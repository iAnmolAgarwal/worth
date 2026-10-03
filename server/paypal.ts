import type { IncomingHttpHeaders } from 'node:http'
import type { StoredPurchase } from './store.ts'

export interface PayPalAmount {
  currency_code: string
  value: string
}
export interface PayPalLink {
  rel: string
  href: string
  method?: string
}
export interface PayPalCapture {
  id: string
  status: string
  amount: PayPalAmount
  create_time?: string
}
export interface PayPalOrder {
  id: string
  status: string
  purchase_units?: {
    reference_id?: string
    custom_id?: string
    invoice_id?: string
    amount: PayPalAmount
    payee?: { merchant_id?: string }
    payments?: { captures?: PayPalCapture[] }
  }[]
  links?: PayPalLink[]
}
/** A refund as PayPal reports it; `links[rel=up]` points to the refunded capture. */
export interface PayPalRefund {
  id: string
  status: string
  amount: PayPalAmount
  links?: PayPalLink[]
}
/** What PayPal's server-side eligibility check says about Pay Later for one amount. */
export interface PayLaterEligibility {
  /** True when `paypal_pay_later` was among the eligible methods. */
  payLater: boolean
  productCode?: string
  countryCode?: string
}
export interface CaptureOptions {
  /**
   * Sandbox negative testing: asks PayPal to answer this capture with INSTRUMENT_DECLINED
   * through the `PayPal-Mock-Response` header. Never charges anything.
   */
  mockDecline?: boolean
}
export interface PayPalGateway {
  create(purchase: StoredPurchase): Promise<PayPalOrder>
  /** `requestId` is the PayPal-Request-Id; reusing it returns the earlier capture result. */
  capture(orderId: string, requestId: string, options?: CaptureOptions): Promise<PayPalOrder>
  get(orderId: string): Promise<PayPalOrder>
  getRefund(refundId: string): Promise<PayPalRefund>
  /** Verifies a webhook against the exact bytes PayPal sent. */
  verify(headers: IncomingHttpHeaders, rawBody: string): Promise<boolean>
  eligibility(amountCents: number): Promise<PayLaterEligibility>
}
/**
 * A PayPal failure, normalized: HTTP errors carry PayPal's issue code, while timeouts, network
 * failures and unreadable responses carry TIMEOUT, NETWORK_ERROR or INVALID_RESPONSE.
 */
export class PayPalError extends Error {
  override name = 'PayPalError'
  constructor(
    readonly status: number,
    readonly issue: string,
    readonly debugId?: string,
    readonly links: PayPalLink[] = [],
  ) {
    super(`PayPal request failed (${issue}).`)
  }
}

/** Capture issues that mean the buyer must choose another way to pay, not that the result is unknown. */
export const REAPPROVAL_ISSUES = new Set(['INSTRUMENT_DECLINED', 'PAYER_ACTION_REQUIRED'])

/** Hosts PayPal uses for buyer approval in the sandbox. */
const APPROVAL_HOSTS = new Set(['www.sandbox.paypal.com', 'sandbox.paypal.com'])
export function approvalLink(links: PayPalLink[] | undefined): string | undefined {
  const href = links?.find((link) =>
    ['payer-action', 'approve', 'redirect'].includes(link.rel),
  )?.href
  if (!href) return undefined
  try {
    const url = new URL(href)
    return url.protocol === 'https:' && APPROVAL_HOSTS.has(url.hostname) ? url.href : undefined
  } catch {
    return undefined
  }
}

/** PayPal signs webhooks with certificates served only from its own API hosts. */
const CERT_HOSTS = new Set([
  'api.sandbox.paypal.com',
  'api-m.sandbox.paypal.com',
  'api.paypal.com',
  'api-m.paypal.com',
])
export function trustedCertUrl(value: unknown) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && CERT_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

const WEBHOOK_HEADERS = [
  'paypal-auth-algo',
  'paypal-cert-url',
  'paypal-transmission-id',
  'paypal-transmission-sig',
  'paypal-transmission-time',
] as const

export interface GatewayConfig {
  clientId: string
  secret: string
  origin: string
  webhookId?: string
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch
  /** Receives PayPal debug IDs for failed calls. Never request bodies or credentials. */
  log?: (event: Record<string, unknown>) => void
  timeoutMs?: number
}

