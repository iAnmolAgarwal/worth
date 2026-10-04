import { readFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../server/app.ts'
import { Store } from '../server/store.ts'
import type { StoredPurchase } from '../server/store.ts'
import { createChatProvider } from '../server/chat.ts'
import type { PayPalGateway, PayPalOrder } from '../server/paypal.ts'
import { MAX_SAVED } from '../server/saved.ts'
import { VIDEO_REPLAY_DAY } from '../server/demoClock.ts'
import type { AppState, ChatReply, Comparison, FinancialProfile } from '../shared/types.ts'

// Phase 5: saved wait plans checked on return (C-17, acceptance case 21), "Save for later" for any
// assessed item (A3), opt-in 30-day retention (D-9 a) and the labelled demo clock.

const stores: Store[] = []
const clock = { value: new Date('2026-10-04T16:00:00Z') }
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
        links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?t=1' }],
      }
      orders.set(order.id, order)
      return structuredClone(order)
    }),
    get: vi.fn(async (id: string) => structuredClone(orders.get(id)!)),
    capture: vi.fn(async () => {
      throw new Error('a saved plan never captures')
    }),
    getRefund: vi.fn(async () => {
      throw new Error('unused')
    }),
    verify: vi.fn(async () => false),
    eligibility: vi.fn(async () => ({ payLater: true })),
  }
  return gateway
}
type Block = Record<string, unknown>
function setup(options: { paypal?: boolean; responses?: Block[][] } = {}) {
  clock.value = new Date('2026-10-04T16:00:00Z')
  const store = new Store(':memory:')
  stores.push(store)
  const responses = options.responses ?? []
  const create = vi.fn(async () => ({ content: responses.shift() ?? [], stop_reason: 'tool_use' }))
  const client = { messages: { create } } as unknown as Pick<Anthropic, 'messages'>
  const paypal = options.paypal === false ? undefined : fakePayPal()
  const app = createApp({
    store,
    ...(paypal ? { paypal } : {}),
    chat: createChatProvider('unused', 'claude-sonnet-5-5', client, { log: vi.fn() }),
    now: () => clock.value,
    config: {
      production: false,
      origin: 'http://localhost:5173',
      paypalClientId: undefined,
      paypalSecret: undefined,
      anthropicKey: undefined,
    },
  })
  return { app, store, paypal, agent: request.agent(app) }
}
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(path).set('X-Worth-Client', 'web').send(body)
async function state(agent: Agent): Promise<AppState> {
  const response = await agent.get('/api/state')
  expect(response.status).toBe(200)
  return response.body
}
const compare = async (agent: Agent, productId: string) =>
  (await post(agent, '/api/compare', { productId })).body as Comparison
const save = (agent: Agent, body: object) => post(agent, '/api/saved', body)
const csv = readFileSync(new URL('./fixtures/paypal-personal-sandbox.csv', import.meta.url), 'utf8')

/** Imported (real) data, confirmed: $1,000 today, a $300 cushion and a $2,000 paycheck Oct 13. */
async function realPlan(agent: Agent) {
  expect((await post(agent, '/api/import/commit', { csv })).status).toBe(200)
  const imported = await state(agent)
  const profile: FinancialProfile = {
    ...imported.profile,
    balanceCents: 100000,
    cushionCents: 30000,
    dailySpendCents: 0,
    confirmed: true,
    aiConsent: true,
    missingFields: [],
    flows: [
      {
        id: 'pay',
        name: 'Paycheck',
        amountCents: 200000,
        nextDate: '2026-10-13',
        cadence: 'biweekly',
        kind: 'income',
        category: 'Income',
        confirmed: true,
        active: true,
      },
    ],
  }
  const saved = await agent.patch('/api/profile').set('X-Worth-Client', 'web').send({ profile })
  expect(saved.status).toBe(200)
  // A plan kept past 24 hours needs the opt-in retention.
  expect((await post(agent, '/api/retention', { keep30: true })).status).toBe(200)
  return saved.body as AppState
}

