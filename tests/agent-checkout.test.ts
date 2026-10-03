import Anthropic from '@anthropic-ai/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../server/app.ts'
import { Store } from '../server/store.ts'
import type { StoredPurchase } from '../server/store.ts'
import { createChatProvider } from '../server/chat.ts'
import { decideAgentCheckout } from '../server/agentCheckout.ts'
import type { PrepareCheckoutRequest } from '../server/agentCheckout.ts'
import type { PayPalGateway, PayPalOrder } from '../server/paypal.ts'
import { createDemoState, PRODUCTS } from '../shared/seed.ts'
import type { AppState, FinancialProfile, Purchase } from '../shared/types.ts'

// Acceptance case 18: Claude's prepare_checkout creates an order only behind the server's guard,
// at the catalog price, and never captures.

const TODAY = '2026-10-03'
const stores: Store[] = []
const clock = { value: new Date(`${TODAY}T12:00:00Z`) }
type Agent = ReturnType<typeof request.agent>
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function fakePayPal() {
  const orders = new Map<string, PayPalOrder>()
  const gateway: PayPalGateway = {
    create: vi.fn(async (p: StoredPurchase) => {
      const order: PayPalOrder = {
        id: `ORDER${orders.size + 1}`,
        status: 'PAYER_ACTION_REQUIRED',
        purchase_units: [
          {
            custom_id: p.id,
            reference_id: p.id,
            amount: { currency_code: 'USD', value: (p.amountCents / 100).toFixed(2) },
            payee: { merchant_id: 'MERCHANT1' },
          },
        ],
        links: [
          {
            rel: 'payer-action',
            href: `https://www.sandbox.paypal.com/checkoutnow?token=ORDER${orders.size + 1}`,
          },
        ],
      }
      orders.set(order.id, order)
      return structuredClone(order)
    }),
    get: vi.fn(async (id: string) => structuredClone(orders.get(id)!)),
    capture: vi.fn(async () => {
      throw new Error('prepare_checkout must never capture')
    }),
    getRefund: vi.fn(async () => {
      throw new Error('unused')
    }),
    verify: vi.fn(async () => false),
    eligibility: vi.fn(async () => ({ payLater: true })),
  }
  return { gateway, orders }
}

type Block = Record<string, unknown>
let toolId = 0
function prepare(input: Record<string, unknown>): Block[] {
  return [{ type: 'tool_use', id: `tool-${++toolId}`, name: 'prepare_checkout', input }]
}
const ask = (item_id: string, option = 'buyToday', proceed_despite_shortfall = false) =>
  prepare({ item_id, option, proceed_despite_shortfall })

function setup(responses: Block[][]) {
  clock.value = new Date(`${TODAY}T12:00:00Z`)
  const store = new Store(':memory:')
  stores.push(store)
  const create = vi.fn(async () => ({ content: responses.shift() ?? [], stop_reason: 'tool_use' }))
  const client = { messages: { create } } as unknown as Pick<Anthropic, 'messages'>
  const { gateway, orders } = fakePayPal()
  const app = createApp({
    store,
    paypal: gateway,
    chat: createChatProvider('unused', 'claude-sonnet-5-5', client, { log: vi.fn() }),
    now: () => clock.value,
    config: { production: false, origin: 'http://localhost:5173' },
  })
  return { app, store, gateway, orders, create, agent: request.agent(app) }
}
function post(agent: Agent, path: string, body: object = {}) {
  return agent.post(path).set('X-Worth-Client', 'web').send(body)
}
async function plan(agent: Agent, overrides: Partial<FinancialProfile> = {}) {
  const initial = (await agent.get('/api/state')).body as AppState
  const saved = await agent
    .patch('/api/profile')
    .set('X-Worth-Client', 'web')
    .send({
      profile: {
        ...initial.profile,
        balanceCents: 200000,
        cushionCents: 50000,
        dailySpendCents: 0,
        flows: [],
        aiConsent: true,
        ...overrides,
      },
    })
  expect(saved.status).toBe(200)
  return saved.body as AppState
}
const chat = (agent: Agent, message: string, context?: object) =>
  post(agent, '/api/chat', { message, history: [], ...(context ? { context } : {}) })

