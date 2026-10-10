import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CLOCK_SKEW_S,
  createHandoff,
  MAX_LIFETIME_S,
  MAX_OUTCOME_BYTES,
  MAX_TOKEN_LENGTH,
  outcomeSignature,
  sanitizeName,
  secretBytes,
  signatureMatches,
  signToken,
  timeFailure,
  withResult,
} from '../shared/handoff.ts'
import type { OutcomePayload, QuoteInput, QuotePayload } from '../shared/handoff.ts'

const SECRET = Buffer.alloc(32, 7).toString('base64url')
const OTHER_SECRET = Buffer.alloc(32, 9).toString('base64url')
const ORIGIN = 'https://store.example'
const NOW = 1_791_000_000
const clock = { value: NOW * 1000 }
const keys = { secret: SECRET, mid: 'larkspur', merchantOrigin: ORIGIN, now: () => clock.value }
const handoff = createHandoff(keys)
const key = secretBytes(SECRET)!

const input: QuoteInput = {
  qid: 'q_abcdefghijklmnopqrstuv',
  item: 'Everyday camera',
  productId: 'camera',
  amountCents: 119900,
  currency: 'USD',
  merchant: 'Larkspur Supply',
  returnUrl: `${ORIGIN}/p/camera`,
  imageUrl: `${ORIGIN}/img/camera.png`,
  payLater: { eligible: true, source: 'merchant-sdk' },
  replay: 'video',
}
const payload: QuotePayload = {
  v: 1,
  kid: '1',
  mid: 'larkspur',
  ...input,
  iat: NOW,
  exp: NOW + 900,
} as QuotePayload

/** A token for any payload, signed with the right key unless told otherwise. */
function forge(body: object, direction: 'quote' | 'result' = 'quote', secret = key) {
  return signToken(secret, direction, body)
}
function decode(token: string) {
  return JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'))
}
/** Re-encodes the payload and keeps the original signature. */
function tamper(token: string, change: (body: Record<string, unknown>) => void) {
  const body = decode(token)
  change(body)
  return `${Buffer.from(JSON.stringify(body)).toString('base64url')}.${token.split('.')[1]}`
}

