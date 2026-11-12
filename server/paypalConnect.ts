import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Express, Request, Response } from 'express'
import { CSV_IMPORT_LIMITS, utf8Bytes } from '../shared/limits.ts'
import { WindowLimiter } from './limits.ts'
import { memoryVault } from './paypalVault.ts'
import type { LinkVault } from './paypalVault.ts'

/**
 * "Connect PayPal" (final-day plan §2): the user logs in at PayPal and Worth reads their activity
 * through PayPal's hosted MCP server, which is the only route that gives a third-party app a
 * shopper's own transactions (Log in with PayPal grants identity scopes only, and Transaction Search
 * reads only the app owner's account). OAuth 2.1 code + PKCE against the MCP server, with a client
 * registered there dynamically; then plain JSON-RPC over fetch, because the MCP SDK client fails on
 * this server's tool schemas. Sandbox only, like paypal.ts.
 *
 * Tokens are keyed by the Worth session that started the login and never reach a cookie, a response
 * body, a URL or a log. The access token stays in this process's memory for under an hour. The
 * refresh token, which keeps PayPal connected so Worth can re-read the activity, goes to the
 * session's link vault (paypalVault.ts: sealed with PAYPAL_TOKEN_KEY, or memory only), only ever
 * the newest one PayPal issued, and is used one refresh at a time. Disconnecting, deleting the
 * session's data or PayPal refusing the refresh token removes it.
 */
export const MCP_ORIGIN = 'https://mcp.sandbox.paypal.com'
export const CALLBACK_PATH = '/api/paypal/connect/callback'
/**
 * The only MCP tools Worth may call. The same token can create and send invoices; Worth must never
 * be able to, so every tool call goes through callTool, which refuses anything else before any
 * request is made. PayPal's MCP server ignores a narrower `scope`, so this is the guard.
 */
export const ALLOWED_TOOLS: ReadonlySet<string> = new Set(['list_transactions'])

/** A login must come back within this; the state and PKCE verifier are single-use. */
const STATE_TTL_MS = 10 * 60_000
/** An access token is used for at most this long (PayPal's own lifetime is an hour), less a margin. */
const ACCESS_TTL_MS = 55 * 60_000
/**
 * The health gate: an MCP session that hasn't opened in this long counts as PayPal being down for
 * that visitor, whose browser then hides Connect for the visit. Measured starts are 11–12 s.
 */
const SESSION_TIMEOUT_MS = 25_000
/** Consecutive timed-out sessions, across visitors, after which Connect is reported unavailable. */
const TIMEOUTS_TO_GATE = 2
/** How long Connect is then reported unavailable to everyone. */
const UNAVAILABLE_MS = 60_000
const CALL_TIMEOUT_MS = 30_000
const OAUTH_TIMEOUT_MS = 10_000
/** Transaction search allows at most 31 days per request; a minute less keeps clear of the edge. */
const WINDOW_MS = 31 * 86_400_000 - 60_000
/** Six windows: about 186 days of history, the most Worth asks for. */
const MAX_WINDOWS = 6
const MAX_PAGES = 20
const PAGE_SIZE = 500
const MAX_PENDING = 1_000

export type ConnectResult = 'connected' | 'denied' | 'expired' | 'failed'
export type ConnectStatus = 'on' | 'off' | 'unavailable'

const ERRORS = {
  NOT_CONNECTED: [
    409,
    'Worth no longer has access to your PayPal activity. Connect PayPal again, or use a CSV export.',
  ],
  MCP_TIMEOUT: [
    503,
    'PayPal’s MCP server didn’t answer in time. Use a CSV export instead, or try again later.',
  ],
  MCP_FAILED: [
    502,
    'PayPal couldn’t return your activity just now. Try again, or use a CSV export.',
  ],
  BUSY: [409, 'Worth is already reading your PayPal activity.'],
  TOOL_REFUSED: [500, 'Worth can only read your PayPal activity.'],
  /** Internal: a held access token PayPal no longer accepts; refreshed once, never shown. */
  STALE_ACCESS: [
    502,
    'PayPal couldn’t return your activity just now. Try again, or use a CSV export.',
  ],
} as const
export type ConnectErrorCode = keyof typeof ERRORS
export class ConnectError extends Error {
  override name = 'ConnectError'
  readonly status: number
  constructor(readonly code: ConnectErrorCode) {
    super(ERRORS[code][1])
    this.status = ERRORS[code][0]
  }
}

