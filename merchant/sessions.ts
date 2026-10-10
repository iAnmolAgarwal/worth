import { randomBytes } from 'node:crypto'

/** The quote ID this shopper holds for one product. */
export interface QuoteRecord {
  qid: string
  productId: string
}
/** A PayPal order this store created for one shopper, with the quote it came from. */
export interface OrderRecord {
  /** The store's own reference: PayPal's custom_id, reference_id and invoice_id. */
  id: string
  orderId: string
  productId: string
  name: string
  amountCents: number
  qid?: string
  merchantId?: string
}
interface Session {
  /** One quote ID per product, kept for the session's life and re-signed on every render. */
  quotes: Map<string, string>
  expires: number
}

const DAY_MS = 24 * 60 * 60 * 1000
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/

/**
 * The store's first-party session, kept in memory: the store holds no shopper data beyond which
 * quote ID it gave this shopper for each product (contract §3.1) and the orders it created. The
 * quote ID stays the same across renders, so the order reports back the qid Worth opened. A
 * restart forgets the session; a verified result from Worth then pins its qid again.
 */
export class Sessions {
  private readonly sessions = new Map<string, Session>()
  private readonly orders = new Map<string, OrderRecord & { sessionId: string; expires: number }>()
  constructor(
    private readonly now: () => number = Date.now,
    readonly maxSessions = 10_000,
  ) {}

  /** The live session for this cookie value, or a new one. */
  resolve(cookie: unknown): { id: string; created: boolean } {
    const time = this.now()
    if (typeof cookie === 'string' && SESSION_ID.test(cookie)) {
      const session = this.sessions.get(cookie)
      if (session && session.expires > time) {
        session.expires = time + DAY_MS
        return { id: cookie, created: false }
      }
    }
    if (this.sessions.size >= this.maxSessions) this.cleanup()
    // Beyond the cap the oldest session goes first; Map order is creation order.
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) break
      this.sessions.delete(oldest)
    }
    const id = randomBytes(32).toString('base64url')
    this.sessions.set(id, { quotes: new Map(), expires: time + DAY_MS })
    return { id, created: true }
  }

  /** This shopper's quote ID for a product, minting one the first time. */
  quoteId(sessionId: string, productId: string, mint: () => string): string {
    const session = this.sessions.get(sessionId)
    const existing = session?.quotes.get(productId)
    if (existing) return existing
    const qid = mint()
    session?.quotes.set(productId, qid)
    return qid
  }

  /**
   * Adopts the qid from a verified Worth result when this shopper holds none for the product (a
   * restarted store, or a cleared cookie), so the order still reports back the quote Worth opened.
   */
  pinQuote(sessionId: string, productId: string, qid: string) {
    const session = this.sessions.get(sessionId)
    if (!session || session.quotes.has(productId) || this.quote(sessionId, qid)) return
    session.quotes.set(productId, qid)
  }

  /** The quote with this ID, only if this session holds it. */
  quote(sessionId: string, qid: string): QuoteRecord | undefined {
    for (const [productId, held] of this.sessions.get(sessionId)?.quotes ?? [])
      if (held === qid) return { qid, productId }
    return undefined
  }

  /** The quote this session holds for a product: the one an order reports back against. */
  quoteFor(sessionId: string, productId: string): QuoteRecord | undefined {
    const qid = this.sessions.get(sessionId)?.quotes.get(productId)
    return qid ? { qid, productId } : undefined
  }

  addOrder(sessionId: string, order: OrderRecord) {
    this.orders.set(order.orderId, { ...order, sessionId, expires: this.now() + DAY_MS })
  }

  /** The order, only for the session that created it. */
  order(sessionId: string, orderId: string): OrderRecord | undefined {
    const order = this.orders.get(orderId)
    return order && order.sessionId === sessionId && order.expires > this.now() ? order : undefined
  }

  updateOrder(orderId: string, patch: Partial<OrderRecord>) {
    const order = this.orders.get(orderId)
    if (order) Object.assign(order, patch)
  }

  cleanup() {
    const time = this.now()
    for (const [id, session] of this.sessions) if (session.expires <= time) this.sessions.delete(id)
    for (const [id, order] of this.orders) if (order.expires <= time) this.orders.delete(id)
  }
}
