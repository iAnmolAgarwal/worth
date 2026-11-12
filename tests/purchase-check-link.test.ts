import Anthropic from '@anthropic-ai/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../server/app.ts'
import type { AppConfig } from '../server/app.ts'
import { Store } from '../server/store.ts'
import type { StoredPurchase } from '../server/store.ts'
import { createChatProvider } from '../server/chat.ts'
import { checkoutGuards } from '../server/checkoutGuards.ts'
import type { CheckoutOption } from '../server/checkoutGuards.ts'
import type { PayPalGateway, PayPalOrder } from '../server/paypal.ts'
import { createDemoState, PRODUCTS } from '../shared/seed.ts'
import type { AppState, FinancialProfile, Purchase } from '../shared/types.ts'

// Decision 0.2: Ask Worth never prepares an order. When the person wants to buy a catalog item,
// Claude's open_purchase_check links to Worth's own comparison, next to Worth's verdict. The demo
// store is never named or linked (final-day plan §0), even with the store hand-off on.

const TODAY = '2026-10-03'
const STORE = 'https://store.example'
const handoff = { handoffSecret: Buffer.alloc(32, 3).toString('base64url'), merchantOrigin: STORE }
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
      throw new Error('Ask Worth must never capture')
    }),
    getRefund: vi.fn(async () => {
      throw new Error('unused')
    }),
    verify: vi.fn(async () => false),
    eligibility: vi.fn(async () => ({ payLater: true })),
  }
  return { gateway, orders }
}
/** Every PayPal call the gateway can make; Ask Worth's comparison link makes none of them. */
const paypalCalls = (gateway: PayPalGateway) =>
  [gateway.create, gateway.get, gateway.capture, gateway.getRefund, gateway.eligibility].reduce(
    (count, fn) => count + vi.mocked(fn).mock.calls.length,
    0,
  )

type Block = Record<string, unknown>
let toolId = 0
function open(input: Record<string, unknown>): Block[] {
  return [{ type: 'tool_use', id: `tool-${++toolId}`, name: 'open_purchase_check', input }]
}
const final = (intent = 'affordability'): Block[] => [
  { type: 'text', text: JSON.stringify({ intent, follow_ups: [] }) },
]

