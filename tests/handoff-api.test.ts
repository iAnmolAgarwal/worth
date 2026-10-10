import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../server/app.ts'
import { Store } from '../server/store.ts'
import { publicSaved } from '../server/saved.ts'
import type { PayPalGateway } from '../server/paypal.ts'
import type { ChatProvider } from '../server/chat.ts'
import { createHandoff, signToken, secretBytes } from '../shared/handoff.ts'
import type { QuoteInput } from '../shared/handoff.ts'
import type { AppState, HandoffOpened } from '../shared/types.ts'

const SECRET = Buffer.alloc(32, 3).toString('base64url')
const STORE = 'https://store.example'
const handoffConfig = { handoffSecret: SECRET, merchantOrigin: STORE }
const config = {
  production: false,
  origin: 'http://localhost:5173',
  paypalClientId: undefined,
  paypalSecret: undefined,
  anthropicKey: undefined,
  ...handoffConfig,
}
const clock = { value: new Date('2026-10-03T12:00:00Z') }
/** The store's side of the contract, on the same clock as Worth. */
const larkspur = createHandoff({
  secret: SECRET,
  mid: 'larkspur',
  merchantOrigin: STORE,
  now: () => clock.value.getTime(),
})
const quote: QuoteInput = {
  qid: 'q_abcdefghijklmnopqrstuv',
  item: 'Everyday camera',
  productId: 'camera',
  amountCents: 119900,
  currency: 'USD',
  merchant: 'Larkspur Supply',
  returnUrl: `${STORE}/p/camera`,
  imageUrl: `${STORE}/img/camera.png`,
  payLater: { eligible: true, source: 'merchant-sdk' },
}
const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function setup(extra: Parameters<typeof createApp>[0] = {}) {
  clock.value = new Date('2026-10-03T12:00:00Z')
  const store = new Store(':memory:')
  stores.push(store)
  const eligibility = vi.fn(async () => ({ payLater: true }))
  const paypal = { eligibility } as unknown as PayPalGateway
  const reply = vi.fn()
  const chat = { reply } as unknown as ChatProvider
  const app = createApp({ store, config, paypal, chat, now: () => clock.value, ...extra })
  return { app, store, eligibility, reply, agent: request.agent(app) }
}
type Agent = ReturnType<typeof request.agent>
function post(agent: Agent, path: string, body: object = {}) {
  return agent.post(path).set('X-Worth-Client', 'web').send(body)
}
async function open(agent: Agent, token: string) {
  return post(agent, '/api/handoff/open', { token })
}
async function opened(agent: Agent, input: Partial<QuoteInput> = {}) {
  const response = await open(agent, larkspur.signQuote({ ...quote, ...input }))
  expect(response.status).toBe(200)
  return response.body as HandoffOpened
}
async function state(agent: Agent): Promise<AppState> {
  return (await agent.get('/api/state')).body
}

describe('GET /check', () => {
  it('sends no referrer from the page a hand-off lands on', async () => {
    const { app } = setup()
    expect((await request(app).get('/check')).headers['referrer-policy']).toBe('no-referrer')
    expect((await request(app).get('/')).headers['referrer-policy']).toBe('same-origin')
    expect((await request(app).get('/api/state')).headers['referrer-policy']).toBe('same-origin')
    expect((await request(app).get('/check/')).headers['referrer-policy']).toBe('no-referrer')
    expect((await request(app).get('/checkout')).headers['referrer-policy']).toBe('same-origin')
  })

  it('allows the store origin for product images in the production policy', async () => {
    const { app } = setup({
      config: { ...config, production: true, trustProxy: 1, origin: 'https://w.example' },
    })
    const policy = (await request(app).get('/api/health')).headers['content-security-policy']
    expect(policy).toMatch(new RegExp(`img-src [^;]*${STORE}`))
    expect(policy).not.toMatch(new RegExp(`script-src [^;]*${STORE}`))
    expect(policy).not.toMatch(new RegExp(`connect-src [^;]*${STORE}`))
  })
})

