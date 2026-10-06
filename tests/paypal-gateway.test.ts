import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPayPalGateway, PayPalError, retryDelay } from '../server/paypal.ts'
import type { StoredPurchase } from '../server/store.ts'

// Contract tests for the real Orders v2 gateway, with fetch mocked at the network boundary.

const BASE = 'https://api-m.sandbox.paypal.com'
type Reply = Response | Error | ((url: string, init: RequestInit) => Response | Promise<Response>)

function gateway(replies: Reply[], options: { webhookId?: string } = {}) {
  const calls: { url: string; init: RequestInit; headers: Record<string, string> }[] = []
  const log = vi.fn()
  // Retries wait through this instead of a timer, so the tests stay fast.
  const sleep = vi.fn(async (_ms: number) => {})
  const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const href = String(url)
    calls.push({ url: href, init, headers: { ...(init.headers as Record<string, string>) } })
    if (href.endsWith('/v1/oauth2/token'))
      return Response.json({ access_token: `token-${calls.length}`, expires_in: 3600 })
    const next = replies.shift()
    if (!next) throw new Error(`Unexpected call to ${href}`)
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next(href, init) : next
  })
  const paypal = createPayPalGateway({
    clientId: 'client',
    secret: 'secret',
    origin: 'https://worth.example.com',
    webhookId: options.webhookId,
    fetch: fetch as unknown as typeof globalThis.fetch,
    log,
    timeoutMs: 50,
    sleep,
  })
  const api = () => calls.filter((call) => !call.url.endsWith('/v1/oauth2/token'))
  return { paypal, calls, api, log, fetch, sleep }
}
const purchase = {
  id: 'p-1',
  productId: 'headphones',
  name: 'Studio headphones',
  amountCents: 34900,
  currency: 'USD',
  mode: 'sandbox',
  status: 'created',
  createdAt: '2026-10-03T12:00:00Z',
  profileVersion: 1,
  assessmentDate: '2026-10-03',
  acknowledgedShortfall: false,
} as StoredPurchase
const order = { id: 'ORDER1', status: 'PAYER_ACTION_REQUIRED' }
const declined = () =>
  Response.json(
    {
      name: 'UNPROCESSABLE_ENTITY',
      details: [{ issue: 'INSTRUMENT_DECLINED' }],
      debug_id: 'debug-422',
      links: [{ rel: 'redirect', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1' }],
    },
    { status: 422 },
  )

describe('PayPal Orders v2 gateway contract', () => {
  it('creates an order with items, a breakdown, an invoice ID and idempotency headers', async () => {
    const { paypal, api } = gateway([Response.json(order, { status: 201 })])
    await paypal.create(purchase)
    const [call] = api()
    expect(call!.url).toBe(`${BASE}/v2/checkout/orders`)
    expect(call!.headers).toMatchObject({
      Authorization: 'Bearer token-1',
      'PayPal-Request-Id': 'create-p-1',
      Prefer: 'return=representation',
    })
    const body = JSON.parse(String(call!.init.body))
    expect(body.intent).toBe('CAPTURE')
    expect(body.purchase_units[0]).toMatchObject({
      reference_id: 'p-1',
      custom_id: 'p-1',
      invoice_id: 'p-1',
      amount: {
        currency_code: 'USD',
        value: '349.00',
        breakdown: { item_total: { currency_code: 'USD', value: '349.00' } },
      },
      items: [
        {
          name: 'Studio headphones',
          sku: 'headphones',
          quantity: '1',
          unit_amount: { currency_code: 'USD', value: '349.00' },
        },
      ],
    })
    expect(body.payment_source.paypal.experience_context).toMatchObject({
      shipping_preference: 'NO_SHIPPING',
      user_action: 'CONTINUE',
      return_url: 'https://worth.example.com/api/checkout/p-1/return?paypal=approved',
      cancel_url: 'https://worth.example.com/api/checkout/p-1/return?paypal=cancelled',
    })
  })
  it('caches the OAuth token and refreshes it once after a 401', async () => {
    const { paypal, calls } = gateway([
      Response.json(order),
      Response.json({ name: 'AUTHENTICATION_FAILURE' }, { status: 401 }),
      Response.json(order),
    ])
    await paypal.get('ORDER1')
    expect((await paypal.get('ORDER1')).id).toBe('ORDER1')
    const tokens = calls.filter((call) => call.url.endsWith('/v1/oauth2/token'))
    expect(tokens).toHaveLength(2)
    expect(calls.at(-1)!.headers.Authorization).toBe(`Bearer token-${calls.length - 1}`)
  })
  it('gives up after one refresh when PayPal keeps answering 401', async () => {
    const unauthorized = () => Response.json({ name: 'AUTHENTICATION_FAILURE' }, { status: 401 })
    const { paypal, api } = gateway([unauthorized(), unauthorized()])
    await expect(paypal.get('ORDER1')).rejects.toMatchObject({ status: 401 })
    expect(api()).toHaveLength(2)
  })
  it('turns a decline into an issue code with its links and logs the debug ID', async () => {
    const { paypal, log } = gateway([declined()])
    const error = await paypal.capture('ORDER1', 'capture-p-1').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PayPalError)
    expect(error).toMatchObject({
      status: 422,
      issue: 'INSTRUMENT_DECLINED',
      debugId: 'debug-422',
      links: [{ rel: 'redirect' }],
    })
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'paypal_error', status: 422, debugId: 'debug-422' }),
    )
  })
  it('normalizes non-JSON, timeout and network failures into PayPalError', async () => {
    const html = () =>
      new Response('<html>Bad gateway</html>', {
        status: 502,
        headers: { 'paypal-debug-id': 'debug-html' },
      })
    const slow = () =>
      new Promise<Response>((_resolve, reject) =>
        setTimeout(
          () => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })),
          5,
        ),
      )
    const failed = () => new TypeError('fetch failed')
    const { paypal, api, log } = gateway([
      ...[html(), html(), html()],
      slow,
      ...[failed(), failed(), failed()],
    ])
    await expect(paypal.get('ORDER1')).rejects.toMatchObject({
      status: 502,
      issue: 'INVALID_RESPONSE',
      debugId: 'debug-html',
    })
    // An eligibility check is a POST without a request ID, so a timeout is not sent again.
    await expect(paypal.eligibility(119900)).rejects.toMatchObject({ status: 0, issue: 'TIMEOUT' })
    expect(api()).toHaveLength(4)
    await expect(paypal.get('ORDER1')).rejects.toMatchObject({ status: 0, issue: 'NETWORK_ERROR' })
    expect(api()).toHaveLength(7)
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret')
  })
  it('rejects a 200 response that is not JSON', async () => {
    const { paypal } = gateway([new Response('not json', { status: 200 })])
    await expect(paypal.get('ORDER1')).rejects.toMatchObject({ issue: 'INVALID_RESPONSE' })
  })
  it('captures with the given request ID and sends the decline mock only on request', async () => {
    const { paypal, api } = gateway([Response.json(order), Response.json(order)])
    await paypal.capture('ORDER1', 'capture-p-1')
    await paypal.capture('ORDER1', 'capture-p-1-1', { mockDecline: true })
    const [plain, mocked] = api()
    expect(plain!.url).toBe(`${BASE}/v2/checkout/orders/ORDER1/capture`)
    expect(plain!.headers['PayPal-Request-Id']).toBe('capture-p-1')
    expect(plain!.headers['PayPal-Mock-Response']).toBeUndefined()
    expect(mocked!.headers['PayPal-Request-Id']).toBe('capture-p-1-1')
    expect(JSON.parse(mocked!.headers['PayPal-Mock-Response']!)).toEqual({
      mock_application_codes: 'INSTRUMENT_DECLINED',
    })
  })
  it('reads Pay Later eligibility from find-eligible-methods', async () => {
    const { paypal, api } = gateway([
      Response.json({
        eligible_methods: {
          paypal: {},
          paypal_pay_later: { country_code: 'US', product_code: 'PAYLATER' },
        },
      }),
      Response.json({ eligible_methods: { paypal: {} } }),
    ])
    expect(await paypal.eligibility(119900)).toEqual({
      payLater: true,
      productCode: 'PAYLATER',
      countryCode: 'US',
    })
    expect(await paypal.eligibility(119900)).toEqual({ payLater: false })
    expect(api()[0]!.url).toBe(`${BASE}/v2/payments/find-eligible-methods`)
    expect(JSON.parse(String(api()[0]!.init.body))).toEqual({
      customer: { country_code: 'US' },
      purchase_units: [{ amount: { currency_code: 'USD', value: '1199.00' } }],
      preferences: { payment_flow: 'ONE_TIME_PAYMENT' },
    })
  })
  it('reads a refund by ID', async () => {
    const { paypal, api } = gateway([
      Response.json({
        id: 'R1',
        status: 'COMPLETED',
        amount: { currency_code: 'USD', value: '1.00' },
      }),
    ])
    expect((await paypal.getRefund('R1')).id).toBe('R1')
    expect(api()[0]!.url).toBe(`${BASE}/v2/payments/refunds/R1`)
  })
})

