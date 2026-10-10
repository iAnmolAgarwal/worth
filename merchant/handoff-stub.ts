import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

/**
 * The store's side of the hand-off contract (workspace specs/handoff-contract.md §2–§5), until the
 * shared module lands. Tokens are `<payload>.<sig>`: base64url JSON, then base64url HMAC-SHA256 of
 * "worth-handoff.v1.<direction>.<payload>", so a quote can never be replayed as a result.
 * Signing and verifying happen only on the server; the key never reaches a browser.
 */
export const HANDOFF_LABEL = 'worth-handoff.v1'
export const KEY_ID = '1'
/** Tokens over this length are rejected before any decoding. */
export const MAX_TOKEN_BYTES = 4096
/** The longest a token may live (exp − iat), in seconds. */
export const MAX_TTL_S = 900
/** Clock skew allowed between the store and Worth, in seconds. */
export const SKEW_S = 60

export type Direction = 'quote' | 'result'

export interface QuotePayload {
  v: 1
  kid: string
  mid: string
  qid: string
  item: string
  productId: string
  amountCents: number
  currency: 'USD'
  merchant: string
  returnUrl: string
  imageUrl?: string
  payLater?: { eligible: boolean; source: 'merchant-sdk' }
  replay?: 'video'
  iat: number
  exp: number
}

const resultSchema = z.strictObject({
  v: z.literal(1),
  kid: z.string().max(16),
  mid: z.string().max(64),
  qid: z.string().regex(/^q_[A-Za-z0-9_-]{22}$/),
  verdict: z.enum(['buy_today', 'wait', 'spend_less']),
  fitsOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  payIn4Fits: z.boolean().optional(),
  iat: z.number().int(),
  exp: z.number().int(),
})
export type ResultPayload = z.infer<typeof resultSchema>

/** What the report-back carries (contract §5). */
export interface OutcomeBody {
  v: 1
  kid: string
  mid: string
  qid: string
  orderId: string
  captureId: string
  amountCents: number
  currency: 'USD'
  status: 'COMPLETED'
  capturedAt: string
}

export interface HandoffOptions {
  /** HANDOFF_SECRET, at least 32 bytes in production. */
  secret: Buffer
  /** HANDOFF_MERCHANT_ID, the `mid` claim. */
  merchantId: string
  /** Milliseconds since the epoch; injected in tests. */
  now?: () => number
}

const BASE64URL = /^[A-Za-z0-9_-]+$/

function mac(secret: Buffer, message: string) {
  return createHmac('sha256', secret).update(message).digest()
}

export function createHandoff({ secret, merchantId, now = Date.now }: HandoffOptions) {
  const seconds = () => Math.floor(now() / 1000)
  const sign = (direction: Direction, payload: object) => {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const sig = mac(secret, `${HANDOFF_LABEL}.${direction}.${encoded}`).toString('base64url')
    return `${encoded}.${sig}`
  }
  /**
   * The checks every token passes before its fields are read: size, shape, signature in constant
   * time, then the shared claims and the time window. Returns the decoded JSON or undefined.
   */
  const open = (direction: Direction, token: unknown): Record<string, unknown> | undefined => {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_BYTES) return undefined
    const parts = token.split('.')
    if (parts.length !== 2 || !BASE64URL.test(parts[0]!) || !BASE64URL.test(parts[1]!))
      return undefined
    const [encoded, sig] = parts as [string, string]
    const expected = mac(secret, `${HANDOFF_LABEL}.${direction}.${encoded}`)
    const given = Buffer.from(sig, 'base64url')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined
    let payload: unknown
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    } catch {
      return undefined
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
    const claims = payload as Record<string, unknown>
    const { v, kid, mid, iat, exp } = claims
    if (v !== 1 || kid !== KEY_ID || mid !== merchantId) return undefined
    if (!Number.isInteger(iat) || !Number.isInteger(exp)) return undefined
    const time = seconds()
    const issued = iat as number
    const expires = exp as number
    if (expires <= issued || expires - issued > MAX_TTL_S) return undefined
    if (expires + SKEW_S < time || issued - SKEW_S > time) return undefined
    return claims
  }
  return {
    /** Signs a quote for the "Analyse with Worth" link (§3). Callers fill every claim. */
    signQuote(payload: QuotePayload): string {
      if (payload.exp - payload.iat > MAX_TTL_S || payload.exp <= payload.iat)
        throw new Error('A quote lives at most 15 minutes.')
      return sign('quote', payload)
    },
    /** Verifies Worth's `?worth=` result token (§4); undefined for anything invalid or expired. */
    verifyResult(token: unknown): ResultPayload | undefined {
      const claims = open('result', token)
      if (!claims) return undefined
      const parsed = resultSchema.safeParse(claims)
      return parsed.success ? parsed.data : undefined
    },
    /** The signed report-back request (§5): the exact body bytes and the two headers. */
    signOutcome(body: OutcomeBody): { body: string; headers: Record<string, string> } {
      const raw = JSON.stringify(body)
      const timestamp = String(seconds())
      const signature = mac(secret, `${HANDOFF_LABEL}.outcome.${timestamp}.${raw}`).toString(
        'base64url',
      )
      return {
        body: raw,
        headers: {
          'Content-Type': 'application/json',
          'Worth-Handoff-Timestamp': timestamp,
          'Worth-Handoff-Signature': signature,
        },
      }
    },
    /** For tests and the shared module's parity checks: the generic signer and opener. */
    sign,
    open,
  }
}
export type Handoff = ReturnType<typeof createHandoff>