describe('prepare_checkout through the chat loop', () => {
  it('prepares a catalog-priced order for approval and never captures', async () => {
    const { agent, gateway } = setup([ask('headphones')])
    await plan(agent)
    const reply = await chat(agent, 'Buy the headphones for me')
    expect(reply.status).toBe(200)
    const state = (await agent.get('/api/state')).body as AppState
    const purchase = state.purchases[0]!
    expect(reply.body.checkout).toEqual({
      purchaseId: purchase.id,
      orderId: 'ORDER1',
      approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1',
      itemName: 'Studio headphones',
      amountCents: 34900,
      option: 'buyToday',
      requiresProceedConfirm: false,
    })
    expect(reply.body.toolCalls).toContain('prepare_checkout')
    expect(reply.body.message).toContain('Worth prepared a PayPal sandbox order')
    expect(purchase).toMatchObject({ status: 'created', preparedBy: 'agent', amountCents: 34900 })
    expect(vi.mocked(gateway.create).mock.calls[0]![0].amountCents).toBe(
      PRODUCTS.find((p) => p.id === 'headphones')!.priceCents,
    )
    expect(gateway.capture).not.toHaveBeenCalled()
  })
  it('refuses a price supplied by the model', async () => {
    const { agent, gateway } = setup([
      prepare({
        item_id: 'camera',
        option: 'buyToday',
        proceed_despite_shortfall: false,
        amount_cents: 100,
      }),
      [{ type: 'text', text: '{"intent":"clarify","follow_ups":[]}' }],
    ])
    await plan(agent)
    const reply = await chat(agent, 'Buy the camera for $1')
    expect(reply.body.checkout).toBeUndefined()
    expect(gateway.create).not.toHaveBeenCalled()
  })
  it('refuses a second active checkout', async () => {
    const { agent, gateway } = setup([ask('chair')])
    await plan(agent)
    expect((await post(agent, '/api/checkout/create', { productId: 'headphones' })).status).toBe(
      200,
    )
    const reply = await chat(agent, 'Buy the chair')
    expect(reply.body.checkout).toBeUndefined()
    expect(reply.body.message).toContain('already have a checkout in progress')
    expect(gateway.create).toHaveBeenCalledTimes(1)
  })
  it('refuses when today’s funds are not confirmed', async () => {
    const { agent, gateway } = setup([ask('headphones')])
    await plan(agent, { snapshotDate: '2026-10-02' })
    const reply = await chat(agent, 'Buy the headphones')
    expect(reply.body.checkout).toBeUndefined()
    expect(reply.body.message).toContain('Confirm today’s available funds')
    expect(gateway.create).not.toHaveBeenCalled()
  })
  it('refuses a stale assessment when the plan changes before the order is created', async () => {
    const { agent, gateway, store } = setup([ask('headphones')])
    await plan(agent)
    gateway.eligibility = vi.fn(async () => {
      // Another tab saves the plan while the order is being prepared.
      const row = store.db.prepare('SELECT id FROM sessions').get() as { id: string }
      const data = store.get(row.id)!
      data.profile.version += 1
      store.save(row.id, data)
      return { payLater: true }
    })
    const reply = await chat(agent, 'Buy the headphones')
    expect(reply.body.checkout).toBeUndefined()
    expect(reply.body.message).toContain('Check this purchase again')
    expect(gateway.create).not.toHaveBeenCalled()
  })
  it('refuses a non-fitting purchase unless the user says to go ahead, then asks the UI to confirm', async () => {
    const tight = { balanceCents: 150000 }
    const declined = setup([ask('camera', 'buyToday', true)])
    await plan(declined.agent, tight)
    // Claude claims a decision to proceed, but the user's words do not contain one.
    const first = await chat(declined.agent, 'Buy the camera')
    expect(first.body.checkout).toBeUndefined()
    expect(first.body.message).toContain('only if you say you want to go ahead anyway')
    expect(declined.gateway.create).not.toHaveBeenCalled()

    const accepted = setup([ask('camera', 'buyToday', true)])
    await plan(accepted.agent, tight)
    const second = await chat(accepted.agent, 'Buy the camera anyway, I understand it dips below')
    expect(second.body.checkout).toMatchObject({
      amountCents: 119900,
      requiresProceedConfirm: true,
    })
    expect(accepted.gateway.capture).not.toHaveBeenCalled()
  })
  it('refuses to prepare an order for a question about affording', async () => {
    const { agent, gateway } = setup([ask('headphones')])
    await plan(agent)
    const reply = await chat(agent, 'Can I afford the headphones?')
    expect(reply.body.checkout).toBeUndefined()
    expect(gateway.create).not.toHaveBeenCalled()
  })
  it('does not offer the tool in local mode', async () => {
    const { agent, create, gateway } = setup([])
    await plan(agent, { aiConsent: false })
    const reply = await chat(agent, 'Buy the headphones')
    expect(reply.body.mode).toBe('demo')
    expect(reply.body.checkout).toBeUndefined()
    expect(create).not.toHaveBeenCalled()
    expect(gateway.create).not.toHaveBeenCalled()
  })
  it('offers prepare_checkout to Claude without any price field', async () => {
    const { agent, create } = setup([
      [{ type: 'text', text: '{"intent":"overview","follow_ups":[]}' }],
    ])
    await plan(agent)
    await chat(agent, 'Hello')
    const params = (create.mock.calls[0] as unknown as [{ tools: Anthropic.Tool[] }])[0]
    const tool = params.tools.find((t) => t.name === 'prepare_checkout')!
    expect(Object.keys(tool.input_schema.properties as object).sort()).toEqual([
      'item_id',
      'option',
      'proceed_despite_shortfall',
    ])
  })
})

