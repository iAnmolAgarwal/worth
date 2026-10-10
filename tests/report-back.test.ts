import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../server/app.ts'
import { Store } from '../server/store.ts'
import type { StoredPurchase } from '../server/store.ts'
import type { PayPalGateway } from '../server/paypal.ts'
import type { ChatProvider } from '../server/chat.ts'
import { createHandoff, outcomeSignature } from '../shared/handoff.ts'
import type { OutcomePayload, QuoteInput } from '../shared/handoff.ts'
import type { AppState, Comparison, SavedItem } from '../shared/types.ts'

// C4, report-back (specs/handoff-contract.md §5): the store's signed capture report, recorded
// once in the shopper's Activity.

const SECRET = Buffer.alloc(32, 3).toString('base64url')
const STORE = 'https://store.example'
const config = {
  production: false,
  origin: 'http://localhost:5173',
  paypalClientId: undefined,
  paypalSecret: undefined,
  anthropicKey: undefined,
  handoffSecret: SECRET,
  merchantOrigin: STORE,
}
const clock = { value: new Date('2026-10-03T12:00:00Z') }
const larkspur = createHandoff({
  secret: SECRET,
  mid: 'larkspur',
  merchantOrigin: STORE,
  now: () => clock.value.getTime(),
})
const QID = 'q_abcdefghijklmnopqrstuv'
const quote: QuoteInput = {
  qid: QID,
  item: 'Everyday camera',
  productId: 'camera',
  amountCents: 119900,
  currency: 'USD',
  merchant: 'Larkspur Supply',
  returnUrl: `${STORE}/p/camera`,
}
const capture = (patch: Partial<OutcomePayload> = {}): OutcomePayload => ({
  v: 1,
  kid: '1',
  mid: 'larkspur',
  qid: QID,
  orderId: 'ORDER1',
  captureId: 'CAP1',
  amountCents: 119900,
  currency: 'USD',
  status: 'COMPLETED',
  capturedAt: '2026-10-03T15:04:05Z',
  ...patch,
})
const REFUSED = { error: 'This report was not accepted.', code: 'OUTCOME_REJECTED' }
const NOT_FOUND = { error: 'Not found.', code: 'NOT_FOUND' }

const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function setup(extra: Parameters<typeof createApp>[0] = {}) {
  clock.value = new Date('2026-10-03T12:00:00Z')
  const store = new Store(':memory:')
  stores.push(store)
  const paypal = {
    eligibility: vi.fn(async () => ({ payLater: true })),
  } as unknown as PayPalGateway
  const chat = { reply: vi.fn() } as unknown as ChatProvider
  const app = createApp({ store, config, paypal, chat, now: () => clock.value, ...extra })
  return { app, store, agent: request.agent(app) }
}
type Agent = ReturnType<typeof request.agent>
type App = ReturnType<typeof createApp>
function post(agent: Agent, path: string, body: object = {}) {
  return agent.post(path).set('X-Worth-Client', 'web').send(body)
}
async function state(agent: Agent): Promise<AppState> {
  return (await agent.get('/api/state')).body
}
/** Home's "Room to spend today": the most the plan can spend now and keep its cushion. */
async function room(agent: Agent) {
  const response = await post(agent, '/api/compare', { amountCents: 0, itemName: 'Room to spend' })
  return (response.body as Comparison).spendLess.maxPriceCents
}
/** The shopper's path through /check: open the store's link, then optionally consent and go back. */
async function shopper(
  agent: Agent,
  { consent = true, returned = true, input = {} as Partial<QuoteInput> } = {},
) {
  const opened = await post(agent, '/api/handoff/open', {
    token: larkspur.signQuote({ ...quote, ...input }),
  })
  expect(opened.status).toBe(200)
  if (consent)
    expect((await post(agent, '/api/handoff/consent', { qid: QID, consent: true })).status).toBe(
      200,
    )
  if (returned) expect((await post(agent, '/api/handoff/return', { qid: QID })).status).toBe(200)
  return opened.body.state as AppState
}
/** The store server's report, signed exactly as merchant/reportBack.ts sends it. */
function report(
  app: App,
  body: OutcomePayload | string = capture(),
  headers: { timestamp?: string; signature?: string; drop?: 'timestamp' | 'signature' } = {},
) {
  const signed = larkspur.signOutcome(body)
  const sent: Record<string, string> = { ...signed.headers }
  if (headers.timestamp !== undefined) {
    sent['Worth-Handoff-Timestamp'] = headers.timestamp
    sent['Worth-Handoff-Signature'] = outcomeSignature(
      Buffer.from(SECRET, 'base64url'),
      headers.timestamp,
      signed.body,
    )
  }
  if (headers.signature !== undefined) sent['Worth-Handoff-Signature'] = headers.signature
  if (headers.drop === 'timestamp') delete sent['Worth-Handoff-Timestamp']
  if (headers.drop === 'signature') delete sent['Worth-Handoff-Signature']
  return request(app).post('/api/handoff/outcome').set(sent).send(signed.body)
}
const seconds = () => Math.floor(clock.value.getTime() / 1000)
const storeRows = (s: AppState) => s.transactions.filter((t) => t.source === 'purchase')