describe('retries after a rate limit or server error', () => {
  const unavailable = (status: number, debugId: string, headers: Record<string, string> = {}) =>
    Response.json(
      { name: 'SERVICE_UNAVAILABLE', debug_id: debugId },
      { status, headers: { 'paypal-debug-id': debugId, ...headers } },
    )

  it('succeeds when a 429 is followed by a 200, waiting as long as Retry-After asks', async () => {
    const { paypal, api, sleep } = gateway([
      unavailable(429, 'debug-429', { 'retry-after': '1' }),
      Response.json(order),
    ])
    expect((await paypal.get('ORDER1')).id).toBe('ORDER1')
    expect(api()).toHaveLength(2)
    expect(sleep.mock.calls).toEqual([[1000]])
  })

  it('gives up after 2 retries when PayPal keeps answering 503', async () => {
    const { paypal, api, log, sleep } = gateway([
      unavailable(503, 'debug-1'),
      unavailable(503, 'debug-2'),
      unavailable(503, 'debug-3'),
    ])
    await expect(paypal.capture('ORDER1', 'capture-p-1')).rejects.toMatchObject({
      status: 503,
      issue: 'SERVICE_UNAVAILABLE',
      debugId: 'debug-3',
    })
    expect(api()).toHaveLength(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    // Each retry is logged with PayPal's debug ID, and never with a body or a token.
    const events = log.mock.calls.map(([event]) => event as Record<string, unknown>)
    expect(events.filter((e) => e.event === 'paypal_retry')).toEqual([
      expect.objectContaining({ status: 503, retry: 1, debugId: 'debug-1' }),
      expect.objectContaining({ status: 503, retry: 2, debugId: 'debug-2' }),
    ])
    expect(events.filter((e) => e.event === 'paypal_error')).toHaveLength(1)
    expect(JSON.stringify(events)).not.toMatch(/token-|secret|Bearer/)
  })

  it('sends the same PayPal-Request-Id and body on every retry of a write', async () => {
    const { paypal, api } = gateway([
      unavailable(500, 'debug-500'),
      unavailable(429, 'debug-429'),
      Response.json(order, { status: 201 }),
    ])
    await paypal.create(purchase)
    const sent = api()
    expect(sent).toHaveLength(3)
    expect(sent.map((call) => call.headers['PayPal-Request-Id'])).toEqual([
      'create-p-1',
      'create-p-1',
      'create-p-1',
    ])
    expect(new Set(sent.map((call) => String(call.init.body))).size).toBe(1)
  })

  it('does not retry a 400 or any other client error', async () => {
    const { paypal, api, sleep } = gateway([
      Response.json(
        { name: 'INVALID_REQUEST', details: [{ issue: 'MISSING_REQUIRED_PARAMETER' }] },
        { status: 400 },
      ),
      declined(),
      Response.json({ name: 'RESOURCE_NOT_FOUND' }, { status: 404 }),
    ])
    await expect(paypal.create(purchase)).rejects.toMatchObject({
      status: 400,
      issue: 'MISSING_REQUIRED_PARAMETER',
    })
    await expect(paypal.capture('ORDER1', 'capture-p-1')).rejects.toMatchObject({ status: 422 })
    await expect(paypal.get('ORDER1')).rejects.toMatchObject({ status: 404 })
    expect(api()).toHaveLength(3)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('still refreshes the token only once after a 401, alongside server-error retries', async () => {
    const unauthorized = () => Response.json({ name: 'AUTHENTICATION_FAILURE' }, { status: 401 })
    const { paypal, calls, api } = gateway([
      unauthorized(),
      unavailable(503, 'debug-503'),
      unauthorized(),
    ])
    await expect(paypal.capture('ORDER1', 'capture-p-1')).rejects.toMatchObject({ status: 401 })
    expect(api()).toHaveLength(3)
    expect(calls.filter((call) => call.url.endsWith('/v1/oauth2/token'))).toHaveLength(2)
    expect(api().map((call) => call.headers['PayPal-Request-Id'])).toEqual([
      'capture-p-1',
      'capture-p-1',
      'capture-p-1',
    ])
  })

  it('retries a timed-out capture under its request ID but never an unkeyed POST', async () => {
    const timeout = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const { paypal, api, sleep } = gateway([timeout(), Response.json(order), timeout()])
    expect((await paypal.capture('ORDER1', 'capture-p-1')).id).toBe('ORDER1')
    expect(api()).toHaveLength(2)
    await expect(paypal.eligibility(119900)).rejects.toMatchObject({ issue: 'TIMEOUT' })
    expect(api()).toHaveLength(3)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('backs off exponentially with jitter and caps every wait at 2 seconds', () => {
    expect(retryDelay(1, null, () => 0)).toBe(150)
    expect(retryDelay(1, null, () => 1)).toBe(300)
    expect(retryDelay(2, null, () => 0)).toBe(300)
    expect(retryDelay(2, null, () => 1)).toBe(600)
    expect(retryDelay(6, null, () => 1)).toBe(2000)
    expect(retryDelay(1, '0.5')).toBe(500)
    expect(retryDelay(1, '120')).toBe(2000)
    expect(retryDelay(1, new Date(Date.now() + 60_000).toUTCString())).toBe(2000)
    // An unreadable Retry-After falls back to the backoff.
    expect(retryDelay(1, 'soon', () => 1)).toBe(300)
  })

  it('never retries sooner than the backoff, whatever Retry-After says', () => {
    const past = new Date(Date.now() - 60_000).toUTCString()
    for (const retryAfter of ['0', '-5', past]) {
      expect(retryDelay(1, retryAfter, () => 0)).toBe(150)
      expect(retryDelay(2, retryAfter, () => 1)).toBe(600)
    }
  })

  it('does not retry Pay Later eligibility, which is advisory', async () => {
    const { paypal, api, sleep } = gateway([unavailable(503, 'debug-503'), Response.json({})])
    await expect(paypal.eligibility(119900)).rejects.toMatchObject({ status: 503 })
    expect(api()).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('treats a body that fails to arrive as a transport failure, never an empty success', async () => {
    const broken = () =>
      new Response(
        new ReadableStream({
          start: (controller) => controller.error(new TypeError('terminated')),
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      )
    const { paypal, api } = gateway([broken(), broken(), broken(), broken()])
    // A keyed capture is sent again under the same request ID, then reported as uncertain.
    await expect(paypal.capture('ORDER1', 'capture-p-1')).rejects.toMatchObject({
      status: 0,
      issue: 'NETWORK_ERROR',
    })
    expect(api()).toHaveLength(3)
    await expect(paypal.eligibility(119900)).rejects.toMatchObject({
      status: 0,
      issue: 'NETWORK_ERROR',
    })
    expect(api()).toHaveLength(4)
  })
})

describe('one deadline for each PayPal call', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * A gateway on fake timers with its own default timeouts and waits. `hang` paths never answer:
   * their request (or, for `hang-body`, only the body) fails when the gateway aborts it.
   */
  function slowPayPal(
    reply: (path: string) => Response | 'hang' | 'hang-body',
    config: { budgetMs?: number } = {},
  ) {
    vi.useFakeTimers()
    const sends: string[] = []
    const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      const path = String(url).slice(BASE.length)
      if (path === '/v1/oauth2/token')
        return Response.json({ access_token: 'token', expires_in: 3600 })
      sends.push(path)
      const signal = init.signal!
      const aborted = () => signal.reason as Error
      const answer = reply(path)
      if (answer === 'hang')
        return new Promise<Response>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(aborted())),
        )
      if (answer === 'hang-body')
        return new Response(
          new ReadableStream({
            start: (controller) =>
              signal.addEventListener('abort', () => controller.error(aborted())),
          }),
        )
      return answer
    })
    const paypal = createPayPalGateway({
      clientId: 'client',
      secret: 'secret',
      origin: 'https://worth.example.com',
      fetch: fetch as unknown as typeof globalThis.fetch,
      log: vi.fn(),
      ...config,
    })
    /** Runs one call to the end and reports how long it took on the fake clock. */
    async function timed<T>(call: () => Promise<T>) {
      const start = Date.now()
      const settled = call().then(
        (value) => ({ value, ms: Date.now() - start }),
        (error: unknown) => ({ error, ms: Date.now() - start }),
      )
      await vi.advanceTimersByTimeAsync(120_000)
      return settled
    }
    return { paypal, sends, timed }
  }

  it('ends a GET that PayPal never answers at the 20 s budget', async () => {
    const { paypal, sends, timed } = slowPayPal(() => 'hang')
    const result = await timed(() => paypal.get('ORDER1'))
    expect(result).toMatchObject({ error: { status: 0, issue: 'TIMEOUT' }, ms: 20_000 })
    // The first attempt used the whole budget, so no retry started.
    expect(sends).toHaveLength(1)
  })

  it('gives a retry only the time left in the budget', async () => {
    const { paypal, sends, timed } = slowPayPal(() => 'hang', { budgetMs: 25_000 })
    const result = await timed(() => paypal.capture('ORDER1', 'capture-p-1'))
    expect(result).toMatchObject({ error: { status: 0, issue: 'TIMEOUT' }, ms: 25_000 })
    expect(sends).toHaveLength(2)
  })

  it('starts no retry with less than 3 s of the budget left', async () => {
    const { paypal, sends, timed } = slowPayPal(
      () => Response.json({}, { status: 503, headers: { 'retry-after': '2' } }),
      { budgetMs: 5_000 },
    )
    const result = await timed(() => paypal.get('ORDER1'))
    // 0 s: 503, wait 2 s (3 s left after it). 2 s: 503, a second wait would leave 1 s, so stop.
    expect(result).toMatchObject({ error: { status: 503 }, ms: 2_000 })
    expect(sends).toHaveLength(2)
  })

  it('times out a body that never arrives instead of reading it as success', async () => {
    const { paypal, sends, timed } = slowPayPal(() => 'hang-body')
    const result = await timed(() => paypal.capture('ORDER1', 'capture-p-1'))
    expect(result).toMatchObject({ error: { status: 0, issue: 'TIMEOUT' }, ms: 20_000 })
    expect(sends).toHaveLength(1)
  })

  it('bounds the capture route (lookup, then capture) at 40 s, ending in a timeout', async () => {
    const { paypal, sends, timed } = slowPayPal(() => 'hang')
    const lookup = await timed(() => paypal.get('ORDER1'))
    const capture = await timed(() => paypal.capture('ORDER1', 'capture-p-1'))
    // A timeout is status 0, which the capture route records as PAYPAL_UNCERTAIN.
    expect(capture).toMatchObject({ error: { status: 0, issue: 'TIMEOUT' } })
    expect(lookup.ms + capture.ms).toBe(40_000)
    expect(sends).toEqual(['/v2/checkout/orders/ORDER1', '/v2/checkout/orders/ORDER1/capture'])
  })

  it('bounds a checkout start (eligibility, then the order) at 25 s', async () => {
    const { paypal, sends, timed } = slowPayPal(() => 'hang')
    const eligibility = await timed(() => paypal.eligibility(119900))
    const order = await timed(() => paypal.create(purchase))
    expect(eligibility).toMatchObject({ error: { issue: 'TIMEOUT' }, ms: 5_000 })
    expect(order).toMatchObject({ error: { status: 0, issue: 'TIMEOUT' }, ms: 20_000 })
    expect(sends).toHaveLength(2)
  })
})

describe('webhook verification', () => {
  const headers = {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
    'paypal-transmission-id': 'T1',
    'paypal-transmission-sig': 'SIG',
    'paypal-transmission-time': '2026-10-03T12:00:00Z',
  }
  // Key order and spacing as PayPal sent them; re-serializing would change the bytes.
  const raw =
    '{"id":"WH-1",  "resource":{"amount":{"value":"10.00"}},"event_type":"PAYMENT.CAPTURE.REFUNDED"}'

  it('posts the event back exactly as received', async () => {
    const { paypal, api } = gateway([Response.json({ verification_status: 'SUCCESS' })], {
      webhookId: 'WEBHOOK1',
    })
    expect(await paypal.verify(headers, raw)).toBe(true)
    const body = String(api()[0]!.init.body)
    expect(body.endsWith(`"webhook_event":${raw}}`)).toBe(true)
    expect(JSON.parse(body)).toMatchObject({
      webhook_id: 'WEBHOOK1',
      cert_url: headers['paypal-cert-url'],
    })
  })
  it('fails closed without a webhook ID, headers, a PayPal certificate host, or JSON', async () => {
    const unset = gateway([])
    expect(await unset.paypal.verify(headers, raw)).toBe(false)
    const { paypal, fetch } = gateway([], { webhookId: 'WEBHOOK1' })
    expect(
      await paypal.verify({ ...headers, 'paypal-cert-url': 'https://evil.example/cert' }, raw),
    ).toBe(false)
    expect(
      await paypal.verify({ ...headers, 'paypal-cert-url': 'http://api.paypal.com/cert' }, raw),
    ).toBe(false)
    const { 'paypal-transmission-sig': _sig, ...missing } = headers
    expect(await paypal.verify(missing, raw)).toBe(false)
    expect(await paypal.verify(headers, 'not json')).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    expect(unset.fetch).not.toHaveBeenCalled()
  })
  it('reports a failed verification', async () => {
    const { paypal } = gateway([Response.json({ verification_status: 'FAILURE' })], {
      webhookId: 'WEBHOOK1',
    })
    expect(await paypal.verify(headers, raw)).toBe(false)
  })
})