/** One row of Transaction Search as list_transactions returns it; only transaction_info is used. */
export interface TransactionInfo {
  transaction_id?: string
  paypal_reference_id?: string
  transaction_event_code?: string
  transaction_initiation_date?: string
  transaction_amount?: { currency_code?: string; value?: string }
  fee_amount?: { currency_code?: string; value?: string }
  transaction_status?: string
  transaction_subject?: string
  transaction_note?: string
  ending_balance?: { currency_code?: string; value?: string }
}
export interface ActivitySummary {
  /** Rows converted into the CSV. */
  transactions: number
  /** First and last activity dates (YYYY-MM-DD, in the plan's time zone). */
  first?: string
  last?: string
  /** The span Worth asked PayPal about, in days. */
  searchedDays: number
  /** Rows PayPal returned that Worth couldn't read (an unreadable date or amount). */
  skipped: number
  /** True when the read stopped at the import's row or size limit. */
  truncated: boolean
}
export interface Activity {
  csv: string
  summary: ActivitySummary
}

export interface PayPalConnectOptions {
  /** Worth's public origin; the callback is registered under it. */
  origin: string
  /** A client already registered on the MCP server for this origin's callback (PAYPAL_MCP_CLIENT_ID). */
  clientId?: string
  /** Off: every route answers that Connect is off, and the button never shows. */
  enabled: boolean
  fetch?: typeof fetch
  now?: () => number
  /** Event names and failure kinds only; never a token, code, verifier or response body. */
  log?: (event: Record<string, unknown>) => void
  sessionTimeoutMs?: number
  /** Where refresh tokens are kept; memory only by default. */
  vault?: LinkVault
}

const STATUS_TEXT: Record<string, string> = {
  S: 'Completed',
  P: 'Pending',
  D: 'Denied',
  V: 'Reversed',
}
/** PayPal event codes (developer.paypal.com/reports/reference/t-codes) as an activity export's Type. */
const EXACT: Record<string, [type: string, label: string]> = {
  T0002: ['Subscription Payment', 'Subscription payment'],
  T0003: ['Preapproved Payment Bill User Payment', 'Automatic payment'],
  T0006: ['Express Checkout Payment', 'PayPal checkout payment'],
  T0007: ['Website Payment', 'Website payment'],
  T0011: ['Mobile Payment', 'Mobile payment'],
  T0013: ['Donation Payment', 'Donation'],
  T1101: ['Transfer from Bank', 'Bank withdrawal reversed'],
  T1104: ['Transfer to Bank', 'Bank deposit reversed'],
  T1107: ['Payment Refund', 'Refund'],
  T1109: ['Fee Refund', 'Fee refund'],
  T1120: ['Payment Refund', 'Refund'],
  // Buyer credit funding is how Pay in 4 and Pay Later purchases show; csv.ts pairs it with the
  // purchase it paid for and proposes the plan.
  T1600: ['Pay Later Funding', 'PayPal Pay Later'],
  T1601: ['Pay Later Funding', 'PayPal Pay Later'],
  T1602: ['Pay Later Payment', 'PayPal Pay Later'],
  T1603: ['Pay Later Payment', 'PayPal Pay Later'],
  T1800: ['Pay Later Payment', 'PayPal Pay Later'],
  T1801: ['Pay Later Payment', 'PayPal Pay Later'],
  T1200: ['Account Adjustment', 'Account adjustment'],
  T1203: ['Account Adjustment', 'Account adjustment'],
  T1204: ['Account Adjustment', 'Account adjustment'],
}
const GROUPS: Record<string, [type: string, label: string]> = {
  T00: ['General Payment', 'PayPal payment'],
  T01: ['Fee', 'PayPal fee'],
  T02: ['General Currency Conversion', 'Currency conversion'],
  T03: ['Bank Deposit to PP Account', 'Bank deposit to PayPal'],
  T04: ['General Withdrawal', 'Withdrawal to bank'],
  T05: ['PayPal Debit Card Transaction', 'PayPal debit card'],
  T07: ['General Card Deposit', 'Card deposit to PayPal'],
  T08: ['Bonus', 'PayPal bonus'],
  T09: ['Incentive', 'PayPal incentive'],
  T10: ['BillPay', 'Bill payment'],
  T11: ['Payment Reversal', 'Reversal'],
  T12: ['Chargeback', 'Chargeback'],
  T13: ['General Authorization', 'Authorization'],
  T14: ['Dividend', 'Dividend'],
  T15: ['Account Hold', 'Account hold'],
  T17: ['General Withdrawal', 'Withdrawal'],
  T19: ['Account Correction', 'Account correction'],
  T20: ['Transfer', 'Transfer'],
  T21: ['Account Hold', 'Account hold'],
  T22: ['Transfer', 'Transfer'],
}
/** The activity export's Type and a readable name for a PayPal event code. */
export function eventType(code: string | undefined): { type: string; label: string } {
  const known = (code && (EXACT[code] ?? GROUPS[code.slice(0, 3)])) || undefined
  if (known) return { type: known[0], label: known[1] }
  return {
    type: 'PayPal Activity',
    label: code && /^T\d{4}$/.test(code) ? `PayPal activity (${code})` : 'PayPal activity',
  }
}