function setup(responses: Block[][], config: Partial<AppConfig> = handoff) {
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
    config: { production: false, origin: 'http://localhost:5173', ...config },
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
const chat = (agent: Agent, message: string) => post(agent, '/api/chat', { message, history: [] })
const sentTools = (create: ReturnType<typeof setup>['create']) =>
  (create.mock.calls[0] as unknown as [{ tools: Anthropic.Tool[] }])[0].tools

describe('open_purchase_check through the chat loop', () => {
  it('links to Worth’s own comparison for the item, with the verdict, and calls PayPal for nothing', async () => {
    const { agent, gateway } = setup([open({ item_id: 'headphones' })])
    await plan(agent)
    const reply = await chat(agent, 'Go ahead and buy the studio headphones')
    expect(reply.status).toBe(200)
    // Fits today, so there is no wait date to repeat next to the link.
    expect(reply.body.checkLink).toEqual({
      href: '#decision?product=headphones',
      itemName: 'Studio headphones',
      amountCents: 34900,
    })
    expect(reply.body).toMatchObject({
      intent: 'affordability',
      verdict: expect.any(String),
      assessment: { itemName: 'Studio headphones', amountCents: 34900, outcome: 'fits' },
    })
    expect(reply.body.toolCalls).toContain('open_purchase_check')
    expect(reply.body.checkout).toBeUndefined()
    expect(reply.body.message).not.toMatch(/prepared|order/i)
    expect(reply.body.trace.tools).toContainEqual({ name: 'open_purchase_check', outcome: 'ran' })
    expect(reply.body.trace.guards.map((g: { id: string }) => g.id)).toEqual([
      'verdict_template',
      'catalog_item',
      'catalog_price',
      'no_order',
      'comparison_link',
    ])
    expect(reply.body.trace.guards.every((g: { passed: boolean }) => g.passed)).toBe(true)
    // The store hand-off is on here, and still no store name or address reaches the answer.
    expect(JSON.stringify(reply.body)).not.toMatch(/Larkspur|store\.example|\/p\/headphones/)
    expect(paypalCalls(gateway)).toBe(0)
    expect(((await agent.get('/api/state')).body as AppState).purchases).toEqual([])
  })

  it('links even when buying today dips below the cushion, and the verdict says so', async () => {
    const { agent, gateway } = setup([open({ item_id: 'camera' })])
    // Tight today; a paycheck on Oct 8 makes Oct 9 the first day that keeps the cushion.
    const paycheck = {
      id: 'pay',
      name: 'Paycheck',
      amountCents: 100000,
      nextDate: '2026-10-08',
      cadence: 'once' as const,
      kind: 'income' as const,
      category: 'Income',
      confirmed: true,
      active: true,
    }
    await plan(agent, { balanceCents: 150000, flows: [paycheck] })
    const reply = await chat(agent, 'Buy the camera')
    expect(reply.body.checkLink).toMatchObject({
      href: '#decision?product=camera',
      waitDate: '2026-10-09',
    })
    expect(reply.body.assessment).toMatchObject({ amountCents: 119900, outcome: 'tight' })
    expect(paypalCalls(gateway)).toBe(0)
  })

  it('links to the same comparison with the store hand-off off', async () => {
    const { agent, gateway } = setup([open({ item_id: 'headphones' })], {
      handoffSecret: undefined,
      merchantOrigin: undefined,
    })
    await plan(agent)
    const reply = await chat(agent, 'Buy the headphones')
    expect(reply.status).toBe(200)
    expect(reply.body.checkLink.href).toBe('#decision?product=headphones')
    expect(reply.body.assessment).toMatchObject({ itemName: 'Studio headphones' })
    expect(paypalCalls(gateway)).toBe(0)
  })

  it('takes no price, store or link from the model', async () => {
    const { agent, create, gateway } = setup([
      open({ item_id: 'camera', amount_cents: 100, url: 'https://evil.example/' }),
      final('clarify'),
    ])
    await plan(agent)
    const reply = await chat(agent, 'Buy the camera for $1')
    expect(reply.body.checkLink).toBeUndefined()
    expect(JSON.stringify(reply.body)).not.toContain('evil.example')
    expect(create).toHaveBeenCalledTimes(2)
    expect(paypalCalls(gateway)).toBe(0)
  })

  it('links once per answer', async () => {
    const { agent } = setup([[...open({ item_id: 'headphones' }), ...open({ item_id: 'camera' })]])
    await plan(agent)
    const reply = await chat(agent, 'Buy the headphones')
    expect(reply.body.checkLink.href).toBe('#decision?product=headphones')
    expect(reply.body.trace.tools).toContainEqual({
      name: 'open_purchase_check',
      outcome: 'refused',
    })
  })

  it('does not offer the tool in local mode', async () => {
    const { agent, create, gateway } = setup([])
    await plan(agent, { aiConsent: false })
    const reply = await chat(agent, 'Buy the headphones')
    expect(reply.body.mode).toBe('demo')
    expect(reply.body.checkLink).toBeUndefined()
    expect(create).not.toHaveBeenCalled()
    expect(paypalCalls(gateway)).toBe(0)
  })

  it('offers open_purchase_check with only an item, naming no store, and no tool that prepares an order', async () => {
    const { agent, create } = setup([final('overview')])
    await plan(agent)
    await chat(agent, 'Hello')
    const tools = sentTools(create)
    expect(tools.map((t) => t.name)).not.toContain('prepare_checkout')
    expect(tools.map((t) => t.name)).not.toContain('open_store_checkout')
    const tool = tools.find((t) => t.name === 'open_purchase_check')!
    expect(Object.keys(tool.input_schema.properties as object)).toEqual(['item_id'])
    expect(tool.description).toMatch(/Worth prepares no order and takes no payment/)
    const request = create.mock.calls[0] as unknown as [{ system: { text: string }[] }]
    expect(JSON.stringify([tools, request[0].system])).not.toMatch(/Larkspur|demo store/i)
  })
})

describe('checkoutGuards: the saved plan’s Buy button', () => {
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
  const guard = (
    itemId: string,
    option: CheckoutOption = 'buyToday',
    extra: { purchases?: Purchase[]; profile?: Partial<FinancialProfile> } = {},
  ) => {
    const decision = checkoutGuards({
      profile: { ...profile, ...extra.profile },
      purchases: extra.purchases ?? [],
      today: TODAY,
      product: PRODUCTS.find((p) => p.id === itemId)!,
      request: { option },
    })
    return decision.ok ? 'OK' : decision.code
  }

  it('passes a fitting catalog purchase', () => {
    expect(guard('headphones')).toBe('OK')
    expect(guard('headphones', 'wait')).toBe('OK')
  })
  it('refuses each failed condition', () => {
    expect(guard('headphones', 'buyToday', { profile: { snapshotDate: '2026-10-02' } })).toBe(
      'FUNDS_NOT_TODAY',
    )
    expect(guard('headphones', 'buyToday', { profile: { confirmed: false } })).toBe(
      'FUNDS_NOT_TODAY',
    )
    expect(guard('headphones', 'buyToday', { profile: { missingFields: ['Something'] } })).toBe(
      'PLAN_INCOMPLETE',
    )
    const active = { status: 'created' } as Purchase
    expect(guard('headphones', 'buyToday', { purchases: [active] })).toBe('CHECKOUT_ACTIVE')
  })
  it('never goes below the cushion', () => {
    const tight = { profile: { balanceCents: 150000 } }
    expect(guard('camera', 'buyToday', tight)).toBe('SHORTFALL_NOT_CONFIRMED')
    expect(guard('camera', 'wait', tight)).toBe('WAIT_NOT_REACHED')
    expect(guard('camera', 'spendLess', tight)).toBe('OVER_SPEND_LESS_LIMIT')
    expect(guard('headphones', 'spendLess', tight)).toBe('OK')
  })
})

describe('an agent’s below-cushion order from before decision 0.2', () => {
  it('still captures only with the person’s own acknowledgement', async () => {
    const { agent, gateway, orders, store } = setup([])
    await plan(agent)
    const created = await post(agent, '/api/checkout/create', { productId: 'headphones' })
    expect(created.status).toBe(200)
    // Stored as Ask Worth's assistant used to store an order it prepared below the cushion.
    const { id: session } = store.db.prepare('SELECT id FROM sessions').get() as { id: string }
    const stored = store.purchases(session)[0]!
    store.putPurchase(session, { ...stored, proceedConfirmRequired: true, preparedBy: 'agent' })
    orders.get(stored.orderId!)!.status = 'APPROVED'
    gateway.capture = vi.fn(async (orderId: string) => {
      const order = orders.get(orderId)!
      order.status = 'COMPLETED'
      order.purchase_units![0]!.payments = {
        captures: [{ id: 'CAP1', status: 'COMPLETED', amount: order.purchase_units![0]!.amount }],
      }
      return structuredClone(order)
    })
    for (const body of [{}, { acknowledgeShortfall: false }]) {
      const refused = await post(agent, `/api/checkout/${stored.id}/capture`, body)
      expect(refused.status).toBe(409)
      expect(refused.body.code).toBe('SHORTFALL_ACKNOWLEDGEMENT_REQUIRED')
    }
    expect(gateway.capture).not.toHaveBeenCalled()
    const paid = await post(agent, `/api/checkout/${stored.id}/capture`, {
      acknowledgeShortfall: true,
    })
    expect(paid.status).toBe(200)
    expect(paid.body.purchase.status).toBe('completed')
  })
})