describe('prepare_checkout guard', () => {
  const seed = createDemoState(TODAY)
  const profile: FinancialProfile = {
    ...seed.profile,
    balanceCents: 200000,
    cushionCents: 50000,
    dailySpendCents: 0,
    flows: [],
    missingFields: [],
    confirmed: true,
    snapshotDate: TODAY,
  }
  const decide = (
    request: Partial<PrepareCheckoutRequest>,
    message = 'Buy the headphones',
    extra: { purchases?: Purchase[]; profile?: Partial<FinancialProfile> } = {},
  ) =>
    decideAgentCheckout({
      profile: { ...profile, ...extra.profile },
      purchases: extra.purchases ?? [],
      today: TODAY,
      product: PRODUCTS.find((p) => p.id === (request.itemId ?? 'headphones')),
      request: {
        itemId: 'headphones',
        option: 'buyToday',
        proceedDespiteShortfall: false,
        ...request,
      },
      message,
    })
  const code = (decision: ReturnType<typeof decide>) => (decision.ok ? 'OK' : decision.code)

  it('accepts a fitting catalog purchase the user asked for', () => {
    expect(decide({})).toMatchObject({ ok: true, fits: true, profileVersion: profile.version })
  })
  it('refuses each failed condition', () => {
    expect(code(decide({}, 'Can I afford the headphones?'))).toBe('NOT_REQUESTED')
    expect(code(decide({ itemId: 'yacht' }, 'Buy the yacht'))).toBe('UNKNOWN_ITEM')
    expect(code(decide({}, 'Buy the camera'))).toBe('ITEM_NOT_DISCUSSED')
    expect(
      code(decide({}, 'Buy the headphones', { profile: { snapshotDate: '2026-10-02' } })),
    ).toBe('FUNDS_NOT_TODAY')
    expect(code(decide({}, 'Buy the headphones', { profile: { confirmed: false } }))).toBe(
      'FUNDS_NOT_TODAY',
    )
    expect(
      code(decide({}, 'Buy the headphones', { profile: { missingFields: ['Something'] } })),
    ).toBe('PLAN_INCOMPLETE')
    const active = { status: 'created' } as Purchase
    expect(code(decide({}, 'Buy the headphones', { purchases: [active] }))).toBe('CHECKOUT_ACTIVE')
  })
  it('allows going ahead below the cushion only on the user’s explicit words, for buying today', () => {
    const tight = { profile: { balanceCents: 150000 } }
    const camera = { itemId: 'camera' }
    expect(code(decide(camera, 'Buy the camera', tight))).toBe('SHORTFALL_NOT_CONFIRMED')
    expect(
      code(decide({ ...camera, proceedDespiteShortfall: true }, 'Buy the camera', tight)),
    ).toBe('SHORTFALL_NOT_CONFIRMED')
    expect(
      decide({ ...camera, proceedDespiteShortfall: true }, 'Buy the camera anyway', tight),
    ).toMatchObject({ ok: true, fits: false })
    // The user's words decide, even when Claude's flag is cautious.
    expect(decide(camera, 'Go ahead and buy the camera anyway', tight)).toMatchObject({
      ok: true,
      fits: false,
    })
    expect(
      code(
        decide(
          { ...camera, option: 'wait', proceedDespiteShortfall: true },
          'Buy the camera anyway',
          tight,
        ),
      ),
    ).toBe('WAIT_NOT_REACHED')
    expect(code(decide({ ...camera, option: 'spendLess' }, 'Buy the camera', tight))).toBe(
      'OVER_SPEND_LESS_LIMIT',
    )
    expect(code(decide({ option: 'spendLess' }, 'Buy the headphones instead', tight))).toBe('OK')
    expect(code(decide({ option: 'wait' }, 'Buy the headphones'))).toBe('OK')
  })
})