describe('POST /api/handoff/outcome: recording (contract §5)', () => {
  it('adds one Activity row and one paid purchase, and room to spend drops once', async () => {
    const { app, agent } = setup()
    await shopper(agent, { input: { item: 'Canvas tote', amountCents: 5000 } })
    const before = await room(agent)
    const response = await report(app, capture({ amountCents: 5000 }))
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ recorded: true })
    const after = await state(agent)
    expect(storeRows(after)).toEqual([
      expect.objectContaining({
        date: '2026-10-03',
        name: 'Canvas tote',
        amountCents: -5000,
        currency: 'USD',
        kind: 'expense',
        status: 'completed',
        source: 'purchase',
        referenceId: 'store:CAP1',
      }),
    ])
    const [purchase] = after.purchases
    expect(purchase).toMatchObject({
      name: 'Canvas tote',
      amountCents: 5000,
      status: 'completed',
      completedAt: '2026-10-03T15:04:05Z',
      completedOn: '2026-10-03',
      productId: 'larkspur:camera',
      paymentPlan: { product: 'full' },
      reportedBy: 'Larkspur Supply',
      reportNotice: true,
    })
    expect(storeRows(after)[0]!.id).toBe(`purchase-${purchase!.id}`)
    // No store order or capture identity reaches the browser, and none can match Worth's own.
    expect(purchase).not.toHaveProperty('storeReport')
    expect(purchase).not.toHaveProperty('orderId')
    expect(purchase).not.toHaveProperty('captureId')
    // Nothing to confirm: Worth records one paid amount, never a plan it can't see.
    expect(after.reviews).toEqual([])
    expect(await room(agent)).toBe(before - 5000)
    // The same capture again changes nothing.
    expect((await report(app, capture({ amountCents: 5000 }))).body).toEqual({ recorded: true })
    expect(await room(agent)).toBe(before - 5000)
    expect(storeRows(await state(agent))).toHaveLength(1)
  })

  it('records the captured amount when it differs from the quote, keeping the quote for display', async () => {
    const { app, agent } = setup()
    await shopper(agent)
    expect((await report(app, capture({ amountCents: 125000 }))).body).toEqual({ recorded: true })
    const after = await state(agent)
    expect(storeRows(after)[0]!.amountCents).toBe(-125000)
    expect(after.purchases[0]).toMatchObject({ amountCents: 125000, quotedCents: 119900 })
    // A matching amount keeps no second figure.
    const same = setup()
    await shopper(same.agent)
    await report(same.app)
    expect((await state(same.agent)).purchases[0]).not.toHaveProperty('quotedCents')
  })

  it('dates the row on the plan’s day for the capture time, and on the demo clock’s day in a replay', async () => {
    const { app, agent } = setup()
    await shopper(agent)
    // 01:30 UTC on Oct 4 is still Oct 3 in New York, the sample plan's time zone.
    await report(app, capture({ capturedAt: '2026-10-04T01:30:00Z' }))
    expect(storeRows(await state(agent))[0]!.date).toBe('2026-10-03')

    const replay = setup()
    await shopper(replay.agent, { input: { replay: 'video' } })
    await report(replay.app, capture({ capturedAt: '2026-10-03T15:04:05Z' }))
    const replayed = await state(replay.agent)
    expect(replayed.demoClock?.today).toBeDefined()
    expect(storeRows(replayed)[0]!.date).toBe(replayed.today)
  })

  it('removes the Saved item for the store’s page, by its link or its quote, and nothing else', async () => {
    const { app, agent, store } = setup()
    await shopper(agent)
    const id = store.quote(QID, clock.value.getTime())!.sessionId
    const data = store.get(id)!
    const item = (patch: Partial<SavedItem>): SavedItem => ({
      id: patch.id!,
      kind: 'custom',
      name: 'Everyday camera',
      amountCents: 119900,
      createdAt: '2026-10-03T11:00:00.000Z',
      status: 'active',
      ...patch,
    })
    data.saved = [
      item({ id: 'by-link', sourceUrl: `${STORE}/p/camera#reviews`, waitDate: '2026-10-23' }),
      item({ id: 'by-qid', qid: QID }),
      item({ id: 'other-page', sourceUrl: `${STORE}/p/chair` }),
      item({ id: 'other-quote', qid: 'q_zzzzzzzzzzzzzzzzzzzzzz' }),
      item({ id: 'no-link' }),
    ]
    store.save(id, data)
    await report(app)
    const saved = store.get(id)!.saved!
    const status = Object.fromEntries(saved.map((s) => [s.id, s.status]))
    expect(status).toEqual({
      'by-link': 'removed',
      'by-qid': 'removed',
      'other-page': 'active',
      'other-quote': 'active',
      'no-link': 'active',
    })
    expect(saved.find((s) => s.id === 'by-link')!.waitDate).toBeUndefined()
    expect((await state(agent)).saved!.map((s) => s.id).sort()).toEqual(
      ['no-link', 'other-page', 'other-quote'].sort(),
    )
  })

  it('removes an item saved for its date on /check once that quote’s purchase is reported', async () => {
    const { app, agent, store } = setup()
    await shopper(agent, { consent: false, returned: false })
    const saved = await post(agent, '/api/handoff/save', { qid: QID, waitDate: '2026-10-23' })
    expect(saved.status).toBe(200)
    expect(saved.body.item).toMatchObject({ qid: QID, sourceUrl: `${STORE}/p/camera` })
    // The link stays, but only the qid is needed: drop the link to prove the qid alone matches.
    const id = store.quote(QID, clock.value.getTime())!.sessionId
    const data = store.get(id)!
    delete data.saved!.find((item) => item.qid === QID)!.sourceUrl
    store.save(id, data)
    await post(agent, '/api/handoff/consent', { qid: QID, consent: true })
    await post(agent, '/api/handoff/return', { qid: QID })
    expect((await report(app)).body).toEqual({ recorded: true })
    const after = await state(agent)
    expect(after.saved!.some((item) => item.qid === QID)).toBe(false)
    expect(store.get(id)!.saved!.find((item) => item.qid === QID)!.status).toBe('removed')
  })

  it('takes the sample plan’s saved camera out of Saved when Larkspur reports it (Gate 1)', async () => {
    const { app, agent } = setup()
    const before = await shopper(agent)
    const catalog = (s: AppState) =>
      s.saved!.filter((item) => item.kind === 'catalog').map((item) => item.productId)
    expect(catalog(before)).toEqual(expect.arrayContaining(['camera', 'headphones']))
    expect((await report(app)).body).toEqual({ recorded: true })
    const after = await state(agent)
    expect(catalog(after)).toEqual(['headphones'])
    expect(after.wishlist).toEqual(['headphones'])
  })

  it('leaves a catalog item alone when another store sells something with the same id', async () => {
    const { app, agent } = setup()
    await shopper(agent, { input: { merchant: 'Other Camera Shop' } })
    expect((await report(app)).body).toEqual({ recorded: true })
    const saved = (await state(agent)).saved!
    expect(saved.some((item) => item.kind === 'catalog' && item.productId === 'camera')).toBe(true)
  })

  it('keeps Saved as it is when nothing is recorded', async () => {
    const { app, agent, store } = setup()
    await shopper(agent, { consent: false })
    const id = store.quote(QID, clock.value.getTime())!.sessionId
    const data = store.get(id)!
    data.saved = [
      {
        id: 'by-qid',
        kind: 'custom',
        name: 'Everyday camera',
        amountCents: 119900,
        createdAt: '2026-10-03T11:00:00.000Z',
        status: 'active',
        qid: QID,
      },
    ]
    store.save(id, data)
    expect((await report(app)).body).toEqual({ recorded: false })
    expect(store.get(id)!.saved![0]!.status).toBe('active')
  })

  it('clears the one-time notice for this session only', async () => {
    const { app, agent } = setup()
    await shopper(agent)
    await report(app)
    const [purchase] = (await state(agent)).purchases
    expect(purchase!.reportNotice).toBe(true)
    // Another session can't clear it.
    const other = request.agent(app)
    expect(
      (await post(other, '/api/handoff/notices/seen', { purchaseIds: [purchase!.id] })).status,
    ).toBe(200)
    expect((await state(agent)).purchases[0]!.reportNotice).toBe(true)
    const seen = await post(agent, '/api/handoff/notices/seen', { purchaseIds: [purchase!.id] })
    expect(seen.status).toBe(200)
    expect((seen.body as AppState).purchases[0]).not.toHaveProperty('reportNotice')
    expect((await post(agent, '/api/handoff/notices/seen', { purchaseIds: [] })).status).toBe(400)
  })
})

