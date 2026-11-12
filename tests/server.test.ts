import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../server/app.ts'
import { Store } from '../server/store.ts'
import type { StoredPurchase } from '../server/store.ts'
import { createPayPalGateway, PayPalError } from '../server/paypal.ts'
import type { PayPalGateway, PayPalOrder, PayPalRefund } from '../server/paypal.ts'
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
/** Production refuses to start without the hand-off key and store origin. */
const handoffConfig = {
  handoffSecret: Buffer.alloc(32, 1).toString('base64url'),
  merchantOrigin: 'https://store.example',
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
  const refunds = new Map<string, PayPalRefund>()
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
    getRefund: vi.fn(async (id: string) => {
      const refund = refunds.get(id)
      if (!refund) throw new PayPalError(404, 'RESOURCE_NOT_FOUND')
      return structuredClone(refund)
    }),
    eligibility: vi.fn(async () => ({
      payLater: true,
      productCode: 'PAYLATER',
      countryCode: 'US',
    })),
  }
  return { gateway, orders, refunds }
}
/** A refund as PayPal sends it: no order ID, and an `up` link to the refunded capture. */
function refundResource(id: string, captureId: string, value: string): PayPalRefund {
  return {
    id,
    status: 'COMPLETED',
    amount: { currency_code: 'USD', value },
    links: [
      { rel: 'self', href: `https://api.sandbox.paypal.com/v2/payments/refunds/${id}` },
      { rel: 'up', href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` },
    ],
  }
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
    expect((await state(agent)).config).toEqual({
      ai: 'demo',
      paypal: 'demo',
      alternatives: 'off',
      handoff: 'off',
      paypalConnect: 'off',
      sample: 'maya',
    })
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
  it('lets the untouched sample profile turn Claude off and on again', async () => {
    const reply = vi.fn(async () => ({
      message: 'external',
      mode: 'anthropic' as const,
      intent: 'overview' as const,
      suggestions: [],
      toolCalls: [],
    }))
    const { agent } = setup({ chat: { reply } })
    const ask = async () =>
      (await post(agent, '/api/chat', { message: 'How is the sample plan?', history: [] })).body
        .mode
    expect(await ask()).toBe('anthropic')
    const off = await post(agent, '/api/consent', { aiConsent: false })
    expect(off.body.profile.aiChoiceMade).toBe(true)
    expect(off.body.profile.userEdited).toBe(false)
    expect(await ask()).toBe('demo')
    await post(agent, '/api/consent', { aiConsent: true })
    expect(await ask()).toBe('anthropic')
    expect(reply).toHaveBeenCalledTimes(2)
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
    expect(on.body.profile).toEqual({ ...before.profile, aiConsent: true, aiChoiceMade: true })
    expect(await ask()).toBe('anthropic')
    const captured = await post(agent, `/api/checkout/${created.body.purchase.id}/capture`)
    expect(captured.body.purchase.status).toBe('completed')
    expect((await post(agent, '/api/consent', { aiConsent: false })).body.profile.aiConsent).toBe(
      false,
    )
    expect(await ask()).toBe('demo')
    expect(reply).toHaveBeenCalledTimes(1)
  })
  it('reads purchases locally when AI sharing is off, asking instead of guessing', async () => {
    const reply = vi.fn()
    const { agent } = setup({ chat: { reply } })
    const current = await state(agent)
    await patch(agent, { profile: { ...current.profile, name: 'Edited' } })
    const laptop = await post(agent, '/api/chat', { message: 'Can I afford a $1.5k laptop?' })
    expect(laptop.body).toMatchObject({
      mode: 'demo',
      intent: 'affordability',
      interpretation: { amountCents: 150000, currency: 'USD', date: '2026-10-03', source: 'local' },
    })
    const euros = await post(agent, '/api/chat', { message: 'Can I afford a bag for 500 euros?' })
    expect(euros.body.intent).toBe('clarify')
    expect(euros.body.assessment).toBeUndefined()
    expect(euros.body.message).toContain('financial context was not sent to Claude')
    expect(reply).not.toHaveBeenCalled()
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
    const { gateway, orders, refunds } = fakePayPal()
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
    const before = await post(agent, '/api/assess', { amountCents: 0 })
    refunds.set('REFUND-A', refundResource('REFUND-A', `CAPTURE${created.body.orderId}`, '100.00'))
    await request(app)
      .post('/api/paypal/webhook')
      .send({
        id: 'REFUND1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: refundResource('REFUND-A', `CAPTURE${created.body.orderId}`, '100.00'),
      })
    const current = await state(agent)
    expect(current.purchases[0]?.status).toBe('completed')
    // A refund is a review item; it changes spending room by $0 until the user confirms it.
    expect(current.profile.confirmed).toBe(true)
    expect(current.reviews).toContainEqual(
      expect.objectContaining({ kind: 'refund', refundId: 'REFUND-A', refundedCents: 10000 }),
    )
    const after = await post(agent, '/api/assess', { amountCents: 0 })
    expect(after.body.baselineLowestCents).toBe(before.body.baselineLowestCents)
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

describe('payment lifecycle: declines, cancels and late events (C-8)', () => {
  async function checkout(agent: ReturnType<typeof request.agent>, productId = 'headphones') {
    await simpleProfile(agent)
    const created = await post(agent, '/api/checkout/create', { productId })
    expect(created.status).toBe(200)
    return created.body as { purchase: { id: string }; orderId: string }
  }
  it('ends a capture PayPal never answers in PAYPAL_UNCERTAIN within the gateway budget', async () => {
    // The real gateway, with a small budget: the order exists and is approved, the capture hangs.
    let created: PayPalOrder | undefined
    const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      const path = new URL(String(url)).pathname
      if (path === '/v1/oauth2/token') return Response.json({ access_token: 't', expires_in: 3600 })
      if (path === '/v2/payments/find-eligible-methods') return Response.json({})
      if (path === '/v2/checkout/orders') {
        const unit = JSON.parse(String(init.body)).purchase_units[0]
        created = {
          id: 'ORDER1',
          status: 'APPROVED',
          purchase_units: [
            {
              custom_id: unit.custom_id,
              reference_id: unit.reference_id,
              amount: { currency_code: 'USD', value: unit.amount.value },
              payee: { merchant_id: 'MERCHANT1' },
            },
          ],
        }
        return Response.json(created, { status: 201 })
      }
      if (path === '/v2/checkout/orders/ORDER1') return Response.json(created)
      return new Promise<Response>((_resolve, reject) =>
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason as Error)),
      )
    })
    const paypal = createPayPalGateway({
      clientId: 'client',
      secret: 'secret',
      origin: config.origin,
      fetch: fetch as unknown as typeof globalThis.fetch,
      log: vi.fn(),
      budgetMs: 300,
    })
    const { agent } = setup({ paypal })
    const { purchase } = await checkout(agent)
    const start = Date.now()
    const capture = await post(agent, `/api/checkout/${purchase.id}/capture`)
    expect(Date.now() - start).toBeLessThan(2_000)
    expect(capture.status).toBe(502)
    expect(capture.body.code).toBe('PAYPAL_UNCERTAIN')
    expect((await state(agent)).purchases[0]).toMatchObject({
      status: 'unknown',
      lastError: { code: 'PAYPAL_UNCERTAIN' },
    })
    // Less than 3 s of budget was left, so the capture was sent once.
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/capture'))).toHaveLength(1)
  })
  it('reopens approval after INSTRUMENT_DECLINED, without a lockout, and captures once with a new request ID', async () => {
    const { gateway } = fakePayPal()
    const original = gateway.capture
    gateway.capture = vi.fn(async (orderId, requestId, options) => {
      if (vi.mocked(gateway.capture).mock.calls.length === 1)
        throw new PayPalError(422, 'INSTRUMENT_DECLINED', 'debug-1', [
          { rel: 'redirect', href: 'https://www.sandbox.paypal.com/checkoutnow?token=again' },
        ])
      return original(orderId, requestId, options)
    })
    const { agent } = setup({ paypal: gateway })
    const created = await checkout(agent)
    const id = created.purchase.id
    const declined = await post(agent, `/api/checkout/${id}/capture`)
    expect(declined.status).toBe(409)
    expect(declined.body.code).toBe('PAYMENT_DECLINED')
    expect(declined.body.error).toBe(
      'Your payment method was declined. Choose another way to pay in PayPal.',
    )
    expect(declined.body.purchase).toMatchObject({
      status: 'created',
      needsReapproval: true,
      approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=again',
      lastError: { code: 'INSTRUMENT_DECLINED' },
    })
    expect(JSON.stringify(declined.body)).not.toContain('debug-1')
    const stored = (await state(agent)).purchases[0]!
    expect(stored).toMatchObject({ status: 'created', needsReapproval: true })
    // The buyer chooses another funding source; the next capture is a new PayPal request.
    const captured = await post(agent, `/api/checkout/${id}/capture`)
    expect(captured.body.purchase.status).toBe('completed')
    expect(captured.body.purchase.needsReapproval).toBeUndefined()
    expect(captured.body.purchase.lastError).toBeUndefined()
    expect(captured.body.purchase.approveUrl).toBeUndefined()
    const requestIds = vi.mocked(gateway.capture).mock.calls.map((call) => call[1])
    expect(requestIds).toEqual([`capture-${id}`, `capture-${id}-1`])
    expect(
      captured.body.state.transactions.filter((t: { source: string }) => t.source === 'purchase'),
    ).toHaveLength(1)
  })
  it('lets a declined checkout be cancelled and the plan edited straight away', async () => {
    const { gateway } = fakePayPal()
    gateway.capture = vi.fn(async () => {
      throw new PayPalError(422, 'PAYER_ACTION_REQUIRED', undefined, [
        { rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=action' },
      ])
    })
    const { agent } = setup({ paypal: gateway })
    const created = await checkout(agent)
    const declined = await post(agent, `/api/checkout/${created.purchase.id}/capture`)
    expect(declined.body.purchase).toMatchObject({
      approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=action',
      lastError: { code: 'PAYER_ACTION_REQUIRED' },
    })
    expect((await post(agent, `/api/checkout/${created.purchase.id}/cancel`)).status).toBe(200)
    expect((await post(agent, '/api/reset')).status).toBe(200)
  })
  it('passes the sandbox decline mock to PayPal only when negative testing is on', async () => {
    const { gateway } = fakePayPal()
    const { agent } = setup({ paypal: gateway })
    const created = await checkout(agent)
    await post(agent, `/api/checkout/${created.purchase.id}/capture`, { mockDecline: true })
    expect(vi.mocked(gateway.capture).mock.calls[0]![2]).toEqual({ mockDecline: true })
    const hosted = fakePayPal()
    const origin = 'https://worth.example.com'
    const prod = setup({
      paypal: hosted.gateway,
      config: {
        ...config,
        ...handoffConfig,
        production: true,
        trustProxy: 1,
        origin,
        paypalNegativeTesting: false,
      },
    })
    const first = await request(prod.app).get('/api/state')
    const cookie = (first.headers['set-cookie'][0] as string).split(';')[0]!
    const send = (path: string, body: object) =>
      request(prod.app)
        .post(path)
        .set('Cookie', cookie)
        .set('X-Worth-Client', 'web')
        .set('Origin', origin)
        .send(body)
    const refused = await send('/api/checkout/anything/capture', { mockDecline: true })
    expect(refused.status).toBe(400)
    expect(refused.body.code).toBe('NEGATIVE_TESTING_DISABLED')
    expect(hosted.gateway.capture).not.toHaveBeenCalled()
  })
  it('releases the attempt when PayPal says the order is not approved', async () => {
    const { gateway } = fakePayPal()
    gateway.capture = vi.fn(async () => {
      throw new PayPalError(422, 'ORDER_NOT_APPROVED')
    })
    const { agent } = setup({ paypal: gateway })
    const created = await checkout(agent)
    const result = await post(agent, `/api/checkout/${created.purchase.id}/capture`)
    expect(result.status).toBe(409)
    expect(result.body.code).toBe('BUYER_APPROVAL_REQUIRED')
    expect((await state(agent)).purchases[0]?.status).toBe('created')
    expect((await post(agent, `/api/checkout/${created.purchase.id}/cancel`)).status).toBe(200)
  })
  it('settles ORDER_ALREADY_CAPTURED from the order instead of leaving it uncertain', async () => {
    const { gateway } = fakePayPal()
    const original = gateway.capture
    gateway.capture = vi.fn(async (orderId, requestId) => {
      await original(orderId, requestId)
      throw new PayPalError(422, 'ORDER_ALREADY_CAPTURED')
    })
    const { agent } = setup({ paypal: gateway })
    const created = await checkout(agent)
    const result = await post(agent, `/api/checkout/${created.purchase.id}/capture`)
    expect(result.body.purchase.status).toBe('completed')
  })
  it('makes one order lookup per capture request', async () => {
    const { gateway } = fakePayPal()
    const { agent } = setup({ paypal: gateway })
    const created = await checkout(agent)
    await post(agent, `/api/checkout/${created.purchase.id}/capture`)
    expect(gateway.get).toHaveBeenCalledTimes(1)
  })
  it('cancels locally when PayPal no longer has an order Worth never captured', async () => {
    const { gateway } = fakePayPal()
    const { agent } = setup({ paypal: gateway })
    const created = await checkout(agent)
    gateway.get = vi.fn(async () => {
      throw new PayPalError(404, 'RESOURCE_NOT_FOUND')
    })
    const cancelled = await post(agent, `/api/checkout/${created.purchase.id}/cancel`)
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.purchases[0].status).toBe('cancelled')
    expect((await post(agent, '/api/checkout/create', { productId: 'chair' })).status).toBe(200)
  })
  it('keeps the reservation on a 404 after a capture attempt', async () => {
    const { gateway } = fakePayPal()
    gateway.capture = vi.fn(async () => {
      throw new Error('socket hang up')
    })
    const { agent } = setup({ paypal: gateway })
    const created = await checkout(agent)
    expect((await post(agent, `/api/checkout/${created.purchase.id}/capture`)).status).toBe(502)
    gateway.get = vi.fn(async () => {
      throw new PayPalError(404, 'RESOURCE_NOT_FOUND')
    })
    const cancel = await post(agent, `/api/checkout/${created.purchase.id}/cancel`)
    expect(cancel.status).toBe(502)
    expect((await state(agent)).purchases[0]).toMatchObject({
      status: 'unknown',
      lastError: { code: 'PAYPAL_UNCERTAIN' },
    })
  })
  it('never revives a cancelled checkout from a late APPROVED event, even with another checkout active', async () => {
    const { gateway, orders } = fakePayPal()
    const { app, agent } = setup({ paypal: gateway })
    const first = await checkout(agent)
    expect((await post(agent, `/api/checkout/${first.purchase.id}/cancel`)).status).toBe(200)
    const second = await post(agent, '/api/checkout/create', { productId: 'chair' })
    expect(second.status).toBe(200)
    orders.get(first.orderId)!.status = 'APPROVED'
    for (const id of ['LATE-A', 'LATE-B']) {
      const event = await request(app)
        .post('/api/paypal/webhook')
        .send({ id, event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: first.orderId } })
      expect(event.status).toBe(200)
    }
    const purchases = (await state(agent)).purchases
    expect(purchases.find((p) => p.id === first.purchase.id)?.status).toBe('cancelled')
    expect(purchases.find((p) => p.id === second.body.purchase.id)?.status).toBe('created')
  })
  it('records a buyer’s cancel or approval on the PayPal return and opens the app', async () => {
    const { gateway } = fakePayPal()
    const { app, agent } = setup({ paypal: gateway })
    const created = await checkout(agent)
    const id = created.purchase.id
    const cancelled = await agent.get(`/api/checkout/${id}/return?paypal=cancelled`)
    expect(cancelled.status).toBe(303)
    expect(cancelled.headers.location).toBe(`/?checkout=${id}&paypal=cancelled`)
    expect((await state(agent)).purchases[0]).toMatchObject({
      status: 'created',
      lastError: { code: 'PAYPAL_CANCELLED' },
      approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=fake',
    })
    const approved = await agent.get(`/api/checkout/${id}/return?paypal=approved`)
    expect(approved.headers.location).toBe(`/?checkout=${id}&paypal=approved`)
    expect((await state(agent)).purchases[0]?.lastError).toBeUndefined()
    // Another session's return changes nothing.
    const stranger = await request(app).get(`/api/checkout/${id}/return?paypal=cancelled`)
    expect(stranger.status).toBe(303)
    expect((await state(agent)).purchases[0]?.lastError).toBeUndefined()
  })
  it('marks a purchase created by the checkout button as user-prepared', async () => {
    const { gateway } = fakePayPal()
    const { agent } = setup({ paypal: gateway })
    await checkout(agent)
    expect((await state(agent)).purchases[0]?.preparedBy).toBe('user')
  })
})

describe('PayPal webhooks (PP-5, SB-9)', () => {
  it('verifies the raw body exactly as delivered', async () => {
    const { gateway } = fakePayPal()
    const { app } = setup({ paypal: gateway })
    const raw =
      '{ "id" : "EV-RAW", "event_type":"CHECKOUT.ORDER.APPROVED","resource":{"id":"NONE"} }'
    const result = await request(app)
      .post('/api/paypal/webhook')
      .set('Content-Type', 'application/json')
      .send(raw)
    expect(result.status).toBe(200)
    expect(vi.mocked(gateway.verify).mock.calls[0]![1]).toBe(raw)
  })
  it('rate-limits deliveries before any verification call', async () => {
    const { gateway } = fakePayPal()
    gateway.verify = vi.fn(async () => false)
    const { app } = setup({ paypal: gateway })
    const statuses: number[] = []
    for (let i = 0; i < 62; i++)
      statuses.push(
        (
          await request(app)
            .post('/api/paypal/webhook')
            .send({ id: `E${i}` })
        ).status,
      )
    expect(statuses.filter((s) => s === 401)).toHaveLength(60)
    expect(statuses.slice(-2)).toEqual([429, 429])
    expect(gateway.verify).toHaveBeenCalledTimes(60)
  })
  it('maps a refund to its capture through links[rel=up] and records it once for review', async () => {
    const { gateway, refunds } = fakePayPal()
    const { app, agent } = setup({ paypal: gateway })
    await simpleProfile(agent)
    const created = await post(agent, '/api/checkout/create', { productId: 'headphones' })
    await post(agent, `/api/checkout/${created.body.purchase.id}/capture`)
    const captureId = `CAPTURE${created.body.orderId}`
    // The verified event says $349; PayPal's own refund record says $50, and that is what counts.
    refunds.set('R-50', refundResource('R-50', captureId, '50.00'))
    const send = (id: string) =>
      request(app)
        .post('/api/paypal/webhook')
        .send({
          id,
          event_type: 'PAYMENT.CAPTURE.REFUNDED',
          resource: refundResource('R-50', captureId, '349.00'),
        })
    expect((await send('EV-R1')).body).toEqual({ received: true })
    expect((await send('EV-R1')).body.duplicate).toBe(true)
    expect((await send('EV-R2')).status).toBe(200)
    const current = await state(agent)
    expect(current.purchases[0]?.refunds).toEqual([
      expect.objectContaining({ id: 'R-50', amountCents: 5000, status: 'review' }),
    ])
    expect(current.reviews.filter((r) => r.kind === 'refund')).toHaveLength(1)
    expect(gateway.getRefund).toHaveBeenCalledWith('R-50')
  })
  it('ignores a refund for an unknown capture or in another currency', async () => {
    const { gateway, refunds } = fakePayPal()
    const { app } = setup({ paypal: gateway })
    refunds.set('R-X', refundResource('R-X', 'NOPE', '5.00'))
    const result = await request(app)
      .post('/api/paypal/webhook')
      .send({ id: 'EV-X', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'R-X' } })
    expect(result.body.ignored).toBe(true)
  })
})

describe('Pay in 4 eligibility from PayPal (case 29)', () => {
  async function compare(agent: ReturnType<typeof request.agent>, productId: string) {
    const result = await post(agent, '/api/compare', { productId })
    expect(result.status).toBe(200)
    return result.body.payIn4 as { available: boolean; eligibility: string; reason?: string }
  }
  it('confirms Pay in 4 only when PayPal offers Pay Later and the amount is in range', async () => {
    const { gateway } = fakePayPal()
    const { agent } = setup({ paypal: gateway })
    await simpleProfile(agent)
    expect(await compare(agent, 'camera')).toMatchObject({ available: true, eligibility: 'paypal' })
    expect(gateway.eligibility).toHaveBeenCalledWith(119900)
    // Same price band: answered from the cache for about ten minutes.
    await compare(agent, 'camera')
    expect(gateway.eligibility).toHaveBeenCalledTimes(1)
    clock.value = new Date(clock.value.getTime() + 11 * 60_000)
    await compare(agent, 'camera')
    expect(gateway.eligibility).toHaveBeenCalledTimes(2)
    const outOfRange = await post(agent, '/api/compare', { amountCents: 250000 })
    expect(outOfRange.body.payIn4).toEqual({
      available: false,
      reason: 'Not available for this amount',
      eligibility: 'unavailable',
    })
    expect(gateway.eligibility).toHaveBeenCalledTimes(2)
  })
  it('reads PayPal’s Pay Later no as unknown: the range decides (contract §3.2)', async () => {
    const { gateway } = fakePayPal()
    gateway.eligibility = vi.fn(async () => ({ payLater: false }))
    const { agent } = setup({ paypal: gateway })
    await simpleProfile(agent)
    expect(await compare(agent, 'headphones')).toMatchObject({
      available: true,
      eligibility: 'range-only',
    })
  })
  it('falls back to the amount range when the PayPal check fails, and retries soon', async () => {
    const { gateway } = fakePayPal()
    gateway.eligibility = vi.fn(async () => {
      throw new PayPalError(0, 'TIMEOUT')
    })
    const { agent } = setup({ paypal: gateway })
    await simpleProfile(agent)
    expect(await compare(agent, 'headphones')).toMatchObject({
      available: true,
      eligibility: 'range-only',
    })
    clock.value = new Date(clock.value.getTime() + 2 * 60_000)
    await compare(agent, 'headphones')
    expect(gateway.eligibility).toHaveBeenCalledTimes(2)
  })
  it('uses the range alone without PayPal credentials', async () => {
    const { agent } = setup()
    await simpleProfile(agent)
    expect(await compare(agent, 'headphones')).toMatchObject({ eligibility: 'range-only' })
  })
  it('raises “Confirm your plan” after a capture PayPal may have offered Pay Later for', async () => {
    const offered = fakePayPal()
    const withPayLater = setup({ paypal: offered.gateway })
    await simpleProfile(withPayLater.agent)
    const a = await post(withPayLater.agent, '/api/checkout/create', { productId: 'headphones' })
    const done = await post(withPayLater.agent, `/api/checkout/${a.body.purchase.id}/capture`)
    expect(done.body.state.reviews).toEqual([
      expect.objectContaining({ kind: 'confirmPlan', purchaseId: a.body.purchase.id }),
    ])
    const notOffered = fakePayPal()
    notOffered.gateway.eligibility = vi.fn(async () => ({ payLater: false }))
    const without = setup({ paypal: notOffered.gateway })
    await simpleProfile(without.agent)
    const b = await post(without.agent, '/api/checkout/create', { productId: 'headphones' })
    const paid = await post(without.agent, `/api/checkout/${b.body.purchase.id}/capture`)
    // PayPal's no is unknown, not a no (§3.2), so the shopper is still asked how they paid.
    expect(paid.body.state.reviews).toEqual([
      expect.objectContaining({ kind: 'confirmPlan', purchaseId: b.body.purchase.id }),
    ])
    expect(paid.body.purchase.paymentPlan).toBeUndefined()
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
    const { gateway, refunds } = fakePayPal()
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
    const refund = refundResource('REFUND-OLD', `CAPTURE${created.body.orderId}`, '349.00')
    refunds.set(refund.id, refund)
    await request(app)
      .post('/api/paypal/webhook')
      .send({ id: 'REFUND-ARCHIVED', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: refund })
    expect((await state(agent)).profile.confirmed).toBe(true)
    expect((await state(agent)).reviews).toEqual([])
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
  it('dates recurring suggestions from the plan’s own today', async () => {
    const { app } = setup()
    // 01:30 on Oct 4 in India; still Oct 3 in New York.
    clock.value = new Date('2026-10-03T20:00:00Z')
    const csv = [
      'Date,Name,Type,Status,Currency,Net,Transaction ID',
      '2026-08-03,Music streaming subscription,Subscription Payment,Completed,USD,-10.99,M1',
      '2026-09-03,Music streaming subscription,Subscription Payment,Completed,USD,-10.99,M2',
    ].join('\n')
    const nextDate = async (zone: string) => {
      const agent = request.agent(app)
      const imported = await post(agent, '/api/import/commit', { csv }).set(
        'X-Worth-Timezone',
        zone,
      )
      expect(imported.status).toBe(200)
      return imported.body.profile.flows[0].nextDate as string
    }
    // Oct 3 is still to come in New York but has passed in India.
    expect(await nextDate('America/New_York')).toBe('2026-10-03')
    expect(await nextDate('Asia/Kolkata')).toBe('2026-11-03')
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
      expect(r.body.message).toContain('Claude limit for the hour')
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
    expect(exhausted.body.message).toContain('allowance for today is used up')
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

  it('keeps a single spending-review entry however many payments are resolved', async () => {
    const { agent } = setup()
    await post(agent, '/api/import/commit', {
      csv: [
        'Date,Time,Name,Type,Status,Currency,Net,Transaction ID',
        '2026-09-14,09:00:00,Coffee,Express Checkout Payment,Completed,USD,-4.00,U1',
        '2026-09-10,10:00:00,Shop one,Express Checkout Payment,Completed,EUR,-10.00,E1',
        '2026-09-11,11:00:00,Shop two,Express Checkout Payment,Completed,EUR,-10.00,E2',
      ].join('\n'),
    })
    await simpleProfile(agent, { confirmed: true, missingFields: [] })
    for (const id of ['paypal:E1', 'paypal:E2']) await resolve(agent, id, { amountCents: 1100 })
    const fields = (await state(agent)).profile.missingFields
    expect(
      fields.filter((field) => field.startsWith('Review your everyday spending')),
    ).toHaveLength(1)
    expect(fields.at(-1)).toContain('with Shop two included')
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

describe('foreign payments across imports', () => {
  const H =
    '"Date","Time","TimeZone","Name","Type","Status","Currency","Amount","Fees","Total","Exchange Rate","Receipt ID","Balance","Transaction ID","Item Title"'
  const row = (
    time: string,
    name: string,
    type: string,
    currency: string,
    total: string,
    id: string,
    status = 'Completed',
  ) =>
    `"09/15/2026","${time}","EDT","${name}","${type}","${status}","${currency}","${total}","0.00","${total}","","","0.00","${id}",""`
  const grocery =
    '"09/20/2026","09:00:00","EDT","Corner grocery","Express Checkout Payment","Completed","USD","-10.00","0.00","-10.00","","","0.00","U1",""'
  const payment = (status = 'Completed') =>
    row('12:30:05', 'Lisbon bakery', 'Express Checkout Payment', 'EUR', '-18.50', 'P1', status)
  const legs = [
    row('12:30:05', '', 'General Currency Conversion', 'EUR', '18.50', 'C1'),
    row('12:30:05', '', 'General Currency Conversion', 'USD', '-20.61', 'C2'),
  ]
  const fileA = [H, grocery, payment()].join('\n')
  const fileB = [H, grocery, payment(), ...legs].join('\n')
  const resolve = (agent: ReturnType<typeof request.agent>, body: object) =>
    post(agent, `/api/import/unresolved/${encodeURIComponent('paypal:P1')}`, body)
  const spending = (transactions: AppState['transactions']) =>
    transactions
      .filter((t) => t.kind === 'expense' && t.status === 'completed')
      .reduce((sum, t) => sum - t.amountCents, 0)

  it('marks an unresolved payment matched once a later export pairs it', async () => {
    const { agent } = setup()
    await post(agent, '/api/import/commit', { csv: fileA })
    const later = await post(agent, '/api/import/commit', { csv: fileB })
    expect(later.body.foreignPayments[0].resolution).toEqual({ kind: 'matched' })
    expect(later.body.profile.missingFields.join(' ')).not.toContain('foreign-currency')
    expect(spending(later.body.transactions)).toBe(1000 + 2061)
    expect((await resolve(agent, { amountCents: 2061 })).body.code).toBe('ALREADY_RESOLVED')
    expect(spending((await state(agent)).transactions)).toBe(1000 + 2061)
  })

  it('refuses to resolve a payment that is already in history', async () => {
    const { agent, store } = setup()
    await post(agent, '/api/import/commit', { csv: fileB })
    const { id } = store.db.prepare('SELECT id FROM sessions').get() as { id: string }
    const data = store.get(id)!
    data.foreignPayments = [
      {
        id: 'paypal:P1',
        date: '2026-09-15',
        name: 'Lisbon bakery',
        type: 'Express Checkout Payment',
        currency: 'EUR',
        originalCents: -1850,
      },
    ]
    store.save(id, data)
    const refused = await resolve(agent, { amountCents: 2061 })
    expect(refused.status).toBe(409)
    expect(refused.body.code).toBe('ALREADY_IN_HISTORY')
  })

  it('counts a payment once when it was pending at the first import', async () => {
    const { agent } = setup()
    const first = await post(agent, '/api/import/commit', {
      csv: [H, grocery, payment('Pending'), ...legs].join('\n'),
    })
    expect(spending(first.body.transactions)).toBe(1000)
    const second = await post(agent, '/api/import/commit', { csv: fileB })
    expect(spending(second.body.transactions)).toBe(1000 + 2061)
  })

  it('lets a later conversion replace an entered USD cost instead of failing', async () => {
    const { agent } = setup()
    await post(agent, '/api/import/commit', { csv: fileA })
    await resolve(agent, { amountCents: 2000 })
    const later = await post(agent, '/api/import/commit', { csv: fileB })
    expect(later.status).toBe(200)
    expect(later.body.transactions.find((t: { id: string }) => t.id === 'paypal:P1')).toMatchObject(
      {
        amountCents: -2061,
      },
    )
    expect(later.body.foreignPayments[0].resolution).toEqual({ kind: 'matched' })
    expect(spending(later.body.transactions)).toBe(1000 + 2061)
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
    // Importing the same file again keeps the plan in the review.
    const again = await post(agent, '/api/import/commit', { csv })
    expect(again.body.profile.missingFields).toContain(
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
    const { app } = setup({
      config: { ...config, ...handoffConfig, production: true, trustProxy: 1, origin },
    })
    const first = await request(app).get('/api/state')
    expect(first.status).toBe(200)
    expect(first.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains')
    expect(first.headers['x-content-type-options']).toBe('nosniff')
    expect(first.headers['referrer-policy']).toBe('same-origin')
    const csp = Object.fromEntries(
      (first.headers['content-security-policy'] as string)
        .split('; ')
        .map((directive) => [directive.split(' ')[0], directive.split(' ').slice(1)]),
    )
    for (const directive of ['script-src', 'frame-src', 'connect-src', 'img-src'])
      expect(csp[directive]).toEqual(
        expect.arrayContaining([
          "'self'",
          'https://www.paypal.com',
          'https://www.sandbox.paypal.com',
          'https://*.paypal.com',
          'https://*.paypalobjects.com',
        ]),
      )
    expect(csp['default-src']).toEqual(["'self'"])
    expect(csp['frame-ancestors']).toEqual(["'none'"])
    expect(csp['script-src']).not.toContain("'unsafe-inline'")
    expect(JSON.stringify(csp)).not.toContain('fonts.googleapis.com')
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
