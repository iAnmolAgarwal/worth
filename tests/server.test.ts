import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../server/app.ts'
import { Store } from '../server/store.ts'
import type { StoredPurchase } from '../server/store.ts'
import type { PayPalGateway, PayPalOrder } from '../server/paypal.ts'
import type { AppState } from '../shared/types.ts'
import { createChatProvider, fallbackReply } from '../server/chat.ts'
import { addDays } from '../shared/finance.ts'
import { CSV_IMPORT_LIMITS, utf8Bytes } from '../shared/limits.ts'

const stores: Store[] = []
function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
}
const config = {
  production: false,
  origin: 'http://localhost:5173',
  paypalClientId: undefined,
  paypalSecret: undefined,
  anthropicKey: undefined,
}
const clock = { value: new Date('2026-10-03T12:00:00Z') }
function setup(extra: Parameters<typeof createApp>[0] = {}) {
  clock.value = new Date('2026-10-03T12:00:00Z')
  const store = new Store(':memory:')
  stores.push(store)
  const app = createApp({ store, config, now: () => clock.value, ...extra })
  return { app, store, agent: request.agent(app) }
}
function post(agent: ReturnType<typeof request.agent>, path: string, body: object = {}) {
  return agent.post(path).set('X-Worth-Client', 'web').send(body)
}
function patch(agent: ReturnType<typeof request.agent>, body: object) {
  return agent.patch('/api/profile').set('X-Worth-Client', 'web').send(body)
}
async function state(agent: ReturnType<typeof request.agent>): Promise<AppState> {
  const result = await agent.get('/api/state')
  expect(result.status).toBe(200)
  return result.body
}
async function simpleProfile(
  agent: ReturnType<typeof request.agent>,
  overrides: Record<string, unknown> = {},
) {
  const initial = await state(agent)
  const response = await patch(agent, {
    profile: {
      ...initial.profile,
      balanceCents: 200000,
      cushionCents: 50000,
      dailySpendCents: 0,
      flows: [],
      ...overrides,
    },
  })
  expect(response.status).toBe(200)
  return response.body as AppState
}
function fakePayPal() {
  const orders = new Map<string, PayPalOrder>()
  const gateway: PayPalGateway = {
    create: vi.fn(async (p: StoredPurchase) => {
      const order: PayPalOrder = {
        id: `ORDER${orders.size + 1}`,
        status: 'APPROVED',
        purchase_units: [
          {
            custom_id: p.id,
            reference_id: p.id,
            amount: { currency_code: 'USD', value: (p.amountCents / 100).toFixed(2) },
            payee: { merchant_id: 'MERCHANT1' },
          },
        ],
        links: [
          { rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=fake' },
        ],
      }
      orders.set(order.id, order)
      return structuredClone(order)
    }),
    get: vi.fn(async (id: string) => structuredClone(orders.get(id)!)),
    capture: vi.fn(async (id: string) => {
      const order = orders.get(id)!
      order.status = 'COMPLETED'
      order.purchase_units![0]!.payments = {
        captures: [
          {
            id: `CAPTURE${id}`,
            status: 'COMPLETED',
            amount: order.purchase_units![0]!.amount,
            create_time: clock.value.toISOString(),
          },
        ],
      }
      return structuredClone(order)
    }),
    verify: vi.fn(async () => true),
  }
  return { gateway, orders }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe('HTTP sessions, profiles, and calculations', () => {
  it('isolates sessions, protects writes, and keeps secrets outside the state', async () => {
    const { app, agent } = setup()
    const initial = await state(agent)
    const response = await patch(agent, { profile: { ...initial.profile, name: 'Personal' } })
    expect(response.status).toBe(200)
    expect((await state(request.agent(app))).profile.name).toBe('Maya')
    expect((await agent.post('/api/reset').send({})).status).toBe(403)
    expect((await post(agent, '/api/reset').set('Origin', 'https://attacker.example')).status).toBe(
      403,
    )
    expect((await state(agent)).config).toEqual({ ai: 'demo', paypal: 'demo' })
    const cookie = (await request(app).get('/api/state')).headers['set-cookie'][0]
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
  })
  it('exposes a stable non-auth session fingerprint that rotates on reset and expiry', async () => {
    const { app, agent } = setup()
    const initial = await agent.get('/api/state')
    const fingerprint = initial.body.sessionKey as string
    const cookie = initial.headers['set-cookie'][0] as string
    const authToken = cookie.match(/^worth_session=([^;]+)/)![1]!
    expect(fingerprint).toMatch(/^[a-f0-9]{20}$/)
    expect(JSON.stringify(initial.body)).not.toContain(authToken)
    expect((await state(agent)).sessionKey).toBe(fingerprint)
    expect((await post(agent, '/api/wishlist', { productId: 'headphones' })).body.sessionKey).toBe(
      fingerprint,
    )
    const cannotAuthenticate = await request(app)
      .get('/api/state')
      .set('Cookie', `worth_session=${fingerprint}`)
    expect(cannotAuthenticate.body.sessionKey).not.toBe(fingerprint)
    const reset = await post(agent, '/api/reset')
    expect(reset.body.sessionKey).toMatch(/^[a-f0-9]{20}$/)
    expect(reset.body.sessionKey).not.toBe(fingerprint)
    expect((await state(agent)).sessionKey).toBe(reset.body.sessionKey)
    clock.value = new Date('2026-10-04T12:00:01Z')
    const expired = await state(agent)
    expect(expired.sessionKey).not.toBe(reset.body.sessionKey)
    expect(expired.sessionKey).not.toBe(fingerprint)
    expect((await state(agent)).sessionKey).toBe(expired.sessionKey)
  })
  it('rejects invalid dates, forged amounts, duplicate flow ids, and stale profile edits', async () => {
    const { agent } = setup()
    const initial = await state(agent)
    expect((await post(agent, '/api/assess', { amountCents: -1 })).status).toBe(400)
    expect(
      (await post(agent, '/api/assess', { amountCents: 100, purchaseDate: '2026-02-31' })).status,
    ).toBe(400)
    expect(
      (await post(agent, '/api/assess', { amountCents: 100, purchaseDate: '2028-01-01' })).status,
    ).toBe(400)
    expect(
      (await post(agent, '/api/checkout/create', { productId: 'headphones', amountCents: 1 }))
        .status,
    ).toBe(400)
    expect(
      (
        await patch(agent, {
          profile: {
            ...initial.profile,
            flows: [initial.profile.flows[0], initial.profile.flows[0]],
          },
        })
      ).status,
    ).toBe(400)
    expect((await patch(agent, { profile: { ...initial.profile, name: 'Updated' } })).status).toBe(
      200,
    )
    expect((await patch(agent, { profile: initial.profile })).status).toBe(409)
  })
  it('keeps a recurrence anchor on saved flows and rejects an invalid one', async () => {
    const { agent } = setup()
    const initial = await state(agent)
    const rent = {
      ...initial.profile.flows[0]!,
      cadence: 'monthly',
      nextDate: '2026-10-31',
      anchorDay: 'last',
    }
    for (const anchorDay of [0, 32, 1.5, 'first'])
      expect(
        (await patch(agent, { profile: { ...initial.profile, flows: [{ ...rent, anchorDay }] } }))
          .status,
      ).toBe(400)
    const saved = await patch(agent, { profile: { ...initial.profile, flows: [rent] } })
    expect(saved.status).toBe(200)
    expect(saved.body.profile.flows[0]).toMatchObject({ anchorDay: 'last' })
  })
  it('expires normalized personal data and deletes prior records on reset', async () => {
    const { agent, store } = setup()
    await state(agent)
    const csv =
      'Date,Name,Net,Currency,Type,Status,Transaction ID\n10/01/2026,Coffee,-5.00,USD,Payment,Completed,ABC123'
    expect((await post(agent, '/api/import/commit', { csv, dateOrder: 'MM/DD' })).status).toBe(200)
    expect((await state(agent)).profile.source).toBe('import')
    clock.value = new Date('2026-10-04T12:00:01Z')
    expect((await state(agent)).profile.source).toBe('demo')
    expect(
      (store.db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }).count,
    ).toBe(1)
    await post(agent, '/api/reset')
    expect(
      (store.db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }).count,
    ).toBe(1)
  })
  it('deduplicates repeated imports and blocks partial malformed imports', async () => {
    const { agent } = setup()
    const csv =
      'Date,Name,Net,Currency,Type,Status,Transaction ID\n10/01/2026,Coffee,-5.00,USD,Payment,Completed,ABC123'
    const first = await post(agent, '/api/import/commit', { csv, dateOrder: 'MM/DD' })
    expect(first.status).toBe(200)
    expect(first.body.profile.balanceCents).toBe(0)
    expect(first.body.profile.flows).toEqual([])
    expect(first.body.profile.confirmed).toBe(false)
    expect(
      (await post(agent, '/api/import/commit', { csv, dateOrder: 'MM/DD' })).body.transactions,
    ).toHaveLength(1)
    expect(
      (
        await post(agent, '/api/import/commit', {
          csv: csv + '\n10/02/2026,Bad,-3.0x,USD,Payment,Completed,ABC124',
          dateOrder: 'MM/DD',
        })
      ).status,
    ).toBe(400)
    expect((await state(agent)).transactions).toHaveLength(1)
  })
  it('never sends unconsented imports to an external model', async () => {
    const reply = vi.fn(async () => ({
      message: 'external',
      mode: 'anthropic' as const,
      intent: 'overview' as const,
      suggestions: [],
      toolCalls: [],
    }))
    const { agent } = setup({ chat: { reply } })
    await post(agent, '/api/import/commit', {
      csv: 'Date,Name,Net,Currency,Type,Status\n10/01/2026,Coffee,-5.00,USD,Payment,Completed',
      dateOrder: 'MM/DD',
    })
    const response = await post(agent, '/api/chat', { message: 'What did I spend?', history: [] })
    expect(response.body.mode).toBe('demo')
    expect(reply).not.toHaveBeenCalled()
    const current = await state(agent)
    await patch(agent, { profile: { ...current.profile, aiConsent: true } })
    expect(
      (await post(agent, '/api/chat', { message: 'What did I spend?', history: [] })).body.mode,
    ).toBe('anthropic')
    expect(reply).toHaveBeenCalledTimes(1)
  })
  it('rejects stale chat history after session expiry before calling an AI provider', async () => {
    const reply = vi.fn(async () => ({
      message: 'external',
      mode: 'anthropic' as const,
      intent: 'overview' as const,
      suggestions: [],
      toolCalls: [],
    }))
    const { agent } = setup({ chat: { reply } })
    await post(agent, '/api/import/commit', {
      csv: 'Date,Name,Net,Currency,Type,Status\n10/01/2026,Coffee,-5.00,USD,Payment,Completed',
      dateOrder: 'MM/DD',
    })
    const personal = await state(agent)
    await patch(agent, { profile: { ...personal.profile, aiConsent: true } })
    expect(
      (
        await post(agent, '/api/chat', {
          sessionKey: personal.sessionKey,
          message: 'Summarize this plan',
          history: [],
        })
      ).body.mode,
    ).toBe('anthropic')
    reply.mockClear()
    clock.value = new Date('2026-10-04T12:00:01Z')
    const expired = await post(agent, '/api/chat', {
      sessionKey: personal.sessionKey,
      message: 'Can I buy a $900 camera?',
      history: [{ role: 'user', content: 'Private context from my old imported plan.' }],
    })
    expect(expired.status).toBe(409)
    expect(expired.body.code).toBe('SESSION_CHANGED')
    expect(reply).not.toHaveBeenCalled()
    const refreshed = await state(agent)
    expect(refreshed.sessionKey).not.toBe(personal.sessionKey)
    expect(
      (
        await post(agent, '/api/chat', {
          sessionKey: refreshed.sessionKey,
          message: 'Summarize the new sample plan',
          history: [],
        })
      ).body.mode,
    ).toBe('anthropic')
    expect(reply).toHaveBeenCalledTimes(1)
  })
  it('requires explicit consent after manually editing a synthetic profile, for chat and category proposals', async () => {
    const reply = vi.fn(async () => ({
      message: 'external',
      mode: 'anthropic' as const,
      intent: 'overview' as const,
      suggestions: [],
      toolCalls: [],
    }))
    const categorize = vi.fn(async () => ({
      mode: 'anthropic' as const,
      suggestions: [],
      message: 'external proposals',
    }))
    const { agent } = setup({ chat: { reply, categorize } })
    const initial = await state(agent)
    expect(initial.profile.version).toBe(1)
    expect(initial.profile.aiConsent).toBe(false)
    expect(
      (await post(agent, '/api/chat', { message: 'How is the sample plan?', history: [] })).body
        .mode,
    ).toBe('anthropic')
    expect((await post(agent, '/api/transactions/categories')).body.mode).toBe('anthropic')
    expect(reply).toHaveBeenCalledTimes(1)
    expect(categorize).toHaveBeenCalledTimes(1)

    const edited = await patch(agent, {
      profile: {
        ...initial.profile,
        name: 'My real plan',
        balanceCents: 123456,
        dailySpendCents: 2711,
      },
    })
    expect(edited.status).toBe(200)
    expect(edited.body.profile.source).toBe('demo')
    expect(edited.body.profile.version).toBe(2)
    const local = await post(agent, '/api/chat', { message: 'How much can I afford?', history: [] })
    expect(local.body.mode).toBe('demo')
    expect(local.body.message).toContain('financial context was not sent to Claude')
    expect((await post(agent, '/api/transactions/categories')).body.mode).toBe('demo')
    expect(reply).toHaveBeenCalledTimes(1)
    expect(categorize).toHaveBeenCalledTimes(1)
    expect((await patch(agent, { profile: { ...edited.body.profile, version: 1 } })).status).toBe(
      409,
    )

    await patch(agent, { profile: { ...edited.body.profile, aiConsent: true } })
    expect(
      (await post(agent, '/api/chat', { message: 'How much can I afford?', history: [] })).body
        .mode,
    ).toBe('anthropic')
    expect((await post(agent, '/api/transactions/categories')).body.mode).toBe('anthropic')
    expect(reply).toHaveBeenCalledTimes(2)
    expect(categorize).toHaveBeenCalledTimes(2)
  })
  it('keeps Claude for the synthetic persona after a purchase, and ignores a client-claimed untouched flag', async () => {
    const reply = vi.fn(async () => ({
      message: 'external',
      mode: 'anthropic' as const,
      intent: 'overview' as const,
      suggestions: [],
      toolCalls: [],
    }))
    const { agent, store } = setup({ chat: { reply } })
    const ask = async () =>
      (await post(agent, '/api/chat', { message: 'How is the sample plan?', history: [] })).body
        .mode
    const created = await post(agent, '/api/checkout/create', { productId: 'headphones' })
    const captured = await post(agent, `/api/checkout/${created.body.purchase.id}/capture`)
    expect(captured.body.state.profile.version).toBe(2)
    expect(captured.body.state.profile.userEdited).toBe(false)
    expect(await ask()).toBe('anthropic')
    // A category correction on synthetic history adds no personal financial data.
    const row = captured.body.state.transactions.find(
      (t: { source: string }) => t.source === 'demo',
    )
    await agent
      .patch(`/api/transactions/${encodeURIComponent(row.id)}`)
      .set('X-Worth-Client', 'web')
      .send({ category: 'Travel' })
    expect(await ask()).toBe('anthropic')
    const current = await state(agent)
    const edited = await patch(agent, { profile: { ...current.profile, userEdited: false } })
    expect(edited.body.profile.userEdited).toBe(true)
    expect(await ask()).toBe('demo')
    // Records written before the flag existed are treated as user data.
    const id = [...(store.db.prepare('SELECT id FROM sessions').all() as { id: string }[])][0]!.id
    const legacy = store.get(id)!
    legacy.profile = { ...legacy.profile, userEdited: undefined, aiConsent: false }
    store.save(id, legacy)
    expect(await ask()).toBe('demo')
    expect(reply).toHaveBeenCalledTimes(2)
  })
  it('toggles AI consent alone without editing the plan or an active checkout', async () => {
    const reply = vi.fn(async () => ({
      message: 'external',
      mode: 'anthropic' as const,
      intent: 'overview' as const,
      suggestions: [],
      toolCalls: [],
    }))
    const { agent } = setup({ chat: { reply } })
    const imported = await post(agent, '/api/import/commit', {
      csv: 'Date,Name,Net,Currency,Type,Status\n10/01/2026,Coffee,-5.00,USD,Payment,Completed',
      dateOrder: 'MM/DD',
    })
    expect(imported.body.profile.userEdited).toBe(true)
    const ask = async () =>
      (await post(agent, '/api/chat', { message: 'What did I spend?', history: [] })).body.mode
    expect(await ask()).toBe('demo')
    await simpleProfile(agent, { confirmed: true, missingFields: [] })
    const created = await post(agent, '/api/checkout/create', { productId: 'headphones' })
    expect(created.status).toBe(200)
    const before = await state(agent)
    expect((await agent.post('/api/consent').send({ aiConsent: true })).status).toBe(403)
    expect((await post(agent, '/api/consent', { aiConsent: true, version: 1 })).status).toBe(400)
    const on = await post(agent, '/api/consent', { aiConsent: true })
    expect(on.status).toBe(200)
    expect(on.body.profile).toEqual({ ...before.profile, aiConsent: true })
    expect(await ask()).toBe('anthropic')
    const captured = await post(agent, `/api/checkout/${created.body.purchase.id}/capture`)
    expect(captured.body.purchase.status).toBe('completed')
    expect((await post(agent, '/api/consent', { aiConsent: false })).body.profile.aiConsent).toBe(
      false,
    )
    expect(await ask()).toBe('demo')
    expect(reply).toHaveBeenCalledTimes(1)
  })
  it('returns labelled deterministic assessment when AI is unavailable', async () => {
    const { agent } = setup()
    await simpleProfile(agent)
    const response = await post(agent, '/api/chat', {
      message: 'Can I afford a $900 camera?',
      history: [],
    })
    expect(response.body.mode).toBe('demo')
    expect(response.body.assessment.amountCents).toBe(90000)
    expect(response.body.message).toContain('$1,100')
    expect(response.body.message).toContain('not an AI response')
  })
})

