import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../server/app.ts'
import { allowedOrigins, ConfigError, loadConfig } from '../server/config.ts'
import { Store } from '../server/store.ts'

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
      loadConfig({ NODE_ENV: 'production', RENDER_EXTERNAL_URL: 'https://worth.onrender.com' })
        .origin,
    ).toBe('https://worth.onrender.com')
  })

  it('binds every interface in production and loopback otherwise', () => {
    const hosted = { APP_ORIGIN: 'https://worth.example.com' }
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
      ...allowedOrigins(loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://w.example' })),
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