describe('consent, returnedAt and anti-forwarding (contract §5)', () => {
  const cases = [
    { consent: false, returned: false, recorded: false },
    { consent: true, returned: false, recorded: false },
    { consent: false, returned: true, recorded: false },
    { consent: true, returned: true, recorded: true },
  ]
  for (const { consent, returned, recorded } of cases)
    it(`consent ${consent}, came back through Worth ${returned}: recorded ${recorded}`, async () => {
      const { app, agent } = setup()
      await shopper(agent, { consent, returned })
      expect((await report(app)).body).toEqual({ recorded })
      expect(storeRows(await state(agent))).toHaveLength(recorded ? 1 : 0)
    })

  it('records nothing once the shopper takes consent back', async () => {
    const { app, agent } = setup()
    await shopper(agent)
    await post(agent, '/api/handoff/consent', { qid: QID, consent: false })
    expect((await report(app)).body).toEqual({ recorded: false })
  })

  it('a forwarded link can’t consent, come back or record for anyone but its first session', async () => {
    const { app, agent, store } = setup()
    // The first shopper opens the store's link and does nothing more.
    await shopper(agent, { consent: false, returned: false })
    const owner = store.quote(QID, clock.value.getTime())!.sessionId
    // Someone the link was forwarded to opens it too, then tries to opt in and go back.
    const forwarded = request.agent(app)
    await post(forwarded, '/api/handoff/open', { token: larkspur.signQuote(quote) })
    expect(
      (await post(forwarded, '/api/handoff/consent', { qid: QID, consent: true })).status,
    ).toBe(404)
    expect((await post(forwarded, '/api/handoff/return', { qid: QID })).status).toBe(404)
    expect(store.quote(QID, clock.value.getTime())).toMatchObject({
      sessionId: owner,
      consent: false,
    })
    expect((await report(app)).body).toEqual({ recorded: false })
    expect(storeRows(await state(agent))).toHaveLength(0)
    expect(storeRows(await state(forwarded))).toHaveLength(0)
  })

  it('records nothing when the quote’s session has expired', async () => {
    const { app, agent, store } = setup()
    await shopper(agent)
    const id = store.quote(QID, clock.value.getTime())!.sessionId
    store.setExpiry(id, clock.value.getTime() - 1)
    expect((await report(app)).body).toEqual({ recorded: false })
    expect(store.purchases(id)).toEqual([])
  })

  it('records one purchase per quote: a second capture for it is not recorded', async () => {
    const { app, agent } = setup()
    await shopper(agent)
    expect((await report(app)).body).toEqual({ recorded: true })
    expect((await report(app, capture({ captureId: 'CAP2', orderId: 'ORDER2' }))).body).toEqual({
      recorded: false,
    })
    expect(storeRows(await state(agent))).toHaveLength(1)
  })
})

