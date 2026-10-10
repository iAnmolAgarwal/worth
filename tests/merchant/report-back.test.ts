import { describe, expect, it, vi } from 'vitest'
import { createHandoff } from '../../shared/handoff.ts'
import { reportOutcome } from '../../merchant/reportBack.ts'
import { utcTime } from '../../merchant/app.ts'
import { outcomeSchema } from '../../shared/handoff.ts'

const handoff = createHandoff({
  secret: Buffer.alloc(32, 1),
  mid: 'larkspur',
  merchantOrigin: 'https://larkspur.example',
})
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
type Reply = Response | Error | (() => Promise<Response>)
function transport(replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    const next = replies.shift()
    if (!next) throw new Error('unexpected call')
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next() : next
  })
  const sleep = vi.fn(async (_ms: number) => {})
  const log = vi.fn()
  return {
    calls,
    sleep,
    log,
    options: {
      worthOrigin: 'https://worth.example',
      handoff,
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep,
      log,
    },
  }
}

describe('report-back sender', () => {
  it('posts the signed body to Worth’s outcome endpoint', async () => {
    const t = transport([Response.json({ recorded: true })])
    expect(await reportOutcome(body, t.options)).toBe('sent')
    const [call] = t.calls
    expect(call!.url).toBe('https://worth.example/api/handoff/outcome')
    expect(call!.init.method).toBe('POST')
    expect(JSON.parse(String(call!.init.body))).toEqual(body)
    const headers = call!.init.headers as Record<string, string>
    expect(headers['Worth-Handoff-Signature']).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(headers['Worth-Handoff-Timestamp']).toMatch(/^\d+$/)
    expect(call!.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('retries a 5xx, a 429 and a network failure, at most twice', async () => {
    const ok = transport([
      new TypeError('fetch failed'),
      new Response('', { status: 429 }),
      Response.json({}),
    ])
    expect(await reportOutcome(body, ok.options)).toBe('sent')
    expect(ok.calls).toHaveLength(3)
    expect(ok.sleep).toHaveBeenCalledTimes(2)

    const down = transport([
      new Response('', { status: 503 }),
      new Response('', { status: 502 }),
      new Response('', { status: 500 }),
    ])
    expect(await reportOutcome(body, down.options)).toBe('failed')
    expect(down.calls).toHaveLength(3)
    expect(down.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'report_failed' }))
  })

  it('does not retry a rejection', async () => {
    const t = transport([new Response('', { status: 401 })])
    expect(await reportOutcome(body, t.options)).toBe('rejected')
    expect(t.calls).toHaveLength(1)
  })

  it('gives each attempt a timeout and never throws', async () => {
    // Each attempt hangs until its abort signal fires.
    const hang = (init: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason)),
      )
    const calls: RequestInit[] = []
    const fetch = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => {
      calls.push(init)
      return hang(init)
    })
    const log = vi.fn()
    const result = await reportOutcome(body, {
      worthOrigin: 'https://worth.example',
      handoff,
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: async () => {},
      log,
      timeoutMs: 20,
    })
    expect(result).toBe('failed')
    expect(calls).toHaveLength(3)
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ issue: 'TIMEOUT' }))
  })

  it('never logs the signature or the body', async () => {
    const t = transport([
      new Response('', { status: 500 }),
      new Error('x'),
      new Response('', { status: 400 }),
    ])
    await reportOutcome(body, t.options)
    const logged = JSON.stringify(t.log.mock.calls)
    expect(logged).not.toContain('q_AAAA')
    expect(logged).not.toContain('Signature')
  })
})

describe('the capture time the store sends', () => {
  it('passes PayPal’s UTC time through and converts an offset, so Worth’s schema takes it', () => {
    expect(utcTime('2026-10-23T15:04:05Z')).toBe('2026-10-23T15:04:05Z')
    expect(utcTime('2026-10-23T11:04:05-04:00')).toBe('2026-10-23T15:04:05.000Z')
    for (const value of ['2026-10-23T15:04:05Z', '2026-10-23T11:04:05-04:00'])
      expect(outcomeSchema.shape.capturedAt.safeParse(utcTime(value)).success).toBe(true)
    expect(utcTime('not a time')).toBeUndefined()
    expect(utcTime(undefined)).toBeUndefined()
  })
})
