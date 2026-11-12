import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { DEMO_PRESETS } from './seed.ts'
import { plainText } from './text.ts'

/**
 * The store ↔ Worth hand-off (specs/handoff-contract.md §2–§5). Server-only: both signing and
 * verifying need HANDOFF_SECRET, which never reaches a browser. Every function is pure apart from
 * the clock, which the factory takes as an option.
 */

/** Which way a token travels. The label is signed, so a token can't be replayed the other way. */
export type Direction = 'quote' | 'result'
export const HANDOFF_PREFIX = 'worth-handoff.v1.'
/** The only key id in v1; a later key rotation adds more. */
export const HANDOFF_KID = '1'
/** A whole token, checked before anything is decoded. */
export const MAX_TOKEN_LENGTH = 4096
/** The outcome report's raw body. */
export const MAX_OUTCOME_BYTES = 2048
/** The longest a quote or result may live: exp − iat. */
export const MAX_LIFETIME_S = 900
/** Clock difference allowed between the store and Worth for iat and exp. */
export const CLOCK_SKEW_S = 60
/** How far an outcome report's timestamp may be from now. */
export const OUTCOME_SKEW_S = 300
export const ITEM_MAX = 120
export const MERCHANT_MAX = 60
/** HANDOFF_SECRET's minimum decoded length. */
export const MIN_SECRET_BYTES = 32

const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/

/** A third-party name made safe to show and to quote: hidden characters out, length capped. */
export function sanitizeName(value: string, max: number) {
  return plainText(value).slice(0, max).trim()
}

/**
 * HANDOFF_SECRET as key bytes, or undefined when it is not base64url or shorter than 32 bytes.
 * Bytes already decoded are accepted as they are.
 */
export function secretBytes(secret: string | Buffer | undefined): Buffer | undefined {
  if (Buffer.isBuffer(secret)) return secret.length >= MIN_SECRET_BYTES ? secret : undefined
  if (!secret || !BASE64URL.test(secret)) return undefined
  const bytes = Buffer.from(secret, 'base64url')
  return bytes.length >= MIN_SECRET_BYTES ? bytes : undefined
}

function hmac(key: Buffer, message: string) {
  return createHmac('sha256', key).update(message, 'utf8').digest()
}

/**
 * Constant-time equality of the canonical base64url signature strings, with the length checked
 * first. Comparing strings, not decoded bytes, keeps one spelling per token: the unused low bits
 * of the last character can't make a second string verify.
 */
export function signatureMatches(given: string, expected: Buffer) {
  const want = Buffer.from(expected.toString('base64url'), 'utf8')
  const got = Buffer.from(given, 'utf8')
  return got.length === want.length && timingSafeEqual(got, want)
}

/** `<payload>.<sig>` for one direction. */
export function signToken(key: Buffer, direction: Direction, payload: object) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sig = hmac(key, `${HANDOFF_PREFIX}${direction}.${body}`).toString('base64url')
  return `${body}.${sig}`
}

/** The signature an outcome report carries, over `timestamp + "." + rawBody`. */
export function outcomeSignature(key: Buffer, timestamp: string, rawBody: string) {
  return hmac(key, `${HANDOFF_PREFIX}outcome.${timestamp}.${rawBody}`).toString('base64url')
}

const kid = z.string().min(1).max(16)
const mid = z.string().min(1).max(32)
const seconds = z.number().int().min(0).max(1e11)
const cents = z.number().int().min(1).max(100_000_000)
/** A store's three-letter code. Only USD is accepted, but that check is its own step (§3.4). */
const currency = z.string().regex(/^[A-Z]{3}$/)
const qid = z.string().regex(/^q_[A-Za-z0-9_-]{22}$/)
const link = z.string().min(1).max(2048)
const name = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value) => sanitizeName(value, max))
    .refine((value) => value.length > 0, 'A name is required')
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const quoteSchema = z
  .object({
    v: z.literal(1),
    kid,
    mid,
    qid,
    item: name(ITEM_MAX),
    productId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    amountCents: cents,
    currency,
    merchant: name(MERCHANT_MAX),
    returnUrl: link,
    imageUrl: link.optional(),
    payLater: z
      .object({ eligible: z.boolean(), source: z.literal('merchant-sdk') })
      .strict()
      .optional(),
    replay: z.enum(DEMO_PRESETS).optional(),
    iat: seconds,
    exp: seconds,
  })
  .strict()
export type QuotePayload = z.infer<typeof quoteSchema>

export const VERDICTS = ['buy_today', 'wait', 'spend_less'] as const
export type Verdict = (typeof VERDICTS)[number]
export const resultSchema = z
  .object({
    v: z.literal(1),
    kid,
    mid,
    qid,
    verdict: z.enum(VERDICTS),
    fitsOn: date.optional(),
    payIn4Fits: z.boolean().optional(),
    iat: seconds,
    exp: seconds,
  })
  .strict()