describe('checkout reservations and payment reconciliation', () => {
  it('uses today for checkout even when a future scenario fits', async () => {
    const { agent } = setup()
    await simpleProfile(agent, {
      balanceCents: 100000,
      flows: [
        {
          id: 'salary',
          name: 'Paycheck',
          amountCents: 200000,
          nextDate: '2026-10-05',
          cadence: 'once',
          kind: 'income',
          category: 'Income',
          confirmed: true,
          active: true,
        },
      ],
    })
    const future = await post(agent, '/api/assess', {
      amountCents: 119900,
      purchaseDate: '2026-10-06',
    })
    expect(future.body.outcome).toBe('fits')
    const create = await post(agent, '/api/checkout/create', { productId: 'camera' })
    expect(create.status).toBe(409)
    expect(create.body.code).toBe('SHORTFALL_ACKNOWLEDGEMENT_REQUIRED')
    expect(create.body.assessment.purchaseDate).toBe('2026-10-03')
    expect(
      (
        await post(agent, '/api/checkout/create', {
          productId: 'camera',
          acknowledgeShortfall: true,
        })
      ).status,
    ).toBe(200)
  })
  it('reserves one slot, enforces ownership, and counts an explicit demo completion only once', async () => {
    const { app, agent } = setup()
    await simpleProfile(agent)
    const created = await post(agent, '/api/checkout/create', { productId: 'headphones' })
    expect(created.status).toBe(200)
    const id = created.body.purchase.id
    expect(
      (
        await post(agent, '/api/checkout/create', {
          productId: 'camera',
          acknowledgeShortfall: true,
        })
      ).status,
    ).toBe(409)
    expect((await post(request.agent(app), `/api/checkout/${id}/capture`)).status).toBe(404)
    expect((await post(agent, '/api/reset')).status).toBe(409)
    const completed = await post(agent, `/api/checkout/${id}/capture`)
    expect(completed.body.purchase.status).toBe('completed')
    const retry = await post(agent, `/api/checkout/${id}/capture`)
    expect(
      retry.body.state.transactions.filter((t: { source: string }) => t.source === 'purchase'),
    ).toHaveLength(1)
    const assessment = await post(agent, '/api/assess', { amountCents: 0 })
    expect(assessment.body.baselineLowestCents).toBe(165100)
    const current = await state(agent)
    await patch(agent, {
      profile: { ...current.profile, balanceCents: 165100, reflectedPurchaseIds: [id] },
    })
    expect((await post(agent, '/api/assess', { amountCents: 0 })).body.baselineLowestCents).toBe(
      165100,
    )
  })
  it('blocks profile updates while active and rejects capture across midnight', async () => {
    const { agent } = setup()
    const initial = await simpleProfile(agent)
    const created = await post(agent, '/api/checkout/create', { productId: 'headphones' })
    expect((await patch(agent, { profile: initial.profile })).status).toBe(409)
    // Remain within the absolute session lifetime but cross New York midnight.
    clock.value = new Date('2026-10-04T05:00:00Z')
    const capture = await post(agent, `/api/checkout/${created.body.purchase.id}/capture`)
    expect(capture.status).toBe(409)
    expect(capture.body.code).toBe('ASSESSMENT_EXPIRED')
    expect((await post(agent, `/api/checkout/${created.body.purchase.id}/cancel`)).status).toBe(200)
    expect((await state(agent)).purchases[0]?.status).toBe('cancelled')
  })
  it('captures sandbox once and deduplicates verified webhooks', async () => {
    const { gateway } = fakePayPal()
    const { app, agent } = setup({ paypal: gateway })
    await simpleProfile(agent)
    const created = await post(agent, '/api/checkout/create', { productId: 'headphones' })
    const id = created.body.purchase.id
    expect(created.body.mode).toBe('sandbox')
    expect((await post(agent, `/api/checkout/${id}/capture`)).body.purchase.status).toBe(
      'completed',
    )
    await post(agent, `/api/checkout/${id}/capture`)
    const event = {
      id: 'EVENT1',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { supplementary_data: { related_ids: { order_id: created.body.orderId } } },
    }
    expect((await request(app).post('/api/paypal/webhook').send(event)).status).toBe(200)
    expect((await request(app).post('/api/paypal/webhook').send(event)).body.duplicate).toBe(true)
    expect(gateway.capture).toHaveBeenCalledTimes(1)
    expect((await state(agent)).transactions.filter((t) => t.source === 'purchase')).toHaveLength(1)
  })
  it('recovers a capture timeout from order lookup without another debit', async () => {
    const { gateway, orders } = fakePayPal()
    const original = gateway.capture
    gateway.capture = vi.fn(async (orderId, purchaseId) => {
      await original(orderId, purchaseId)
      throw new Error('network timeout')
    })
    const { agent } = setup({ paypal: gateway })
    await simpleProfile(agent)
    const created = await post(agent, '/api/checkout/create', { productId: 'headphones' })
    const id = created.body.purchase.id
    expect((await post(agent, `/api/checkout/${id}/capture`)).status).toBe(502)
    expect((await state(agent)).purchases[0]?.status).toBe('unknown')
    expect(orders.get(created.body.orderId)?.status).toBe('COMPLETED')
    expect((await post(agent, `/api/checkout/${id}/capture`)).body.purchase.status).toBe(
      'completed',
    )
    expect(gateway.capture).toHaveBeenCalledTimes(1)
  })
  it('requires PayPal buyer approval and rejects mismatched capture amount', async () => {
    const { gateway, orders } = fakePayPal()
    const { agent } = setup({ paypal: gateway })
    await simpleProfile(agent)
    const created = await post(agent, '/api/checkout/create', { productId: 'headphones' })
    const id = created.body.purchase.id
    orders.get(created.body.orderId)!.status = 'CREATED'
    const unapproved = await post(agent, `/api/checkout/${id}/capture`)
    expect(unapproved.status).toBe(409)
    expect(unapproved.body.code).toBe('BUYER_APPROVAL_REQUIRED')
    orders.get(created.body.orderId)!.status = 'APPROVED'
    const original = gateway.capture
    gateway.capture = vi.fn(async (orderId, purchaseId) => {
      const order = await original(orderId, purchaseId)
      order.purchase_units![0]!.payments!.captures![0]!.amount = {
        currency_code: 'USD',
        value: '0.01',
      }
      return order
    })
    const mismatch = await post(agent, `/api/checkout/${id}/capture`)
    expect(mismatch.status).toBe(502)
    expect(mismatch.body.code).toBe('PAYMENT_MISMATCH')
    expect((await state(agent)).purchases[0]?.status).toBe('unknown')
    expect((await state(agent)).transactions.filter((t) => t.source === 'purchase')).toHaveLength(0)
  })
  it('does not release a pending sandbox capture on cancel', async () => {
    const { gateway, orders } = fakePayPal()
    const { agent } = setup({ paypal: gateway })
    await simpleProfile(agent)
    const created = await post(agent, '/api/checkout/create', { productId: 'headphones' })
    const order = orders.get(created.body.orderId)!
    order.purchase_units![0]!.payments = {
      captures: [{ id: 'PENDING1', status: 'PENDING', amount: order.purchase_units![0]!.amount }],
    }
    expect((await post(agent, `/api/checkout/${created.body.purchase.id}/cancel`)).status).toBe(409)
    expect((await state(agent)).purchases[0]?.status).toBe('pending')
  })
  it('atomically prevents two distinct checkouts while remote creation is in flight', async () => {
    const { gateway } = fakePayPal()
    const original = gateway.create
    let release!: () => void
    let started!: () => void
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    gateway.create = vi.fn(async (purchase) => {
      started()
      await gate
      return original(purchase)
    })
    const { agent } = setup({ paypal: gateway })
    await simpleProfile(agent)
    const first = post(agent, '/api/checkout/create', { productId: 'headphones' }).then(
      (response) => response,
    )
    await began
    const second = await post(agent, '/api/checkout/create', { productId: 'chair' })
    expect(second.status).toBe(409)
    expect(second.body.code).toBe('CHECKOUT_ACTIVE')
    release()
    expect((await first).status).toBe(200)
    expect(gateway.create).toHaveBeenCalledTimes(1)
    expect((await state(agent)).purchases).toHaveLength(1)
  })
  it('preserves an uncertain capture allocation and retries the same capture identity', async () => {
    const { gateway } = fakePayPal()
    const original = gateway.capture
    let attempts = 0
    gateway.capture = vi.fn(async (orderId, purchaseId) => {
      if (++attempts === 1) throw new Error('transport timeout')
      return original(orderId, purchaseId)
    })
    const { agent } = setup({ paypal: gateway })
    await simpleProfile(agent)
    const created = await post(agent, '/api/checkout/create', { productId: 'headphones' })
    const id = created.body.purchase.id
    expect((await post(agent, `/api/checkout/${id}/capture`)).status).toBe(502)
    const cancelled = await post(agent, `/api/checkout/${id}/cancel`)
    expect(cancelled.status).toBe(409)
    expect(cancelled.body.code).toBe('PAYMENT_PENDING')
    expect((await post(agent, '/api/checkout/create', { productId: 'chair' })).status).toBe(409)
    const retried = await post(agent, `/api/checkout/${id}/capture`)
    expect(retried.body.purchase.status).toBe('completed')
    expect(vi.mocked(gateway.capture).mock.calls[0]).toEqual(
      vi.mocked(gateway.capture).mock.calls[1],
    )
    expect(
      retried.body.state.transactions.filter((t: { source: string }) => t.source === 'purchase'),
    ).toHaveLength(1)
  })
  it('keeps completed captures after a late approval and flags subsequent refunds for review', async () => {
    const { gateway, orders } = fakePayPal()
    const { app, agent } = setup({ paypal: gateway })
    await simpleProfile(agent)
    const created = await post(agent, '/api/checkout/create', { productId: 'headphones' })
    const id = created.body.purchase.id
    await post(agent, `/api/checkout/${id}/capture`)
    orders.get(created.body.orderId)!.status = 'APPROVED'
    delete orders.get(created.body.orderId)!.purchase_units![0]!.payments
    await request(app)
      .post('/api/paypal/webhook')
      .send({
        id: 'LATE1',
        event_type: 'CHECKOUT.ORDER.APPROVED',
        resource: { id: created.body.orderId },
      })
    expect((await state(agent)).purchases[0]?.status).toBe('completed')
    await request(app)
      .post('/api/paypal/webhook')
      .send({
        id: 'REFUND1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: { supplementary_data: { related_ids: { order_id: created.body.orderId } } },
      })
    const current = await state(agent)
    expect(current.purchases[0]?.status).toBe('completed')
    expect(current.profile.confirmed).toBe(false)
    expect(current.profile.missingFields.join(' ')).toContain('payment changed')
  })
  it('rejects unverified webhooks before touching stored purchases', async () => {
    const { gateway } = fakePayPal()
    gateway.verify = vi.fn(async () => false)
    const { app } = setup({ paypal: gateway })
    const result = await request(app)
      .post('/api/paypal/webhook')
      .send({ id: 'EVENT1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} })
    expect(result.status).toBe(401)
    expect(gateway.get).not.toHaveBeenCalled()
  })
})

describe('local chat fallback', () => {
  it.each(['How much can I comfortably spend?', 'What can I spend?'])(
    'routes the budget question %s to current affordability overview',
    async (message) => {
      const { agent } = setup()
      const data = await simpleProfile(agent)
      const result = fallbackReply({ message, history: [] }, data)
      expect(result.intent).toBe('overview')
      expect(result.message).toContain('a purchase of up to $1,500')
      expect(result.message).not.toContain('recorded completed expenses')
    },
  )
  it('keeps a historical spending question routed to transaction totals', async () => {
    const { agent } = setup()
    const data = await simpleProfile(agent)
    const result = fallbackReply({ message: 'How much did I spend?', history: [] }, data)
    expect(result.intent).toBe('spending')
    expect(result.message).toContain('recorded completed expenses')
    expect(result.message).not.toContain('a purchase of up to')
  })

  it('reports the existing baseline shortfall instead of claiming a zero-dollar purchase preserves the cushion', async () => {
    const { agent } = setup()
    const data = await simpleProfile(agent, { balanceCents: 40000, cushionCents: 50000 })
    const result = fallbackReply({ message: 'How much can I afford?', history: [] }, data)
    expect(result.intent).toBe('overview')
    expect(result.message).toContain('already falls below your cushion before a new purchase')
    expect(result.message).toContain('$400')
    expect(result.message).toContain('$100 below')
    expect(result.message).not.toContain('would preserve')
  })
  it('distinguishes an exact-cushion plan from an existing shortfall', async () => {
    const { agent } = setup()
    const data = await simpleProfile(agent, { balanceCents: 50000, cushionCents: 50000 })
    const result = fallbackReply({ message: 'How much can I afford?', history: [] }, data)
    expect(result.message).toContain('reaches your $500 cushion')
    expect(result.message).toContain('no room for an additional purchase')
    expect(result.message).not.toContain('already falls below')
  })
  it('asks for missing information before making a baseline shortfall claim', async () => {
    const { agent } = setup()
    const data = await simpleProfile(agent, {
      balanceCents: 40000,
      cushionCents: 50000,
      confirmed: false,
    })
    const result = fallbackReply({ message: 'How much can I afford?', history: [] }, data)
    expect(result.message).toContain('Your plan needs a quick review')
    expect(result.message).not.toContain('already falls below')
  })
  it('asks for a price and does not pretend natural language is always understood', async () => {
    const { agent } = setup()
    const data = await state(agent)
    const result = fallbackReply({ message: 'Can I afford a vacation?', history: [] }, data)
    expect(result.intent).toBe('clarify')
    expect(result.assessment).toBeUndefined()
  })
})

describe('reviewable transaction category proposals', () => {
  it('returns bounded local categories without mutating history when no model is configured', async () => {
    const { agent } = setup()
    const before = await state(agent)
    const result = await post(agent, '/api/transactions/categories')
    expect(result.status).toBe(200)
    expect(result.body.mode).toBe('demo')
    expect(result.body.suggestions).toHaveLength(30)
    expect(result.body.message).toContain('not AI proposals')
    expect((await state(agent)).transactions).toEqual(before.transactions)
    expect((await state(agent)).profile.version).toBe(before.profile.version)
  })
  it('requires consent for imported category proposals and bounds the model input', async () => {
    const categorize = vi.fn(async (_transactions: AppState['transactions']) => ({
      mode: 'anthropic' as const,
      suggestions: [],
      message: 'Read-only suggestions',
    }))
    const chat = { reply: vi.fn(), categorize }
    const { agent } = setup({ chat })
    const csv =
      'Date,Name,Net,Currency,Type,Status,Transaction ID\n10/01/2026,Coffee,-5.00,USD,Payment,Completed,PRIVATE123'
    await post(agent, '/api/import/commit', { csv, dateOrder: 'MM/DD' })
    expect((await post(agent, '/api/transactions/categories')).body.mode).toBe('demo')
    expect(categorize).not.toHaveBeenCalled()
    const current = await state(agent)
    await patch(agent, { profile: { ...current.profile, aiConsent: true } })
    expect((await post(agent, '/api/transactions/categories')).body.mode).toBe('anthropic')
    expect(categorize).toHaveBeenCalledTimes(1)
    expect(categorize.mock.calls[0]![0]).toHaveLength(1)
  })
  it('applies a category correction only to the owned transaction and preserves financial inputs', async () => {
    const { app, agent } = setup()
    const csv =
      'Date,Name,Net,Currency,Type,Status,Transaction ID\n10/01/2026,Coffee,-5.00,USD,Payment,Completed,PRIVATE123'
    await post(agent, '/api/import/commit', { csv, dateOrder: 'MM/DD' })
    const before = await state(agent)
    const transaction = before.transactions[0]!
    const other = request.agent(app)
    expect(
      (
        await other
          .patch(`/api/transactions/${encodeURIComponent(transaction.id)}`)
          .set('X-Worth-Client', 'web')
          .send({ category: 'Travel' })
      ).status,
    ).toBe(404)
    const changed = await agent
      .patch(`/api/transactions/${encodeURIComponent(transaction.id)}`)
      .set('X-Worth-Client', 'web')
      .send({ category: 'Travel' })
    expect(changed.status).toBe(200)
    expect(changed.body.transactions[0]).toEqual({ ...transaction, category: 'Travel' })
    expect(changed.body.profile).toEqual({ ...before.profile, version: before.profile.version + 1 })
    expect(changed.body.profile.dailySpendCents).toBe(before.profile.dailySpendCents)
  })
  it('rejects invalid category changes and protects an active checkout', async () => {
    const { agent } = setup()
    const before = await simpleProfile(agent)
    const path = `/api/transactions/${encodeURIComponent(before.transactions[0]!.id)}`
    for (const body of [
      { category: '' },
      { category: 'x'.repeat(81) },
      { category: 'Food', amountCents: 1 },
      { category: 'Food\nInjected' },
    ]) {
      expect((await agent.patch(path).set('X-Worth-Client', 'web').send(body)).status).toBe(400)
    }
    await post(agent, '/api/checkout/create', { productId: 'headphones' })
    const blocked = await agent
      .patch(path)
      .set('X-Worth-Client', 'web')
      .send({ category: 'Travel' })
    expect(blocked.status).toBe(409)
    expect(blocked.body.code).toBe('CHECKOUT_ACTIVE')
  })
  it('sends only sanitized merchant labels and aliases, accepting validated suggestions as read-only proposals', async () => {
    const { agent } = setup()
    const before = await state(agent)
    const transactions = before.transactions
      .filter((t) => t.kind === 'expense')
      .slice(0, 35)
      .map((t, index) => ({
        ...t,
        id: `PRIVATE-IDENTITY-${index}`,
        name:
          index === 0
            ? 'Coffee alice@example.com 212-555-0199 123 Main Street https://private.example/profile'
            : 'Neighborhood Market',
      }))
    const create = vi.fn(async (_options: unknown) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ suggestions: [{ row: 'row_1', category: 'Food & drink' }] }),
        },
      ],
    }))
    const client = { messages: { create } } as unknown as NonNullable<
      Parameters<typeof createChatProvider>[2]
    >
    const provider = createChatProvider('unused-test-key', 'claude-sonnet-5-5', client)
    const response = await provider.categorize!(transactions)
    expect(response.mode).toBe('anthropic')
    expect(response.suggestions).toEqual([
      { transactionId: 'PRIVATE-IDENTITY-0', category: 'Food & drink' },
    ])
    const call = create.mock.calls[0]![0] as { model: string; messages: { content: string }[] }
    const payload = JSON.parse(call.messages[0]!.content) as { row: string; merchant: string }[]
    expect(call.model).toBe('claude-sonnet-5-5')
    expect(payload).toHaveLength(30)
    expect(Object.keys(payload[0]!)).toEqual(['row', 'merchant'])
    const serialized = JSON.stringify(call)
    for (const secret of [
      'alice@example.com',
      '212-555-0199',
      '123 Main Street',
      'https://private.example',
      'PRIVATE-IDENTITY',
      'amountCents',
      'balanceCents',
    ])
      expect(serialized).not.toContain(secret)
    expect(transactions[0]!.name).toContain('alice@example.com')
    expect(transactions[0]!.category).toBe(
      before.transactions.filter((t) => t.kind === 'expense')[0]!.category,
    )
  })
  it('rejects fabricated IDs, duplicate aliases, and arbitrary model categories', async () => {
    const { agent } = setup()
    const data = await state(agent)
    for (const suggestions of [
      [{ row: 'not-supplied', category: 'Travel' }],
      [
        { row: 'row_1', category: 'Travel' },
        { row: 'row_1', category: 'Home' },
      ],
      [{ row: 'row_1', category: 'Send money now' }],
    ]) {
      const create = vi.fn(async (_options: unknown) => ({
        content: [{ type: 'text', text: JSON.stringify({ suggestions }) }],
      }))
      const client = { messages: { create } } as unknown as NonNullable<
        Parameters<typeof createChatProvider>[2]
      >
      const provider = createChatProvider('unused-test-key', 'claude-sonnet-5-5', client)
      await expect(provider.categorize!(data.transactions)).rejects.toThrow()
    }
  })
  it('labels model failure as local categorization and leaves stored categories unchanged', async () => {
    const categorize = vi.fn(async () => {
      throw new Error('Provider unavailable')
    })
    const { agent } = setup({ chat: { reply: vi.fn(), categorize } })
    const before = await state(agent)
    const response = await post(agent, '/api/transactions/categories')
    expect(response.status).toBe(200)
    expect(response.body.mode).toBe('demo')
    expect(response.body.message).toContain('temporarily unavailable')
    expect((await state(agent)).transactions).toEqual(before.transactions)
  })
})

