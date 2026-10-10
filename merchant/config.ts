import { randomBytes } from 'node:crypto'
import { ConfigError } from '../server/config.ts'

type Env = Record<string, string | undefined>

/** Larkspur Supply's settings. The store is a separate origin; it shares only the hand-off key. */
export interface MerchantConfig {
  /** The store's public browser origin (MERCHANT_ORIGIN). Quotes' returnUrl and imageUrl live here. */
  origin: string
  /** Worth's public origin (WORTH_ORIGIN): the Analyse link and the report-back go here. */
  worthOrigin: string
  production: boolean
  port: number
  host: string
  /** Reverse-proxy hops whose X-Forwarded-For entry is trusted as the client IP; 0 disables. */
  trustProxy: number
  /** HANDOFF_SECRET, decoded. Production refuses to start without 32 bytes of it. */
  handoffSecret: Buffer
  /** HANDOFF_MERCHANT_ID, the `mid` claim in every token. */
  merchantId: string
  paypalClientId?: string
  paypalSecret?: string
  /** The ID of the webhook registered for this store's /api/paypal/webhook. */
  paypalWebhookId?: string
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])
/** The default local ports: Worth on PORT (5173), the store on 8788. */
const STORE_PORT = 8788
const WORTH_PORT = 5173
export const MIN_SECRET_BYTES = 32

function setting(env: Env, name: string) {
  return env[name]?.trim() || undefined
}

function port(env: Env, name: string) {
  const value = setting(env, name)
  if (value === undefined) return undefined
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535)
    throw new ConfigError(`${name} must be a port from 1 to 65535; received “${value}”.`)
  return parsed
}

function origin(name: string, value: string, production: boolean) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`${name} “${value}” is not a valid URL.`)
  }
  if (
    production &&
    (url.protocol !== 'https:' ||
      LOCAL_HOSTNAMES.has(url.hostname) ||
      url.hostname.endsWith('.localhost'))
  )
    throw new ConfigError(
      `Refusing to start in production with ${name} ${url.origin}. Set it to the public https:// address.`,
    )
  return url.origin
}

/**
 * HANDOFF_SECRET is base64url. Production needs at least 32 decoded bytes; local development
 * without one gets a random per-process key, so tokens work on the store but Worth rejects them.
 */
function handoffSecret(env: Env, production: boolean) {
  const value = setting(env, 'HANDOFF_SECRET')
  if (value === undefined) {
    if (production)
      throw new ConfigError(
        'Set HANDOFF_SECRET to at least 32 random bytes (base64url), the same value Worth uses.',
      )
    return randomBytes(MIN_SECRET_BYTES)
  }
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value))
    throw new ConfigError('HANDOFF_SECRET must be base64url.')
  const key = Buffer.from(value, 'base64url')
  if (production && key.length < MIN_SECRET_BYTES)
    throw new ConfigError(
      `HANDOFF_SECRET must decode to at least ${MIN_SECRET_BYTES} bytes in production.`,
    )
  return key
}

/**
 * Reads the store's settings, mirroring server/config.ts: explicit overrides win, and the
 * production guards (https origins, the hand-off key, TRUST_PROXY) apply to the final result.
 */
export function loadMerchantConfig(
  env: Env = process.env,
  overrides: Partial<MerchantConfig> = {},
): MerchantConfig {
  const production = overrides.production ?? env.NODE_ENV === 'production'
  // Locally .env's PORT belongs to Worth, so the store reads MERCHANT_PORT; a host such as Render
  // sets PORT for this service alone.
  const listen =
    overrides.port ??
    port(env, 'MERCHANT_PORT') ??
    (production ? port(env, 'PORT') : undefined) ??
    STORE_PORT
  const worthPort = port(env, 'PORT') ?? WORTH_PORT
  const merchantId = overrides.merchantId ?? setting(env, 'HANDOFF_MERCHANT_ID') ?? 'larkspur'
  if (!/^[a-z0-9_-]{1,32}$/.test(merchantId))
    throw new ConfigError('HANDOFF_MERCHANT_ID must be 1–32 lowercase letters, digits, _ or -.')
  const config: MerchantConfig = {
    origin:
      setting(env, 'MERCHANT_ORIGIN') ??
      setting(env, 'RENDER_EXTERNAL_URL') ??
      `http://localhost:${listen}`,
    worthOrigin: setting(env, 'WORTH_ORIGIN') ?? `http://localhost:${worthPort}`,
    production,
    port: listen,
    host: setting(env, 'HOST') ?? (production ? '0.0.0.0' : '127.0.0.1'),
    trustProxy: Number(setting(env, 'TRUST_PROXY') ?? (production ? 1 : 0)),
    handoffSecret: overrides.handoffSecret ?? handoffSecret(env, production),
    merchantId,
    paypalClientId: setting(env, 'PAYPAL_CLIENT_ID'),
    paypalSecret: setting(env, 'PAYPAL_CLIENT_SECRET'),
    paypalWebhookId: setting(env, 'PAYPAL_WEBHOOK_ID'),
    ...overrides,
  }
  config.origin = origin('MERCHANT_ORIGIN', config.origin, config.production)
  config.worthOrigin = origin('WORTH_ORIGIN', config.worthOrigin, config.production)
  if (!Number.isSafeInteger(config.trustProxy) || config.trustProxy < 0 || config.trustProxy > 10)
    throw new ConfigError('TRUST_PROXY must be a whole number from 0 to 10.')
  if (config.production && config.handoffSecret.length < MIN_SECRET_BYTES)
    throw new ConfigError(
      `HANDOFF_SECRET must decode to at least ${MIN_SECRET_BYTES} bytes in production.`,
    )
  // A wrong hop count makes every visitor share one rate-limit key, so production must state it.
  if (config.production && overrides.trustProxy === undefined && !setting(env, 'TRUST_PROXY'))
    throw new ConfigError('Set TRUST_PROXY to the number of reverse proxies in front of the store.')
  return config
}
