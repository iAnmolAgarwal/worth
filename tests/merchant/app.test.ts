import { describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createMerchantApp } from '../../merchant/app.ts'
import { createHandoff, signToken } from '../../shared/handoff.ts'
import { PayPalError, type PayPalGateway, type PayPalOrder } from '../../server/paypal.ts'
import { PRODUCTS } from '../../shared/seed.ts'

const SECRET = Buffer.alloc(32, 9)
const ORIGIN = 'https://larkspur.example'
const WORTH = 'https://worth.example'
const T0 = 1_791_000_000

function setup(
  options: {
    paypal?: Partial<PayPalGateway> | null
    reportReplies?: (Response | Promise<Response>)[]
  } = {},
) {
  let clock = T0 * 1000
  const created: (Parameters<PayPalGateway['create']>[0] & { qid?: string })[] = []
  const orderFor = (
    source: { id: string; amountCents: number },
    captured = false,
  ): PayPalOrder => ({
    id: 'ORDER1',
    status: captured ? 'COMPLETED' : 'PAYER_ACTION_REQUIRED',
    purchase_units: [
      {
        reference_id: source.id,
        custom_id: source.id,
        amount: { currency_code: 'USD', value: (source.amountCents / 100).toFixed(2) },
        payee: { merchant_id: 'MERCHANT1' },
        ...(captured
          ? {
              payments: {
                captures: [
                  {
                    id: 'CAP1',
                    status: 'COMPLETED',
                    amount: { currency_code: 'USD', value: (source.amountCents / 100).toFixed(2) },
                    create_time: '2026-10-23T15:04:05Z',
                  },
                ],
              },
            }
          : {}),
      },
    ],
  })
  const paypal = {
    create: vi.fn(async (source: Parameters<PayPalGateway['create']>[0]) => {
      created.push(source)
      return orderFor(source)
    }),
    capture: vi.fn(async () => orderFor(created.at(-1)!, true)),
    get: vi.fn(async () => orderFor(created.at(-1)!, true)),
    getRefund: vi.fn(),
    verify: vi.fn(async () => true),
    eligibility: vi.fn(),
    ...options.paypal,
  } as unknown as PayPalGateway
  const replies = options.reportReplies ?? [Response.json({ recorded: true })]
  const reports: { url: string; init: RequestInit }[] = []
  const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    reports.push({ url: String(url), init })
    return replies.shift() ?? Response.json({})
  })
  const app = createMerchantApp({
    env: {},
    config: {
      origin: ORIGIN,
      worthOrigin: WORTH,
      handoffSecret: SECRET,
      paypalClientId: 'public-client-id',
    },
    ...(options.paypal === null ? {} : { paypal }),
    now: () => clock,
    report: {
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: async () => {},
      log: () => {},
    },
  })
  // Worth's side of the shared module, on the store's clock, to read quotes and sign results.
  const shared = createHandoff({
    secret: SECRET,
    mid: 'larkspur',
    merchantOrigin: ORIGIN,
    now: () => clock,
  })
  const worth = {
    /** A quote's payload if Worth would accept it, as the store's first stub answered. */
    open: (_direction: 'quote', token: string | undefined) => {
      const verified = shared.verifyQuote(token)
      return verified.ok
        ? (verified.payload as Record<string, unknown> & { qid: string })
        : undefined
    },
    /** Any payload signed for a direction, valid or not, to probe the store's checks. */
    sign: (direction: 'quote' | 'result', payload: object) => signToken(SECRET, direction, payload),
  }
  return {
    app,
    paypal,
    created,
    reports,
    worth,
    tick: (seconds: number) => {
      clock += seconds * 1000
    },
  }
}

/** The quote token from the Analyse link on a page. */
function quoteToken(html: string) {
  const match = html.match(/href="https:\/\/worth\.example\/check#q=([^"]+)"/)
  return match?.[1]
}
const json = { 'Content-Type': 'application/json', Origin: ORIGIN }
/**
 * The shopper's round trip: the product page, Worth, then back with a verified result for the
 * quote. Only then may the store report the quote's purchase (contract §5, anti-forwarding).
 */