export type ResultPayload = z.infer<typeof resultSchema>

export const outcomeSchema = z
  .object({
    v: z.literal(1),
    kid,
    mid,
    qid,
    orderId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
    captureId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
    amountCents: cents,
    currency,
    status: z.literal('COMPLETED'),
    capturedAt: z.iso.datetime(),
  })
  .strict()
export type OutcomePayload = z.infer<typeof outcomeSchema>

/**
 * Why a token failed, in the order the checks run. `expired` and `non_usd` come after the
 * signature and origin checks, so their payload is trusted enough to offer a way back.
 */
export type Failure =
  | 'malformed'
  | 'unknown_key'
  | 'bad_signature'
  | 'bad_version'
  | 'bad_shape'
  | 'bad_origin'
  | 'non_usd'
  | 'too_long'
  | 'expired'
  | 'future'
export type Verified<T> =
  | { ok: true; payload: T }
  | { ok: false; reason: Exclude<Failure, 'non_usd' | 'expired'> }
  | { ok: false; reason: 'non_usd' | 'expired'; payload: T }

/** Whether a URL is exactly on the allowed origin, without credentials. */
export function onOrigin(value: string, origin: string) {
  try {
    const url = new URL(value)
    return (
      url.origin === origin &&
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' || url.protocol === 'http:')
    )
  } catch {
    return false
  }
}

/** The lifetime checks shared by quotes and results: span, expiry and a future iat. */
export function timeFailure(
  claims: { iat: number; exp: number },
  nowSeconds: number,
): 'too_long' | 'expired' | 'future' | undefined {
  if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_LIFETIME_S) return 'too_long'
  if (nowSeconds > claims.exp + CLOCK_SKEW_S) return 'expired'
  if (claims.iat > nowSeconds + CLOCK_SKEW_S) return 'future'
  return undefined
}

/** Where to send the shopper back: `?worth=` or `&worth=`, keeping any fragment last. */
export function withResult(returnUrl: string, token: string) {
  const url = new URL(returnUrl)
  url.searchParams.set('worth', token)
  return url.toString()
}

export interface HandoffKeys {
  /** HANDOFF_SECRET, base64url (or its decoded bytes), at least 32 bytes once decoded. */
  secret: string | Buffer
  /** HANDOFF_MERCHANT_ID: the `mid` claim. */
  mid: string
  /** MERCHANT_ORIGIN: the only origin a returnUrl or imageUrl may use. */
  merchantOrigin: string
  kid?: string
  /** The clock, in milliseconds. */
  now?: () => number
}
/** What a store fills in for a quote; the version, key ids and times are added when signed. */
export type QuoteInput = Omit<QuotePayload, 'v' | 'kid' | 'mid' | 'iat' | 'exp'> &
  Partial<Pick<QuotePayload, 'v' | 'kid' | 'mid' | 'iat' | 'exp'>>
export type ResultInput = Omit<ResultPayload, 'v' | 'kid' | 'mid' | 'iat' | 'exp'>

/**
 * Signs and verifies hand-off tokens with one merchant's key. The store uses signQuote,
 * verifyResult and signOutcome; Worth uses verifyQuote, signResult and verifyOutcome.
 */