describe('saved items on the server', () => {
  it('saves a catalog item at the server price and refuses a client price', async () => {
    const { agent } = setup()
    const saved = await save(agent, { kind: 'catalog', productId: 'macbook-pro-14' })
    expect(saved.status).toBe(200)
    expect(saved.body.item).toMatchObject({
      kind: 'catalog',
      productId: 'macbook-pro-14',
      name: 'MacBook Pro 14-inch',
      amountCents: 249900,
      status: 'active',
    })
    expect(saved.body.state.saved[0].productId).toBe('macbook-pro-14')
    expect(saved.body.state.wishlist).toContain('macbook-pro-14')
    const priced = await save(agent, { kind: 'catalog', productId: 'camera', amountCents: 100 })
    expect(priced.status).toBe(400)
    expect((await save(agent, { kind: 'catalog', productId: 'yacht' })).body.code).toBe('NOT_FOUND')
  })

  it('saves any assessed item as a custom item that is never checked out', async () => {
    const { agent, paypal } = setup()
    const custom = await save(agent, {
      kind: 'custom',
      name: 'Road bike',
      amountCents: 64900,
      option: 'wait',
      waitDate: '2026-10-20',
    })
    expect(custom.body.item).toMatchObject({
      kind: 'custom',
      name: 'Road bike',
      amountCents: 64900,
      option: 'wait',
      waitDate: '2026-10-20',
    })
    // Saving the same item again replaces its plan instead of adding a second copy.
    const again = await save(agent, { kind: 'custom', name: 'road bike', amountCents: 64900 })
    expect(
      again.body.state.saved.filter((i: { kind: string }) => i.kind === 'custom'),
    ).toHaveLength(1)
    expect(again.body.item.waitDate).toBeUndefined()
    const prepared = await post(agent, `/api/saved/${custom.body.item.id}/prepare`)
    expect(prepared.status).toBe(409)
    expect(prepared.body).toMatchObject({ code: 'NOT_IN_STORE' })
    expect(prepared.body.error).toContain('Assessment only — not sold in the demo store')
    expect(paypal!.create).not.toHaveBeenCalled()
    expect((await state(agent)).purchases).toEqual([])
  })

  it('takes a retailer listing as a custom item (the shape the alternatives panel will send)', async () => {
    const { agent } = setup()
    const listing = await save(agent, {
      kind: 'custom',
      name: 'Mirrorless camera body',
      amountCents: 89900,
      retailer: 'Example Retailer',
      url: 'https://shop.example.com/camera',
    })
    expect(listing.body.item).toMatchObject({
      retailer: 'Example Retailer',
      url: 'https://shop.example.com/camera',
    })
    for (const bad of [
      { url: 'http://shop.example.com/camera' },
      { url: 'javascript:alert(1)' },
      { name: 'Bad\u0007name' },
      // Pre-merge judge finding 10: C1 controls, zero-width marks and bidi overrides.
      { name: 'x\u202Eevil' },
      { name: 'x\u2066evil' },
      { name: 'x\u200Bevil' },
      { name: 'x\u0085evil' },
      { retailer: 'Shop\u202E' },
      { amountCents: 0 },
      { amountCents: 12.5 },
      { waitDate: '2026-10-03' },
      { waitDate: '2026-11-04' },
      { waitDate: '2026-02-30' },
      { option: 'spendLess', waitDate: '2026-10-20' },
    ])
      expect(
        (await save(agent, { kind: 'custom', name: 'Item', amountCents: 1000, ...bad })).status,
      ).toBe(400)
  })

  it(`keeps at most ${MAX_SAVED} items and frees a place on removal`, async () => {
    const { agent } = setup()
    const seeded = (await state(agent)).saved!.length
    for (let i = seeded; i < MAX_SAVED; i++)
      expect(
        (await save(agent, { kind: 'custom', name: `Item ${i}`, amountCents: 1000 + i })).status,
      ).toBe(200)
    const full = await save(agent, { kind: 'custom', name: 'One more', amountCents: 999 })
    expect(full.status).toBe(409)
    expect(full.body.code).toBe('SAVED_LIMIT')
    const first = (await state(agent)).saved![0]!
    expect((await post(agent, `/api/saved/${first.id}/remove`)).status).toBe(200)
    expect((await save(agent, { kind: 'custom', name: 'One more', amountCents: 999 })).status).toBe(
      200,
    )
  })

  it('keeps sessions apart', async () => {
    const { app, agent } = setup()
    const mine = await save(agent, { kind: 'custom', name: 'Road bike', amountCents: 64900 })
    const other = request.agent(app)
    expect((await state(other)).saved!.some((item) => item.name === 'Road bike')).toBe(false)
    expect((await post(other, `/api/saved/${mine.body.item.id}/remove`)).status).toBe(404)
    expect((await post(other, `/api/saved/${mine.body.item.id}/prepare`)).status).toBe(404)
    expect((await state(agent)).saved!.some((item) => item.name === 'Road bike')).toBe(true)
  })

  it('keeps the older wishlist toggle working on top of saved items', async () => {
    const { agent } = setup()
    const initial = await state(agent)
    expect(initial.wishlist.sort()).toEqual(['camera', 'headphones'])
    const added = await post(agent, '/api/wishlist', { productId: 'chair' })
    expect(added.body.wishlist).toContain('chair')
    const removed = await post(agent, '/api/wishlist', { productId: 'chair' })
    expect(removed.body.wishlist).not.toContain('chair')
    expect(
      removed.body.saved.some((item: { productId?: string }) => item.productId === 'chair'),
    ).toBe(false)
  })

  it('moves the browser’s old wait dates to the server once and survives malformed values', async () => {
    const { agent } = setup()
    // The old browser kept dates for items the server wishlist held (headphones and camera are
    // the persona's own).
    for (const productId of ['chair', 'backpack', 'macbook-pro-14'])
      await post(agent, '/api/wishlist', { productId })
    const removed = (await state(agent)).saved!.find((i) => i.productId === 'macbook-pro-14')!
    expect((await post(agent, `/api/saved/${removed.id}/remove`)).status).toBe(200)
    const moved = await post(agent, '/api/saved/migrate', {
      planned: {
        camera: '2026-10-23',
        chair: 'not a date',
        headphones: 42,
        yacht: '2026-10-20',
        backpack: '2027-01-01',
        // Pre-merge judge finding 9: a past date, a removed item and a never-saved item stay out.
        'macbook-pro-14': '2026-10-20',
        'airpods-4': '2026-10-20',
      },
    })
    expect(moved.status).toBe(200)
    expect(moved.body.moved).toBe(1)
    const after = (moved.body.state as AppState).saved!
    expect(after.some((i) => i.productId === 'macbook-pro-14' || i.productId === 'airpods-4')).toBe(
      false,
    )
    const past = await post(agent, '/api/saved/migrate', { planned: { chair: '2026-10-03' } })
    expect(past.body.moved).toBe(0)
    const camera = (moved.body.state as AppState).saved!.find((i) => i.productId === 'camera')!
    expect(camera).toMatchObject({ option: 'wait', waitDate: '2026-10-23' })
    // A date already on the server wins over a stale browser copy.
    const again = await post(agent, '/api/saved/migrate', { planned: { camera: '2026-10-25' } })
    expect(again.body.moved).toBe(0)
    expect((await post(agent, '/api/saved/migrate', { planned: 'oops' })).status).toBe(400)
    expect((await post(agent, '/api/saved/migrate', {})).status).toBe(400)
  })
})