describe('POST /api/handoff/open (contract §3.3)', () => {
  it('verifies the quote, binds it to a new sample-plan session and returns it for display', async () => {
    const { agent, store, reply } = setup()
    const response = await open(agent, larkspur.signQuote(quote))
    expect(response.status).toBe(200)
    const body = response.body as HandoffOpened
    expect(body.quote).toEqual({
      qid: quote.qid,
      merchant: 'Larkspur Supply',
      item: 'Everyday camera',
      amountCents: 119900,
      returnUrl: `${STORE}/p/camera`,
      imageUrl: `${STORE}/img/camera.png`,
      payLater: 'offered',
      consent: false,
      canConsent: true,
    })
    // A first visit gets Maya's sample plan, exactly as on Home.
    expect(body.state.profile.source).toBe('demo')
    expect(body.replay).toBeUndefined()
    const stored = store.quote(quote.qid, clock.value.getTime())!
    expect(stored).toMatchObject({
      qid: quote.qid,
      mid: 'larkspur',
      item: 'Everyday camera',
      amountCents: 119900,
      merchant: 'Larkspur Supply',
      returnUrl: `${STORE}/p/camera`,
      payLater: { eligible: true, source: 'merchant-sdk' },
      openedAt: clock.value.getTime(),
      consent: false,
    })
    expect(store.isLive(stored.sessionId, clock.value.getTime())).toBe(true)
    // Store text never reaches Claude from the hand-off.
    expect(reply).not.toHaveBeenCalled()
  })

  it('keeps the quote for 24 hours and deletes it with the session', async () => {
    const { agent, store } = setup()
    await opened(agent)
    const time = clock.value.getTime()
    expect(store.quote(quote.qid, time + 24 * 3600_000 - 1)).toBeDefined()
    expect(store.quote(quote.qid, time + 24 * 3600_000)).toBeUndefined()
    store.cleanup(time + 24 * 3600_000)
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM handoff_quotes').get()).toEqual({ n: 0 })
    const again = setup()
    await opened(again.agent)
    const { sessionId } = again.store.quote(quote.qid, clock.value.getTime())!
    again.store.delete(sessionId)
    expect(again.store.quote(quote.qid, clock.value.getTime())).toBeUndefined()
  })

  it('shows the store’s Pay in 4 answer as offered or unknown: a signed no is unknown', async () => {
    const offered = setup()
    expect((await opened(offered.agent)).quote.payLater).toBe('offered')
    const declined = setup()
    expect(
      (await opened(declined.agent, { payLater: { eligible: false, source: 'merchant-sdk' } }))
        .quote.payLater,
    ).toBe('unknown')
    const unknown = setup()
    expect((await opened(unknown.agent, { payLater: undefined })).quote.payLater).toBe('unknown')
    // Over $2,000 PayPal's answer can't be an offer of Pay in 4.
    const over = setup()
    expect((await opened(over.agent, { amountCents: 250000 })).quote.payLater).toBe('not-offered')
  })

  const unverified = {
    error: 'We couldn’t verify this link from the store. You can still check the item yourself.',
    code: 'HANDOFF_UNVERIFIED',
  }
  const key = secretBytes(SECRET)!
  const payload = {
    ...quote,
    v: 1,
    kid: '1',
    mid: 'larkspur',
    iat: Math.floor(new Date('2026-10-03T12:00:00Z').getTime() / 1000),
    exp: Math.floor(new Date('2026-10-03T12:15:00Z').getTime() / 1000),
  }
  const cases: [string, string][] = [
    ['bad format', 'not-a-token'],
    ['oversize', `${'A'.repeat(5000)}.${'A'.repeat(43)}`],
    ['unknown kid', signToken(key, 'quote', { ...payload, kid: '9' })],
    ['unknown mid', signToken(key, 'quote', { ...payload, mid: 'other' })],
    [
      'bad signature',
      signToken(secretBytes(Buffer.alloc(32, 4).toString('base64url'))!, 'quote', payload),
    ],
    ['a result replayed as a quote', signToken(key, 'result', payload)],
    ['bad version', signToken(key, 'quote', { ...payload, v: 2 })],
    ['bad shape', signToken(key, 'quote', { ...payload, extra: 'field' })],
    [
      'wrong return origin',
      signToken(key, 'quote', { ...payload, returnUrl: 'https://evil.example/p' }),
    ],
    [
      'wrong image origin',
      signToken(key, 'quote', { ...payload, imageUrl: 'https://evil.example/i.png' }),
    ],
    ['a lifetime over 900 s', signToken(key, 'quote', { ...payload, exp: payload.iat + 901 })],
    [
      'an iat in the future',
      signToken(key, 'quote', { ...payload, iat: payload.iat + 120, exp: payload.iat + 900 }),
    ],
  ]
  for (const [name, token] of cases)
    it(`refuses ${name} with the unverified message and no way back to the store`, async () => {
      const { agent, store } = setup()
      const response = await open(agent, token)
      expect(response.status).toBe(400)
      expect(response.body).toEqual(unverified)
      const text = JSON.stringify(response.body)
      for (const leak of ['store.example', 'evil.example', 'Everyday camera', 'Larkspur', token])
        expect(text).not.toContain(leak)
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM handoff_quotes').get()).toEqual({ n: 0 })
    })

  it('answers a body over 8 KB with the unverified message, not the CSV one', async () => {
    const { agent } = setup()
    const response = await post(agent, '/api/handoff/open', { token: 'A'.repeat(9000) })
    expect(response.status).toBe(400)
    expect(response.body).toEqual(unverified)
  })

  it('refuses a body that isn’t just a token string', async () => {
    const { agent } = setup()
    for (const body of [{}, { token: 1 }, { token: 'x', more: true }])
      expect((await post(agent, '/api/handoff/open', body)).body).toEqual(unverified)
  })

  it('with the hand-off off, every route answers generically and says it is off', async () => {
    const { agent } = setup({
      config: { ...config, handoffSecret: undefined, merchantOrigin: undefined },
    })
    expect((await agent.get('/api/health')).body.handoff).toBe('off')
    expect((await state(agent)).config.handoff).toBe('off')
    const token = larkspur.signQuote(quote)
    expect((await open(agent, token)).body).toEqual(unverified)
    const qid = quote.qid
    expect((await agent.get(`/api/handoff/quotes/${qid}`)).status).toBe(404)
    expect((await post(agent, '/api/handoff/consent', { qid, consent: true })).status).toBe(404)
    expect((await post(agent, '/api/handoff/return', { qid })).status).toBe(404)
    expect((await post(agent, '/api/compare', { amountCents: 119900, qid })).status).toBe(404)
    expect((await post(agent, '/api/handoff/outcome', {})).status).toBe(404)
    const on = setup()
    expect((await request(on.app).get('/api/health')).body.handoff).toBe('on')
    expect((await state(on.agent)).config.handoff).toBe('on')
  })

  it('treats every link as unverified while the key or store origin is unset', async () => {
    const { agent } = setup({ config: { ...config, handoffSecret: undefined } })
    const response = await open(agent, larkspur.signQuote(quote))
    expect(response.status).toBe(400)
    expect(response.body).toEqual(unverified)
    const noOrigin = setup({ config: { ...config, merchantOrigin: undefined } })
    expect((await open(noOrigin.agent, larkspur.signQuote(quote))).body).toEqual(unverified)
  })

  it('says an expired link has expired, naming the store, with the plain way back', async () => {
    const { agent, store } = setup()
    const token = larkspur.signQuote(quote)
    clock.value = new Date(clock.value.getTime() + (900 + 61) * 1000)
    const response = await open(agent, token)
    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      error:
        'This link from Larkspur Supply has expired. Go back and tap Analyse with Worth again.',
      code: 'HANDOFF_EXPIRED',
      merchant: 'Larkspur Supply',
      returnUrl: `${STORE}/p/camera`,
    })
    expect(store.quote(quote.qid, clock.value.getTime())).toBeUndefined()
  })

  it('says Worth checks US dollars only for a non-USD quote, with the way back', async () => {
    const { agent } = setup()
    const response = await open(agent, larkspur.signQuote({ ...quote, currency: 'EUR' }))
    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      error: 'Worth checks US dollar prices for now.',
      code: 'HANDOFF_CURRENCY',
      merchant: 'Larkspur Supply',
      item: 'Everyday camera',
      returnUrl: `${STORE}/p/camera`,
    })
  })

  it('limits hand-off calls per client IP with the existing message', async () => {
    const { agent } = setup()
    const token = larkspur.signQuote(quote)
    for (let i = 0; i < 30; i++) expect((await open(agent, token)).status).toBe(200)
    const limited = await open(agent, token)
    expect(limited.status).toBe(429)
    expect(limited.body).toEqual({
      error: 'Please wait a moment before making more requests.',
      code: 'RATE_LIMITED',
    })
    expect(
      (await post(agent, '/api/handoff/consent', { qid: quote.qid, consent: true })).status,
    ).toBe(429)
    clock.value = new Date(clock.value.getTime() + 60_000)
    expect((await open(agent, larkspur.signQuote(quote))).status).toBe(200)
  })

  it('accepts hand-off calls only from the Worth app', async () => {
    const { app } = setup()
    const token = larkspur.signQuote(quote)
    expect((await request(app).post('/api/handoff/open').send({ token })).status).toBe(403)
    expect(
      (
        await request(app)
          .post('/api/handoff/open')
          .set('X-Worth-Client', 'web')
          .set('Origin', STORE)
          .send({ token })
      ).status,
    ).toBe(403)
  })

  it('binds a quote to the first session that opens it; another session can’t take it', async () => {
    const first = setup()
    await opened(first.agent)
    const owner = first.store.quote(quote.qid, clock.value.getTime())!.sessionId
    const other = request.agent(first.app)
    const second = await opened(other)
    expect(second.quote).toMatchObject({ qid: quote.qid, consent: false, canConsent: false })
    expect(first.store.quote(quote.qid, clock.value.getTime())!.sessionId).toBe(owner)
    expect(
      (await post(other, '/api/handoff/consent', { qid: quote.qid, consent: true })).status,
    ).toBe(404)
    expect((await post(other, '/api/handoff/return', { qid: quote.qid })).status).toBe(404)
    expect((await other.get(`/api/handoff/quotes/${quote.qid}`)).status).toBe(404)
  })

  it('turns on the video replay only for the sample persona', async () => {
    const sample = setup()
    clock.value = new Date('2026-10-10T12:00:00Z')
    await state(sample.agent)
    const body = await opened(sample.agent, { replay: 'video' })
    expect(body.replay).toBe(true)
    expect(body.state.demoClock).toEqual({ today: '2026-10-03', preset: 'video' })
    expect(body.state.today).toBe('2026-10-03')
    // Opening again keeps the replay as it is.
    expect((await opened(sample.agent, { replay: 'video' })).replay).toBeUndefined()

    const own = setup()
    clock.value = new Date('2026-10-10T12:00:00Z')
    await state(own.agent)
    const id = own.store.db.prepare('SELECT id FROM sessions').get() as { id: string }
    const data = own.store.get(id.id)!
    own.store.save(id.id, { ...data, profile: { ...data.profile, source: 'import' } })
    const mine = await opened(own.agent, { replay: 'video' })
    expect(mine.replay).toBeUndefined()
    expect(mine.state.demoClock).toBeUndefined()
    expect(mine.state.today).toBe('2026-10-10')
  })
})