const CSV_HEADER = [
  'Date',
  'Time',
  'TimeZone',
  'Name',
  'Type',
  'Status',
  'Currency',
  'Net',
  'Transaction ID',
  'Reference Txn ID',
  'Balance',
]
function cell(value: string) {
  return `"${value.replace(/"/g, '""')}"`
}
/** Plain one-line text: no control characters, at most `max` characters. */
function plain(value: unknown, max = 180) {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .trim()
        .slice(0, max)
    : ''
}
const AMOUNT = /^-?\d{1,12}(?:\.\d{1,2})?$/
function cents(value: string | undefined): number | undefined {
  if (!value || !AMOUNT.test(value.trim())) return undefined
  const [whole, fraction = ''] = value.trim().replace('-', '').split('.')
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return value.trim().startsWith('-') ? -result : result
}
function decimal(amount: number) {
  const sign = amount < 0 ? '-' : ''
  const abs = Math.abs(amount)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}
/** Date and time of an instant in the plan's time zone, as YYYY-MM-DD and HH:MM:SS. */
function local(instant: string | undefined, timezone: string) {
  const time = instant ? Date.parse(instant.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : Number.NaN
  if (!Number.isFinite(time)) return undefined
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(time)
      .map((part) => [part.type, part.value]),
  )
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  }
}

/**
 * PayPal's activity rows as the CSV text of a personal activity export, so the existing import
 * (parsePayPalCsv, the review step, recurring detection and Pay in 4 proposals) reads them unchanged.
 * There is no counterparty name in these rows: the transaction's subject (the order description)
 * names it, else the event's own label. Oldest first; at most the import's row and size limits.
 */
export function activityCsv(rows: TransactionInfo[], timezone: string): Activity {
  const lines: { date: string; line: string }[] = []
  let skipped = 0
  // Transaction Search can list a reversal (T11xx) under the ID of the transaction it reverses; an
  // export never does, and the import would read the pair as one transaction in conflict. Such a
  // reversal gets a stable ID of its own: the original's ID and its event code.
  const codes = new Map<string, Set<string>>()
  for (const row of rows) {
    const id = plain(row.transaction_id, 64)
    if (id) codes.set(id, (codes.get(id) ?? new Set()).add(plain(row.transaction_event_code, 5)))
  }
  const ownId = (row: TransactionInfo) => {
    const id = plain(row.transaction_id, 64)
    const code = plain(row.transaction_event_code, 5)
    const shared = [...(codes.get(id) ?? [])].some((other) => other !== code)
    return shared && code.startsWith('T11') ? `${id}-${code}` : id
  }
  for (const row of rows) {
    const when = local(row.transaction_initiation_date, timezone)
    const amount = cents(row.transaction_amount?.value)
    const currency = plain(row.transaction_amount?.currency_code, 8).toUpperCase()
    if (!when || amount === undefined || !/^[A-Z]{3}$/.test(currency)) {
      skipped++
      continue
    }
    const feeCurrency = row.fee_amount?.currency_code
    const fee = cents(row.fee_amount?.value) ?? 0
    const net = !feeCurrency || feeCurrency.toUpperCase() === currency ? amount + fee : amount
    const { type, label } = eventType(plain(row.transaction_event_code, 5))
    const status = STATUS_TEXT[plain(row.transaction_status, 2)] ?? 'Unknown'
    // A Pay Later funding or repayment row is named by its event, never its subject: named after the
    // product, a repayment would read as a new purchase and propose a plan that doesn't exist.
    const payLater = /^T1[68]\d\d$/.test(plain(row.transaction_event_code, 5))
    const name = payLater
      ? label
      : plain(row.transaction_subject) || plain(row.transaction_note) || label
    const balance = cents(row.ending_balance?.value)
    lines.push({
      date: `${when.date} ${when.time}`,
      line: [
        when.date,
        when.time,
        timezone,
        name,
        type,
        status,
        currency,
        decimal(net),
        ownId(row),
        plain(row.paypal_reference_id, 64),
        balance === undefined ? '' : decimal(balance),
      ]
        .map(cell)
        .join(','),
    })
  }
  // Newest first, so the limits drop the oldest rows; the export itself is written oldest first.
  lines.sort((a, b) => b.date.localeCompare(a.date))
  const header = CSV_HEADER.map(cell).join(',')
  let bytes = utf8Bytes(header)
  const kept: typeof lines = []
  for (const item of lines) {
    const size = utf8Bytes(item.line) + 1
    if (kept.length >= CSV_IMPORT_LIMITS.maxRows || bytes + size > CSV_IMPORT_LIMITS.maxBytes) break
    bytes += size
    kept.push(item)
  }
  kept.reverse()
  return {
    csv: [header, ...kept.map((item) => item.line)].join('\n'),
    summary: {
      transactions: kept.length,
      ...(kept.length
        ? { first: kept[0]!.date.slice(0, 10), last: kept.at(-1)!.date.slice(0, 10) }
        : {}),
      searchedDays: 0,
      skipped,
      truncated: kept.length < lines.length,
    },
  }
}

