import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { FinancialProfile, Purchase, Transaction } from '../shared/types.ts'

export interface SessionData {
  profile: FinancialProfile
  transactions: Transaction[]
  wishlist: string[]
}
export interface StoredPurchase extends Purchase {
  approvalUrl?: string
  merchantId?: string
  acknowledgedShortfall: boolean
  captureAttemptedAt?: string
}
export const ACTIVE = new Set(['created', 'pending', 'unknown'])
const DAY = 24 * 60 * 60 * 1000

export class Store {
  readonly db: DatabaseSync
  constructor(path = '.data/worth.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS purchases (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        status TEXT NOT NULL, order_id TEXT UNIQUE, capture_id TEXT UNIQUE, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_checkout ON purchases(session_id) WHERE status IN ('created','pending','unknown');
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE);
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

export function publicPurchase(purchase: StoredPurchase): Purchase {
  const {
    approvalUrl: _url,
    merchantId: _merchant,
    acknowledgedShortfall: _ack,
    captureAttemptedAt: _attempted,
    ...result
  } = purchase
  return result
}