describe('AI financial grounding', () => {
  function mockModel(contents: unknown[][]) {
    const create = vi.fn(async (_options: unknown) => ({ content: contents.shift() ?? [] }))
    const client = { messages: { create } } as unknown as NonNullable<
      Parameters<typeof createChatProvider>[2]
    >
    return { provider: createChatProvider('unused-test-key', 'claude-sonnet-5-5', client), create }
  }
  const answer = (insight = '', intent = 'affordability', suggestions: string[] = []) => [
    { type: 'text', text: JSON.stringify({ intent, insight, suggestions }) },
  ]
  const assess = (amountCents: number, purchaseDate?: string) => [
    {
      type: 'tool_use',
      id: 'assessment-tool',
      name: 'assess_purchase',
      input: { amountCents, itemName: 'A camera', ...(purchaseDate ? { purchaseDate } : {}) },
    },
  ]
  it('cannot turn a tight purchase today into a fitting purchase by inventing a future date', async () => {
    const { agent } = setup()
    const data = await state(agent)
    const { provider, create } = mockModel([
      assess(119900, '2026-10-16'),
      answer('There is plenty of room for this purchase.'),
    ])
    const result = await provider.reply(
      { message: 'Can I afford a $1199 camera?', history: [] },
      data,
    )
    expect(result.assessment?.purchaseDate).toBe('2026-10-03')
    expect(result.assessment?.outcome).toBe('tight')
    expect(result.message).not.toContain('fits your confirmed plan')
    expect(result.message).not.toContain('plenty of room')
    const second = create.mock.calls[1]![0] as { messages: unknown[] }
    expect(JSON.stringify(second.messages)).toContain('"is_error":true')
  })
  it.each([
    ['today', '2026-10-03'],
    ['tomorrow', '2026-10-04'],
    ['the day after tomorrow', '2026-10-05'],
    ['next week', '2026-10-10'],
    ['in 3 days', '2026-10-06'],
    ['in two days', '2026-10-05'],
    ['in 2 weeks', '2026-10-17'],
    ['in 30 days', '2026-11-02'],
    ['on 2026-10-16', '2026-10-16'],
  ])(
    'uses the user-requested timing %s even when the model omits its date',
    async (timing, expectedDate) => {
      const { agent } = setup()
      const data = await simpleProfile(agent)
      const input = { message: `Can I buy a $900 camera ${timing}?`, history: [] }
      const local = fallbackReply(input, data)
      expect(local.assessment?.purchaseDate).toBe(expectedDate)
      const { provider } = mockModel([assess(90000), answer()])
      expect((await provider.reply(input, data)).assessment?.purchaseDate).toBe(expectedDate)
    },
  )
  it.each([
    ['on payday', '2026-10-08'],
    ['after my next paycheck', '2026-10-09'],
  ])('uses the confirmed income date for %s', async (timing, expectedDate) => {
    const { agent } = setup()
    const data = await state(agent)
    const { provider } = mockModel([assess(119900, expectedDate), answer()])
    const result = await provider.reply(
      { message: `Can I buy a $1199 camera ${timing}?`, history: [] },
      data,
    )
    expect(result.assessment?.purchaseDate).toBe(expectedDate)
  })
  it.each([
    'after the weekend',
    'next Friday',
    'sometime next month',
    'in 31 days',
    'on 2026-02-31',
    'on 2026-10-10 or tomorrow',
  ])(
    'requires exact timing rather than silently accepting the model date for %s',
    async (timing) => {
      const { agent } = setup()
      const data = await state(agent)
      const input = { message: `Can I buy a $1199 camera ${timing}?`, history: [] }
      expect(fallbackReply(input, data).intent).toBe('clarify')
      const { provider } = mockModel([assess(119900, '2026-10-16'), answer()])
      const result = await provider.reply(input, data)
      expect(result.intent).toBe('clarify')
      expect(result.assessment).toBeUndefined()
      expect(result.message).toMatch(/exact purchase date|exact date/)
    },
  )
  it('requires confirmed payday information instead of assuming the purchase is today', async () => {
    const { agent } = setup()
    const data = await simpleProfile(agent)
    const { provider } = mockModel([assess(90000, '2026-10-16'), answer()])
    const result = await provider.reply(
      { message: 'Can I buy a $900 camera on payday?', history: [] },
      data,
    )
    expect(result.intent).toBe('clarify')
    expect(result.assessment).toBeUndefined()
    expect(result.message).toContain('confirmed upcoming income date')
  })
  it('lets an explicit today override a future context date and refuses the stale model date', async () => {
    const { agent } = setup()
    const data = await state(agent)
    const { provider } = mockModel([assess(119900, '2026-10-16'), answer()])
    const result = await provider.reply(
      {
        message: 'Can I buy this camera today?',
        history: [],
        context: { amountCents: 119900, purchaseDate: '2026-10-16' },
      },
      data,
    )
    expect(result.assessment?.purchaseDate).toBe('2026-10-03')
    expect(result.assessment?.outcome).toBe('tight')
  })
  it('answers an open purchase-timing question using the current-date assessment and engine waiting recommendation', async () => {
    const { agent } = setup()
    const data = await state(agent)
    const { provider } = mockModel([assess(119900), answer()])
    const result = await provider.reply(
      { message: 'When can I afford a $1199 camera?', history: [] },
      data,
    )
    expect(result.assessment?.purchaseDate).toBe('2026-10-03')
    expect(result.assessment?.earliestDate).toBe('2026-10-23')
    expect(result.message).toContain('earliest date')
  })
  it('rejects a model-invented price and asks for the missing price even if the model declares approval', async () => {
    const { agent } = setup()
    const data = await simpleProfile(agent)
    const { provider, create } = mockModel([
      assess(10000),
      answer('There is plenty of room for this purchase.'),
    ])
    const result = await provider.reply({ message: 'Can I buy a camera?', history: [] }, data)
    expect(result.assessment).toBeUndefined()
    expect(result.intent).toBe('clarify')
    expect(result.message).toContain('Tell me the all-in price')
    expect(result.message).not.toContain('fits your confirmed plan')
    expect(result.message).not.toContain('plenty of room')
    const second = create.mock.calls[1]![0] as { messages: { role: string; content: unknown }[] }
    expect(JSON.stringify(second.messages)).toContain('"is_error":true')
  })
  it.each([
    'Can I buy a $900 camera?',
    'Can I buy a camera for 900 USD?',
    'The camera costs 900. Can I buy it?',
  ])(
    'accepts an explicit numeric user price and a valid later-date interpretation: %s',
    async (message) => {
      const { agent } = setup()
      const data = await simpleProfile(agent)
      const insight = 'Review the timing of your upcoming commitments before deciding.'
      const { provider } = mockModel([assess(90000, '2026-10-07'), answer(insight)])
      const result = await provider.reply(
        { message: message + ' on 2026-10-07', history: [] },
        data,
      )
      expect(result.assessment?.amountCents).toBe(90000)
      expect(result.assessment?.purchaseDate).toBe('2026-10-07')
      expect(result.message).toContain(insight)
    },
  )
  it('accepts a price from validated current context without requiring it in the message', async () => {
    const { agent } = setup()
    const data = await simpleProfile(agent)
    const { provider } = mockModel([assess(34900, '2026-10-07'), answer()])
    const result = await provider.reply(
      {
        message: 'Could I buy these headphones on the selected date?',
        history: [],
        context: { amountCents: 34900, itemName: 'Studio headphones', purchaseDate: '2026-10-07' },
      },
      data,
    )
    expect(result.assessment?.amountCents).toBe(34900)
    expect(result.assessment?.purchaseDate).toBe('2026-10-07')
  })
  it('grounds the price even when a combined question was locally routed to subscriptions', async () => {
    const { agent } = setup()
    const data = await simpleProfile(agent)
    const { provider } = mockModel([assess(90000), answer()])
    const result = await provider.reply(
      { message: 'Can I buy a $900 camera given my upcoming subscriptions?', history: [] },
      data,
    )
    expect(result.assessment?.amountCents).toBe(90000)
  })
  it('does not confuse a quantity with a purchase price or reuse model history as price evidence', async () => {
    const { agent } = setup()
    const data = await simpleProfile(agent)
    const { provider } = mockModel([assess(200), answer()])
    const result = await provider.reply(
      {
        message: 'Can I buy 2 cameras?',
        history: [{ role: 'assistant', content: 'Those cost $2.' }],
      },
      data,
    )
    expect(result.assessment).toBeUndefined()
    expect(result.intent).toBe('clarify')
  })
  it('does not let a model-authored item label inject unverified financial claims into deterministic facts', async () => {
    const { agent } = setup()
    const data = await simpleProfile(agent)
    const tool = assess(90000)
    tool[0]!.input.itemName = 'You will have ten thousand dollars left'
    const { provider } = mockModel([tool, answer()])
    const result = await provider.reply({ message: 'Can I buy a $900 camera?', history: [] }, data)
    expect(result.assessment?.itemName).toBe('Your purchase')
    expect(result.message).not.toContain('ten thousand')
    expect(result.assessment?.amountCents).toBe(90000)
  })
  it('rejects a model-selected amount different from the user price', async () => {
    const { agent } = setup()
    const data = await simpleProfile(agent)
    const { provider, create } = mockModel([assess(10000), answer()])
    const result = await provider.reply({ message: 'Can I buy a $900 camera?', history: [] }, data)
    expect(result.assessment?.amountCents).toBe(90000)
    const second = create.mock.calls[1]![0] as { messages: unknown[] }
    expect(JSON.stringify(second.messages)).toContain('"is_error":true')
  })
  it('keeps the fixed zero-cost baseline available for a general budget question', async () => {
    const { agent } = setup()
    const data = await simpleProfile(agent)
    const { provider } = mockModel([assess(0), answer()])
    const result = await provider.reply(
      { message: 'How much can I comfortably spend?', history: [] },
      data,
    )
    expect(result.intent).toBe('overview')
    expect(result.assessment).toBeUndefined()
    expect(result.message).toContain('a purchase of up to $1,500')
  })
  it('retains qualitative subscription explanations and read-only commitment tools', async () => {
    const { agent } = setup()
    const data = await state(agent)
    const insight = 'Review the timing of your upcoming commitments before deciding.'
    const { provider } = mockModel([
      [{ type: 'tool_use', id: 'commitments-tool', name: 'upcoming_commitments', input: {} }],
      answer(insight, 'subscriptions'),
    ])
    const result = await provider.reply(
      { message: 'Which subscriptions are coming up?', history: [] },
      data,
    )
    expect(result.intent).toBe('subscriptions')
    expect(result.message).toContain(insight)
    expect(result.toolCalls).toEqual(['upcoming_commitments'])
  })
  it('omits advice to sacrifice the cushion, known bills, or take on debt from every narrative field', async () => {
    const { agent } = setup()
    const data = await state(agent)
    const unsafeAdvice = [
      'Waiting until after the paycheck or lowering your cushion would change the picture.',
      'You could reduce your cushion to make room.',
      'Relaxing the buffer would improve the fit.',
      'Skipping known bills could leave room for the camera.',
      'Defer rent to create room for the camera.',
      'Borrowing could close the gap.',
      'A loan could help with the purchase.',
      'Using credit could make the purchase work.',
    ]
    for (const advice of unsafeAdvice) {
      const { provider } = mockModel([answer(advice, 'affordability', [advice])])
      const result = await provider.reply(
        { message: 'Can I afford a $1199 camera?', history: [] },
        data,
      )
      expect(result.intro).not.toContain(advice)
      expect(result.message).not.toContain(advice)
      expect(result.suggestions).not.toContain(advice)
      expect(result.assessment?.outcome).toBe('tight')
      expect(result.assessment?.amountCents).toBe(119900)
      expect(result.message).toContain('$1,199')
    }
  })
  it('preserves qualitative waiting and cheaper-alternative advice without changing the assessment', async () => {
    const { agent } = setup()
    const data = await state(agent)
    const insight = 'Waiting for your paycheck or choosing a cheaper option could improve the fit.'
    const nextQuestions = ['What if I wait for my paycheck?', 'Could I compare a lower price?']
    const { provider } = mockModel([answer(insight, 'affordability', nextQuestions)])
    const result = await provider.reply(
      { message: 'Can I afford a $1199 camera?', history: [] },
      data,
    )
    expect(result.intro).toBe(insight)
    expect(result.message).toContain(insight)
    expect(result.suggestions).toEqual(nextQuestions)
    expect(result.assessment?.outcome).toBe('tight')
    expect(result.assessment?.purchaseDate).toBe(data.today)
  })
  it.each([
    'You would have nine hundred dollars left.',
    'Your balance leaves several hundred in reserve.',
    'Your spending will fall by twenty percent.',
    'Rent clears on Friday.',
    'The next bill arrives on November first.',
  ])('omits unverified spelled-out financial facts and dates: %s', async (insight) => {
    const { agent } = setup()
    const data = await simpleProfile(agent)
    const { provider } = mockModel([answer(insight, 'affordability', [insight])])
    const result = await provider.reply({ message: 'Can I buy a $900 camera?', history: [] }, data)
    expect(result.message).not.toContain(insight)
    expect(result.suggestions).not.toContain(insight)
    expect(result.message).toContain('$900')
    expect(result.assessment?.amountCents).toBe(90000)
    expect(result.message).toContain('$1,100')
  })
})