interface Pending {
  sessionId: string
  verifier: string
  until: number
}
interface Held {
  token: string
  until: number
  /** Issued by the latest login or refresh and not yet used for a read. */
  fresh: boolean
}
/** What PayPal's opaque tokens look like: printable ASCII, no spaces. */
const TOKEN_SHAPE = /^[\x21-\x7e]{1,4096}$/
interface JsonRpcMessage {
  id?: number
  result?: { content?: { type?: string; text?: string }[]; isError?: boolean }
  error?: { code?: number; message?: string }
}

function base64url(bytes: Buffer) {
  return bytes.toString('base64url')
}
function sameText(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export interface PayPalConnect {
  status(): ConnectStatus
  /** Starts a login for this Worth session and returns PayPal's authorize URL. */
  start(sessionId: string): Promise<string>
  /** Completes a login from the callback's query. Only the session that started it can. */
  finish(sessionId: string, query: Record<string, unknown>): Promise<ConnectResult>
  /** Whether Worth can read this session's PayPal activity without another login. */
  linked(sessionId: string): boolean
  /** Forgets this session's PayPal tokens and any login in progress. The plan is not touched. */
  disconnect(sessionId: string): void
  /**
   * Reads the session's activity through list_transactions, refreshing the access token from the
   * kept refresh token when needed. One read per session at a time.
   */
  read(sessionId: string, timezone: string): Promise<Activity>
  /** The one place a tool is called: anything outside ALLOWED_TOOLS is refused before any request. */
  callTool(
    token: string,
    mcpSession: string | undefined,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string>
}

export function createPayPalConnect(options: PayPalConnectOptions): PayPalConnect {
  const http = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const log =
    options.log ??
    ((event: Record<string, unknown>) => console.warn('PayPal Connect:', JSON.stringify(event)))
  const sessionTimeout = options.sessionTimeoutMs ?? SESSION_TIMEOUT_MS
  const redirectUri = new URL(CALLBACK_PATH, options.origin).href
  const pending = new Map<string, Pending>()
  const tokens = new Map<string, Held>()
  const vault = options.vault ?? memoryVault()
  const reading = new Set<string>()
  let client: Promise<string> | undefined = options.clientId
    ? Promise.resolve(options.clientId)
    : undefined
  let unavailableUntil = 0
  let timeouts = 0
  let rpcId = 0

  function prune(time: number) {
    for (const [key, item] of pending) if (item.until <= time) pending.delete(key)
    for (const [key, item] of tokens) if (item.until <= time) tokens.delete(key)
  }

  /** A fetch to the MCP server with a hard timeout; transport failures become `failure`. */
  async function send(path: string, init: RequestInit, timeout: number, failure: ConnectErrorCode) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const response = await http(`${MCP_ORIGIN}${path}`, {
        ...init,
        redirect: 'error',
        signal: controller.signal,
      })
      const text = await response.text()
      return { response, text }
    } catch {
      throw new ConnectError(failure)
    } finally {
      clearTimeout(timer)
    }
  }

  /** Registers Worth's callback with the MCP server once per process (dynamic client registration). */
  function clientId() {
    client ??= (async () => {
      const { response, text } = await send(
        '/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_name: 'Worth',
            redirect_uris: [redirectUri],
            token_endpoint_auth_method: 'none',
            // The refresh grant keeps PayPal connected, so Worth can re-read without a new login.
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
          }),
        },
        OAUTH_TIMEOUT_MS,
        'MCP_FAILED',
      )
      const id = response.ok ? (JSON.parse(text) as { client_id?: unknown }).client_id : undefined
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
        log({ event: 'paypal_connect_register_failed', status: response.status })
        throw new ConnectError('MCP_FAILED')
      }
      return id
    })().catch((error: unknown) => {
      client = undefined
      throw error instanceof ConnectError ? error : new ConnectError('MCP_FAILED')
    })
    return client
  }

  /** One JSON-RPC message to /mcp; the reply may be JSON or a server-sent event stream. */
  async function rpc(
    token: string,
    mcpSession: string | undefined,
    method: string,
    params: Record<string, unknown>,
    { notify = false, timeout = CALL_TIMEOUT_MS, failure = 'MCP_FAILED' as ConnectErrorCode } = {},
  ) {
    const id = ++rpcId
    const { response, text } = await send(
      '/mcp',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(mcpSession ? { 'mcp-session-id': mcpSession } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(notify ? {} : { id }) }),
      },
      timeout,
      failure,
    )
    if (response.status === 401 || response.status === 403) throw new ConnectError('NOT_CONNECTED')
    if (!response.ok) {
      log({ event: 'paypal_connect_rpc_failed', method, status: response.status })
      throw new ConnectError('MCP_FAILED')
    }
    const session = response.headers.get('mcp-session-id') ?? mcpSession
    if (notify) return { session, message: undefined }
    const candidates = /^\s*[{[]/.test(text)
      ? [text]
      : text
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
    for (const candidate of candidates) {
      try {
        const message = JSON.parse(candidate) as JsonRpcMessage
        if (message.id === id) return { session, message }
      } catch {
        // Not this message; keep looking.
      }
    }
    log({ event: 'paypal_connect_rpc_unreadable', method })
    throw new ConnectError('MCP_FAILED')
  }

  async function callTool(
    token: string,
    mcpSession: string | undefined,
    name: string,
    args: Record<string, unknown>,
  ) {
    if (!ALLOWED_TOOLS.has(name)) {
      log({ event: 'paypal_connect_tool_refused', tool: name.slice(0, 40) })
      throw new ConnectError('TOOL_REFUSED')
    }
    const { message } = await rpc(token, mcpSession, 'tools/call', { name, arguments: args })
    if (!message?.result || message.error) {
      log({ event: 'paypal_connect_tool_failed', tool: name, code: message?.error?.code })
      throw new ConnectError('MCP_FAILED')
    }
    return (message.result.content ?? [])
      .map((part) => (part.type === undefined || part.type === 'text' ? (part.text ?? '') : ''))
      .join('')
  }

  /** One page of list_transactions, or no rows when PayPal says there are none. */
  function page(text: string): { rows: TransactionInfo[]; pages: number } {
    if (/^\s*no transactions found/i.test(text)) return { rows: [], pages: 0 }
    let body: {
      ok?: boolean
      status?: number
      transaction_details?: { transaction_info?: TransactionInfo }[]
      total_pages?: number
    }
    try {
      body = JSON.parse(text)
    } catch {
      log({ event: 'paypal_connect_list_unreadable' })
      throw new ConnectError('MCP_FAILED')
    }
    if (body.ok === false || !Array.isArray(body.transaction_details)) {
      log({ event: 'paypal_connect_list_failed', status: body.status })
      throw new ConnectError(
        body.status === 401 || body.status === 403 ? 'NOT_CONNECTED' : 'MCP_FAILED',
      )
    }
    return {
      rows: body.transaction_details.flatMap((item) =>
        item.transaction_info ? [item.transaction_info] : [],
      ),
      pages: Number.isSafeInteger(body.total_pages) ? body.total_pages! : 1,
    }
  }

  return {
    status() {
      if (!options.enabled) return 'off'
      return now() < unavailableUntil ? 'unavailable' : 'on'
    },
    async start(sessionId) {
      const time = now()
      prune(time)
      // One login at a time per session; the oldest are dropped when too many are open.
      for (const [key, item] of pending) if (item.sessionId === sessionId) pending.delete(key)
      while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!)
      const id = await clientId()
      const verifier = base64url(randomBytes(32))
      const state = base64url(randomBytes(32))
      pending.set(state, { sessionId, verifier, until: time + STATE_TTL_MS })
      const url = new URL('/authorize', MCP_ORIGIN)
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: id,
        redirect_uri: redirectUri,
        code_challenge: base64url(createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256',
        state,
      }).toString()
      return url.href
    },
    async finish(sessionId, query) {
      const time = now()
      prune(time)
      const state = typeof query.state === 'string' ? query.state : ''
      const login = /^[A-Za-z0-9_-]{43}$/.test(state) ? pending.get(state) : undefined
      // Single use, whatever happens next.
      if (login) pending.delete(state)
      if (!login || login.until <= time || !sameText(login.sessionId, sessionId)) return 'expired'
      if (query.error !== undefined) return query.error === 'access_denied' ? 'denied' : 'failed'
      const code = typeof query.code === 'string' ? query.code : ''
      if (!/^[\x21-\x7e]{1,2048}$/.test(code)) return 'failed'
      try {
        const { response, text } = await send(
          '/token',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              code,
              redirect_uri: redirectUri,
              client_id: await clientId(),
              code_verifier: login.verifier,
            }).toString(),
          },
          OAUTH_TIMEOUT_MS,
          'MCP_FAILED',
        )
        const granted = response.ok ? keep(sessionId, await clientId(), text, time) : false
        if (!granted) {
          log({ event: 'paypal_connect_token_failed', status: response.status })
          return 'failed'
        }
        return 'connected'
      } catch {
        log({ event: 'paypal_connect_token_failed' })
        return 'failed'
      }
    },
    linked(sessionId) {
      const held = tokens.get(sessionId)
      return Boolean((held && held.until > now()) || vault.get(sessionId))
    },
    disconnect(sessionId) {
      tokens.delete(sessionId)
      vault.delete(sessionId)
      for (const [key, item] of pending) if (item.sessionId === sessionId) pending.delete(key)
    },
    async read(sessionId, timezone) {
      if (reading.has(sessionId)) throw new ConnectError('BUSY')
      reading.add(sessionId)
      try {
        try {
          return await readWith(sessionId, timezone, await access(sessionId))
        } catch (error) {
          // A held access token PayPal no longer accepts: refresh once and read again.
          if (!(error instanceof ConnectError && error.code === 'STALE_ACCESS')) throw error
          tokens.delete(sessionId)
          return await readWith(sessionId, timezone, await access(sessionId))
        }
      } catch (error) {
        if (error instanceof ConnectError && error.code === 'STALE_ACCESS')
          throw new ConnectError('MCP_FAILED')
        throw error instanceof ConnectError ? error : new ConnectError('MCP_FAILED')
      } finally {
        reading.delete(sessionId)
      }
    },
    callTool,
  }

  /**
   * Keeps a token reply: the access token in memory, the refresh token (if any) in the vault under
   * the client it was issued to. False when the reply holds no usable access token.
   */
  function keep(sessionId: string, client: string, text: string, time: number) {
    let body: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }
    try {
      body = JSON.parse(text)
    } catch {
      return false
    }
    const token = body.access_token
    if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return false
    const seconds =
      typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600
    tokens.set(sessionId, {
      token,
      until: time + Math.min(ACCESS_TTL_MS, seconds * 1000 - 60_000),
      fresh: true,
    })
    // PayPal rotates refresh tokens: only the newest is kept (an older one may still work at
    // PayPal, which is why it must never be stored or logged).
    if (typeof body.refresh_token === 'string' && TOKEN_SHAPE.test(body.refresh_token))
      vault.set(sessionId, { clientId: client, refreshToken: body.refresh_token })
    return true
  }

  /** An access token for the session: the held one, or a new one from the kept refresh token. */
  async function access(sessionId: string) {
    const time = now()
    const held = tokens.get(sessionId)
    if (held && held.until > time) return held
    tokens.delete(sessionId)
    const link = vault.get(sessionId)
    if (!link) throw new ConnectError('NOT_CONNECTED')
    const { response, text } = await send(
      '/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: link.refreshToken,
          client_id: link.clientId,
        }).toString(),
      },
      OAUTH_TIMEOUT_MS,
      'MCP_FAILED',
    )
    // PayPal refused the refresh token (expired, revoked, rotated away, or its client is gone):
    // the link is over. The plan stays as it is; the next Connect PayPal logs in again.
    if (response.status === 400 || response.status === 401) {
      vault.delete(sessionId)
      log({ event: 'paypal_connect_refresh_refused', status: response.status })
      throw new ConnectError('NOT_CONNECTED')
    }
    if (!response.ok || !keep(sessionId, link.clientId, text, time)) {
      log({ event: 'paypal_connect_refresh_failed', status: response.status })
      throw new ConnectError('MCP_FAILED')
    }
    log({ event: 'paypal_connect_refreshed' })
    return tokens.get(sessionId)!
  }

  async function readWith(sessionId: string, timezone: string, held: Held): Promise<Activity> {
    const started = now()
    let mcpSession: string | undefined
    try {
      const opened = await rpc(
        held.token,
        undefined,
        'initialize',
        {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'worth', version: '1' },
        },
        { timeout: sessionTimeout, failure: 'MCP_TIMEOUT' },
      ).catch((error: unknown) => {
        // One slow start gates only the visitor who hit it (their browser hides Connect); only
        // repeated ones mean PayPal is down for everyone, and then only briefly.
        if (error instanceof ConnectError && error.code === 'MCP_TIMEOUT') {
          timeouts++
          if (timeouts >= TIMEOUTS_TO_GATE) {
            unavailableUntil = now() + UNAVAILABLE_MS
            timeouts = 0
          }
        }
        throw error
      })
      timeouts = 0
      mcpSession = opened.session ?? undefined
      log({ event: 'paypal_connect_session_open', ms: now() - started })
      await rpc(held.token, mcpSession, 'notifications/initialized', {}, { notify: true })
      // Each list_transactions call takes PayPal about ten seconds, so the 31-day windows are
      // read side by side; a window's further pages, if any, follow one by one.
      const end = now()
      const window = async (index: number) => {
        const callStarted = now()
        const rows: TransactionInfo[] = []
        for (let number = 1, pages = 1; number <= Math.min(pages, MAX_PAGES); number++) {
          const result = page(
            await callTool(held.token, mcpSession, 'list_transactions', {
              start_date: new Date(end - (index + 1) * WINDOW_MS).toISOString(),
              end_date: new Date(end - index * WINDOW_MS).toISOString(),
              page_size: PAGE_SIZE,
              ...(number > 1 ? { page: number } : {}),
            }),
          )
          pages = result.pages
          rows.push(...result.rows)
        }
        log({ event: 'paypal_connect_window', index, rows: rows.length, ms: now() - callStarted })
        return rows
      }
      const windows = MAX_WINDOWS
      const rows = (
        await Promise.all(Array.from({ length: windows }, (_, index) => window(index)))
      ).flat()
      const activity = activityCsv(rows, timezone)
      activity.summary.searchedDays = Math.round((windows * WINDOW_MS) / 86_400_000)
      if (rows.length >= CSV_IMPORT_LIMITS.maxRows) activity.summary.truncated = true
      held.fresh = false
      log({
        event: 'paypal_connect_read',
        rows: activity.summary.transactions,
        windows,
        ms: now() - started,
      })
      return activity
    } catch (error) {
      // PayPal's MCP server turned the access token down. One held from an earlier read may just
      // have lapsed early (STALE_ACCESS: refresh once); a brand-new one means the link is over.
      if (error instanceof ConnectError && error.code === 'NOT_CONNECTED') {
        tokens.delete(sessionId)
        if (!held.fresh && vault.get(sessionId)) throw new ConnectError('STALE_ACCESS')
        vault.delete(sessionId)
      }
      throw error instanceof ConnectError ? error : new ConnectError('MCP_FAILED')
    } finally {
      if (mcpSession)
        void send(
          '/mcp',
          {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${held.token}`, 'mcp-session-id': mcpSession },
          },
          5_000,
          'MCP_FAILED',
        ).catch(() => {})
    }
  }
}

/** Where the callback sends the browser: a fixed path, so no request can choose the destination. */
export function connectReturn(result: ConnectResult | 'off') {
  return `/#import?connect=${result === 'connected' ? 'paypal' : result}`
}

export interface ConnectRoutes {
  connect: PayPalConnect
  sessionId: (res: Response) => string
  timezone: (res: Response) => string
  now: () => number
  /** Told the CSV text of each successful read, so an import of exactly that text is known. */
  onRead?: (res: Response, csv: string) => void
  /**
   * Applies a background read to the session's confirmed plan (POST /api/paypal/sync) and returns
   * the response body; undefined when the session's plan isn't from Connect PayPal.
   */
  onSync?: (res: Response, activity: Activity) => unknown
  /** Whether the session's plan is one to keep up to date, checked before PayPal is read. */
  canSync?: (res: Response) => boolean
  /** The response body after a disconnect, such as the session's state. */
  onDisconnect?: (res: Response) => unknown
}

/**
 * Logins started per session and per IP per hour; each one registers state and calls PayPal. A
 * login is counted once, when it starts: its callback can only finish a state started here. Judges
 * may share one office network, so the per-IP allowance is generous.
 */
const STARTS_PER_SESSION = 10
const STARTS_PER_IP = 60
/** Activity reads per session and per IP per hour; each one is up to seven PayPal MCP calls. */
const READS_PER_SESSION = 6
const READS_PER_IP = 20

/**
 * GET /api/paypal/connect, GET /api/paypal/connect/callback and POST /api/paypal/activity. Mounted
 * after the /api session middleware, so each request already has its Worth session.
 */
export function mountPayPalConnect(
  app: Express,
  { connect, sessionId, timezone, now, onRead, onSync, canSync, onDisconnect }: ConnectRoutes,
) {
  const startsPerSession = new WindowLimiter(STARTS_PER_SESSION, 60 * 60_000)
  const startsPerIp = new WindowLimiter(STARTS_PER_IP, 60 * 60_000)
  const readsPerSession = new WindowLimiter(READS_PER_SESSION, 60 * 60_000)
  const readsPerIp = new WindowLimiter(READS_PER_IP, 60 * 60_000)
  const back = (res: Response, result: ConnectResult | 'off' | 'limited') => {
    // The callback's URL held a code; nothing of it travels on as a referrer.
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.redirect(303, connectReturn(result === 'limited' ? 'failed' : result))
  }

  app.get('/api/paypal/connect', async (req: Request, res: Response) => {
    if (connect.status() === 'off') return back(res, 'off')
    // Only a click inside Worth (or a typed address) starts a login, never another site's link.
    if (req.get('sec-fetch-site') === 'cross-site') return back(res, 'failed')
    const id = sessionId(res)
    const time = now()
    if (!startsPerSession.take(id, time) || !startsPerIp.take(req.ip ?? 'local', time))
      return back(res, 'limited')
    try {
      res.setHeader('Referrer-Policy', 'no-referrer')
      res.redirect(303, await connect.start(id))
    } catch {
      back(res, 'failed')
    }
  })

  app.get(CALLBACK_PATH, async (req: Request, res: Response) => {
    if (connect.status() === 'off') return back(res, 'off')
    back(res, await connect.finish(sessionId(res), req.query as Record<string, unknown>))
  })

  app.post('/api/paypal/activity', async (req: Request, res: Response) => {
    if (connect.status() === 'off')
      return void res.status(404).json({
        error: 'Connect PayPal is off here. Use a CSV export.',
        code: 'PAYPAL_CONNECT_OFF',
      })
    const id = sessionId(res)
    const time = now()
    if (!readsPerSession.take(id, time) || !readsPerIp.take(req.ip ?? 'local', time))
      return void res.status(429).json({
        error: 'Too many PayPal reads. Try again later, or use a CSV export.',
        code: 'RATE_LIMITED',
      })
    try {
      const activity = await connect.read(id, timezone(res))
      onRead?.(res, activity.csv)
      res.json(activity)
    } catch (error) {
      const failure = error instanceof ConnectError ? error : new ConnectError('MCP_FAILED')
      res.status(failure.status).json({ error: failure.message, code: failure.code })
    }
  })

  /**
   * Keeps a connected plan up to date without a login: reads with the kept refresh token and
   * applies only what can't overwrite what the user confirmed (see paypalSync.ts). The same
   * per-session and per-IP read limits apply, and a session never has two reads at once.
   */
  app.post('/api/paypal/sync', async (req: Request, res: Response) => {
    if (connect.status() === 'off' || !onSync)
      return void res
        .status(404)
        .json({ error: 'Connect PayPal is off here.', code: 'PAYPAL_CONNECT_OFF' })
    const id = sessionId(res)
    if (!connect.linked(id)) {
      const failure = new ConnectError('NOT_CONNECTED')
      return void res.status(failure.status).json({ error: failure.message, code: failure.code })
    }
    if (canSync && !canSync(res))
      return void res
        .status(409)
        .json({ error: 'This plan isn’t from Connect PayPal.', code: 'NOT_SYNCED' })
    const time = now()
    if (!readsPerSession.take(id, time) || !readsPerIp.take(req.ip ?? 'local', time))
      return void res.status(429).json({
        error: 'Too many PayPal reads. Try again later.',
        code: 'RATE_LIMITED',
      })
    try {
      const activity = await connect.read(id, timezone(res))
      const body = onSync(res, activity)
      if (body === undefined)
        return void res
          .status(409)
          .json({ error: 'This plan isn’t from Connect PayPal.', code: 'NOT_SYNCED' })
      res.json(body)
    } catch (error) {
      const failure = error instanceof ConnectError ? error : new ConnectError('MCP_FAILED')
      res.status(failure.status).json({ error: failure.message, code: failure.code })
    }
  })

  /** Forgets the session's PayPal tokens. The plan stays exactly as it is. */
  app.post('/api/paypal/disconnect', (_req: Request, res: Response) => {
    connect.disconnect(sessionId(res))
    res.json(onDisconnect?.(res) ?? { disconnected: true })
  })
}