describe('POST /api/handoff/consent', () => {
  it('starts unticked and records the choice for the session that opened the quote', async () => {
    const { agent, store } = setup()
    expect((await opened(agent)).quote.consent).toBe(false)
    const ticked = await post(agent, '/api/handoff/consent', { qid: quote.qid, consent: true })
    expect(ticked.status).toBe(200)
    expect(ticked.body).toEqual({ qid: quote.qid, consent: true })
    expect(store.quote(quote.qid, clock.value.getTime())!.consent).toBe(true)
    // Reopening the same link keeps the choice; the reload view shows it.
    expect((await opened(agent)).quote.consent).toBe(true)
    expect((await agent.get(`/api/handoff/quotes/${quote.qid}`)).body.quote.consent).toBe(true)
    await post(agent, '/api/handoff/consent', { qid: quote.qid, consent: false })
    expect(store.quote(quote.qid, clock.value.getTime())!.consent).toBe(false)
  })

  it('refuses an unknown quote and anything but a qid and a boolean', async () => {
    const { agent } = setup()
    await opened(agent)
    expect(
      (
        await post(agent, '/api/handoff/consent', {
          qid: 'q_ZZZZZZZZZZZZZZZZZZZZZZ',
          consent: true,
        })
      ).status,
    ).toBe(404)
    for (const body of [
      { qid: quote.qid, consent: 'yes' },
      { qid: quote.qid },
      { qid: quote.qid, consent: true, sessionId: 'x' },
      { qid: 'nope', consent: true },
    ])
      expect((await post(agent, '/api/handoff/consent', body)).status).toBe(400)
  })
})

