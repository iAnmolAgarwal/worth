import { describe, expect, it } from 'vitest'
import { loadMerchantConfig } from '../../merchant/config.ts'
import { ConfigError } from '../../server/config.ts'

const SECRET = Buffer.alloc(32, 3).toString('base64url')
const PROD = {
  NODE_ENV: 'production',
  MERCHANT_ORIGIN: 'https://larkspur.example',
  WORTH_ORIGIN: 'https://worth-paypal.onrender.com',
  HANDOFF_SECRET: SECRET,
  TRUST_PROXY: '2',
  PORT: '10000',
}

describe('store configuration', () => {
  it('defaults to the store on 8788 and Worth on its PORT locally', () => {
    const config = loadMerchantConfig({})
    expect(config).toMatchObject({
      origin: 'http://localhost:8788',
      worthOrigin: 'http://localhost:5173',
      port: 8788,
      host: '127.0.0.1',
      merchantId: 'larkspur',
      production: false,
    })
    // Without a key, development gets a random throwaway one.
    expect(config.handoffSecret.length).toBe(32)
    // .env's PORT belongs to Worth locally; the store keeps its own port.
    expect(loadMerchantConfig({ PORT: '8787' })).toMatchObject({
      port: 8788,
      worthOrigin: 'http://localhost:8787',
    })
    expect(loadMerchantConfig({ MERCHANT_PORT: '9000' }).origin).toBe('http://localhost:9000')
  })

  it('reads the production settings and the host’s PORT', () => {
    const config = loadMerchantConfig(PROD)
    expect(config).toMatchObject({
      origin: 'https://larkspur.example',
      worthOrigin: 'https://worth-paypal.onrender.com',
      port: 10000,
      host: '0.0.0.0',
      trustProxy: 2,
    })
    expect(config.handoffSecret.equals(Buffer.alloc(32, 3))).toBe(true)
    expect(
      loadMerchantConfig({
        ...PROD,
        MERCHANT_ORIGIN: '',
        RENDER_EXTERNAL_URL: 'https://s.onrender.com',
      }).origin,
    ).toBe('https://s.onrender.com')
  })

  it('refuses to start in production on plain-http or local origins', () => {
    for (const [key, value] of [
      ['MERCHANT_ORIGIN', 'http://larkspur.example'],
      ['MERCHANT_ORIGIN', 'https://localhost:8788'],
      ['WORTH_ORIGIN', 'http://worth.example'],
      ['WORTH_ORIGIN', 'https://127.0.0.1'],
      ['WORTH_ORIGIN', 'not a url'],
    ])
      expect(() => loadMerchantConfig({ ...PROD, [key!]: value })).toThrow(ConfigError)
  })

  it('refuses to start in production without a 32-byte hand-off key', () => {
    expect(() => loadMerchantConfig({ ...PROD, HANDOFF_SECRET: '' })).toThrow(/HANDOFF_SECRET/)
    expect(() =>
      loadMerchantConfig({ ...PROD, HANDOFF_SECRET: Buffer.alloc(31).toString('base64url') }),
    ).toThrow(/32 bytes/)
    expect(() => loadMerchantConfig({ ...PROD, HANDOFF_SECRET: 'not base64!' })).toThrow(
      ConfigError,
    )
  })

  it('requires TRUST_PROXY in production and a well-formed merchant ID', () => {
    expect(() => loadMerchantConfig({ ...PROD, TRUST_PROXY: '' })).toThrow(/TRUST_PROXY/)
    expect(() => loadMerchantConfig({ HANDOFF_MERCHANT_ID: 'Lark spur' })).toThrow(ConfigError)
  })
})