describe('acceptance case 21: a saved wait plan, checked on return', () => {
  it('real data, injected clock: may fit now, but no order before funds are confirmed', async () => {
    const { agent, paypal } = setup({
      responses: [
        [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'prepare_checkout',
            input: { item_id: 'camera', option: 'wait', proceed_despite_shortfall: false },
          },
        ],
      ],
    })
    await realPlan(agent)
    const before = await compare(agent, 'camera')
    expect(before.recommendation).toBe('wait')
    // Payday income lands after that day's outflows, so the first safe day is the next one.
    expect(before.wait.date).toBe('2026-10-14')
    const plan = await save(agent, {
      kind: 'catalog',
      productId: 'camera',
      option: 'wait',
      waitDate: before.wait.date!,
    })
    expect(plan.body.item.status).toBe('active')
    // The day before: still waiting.
    clock.value = new Date('2026-10-13T16:00:00Z')
    expect((await state(agent)).saved!.find((i) => i.id === plan.body.item.id)!.status).toBe(
      'active',
    )
    // On the wait date the plan is ready, but the funds snapshot is from Oct 4.
    clock.value = new Date('2026-10-14T16:00:00Z')
    const back = await state(agent)
    expect(back.today).toBe('2026-10-14')
    expect(back.demoClock).toBeUndefined()
    expect(back.fundsProjection).toBeUndefined()
    expect(back.saved!.find((i) => i.id === plan.body.item.id)!.status).toBe('ready')
    const early = await post(agent, `/api/saved/${plan.body.item.id}/prepare`)
    expect(early.status).toBe(409)
    expect(early.body.code).toBe('FUNDS_NOT_TODAY')
    // Claude's prepare_checkout hits the same guard.
    const chat = await post(agent, '/api/chat', {
      message: 'Buy the camera now',
      history: [],
      context: { amountCents: 119900, itemName: 'Everyday camera' },
    })
    expect(chat.body.checkout).toBeUndefined()
    expect(chat.body.message).toContain('Confirm today’s available funds')
    expect(paypal!.create).not.toHaveBeenCalled()
    expect((await state(agent)).purchases).toEqual([])
    // Confirm today's funds, then a fresh assessment, then the order.
    const confirmed = await post(agent, '/api/funds/confirm', { balanceCents: 300000 })
    expect(confirmed.status).toBe(200)
    expect(confirmed.body.profile).toMatchObject({
      snapshotDate: '2026-10-14',
      balanceCents: 300000,
      userEdited: true,
    })
    expect((await compare(agent, 'camera')).buyToday.outcome).toBe('fits')
    const prepared = await post(agent, `/api/saved/${plan.body.item.id}/prepare`)
    expect(prepared.status).toBe(200)
    expect(prepared.body.purchase).toMatchObject({
      productId: 'camera',
      amountCents: 119900,
      status: 'created',
      assessmentDate: '2026-10-14',
      preparedBy: 'user',
    })
    expect(prepared.body.approvalUrl).toContain('sandbox.paypal.com')
    expect(paypal!.capture).not.toHaveBeenCalled()
  })

  it('refuses a plan that no longer fits after the fresh check', async () => {
    const { agent, paypal } = setup()
    await realPlan(agent)
    const plan = await save(agent, {
      kind: 'catalog',
      productId: 'camera',
      option: 'wait',
      waitDate: '2026-10-14',
    })
    expect(plan.status).toBe(200)
    clock.value = new Date('2026-10-14T16:00:00Z')
    // Less money than planned: the fresh check moves the date, so nothing is prepared.
    await post(agent, '/api/funds/confirm', { balanceCents: 20000 })
    const refused = await post(agent, `/api/saved/${plan.body.item.id}/prepare`)
    expect(refused.status).toBe(409)
    expect(['WAIT_NOT_REACHED', 'SHORTFALL_NOT_CONFIRMED']).toContain(refused.body.code)
    expect(paypal!.create).not.toHaveBeenCalled()
  })

  it('validates the funds confirmation', async () => {
    const { agent } = setup()
    for (const body of [
      {},
      { balanceCents: -1 },
      { balanceCents: 1.5 },
      { balanceCents: 100, extra: true },
      { balanceCents: 100, paidFlowIds: ['rent'] },
      { balanceCents: 100, reflectedPurchaseIds: ['nope'] },
    ])
      expect((await post(agent, '/api/funds/confirm', body)).status).toBe(400)
  })

  it('synthetic persona: the video replay, then a return visit on the wait date', async () => {
    const { agent, paypal } = setup()
    const replay = await post(agent, '/api/demo-clock', { preset: 'video' })
    expect(replay.status).toBe(200)
    const pinned = replay.body as AppState
    expect(pinned.today).toBe(VIDEO_REPLAY_DAY)
    expect(pinned.demoClock).toEqual({ today: '2026-10-03', preset: 'video' })
    expect(pinned.profile.flows.find((f) => f.id === 'rent')!.nextDate).toBe('2026-10-16')
    const camera = await compare(agent, 'camera')
    expect(camera.wait.date).toBe('2026-10-23')
    expect(camera.buyToday.lowestBalanceCents).toBe(-45899)
    expect(camera.buyToday.lowestDate).toBe('2026-10-22')
    // The viewer's real day never moves a pinned persona.
    expect((await state(agent)).today).toBe('2026-10-03')
    const plan = await save(agent, {
      kind: 'catalog',
      productId: 'camera',
      option: 'wait',
      waitDate: '2026-10-23',
    })
    const back = await post(agent, '/api/demo-clock', { date: '2026-10-23' })
    expect(back.status).toBe(200)
    const returned = back.body as AppState
    expect(returned.today).toBe('2026-10-23')
    expect(returned.saved!.find((i) => i.id === plan.body.item.id)!.status).toBe('ready')
    expect(returned.fundsProjection).toEqual({ cents: 284001, from: '2026-10-03' })
    expect((await post(agent, `/api/saved/${plan.body.item.id}/prepare`)).body.code).toBe(
      'FUNDS_NOT_TODAY',
    )
    expect((await compare(agent, 'camera')).recommendation).toBeNull()
    const laptop = returned.profile.flows.find((f) => f.nextDate === '2026-10-15')!
    const confirmed = await post(agent, '/api/funds/confirm', {
      balanceCents: 284001,
      paidFlowIds: [laptop.id],
    })
    expect(confirmed.status).toBe(200)
    // Accepting the sample's own projection keeps it the untouched sample (Claude stays on).
    expect(confirmed.body.profile.userEdited).toBe(false)
    const fresh = await compare(agent, 'camera')
    expect(fresh.recommendation).toBe('buyToday')
    expect(fresh.buyToday.lowestBalanceCents).toBe(72053)
    const prepared = await post(agent, `/api/saved/${plan.body.item.id}/prepare`)
    expect(prepared.status).toBe(200)
    expect(prepared.body.purchase.assessmentDate).toBe('2026-10-23')
    expect(paypal!.create).toHaveBeenCalledOnce()
  })

  it('marks a saved catalog item bought once its checkout completes', async () => {
    const { agent } = setup({ paypal: false })
    await post(agent, '/api/demo-clock', { preset: 'video' })
    const plan = await save(agent, { kind: 'catalog', productId: 'headphones', option: 'buyToday' })
    const prepared = await post(agent, `/api/saved/${plan.body.item.id}/prepare`)
    expect(prepared.body.purchase.mode).toBe('demo')
    const paid = await post(agent, `/api/checkout/${prepared.body.purchase.id}/capture`)
    expect(paid.body.purchase.status).toBe('completed')
    const after = paid.body.state as AppState
    expect(after.saved!.find((i) => i.id === plan.body.item.id)!.status).toBe('bought')
    // The demo clock dates the persona's purchase on the clock's day, and "bought on" with it
    // (pre-merge judge finding 6), though the real completion time is a day later.
    expect(after.transactions.find((t) => t.source === 'purchase')!.date).toBe('2026-10-03')
    expect(paid.body.purchase.completedAt.slice(0, 10)).toBe('2026-10-04')
    expect(paid.body.purchase.completedOn).toBe('2026-10-03')
  })
})