async function cameBack(t: ReturnType<typeof setup>, agent: ReturnType<typeof request.agent>) {
  const qid = t.worth.open('quote', quoteToken((await agent.get('/p/camera')).text))!.qid
  const result = t.worth.sign('result', {
    v: 1,
    kid: '1',
    mid: 'larkspur',
    qid,
    verdict: 'buy_today',
    iat: T0,
    exp: T0 + 900,
  })
  expect((await agent.get(`/p/camera?worth=${result}`)).text).toContain('Worth: fits today')
  return qid
}

describe('store pages', () => {
  it('serves a health check, the security headers and the store’s own CSP', async () => {
    const { app } = setup()
    const res = await request(app).get('/healthz').expect(200)
    expect(res.body).toEqual({ ok: true, service: 'larkspur', paypal: 'sandbox' })
    const page = await request(app).get('/')
    const csp = page.headers['content-security-policy'] as string
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self' https://www.paypal.com https://www.sandbox.paypal.com")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toMatch(/'unsafe-eval'|script-src[^;]*'unsafe-inline'/)
    // Nothing but the store and PayPal's hosts.
    const hosts = csp.match(/https:\/\/[^\s;]+/g) ?? []
    expect(hosts.every((h) => /paypal(objects)?\.com$/.test(h))).toBe(true)
    expect(page.headers['x-frame-options']).toBe('DENY')
    expect(page.headers['referrer-policy']).toBe('same-origin')
    expect(page.headers['cache-control']).toBe('no-store')
  })

  it('lists every demo product with its catalog price and a fictional-store footer', async () => {
    const { app } = setup()
    const html = (await request(app).get('/').expect(200)).text
    for (const product of PRODUCTS) {
      expect(html).toContain(`href="/p/${product.id}"`)
      expect(html).toContain(product.name)
      expect(html).toContain(product.image)
    }
    expect(html).toContain('$1,199.00')
    expect(html).toContain('Larkspur Supply is a demo store · PayPal sandbox · nothing ships')
    expect(html).toContain('<p class="lk-catalog__count">6 products</p>')
    expect(html).toContain('<span class="lk-card__no">No. 02</span>')
    expect(html).toContain('<title>Larkspur Supply</title>')
  })

  it('keeps ?replay=video on catalog links', async () => {
    const { app } = setup()
    const html = (await request(app).get('/?replay=video')).text
    expect(html).toContain('href="/p/camera?replay=video"')
  })

  it('renders a product page with PayPal’s button and message, and the Worth mount point', async () => {
    const { app } = setup()
    const res = await request(app).get('/p/camera').expect(200)
    expect(res.headers['set-cookie']?.[0]).toMatch(
      /^lk_session=[A-Za-z0-9_-]{43}; .*HttpOnly; SameSite=Lax/,
    )
    const html = res.text
    expect(html).toContain('<h1 class="lk-product__name">Everyday camera</h1>')
    expect(html).toContain('<p class="lk-product__price">$1,199.00</p>')
    // PayPal's own button, wrapped by the real <worth-check> in swipe mode, which docks Worth's tab
    // beside it; a plain same-tab link inside stays for no-JavaScript visits.
    expect(html).toMatch(
      /<worth-check mode="swipe" href="https:\/\/worth\.example\/check#q=[^"]+" merchant="Larkspur Supply" amount="1199\.00" refresh-url="\/api\/worth-quote\?productId=camera"><paypal-button class="lk-buy__button" type="pay" hidden><\/paypal-button><a class="worth-check" slot="fallback" href="https:\/\/worth\.example\/check#q=[^"]+">Analyse with Worth<\/a><\/worth-check>/,
    )
    // One Worth control: the separate outline link under PayPal is gone.
    expect(html.match(/<worth-check /g)).toHaveLength(1)
    expect(html).not.toContain('lk-buy__worth"')
    expect(html).toContain(
      '<paypal-message auto-bootstrap="true" amount="1199.00" currency-code="USD"',
    )
    expect(html).toContain('data-client-id="public-client-id"')
    expect(html).toContain('<script type="module" src="/assets/worth-check.js"></script>')
    expect((await request(app).get('/')).text).not.toContain('worth-check.js')
    expect(html).not.toContain('lk-buy__worth-result')
    // The spec sheet: stock number, breadcrumb, facts and four other products.
    expect(html).toContain('<span class="lk-product__no">No. 02</span>Cameras')
    expect(html).toContain('<span class="lk-product__crumb">Cameras</span>')
    expect(html).toContain('<dt>Payment</dt><dd>PayPal sandbox</dd>')
    const more = html.slice(html.indexOf('class="lk-more"'))
    expect(more.match(/class="lk-card"/g)).toHaveLength(4)
    expect(more).not.toContain('href="/p/camera"')
  })

  it('says when PayPal is not configured and 404s an unknown product', async () => {
    const { app } = setup({ paypal: null })
    const off = createMerchantApp({ env: {}, config: { origin: ORIGIN, handoffSecret: SECRET } })
    expect((await request(off).get('/p/camera')).text).toContain('PayPal sandbox is not configured')
    await request(app).get('/p/nope').expect(404)
    await request(app).get('/p/..%2Fetc').expect(404)
  })
})