describe('idempotent on captureId', () => {
  it('answers a repeat with the first answer, even after consent changes', async () => {
    const { app, agent } = setup()
    await shopper(agent, { consent: false })
    expect((await report(app)).body).toEqual({ recorded: false })
    await post(agent, '/api/handoff/consent', { qid: QID, consent: true })
    expect((await report(app)).body).toEqual({ recorded: false })
    expect(storeRows(await state(agent))).toHaveLength(0)
    // The same capture under another quote or amount is still the first answer.
    expect((await report(app, capture({ amountCents: 1 }))).body).toEqual({ recorded: false })
  })

  it('records once when the store’s capture path and webhook race', async () => {
    const { app, agent, store } = setup()
    await shopper(agent, { input: { amountCents: 5000 } })
    const before = await room(agent)
    // The capture response and the PAYMENT.CAPTURE.COMPLETED webhook each send, at once, each
    // signed separately (as two store instances would).
    const sent = capture({ amountCents: 5000 })
    const answers = await Promise.all([report(app, sent), report(app, sent), report(app, sent)])
    expect(answers.map((r) => [r.status, r.body])).toEqual([
      [200, { recorded: true }],
      [200, { recorded: true }],
      [200, { recorded: true }],
    ])
    expect(storeRows(await state(agent))).toHaveLength(1)
    expect(await room(agent)).toBe(before - 5000)
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM handoff_outcomes').get()).toEqual({ n: 1 })
  })

  it('keeps the key with the session and drops it with the session', async () => {
    const { app, agent, store } = setup()
    await shopper(agent)
    await report(app)
    store.cleanup(clock.value.getTime() + 25 * 3600_000)
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM handoff_outcomes').get()).toEqual({ n: 0 })
  })
})

