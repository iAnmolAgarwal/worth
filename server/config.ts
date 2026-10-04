type Env = Record<string, string | undefined>

export interface AppConfig {
  /** Public browser origin. PayPal returns here and state-changing requests must come from it. */
  origin: string
  production: boolean
  port: number
  host: string
  /** Reverse-proxy hops whose X-Forwarded-For entry is trusted as the client IP; 0 disables. */
  trustProxy: number
  /** API requests per client IP per minute. */
  requestsPerMinute: number
  /** New sessions per client IP per hour. */
  sessionIpHourlyLimit: number
  /** Live sessions across the server; new visitors receive 503 beyond this. */
  maxSessions: number
  /** Stored transactions per session; imports beyond this are rejected. */
  maxTransactions: number
  /** Claude requests per client IP per hour, then labelled local answers. */
  claudeIpHourlyLimit: number
  /** Claude requests across the server per day, then labelled local answers. */
  claudeDailyLimit: number
  paypalClientId?: string
  paypalSecret?: string
  paypalWebhookId?: string
  /**
   * Allows the sandbox decline demo (`PayPal-Mock-Response: INSTRUMENT_DECLINED` on capture). On by
   * default in development; production needs PAYPAL_NEGATIVE_TESTING=true.
   */
  paypalNegativeTesting: boolean
  /** Sends the full Content-Security-Policy. On in production; the Vite dev server needs it off. */
  contentSecurityPolicy: boolean
  anthropicKey?: string
  anthropicModel: string
  /** Channel3 product search for similar items under what fits today; hidden without a key. */
  channel3ApiKey?: string
  /** live (default with a key), fixture (recorded example results only) or off. */
  channel3Mode?: 'live' | 'fixture' | 'off'
  /** Live Channel3 searches per day across the server, then recorded example results. */
  channel3DailyLimit: number
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])

function setting(env: Env, name: string) {
  return env[name]?.trim() || undefined
}

function wholeNumber(env: Env, name: string, fallback: number, min = 0, max = 1_000_000_000) {
  const value = setting(env, name)
  if (value === undefined) return fallback
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new ConfigError(
      `${name} must be a whole number from ${min} to ${max}; received “${value}”.`,
    )
  return parsed
}

function publicOrigin(value: string, production: boolean) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(
      `The app origin “${value}” is not a valid URL. Set APP_ORIGIN to the browser origin, for example https://worth.example.com.`,
    )
  }
  if (
    production &&
    (url.protocol !== 'https:' ||
      LOCAL_HOSTNAMES.has(url.hostname) ||
      url.hostname.endsWith('.localhost'))
  )
    throw new ConfigError(
      `Refusing to start in production with the origin ${url.origin}. Set APP_ORIGIN (or APP_URL / RENDER_EXTERNAL_URL) to the public https:// address of this deployment.`,
    )
  return url.origin
}

function channel3Mode(env: Env): AppConfig['channel3Mode'] {
  const value = setting(env, 'CHANNEL3_MODE')
  if (value === undefined) return undefined
  if (value === 'live' || value === 'fixture' || value === 'off') return value
  throw new ConfigError(`CHANNEL3_MODE must be live, fixture or off; received “${value}”.`)
}

/**
 * Reads deployment settings from the environment. Explicit overrides win, and the production
 * origin guard applies to the final result, so a misconfigured host refuses to start.
 */
export function loadConfig(env: Env = process.env, overrides: Partial<AppConfig> = {}): AppConfig {
  const production = overrides.production ?? env.NODE_ENV === 'production'
  const port = overrides.port ?? wholeNumber(env, 'PORT', 5173, 1, 65535)
  const config: AppConfig = {
    origin:
      setting(env, 'APP_ORIGIN') ??
      setting(env, 'APP_URL') ??
      setting(env, 'RENDER_EXTERNAL_URL') ??
      `http://localhost:${port}`,
    production,
    port,
    host: setting(env, 'HOST') ?? (production ? '0.0.0.0' : '127.0.0.1'),
    trustProxy: wholeNumber(env, 'TRUST_PROXY', production ? 1 : 0, 0, 10),
    requestsPerMinute: 180,
    sessionIpHourlyLimit: wholeNumber(env, 'SESSION_IP_HOURLY_LIMIT', 30, 1),
    maxSessions: wholeNumber(env, 'MAX_SESSIONS', 5000, 1),
    maxTransactions: wholeNumber(env, 'MAX_TRANSACTIONS', 20_000, 1),
    claudeIpHourlyLimit: wholeNumber(env, 'CLAUDE_IP_HOURLY_LIMIT', 20),
    claudeDailyLimit: wholeNumber(env, 'CLAUDE_DAILY_LIMIT', 200),
    paypalClientId: setting(env, 'PAYPAL_CLIENT_ID'),
    paypalSecret: setting(env, 'PAYPAL_CLIENT_SECRET'),
    paypalWebhookId: setting(env, 'PAYPAL_WEBHOOK_ID'),
    paypalNegativeTesting: production
      ? setting(env, 'PAYPAL_NEGATIVE_TESTING') === 'true'
      : setting(env, 'PAYPAL_NEGATIVE_TESTING') !== 'false',
    contentSecurityPolicy: production,
    anthropicKey: setting(env, 'ANTHROPIC_API_KEY'),
    anthropicModel: setting(env, 'ANTHROPIC_MODEL') ?? 'claude-sonnet-5-5',
    channel3ApiKey: setting(env, 'CHANNEL3_API_KEY'),
    channel3Mode: channel3Mode(env),
    channel3DailyLimit: wholeNumber(env, 'CHANNEL3_DAILY_LIMIT', 300),
    ...overrides,
  }
  config.origin = publicOrigin(config.origin, config.production)
  // A wrong hop count makes every visitor share one rate-limit key, so production must state it.
  if (config.production && overrides.trustProxy === undefined && !setting(env, 'TRUST_PROXY'))
    throw new ConfigError(
      'Set TRUST_PROXY to the number of reverse proxies in front of this server. Check the X-Forwarded-For hop count logged on the first request after deploying.',
    )
  return config
}

/** Origins allowed to send state-changing requests. Local development accepts both loopback names. */
export function allowedOrigins(config: AppConfig) {
  const origins = new Set([config.origin])
  if (!config.production)
    for (const hostname of ['localhost', '127.0.0.1'])
      origins.add(`http://${hostname}:${config.port}`)
  return origins
}