describe('quotes for Worth', () => {
  it('signs the store’s own catalog price into the quote at render', async () => {
    const { app, worth } = setup()
    const token = quoteToken((await request(app).get('/p/camera')).text)
    const quote = worth.open('quote', token)
    expect(quote).toMatchObject({
      v: 1,
      kid: '1',
      mid: 'larkspur',
      item: 'Everyday camera',
      productId: 'camera',
      amountCents: 119900,
      currency: 'USD',
      merchant: 'Larkspur Supply',
      returnUrl: `${ORIGIN}/p/camera`,
      imageUrl: `${ORIGIN}/images/camera.jpg`,
      iat: T0,
      exp: T0 + 900,
    })
    expect(quote!.qid).toMatch(/^q_[A-Za-z0-9_-]{22}$/)
    expect(quote).not.toHaveProperty('replay')
    expect(quote).not.toHaveProperty('payLater')
  })

  it('carries replay into the quote and its return URL', async () => {
    const { app, worth } = setup()
    const token = quoteToken((await request(app).get('/p/camera?replay=video')).text)
    expect(worth.open('quote', token)).toMatchObject({
      replay: 'video',
      returnUrl: `${ORIGIN}/p/camera?replay=video`,
    })
    // A refreshed link keeps the replay too.
    expect((await request(app).get('/p/camera?replay=video')).text).toContain(
      'refresh-url="/api/worth-quote?productId=camera&amp;replay=video"',
    )
  })

  it('mints a fresh quote on request, with the store SDK’s Pay Later answer', async () => {
    const { app, worth, tick } = setup()
    tick(600)
    const res = await request(app)
      .get('/api/worth-quote?productId=headphones&payLater=true')
      .expect(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body.exp).toBe(T0 + 600 + 900)
    expect(res.body.href).toBe(`${WORTH}/check#q=${res.body.token}`)
    expect(worth.open('quote', res.body.token)).toMatchObject({
      productId: 'headphones',
      amountCents: 34900,
      payLater: { eligible: true, source: 'merchant-sdk' },
    })
    // Only a yes is signed; a no reads as unknown and leaves payLater out (contract §3.2).
    const no = await request(app).get('/api/worth-quote?productId=headphones&payLater=false')
    expect(no.status).toBe(200)
    expect(worth.open('quote', no.body.token)).not.toHaveProperty('payLater')
    await request(app).get('/api/worth-quote?productId=nope').expect(404)
    await request(app).get('/api/worth-quote?productId=camera&payLater=maybe').expect(400)
  })

  it('expires: a quote is not valid 15 minutes and a minute later', async () => {
    const { app, worth, tick } = setup()
    const token = quoteToken((await request(app).get('/p/camera')).text)
    tick(961)
    expect(worth.open('quote', token)).toBeUndefined()
  })
})

