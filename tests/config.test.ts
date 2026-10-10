import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../server/app.ts'
import { allowedOrigins, ConfigError, handoffEnabled, loadConfig } from '../server/config.ts'
import { WindowLimiter } from '../server/limits.ts'
import { Store } from '../server/store.ts'

/** The hand-off key and store origin production requires (specs/handoff-contract.md §1). */
const HANDOFF = {
  HANDOFF_SECRET: Buffer.alloc(32, 1).toString('base64url'),
  MERCHANT_ORIGIN: 'https://store.example',
}
const handoff = {
  handoffSecret: HANDOFF.HANDOFF_SECRET,
  merchantOrigin: HANDOFF.MERCHANT_ORIGIN,
}

describe('deployment configuration', () => {
  it('prefers APP_ORIGIN, then APP_URL, then RENDER_EXTERNAL_URL, then the local port', () => {
    const render = { RENDER_EXTERNAL_URL: 'https://worth.onrender.com' }
    expect(loadConfig({}).origin).toBe('http://localhost:5173')
    expect(loadConfig({ PORT: '8080' }).origin).toBe('http://localhost:8080')
    expect(loadConfig(render).origin).toBe('https://worth.onrender.com')
    expect(loadConfig({ ...render, APP_URL: 'https://app.example' }).origin).toBe(
      'https://app.example',
    )
    expect(
      loadConfig({ ...render, APP_URL: 'https://app.example', APP_ORIGIN: 'https://o.example/' })
        .origin,
    ).toBe('https://o.example')
    expect(loadConfig({ APP_ORIGIN: '  ', APP_URL: 'https://app.example' }).origin).toBe(
      'https://app.example',
    )
  })

  it('reads the Channel3 key, mode and daily limit, and rejects an unknown mode', () => {
    expect(loadConfig({})).toMatchObject({ channel3ApiKey: undefined, channel3DailyLimit: 300 })
    expect(
      loadConfig({ CHANNEL3_API_KEY: ' k ', CHANNEL3_MODE: 'fixture', CHANNEL3_DAILY_LIMIT: '50' }),
    ).toMatchObject({ channel3ApiKey: 'k', channel3Mode: 'fixture', channel3DailyLimit: 50 })
    expect(() => loadConfig({ CHANNEL3_MODE: 'sometimes' })).toThrow(ConfigError)
  })

  it('refuses to start in production on a local or plain-http origin', () => {
    for (const origin of [
      'http://localhost:5173',
      'https://localhost',
      'https://127.0.0.1:10000',
      'https://[::1]:443',
      'http://worth.example.com',
    ])
      expect(() => loadConfig({ NODE_ENV: 'production', APP_ORIGIN: origin })).toThrow(
        /Refusing to start in production/,
      )
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(ConfigError)
    const store = new Store(':memory:')
    expect(() =>
      createApp({ store, config: { production: true, origin: 'http://localhost' } }),
    ).toThrow(/APP_ORIGIN/)
    store.close()
    expect(() => loadConfig({ APP_ORIGIN: 'not a url' })).toThrow(/not a valid URL/)
    expect(
      loadConfig({
        ...HANDOFF,
        NODE_ENV: 'production',
        TRUST_PROXY: '1',
        RENDER_EXTERNAL_URL: 'https://worth.onrender.com',
      }).origin,
    ).toBe('https://worth.onrender.com')
  })

  it('leaves hand-offs off locally until the key and the store origin are both set', () => {
    expect(handoffEnabled(loadConfig({}))).toBe(false)
    expect(handoffEnabled(loadConfig({ HANDOFF_SECRET: HANDOFF.HANDOFF_SECRET }))).toBe(false)
    expect(handoffEnabled(loadConfig({ MERCHANT_ORIGIN: 'http://localhost:8788' }))).toBe(false)
    const local = loadConfig({ ...HANDOFF, MERCHANT_ORIGIN: 'http://localhost:8788/p/x' })
    expect(handoffEnabled(local)).toBe(true)
    expect(local).toMatchObject({
      merchantOrigin: 'http://localhost:8788',
      handoffMerchantId: 'larkspur',
    })
    expect(loadConfig({ HANDOFF_MERCHANT_ID: 'other_1' }).handoffMerchantId).toBe('other_1')
    expect(() => loadConfig({ HANDOFF_MERCHANT_ID: 'Has Space' })).toThrow(/HANDOFF_MERCHANT_ID/)
  })

  it('refuses a hand-off key shorter than 32 bytes or not base64url, in any environment', () => {
    const short = Buffer.alloc(31, 1).toString('base64url')
    expect(() => loadConfig({ HANDOFF_SECRET: short })).toThrow(/at least 32 bytes/)
    expect(() => loadConfig({ HANDOFF_SECRET: 'not base64url/+='.repeat(4) })).toThrow(
      /HANDOFF_SECRET/,
    )
    expect(() => loadConfig({ MERCHANT_ORIGIN: 'not a url' })).toThrow(/MERCHANT_ORIGIN/)
    expect(() => loadConfig({ MERCHANT_ORIGIN: 'ftp://store.example' })).toThrow(/MERCHANT_ORIGIN/)
  })

  it('refuses to start in production without the hand-off key or an https store origin', () => {
    const hosted = { NODE_ENV: 'production', TRUST_PROXY: '1', APP_ORIGIN: 'https://w.example' }
    expect(() => loadConfig(hosted)).toThrow(/HANDOFF_SECRET and MERCHANT_ORIGIN/)
    expect(() => loadConfig({ ...hosted, HANDOFF_SECRET: HANDOFF.HANDOFF_SECRET })).toThrow(
      /HANDOFF_SECRET and MERCHANT_ORIGIN/,
    )
    expect(() => loadConfig({ ...hosted, MERCHANT_ORIGIN: HANDOFF.MERCHANT_ORIGIN })).toThrow(
      /HANDOFF_SECRET and MERCHANT_ORIGIN/,
    )
    for (const origin of ['http://store.example', 'https://localhost:8788', 'https://s.localhost'])
      expect(() => loadConfig({ ...hosted, ...HANDOFF, MERCHANT_ORIGIN: origin })).toThrow(
        /store origin/,
      )
    expect(handoffEnabled(loadConfig({ ...hosted, ...HANDOFF }))).toBe(true)
    const store = new Store(':memory:')
    expect(() =>
      createApp({
        store,
        config: { production: true, trustProxy: 1, origin: 'https://w.example' },
      }),
    ).toThrow(/HANDOFF_SECRET/)
    expect(() =>
      createApp({
        store,
        config: { production: true, trustProxy: 1, origin: 'https://w.example', ...handoff },
      }),
    ).not.toThrow()
    store.close()
  })

  it('binds every interface in production and loopback otherwise', () => {
    const hosted = { ...HANDOFF, APP_ORIGIN: 'https://worth.example.com', TRUST_PROXY: '1' }
    expect(loadConfig({ ...hosted, NODE_ENV: 'production' }).host).toBe('0.0.0.0')
    expect(loadConfig({}).host).toBe('127.0.0.1')
    expect(loadConfig({ HOST: '::' }).host).toBe('::')
    expect(() => loadConfig({ PORT: 'eighty' })).toThrow(/PORT must be a whole number/)
  })

  it('accepts both loopback names on the configured port only in development', () => {
    expect([...allowedOrigins(loadConfig({ PORT: '4000' }))].sort()).toEqual([
      'http://127.0.0.1:4000',
      'http://localhost:4000',
    ])
    expect([
      ...allowedOrigins(
        loadConfig({
          ...HANDOFF,
          NODE_ENV: 'production',
          TRUST_PROXY: '1',
          APP_ORIGIN: 'https://w.example',
        }),
      ),
    ]).toEqual(['https://w.example'])
  })

  it('lets a local browser on 127.0.0.1 write when the origin is localhost', async () => {
    const store = new Store(':memory:')
    const app = createApp({
      store,
      config: { production: false, origin: 'http://localhost:5173', port: 5173 },
    })
    const write = (origin: string) =>
      request(app)
        .post('/api/wishlist')
        .set('X-Worth-Client', 'web')
        .set('Origin', origin)
        .send({ productId: 'headphones' })
    expect((await write('http://127.0.0.1:5173')).status).toBe(200)
    expect((await write('http://localhost:5173')).status).toBe(200)
    expect((await write('http://127.0.0.1:5174')).status).toBe(403)
    expect((await write('https://attacker.example')).status).toBe(403)
    store.close()
  })
})