describe('POST /api/handoff/return (contract §4)', () => {
  async function result(agent: Agent, body: object = {}) {
    const response = await post(agent, '/api/handoff/return', { qid: quote.qid, ...body })
    expect(response.status).toBe(200)
    const url = new URL(response.body.url as string)
    expect(url.origin + url.pathname).toBe(`${STORE}/p/camera`)
    const token = url.searchParams.get('worth')
    return { url, token, verified: token ? larkspur.verifyResult(token) : undefined }
  }

  it('signs a wait verdict with the date it fits, and nothing about money or the plan', async () => {
    const { agent } = setup()
    await opened(agent)
    const { token, verified } = await result(agent)
    expect(verified).toMatchObject({
      ok: true,
      payload: { qid: quote.qid, verdict: 'wait', fitsOn: '2026-10-23' },
    })
    const payload = JSON.parse(Buffer.from(token!.split('.')[0]!, 'base64url').toString())
    expect(Object.keys(payload).sort()).toEqual(
      ['exp', 'fitsOn', 'iat', 'kid', 'mid', 'payIn4Fits', 'qid', 'v', 'verdict'].sort(),
    )
    expect(payload.exp - payload.iat).toBe(900)
  })

  it('records returnedAt only when it signs a result, in the owning session (§5)', async () => {
    const { agent, store } = setup()
    await opened(agent)
    const stored = () => store.quote(quote.qid, clock.value.getTime())!
    expect(stored().returnedAt).toBeUndefined()
    // A changed price goes back without a result, so it doesn't count as returning through Worth.
    await result(agent, { amountCents: 2000 })
    expect(stored().returnedAt).toBeUndefined()
    clock.value = new Date(clock.value.getTime() + 5000)
    await result(agent)
    expect(stored().returnedAt).toBe(clock.value.getTime())
    // Reopening the link and consenting keep it.
    await post(agent, '/api/handoff/consent', { qid: quote.qid, consent: true })
    await opened(agent)
    expect(stored()).toMatchObject({ consent: true, returnedAt: clock.value.getTime() })
    expect(store.markQuoteReturned(quote.qid, 'another-session', clock.value.getTime())).toBe(false)
  })

  it('signs buy today with today’s date for an item that fits', async () => {
    const { agent } = setup()
    await opened(agent, { amountCents: 2000 })
    const { verified } = await result(agent)
    expect(verified).toMatchObject({
      ok: true,
      payload: { verdict: 'buy_today', fitsOn: '2026-10-03', payIn4Fits: true },
    })
  })

  it('never signs a verdict once the shopper changed the price (contract §7)', async () => {
    const { agent } = setup()
    await opened(agent)
    // $20 would fit today, but the store would show it next to its own $1,199.
    const edited = await result(agent, { amountCents: 2000 })
    expect(edited.token).toBeNull()
    expect(edited.url.toString()).toBe(`${STORE}/p/camera`)
    // The store's own price, sent explicitly, is not an edit.
    const same = await result(agent, { amountCents: 119900 })
    expect(same.verified).toMatchObject({ ok: true, payload: { verdict: 'wait' } })
  })

  it('judges Pay in 4 by the range when the store signed a no, as for no answer (§3.2)', async () => {
    const { agent } = setup()
    await opened(agent, { payLater: { eligible: false, source: 'merchant-sdk' } })
    const { verified } = await result(agent)
    expect(verified?.ok && typeof verified.payload.payIn4Fits).toBe('boolean')
  })

  it('keeps an existing query and returns the plain link when the plan needs details first', async () => {
    const { agent, store } = setup()
    await opened(agent, { returnUrl: `${STORE}/p/camera?ref=worth` })
    const { url } = await result(agent)
    expect(url.searchParams.get('ref')).toBe('worth')
    expect(url.searchParams.get('worth')).toBeTruthy()
    const id = store.quote(quote.qid, clock.value.getTime())!.sessionId
    const data = store.get(id)!
    store.save(id, { ...data, profile: { ...data.profile, confirmed: false } })
    const plain = await post(agent, '/api/handoff/return', { qid: quote.qid })
    expect(plain.body.url).toBe(`${STORE}/p/camera?ref=worth`)
  })

  it('refuses a quote this session didn’t open and money fields it doesn’t take', async () => {
    const { agent } = setup()
    expect((await post(agent, '/api/handoff/return', { qid: quote.qid })).status).toBe(404)
    await opened(agent)
    expect(
      (await post(agent, '/api/handoff/return', { qid: quote.qid, verdict: 'buy_today' })).status,
    ).toBe(400)
  })
})