describe('Worth’s result beside the PayPal button', () => {
  async function visit(t: ReturnType<typeof setup>, productId = 'camera') {
    const agent = request.agent(t.app)
    const token = quoteToken((await agent.get(`/p/${productId}`)).text)
    const qid = t.worth.open('quote', token)!.qid as string
    return { agent, qid }
  }
  const result = (qid: string, extra: Record<string, unknown> = {}) => ({
    v: 1,
    kid: '1',
    mid: 'larkspur',
    qid,
    verdict: 'wait',
    fitsOn: '2026-10-23',
    iat: T0,
    exp: T0 + 900,
    ...extra,
  })

  it('shows one line for a valid result for this shopper’s quote', async () => {
    const t = setup()
    const { agent, qid } = await visit(t)
    const wait = await agent.get(`/p/camera?worth=${t.worth.sign('result', result(qid))}`)
    expect(wait.text).toContain('<p class="lk-buy__worth-result">Worth: fits on Fri, Oct 23</p>')
    expect(wait.text.match(/lk-buy__worth-result/g)).toHaveLength(1)
    const today = t.worth.sign('result', result(qid, { verdict: 'buy_today', fitsOn: undefined }))
    expect((await agent.get(`/p/camera?worth=${today}`)).text).toContain('Worth: fits today')
    // The price and the quote are the store's own either way.
    expect(wait.text).toContain('<p class="lk-product__price">$1,199.00</p>')
  })

  it('shows nothing for an invalid, expired, foreign or other-product result', async () => {
    const t = setup()
    const { agent, qid } = await visit(t)
    const cases = [
      `${t.worth.sign('result', result(qid)).slice(0, -3)}abc`,
      t.worth.sign('quote', result(qid)),
      t.worth.sign('result', result('q_BBBBBBBBBBBBBBBBBBBBBB')),
      t.worth.sign('result', result(qid, { iat: T0 - 2000, exp: T0 - 1100 })),
      'garbage',
    ]
    for (const token of cases)
      expect((await agent.get(`/p/camera?worth=${token}`)).text).not.toContain(
        'lk-buy__worth-result',
      )
    // A shopper holding another quote for the product ignores it, and it never applies to another
    // product.
    const valid = t.worth.sign('result', result(qid))
    const other = request.agent(t.app)
    await other.get('/p/camera')
    expect((await other.get(`/p/camera?worth=${valid}`)).text).not.toContain('Worth:')
    expect((await agent.get(`/p/chair?worth=${valid}`)).text).not.toContain('Worth:')
    // ...nor is it pinned to that other product's order.
    await agent.post('/api/orders').set(json).send({ productId: 'chair' }).expect(201)
    expect(t.created[0]!.qid).not.toBe(qid)
  })

  it('adopts a verified result’s qid when the shopper’s session is new (a restarted store)', async () => {
    const t = setup()
    const { qid } = await visit(t)
    const fresh = request.agent(t.app)
    const page = await fresh.get(`/p/camera?worth=${t.worth.sign('result', result(qid))}`)
    expect(page.text).toContain('Worth: fits on Fri, Oct 23')
    expect(t.worth.open('quote', quoteToken(page.text))!.qid).toBe(qid)
  })
})