describe('hosted PayPal return', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('sends buyers back to the Render origin when only RENDER_EXTERNAL_URL is set', async () => {
    const origin = 'https://worth.onrender.com'
    const bodies: { return_url?: string; cancel_url?: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/v1/oauth2/token'))
          return Response.json({ access_token: 'stub', expires_in: 3600 })
        if (!url.endsWith('/v2/checkout/orders')) throw new Error(`Unexpected call to ${url}`)
        const body = JSON.parse(String(init!.body))
        bodies.push(body.payment_source.paypal.experience_context)
        return Response.json({
          id: 'ORDER1',
          status: 'PAYER_ACTION_REQUIRED',
          purchase_units: [{ ...body.purchase_units[0], payee: { merchant_id: 'M1' } }],
          links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?t=1' }],
        })
      }),
    )
    const store = new Store(':memory:')
    const config = loadConfig({
      ...HANDOFF,
      NODE_ENV: 'production',
      TRUST_PROXY: '1',
      RENDER_EXTERNAL_URL: origin,
      PAYPAL_CLIENT_ID: 'sandbox-id',
      PAYPAL_CLIENT_SECRET: 'sandbox-secret',
    })
    const app = createApp({ store, config })
    const created = await request(app)
      .post('/api/checkout/create')
      .set('X-Worth-Client', 'web')
      .set('Origin', origin)
      .send({ productId: 'headphones' })
    expect(created.status).toBe(200)
    expect(created.body.mode).toBe('sandbox')
    const id = encodeURIComponent(created.body.purchase.id)
    expect(bodies).toEqual([
      expect.objectContaining({
        return_url: `${origin}/api/checkout/${id}/return?paypal=approved`,
        cancel_url: `${origin}/api/checkout/${id}/return?paypal=cancelled`,
      }),
    ])
    store.close()
  })
})

