import { secretBytes } from '../shared/handoff.ts'

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
  /** Live Channel3 searches per client IP per hour; cached results do not count. */
  channel3IpHourlyLimit: number
  /** Requests to /mcp per client IP per minute, counted before the token is checked. */
  mcpIpPerMinute: number
  /** Requests to /mcp per agent token per minute. */
  mcpTokenPerMinute: number
  /** Failed agent-token checks per client IP per 15 minutes, then /mcp refuses that IP. */
  mcpAuthFailures: number
  /** Agent tokens one plan may have active at once. */
  maxAgentTokens: number
  /**
   * The key shared with the demo store for signed hand-offs (specs/handoff-contract.md §1):
   * base64url, at least 32 bytes. Without it and MERCHANT_ORIGIN, /check can't verify any link.
   */
  handoffSecret?: string
  /** The one store origin a hand-off may return to. Production: https only. */
  merchantOrigin?: string
  /** The `mid` claim the store signs with. */
  handoffMerchantId: string
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

/** MERCHANT_ORIGIN as an origin, held to the same production rules as APP_ORIGIN. */
function merchantOrigin(value: string, production: boolean) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(
      `MERCHANT_ORIGIN “${value}” is not a valid URL. Set it to the demo store's origin, for example https://store.example.com.`,
    )
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new ConfigError('MERCHANT_ORIGIN must be an http(s) origin.')
  if (
    production &&
    (url.protocol !== 'https:' ||
      LOCAL_HOSTNAMES.has(url.hostname) ||
      url.hostname.endsWith('.localhost'))
  )
    throw new ConfigError(
      `Refusing to start in production with the store origin ${url.origin}. Set MERCHANT_ORIGIN to the demo store's public https:// address.`,
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
    channel3IpHourlyLimit: wholeNumber(env, 'CHANNEL3_IP_HOURLY_LIMIT', 20, 1),
    mcpIpPerMinute: wholeNumber(env, 'MCP_IP_PER_MINUTE', 120, 1),
    mcpTokenPerMinute: wholeNumber(env, 'MCP_TOKEN_PER_MINUTE', 30, 1),
    mcpAuthFailures: 20,
    maxAgentTokens: 3,
    handoffSecret: setting(env, 'HANDOFF_SECRET'),
    merchantOrigin: setting(env, 'MERCHANT_ORIGIN'),
    handoffMerchantId: setting(env, 'HANDOFF_MERCHANT_ID') ?? 'larkspur',
    ...overrides,
  }
  config.origin = publicOrigin(config.origin, config.production)
  // Hand-offs are off until both are set (contract §1). A partial or invalid setting is refused in
  // production, where it can only be a mistake; both unset runs with the hand-off off.
  if (config.handoffSecret !== undefined && !secretBytes(config.handoffSecret))
    throw new ConfigError(
      "HANDOFF_SECRET must be base64url and at least 32 bytes once decoded. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
    )
  if (config.merchantOrigin !== undefined)
    config.merchantOrigin = merchantOrigin(config.merchantOrigin, config.production)
  if (config.production && Boolean(config.handoffSecret) !== Boolean(config.merchantOrigin))
    throw new ConfigError(
      `Set both HANDOFF_SECRET and MERCHANT_ORIGIN, or neither: ${config.handoffSecret ? 'MERCHANT_ORIGIN' : 'HANDOFF_SECRET'} is unset, so store hand-offs can't be verified.`,
    )
  if (!/^[a-z0-9_-]{1,32}$/.test(config.handoffMerchantId))
    throw new ConfigError('HANDOFF_MERCHANT_ID must be 1–32 lowercase letters, digits, _ or -.')
  // A wrong hop count makes every visitor share one rate-limit key, so production must state it.
  if (config.production && overrides.trustProxy === undefined && !setting(env, 'TRUST_PROXY'))
    throw new ConfigError(
      'Set TRUST_PROXY to the number of reverse proxies in front of this server. Check the X-Forwarded-For hop count logged on the first request after deploying.',
    )
  return config
}

/** Whether signed hand-offs from the store can be verified here. */
export function handoffEnabled(
  config: AppConfig,
): config is AppConfig & { handoffSecret: string; merchantOrigin: string } {
  return Boolean(config.handoffSecret && config.merchantOrigin)
}

/** The one start-up line when hand-offs are off, naming the unset settings, never any value. */
export function handoffStatusLine(config: AppConfig): string | undefined {
  if (handoffEnabled(config)) return undefined
  const unset = [
    ...(config.handoffSecret ? [] : ['HANDOFF_SECRET']),
    ...(config.merchantOrigin ? [] : ['MERCHANT_ORIGIN']),
  ]
  return `Store hand-off is off: ${unset.join(' and ')} ${unset.length > 1 ? 'are' : 'is'} unset.`
}

/** Origins allowed to send state-changing requests. Local development accepts both loopback names. */
export function allowedOrigins(config: AppConfig) {
  const origins = new Set([config.origin])
  if (!config.production)
    for (const hostname of ['localhost', '127.0.0.1'])
      origins.add(`http://${hostname}:${config.port}`)
  return origins
}