describe('one quote ID per shopper and product', () => {
  it('re-signs the same qid with a fresh iat and exp on every render and refresh', async () => {
    const t = setup()
    const agent = request.agent(t.app)
    const first = t.worth.open('quote', quoteToken((await agent.get('/p/camera')).text))!
    t.tick(300)
    const again = t.worth.open('quote', quoteToken((await agent.get('/p/camera')).text))!
    expect(again.qid).toBe(first.qid)
    expect(again.iat).toBe(T0 + 300)
    expect(again.exp).toBe(T0 + 1200)
    t.tick(300)
    const refreshed = await agent.get('/api/worth-quote?productId=camera').expect(200)
    expect(t.worth.open('quote', refreshed.body.token)).toMatchObject({
      qid: first.qid,
      iat: T0 + 600,
    })
    // Another product, and another shopper, get their own.
    const chair = t.worth.open('quote', quoteToken((await agent.get('/p/chair')).text))!
    expect(chair.qid).not.toBe(first.qid)
    const other = t.worth.open('quote', quoteToken((await request(t.app).get('/p/camera')).text))!
    expect(other.qid).not.toBe(first.qid)
  })

  it('orders and reports back with the qid Worth opened, after the shopper comes back', async () => {
    const t = setup()
    const agent = request.agent(t.app)
    // The store's page links to Worth with qid A; Worth opens it and sends the shopper back.
    const opened = t.worth.open('quote', quoteToken((await agent.get('/p/camera')).text))!.qid
    t.tick(120)
    const back = await agent.get(
      `/p/camera?worth=${t.worth.sign('result', {
        v: 1,
        kid: '1',
        mid: 'larkspur',
        qid: opened,
        verdict: 'buy_today',
        iat: T0 + 120,
        exp: T0 + 1020,
      })}`,
    )
    expect(back.text).toContain('Worth: fits today')
    await agent.post('/api/orders').set(json).send({ productId: 'camera' }).expect(201)
    expect(t.created[0]!.qid).toBe(opened)
    expect(t.created[0]!.id.startsWith(`${opened}.`)).toBe(true)
    await agent.post('/api/orders/ORDER1/capture').set(json).send({}).expect(200)
    await t.app.locals.lastReport
    expect(JSON.parse(String(t.reports[0]!.init.body)).qid).toBe(opened)
  })
})

describe('anti-forwarding (contract §5)', () => {
  it('never reports a quote the session minted but never brought back from Worth', async () => {
    const t = setup()
    const agent = request.agent(t.app)
    await agent.get('/p/camera')
    await agent.post('/api/orders').set(json).send({ productId: 'camera' }).expect(201)
    // No quote travels with the order: its reference is the store's own.
    expect(t.created[0]!.qid).toBeUndefined()
    expect(t.created[0]!.id).toMatch(/^lk_/)
    await agent.post('/api/orders/ORDER1/capture').set(json).send({}).expect(200)
    expect(t.app.locals.lastReport).toBeUndefined()
    const webhook = await request(t.app)
      .post('/api/paypal/webhook')
      .set('Content-Type', 'application/json')
      .send(
        JSON.stringify({
          id: 'WH-1',
          event_type: 'PAYMENT.CAPTURE.COMPLETED',
          resource: { id: 'CAP1', supplementary_data: { related_ids: { order_id: 'ORDER1' } } },
        }),
      )
    expect(webhook.body).toEqual({ received: true, ignored: true })
    expect(t.reports).toHaveLength(0)
  })

  it('reports a forwarded quote only for the shopper who came back with it, never its minter', async () => {
    const t = setup()
    // The minter's session holds the quote and forwards the Worth link.
    const minter = request.agent(t.app)
    const qid = t.worth.open('quote', quoteToken((await minter.get('/p/camera')).text))!.qid
    // Someone else opens it in Worth and comes back with a verified result.
    const shopper = request.agent(t.app)
    const result = t.worth.sign('result', {
      v: 1,
      kid: '1',
      mid: 'larkspur',
      qid,
      verdict: 'wait',
      fitsOn: '2026-10-23',
      iat: T0,
      exp: T0 + 900,
    })
    await shopper.get(`/p/camera?worth=${result}`)
    // The minter's purchase carries no quote and reports nothing.
    await minter.post('/api/orders').set(json).send({ productId: 'camera' }).expect(201)
    expect(t.created[0]!.qid).toBeUndefined()
    await minter.post('/api/orders/ORDER1/capture').set(json).send({}).expect(200)
    expect(t.reports).toHaveLength(0)
    // The shopper who came back is the one whose purchase reports the quote.
    await shopper.post('/api/orders').set(json).send({ productId: 'camera' }).expect(201)
    expect(t.created[1]!.qid).toBe(qid)
  })

  it('needs the result for this product’s quote, verified, not any result', async () => {
    const t = setup()
    const agent = request.agent(t.app)
    const qid = t.worth.open('quote', quoteToken((await agent.get('/p/camera')).text))!.qid
    const forged = `${t.worth.sign('result', { v: 1, kid: '1', mid: 'larkspur', qid, verdict: 'buy_today', iat: T0, exp: T0 + 900 }).slice(0, -2)}AA`
    await agent.get(`/p/camera?worth=${forged}`)
    const valid = t.worth.sign('result', {
      v: 1,
      kid: '1',
      mid: 'larkspur',
      qid,
      verdict: 'buy_today',
      iat: T0,
      exp: T0 + 900,
    })
    // A camera result shown on the chair page doesn't count for the camera.
    await agent.get(`/p/chair?worth=${valid}`)
    await agent.post('/api/orders').set(json).send({ productId: 'camera' }).expect(201)
    expect(t.created[0]!.qid).toBeUndefined()
  })
})

