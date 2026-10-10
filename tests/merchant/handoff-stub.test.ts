import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createHandoff, type QuotePayload } from '../../merchant/handoff-stub.ts'

// The store's stub of the hand-off contract (specs/handoff-contract.md §2–§5).

const SECRET = Buffer.alloc(32, 7)
const T0 = 1_791_000_000
function handoff(at = T0, secret = SECRET, merchantId = 'larkspur') {
  return createHandoff({ secret, merchantId, now: () => at * 1000 })
}
const quote: QuotePayload = {
  v: 1,
  kid: '1',
  mid: 'larkspur',
  qid: 'q_AAAAAAAAAAAAAAAAAAAAAA',
  item: 'Everyday camera',
  productId: 'camera',
  amountCents: 119900,
  currency: 'USD',
  merchant: 'Larkspur Supply',
  returnUrl: 'https://store.example/p/camera',
  iat: T0,
  exp: T0 + 900,
}
const result = {
  v: 1,
  kid: '1',
  mid: 'larkspur',
  qid: 'q_AAAAAAAAAAAAAAAAAAAAAA',
  verdict: 'wait',
  fitsOn: '2026-10-23',
  iat: T0,
  exp: T0 + 900,
}

describe('hand-off token format', () => {
  it('signs a quote as base64url JSON plus an HMAC over the direction-labelled payload', () => {
    const token = handoff().signQuote(quote)
    const [payload, sig] = token.split('.')
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'))).toEqual(quote)
    const expected = createHmac('sha256', SECRET)
      .update(`worth-handoff.v1.quote.${payload}`)
      .digest('base64url')
    expect(sig).toBe(expected)
  })

  it('round-trips a quote, and the quote expires after 15 minutes plus the skew', () => {
    const token = handoff().signQuote(quote)
    expect(handoff(T0 + 10).open('quote', token)).toEqual(quote)
    expect(handoff(T0 + 900 + 60).open('quote', token)).toEqual(quote)
    expect(handoff(T0 + 900 + 61).open('quote', token)).toBeUndefined()
  })

  it('refuses to sign a quote that lives longer than 15 minutes', () => {
    expect(() => handoff().signQuote({ ...quote, exp: T0 + 901 })).toThrow()
    expect(() => handoff().signQuote({ ...quote, exp: T0 })).toThrow()
  })

  it('never accepts a token in the other direction, with another key or tampered', () => {
    const h = handoff()
    const token = h.signQuote(quote)
    expect(h.open('result', token)).toBeUndefined()
    expect(h.verifyResult(token)).toBeUndefined()
    expect(handoff(T0, Buffer.alloc(32, 8)).open('quote', token)).toBeUndefined()
    const [payload, sig] = token.split('.') as [string, string]
    const forged = Buffer.from(JSON.stringify({ ...quote, amountCents: 100 })).toString('base64url')
    expect(h.open('quote', `${forged}.${sig}`)).toBeUndefined()
    expect(h.open('quote', `${payload}.${sig.slice(0, -2)}`)).toBeUndefined()
    expect(h.open('quote', `${payload}.${sig}.x`)).toBeUndefined()
    expect(h.open('quote', `${payload}.${sig}=`)).toBeUndefined()
    expect(h.open('quote', 42)).toBeUndefined()
  })

  it('accepts only the canonical 43-character signature', () => {
    const h = handoff()
    const [payload, sig] = h.signQuote(quote).split('.') as [string, string]
    expect(sig).toHaveLength(43)
    // The last character's two low bits are padding: flipping one decodes to the same MAC bytes.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const last = alphabet[alphabet.indexOf(sig.at(-1)!) ^ 1]!
    const malleated = `${sig.slice(0, -1)}${last}`
    expect(Buffer.from(malleated, 'base64url').equals(Buffer.from(sig, 'base64url'))).toBe(true)
    expect(h.open('quote', `${payload}.${malleated}`)).toBeUndefined()
    expect(h.open('quote', `${payload}.${sig}A`)).toBeUndefined()
    expect(h.open('quote', `${payload}.${sig}`)).toEqual(quote)
  })

  it('rejects a token over 4 KB before decoding it', () => {
    const h = handoff()
    const big = h.sign('quote', { ...quote, item: 'x'.repeat(4000) })
    expect(big.length).toBeGreaterThan(4096)
    expect(h.open('quote', big)).toBeUndefined()
  })

  it('checks the version, key ID and merchant ID', () => {
    const h = handoff()
    expect(h.open('quote', h.sign('quote', { ...quote, v: 2 }))).toBeUndefined()
    expect(h.open('quote', h.sign('quote', { ...quote, kid: '2' }))).toBeUndefined()
    expect(handoff(T0, SECRET, 'other').open('quote', h.signQuote(quote))).toBeUndefined()
  })
})

describe('verifyResult', () => {
  it('accepts a valid result from Worth', () => {
    const h = handoff()
    expect(h.verifyResult(h.sign('result', result))).toEqual(result)
    const today = { ...result, verdict: 'buy_today', payIn4Fits: true }
    delete (today as { fitsOn?: string }).fitsOn
    expect(h.verifyResult(h.sign('result', today))).toEqual(today)
  })

  it('rejects expired, future-dated and over-long results', () => {
    const h = handoff()
    expect(handoff(T0 + 961).verifyResult(h.sign('result', result))).toBeUndefined()
    expect(h.verifyResult(h.sign('result', { ...result, iat: T0 + 61, exp: T0 + 300 }))).toBe(
      undefined,
    )
    expect(h.verifyResult(h.sign('result', { ...result, exp: T0 + 901 }))).toBeUndefined()
    expect(h.verifyResult(h.sign('result', { ...result, iat: T0 + 1.5 }))).toBeUndefined()
  })

  it('is strict about the shape: unknown keys, money or bad values are rejected', () => {
    const h = handoff()
    expect(h.verifyResult(h.sign('result', { ...result, amountCents: 1 }))).toBeUndefined()
    expect(h.verifyResult(h.sign('result', { ...result, verdict: 'yes' }))).toBeUndefined()
    expect(h.verifyResult(h.sign('result', { ...result, fitsOn: 'Oct 23' }))).toBeUndefined()
    expect(h.verifyResult(h.sign('result', { ...result, qid: 'x' }))).toBeUndefined()
    expect(h.verifyResult(h.sign('result', [result]))).toBeUndefined()
  })
})

describe('signOutcome', () => {
  it('signs the exact body with the timestamp under the outcome label', () => {
    const body = {
      v: 1 as const,
      kid: '1',
      mid: 'larkspur',
      qid: 'q_AAAAAAAAAAAAAAAAAAAAAA',
      orderId: 'ORDER1',
      captureId: 'CAP1',
      amountCents: 119900,
      currency: 'USD' as const,
      status: 'COMPLETED' as const,
      capturedAt: '2026-10-23T15:04:05Z',
    }
    const signed = handoff().signOutcome(body)
    expect(JSON.parse(signed.body)).toEqual(body)
    expect(signed.headers['Worth-Handoff-Timestamp']).toBe(String(T0))
    expect(signed.headers['Content-Type']).toBe('application/json')
    expect(signed.headers['Worth-Handoff-Signature']).toBe(
      createHmac('sha256', SECRET)
        .update(`worth-handoff.v1.outcome.${T0}.${signed.body}`)
        .digest('base64url'),
    )
  })
})