describe('hosted abuse limits', () => {
  it('rate-limits by the client IP appended by the trusted proxy, not by spoofable entries', async () => {
    const { app } = setup({ config: { ...config, trustProxy: 1, requestsPerMinute: 3 } })
    const visitor = request.agent(app)
    const get = (forwardedFor: string, agent = visitor) =>
      agent.get('/api/state').set('X-Forwarded-For', forwardedFor)
    for (let i = 0; i < 3; i++) expect((await get('203.0.113.7')).status).toBe(200)
    expect((await get('203.0.113.7')).status).toBe(429)
    expect((await get('198.51.100.20', request.agent(app))).status).toBe(200)
    // Only the hop appended by the proxy is trusted, so a forged left-hand entry changes nothing.
    expect((await get('192.0.2.1, 203.0.113.7')).status).toBe(429)
    clock.value = new Date(clock.value.getTime() + 60_000)
    expect((await get('203.0.113.7')).status).toBe(200)
  })
  it('ignores X-Forwarded-For when no proxy is trusted', async () => {
    const { app } = setup({ config: { ...config, trustProxy: 0, requestsPerMinute: 3 } })
    const visitor = request.agent(app)
    for (let i = 0; i < 3; i++)
      expect(
        (await visitor.get('/api/state').set('X-Forwarded-For', `203.0.113.${i}`)).status,
      ).toBe(200)
    expect(
      (await request.agent(app).get('/api/state').set('X-Forwarded-For', '198.51.100.20')).status,
    ).toBe(429)
  })
})