describe('hand-off tokens (contract §2)', () => {
  it('signs a quote the verifier accepts, with v, kid, mid, iat and a 900 s expiry', () => {
    clock.value = NOW * 1000
    const token = handoff.signQuote(input)
    const result = handoff.verifyQuote(token)
    expect(result).toEqual({ ok: true, payload })
    expect(decode(token)).toMatchObject({
      v: 1,
      kid: '1',
      mid: 'larkspur',
      iat: NOW,
      exp: NOW + 900,
    })
  })

  it('signs over the direction label and the encoded payload with HMAC-SHA256', () => {
    const token = forge(payload)
    const [body, sig] = token.split('.') as [string, string]
    const expected = createHmac('sha256', key)
      .update(`worth-handoff.v1.quote.${body}`)
      .digest('base64url')
    expect(sig).toBe(expected)
  })

  it('rejects a quote replayed as a result and a result replayed as a quote', () => {
    clock.value = NOW * 1000
    const quote = handoff.signQuote(input)
    expect(handoff.verifyResult(quote)).toEqual({ ok: false, reason: 'bad_signature' })
    const result = handoff.signResult({ qid: input.qid, verdict: 'buy_today' })
    expect(handoff.verifyQuote(result)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('detects tampering with every field of a signed quote', () => {
    clock.value = NOW * 1000
    const token = handoff.signQuote(input)
    const changes: Record<string, unknown> = {
      v: 2,
      qid: 'q_ZZZZZZZZZZZZZZZZZZZZZZ',
      item: 'Cheaper camera',
      productId: 'other',
      amountCents: 100,
      currency: 'EUR',
      merchant: 'Someone Else',
      returnUrl: `${ORIGIN}/elsewhere`,
      imageUrl: `${ORIGIN}/img/other.png`,
      payLater: { eligible: false, source: 'merchant-sdk' },
      replay: undefined,
      iat: NOW + 1,
      exp: NOW + 899,
    }
    for (const [field, value] of Object.entries(changes)) {
      const forged = tamper(token, (body) => {
        body[field] = value
      })
      expect(handoff.verifyQuote(forged), field).toEqual({ ok: false, reason: 'bad_signature' })
    }
    // kid and mid are looked up before the signature, so a changed one is an unknown key.
    for (const field of ['kid', 'mid']) {
      const forged = tamper(token, (body) => {
        body[field] = 'x'
      })
      expect(handoff.verifyQuote(forged), field).toEqual({ ok: false, reason: 'unknown_key' })
    }
    // A flipped signature character fails too.
    const [body, sig] = token.split('.') as [string, string]
    const flipped = `${body}.${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`
    expect(handoff.verifyQuote(flipped)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects a token signed with another key', () => {
    const wrong = forge(payload, 'quote', secretBytes(OTHER_SECRET)!)
    expect(handoff.verifyQuote(wrong)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects an unknown kid or mid before checking the signature', () => {
    clock.value = NOW * 1000
    expect(handoff.verifyQuote(forge({ ...payload, kid: '2' }))).toEqual({
      ok: false,
      reason: 'unknown_key',
    })
    expect(handoff.verifyQuote(forge({ ...payload, mid: 'other' }))).toEqual({
      ok: false,
      reason: 'unknown_key',
    })
    const other = createHandoff({ ...keys, mid: 'other' })
    expect(other.verifyQuote(handoff.signQuote(input))).toEqual({
      ok: false,
      reason: 'unknown_key',
    })
  })

  it('rejects malformed and oversize tokens before decoding', () => {
    for (const token of [
      undefined,
      42,
      '',
      'abc',
      'abc.def',
      'a.b.c',
      `${'!'.repeat(10)}.${'A'.repeat(43)}`,
      `${Buffer.from('not json').toString('base64url')}.${'A'.repeat(43)}`,
      `${Buffer.from('[1]').toString('base64url')}.${'A'.repeat(43)}`,
      `${Buffer.from('null').toString('base64url')}.${'A'.repeat(43)}`,
    ])
      expect(handoff.verifyQuote(token), String(token)).toEqual({ ok: false, reason: 'malformed' })
    const big = forge({ ...payload, padding: 'x'.repeat(MAX_TOKEN_LENGTH) })
    expect(big.length).toBeGreaterThan(MAX_TOKEN_LENGTH)
    expect(handoff.verifyQuote(big)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('rejects any version other than 1 after the signature', () => {
    expect(handoff.verifyQuote(forge({ ...payload, v: 2 }))).toEqual({
      ok: false,
      reason: 'bad_version',
    })
    expect(handoff.verifyQuote(forge({ ...payload, v: '1' }))).toEqual({
      ok: false,
      reason: 'bad_version',
    })
  })

  it('rejects unknown keys and wrong shapes (strict schema)', () => {
    clock.value = NOW * 1000
    const bad: Record<string, unknown>[] = [
      { ...payload, extra: true },
      { ...payload, payLater: { eligible: true, source: 'merchant-sdk', more: 1 } },
      { ...payload, payLater: { eligible: true, source: 'browser' } },
      { ...payload, amountCents: 12.5 },
      { ...payload, amountCents: 0 },
      { ...payload, amountCents: -100 },
      { ...payload, amountCents: '119900' },
      { ...payload, qid: 'q_short' },
      { ...payload, qid: `x_${'a'.repeat(22)}` },
      { ...payload, productId: 'has space' },
      { ...payload, productId: 'a'.repeat(65) },
      { ...payload, item: 'x'.repeat(121) },
      { ...payload, item: '\u0000​' },
      { ...payload, merchant: 'x'.repeat(61) },
      { ...payload, replay: 'other' },
      { ...payload, currency: 'usd' },
      { ...payload, iat: 1.5 },
    ]
    for (const body of bad)
      expect(handoff.verifyQuote(forge(body)), JSON.stringify(body)).toEqual({
        ok: false,
        reason: 'bad_shape',
      })
    const { qid: _qid, ...missing } = payload
    expect(handoff.verifyQuote(forge(missing))).toEqual({ ok: false, reason: 'bad_shape' })
  })

  it('strips hidden characters from names and keeps them within their caps', () => {
    clock.value = NOW * 1000
    const token = forge({
      ...payload,
      item: 'Every\u0007day‮ camera​\n',
      merchant: ' Larkspur\u0000 Supply ',
    })
    const result = handoff.verifyQuote(token)
    expect(result).toMatchObject({
      ok: true,
      payload: { item: 'Every day camera', merchant: 'Larkspur Supply' },
    })
    expect(sanitizeName('a'.repeat(200), 120)).toHaveLength(120)
    expect(sanitizeName('\u0001x\u009fy', 60)).toBe('x y')
  })

  it('accepts returnUrl and imageUrl only on MERCHANT_ORIGIN', () => {
    clock.value = NOW * 1000
    for (const change of [
      { returnUrl: 'https://evil.example/p/camera' },
      { returnUrl: 'http://store.example/p/camera' },
      { returnUrl: 'https://store.example:444/p/camera' },
      { returnUrl: 'https://store.example.evil.example/p' },
      { returnUrl: 'https://user:pass@store.example/p' },
      { returnUrl: 'javascript:alert(1)' },
      { returnUrl: '/p/camera' },
      { imageUrl: 'https://cdn.example/camera.png' },
      { imageUrl: 'data:image/png;base64,AAAA' },
    ])
      expect(handoff.verifyQuote(forge({ ...payload, ...change })), JSON.stringify(change)).toEqual(
        { ok: false, reason: 'bad_origin' },
      )
    const { imageUrl: _image, ...noImage } = payload
    expect(handoff.verifyQuote(forge(noImage)).ok).toBe(true)
    expect(() => handoff.signQuote({ ...input, returnUrl: 'https://evil.example/' })).toThrow(
      /MERCHANT_ORIGIN/,
    )
  })

  it('reports a non-USD quote with its trusted payload, after the origin check', () => {
    clock.value = NOW * 1000
    const result = handoff.verifyQuote(forge({ ...payload, currency: 'EUR' }))
    expect(result).toMatchObject({ ok: false, reason: 'non_usd', payload: { currency: 'EUR' } })
    expect(
      handoff.verifyQuote(
        forge({ ...payload, currency: 'EUR', returnUrl: 'https://evil.example' }),
      ),
    ).toEqual({ ok: false, reason: 'bad_origin' })
  })

  it('allows at most 900 s between iat and exp', () => {
    clock.value = NOW * 1000
    expect(handoff.verifyQuote(forge({ ...payload, exp: NOW + 901 }))).toEqual({
      ok: false,
      reason: 'too_long',
    })
    expect(handoff.verifyQuote(forge({ ...payload, exp: NOW - 1 }))).toEqual({
      ok: false,
      reason: 'too_long',
    })
    expect(() => handoff.signQuote({ ...input, iat: NOW, exp: NOW + 901 })).toThrow()
  })

  it('expires after exp plus 60 s of skew, and keeps the payload for a way back', () => {
    const token = forge(payload)
    clock.value = (payload.exp + CLOCK_SKEW_S) * 1000
    expect(handoff.verifyQuote(token).ok).toBe(true)
    clock.value = (payload.exp + CLOCK_SKEW_S + 1) * 1000
    expect(handoff.verifyQuote(token)).toEqual({ ok: false, reason: 'expired', payload })
  })

  it('rejects an iat more than 60 s in the future', () => {
    clock.value = NOW * 1000
    const soon = { ...payload, iat: NOW + CLOCK_SKEW_S, exp: NOW + CLOCK_SKEW_S + 900 }
    expect(handoff.verifyQuote(forge(soon)).ok).toBe(true)
    const future = { ...payload, iat: NOW + CLOCK_SKEW_S + 1, exp: NOW + CLOCK_SKEW_S + 901 }
    expect(handoff.verifyQuote(forge(future))).toEqual({ ok: false, reason: 'future' })
  })

  it('exposes the time checks on their own', () => {
    expect(timeFailure({ iat: 0, exp: MAX_LIFETIME_S }, 10)).toBeUndefined()
    expect(timeFailure({ iat: 0, exp: MAX_LIFETIME_S + 1 }, 10)).toBe('too_long')
    expect(timeFailure({ iat: 0, exp: 100 }, 161)).toBe('expired')
    expect(timeFailure({ iat: 100, exp: 200 }, 39)).toBe('future')
  })

  it('compares signatures in constant time and refuses different lengths without throwing', () => {
    const expected = Buffer.alloc(32, 1)
    expect(signatureMatches(expected.toString('base64url'), expected)).toBe(true)
    expect(signatureMatches(expected.subarray(0, 31).toString('base64url'), expected)).toBe(false)
    expect(signatureMatches(`${expected.toString('base64url')}AA`, expected)).toBe(false)
    expect(signatureMatches('not base64url!', expected)).toBe(false)
  })

  it('needs a base64url secret of at least 32 bytes', () => {
    expect(secretBytes(undefined)).toBeUndefined()
    expect(secretBytes(Buffer.alloc(31).toString('base64url'))).toBeUndefined()
    expect(secretBytes('has spaces and + / ='.repeat(4))).toBeUndefined()
    expect(secretBytes(SECRET)).toHaveLength(32)
    expect(() => createHandoff({ ...keys, secret: 'short' })).toThrow(/32 bytes/)
  })
})

describe('result tokens (contract §4)', () => {
  it('signs a result with no money and verifies it on the store side', () => {
    clock.value = NOW * 1000
    const token = handoff.signResult({
      qid: input.qid,
      verdict: 'wait',
      fitsOn: '2026-10-23',
      payIn4Fits: true,
    })
    const result = handoff.verifyResult(token)
    expect(result).toEqual({
      ok: true,
      payload: {
        v: 1,
        kid: '1',
        mid: 'larkspur',
        qid: input.qid,
        verdict: 'wait',
        fitsOn: '2026-10-23',
        payIn4Fits: true,
        iat: NOW,
        exp: NOW + 900,
      },
    })
    expect(JSON.stringify(decode(token))).not.toMatch(/amount|cents|balance/i)
  })

  it('rejects an unknown verdict, extra fields and an expired result', () => {
    clock.value = NOW * 1000
    expect(() =>
      handoff.signResult({ qid: input.qid, verdict: 'buy_now' as 'buy_today' }),
    ).toThrow()
    const base = { v: 1, kid: '1', mid: 'larkspur', qid: input.qid, verdict: 'buy_today' }
    const times = { iat: NOW, exp: NOW + 900 }
    expect(handoff.verifyResult(forge({ ...base, ...times, amountCents: 1 }, 'result'))).toEqual({
      ok: false,
      reason: 'bad_shape',
    })
    const token = handoff.signResult({ qid: input.qid, verdict: 'buy_today' })
    clock.value = (NOW + 900 + CLOCK_SKEW_S + 1) * 1000
    expect(handoff.verifyResult(token)).toMatchObject({ ok: false, reason: 'expired' })
    clock.value = NOW * 1000
    expect(
      createHandoff({ ...keys, secret: OTHER_SECRET }).verifyResult(
        handoff.signResult({ qid: input.qid, verdict: 'spend_less' }),
      ),
    ).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('adds the result as ?worth= or &worth= and keeps the fragment last', () => {
    expect(withResult(`${ORIGIN}/p/camera`, 'T.S')).toBe(`${ORIGIN}/p/camera?worth=T.S`)
    expect(withResult(`${ORIGIN}/p/camera?ref=1`, 'T.S')).toBe(`${ORIGIN}/p/camera?ref=1&worth=T.S`)
    expect(withResult(`${ORIGIN}/p/camera?worth=old#buy`, 'T.S')).toBe(
      `${ORIGIN}/p/camera?worth=T.S#buy`,
    )
  })
})

describe('outcome report signing (contract §5)', () => {
  const outcome: OutcomePayload = {
    v: 1,
    kid: '1',
    mid: 'larkspur',
    qid: input.qid,
    orderId: '5O190127TN364715T',
    captureId: '3C679366HH908993F',
    amountCents: 119900,
    currency: 'USD',
    status: 'COMPLETED',
    capturedAt: '2026-10-23T15:04:05Z',
  }

  it('signs timestamp + "." + rawBody under the outcome label and verifies it', () => {
    clock.value = NOW * 1000
    const signed = handoff.signOutcome(outcome)
    expect(signed.headers['Worth-Handoff-Timestamp']).toBe(String(NOW))
    expect(signed.headers['Worth-Handoff-Signature']).toBe(
      createHmac('sha256', key)
        .update(`worth-handoff.v1.outcome.${NOW}.${signed.body}`)
        .digest('base64url'),
    )
    expect(outcomeSignature(key, String(NOW), signed.body)).toBe(
      signed.headers['Worth-Handoff-Signature'],
    )
    expect(
      handoff.verifyOutcome(
        signed.body,
        signed.headers['Worth-Handoff-Timestamp'],
        signed.headers['Worth-Handoff-Signature'],
      ),
    ).toEqual({ ok: true, payload: outcome })
  })

  it('rejects a changed body, a moved timestamp and a skew over 300 s', () => {
    clock.value = NOW * 1000
    const { body, headers } = handoff.signOutcome(outcome)
    const ts = headers['Worth-Handoff-Timestamp']
    const sig = headers['Worth-Handoff-Signature']
    expect(handoff.verifyOutcome(body.replace('119900', '100'), ts, sig)).toMatchObject({
      reason: 'bad_signature',
    })
    expect(handoff.verifyOutcome(body, String(NOW + 1), sig)).toMatchObject({
      reason: 'bad_signature',
    })
    expect(handoff.verifyOutcome(body, ts, undefined)).toMatchObject({ reason: 'bad_signature' })
    clock.value = (NOW + 301) * 1000
    expect(handoff.verifyOutcome(body, ts, sig)).toMatchObject({ reason: 'bad_timestamp' })
    clock.value = (NOW - 301) * 1000
    expect(handoff.verifyOutcome(body, ts, sig)).toMatchObject({ reason: 'bad_timestamp' })
    clock.value = NOW * 1000
    expect(handoff.verifyOutcome(body, 'soon', sig)).toMatchObject({ reason: 'bad_timestamp' })
  })

  it('rejects an oversize body, unknown keys and non-USD after the signature', () => {
    clock.value = NOW * 1000
    const big = handoff.signOutcome(
      JSON.stringify({ ...outcome, pad: 'x'.repeat(MAX_OUTCOME_BYTES) }),
    )
    expect(
      handoff.verifyOutcome(
        big.body,
        big.headers['Worth-Handoff-Timestamp'],
        big.headers['Worth-Handoff-Signature'],
      ),
    ).toMatchObject({ reason: 'too_large' })
    for (const [body, reason] of [
      [{ ...outcome, extra: 1 }, 'bad_shape'],
      [{ ...outcome, status: 'PENDING' }, 'bad_shape'],
      [{ ...outcome, mid: 'other' }, 'unknown_key'],
      [{ ...outcome, currency: 'EUR' }, 'non_usd'],
    ] as const) {
      const signed = handoff.signOutcome(JSON.stringify(body))
      expect(
        handoff.verifyOutcome(
          signed.body,
          signed.headers['Worth-Handoff-Timestamp'],
          signed.headers['Worth-Handoff-Signature'],
        ),
      ).toMatchObject({ reason })
    }
  })
})