describe('PayPal orders on the store', () => {
  it('creates the order at the catalog price with the quote’s reference', async () => {
    const t = setup()
    const agent = request.agent(t.app)
    const qid = await cameBack(t, agent)
    const res = await agent.post('/api/orders').set(json).send({ productId: 'camera' }).expect(201)
    expect(res.body).toEqual({ orderId: 'ORDER1' })
    expect(t.created[0]).toMatchObject({
      productId: 'camera',
      name: 'Everyday camera',
      amountCents: 119900,
      qid,
    })
    expect(t.created[0]!.id).toMatch(new RegExp(`^${qid}\\.[A-Za-z0-9_-]{8}$`))
  })

  it('never takes a price from the browser and refuses unknown products', async () => {
    const t = setup()
    await request(t.app)
      .post('/api/orders')
      .set(json)
      .send({ productId: 'camera', amountCents: 100 })
      .expect(400)
    await request(t.app).post('/api/orders').set(json).send({ productId: 'nope' }).expect(400)
    expect(t.paypal.create).not.toHaveBeenCalled()
  })

  it('refuses cross-origin and non-JSON writes', async () => {
    const t = setup()
    await request(t.app)
      .post('/api/orders')
      .set({ ...json, Origin: 'https://evil.example' })
      .send({ productId: 'camera' })
      .expect(403)
    await request(t.app)
      .post('/api/orders')
      .set({ ...json, 'Sec-Fetch-Site': 'cross-site' })
      .send({ productId: 'camera' })
      .expect(403)
    await request(t.app)
      .post('/api/orders')
      .set({ Origin: ORIGIN, 'Content-Type': 'text/plain' })
      .send('productId=camera')
      .expect(415)
  })

  it('captures, answers COMPLETED, and reports back to Worth without waiting', async () => {
    const t = setup()
    const agent = request.agent(t.app)
    const qid = await cameBack(t, agent)
    await agent.post('/api/orders').set(json).send({ productId: 'camera' }).expect(201)
    const res = await agent.post('/api/orders/ORDER1/capture').set(json).send({}).expect(200)
    expect(res.body).toEqual({ status: 'COMPLETED', orderId: 'ORDER1' })
    expect(t.paypal.capture).toHaveBeenCalledWith('ORDER1', `capture-${t.created[0]!.id}`)
    await t.app.locals.lastReport
    expect(t.reports).toHaveLength(1)
    expect(t.reports[0]!.url).toBe(`${WORTH}/api/handoff/outcome`)
    expect(JSON.parse(String(t.reports[0]!.init.body))).toEqual({
      v: 1,
      kid: '1',
      mid: 'larkspur',
      qid,
      orderId: 'ORDER1',
      captureId: 'CAP1',
      amountCents: 119900,
      currency: 'USD',
      status: 'COMPLETED',
      capturedAt: '2026-10-23T15:04:05Z',
    })
  })

  it('completes checkout even when Worth is down', async () => {
    const t = setup({
      reportReplies: [503, 503, 503].map((status) => new Response('', { status })),
    })
    const agent = request.agent(t.app)
    await cameBack(t, agent)
    await agent.post('/api/orders').set(json).send({ productId: 'camera' })
    const res = await agent.post('/api/orders/ORDER1/capture').set(json).send({}).expect(200)
    expect(res.body.status).toBe('COMPLETED')
    expect(await t.app.locals.lastReport).toBe('failed')
    expect(t.reports).toHaveLength(3)
  })

  it('only captures an order this shopper started', async () => {
    const t = setup()
    const agent = request.agent(t.app)
    await agent.get('/p/camera')
    await agent.post('/api/orders').set(json).send({ productId: 'camera' })
    await request(t.app).post('/api/orders/ORDER1/capture').set(json).send({}).expect(404)
    await agent.post('/api/orders/OTHER/capture').set(json).send({}).expect(404)
    expect(t.paypal.capture).not.toHaveBeenCalled()
  })

  it('turns a decline into a clear message and other PayPal failures into a 502', async () => {
    const declined = setup({
      paypal: {
        capture: vi.fn(async () => {
          throw new PayPalError(422, 'INSTRUMENT_DECLINED')
        }),
      },
    })
    const agent = request.agent(declined.app)
    await agent.get('/p/camera')
    await agent.post('/api/orders').set(json).send({ productId: 'camera' })
    const res = await agent.post('/api/orders/ORDER1/capture').set(json).send({}).expect(422)
    expect(res.body.code).toBe('DECLINED')
    expect(declined.reports).toHaveLength(0)

    const down = setup({
      paypal: {
        create: vi.fn(async () => {
          throw new PayPalError(0, 'TIMEOUT')
        }),
      },
    })
    const failed = await request(down.app)
      .post('/api/orders')
      .set(json)
      .send({ productId: 'camera' })
    expect(failed.status).toBe(502)
    expect(failed.body.code).toBe('PAYPAL_UNAVAILABLE')
  })

  it('rejects an order whose amount does not match the catalog', async () => {
    const t = setup({
      paypal: {
        create: vi.fn(async (source: { id: string }) => ({
          id: 'ORDER1',
          status: 'CREATED',
          purchase_units: [
            {
              reference_id: source.id,
              custom_id: source.id,
              amount: { currency_code: 'USD', value: '1.00' },
              payee: { merchant_id: 'M' },
            },
          ],
        })),
      },
    })
    const res = await request(t.app).post('/api/orders').set(json).send({ productId: 'camera' })
    expect(res.status).toBe(500)
  })
})