describe('refusals, in the contract’s order, with one generic body', () => {
  it('refuses a body over 2 KB before anything else', async () => {
    const { app, agent } = setup()
    await shopper(agent)
    const big = JSON.stringify({ ...capture(), pad: 'x'.repeat(2100) })
    const response = await report(app, big, { signature: 'not-even-close' })
    expect(response.status).toBe(400)
    expect(response.body).toEqual(REFUSED)
    // Exactly 2 KB is read, then refused for its shape, not its size.
    const body = JSON.stringify(capture())
    const padded = body.slice(0, -1) + ',"pad":"' + 'x'.repeat(2048 - body.length - 9) + '"}'
    expect(Buffer.byteLength(padded)).toBe(2048)
    const exact = await report(app, padded)
    expect(exact.status).toBe(400)
    expect(exact.body).toEqual(REFUSED)
    expect(storeRows(await state(agent))).toHaveLength(0)
  })

  it('refuses a missing, malformed or skewed timestamp', async () => {
    const { app, agent } = setup()
    await shopper(agent)
    for (const timestamp of [
      String(seconds() - 301),
      String(seconds() + 301),
      '',
      '17e8',
      `${seconds()}.5`,
    ]) {
      const response = await report(app, capture(), { timestamp })
      expect([timestamp, response.status, response.body]).toEqual([timestamp, 401, REFUSED])
    }
    expect((await report(app, capture(), { drop: 'timestamp' })).status).toBe(401)
    // 300 seconds either way is inside the window.
    expect((await report(app, capture(), { timestamp: String(seconds() - 300) })).status).toBe(200)
  })

  it('refuses a missing, wrong or non-canonical signature', async () => {
    const { app, agent } = setup()
    await shopper(agent)
    const good = larkspur.signOutcome(capture()).headers['Worth-Handoff-Signature']
    // The last base64url character carries two unused bits: a twin decodes to the same bytes.
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const twin = good.slice(0, -1) + ALPHABET[ALPHABET.indexOf(good.at(-1)!) ^ 1]
    expect(Buffer.from(twin, 'base64url')).toEqual(Buffer.from(good, 'base64url'))
    const other = createHandoff({
      secret: Buffer.alloc(32, 4),
      mid: 'larkspur',
      merchantOrigin: STORE,
      now: () => clock.value.getTime(),
    })
    const forged = other.signOutcome(capture()).headers['Worth-Handoff-Signature']
    for (const signature of [twin, forged, '', good.slice(0, 42), `${good}A`]) {
      const response = await report(app, capture(), { signature })
      expect([signature, response.status, response.body]).toEqual([signature, 401, REFUSED])
    }
    expect((await report(app, capture(), { drop: 'signature' })).status).toBe(401)
    // A signature for the same body at another timestamp doesn't carry over.
    const signed = larkspur.signOutcome(capture())
    const replayed = await request(app)
      .post('/api/handoff/outcome')
      .set({ ...signed.headers, 'Worth-Handoff-Timestamp': String(seconds() + 1) })
      .send(signed.body)
    expect(replayed.status).toBe(401)
    expect(storeRows(await state(agent))).toHaveLength(0)
  })

  it('checks the signature before the shape, and the shape strictly', async () => {
    const { app, agent } = setup()
    await shopper(agent)
    // A bad shape with a bad signature is a signature failure.
    const unsigned = await report(app, '{"v":2}', { signature: 'A'.repeat(43) })
    expect(unsigned.status).toBe(401)
    const { v: _v, ...noVersion } = capture()
    for (const body of [
      '{not json',
      '[]',
      JSON.stringify({ ...capture(), extra: true }),
      JSON.stringify(noVersion),
      JSON.stringify(capture({ status: 'PENDING' as 'COMPLETED' })),
      JSON.stringify(capture({ amountCents: 0 })),
      JSON.stringify(capture({ amountCents: 1199.5 })),
      JSON.stringify(capture({ capturedAt: 'yesterday' })),
      JSON.stringify(capture({ qid: 'q_short' })),
      JSON.stringify(capture({ captureId: 'CAP 1' })),
    ]) {
      const response = await report(app, body)
      expect([body, response.status, response.body]).toEqual([body, 400, REFUSED])
    }
    expect(storeRows(await state(agent))).toHaveLength(0)
  })

  it('refuses an unknown key id or merchant id, then a non-USD capture', async () => {
    const { app, agent } = setup()
    await shopper(agent)
    for (const patch of [{ kid: '2' }, { mid: 'other' }]) {
      const response = await report(app, capture(patch))
      expect(response.status).toBe(401)
      expect(response.body).toEqual(REFUSED)
    }
    // A wrong key id is refused before the currency is looked at.
    expect((await report(app, capture({ kid: '2', currency: 'EUR' }))).status).toBe(401)
    const euro = await report(app, capture({ currency: 'EUR' }))
    expect(euro.status).toBe(400)
    expect(euro.body).toEqual(REFUSED)
    expect(storeRows(await state(agent))).toHaveLength(0)
  })

  it('answers an unknown or expired qid with a generic 404 and keeps no key', async () => {
    const { app, agent, store } = setup()
    const response = await report(app)
    expect(response.status).toBe(404)
    expect(response.body).toEqual(NOT_FOUND)
    await shopper(agent)
    // The 404 left no answer behind, so the real report still records.
    expect((await report(app)).body).toEqual({ recorded: true })
    // Once the quote has expired, its later captures are unknown too.
    clock.value = new Date(clock.value.getTime() + 24 * 3600_000)
    expect((await report(app, capture({ captureId: 'CAP9' }))).status).toBe(404)
    expect(store.outcome('CAP9')).toBeUndefined()
  })

  it('limits each merchant after the signature check, never before it', async () => {
    const { app } = setup()
    // Unsigned noise doesn't use up the store's allowance.
    for (let i = 0; i < 70; i++)
      expect((await report(app, capture(), { signature: 'A'.repeat(43) })).status).toBe(401)
    for (let i = 0; i < 60; i++)
      expect((await report(app, capture({ captureId: `CAP${i}` }))).status).toBe(404)
    const limited = await report(app, capture({ captureId: 'CAP60' }))
    expect(limited.status).toBe(429)
    clock.value = new Date(clock.value.getTime() + 61_000)
    expect((await report(app, capture({ captureId: 'CAP61' }))).status).toBe(404)
  })

  it('needs no browser headers, cookie or session, and sets none', async () => {
    const { app, agent, store } = setup()
    await shopper(agent)
    const sessions = store.count(clock.value.getTime())
    const response = await report(app)
    expect(response.status).toBe(200)
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.headers['cache-control']).toBe('no-store')
    expect(store.count(clock.value.getTime())).toBe(sessions)
  })
})