describe('the demo clock is limited to the synthetic persona', () => {
  it('refuses imported data, and importing ends a running demo clock', async () => {
    const { agent } = setup()
    await post(agent, '/api/demo-clock', { preset: 'video' })
    expect((await state(agent)).today).toBe('2026-10-03')
    await post(agent, '/api/import/commit', { csv })
    const imported = await state(agent)
    expect(imported.profile.source).toBe('import')
    expect(imported.today).toBe('2026-10-04')
    expect(imported.demoClock).toBeUndefined()
    for (const body of [{ preset: 'video' }, { date: '2026-10-10' }, { preset: 'today' }]) {
      const refused = await post(agent, '/api/demo-clock', body)
      expect(refused.status).toBe(409)
      expect(refused.body.code).toBe('DEMO_CLOCK_SAMPLE_ONLY')
    }
    expect((await state(agent)).today).toBe('2026-10-04')
  })

  it('moves only forward within the window, and returns to today with a fresh persona', async () => {
    const { agent } = setup()
    await post(agent, '/api/demo-clock', { preset: 'video' })
    expect((await post(agent, '/api/demo-clock', { date: '2026-10-02' })).status).toBe(400)
    expect((await post(agent, '/api/demo-clock', { date: '2026-12-03' })).status).toBe(400)
    expect((await post(agent, '/api/demo-clock', { date: 'soon' })).status).toBe(400)
    const today = await post(agent, '/api/demo-clock', { preset: 'today' })
    expect(today.body.today).toBe('2026-10-04')
    expect(today.body.demoClock).toBeUndefined()
    expect(today.body.profile.snapshotDate).toBe('2026-10-04')
  })

  // Pre-merge judge finding 4: hand-typed numbers are the user's own, never run on the clock.
  it('refuses a hand edit of the sample plan while the clock runs', async () => {
    const { agent } = setup()
    await post(agent, '/api/demo-clock', { preset: 'video' })
    const moved = (await post(agent, '/api/demo-clock', { date: '2026-11-20' })).body as AppState
    const patch = (profile: FinancialProfile) =>
      agent.patch('/api/profile').set('X-Worth-Client', 'web').send({ profile })
    const edit = await patch({
      ...moved.profile,
      balanceCents: 900000,
      snapshotDate: '2026-11-20',
      confirmed: true,
    })
    expect(edit.status).toBe(409)
    expect(edit.body.code).toBe('DEMO_CLOCK_RUNNING')
    const after = await state(agent)
    expect(after.profile).toMatchObject({ balanceCents: moved.profile.balanceCents })
    expect(after.profile.userEdited).toBeFalsy()
    // Back on today, the plan is editable, and a future funds date is refused as before.
    const today = (await post(agent, '/api/demo-clock', { preset: 'today' })).body as AppState
    expect((await patch({ ...today.profile, snapshotDate: '2026-11-20' })).body.code).toBe(
      'INVALID_SNAPSHOT',
    )
    const own = await patch({ ...today.profile, balanceCents: 900000 })
    expect(own.status).toBe(200)
    expect(own.body.demoClock).toBeUndefined()
    expect(own.body.profile.userEdited).toBe(true)
  })

  it('keeps the user’s own choice about Claude through a replay', async () => {
    const { agent } = setup()
    await post(agent, '/api/consent', { aiConsent: false })
    const replay = (await post(agent, '/api/demo-clock', { preset: 'video' })).body as AppState
    expect(replay.profile).toMatchObject({ aiConsent: false, aiChoiceMade: true })
  })
})

