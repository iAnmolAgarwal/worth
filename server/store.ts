import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type {
  FinancialProfile,
  ForeignPayment,
  Purchase,
  SavedItem,
  Transaction,
} from '../shared/types.ts'

export interface SessionData {
  profile: FinancialProfile
  transactions: Transaction[]
  /** Older sessions only: catalog IDs saved before saved items moved to `saved`. */
  wishlist: string[]
  /** Imported foreign-currency payments without a USD conversion, and how each was resolved. */
  foreignPayments?: ForeignPayment[]
  /** Saved items and wait plans. Stored statuses are active, bought or removed. */
  saved?: SavedItem[]
  /** When the session began (ms); older sessions without it count from their first read. */
  createdAt?: number
  /** Opt-in 30-day retention (D-9 a). Absent: the 24-hour default. */
  keep30?: boolean
  /** The labelled demo clock. Only the synthetic persona may carry one. */
  demoClock?: { today: string; preset?: 'video' }
}
export interface StoredPurchase extends Purchase {
  approvalUrl?: string
  merchantId?: string
  acknowledgedShortfall: boolean
  captureAttemptedAt?: string
  /** Captures attempted after a decline; each re-approval gets a fresh PayPal-Request-Id. */
  captureRetries?: number
  /** Whether PayPal's checkout could offer Pay Later for this order, from the eligibility check. */
  payLaterCapable?: boolean
}
export const ACTIVE = new Set(['created', 'pending', 'unknown'])
const DAY = 24 * 60 * 60 * 1000
export const SESSION_DAY_MS = DAY
/** Opt-in retention: the plan is kept on this device for 30 days, then deleted. */
export const RETENTION_MS = 30 * DAY

