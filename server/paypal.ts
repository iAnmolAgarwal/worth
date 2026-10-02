import type { IncomingHttpHeaders } from 'node:http'
import type { StoredPurchase } from './store.ts'

export interface PayPalAmount {
  currency_code: string
  value: string
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
    amount: PayPalAmount
    payee?: { merchant_id?: string }
    payments?: { captures?: PayPalCapture[] }
  }[]
  links?: { rel: string; href: string }[]
}
export interface PayPalGateway {
  create(purchase: StoredPurchase): Promise<PayPalOrder>
  capture(orderId: string, purchaseId: string): Promise<PayPalOrder>
  get(orderId: string): Promise<PayPalOrder>
  verify(headers: IncomingHttpHeaders, event: unknown): Promise<boolean>
}
export class PayPalError extends Error {
  constructor(
    readonly status: number,
    readonly issue: string,
  ) {
    super(`PayPal request failed (${issue}).`)
  }
}
export function createPayPalGateway(config: {
  clientId: string
  secret: string
  origin: string
  webhookId?: string
}): PayPalGateway {
  const base = 'https://api-m.sandbox.paypal.com'
  let token: { value: string; until: number } | undefined
  async function accessToken() {
    if (token && token.until > Date.now()) return token.value
    const response = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(15000),
    })
    const body = (await response.json()) as { access_token?: string; expires_in?: number }
    if (!response.ok || !body.access_token)
      throw new PayPalError(response.status, 'AUTHENTICATION_FAILED')
    token = {
      value: body.access_token,
      until: Date.now() + Math.max(0, (body.expires_in ?? 300) - 60) * 1000,
    }
    return token.value
  }
  async function request<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    requestId?: string,
  ): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    })
    const payload = (await response.json()) as { details?: { issue?: string }[]; name?: string }
    if (!response.ok)
      throw new PayPalError(
        response.status,
        payload.details?.[0]?.issue ?? payload.name ?? 'UNAVAILABLE',
      )
    return payload as T
  }
  return {
    create(purchase) {
      return request<PayPalOrder>(
        '/v2/checkout/orders',
        'POST',
        {
          intent: 'CAPTURE',
          purchase_units: [
            {
              reference_id: purchase.id,
              custom_id: purchase.id,
              description: `Worth sandbox: ${purchase.name}`,
              amount: { currency_code: 'USD', value: (purchase.amountCents / 100).toFixed(2) },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: 'Worth — sandbox demo',
                user_action: 'CONTINUE',
                shipping_preference: 'NO_SHIPPING',
                return_url: `${config.origin}/?checkout=${encodeURIComponent(purchase.id)}&paypal=approved`,
                cancel_url: `${config.origin}/?checkout=${encodeURIComponent(purchase.id)}&paypal=cancelled`,
              },
            },
          },
        },
        `create-${purchase.id}`,
      )
    },
    capture(orderId, purchaseId) {
      return request<PayPalOrder>(
        `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
        'POST',
        {},
        `capture-${purchaseId}`,
      )
    },
    get(orderId) {
      return request<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(orderId)}`)
    },
    async verify(headers, event) {
      if (!config.webhookId) return false
      const names = [
        'paypal-auth-algo',
        'paypal-cert-url',
        'paypal-transmission-id',
        'paypal-transmission-sig',
        'paypal-transmission-time',
      ]
      if (names.some((name) => typeof headers[name] !== 'string')) return false
      const result = await request<{ verification_status: string }>(
        '/v1/notifications/verify-webhook-signature',
        'POST',
        {
          auth_algo: headers['paypal-auth-algo'],
          cert_url: headers['paypal-cert-url'],
          transmission_id: headers['paypal-transmission-id'],
          transmission_sig: headers['paypal-transmission-sig'],
          transmission_time: headers['paypal-transmission-time'],
          webhook_id: config.webhookId,
          webhook_event: event,
        },
      )
      return result.verification_status === 'SUCCESS'
    },
  }
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
function toCents(value: string) {
  if (!/^\d+\.\d{2}$/.test(value)) throw new Error('Invalid PayPal amount')
  return Math.round(Number(value) * 100)
}