describe('opt-in 30-day retention (D-9 a)', () => {
  it('is off by default: 24 hours from the start', async () => {
    const { agent } = setup()
    const first = await agent.get('/api/state')
    expect(first.headers['set-cookie'][0]).toContain('Max-Age=86400')
    expect(first.body.retention).toEqual({
      keep30: false,
      expiresAt: '2026-10-05T16:00:00.000Z',
    })
  })

  it('keeps the plan for 30 days when opted in, and deleting still works at any time', async () => {
    const { app, agent } = setup()
    const key = (await state(agent)).sessionKey
    await save(agent, { kind: 'custom', name: 'Road bike', amountCents: 64900 })
    const kept = await post(agent, '/api/retention', { keep30: true })
    expect(kept.status).toBe(200)
    expect(kept.headers['set-cookie'][0]).toContain('Max-Age=2592000')
    expect(kept.body.retention).toEqual({ keep30: true, expiresAt: '2026-11-03T16:00:00.000Z' })
    clock.value = new Date('2026-10-20T16:00:00Z')
    expect(app.locals.cleanup()).toBe(0)
    const later = await state(agent)
    expect(later.sessionKey).toBe(key)
    expect(later.saved!.some((item) => item.name === 'Road bike')).toBe(true)
    const reset = await post(agent, '/api/reset')
    expect(reset.body.sessionKey).not.toBe(key)
    expect(reset.body.retention.keep30).toBe(false)
    expect(reset.body.saved.some((item: { name: string }) => item.name === 'Road bike')).toBe(false)
  })

  it('without opt-in, a saved plan does not outlive the 24-hour session', async () => {
    const { agent } = setup()
    const key = (await state(agent)).sessionKey
    await save(agent, {
      kind: 'catalog',
      productId: 'camera',
      option: 'wait',
      waitDate: '2026-10-10',
    })
    clock.value = new Date('2026-10-05T16:00:01Z')
    const later = await state(agent)
    expect(later.sessionKey).not.toBe(key)
    expect(later.saved!.some((item) => item.waitDate)).toBe(false)
  })

  it('expires after 30 days, and turning it off returns to 24 hours', async () => {
    const { app, agent, store } = setup()
    await post(agent, '/api/retention', { keep30: true })
    clock.value = new Date('2026-11-03T16:00:01Z')
    expect(app.locals.cleanup()).toBe(1)
    expect(store.count(clock.value.getTime())).toBe(0)
    clock.value = new Date('2026-10-04T16:00:00Z')
    const other = request.agent(app)
    await post(other, '/api/retention', { keep30: true })
    const off = await post(other, '/api/retention', { keep30: false })
    expect(off.headers['set-cookie'][0]).toContain('Max-Age=86400')
    expect(off.body.retention).toEqual({ keep30: false, expiresAt: '2026-10-05T16:00:00.000Z' })
    expect((await post(other, '/api/retention', { keep30: 'yes' })).status).toBe(400)
  })

  // Pre-merge judge finding 8: switching retention off never keeps a session alive longer.
  it('never extends a 24-hour session that did not opt in', async () => {
    const { agent } = setup()
    await state(agent)
    clock.value = new Date('2026-10-05T10:00:00Z')
    const off = await post(agent, '/api/retention', { keep30: false })
    expect(off.body.retention).toEqual({ keep30: false, expiresAt: '2026-10-05T16:00:00.000Z' })
    expect(off.headers['set-cookie'][0]).toContain('Max-Age=21600')
    clock.value = new Date('2026-10-05T16:00:01Z')
    expect((await state(agent)).retention.keep30).toBe(false)
    expect((await agent.get('/api/state')).body.sessionKey).not.toBe(off.body.sessionKey)
  })
})