export function createHandoff(keys: HandoffKeys) {
  const key = secretBytes(keys.secret)
  if (!key) throw new Error('HANDOFF_SECRET must be base64url and at least 32 bytes.')
  const keyId = keys.kid ?? HANDOFF_KID
  const origin = new URL(keys.merchantOrigin).origin
  const nowSeconds = () => Math.floor((keys.now ?? Date.now)() / 1000)

  /** Format, size, key ids and signature, in that order; the decoded JSON on success. */
  function open(
    direction: Direction,
    token: unknown,
  ): { ok: true; json: unknown } | { ok: false; reason: Failure } {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !TOKEN.test(token))
      return { ok: false, reason: 'malformed' }
    const [body, sig] = token.split('.') as [string, string]
    let json: unknown
    try {
      json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    } catch {
      return { ok: false, reason: 'malformed' }
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json))
      return { ok: false, reason: 'malformed' }
    const claims = json as { kid?: unknown; mid?: unknown; v?: unknown }
    if (claims.kid !== keyId || claims.mid !== keys.mid) return { ok: false, reason: 'unknown_key' }
    if (!signatureMatches(sig, hmac(key!, `${HANDOFF_PREFIX}${direction}.${body}`)))
      return { ok: false, reason: 'bad_signature' }
    if (claims.v !== 1) return { ok: false, reason: 'bad_version' }
    return { ok: true, json }
  }

  function check<T extends { iat: number; exp: number }>(payload: T): Verified<T> {
    const time = timeFailure(payload, nowSeconds())
    if (time === 'expired') return { ok: false, reason: 'expired', payload }
    if (time) return { ok: false, reason: time }
    return { ok: true, payload }
  }

  return {
    mid: keys.mid,
    kid: keyId,
    merchantOrigin: origin,
    /** Store side: signs a quote at its own catalog price. Throws on a payload Worth would refuse. */
    signQuote(input: QuoteInput) {
      // A full payload may name its version and keys; they must be these.
      if (
        (input.kid ?? keyId) !== keyId ||
        (input.mid ?? keys.mid) !== keys.mid ||
        (input.v ?? 1) !== 1
      )
        throw new Error('A quote must use this key: v 1, its kid and its mid.')
      const iat = input.iat ?? nowSeconds()
      const payload = quoteSchema.parse({
        ...input,
        v: 1,
        kid: keyId,
        mid: keys.mid,
        iat,
        exp: input.exp ?? iat + MAX_LIFETIME_S,
      })
      if (
        !onOrigin(payload.returnUrl, origin) ||
        (payload.imageUrl && !onOrigin(payload.imageUrl, origin))
      )
        throw new Error('returnUrl and imageUrl must be on MERCHANT_ORIGIN.')
      if (timeFailure(payload, payload.iat)) throw new Error('A quote lives at most 900 seconds.')
      return signToken(key!, 'quote', payload)
    },
    /** Worth side: every §3.3 check, in the contract's order. */
    verifyQuote(token: unknown): Verified<QuotePayload> {
      const opened = open('quote', token)
      if (!opened.ok) return opened as Verified<QuotePayload>
      const parsed = quoteSchema.safeParse(opened.json)
      if (!parsed.success) return { ok: false, reason: 'bad_shape' }
      const payload = parsed.data
      if (
        !onOrigin(payload.returnUrl, origin) ||
        (payload.imageUrl && !onOrigin(payload.imageUrl, origin))
      )
        return { ok: false, reason: 'bad_origin' }
      if (payload.currency !== 'USD') return { ok: false, reason: 'non_usd', payload }
      return check(payload)
    },
    /** Worth side: the verdict for "Back to <store>". No money amounts, no plan data. */
    signResult(input: ResultInput) {
      const iat = nowSeconds()
      const payload = resultSchema.parse({
        ...input,
        v: 1,
        kid: keyId,
        mid: keys.mid,
        iat,
        exp: iat + MAX_LIFETIME_S,
      })
      return signToken(key!, 'result', payload)
    },
    /** Store side: a result it may show one line for. Anything invalid or expired shows nothing. */
    verifyResult(token: unknown): Verified<ResultPayload> {
      const opened = open('result', token)
      if (!opened.ok) return opened as Verified<ResultPayload>
      const parsed = resultSchema.safeParse(opened.json)
      if (!parsed.success) return { ok: false, reason: 'bad_shape' }
      return check(parsed.data)
    },
    /** Store side: the report-back body and its two headers (§5). */
    signOutcome(body: OutcomePayload | string, timestamp = nowSeconds()) {
      const raw = typeof body === 'string' ? body : JSON.stringify(body)
      const stamp = String(timestamp)
      return {
        body: raw,
        headers: {
          'Content-Type': 'application/json',
          'Worth-Handoff-Timestamp': stamp,
          'Worth-Handoff-Signature': outcomeSignature(key!, stamp, raw),
        },
      }
    },
    /**
     * Worth side (C4): size, then timestamp skew, then signature, then the strict shape and USD.
     * Unknown qid, idempotency and consent are the route's checks.
     */
    verifyOutcome(
      rawBody: string,
      timestamp: string | undefined,
      signature: string | undefined,
    ):
      | { ok: true; payload: OutcomePayload }
      | {
          ok: false
          reason:
            | 'too_large'
            | 'bad_timestamp'
            | 'bad_signature'
            | 'bad_shape'
            | 'unknown_key'
            | 'non_usd'
        } {
      if (Buffer.byteLength(rawBody, 'utf8') > MAX_OUTCOME_BYTES)
        return { ok: false, reason: 'too_large' }
      if (
        !timestamp ||
        !/^\d{1,12}$/.test(timestamp) ||
        Math.abs(nowSeconds() - Number(timestamp)) > OUTCOME_SKEW_S
      )
        return { ok: false, reason: 'bad_timestamp' }
      if (
        !signature ||
        !signatureMatches(signature, hmac(key!, `${HANDOFF_PREFIX}outcome.${timestamp}.${rawBody}`))
      )
        return { ok: false, reason: 'bad_signature' }
      let json: unknown
      try {
        json = JSON.parse(rawBody)
      } catch {
        return { ok: false, reason: 'bad_shape' }
      }
      const parsed = outcomeSchema.safeParse(json)
      if (!parsed.success) return { ok: false, reason: 'bad_shape' }
      if (parsed.data.kid !== keyId || parsed.data.mid !== keys.mid)
        return { ok: false, reason: 'unknown_key' }
      if (parsed.data.currency !== 'USD') return { ok: false, reason: 'non_usd' }
      return { ok: true, payload: parsed.data }
    },
  }
}
export type Handoff = ReturnType<typeof createHandoff>