describe('store webhook', () => {
  const event = (type = 'PAYMENT.CAPTURE.COMPLETED', id = 'WH-1') =>
    JSON.stringify({
      id,
      event_type: type,
      resource: { id: 'CAP1', supplementary_data: { related_ids: { order_id: 'ORDER1' } } },
    })

  it('refuses unverified deliveries', async () => {
    const t = setup({ paypal: { verify: vi.fn(async () => false) } })
    await request(t.app)
      .post('/api/paypal/webhook')
      .set('Content-Type', 'application/json')
      .send(event())
      .expect(401)
  })

  it('reports a verified capture once, re-reading the order from PayPal', async () => {
    const t = setup()
    const agent = request.agent(t.app)
    const qid = await cameBack(t, agent)
    await agent.post('/api/orders').set(json).send({ productId: 'camera' })
    const res = await request(t.app)
      .post('/api/paypal/webhook')
      .set('Content-Type', 'application/json')
      .send(event())
      .expect(200)
    expect(res.body).toEqual({ received: true })
    expect(t.paypal.verify).toHaveBeenCalledWith(expect.any(Object), event())
    expect(t.paypal.get).toHaveBeenCalledWith('ORDER1')
    await t.app.locals.lastReport
    expect(JSON.parse(String(t.reports[0]!.init.body))).toMatchObject({ qid, captureId: 'CAP1' })
    // The same event again, and the capture path after a sent report, send nothing more.
    const again = await request(t.app)
      .post('/api/paypal/webhook')
      .set('Content-Type', 'application/json')
      .send(event())
    expect(again.body).toEqual({ received: true, duplicate: true })
    await request(t.app)
      .post('/api/paypal/webhook')
      .set('Content-Type', 'application/json')
      .send(event('PAYMENT.CAPTURE.COMPLETED', 'WH-2'))
    expect(t.reports).toHaveLength(1)
  })

  it('sends one report when the capture path and the webhook overlap, and resends after a failure', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const t = setup({
      reportReplies: [
        gate.then(() => new Response('', { status: 400 })),
        Response.json({ recorded: true }),
      ],
    })
    const agent = request.agent(t.app)
    await cameBack(t, agent)
    await agent.post('/api/orders').set(json).send({ productId: 'camera' })
    // The capture's report is in flight while the webhook arrives.
    const slow = t.app.locals as { lastReport?: Promise<unknown> }
    await agent.post('/api/orders/ORDER1/capture').set(json).send({}).expect(200)
    const inFlight = slow.lastReport
    await request(t.app)
      .post('/api/paypal/webhook')
      .set('Content-Type', 'application/json')
      .send(event('PAYMENT.CAPTURE.COMPLETED', 'WH-A'))
      .expect(200)
    release()
    // Worth rejected the first report (400), so it is not counted as sent.
    expect(await inFlight).toBe('rejected')
    expect(t.reports).toHaveLength(1)
    // A later delivery may try again.
    await request(t.app)
      .post('/api/paypal/webhook')
      .set('Content-Type', 'application/json')
      .send(event('PAYMENT.CAPTURE.COMPLETED', 'WH-B'))
    expect(await t.app.locals.lastReport).toBe('sent')
    expect(t.reports).toHaveLength(2)
  })

  it('handles a redelivery when the order re-read failed the first time', async () => {
    const t = setup()
    const agent = request.agent(t.app)
    await cameBack(t, agent)
    await agent.post('/api/orders').set(json).send({ productId: 'camera' })
    const get = vi.mocked(t.paypal.get)
    const real = get.getMockImplementation()!
    get.mockImplementationOnce(async () => {
      throw new PayPalError(503, 'SERVICE_UNAVAILABLE')
    })
    await request(t.app)
      .post('/api/paypal/webhook')
      .set('Content-Type', 'application/json')
      .send(event())
      .expect(502)
    get.mockImplementation(real)
    const retry = await request(t.app)
      .post('/api/paypal/webhook')
      .set('Content-Type', 'application/json')
      .send(event())
      .expect(200)
    expect(retry.body).toEqual({ received: true })
    await t.app.locals.lastReport
    expect(t.reports).toHaveLength(1)
  })

  it('ignores other events and orders that are not the store’s', async () => {
    const t = setup({
      paypal: {
        get: vi.fn(async () => ({
          id: 'ORDER1',
          status: 'COMPLETED',
          purchase_units: [
            {
              reference_id: 'p-1',
              custom_id: 'p-1',
              amount: { currency_code: 'USD', value: '1.00' },
            },
          ],
        })),
      },
    })
    const other = await request(t.app)
      .post('/api/paypal/webhook')
      .set('Content-Type', 'application/json')
      .send(event('CHECKOUT.ORDER.APPROVED'))
    expect(other.body).toEqual({ received: true, ignored: true })
    const foreign = await request(t.app)
      .post('/api/paypal/webhook')
      .set('Content-Type', 'application/json')
      .send(event('PAYMENT.CAPTURE.COMPLETED', 'WH-3'))
    expect(foreign.body).toEqual({ received: true, ignored: true })
    expect(t.reports).toHaveLength(0)
  })
})

describe('store design assets', () => {
  it('serves the stylesheet and its self-hosted fonts from the store’s own origin', async () => {
    const { app } = setup()
    const css = await request(app).get('/static/store.css').expect(200)
    const fonts = [...css.text.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]!)
    expect(fonts).toHaveLength(5)
    for (const font of fonts) {
      expect(font).toMatch(/^fonts\/[a-z0-9-]+\.woff2$/)
      const file = await request(app).get(`/static/${font}`).expect(200)
      expect(file.body.subarray(0, 4).toString()).toBe('wOF2')
    }
    // Colours of the Worth control belong to its component, never the store.
    expect(css.text).not.toMatch(/\.worth-check\s*[{,]/)
  })
})