describe('catalog pricing', () => {
  it('prices every real-brand item from the server catalog', async () => {
    const { agent } = setup({ paypal: false })
    const macbook = await compare(agent, 'macbook-pro-14')
    expect(macbook.amountCents).toBe(249900)
    expect(macbook.itemName).toBe('MacBook Pro 14-inch')
    const mismatch = await post(agent, '/api/compare', {
      productId: 'airpods-4',
      amountCents: 100,
    })
    expect(mismatch.body.code).toBe('PRICE_MISMATCH')
    expect(
      (await post(agent, '/api/checkout/create', { productId: 'airpods-4', amountCents: 100 }))
        .status,
    ).toBe(400)
    const checkout = await post(agent, '/api/checkout/create', { productId: 'airpods-4' })
    expect(checkout.body.purchase).toMatchObject({ name: 'AirPods 4', amountCents: 12900 })
  })
})

// Pre-merge judge finding 3: "items assessed so far" come back from the browser, so the server
// signs each one and ignores any price it did not sign.
describe('remembered items are the server’s own', () => {
  const chat = (agent: Agent, body: object) =>
    post(agent, '/api/chat', { history: [], ...body }).then((r) => {
      expect(r.status).toBe(200)
      return r.body as ChatReply
    })

  it('never reads a forged $1 camera price', async () => {
    const { agent } = setup({ paypal: false })
    const forged = await chat(agent, {
      message: 'Go back to the camera. Does it fit?',
      items: [{ amountCents: 100, itemName: 'Everyday camera' }],
    })
    // The unsigned item is ignored: the camera is read at the store's price.
    expect(forged.interpretation?.items).toEqual([
      { name: 'Everyday camera', amountCents: 119900, quantity: 1, priceSource: 'catalog' },
    ])
    expect(forged.message).not.toContain('$1 ')
    // A made-up tag, or a signed item whose price was edited, is ignored the same way.
    const tag = 'A'.repeat(43)
    const fake = await chat(agent, {
      message: 'And the bike?',
      items: [{ amountCents: 100, itemName: 'road bike', tag }],
    })
    expect(fake.assessment).toBeUndefined()
    expect(fake.message).not.toContain('$1.00')
  })

  it('returns to an item at the price Worth read, signed for this session only', async () => {
    const { agent } = setup({ paypal: false })
    const bike = await chat(agent, { message: 'Can I afford a $649 road bike today?' })
    expect(bike.remember).toMatchObject({ amountCents: 64900, itemName: expect.any(String) })
    const back = await chat(agent, { message: 'And the bike?', items: [bike.remember] })
    expect(back.assessment?.amountCents).toBe(64900)
    const edited = await chat(agent, {
      message: 'And the bike?',
      items: [{ ...bike.remember!, amountCents: 100 }],
    })
    expect(edited.assessment).toBeUndefined()
    // Another session cannot reuse the signature.
    const { agent: other } = setup({ paypal: false })
    const replayed = await chat(other, { message: 'And the bike?', items: [bike.remember] })
    expect(replayed.assessment).toBeUndefined()
  })
})