export class Store {
  readonly db: DatabaseSync
  constructor(path = '.data/worth.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires);
      CREATE TABLE IF NOT EXISTS purchases (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        status TEXT NOT NULL, order_id TEXT UNIQUE, capture_id TEXT UNIQUE, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_checkout ON purchases(session_id) WHERE status IN ('created','pending','unknown');
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS agent_tokens (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        hash TEXT NOT NULL UNIQUE, hint TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
        last_used INTEGER, revoked INTEGER);
      CREATE INDEX IF NOT EXISTS agent_tokens_session ON agent_tokens(session_id);
    `)
  }
  close() {
    this.db.close()
  }
  cleanup(now = Date.now()) {
    const deleted = this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(now).changes
    if (deleted) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return deleted
  }
  create(data: SessionData, now = Date.now()) {
    const id = randomBytes(32).toString('base64url')
    this.db
      .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
      .run(id, JSON.stringify(data), now + DAY)
    return id
  }
  /** When a session expires (ms), or undefined when it does not exist. */
  expiry(id: string): number | undefined {
    const row = this.db.prepare('SELECT expires FROM sessions WHERE id=?').get(id) as
      { expires: number } | undefined
    return row?.expires
  }
  /** Moves a session's expiry, for opt-in retention. */
  setExpiry(id: string, expires: number) {
    this.db.prepare('UPDATE sessions SET expires=? WHERE id=?').run(expires, id)
  }
  /** Live sessions, counted through the expiry index. */
  count(now = Date.now()) {
    return (
      this.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expires > ?').get(now) as {
        count: number
      }
    ).count
  }
  /** Checks one session by primary key and deletes it if it has expired. */
  isLive(id: string, now = Date.now()) {
    const row = this.db.prepare('SELECT expires FROM sessions WHERE id=?').get(id) as
      { expires: number } | undefined
    if (!row) return false
    if (row.expires > now) return true
    this.delete(id)
    return false
  }
  get(id: string): SessionData | undefined {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id=?').get(id) as
      { data: string } | undefined
    return row ? (JSON.parse(row.data) as SessionData) : undefined
  }
  save(id: string, data: SessionData) {
    this.db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(data), id)
  }
  delete(id: string) {
    this.db.prepare('DELETE FROM sessions WHERE id=?').run(id)
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }
  purchases(sessionId: string): StoredPurchase[] {
    return (
      this.db
        .prepare('SELECT data FROM purchases WHERE session_id=? ORDER BY rowid DESC')
        .all(sessionId) as { data: string }[]
    ).map((row) => JSON.parse(row.data) as StoredPurchase)
  }
  purchase(id: string, sessionId?: string): StoredPurchase | undefined {
    const row = (
      sessionId
        ? this.db
            .prepare('SELECT data FROM purchases WHERE id=? AND session_id=?')
            .get(id, sessionId)
        : this.db.prepare('SELECT data FROM purchases WHERE id=?').get(id)
    ) as { data: string } | undefined
    return row ? (JSON.parse(row.data) as StoredPurchase) : undefined
  }
  byOrder(orderId: string): { purchase: StoredPurchase; sessionId: string } | undefined {
    const row = this.db
      .prepare('SELECT session_id, data FROM purchases WHERE order_id=?')
      .get(orderId) as { session_id: string; data: string } | undefined
    return row
      ? { purchase: JSON.parse(row.data) as StoredPurchase, sessionId: row.session_id }
      : undefined
  }
  byCapture(captureId: string): { purchase: StoredPurchase; sessionId: string } | undefined {
    const row = this.db
      .prepare('SELECT session_id, data FROM purchases WHERE capture_id=?')
      .get(captureId) as { session_id: string; data: string } | undefined
    return row
      ? { purchase: JSON.parse(row.data) as StoredPurchase, sessionId: row.session_id }
      : undefined
  }
  putPurchase(sessionId: string, purchase: StoredPurchase) {
    this.db
      .prepare(
        `INSERT INTO purchases(id,session_id,status,order_id,capture_id,data) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,order_id=excluded.order_id,capture_id=excluded.capture_id,data=excluded.data`,
      )
      .run(
        purchase.id,
        sessionId,
        purchase.status,
        purchase.orderId ?? null,
        purchase.captureId ?? null,
        JSON.stringify(purchase),
      )
  }
  hasEvent(id: string) {
    return Boolean(this.db.prepare('SELECT id FROM events WHERE id=?').get(id))
  }
  recordEvent(id: string, sessionId: string) {
    this.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?)').run(id, sessionId)
  }
  /** Stores an agent token by its SHA-256 hash only; the token itself is never written. */
  createAgentToken(token: Omit<AgentTokenRow, 'lastUsed' | 'revoked'> & { hash: string }) {
    this.db
      .prepare(
        'INSERT INTO agent_tokens(id,session_id,hash,hint,created,expires) VALUES(?,?,?,?,?,?)',
      )
      .run(token.id, token.sessionId, token.hash, token.hint, token.created, token.expires)
  }
  /** One session's agent tokens, newest first, without their hashes. */
  agentTokens(sessionId: string): AgentTokenRow[] {
    return (
      this.db
        .prepare(
          'SELECT id, session_id, hint, created, expires, last_used, revoked FROM agent_tokens WHERE session_id=? ORDER BY created DESC, rowid DESC',
        )
        .all(sessionId) as unknown as RawAgentToken[]
    ).map(agentTokenRow)
  }
  /** The token with this hash and its session's expiry, if both still exist. */
  agentTokenByHash(hash: string): (AgentTokenRow & { sessionExpires: number }) | undefined {
    const row = this.db
      .prepare(
        `SELECT t.id, t.session_id, t.hint, t.created, t.expires, t.last_used, t.revoked, s.expires AS session_expires
        FROM agent_tokens t JOIN sessions s ON s.id = t.session_id WHERE t.hash=?`,
      )
      .get(hash) as (RawAgentToken & { session_expires: number }) | undefined
    return row ? { ...agentTokenRow(row), sessionExpires: row.session_expires } : undefined
  }
  touchAgentToken(id: string, time: number) {
    this.db.prepare('UPDATE agent_tokens SET last_used=? WHERE id=?').run(time, id)
  }
  /** Revokes one of this session's tokens; false when the session has no such token. */
  revokeAgentToken(id: string, sessionId: string, time: number) {
    return (
      this.db
        .prepare('UPDATE agent_tokens SET revoked=COALESCE(revoked, ?) WHERE id=? AND session_id=?')
        .run(time, id, sessionId).changes > 0
    )
  }
  atomic<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

/** An agent token as stored, without its hash. Times are in milliseconds. */
export interface AgentTokenRow {
  id: string
  sessionId: string
  /** The token's last four characters, so the user can tell tokens apart. */
  hint: string
  created: number
  expires: number
  lastUsed?: number
  revoked?: number
}
interface RawAgentToken {
  id: string
  session_id: string
  hint: string
  created: number
  expires: number
  last_used: number | null
  revoked: number | null
}
function agentTokenRow(row: RawAgentToken): AgentTokenRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    hint: row.hint,
    created: row.created,
    expires: row.expires,
    ...(row.last_used !== null ? { lastUsed: row.last_used } : {}),
    ...(row.revoked !== null ? { revoked: row.revoked } : {}),
  }
}

/** The purchase as the browser sees it. The approval link appears only while approval is needed. */
export function publicPurchase(purchase: StoredPurchase): Purchase {
  const {
    approvalUrl,
    merchantId: _merchant,
    acknowledgedShortfall: _ack,
    captureAttemptedAt: _attempted,
    captureRetries: _retries,
    payLaterCapable: _payLater,
    approveUrl: _stale,
    ...result
  } = purchase
  return purchase.status === 'created' && approvalUrl
    ? { ...result, approveUrl: approvalUrl }
    : result
}
