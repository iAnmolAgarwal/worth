import { describe, expect, it, vi } from 'vitest'
import { createPayPalGateway, PayPalError } from '../server/paypal.ts'
import type { StoredPurchase } from '../server/store.ts'

// Contract tests for the real Orders v2 gateway, with fetch mocked at the network boundary.

const BASE = 'https://api-m.sandbox.paypal.com'
type Reply = Response | Error | ((url: string, init: RequestInit) => Response | Promise<Response>)

function gateway(replies: Reply[], options: { webhookId?: string } = {}) {
  const calls: { url: string; init: RequestInit; headers: Record<string, string> }[] = []
  const log = vi.fn()
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
  })
  const api = () => calls.filter((call) => !call.url.endsWith('/v1/oauth2/token'))
  return { paypal, calls, api, log, fetch }
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
    const html = new Response('<html>Bad gateway</html>', {
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
    const { paypal, log } = gateway([html, slow, new TypeError('fetch failed')])
    await expect(paypal.get('ORDER1')).rejects.toMatchObject({
      status: 502,
      issue: 'INVALID_RESPONSE',
      debugId: 'debug-html',
    })
    await expect(paypal.get('ORDER1')).rejects.toMatchObject({ status: 0, issue: 'TIMEOUT' })
    await expect(paypal.get('ORDER1')).rejects.toMatchObject({ status: 0, issue: 'NETWORK_ERROR' })
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