describe('the decision for a store’s item', () => {
  it('uses the store’s Pay in 4 answer for its own price, without asking PayPal', async () => {
    const { agent, eligibility } = setup()
    await opened(agent)
    const compare = (body: object) =>
      post(agent, '/api/compare', { itemName: 'Everyday camera', qid: quote.qid, ...body })
    const own = await compare({ amountCents: 119900 })
    expect(own.status).toBe(200)
    expect(own.body.payIn4).toMatchObject({ available: true, eligibility: 'paypal' })
    // A corrected price wasn't the store's question, so only the range decides.
    const edited = await compare({ amountCents: 125000 })
    expect(edited.body.payIn4).toMatchObject({ available: true, eligibility: 'range-only' })
    expect(eligibility).not.toHaveBeenCalled()
    // Without a quote, Worth's own check runs as before.
    await post(agent, '/api/compare', { itemName: 'Everyday camera', amountCents: 119900 })
    expect(eligibility).toHaveBeenCalledTimes(1)
  })

  it('reads a store’s signed no as unknown: range only (§3.2)', async () => {
    const { agent } = setup()
    await opened(agent, { payLater: { eligible: false, source: 'merchant-sdk' } })
    const response = await post(agent, '/api/compare', {
      itemName: 'Everyday camera',
      amountCents: 119900,
      qid: quote.qid,
    })
    expect(response.body.payIn4).toMatchObject({ available: true, eligibility: 'range-only' })
  })

  it('treats a quote without an answer as range only', async () => {
    const { agent } = setup()
    await opened(agent, { payLater: undefined })
    const response = await post(agent, '/api/compare', {
      itemName: 'Everyday camera',
      amountCents: 119900,
      qid: quote.qid,
    })
    expect(response.body.payIn4).toMatchObject({ eligibility: 'range-only' })
  })

  it('refuses another session’s quote id', async () => {
    const { app, agent } = setup()
    await opened(agent)
    const other = request.agent(app)
    const response = await post(other, '/api/compare', { amountCents: 119900, qid: quote.qid })
    expect(response.status).toBe(404)
  })
})