export function createPayPalGateway(config: GatewayConfig): PayPalGateway {
  const base = 'https://api-m.sandbox.paypal.com'
  const http = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? 20_000
  const log =
    config.log ??
    ((event: Record<string, unknown>) => console.warn('PayPal:', JSON.stringify(event)))
  let token: { value: string; until: number } | undefined

  /** One fetch, with transport failures and unreadable bodies turned into PayPalError. */
  async function send(path: string, init: RequestInit, timeout: number) {
    let response: Response
    try {
      response = await http(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeout) })
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      const issue = name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR'
      log({ event: 'paypal_transport_error', path: logPath(path), issue })
      throw new PayPalError(0, issue)
    }
    const text = await response.text().catch(() => '')
    let body: Record<string, unknown> = {}
    let readable = true
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text)
        if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
        else readable = false
      } catch {
        readable = false
      }
    }
    const debugId =
      response.headers.get('paypal-debug-id') ??
      (typeof body.debug_id === 'string' ? body.debug_id : undefined)
    return { response, body, readable, debugId }
  }

  async function accessToken(refresh = false) {
    if (!refresh && token && token.until > Date.now()) return token.value
    const { response, body, readable, debugId } = await send(
      '/v1/oauth2/token',
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.secret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      },
      15_000,
    )
    if (!response.ok || !readable || typeof body.access_token !== 'string') {
      log({ event: 'paypal_auth_failed', status: response.status, debugId })
      throw new PayPalError(response.status, 'AUTHENTICATION_FAILED', debugId)
    }
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 300
    token = {
      value: body.access_token,
      until: Date.now() + Math.max(0, expiresIn - 60) * 1000,
    }
    return token.value
  }

  async function request<T>(
    path: string,
    options: {
      method?: string
      body?: unknown
      rawBody?: string
      requestId?: string
      headers?: Record<string, string>
    } = {},
  ): Promise<T> {
    const method = options.method ?? 'GET'
    const payload =
      options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))
    for (let attempt = 0; ; attempt++) {
      const { response, body, readable, debugId } = await send(
        path,
        {
          method,
          headers: {
            Authorization: `Bearer ${await accessToken(attempt > 0)}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
            ...(options.requestId ? { 'PayPal-Request-Id': options.requestId } : {}),
            ...options.headers,
          },
          ...(payload === undefined ? {} : { body: payload }),
        },
        timeoutMs,
      )
      // A revoked or expired token is refreshed once; the request ID keeps a retried write safe.
      if (response.status === 401 && attempt === 0) {
        token = undefined
        continue
      }
      if (!response.ok) {
        const details = Array.isArray(body.details) ? (body.details as { issue?: unknown }[]) : []
        const issue =
          (typeof details[0]?.issue === 'string' && details[0].issue) ||
          (typeof body.name === 'string' && body.name) ||
          (readable ? 'UNAVAILABLE' : 'INVALID_RESPONSE')
        const links = Array.isArray(body.links) ? (body.links as PayPalLink[]) : []
        log({
          event: 'paypal_error',
          method,
          path: logPath(path),
          status: response.status,
          issue,
          debugId,
        })
        throw new PayPalError(response.status, issue, debugId, links)
      }
      if (!readable) {
        log({
          event: 'paypal_unreadable',
          method,
          path: logPath(path),
          status: response.status,
          debugId,
        })
        throw new PayPalError(response.status, 'INVALID_RESPONSE', debugId)
      }
      return body as T
    }
  }

  return {
    create(purchase) {
      const value = (purchase.amountCents / 100).toFixed(2)
      return request<PayPalOrder>('/v2/checkout/orders', {
        method: 'POST',
        requestId: `create-${purchase.id}`,
        body: {
          intent: 'CAPTURE',
          purchase_units: [
            {
              reference_id: purchase.id,
              custom_id: purchase.id,
              // PayPal refuses a second payment for the same invoice ID.
              invoice_id: purchase.id,
              description: `Worth sandbox: ${purchase.name}`.slice(0, 127),
              amount: {
                currency_code: 'USD',
                value,
                breakdown: { item_total: { currency_code: 'USD', value } },
              },
              items: [
                {
                  name: purchase.name.slice(0, 127),
                  sku: purchase.productId.slice(0, 127),
                  quantity: '1',
                  category: 'PHYSICAL_GOODS',
                  unit_amount: { currency_code: 'USD', value },
                },
              ],
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: 'Worth — sandbox demo',
                user_action: 'CONTINUE',
                shipping_preference: 'NO_SHIPPING',
                return_url: returnUrl(config.origin, purchase.id, 'approved'),
                cancel_url: returnUrl(config.origin, purchase.id, 'cancelled'),
              },
            },
          },
        },
      })
    },
    capture(orderId, requestId, options = {}) {
      return request<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
        method: 'POST',
        body: {},
        requestId,
        ...(options.mockDecline
          ? {
              headers: {
                'PayPal-Mock-Response': JSON.stringify({
                  mock_application_codes: 'INSTRUMENT_DECLINED',
                }),
              },
            }
          : {}),
      })
    },
    get(orderId) {
      return request<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(orderId)}`)
    },
    getRefund(refundId) {
      return request<PayPalRefund>(`/v2/payments/refunds/${encodeURIComponent(refundId)}`)
    },
    async verify(headers, rawBody) {
      if (!config.webhookId) return false
      if (WEBHOOK_HEADERS.some((name) => typeof headers[name] !== 'string')) return false
      // Only PayPal's own certificate hosts are worth an outbound verification call.
      if (!trustedCertUrl(headers['paypal-cert-url'])) return false
      try {
        JSON.parse(rawBody)
      } catch {
        return false
      }
      // The event goes back exactly as received: re-serializing it can fail verification.
      const fields = JSON.stringify({
        auth_algo: headers['paypal-auth-algo'],
        cert_url: headers['paypal-cert-url'],
        transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'],
        transmission_time: headers['paypal-transmission-time'],
        webhook_id: config.webhookId,
      })
      const result = await request<{ verification_status?: string }>(
        '/v1/notifications/verify-webhook-signature',
        { method: 'POST', rawBody: `${fields.slice(0, -1)},"webhook_event":${rawBody}}` },
      )
      return result.verification_status === 'SUCCESS'
    },
    async eligibility(amountCents) {
      const result = await request<{
        eligible_methods?: Record<string, { product_code?: string; country_code?: string }>
      }>('/v2/payments/find-eligible-methods', {
        method: 'POST',
        body: {
          customer: { country_code: 'US' },
          purchase_units: [
            { amount: { currency_code: 'USD', value: (amountCents / 100).toFixed(2) } },
          ],
          preferences: { payment_flow: 'ONE_TIME_PAYMENT' },
        },
      })
      const payLater = result.eligible_methods?.paypal_pay_later
      return payLater
        ? {
            payLater: true,
            ...(payLater.product_code ? { productCode: payLater.product_code } : {}),
            ...(payLater.country_code ? { countryCode: payLater.country_code } : {}),
          }
        : { payLater: false }
    },
  }
}