describe('demo purchases stay out of imported finances', () => {
  it('archives persona purchases on import so they leave the forecast, activity, and AI context', async () => {
    const reply = vi.fn(async (_input: unknown, _data: { purchases: unknown[] }) => ({
      message: 'external',
      mode: 'anthropic' as const,
      intent: 'overview' as const,
      suggestions: [],
      toolCalls: [],
    }))
    const { gateway } = fakePayPal()
    const { app, agent } = setup({ chat: { reply }, paypal: gateway })
    await state(agent)
    const created = await post(agent, '/api/checkout/create', { productId: 'headphones' })
    const captured = await post(agent, `/api/checkout/${created.body.purchase.id}/capture`)
    expect(captured.body.purchase.status).toBe('completed')
    expect(
      captured.body.state.transactions.some((t: { source: string }) => t.source === 'purchase'),
    ).toBe(true)
    const csv =
      'Date,Name,Net,Currency,Type,Status,Transaction ID\n09/20/2026,Coffee,-5.00,USD,Payment,Completed,C1\n10/01/2026,Coffee,-5.00,USD,Payment,Completed,C2'
    expect((await post(agent, '/api/import/preview', { csv })).body.duplicates).toBe(0)
    const imported = await post(agent, '/api/import/commit', { csv })
    expect(imported.status).toBe(200)
    expect(imported.body.purchases).toEqual([])
    expect(imported.body.transactions.map((t: { source: string }) => t.source)).toEqual([
      'import',
      'import',
    ])
    // The user enters their real funds; the persona's purchase was never paid from them.
    const real = {
      ...imported.body.profile,
      balanceCents: 200000,
      cushionCents: 50000,
      confirmed: true,
      missingFields: [],
    }
    const forged = await patch(agent, {
      profile: { ...real, reflectedPurchaseIds: [created.body.purchase.id] },
    })
    expect(forged.status).toBe(400)
    expect(forged.body.code).toBe('INVALID_SNAPSHOT')
    const saved = await patch(agent, { profile: real })
    expect(saved.status).toBe(200)
    const daily = saved.body.profile.dailySpendCents as number
    const assessed = await post(agent, '/api/assess', { amountCents: 0 })
    expect(assessed.body.outcome).toBe('fits')
    expect(assessed.body.points[0].events.map((e: { name: string }) => e.name)).toEqual([
      'Everyday spending',
    ])
    expect(assessed.body.points[0].baselineCents).toBe(200000 - daily)
    await post(agent, '/api/consent', { aiConsent: true })
    await post(agent, '/api/chat', { message: 'What is coming up?', history: [] })
    expect(reply.mock.calls[0]![1].purchases).toEqual([])
    // A late refund for the archived sandbox payment does not unsettle the user's plan.
    await request(app)
      .post('/api/paypal/webhook')
      .send({
        id: 'REFUND-ARCHIVED',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: { supplementary_data: { related_ids: { order_id: created.body.orderId } } },
      })
    expect((await state(agent)).profile.confirmed).toBe(true)
    // Purchases made with the user's own plan still count.
    const own = await post(agent, '/api/checkout/create', { productId: 'chair' })
    expect(own.status).toBe(200)
    const after = await post(agent, '/api/assess', { amountCents: 0 })
    expect(after.body.points[0].events[0]).toMatchObject({ amountCents: -44900, kind: 'purchase' })
  })
})