describe('POST /api/handoff/save (contract §4, Save for <date>)', () => {
  const WAIT = '2026-10-23'
  /** Saved items with a store link: Maya's sample has her own saved items too. */
  const savedOf = async (agent: Agent) =>
    ((await state(agent)).saved ?? []).filter((item) => item.sourceUrl)

  it('saves the store’s item with its link, name and price, as the store’s price', async () => {
    const { agent } = setup()
    await opened(agent)
    const response = await post(agent, '/api/handoff/save', { qid: quote.qid, waitDate: WAIT })
    expect(response.status).toBe(200)
    expect(response.body.item).toMatchObject({
      kind: 'custom',
      name: 'Everyday camera',
      amountCents: 119900,
      option: 'wait',
      waitDate: WAIT,
      sourceUrl: `${STORE}/p/camera`,
      merchantName: 'Larkspur Supply',
      priceSource: 'component',
    })
    const [saved] = await savedOf(agent)
    expect(saved).toMatchObject({
      sourceUrl: `${STORE}/p/camera`,
      merchantName: 'Larkspur Supply',
      priceSource: 'component',
      status: 'active',
    })
    // Saving again updates the same item rather than adding another.
    await post(agent, '/api/handoff/save', { qid: quote.qid, waitDate: '2026-10-24' })
    const items = await savedOf(agent)
    expect(items).toHaveLength(1)
    expect(items[0]!.waitDate).toBe('2026-10-24')
  })

  it('saves a price the shopper changed as theirs, still linked to the store', async () => {
    const { agent } = setup()
    await opened(agent)
    const response = await post(agent, '/api/handoff/save', {
      qid: quote.qid,
      waitDate: WAIT,
      amountCents: 125000,
      itemName: 'Everyday camera with lens',
    })
    expect(response.body.item).toMatchObject({
      name: 'Everyday camera with lens',
      amountCents: 125000,
      priceSource: 'user',
      sourceUrl: `${STORE}/p/camera`,
    })
    // The store is the verified one, so it keeps its own name.
    expect((await savedOf(agent))[0]).toMatchObject({
      priceSource: 'user',
      merchantName: 'Larkspur Supply',
    })
    // The store's own price sent back is not a change.
    const same = setup()
    await opened(same.agent)
    const kept = await post(same.agent, '/api/handoff/save', {
      qid: quote.qid,
      waitDate: WAIT,
      amountCents: 119900,
    })
    expect(kept.body.item.priceSource).toBe('component')
  })

  it('takes only the quote and the day: the browser never sets the source', async () => {
    const { agent } = setup()
    await opened(agent)
    for (const extra of [
      { priceSource: 'component' },
      { sourceUrl: `${STORE}/p/other` },
      { merchantName: 'Someone else' },
    ])
      expect(
        (await post(agent, '/api/handoff/save', { qid: quote.qid, waitDate: WAIT, ...extra }))
          .status,
      ).toBe(400)
    // The ordinary save refuses "component" too (C6).
    const plain = await post(agent, '/api/saved', {
      kind: 'custom',
      name: 'Everyday camera',
      amountCents: 119900,
      sourceUrl: `${STORE}/p/camera`,
      priceSource: 'component',
    })
    expect(plain.status).toBe(400)
    expect(await savedOf(agent)).toHaveLength(0)
  })

  it('saves only a quote this session holds, with the hand-off on', async () => {
    const { app, agent } = setup()
    await opened(agent)
    const other = request.agent(app)
    await opened(other)
    expect(
      (await post(other, '/api/handoff/save', { qid: quote.qid, waitDate: WAIT })).status,
    ).toBe(404)
    expect(
      (
        await post(agent, '/api/handoff/save', {
          qid: 'q_ZZZZZZZZZZZZZZZZZZZZZZ',
          waitDate: WAIT,
        })
      ).status,
    ).toBe(404)
    // A day outside the plan's window is refused like any saved plan.
    expect(
      (await post(agent, '/api/handoff/save', { qid: quote.qid, waitDate: '2027-01-01' })).status,
    ).toBe(400)
    const off = setup({
      config: { ...config, handoffSecret: undefined, merchantOrigin: undefined },
    })
    expect(
      (await post(off.agent, '/api/handoff/save', { qid: quote.qid, waitDate: WAIT })).status,
    ).toBe(404)
  })

  it('stores the quote’s qid on the saved item, so its reported purchase can clear it (§5)', async () => {
    const { agent } = setup()
    await opened(agent)
    const { item } = (await post(agent, '/api/handoff/save', { qid: quote.qid, waitDate: WAIT }))
      .body
    expect(item.qid).toBe(quote.qid)
    expect((await savedOf(agent))[0]!.qid).toBe(quote.qid)
  })

  it('judges a saved store item’s Pay in 4 by the range, never by Worth’s own PayPal', async () => {
    const { agent, eligibility } = setup()
    await opened(agent)
    const { item } = (await post(agent, '/api/handoff/save', { qid: quote.qid, waitDate: WAIT }))
      .body
    const compare = await post(agent, '/api/compare', {
      amountCents: 119900,
      itemName: 'Everyday camera',
      savedId: item.id,
    })
    expect(compare.status).toBe(200)
    expect(compare.body.payIn4).toMatchObject({ available: true, eligibility: 'range-only' })
    expect(eligibility).not.toHaveBeenCalled()
    // A saved item without a store link, or an ID this session doesn't hold, is Worth's own.
    await post(agent, '/api/compare', { amountCents: 119900, itemName: 'X', savedId: 'nope' })
    expect(eligibility).toHaveBeenCalledTimes(1)
  })

  it('does the same for an edited store item saved with a local link in development', async () => {
    const LOCAL = 'http://localhost:8788'
    const local = createHandoff({
      secret: SECRET,
      mid: 'larkspur',
      merchantOrigin: LOCAL,
      now: () => clock.value.getTime(),
    })
    const dev = setup({ config: { ...config, merchantOrigin: LOCAL } })
    await open(
      dev.agent,
      local.signQuote({ ...quote, returnUrl: `${LOCAL}/p/camera`, imageUrl: undefined }),
    )
    const { item } = (
      await post(dev.agent, '/api/handoff/save', {
        qid: quote.qid,
        waitDate: WAIT,
        amountCents: 125000,
      })
    ).body
    expect(item.priceSource).toBe('user')
    const compare = await post(dev.agent, '/api/compare', {
      amountCents: 125000,
      itemName: 'Everyday camera',
      savedId: item.id,
    })
    expect(compare.body.payIn4).toMatchObject({ eligibility: 'range-only' })
    expect(dev.eligibility).not.toHaveBeenCalled()
  })

  it('never re-reads the store’s price through the lookup', async () => {
    const { agent } = setup()
    await opened(agent)
    const { item } = (await post(agent, '/api/handoff/save', { qid: quote.qid, waitDate: WAIT }))
      .body
    // Refused for the store's own price before any day or lookup is considered.
    const recheck = await post(agent, `/api/saved/${item.id}/recheck`, {})
    expect(recheck.status).toBe(409)
    expect(recheck.body.code).toBe('NOT_RECHECKABLE')
  })

  it('in development, allows exactly the local store origin for a saved link', async () => {
    const LOCAL = 'http://localhost:8788'
    const local = createHandoff({
      secret: SECRET,
      mid: 'larkspur',
      merchantOrigin: LOCAL,
      now: () => clock.value.getTime(),
    })
    const dev = setup({ config: { ...config, merchantOrigin: LOCAL } })
    const token = local.signQuote({
      ...quote,
      returnUrl: `${LOCAL}/p/camera`,
      imageUrl: `${LOCAL}/images/camera.jpg`,
    })
    expect((await open(dev.agent, token)).status).toBe(200)
    await post(dev.agent, '/api/handoff/save', { qid: quote.qid, waitDate: WAIT })
    expect((await savedOf(dev.agent))[0]).toMatchObject({
      sourceUrl: `${LOCAL}/p/camera`,
      merchantName: 'Larkspur Supply',
      priceSource: 'component',
    })
    // Only that origin: another local link a browser saves is still refused.
    const pasted = await post(dev.agent, '/api/saved', {
      kind: 'custom',
      name: 'Lamp',
      amountCents: 4500,
      sourceUrl: 'http://localhost:9999/p/lamp',
      priceSource: 'user',
    })
    expect(pasted.status).toBe(400)
  })

  it('outside development, never shows a local link, even the store’s', () => {
    const item = {
      id: 'a',
      kind: 'custom' as const,
      name: 'Everyday camera',
      amountCents: 119900,
      createdAt: '2026-10-03T12:00:00.000Z',
      status: 'active' as const,
      sourceUrl: 'http://localhost:8788/p/camera',
      merchantName: 'Larkspur Supply',
      priceSource: 'component' as const,
    }
    const LOCAL = 'http://localhost:8788'
    const shown = (allowLocal: boolean) =>
      publicSaved([item], '2026-10-03', [], { origin: LOCAL, allowLocal })[0]!
    expect(shown(true)).toMatchObject({ sourceUrl: `${LOCAL}/p/camera`, priceSource: 'component' })
    expect(shown(false).sourceUrl).toBeUndefined()
    expect(shown(false).priceSource).toBeUndefined()
  })
})