/**
 * PayPal sends the buyer back through the server, which records the result before showing the
 * app at `/?checkout=<id>&paypal=approved|cancelled`.
 */
function returnUrl(origin: string, purchaseId: string, result: 'approved' | 'cancelled') {
  return `${origin}/api/checkout/${encodeURIComponent(purchaseId)}/return?paypal=${result}`
}

/** Paths in logs never carry IDs beyond PayPal's own resource IDs. */
function logPath(path: string) {
  return path.split('?')[0]
}

export function validateOrder(order: PayPalOrder, purchase: StoredPurchase): string {
  if (!order.id || (purchase.orderId && order.id !== purchase.orderId))
    throw new Error('Order identity mismatch')
  const units = order.purchase_units
  if (!units || units.length !== 1) throw new Error('Unexpected purchase units')
  const unit = units[0]!
  if (unit.custom_id !== purchase.id || unit.reference_id !== purchase.id)
    throw new Error('Purchase reference mismatch')
  if (unit.amount.currency_code !== 'USD' || toCents(unit.amount.value) !== purchase.amountCents)
    throw new Error('Order amount mismatch')
  const merchant = unit.payee?.merchant_id
  if (!merchant || (purchase.merchantId && merchant !== purchase.merchantId))
    throw new Error('Merchant mismatch')
  for (const capture of unit.payments?.captures ?? []) {
    if (
      capture.amount.currency_code !== 'USD' ||
      toCents(capture.amount.value) !== purchase.amountCents
    )
      throw new Error('Capture amount mismatch')
  }
  if ((unit.payments?.captures?.length ?? 0) > 1) throw new Error('Unexpected multiple captures')
  return merchant
}
export function toCents(value: string) {
  if (!/^\d+\.\d{2}$/.test(value)) throw new Error('Invalid PayPal amount')
  return Math.round(Number(value) * 100)
}