describe('demo dates follow the viewer', () => {
  const localDate = (timeZone: string, at: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone }).format(at)
  // UTC−10 through UTC+14, including half- and quarter-hour offsets.
  const zones = [
    'Pacific/Honolulu',
    'America/Anchorage',
    'America/Los_Angeles',
    'America/Chicago',
    'America/New_York',
    'America/Sao_Paulo',
    'UTC',
    'Europe/London',
    'Europe/Berlin',
    'Europe/Moscow',
    'Asia/Dubai',
    'Asia/Kolkata',
    'Asia/Kathmandu',
    'Asia/Shanghai',
    'Asia/Tokyo',
    'Australia/Adelaide',
    'Pacific/Auckland',
    'Pacific/Tongatapu',
    'Pacific/Kiritimati',
  ]
  it('keeps the untouched persona complete and buyable at every hour from UTC−10 to UTC+14', async () => {
    const { app } = setup({
      config: { ...config, sessionIpHourlyLimit: 10_000, requestsPerMinute: 10_000 },
    })
    const start = new Date('2026-10-03T00:20:00Z').getTime()
    clock.value = new Date(start)
    const viewers = zones.map((zone) => ({ zone, agent: request.agent(app) }))
    const check = async (agent: ReturnType<typeof request.agent>, zone: string) => {
      const send = <T extends { set: (k: string, v: string) => T }>(test: T) =>
        test.set('X-Worth-Timezone', zone).set('X-Worth-Client', 'web')
      const expected = localDate(zone, clock.value)
      const assessed = await send(agent.post('/api/assess')).send({ amountCents: 34900 })
      expect([zone, clock.value.toISOString(), assessed.body.today, assessed.body.outcome]).toEqual(
        [zone, clock.value.toISOString(), expected, 'fits'],
      )
      const created = await send(agent.post('/api/checkout/create')).send({
        productId: 'headphones',
      })
      expect([zone, clock.value.toISOString(), created.status]).toEqual([
        zone,
        clock.value.toISOString(),
        200,
      ])
      const cancelled = await send(
        agent.post(`/api/checkout/${created.body.purchase.id}/cancel`),
      ).send({})
      expect(cancelled.status).toBe(200)
      expect(cancelled.body.profile).toMatchObject({ timezone: zone, snapshotDate: expected })
    }
    for (let hour = 0; hour < 24; hour++) {
      clock.value = new Date(start + hour * 60 * 60_000)
      for (const { zone, agent } of viewers) await check(agent, zone)
      // A session created at this hour is valid immediately as well.
      await check(request.agent(app), zones[hour % zones.length]!)
    }
  })
  it('rolls the persona past New York midnight even without a time zone header', async () => {
    const { agent } = setup()
    clock.value = new Date('2026-10-04T03:30:00Z')
    expect((await post(agent, '/api/assess', { amountCents: 34900 })).body.outcome).toBe('fits')
    const before = await state(agent)
    // 00:30 in New York, inside the same 24-hour session.
    clock.value = new Date('2026-10-04T04:30:00Z')
    const after = await post(agent, '/api/assess', { amountCents: 34900 })
    expect(after.body).toMatchObject({ outcome: 'fits', today: '2026-10-04' })
    expect((await post(agent, '/api/checkout/create', { productId: 'headphones' })).status).toBe(
      200,
    )
    const rolled = await state(agent)
    expect(rolled.profile.snapshotDate).toBe('2026-10-04')
    expect(rolled.profile.flows.map((f) => f.nextDate)).toEqual(
      before.profile.flows.map((f) => addDays(f.nextDate, 1)),
    )
    const synthetic = (s: AppState) => s.transactions.filter((t) => t.source === 'demo')
    expect(synthetic(rolled).map((t) => t.date)).toEqual(
      synthetic(before).map((t) => addDays(t.date, 1)),
    )
    // An editor opened before the rollover cannot save the stale dates.
    expect((await patch(agent, { profile: before.profile })).status).toBe(409)
  })
  it('ignores an unsupported time zone header and leaves edited plans on their own dates', async () => {
    const { agent } = setup()
    const invalid = await agent.get('/api/state').set('X-Worth-Timezone', 'Mars/Olympus_Mons')
    expect(invalid.body.profile.timezone).toBe('America/New_York')
    await simpleProfile(agent)
    clock.value = new Date('2026-10-04T05:00:00Z')
    const next = await agent.get('/api/state').set('X-Worth-Timezone', 'Asia/Tokyo')
    expect(next.body.profile).toMatchObject({
      timezone: 'America/New_York',
      snapshotDate: '2026-10-03',
    })
    expect((await post(agent, '/api/assess', { amountCents: 100 })).body.outcome).toBe('incomplete')
  })
  it('imports with the user’s time zone, stores it, and keeps it editable', async () => {
    const { app } = setup()
    // 01:30 on Oct 4 in India; still Oct 3 in New York.
    clock.value = new Date('2026-10-03T20:00:00Z')
    const csv =
      'Date,Time,TimeZone,Name,Type,Status,Currency,Net,Transaction ID\n2026-10-04,01:05:00,IST,Coffee,Express Checkout Payment,Completed,USD,-4.00,TZ1'
    const viewer = (zone: string) => {
      const agent = request.agent(app)
      const send = (path: string, body: object) =>
        post(agent, path, body).set('X-Worth-Timezone', zone)
      return { agent, send }
    }
    const india = viewer('Asia/Kolkata')
    const imported = await india.send('/api/import/commit', { csv })
    expect(imported.status).toBe(200)
    expect(imported.body.today).toBe('2026-10-04')
    expect(imported.body.profile).toMatchObject({ timezone: 'Asia/Kolkata', userEdited: true })
    const newYork = viewer('America/New_York')
    const preview = await newYork.send('/api/import/preview', { csv })
    expect(preview.body.errors[0].message).toContain('Future-dated')
    expect((await newYork.send('/api/import/commit', { csv })).status).toBe(400)
    const edited = await india.agent
      .patch('/api/profile')
      .set('X-Worth-Client', 'web')
      .set('X-Worth-Timezone', 'Asia/Kolkata')
      .send({
        profile: {
          ...imported.body.profile,
          timezone: 'Europe/London',
          snapshotDate: '2026-10-03',
        },
      })
    expect(edited.status).toBe(200)
    const later = await india.agent.get('/api/state').set('X-Worth-Timezone', 'Asia/Kolkata')
    expect(later.body.profile.timezone).toBe('Europe/London')
    expect(later.body.today).toBe('2026-10-03')
  })
})

describe('session storage bounds', () => {
  it('indexes expiry and leaves expired-row cleanup to the timer', async () => {
    const { app, store, agent } = setup()
    const plan = store.db
      .prepare('EXPLAIN QUERY PLAN DELETE FROM sessions WHERE expires <= ?')
      .all(0) as { detail: string }[]
    expect(plan.map((row) => row.detail).join(' ')).toContain('sessions_expires')
    const cleanup = vi.spyOn(store, 'cleanup')
    await state(agent)
    await state(request.agent(app))
    await post(agent, '/api/wishlist', { productId: 'chair' })
    expect(cleanup).not.toHaveBeenCalled()
    clock.value = new Date('2026-10-04T12:00:01Z')
    expect(store.count(clock.value.getTime())).toBe(0)
    expect(app.locals.cleanup()).toBe(2)
    expect(cleanup).toHaveBeenCalledOnce()
  })
  it('limits new sessions per client IP without affecting existing sessions', async () => {
    const { app } = setup({ config: { ...config, trustProxy: 1, sessionIpHourlyLimit: 2 } })
    const visitor = (ip: string) => request.agent(app).get('/api/state').set('X-Forwarded-For', ip)
    const existing = request.agent(app)
    expect((await existing.get('/api/state').set('X-Forwarded-For', '203.0.113.7')).status).toBe(
      200,
    )
    expect((await visitor('203.0.113.7')).status).toBe(200)
    const limited = await visitor('203.0.113.7')
    expect(limited.status).toBe(429)
    expect(limited.body.code).toBe('SESSION_RATE_LIMITED')
    expect(limited.headers['set-cookie']).toBeUndefined()
    expect((await existing.get('/api/state').set('X-Forwarded-For', '203.0.113.7')).status).toBe(
      200,
    )
    expect((await post(existing, '/api/reset').set('X-Forwarded-For', '203.0.113.7')).status).toBe(
      200,
    )
    expect((await visitor('198.51.100.20')).status).toBe(200)
    clock.value = new Date(clock.value.getTime() + 60 * 60_000)
    expect((await visitor('203.0.113.7')).status).toBe(200)
  })
  it('refuses new sessions beyond the live-session cap and counts only unexpired ones', async () => {
    const { app, store } = setup({ config: { ...config, maxSessions: 2 } })
    expect((await request(app).get('/api/state')).status).toBe(200)
    expect((await request(app).get('/api/state')).status).toBe(200)
    const full = await request(app).get('/api/state')
    expect(full.status).toBe(503)
    expect(full.body.code).toBe('AT_CAPACITY')
    expect(store.count(clock.value.getTime())).toBe(2)
    clock.value = new Date('2026-10-04T12:00:01Z')
    expect((await request(app).get('/api/state')).status).toBe(200)
  })
})

