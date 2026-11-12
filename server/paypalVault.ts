import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/**
 * Where Connect PayPal keeps a visitor's PayPal refresh token, so Worth can re-read their activity
 * without another login. Only the refresh token and the MCP client it was issued to are kept,
 * bound to one Worth session. Access tokens never come here: they stay in memory for under an hour.
 *
 * With PAYPAL_TOKEN_KEY set, the link is sealed with AES-256-GCM (a fresh 96-bit IV each time, the
 * session ID as associated data, so a sealed link can't be moved to another session) and stored
 * next to the session, which deletes it with the session. Without the key it lives in this
 * process's memory only and is lost on restart. Nothing here is ever logged or sent anywhere.
 */
export interface PayPalLink {
  clientId: string
  refreshToken: string
}
export interface LinkVault {
  get(sessionId: string): PayPalLink | undefined
  set(sessionId: string, link: PayPalLink): void
  delete(sessionId: string): void
  /** The sessions held, for a store that can't drop expired ones itself (memory only). */
  sessions?(): string[]
}

const VERSION = 'v1'

/** Seals a link for one session. The output holds no part of the token in the clear. */
export function sealLink(key: Buffer, sessionId: string, link: PayPalLink): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(sessionId))
  const body = Buffer.concat([cipher.update(JSON.stringify(link), 'utf8'), cipher.final()])
  return [VERSION, iv, cipher.getAuthTag(), body]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.')
}

/** Opens a sealed link, or undefined when it was altered, sealed for another session or key. */
export function openLink(key: Buffer, sessionId: string, sealed: string): PayPalLink | undefined {
  const [version, iv, tag, body] = sealed.split('.')
  if (version !== VERSION || !iv || !tag || !body) return undefined
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), {
      authTagLength: 16,
    })
    decipher.setAAD(Buffer.from(sessionId))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    const text = Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
    const link = JSON.parse(text) as Partial<PayPalLink>
    return typeof link.clientId === 'string' && typeof link.refreshToken === 'string'
      ? { clientId: link.clientId, refreshToken: link.refreshToken }
      : undefined
  } catch {
    return undefined
  }
}

/** Sealed links in the session database; a deleted or expired session takes its link with it. */
export function databaseVault(db: DatabaseSync, key: Buffer, now = Date.now): LinkVault {
  db.exec(`CREATE TABLE IF NOT EXISTS paypal_links (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    sealed TEXT NOT NULL, updated INTEGER NOT NULL)`)
  return {
    get(sessionId) {
      const row = db
        .prepare('SELECT sealed FROM paypal_links WHERE session_id=?')
        .get(sessionId) as { sealed: string } | undefined
      return row ? openLink(key, sessionId, row.sealed) : undefined
    },
    set(sessionId, link) {
      db.prepare(
        'INSERT INTO paypal_links VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET sealed=excluded.sealed, updated=excluded.updated',
      ).run(sessionId, sealLink(key, sessionId, link), now())
    },
    delete(sessionId) {
      db.prepare('DELETE FROM paypal_links WHERE session_id=?').run(sessionId)
    },
  }
}

/** Links in this process's memory only: never on disk, gone on restart. Oldest dropped past `max`. */
export function memoryVault(max = 5_000): LinkVault {
  const links = new Map<string, PayPalLink>()
  return {
    get: (sessionId) => links.get(sessionId),
    set(sessionId, link) {
      links.delete(sessionId)
      links.set(sessionId, link)
      while (links.size > max) links.delete(links.keys().next().value!)
    },
    delete: (sessionId) => void links.delete(sessionId),
    sessions: () => [...links.keys()],
  }
}

/** PAYPAL_TOKEN_KEY as a key: 32 bytes, base64 or base64url. Undefined for anything else. */
export function tokenKey(value: string): Buffer | undefined {
  const text = value.trim()
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) return undefined
  const key = Buffer.from(text, /[-_]/.test(text) ? 'base64url' : 'base64')
  return key.length === 32 ? key : undefined
}