describe('with the hand-off off (contract §1)', () => {
  for (const [name, off] of [
    ['both unset', { handoffSecret: undefined, merchantOrigin: undefined }],
    ['no store origin', { merchantOrigin: undefined }],
    ['no key', { handoffSecret: undefined }],
  ] as const)
    it(`answers every report with a generic 404, never a 500 (${name})`, async () => {
      const { app } = setup({ config: { ...config, ...off } })
      for (const response of [
        await report(app),
        await report(app, capture(), { signature: 'x' }),
        await report(app, JSON.stringify({ pad: 'x'.repeat(5000) })),
        await request(app).post('/api/handoff/outcome').send('{oops'),
        await request(app).post('/api/handoff/outcome'),
      ]) {
        expect(response.status).toBe(404)
        expect(response.body).toEqual(NOT_FOUND)
      }
      const agent = request.agent(app)
      const seen = await post(agent, '/api/handoff/notices/seen', { purchaseIds: ['p1'] })
      expect(seen.status).toBe(404)
    })
})

describe('stored purchase', () => {
  it('keeps the store’s order and capture apart from Worth’s own PayPal identities', async () => {
    const { app, agent, store } = setup()
    await shopper(agent)
    await report(app)
    const id = store.quote(QID, clock.value.getTime())!.sessionId
    const [stored] = store.purchases(id) as StoredPurchase[]
    expect(stored!.storeReport).toEqual({
      mid: 'larkspur',
      qid: QID,
      orderId: 'ORDER1',
      captureId: 'CAP1',
    })
    // Worth's own webhook and refund lookups never find a store's order.
    expect(store.byOrder('ORDER1')).toBeUndefined()
    expect(store.byCapture('CAP1')).toBeUndefined()
  })
})