describe('Claude request budgets', () => {
  function countingChat() {
    let inFlight = 0
    let peak = 0
    const reply = vi.fn(async () => {
      peak = Math.max(peak, ++inFlight)
      await new Promise((resolve) => setTimeout(resolve, 20))
      inFlight--
      return {
        message: 'external',
        mode: 'anthropic' as const,
        intent: 'overview' as const,
        suggestions: [],
        toolCalls: [],
      }
    })
    const categorize = vi.fn(async () => ({
      mode: 'anthropic' as const,
      suggestions: [],
      message: 'external proposals',
    }))
    return { chat: { reply, categorize }, peak: () => peak }
  }
  it('holds 40 parallel anonymous chat requests to the per-IP budget with labelled local answers', async () => {
    const { chat, peak } = countingChat()
    const { app } = setup({
      chat,
      config: { ...config, claudeIpHourlyLimit: 5, sessionIpHourlyLimit: 100 },
    })
    const replies = await Promise.all(
      Array.from({ length: 40 }, () =>
        post(request.agent(app), '/api/chat', { message: 'How is the sample plan?', history: [] }),
      ),
    )
    expect(replies.every((r) => r.status === 200)).toBe(true)
    expect(chat.reply).toHaveBeenCalledTimes(5)
    expect(peak()).toBeLessThanOrEqual(5)
    const local = replies.filter((r) => r.body.mode === 'demo')
    expect(local).toHaveLength(35)
    for (const r of local) {
      expect(r.body.intro).toContain('Claude limit for the hour')
      expect(r.body.message).toContain('not an AI response')
    }
    clock.value = new Date(clock.value.getTime() + 60 * 60_000)
    const later = await post(request.agent(app), '/api/chat', { message: 'Hello?', history: [] })
    expect(later.body.mode).toBe('anthropic')
  })
  it('enforces a server-wide daily budget across client IPs, including category proposals', async () => {
    const { chat } = countingChat()
    const { app } = setup({
      chat,
      config: { ...config, trustProxy: 1, claudeIpHourlyLimit: 100, claudeDailyLimit: 3 },
    })
    const ask = (ip: string) =>
      post(request.agent(app), '/api/chat', { message: 'Hi', history: [] }).set(
        'X-Forwarded-For',
        ip,
      )
    const modes = []
    for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4'])
      modes.push((await ask(ip)).body.mode)
    expect(modes).toEqual(['anthropic', 'anthropic', 'anthropic', 'demo'])
    const categories = await post(request.agent(app), '/api/transactions/categories').set(
      'X-Forwarded-For',
      '203.0.113.5',
    )
    expect(categories.body.mode).toBe('demo')
    expect(categories.body.message).toContain('allowance for today is used up')
    expect(chat.categorize).not.toHaveBeenCalled()
    const exhausted = await ask('203.0.113.6')
    expect(exhausted.body.intro).toContain('allowance for today is used up')
    expect(chat.reply).toHaveBeenCalledTimes(3)
    clock.value = new Date(clock.value.getTime() + 24 * 60 * 60_000)
    expect((await ask('203.0.113.7')).body.mode).toBe('anthropic')
  })
  it('does not spend the Claude allowance on requests rejected while an answer is in flight', async () => {
    const { chat } = countingChat()
    const { agent } = setup({ chat, config: { ...config, claudeIpHourlyLimit: 2 } })
    await agent.get('/api/state')
    const burst = await Promise.all(
      Array.from({ length: 3 }, () => post(agent, '/api/chat', { message: 'Hi', history: [] })),
    )
    expect(burst.filter((r) => r.status === 200 && r.body.mode === 'anthropic')).toHaveLength(1)
    expect(burst.filter((r) => r.status === 429 && r.body.code === 'CHAT_BUSY')).toHaveLength(2)
    const next = await post(agent, '/api/chat', { message: 'Hi again', history: [] })
    expect(next.body.mode).toBe('anthropic')
    expect(chat.reply).toHaveBeenCalledTimes(2)
  })
})

describe('real PayPal exports', () => {
  it('imports the actual sandbox personal export without counting its account correction', async () => {
    const { agent } = setup()
    const csv = fixture('paypal-personal-sandbox.csv')
    const preview = await post(agent, '/api/import/preview', { csv })
    expect(preview.body.errors).toEqual([])
    expect(preview.body.adjustments).toHaveLength(1)
    const imported = await post(agent, '/api/import/commit', { csv })
    expect(imported.status).toBe(200)
    expect(imported.body.profile).toMatchObject({ source: 'import', dailySpendCents: 0, flows: [] })
    expect(imported.body.transactions).toMatchObject([
      { name: 'General Account Correction', amountCents: 500000, kind: 'adjustment' },
    ])
    const empty = await post(agent, '/api/import/commit', {
      csv: fixture('paypal-personal-sandbox-empty.csv'),
    })
    expect(empty.body.code).toBe('EMPTY_IMPORT')
  })
})

describe('acceptance case 24: a realistic personal export', () => {
  it('imports, holds back a positive result until foreign spending is resolved, and keeps rent on month end', async () => {
    const { agent } = setup()
    const imported = await post(agent, '/api/import/commit', {
      csv: fixture('paypal-personal-expanded.csv'),
    })
    expect(imported.status).toBe(200)
    const profile = imported.body.profile as AppState['profile']
    expect(profile.missingFields).toEqual([
      'Confirm current available funds, income, upcoming bills, and everyday spending after import.',
      'Your import shows a Pay in 4 or Pay Later plan (Test Store). Add any payments still due to your upcoming bills, or confirm it is paid off.',
      'Resolve 1 foreign-currency payment from your import in Activity: enter what it cost in USD, or mark it as a one-off.',
    ])
    expect(profile.flows.find((flow) => flow.name === 'Maple Court Apartments rent')).toMatchObject(
      {
        nextDate: '2026-10-31',
        anchorDay: 'last',
        confirmed: false,
      },
    )
    // The user confirms today's funds and every suggestion.
    const confirm = (current: AppState['profile'], dailySpendCents: number) =>
      patch(agent, {
        profile: {
          ...current,
          balanceCents: 400000,
          cushionCents: 50000,
          dailySpendCents,
          snapshotDate: '2026-10-03',
          confirmed: true,
          missingFields: [],
          flows: current.flows.map((flow) => ({ ...flow, confirmed: true })),
        },
      })
    const confirmed = await confirm(profile, profile.dailySpendCents)
    expect(confirmed.status).toBe(200)
    const held = await post(agent, '/api/assess', { amountCents: 10000 })
    expect(held.body.outcome).toBe('incomplete')
    expect(held.body.missingFields).toEqual([
      'Resolve 1 foreign-currency payment from your import in Activity: enter what it cost in USD, or mark it as a one-off.',
    ])
    // Rent paid on Jul 31, Aug 31 and Sep 30 is next due on Oct 31, then Nov 30.
    expect(
      (held.body.drivers as { name: string; date: string }[])
        .filter((driver) => driver.name === 'Maple Court Apartments rent')
        .map((driver) => driver.date),
    ).toEqual(['2026-10-31', '2026-11-30'])

    const resolved = await post(
      agent,
      `/api/import/unresolved/${encodeURIComponent('paypal:PX0000016')}`,
      { amountCents: 5340 },
    )
    expect(resolved.status).toBe(200)
    const suggested = Math.round((20711 + 5340) / 63)
    expect(resolved.body.profile.missingFields).toEqual([
      `Review your everyday spending: with London theatre box office included, your imported history suggests $${(suggested / 100).toFixed(2)} a day, more than your $${(profile.dailySpendCents / 100).toFixed(2)} estimate.`,
    ])
    expect((await confirm(resolved.body.profile, suggested)).status).toBe(200)
    const fits = await post(agent, '/api/assess', { amountCents: 10000 })
    expect(fits.body).toMatchObject({ outcome: 'fits', missingFields: [] })
  })
})

describe('foreign-currency imports', () => {
  it('imports a business export with a matched conversion, memo rows and holds', async () => {
    const { agent } = setup()
    const imported = await post(agent, '/api/import/commit', {
      csv: fixture('paypal-business-fx-memo.csv'),
    })
    expect(imported.status).toBe(200)
    const transactions = imported.body.transactions as AppState['transactions']
    expect(transactions.filter((t) => t.name === 'Ceramics studio Berlin')).toMatchObject([
      { amountCents: -5012, currency: 'USD', kind: 'expense' },
    ])
    // Holds, memo rows and both conversion legs are not separate records.
    const ids = transactions.map((t) => t.id)
    for (const left of ['9UH00001AA', '9UR00001AA', 'AOB00001AA', 'CNF00001AA', '7CV00001AA'])
      expect(ids).not.toContain(`paypal:${left}`)
    expect(ids).not.toContain('paypal:7CV00002AA')
    expect(imported.body.profile).toMatchObject({
      coverageDays: 61,
      dailySpendCents: Math.round(11352 / 61),
    })
  })
})

