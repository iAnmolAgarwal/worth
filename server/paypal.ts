import type { IncomingHttpHeaders } from 'node:http'
import { DEMO_MERCHANT, PRODUCTS } from '../shared/seed.ts'
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
  /** One attempt's limit, including reading the body. */
  timeoutMs?: number
  /** One call's limit across its attempts, token fetches and waits; see REQUEST_BUDGET_MS. */
  budgetMs?: number
  /** Waits between retries. Injected in tests; defaults to a timer. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * One call's total time, retries included. Twenty seconds keeps a capture (an order lookup, then
 * the capture) under 40 s and a checkout start (eligibility, then the order) under 25 s, well inside
 * the 60 s an MCP client waits.
 */
const REQUEST_BUDGET_MS = 20_000
/** Pay Later eligibility is advisory and falls back to the range, so it gets one short attempt. */
const ELIGIBILITY_BUDGET_MS = 5_000
/** No retry starts with less than this left of the call's budget; the last error is final. */
const MIN_RETRY_BUDGET_MS = 3_000

/** A 429 or 5xx is retried at most this many times, with the same PayPal-Request-Id. */
const MAX_RETRIES = 2
const RETRY_BASE_MS = 300
/** No wait between retries is longer than this, even when PayPal's Retry-After asks for more. */
const RETRY_CAP_MS = 2_000

/**
 * The wait before retry `retry` (1-based): exponential backoff from RETRY_BASE_MS with jitter, so
 * parallel callers do not retry in step, or PayPal's longer Retry-After. A Retry-After of 0, a
 * negative one or a past date never means an immediate retry.
 */
export function retryDelay(retry: number, retryAfter: string | null, random = Math.random) {
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (retry - 1))
  const backoff = Math.round(ceiling / 2 + random() * (ceiling / 2))
  if (retryAfter) {
    const seconds = Number(retryAfter)
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now()
    if (Number.isFinite(ms)) return Math.min(RETRY_CAP_MS, Math.max(backoff, Math.round(ms)))
  }
  return backoff
}

export function createPayPalGateway(config: GatewayConfig): PayPalGateway {
  const base = 'https://api-m.sandbox.paypal.com'
  const http = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? 20_000
  const budgetMs = config.budgetMs ?? REQUEST_BUDGET_MS
  const sleep =
    config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const log =
    config.log ??
    ((event: Record<string, unknown>) => console.warn('PayPal:', JSON.stringify(event)))
  let token: { value: string; until: number } | undefined

  /** One fetch, with transport failures and unreadable bodies turned into PayPalError. */
  async function send(path: string, init: RequestInit, timeout: number) {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DOMException('PayPal did not answer in time', 'TimeoutError')),
      timeout,
    )
    let response: Response
    let text: string
    try {
      response = await http(`${base}${path}`, { ...init, signal: controller.signal })
      // The body is read under the same timeout. A body that fails to arrive is a transport
      // failure, never an empty success: a capture's result would otherwise be lost.
      text = await response.text()
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      const issue = name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR'
      log({ event: 'paypal_transport_error', path: logPath(path), issue })
      throw new PayPalError(0, issue)
    } finally {
      clearTimeout(timer)
    }
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

  async function accessToken(timeout: number) {
    if (token && token.until > Date.now()) return token.value
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
      Math.min(15_000, timeout),
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
      /** Retries after a 429, 5xx or transport failure; MAX_RETRIES by default. */
      retries?: number
      budgetMs?: number
    } = {},
  ): Promise<T> {
    const method = options.method ?? 'GET'
    const payload =
      options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))
    // A GET, or a write PayPal can match by its request ID, is safe to send again after a timeout.
    const repeatable = method === 'GET' || Boolean(options.requestId)
    const maxRetries = options.retries ?? MAX_RETRIES
    // Every attempt, token fetch and wait shares one deadline, so a call ends in bounded time.
    const deadline = Date.now() + Math.min(budgetMs, options.budgetMs ?? budgetMs)
    let refreshed = false
    let retries = 0
    const left = (wait = 0) => deadline - Date.now() - wait
    const canRetry = (delayMs: number) =>
      retries < maxRetries && left(delayMs) >= MIN_RETRY_BUDGET_MS
    for (;;) {
      let sent: Awaited<ReturnType<typeof send>>
      try {
        const bearer = await accessToken(left())
        const timeout = Math.min(timeoutMs, left())
        if (timeout <= 0) {
          log({ event: 'paypal_transport_error', path: logPath(path), issue: 'TIMEOUT' })
          throw new PayPalError(0, 'TIMEOUT')
        }
        sent = await send(
          path,
          {
            method,
            headers: {
              Authorization: `Bearer ${bearer}`,
              'Content-Type': 'application/json',
              Prefer: 'return=representation',
              ...(options.requestId ? { 'PayPal-Request-Id': options.requestId } : {}),
              ...options.headers,
            },
            ...(payload === undefined ? {} : { body: payload }),
          },
          timeout,
        )
      } catch (error) {
        const transport = error instanceof PayPalError && error.status === 0
        const delayMs = retryDelay(retries + 1, null)
        if (!transport || !repeatable || !canRetry(delayMs)) throw error
        retries++
        log({
          event: 'paypal_retry',
          method,
          path: logPath(path),
          issue: error.issue,
          retry: retries,
          delayMs,
        })
        await sleep(delayMs)
        continue
      }
      const { response, body, readable, debugId } = sent
      // A revoked or expired token is refreshed once; the request ID keeps a retried write safe.
      if (response.status === 401 && !refreshed && left() >= MIN_RETRY_BUDGET_MS) {
        refreshed = true
        token = undefined
        continue
      }
      // Rate limits and server errors are retried a bounded number of times with the same request
      // ID, so PayPal returns the first result instead of acting twice. Other 4xx are final.
      const delayMs = retryDelay(retries + 1, response.headers.get('retry-after'))
      if ((response.status === 429 || response.status >= 500) && canRetry(delayMs)) {
        retries++
        log({
          event: 'paypal_retry',
          method,
          path: logPath(path),
          status: response.status,
          retry: retries,
          delayMs,
          debugId,
        })
        await sleep(delayMs)
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
      // The payee is the store, not Worth: PayPal's approval page names the demo store the sandbox
      // merchant stands in for, so Worth never looks like the seller.
      const store = PRODUCTS.find((p) => p.id === purchase.productId)?.merchant ?? DEMO_MERCHANT
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
              description: `${purchase.name} from ${store} (sandbox demo store)`.slice(0, 127),
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
                brand_name: `${store} (demo store)`.slice(0, 127),
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
        retries: 0,
        budgetMs: ELIGIBILITY_BUDGET_MS,
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