describe('window limiter', () => {
  it('counts per key, resets after the window, and bounds tracked keys', () => {
    const limiter = new WindowLimiter(2, 1000, 3)
    expect([limiter.take('a', 0), limiter.take('a', 1), limiter.take('a', 2)]).toEqual([
      true,
      true,
      false,
    ])
    expect(limiter.take('b', 2)).toBe(true)
    expect(limiter.take('a', 1000)).toBe(true)
    for (const key of ['c', 'd', 'e', 'f']) limiter.take(key, 1001)
    expect(
      (limiter as unknown as { windows: Map<string, unknown> }).windows.size,
    ).toBeLessThanOrEqual(3)
  })
  it('reads the trusted proxy hop count from TRUST_PROXY', () => {
    expect(loadConfig({}).trustProxy).toBe(0)
    const hosted = { ...HANDOFF, NODE_ENV: 'production', APP_ORIGIN: 'https://w.example' }
    expect(() => loadConfig(hosted)).toThrow(/Set TRUST_PROXY/)
    expect(loadConfig({ ...hosted, TRUST_PROXY: '1' }).trustProxy).toBe(1)
    expect(loadConfig({ ...hosted, TRUST_PROXY: '0' }).trustProxy).toBe(0)
    expect(loadConfig({ TRUST_PROXY: '2' }).trustProxy).toBe(2)
    expect(() => loadConfig({ TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/)
  })
})

describe('Render blueprint', () => {
  it('keeps the hosted decline demo off unless turned on deliberately', () => {
    const blueprint = readFileSync(new URL('../render.yaml', import.meta.url), 'utf8')
    expect(blueprint).toMatch(/key: PAYPAL_NEGATIVE_TESTING\n\s+value: 'false'/)
  })
  it('asks for the hand-off key and store origin, which production needs to start', () => {
    const blueprint = readFileSync(new URL('../render.yaml', import.meta.url), 'utf8')
    expect(blueprint).toMatch(/key: HANDOFF_SECRET\n\s+sync: false/)
    expect(blueprint).toMatch(/key: MERCHANT_ORIGIN\n\s+sync: false/)
    expect(blueprint).toMatch(/key: HANDOFF_MERCHANT_ID\n\s+value: larkspur/)
  })
})