describe('unresolved foreign-currency payments', () => {
  const csv = [
    'Date,Time,Name,Type,Status,Currency,Net,Transaction ID',
    '2026-09-10,09:00:00,Lisbon bakery,Express Checkout Payment,Completed,EUR,-12.00,F1',
    '2026-09-11,09:00:00,London theatre,Express Checkout Payment,Completed,GBP,-40.00,F2',
    '2026-09-14,09:00:00,Coffee,Express Checkout Payment,Completed,USD,-4.00,U1',
  ].join('\n')
  const resolve = (agent: ReturnType<typeof request.agent>, id: string, body: object) =>
    post(agent, `/api/import/unresolved/${encodeURIComponent(id)}`, body)
  const assess = async (agent: ReturnType<typeof request.agent>) =>
    (await post(agent, '/api/assess', { amountCents: 100 })).body as {
      outcome: string
      missingFields: string[]
    }

  it('withholds every positive result until each payment is resolved', async () => {
    const { agent } = setup()
    const preview = await post(agent, '/api/import/preview', { csv })
    expect(preview.body.unresolved.map((p: { id: string }) => p.id)).toEqual([
      'paypal:F1',
      'paypal:F2',
    ])
    const imported = await post(agent, '/api/import/commit', { csv })
    expect(imported.status).toBe(200)
    expect(imported.body.foreignPayments).toHaveLength(2)
    expect(imported.body.transactions.map((t: { id: string }) => t.id)).toEqual(['paypal:U1'])
    // Confirming the plan does not clear the foreign-currency entry.
    const saved = await simpleProfile(agent, { confirmed: true, missingFields: [] })
    expect(saved.profile.missingFields).toEqual([
      'Resolve 2 foreign-currency payments from your import in Activity: enter what each one cost in USD, or mark each one as a one-off.',
    ])
    expect(await assess(agent)).toMatchObject({ outcome: 'incomplete' })
    const checkout = await post(agent, '/api/checkout/create', { productId: 'headphones' })
    expect(checkout.body.code).toBe('PLAN_INCOMPLETE')

    const converted = await resolve(agent, 'paypal:F1', { amountCents: 1337 })
    expect(converted.status).toBe(200)
    expect(converted.body.profile.version).toBe(saved.profile.version + 1)
    // History now runs from the bakery on Sep 10 to the coffee on Sep 14.
    expect(converted.body.profile.coverageDays).toBe(5)
    expect(converted.body.transactions.find((t: { id: string }) => t.id === 'paypal:F1')).toEqual(
      expect.objectContaining({ amountCents: -1337, currency: 'USD', kind: 'expense' }),
    )
    expect(converted.body.profile.missingFields).toEqual([
      'Review your everyday spending: with Lisbon bakery included, your imported history suggests $3.47 a day, more than your $0 estimate.',
      'Resolve 1 foreign-currency payment from your import in Activity: enter what it cost in USD, or mark it as a one-off.',
    ])
    expect((await resolve(agent, 'paypal:F1', { oneOff: true })).body.code).toBe('ALREADY_RESOLVED')
    const oneOff = await resolve(agent, 'paypal:F2', { oneOff: true })
    expect(oneOff.status).toBe(200)
    expect(oneOff.body.foreignPayments.map((p: { resolution: unknown }) => p.resolution)).toEqual([
      { kind: 'usd', amountCents: 1337 },
      { kind: 'oneOff' },
    ])
    expect(oneOff.body.transactions.some((t: { id: string }) => t.id === 'paypal:F2')).toBe(false)
    // The spending review is the last thing standing; saving the plan clears it.
    expect((await assess(agent)).missingFields).toEqual([
      expect.stringContaining('Review your everyday spending'),
    ])
    await simpleProfile(agent, { confirmed: true, missingFields: [], dailySpendCents: 347 })
    expect(await assess(agent)).toMatchObject({ outcome: 'fits', missingFields: [] })

    // Importing the same file again raises nothing that was already answered.
    const again = await post(agent, '/api/import/preview', { csv })
    expect(again.body).toMatchObject({ unresolved: [], duplicates: 3 })
  })

  it('validates resolutions and refuses unknown payments', async () => {
    const { agent } = setup()
    await post(agent, '/api/import/commit', { csv })
    for (const body of [{}, { amountCents: 0 }, { amountCents: 12.5 }, { oneOff: false }])
      expect((await resolve(agent, 'paypal:F1', body)).status).toBe(400)
    expect((await resolve(agent, 'paypal:F1', { amountCents: 100, oneOff: true })).status).toBe(400)
    expect((await resolve(agent, 'paypal:NOPE', { oneOff: true })).status).toBe(404)
    expect((await state(agent)).profile.missingFields).toContain(
      'Resolve 2 foreign-currency payments from your import in Activity: enter what each one cost in USD, or mark each one as a one-off.',
    )
  })

  it('keeps answered payments when a later import adds new ones', async () => {
    const { agent } = setup()
    await post(agent, '/api/import/commit', { csv })
    await resolve(agent, 'paypal:F1', { oneOff: true })
    const more = await post(agent, '/api/import/commit', {
      csv: `${csv}\n2026-09-20,09:00:00,Tokyo stationery,Express Checkout Payment,Completed,JPY,"-4,500.00",F3`,
    })
    expect(more.status).toBe(200)
    expect(
      more.body.foreignPayments.map((p: { id: string; resolution?: unknown }) => [
        p.id,
        p.resolution ?? null,
      ]),
    ).toEqual([
      ['paypal:F1', { kind: 'oneOff' }],
      ['paypal:F2', null],
      ['paypal:F3', null],
    ])
    expect(more.body.profile.missingFields).toContain(
      'Resolve 2 foreign-currency payments from your import in Activity: enter what each one cost in USD, or mark each one as a one-off.',
    )
  })
})

describe('Pay in 4 rows in an import', () => {
  it('proposes the plan for review instead of counting it as spending', async () => {
    const { agent } = setup()
    const csv = [
      '"Date","Time","TimeZone","Name","Type","Status","Currency","Amount","Fees","Total","Exchange Rate","Receipt ID","Balance","Transaction ID","Item Title"',
      '"09/28/2026","14:02:11","EDT","Test Store","Pay in 4","Completed","USD","-1,199.00","0.00","-1,199.00","","","","S1",""',
      '"09/28/2026","14:02:11","EDT","Pay in 4","Authorization","Pending","USD","-299.75","0.00","-299.75","","","","S2",""',
    ].join('\n')
    const preview = await post(agent, '/api/import/preview', { csv })
    expect(preview.body.instalmentPlans).toMatchObject([
      { name: 'Test Store', purchaseCents: 119900, paymentCents: 29975 },
    ])
    const imported = await post(agent, '/api/import/commit', { csv })
    expect(imported.status).toBe(200)
    expect(imported.body.profile.dailySpendCents).toBe(0)
    expect(imported.body.profile.missingFields).toContain(
      'Your import shows a Pay in 4 or Pay Later plan (Test Store). Add any payments still due to your upcoming bills, or confirm it is paid off.',
    )
  })
})

describe('import date order', () => {
  it('refuses to import an ambiguous file until the user chooses the date order', async () => {
    const { agent } = setup()
    const csv = fixture('paypal-ambiguous-dates.csv')
    const preview = await post(agent, '/api/import/preview', { csv })
    expect(preview.body).toMatchObject({ needsDateOrder: true, dateOrder: null, transactions: [] })
    const refused = await post(agent, '/api/import/commit', { csv })
    expect(refused.status).toBe(400)
    expect(refused.body.code).toBe('DATE_ORDER_REQUIRED')
    expect((await state(agent)).profile.source).toBe('demo')
    expect((await post(agent, '/api/import/commit', { csv, dateOrder: 'D/M' })).status).toBe(400)
    const imported = await post(agent, '/api/import/commit', { csv, dateOrder: 'DD/MM' })
    expect(imported.status).toBe(200)
    expect(imported.body.transactions.map((t: { date: string }) => t.date).slice(-2)).toEqual([
      '2026-09-01',
      '2026-08-05',
    ])
    expect(imported.body.profile).toMatchObject({ coverageDays: 36, dailySpendCents: 1170 })
    expect(imported.body.profile.flows).toMatchObject([
      { name: 'Video streaming subscription', nextDate: '2026-10-05', confirmed: false },
    ])
  })
  it('imports a UK export without asking because its dates decide the order', async () => {
    const { agent } = setup()
    const csv = fixture('paypal-uk-ddmm.csv')
    expect((await post(agent, '/api/import/preview', { csv })).body).toMatchObject({
      needsDateOrder: false,
      dateOrder: 'DD/MM',
      errors: [],
    })
    const imported = await post(agent, '/api/import/commit', { csv })
    expect(imported.status).toBe(200)
    expect(imported.body.profile.flows.map((f: { nextDate: string }) => f.nextDate)).toEqual([
      '2026-10-05',
      '2026-10-31',
    ])
  })
})

describe('import size limit', () => {
  it('accepts a fully quoted export just under 1 MB and rejects one just over it', async () => {
    const { agent } = setup()
    const header =
      '"Date","Time","TimeZone","Name","Type","Status","Currency","Amount","Fees","Total","Exchange Rate","Receipt ID","Balance","Transaction ID","Item Title"'
    // Quotes inside a field double in CSV and double again as JSON, so the request body is about
    // twice the size of the file.
    const title = `"${'""'.repeat(420)}"`
    const rows = (count: number) =>
      [
        header,
        ...Array.from(
          { length: count },
          (_, index) =>
            `"09/30/2026","12:00:00","EDT","Coffee","Express Checkout Payment","Completed","USD","-5.00","0.00","-5.00","","","0.00","Q${index}",${title}`,
        ),
      ].join('\r\n')
    const under = rows(1_000)
    expect(utf8Bytes(under)).toBeLessThan(CSV_IMPORT_LIMITS.maxBytes)
    expect(JSON.stringify({ csv: under }).length).toBeGreaterThan(1_200 * 1024)
    const preview = await post(agent, '/api/import/preview', { csv: under })
    expect(preview.status).toBe(200)
    expect(preview.body.errors).toEqual([])
    expect(preview.body.transactions).toHaveLength(1_000)
    const over = rows(1_100)
    expect(utf8Bytes(over)).toBeGreaterThan(CSV_IMPORT_LIMITS.maxBytes)
    const rejected = await post(agent, '/api/import/commit', { csv: over })
    expect(rejected.status).toBe(400)
    expect(rejected.body.error).toBe('Use a CSV smaller than 1 MB.')
    expect((await state(agent)).profile.source).toBe('demo')
  })
})

describe('stored transaction cap', () => {
  it('rejects imports that would exceed the per-session transaction cap with a clear message', async () => {
    const { agent } = setup({ config: { ...config, maxTransactions: 3 } })
    const rows = (ids: string[]) =>
      'Date,Name,Net,Currency,Type,Status,Transaction ID\n' +
      ids.map((id) => `10/01/2026,Coffee ${id},-5.00,USD,Payment,Completed,${id}`).join('\n')
    expect(
      (await post(agent, '/api/import/commit', { csv: rows(['A', 'B']), dateOrder: 'MM/DD' }))
        .status,
    ).toBe(200)
    // Re-importing known rows does not count twice.
    expect(
      (await post(agent, '/api/import/commit', { csv: rows(['A', 'B', 'C']), dateOrder: 'MM/DD' }))
        .status,
    ).toBe(200)
    const preview = await post(agent, '/api/import/preview', {
      csv: rows(['D', 'E']),
      dateOrder: 'MM/DD',
    })
    expect(preview.body.errors[0]).toEqual({
      row: 1,
      message:
        'This import would keep 5 transactions, but a session holds at most 3. Import a shorter date range.',
    })
    const rejected = await post(agent, '/api/import/commit', {
      csv: rows(['D', 'E']),
      dateOrder: 'MM/DD',
    })
    expect(rejected.status).toBe(400)
    expect(rejected.body.code).toBe('TOO_MANY_TRANSACTIONS')
    expect(rejected.body.error).toContain('at most 3')
    expect((await state(agent)).transactions).toHaveLength(3)
  })
})

describe('production browser hardening', () => {
  it('sends HSTS and a __Host- session cookie that authenticates later requests', async () => {
    const origin = 'https://worth.example.com'
    const { app } = setup({ config: { ...config, production: true, trustProxy: 1, origin } })
    const first = await request(app).get('/api/state')
    expect(first.status).toBe(200)
    expect(first.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains')
    expect(first.headers['x-content-type-options']).toBe('nosniff')
    expect(first.headers['referrer-policy']).toBe('same-origin')
    expect(first.headers['content-security-policy']).toBe("frame-ancestors 'none'")
    const cookie = first.headers['set-cookie'][0] as string
    expect(cookie).toMatch(/^__Host-worth_session=[A-Za-z0-9_-]{43};/)
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).not.toMatch(/Domain=/i)
    const pair = cookie.split(';')[0]!
    const write = await request(app)
      .post('/api/wishlist')
      .set('Cookie', pair)
      .set('X-Worth-Client', 'web')
      .set('Origin', origin)
      .send({ productId: 'chair' })
    expect(write.status).toBe(200)
    expect(write.body.sessionKey).toBe(first.body.sessionKey)
    expect(write.headers['set-cookie']).toBeUndefined()
    // The development cookie name is not accepted in production.
    const legacy = await request(app)
      .get('/api/state')
      .set('Cookie', pair.replace('__Host-worth_session', 'worth_session'))
    expect(legacy.body.sessionKey).not.toBe(first.body.sessionKey)
  })
  it('keeps local development on plain HTTP without HSTS', async () => {
    const { app } = setup()
    const response = await request(app).get('/api/state')
    expect(response.headers['strict-transport-security']).toBeUndefined()
    expect(response.headers['content-security-policy']).toBe("frame-ancestors 'none'")
    expect(response.headers['set-cookie'][0]).toMatch(/^worth_session=/)
    expect(response.headers['set-cookie'][0]).not.toContain('Secure')
  })
})