describe('a later PayPal CSV import (contract §5)', () => {
  const csv = [
    'Date,Name,Type,Status,Currency,Amount,Transaction ID',
    '2026-10-03,Larkspur Supply,Express Checkout Payment,Completed,USD,-1199.00,BUYER-1',
    '2026-10-02,Corner cafe,Express Checkout Payment,Completed,USD,-4.50,BUYER-2',
  ].join('\n')

  it('keeps the reported payment as one row and one paid purchase', async () => {
    const { app, agent, store } = setup()
    await shopper(agent)
    await report(app)
    // The shopper is already on their own imported plan.
    const id = store.quote(QID, clock.value.getTime())!.sessionId
    const data = store.get(id)!
    data.profile.source = 'import'
    data.transactions = data.transactions.filter((t) => t.source === 'purchase')
    store.save(id, data)
    const preview = await post(agent, '/api/import/preview', { csv })
    expect(preview.body.duplicates).toBe(1)
    expect(preview.body.storeMatches).toEqual([
      expect.objectContaining({
        name: 'Larkspur Supply',
        store: 'Larkspur Supply',
        item: 'Everyday camera',
      }),
    ])
    const committed = await post(agent, '/api/import/commit', { csv })
    expect(committed.status).toBe(200)
    const after = committed.body as AppState
    const payments = after.transactions.filter((t) => t.amountCents === -119900)
    expect(payments).toEqual([
      expect.objectContaining({ source: 'purchase', name: 'Everyday camera' }),
    ])
    expect(after.transactions.map((t) => t.name)).toContain('Corner cafe')
    expect(after.purchases.filter((p) => p.reportedBy)).toHaveLength(1)
  })

  it('sets the purchase aside with the sample plan when the import replaces it', async () => {
    const { app, agent } = setup()
    await shopper(agent)
    await report(app)
    const committed = await post(agent, '/api/import/commit', { csv })
    expect(committed.status).toBe(200)
    const after = committed.body as AppState
    // The export now holds the payment; the sample plan's copy no longer counts.
    expect(after.transactions.filter((t) => t.amountCents === -119900)).toEqual([
      expect.objectContaining({ source: 'import', id: 'paypal:BUYER-1' }),
    ])
    expect(after.purchases.every((p) => p.archived)).toBe(true)
  })
})
