import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../server/app.ts'
import { Store } from '../server/store.ts'
import type { StoredPurchase } from '../server/store.ts'
import type { PayPalGateway, PayPalOrder } from '../server/paypal.ts'
import type { AppState } from '../shared/types.ts'
import { createChatProvider, fallbackReply } from '../server/chat.ts'

const stores: Store[] = []
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
    expect((await state(request.agent(app))).profile.name).toBe('Alex')
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
  it('expires normalized personal data and deletes prior records on reset', async () => {
    const { agent, store } = setup()
    await state(agent)
    const csv =
      'Date,Name,Net,Currency,Type,Status,Transaction ID\n10/01/2026,Coffee,-5.00,USD,Payment,Completed,ABC123'
    expect((await post(agent, '/api/import/commit', { csv })).status).toBe(200)
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
    const first = await post(agent, '/api/import/commit', { csv })
    expect(first.status).toBe(200)
    expect(first.body.profile.balanceCents).toBe(0)
    expect(first.body.profile.flows).toEqual([])
    expect(first.body.profile.confirmed).toBe(false)
    expect((await post(agent, '/api/import/commit', { csv })).body.transactions).toHaveLength(1)
    expect(
      (
        await post(agent, '/api/import/commit', {
          csv: csv + '\n10/02/2026,Bad,-3.00,EUR,Payment,Completed,ABC124',
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
    await post(agent, '/api/import/commit', { csv })
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
    await post(agent, '/api/import/commit', { csv })
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
    ['on payday', '2026-10-15'],
    ['after my next paycheck', '2026-10-16'],
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
    expect(result.assessment?.earliestDate).toBe('2026-10-16')
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
