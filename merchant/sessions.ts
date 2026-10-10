import { randomBytes } from 'node:crypto'

/** A quote this shopper's page was given: which product it named. */
export interface QuoteRecord {
  qid: string
  productId: string
  issuedAt: number
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
  quotes: QuoteRecord[]
  expires: number
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Recent quotes kept per shopper; older ones fall off. */
const MAX_QUOTES = 20
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/

/**
 * The store's first-party session, kept in memory: the store holds no shopper data beyond which
 * quotes it minted for whom (contract §3.1) and the orders it created. A restart forgets both,
 * which only means a later report-back cannot name a quote; PayPal's custom_id still carries it.
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
    this.sessions.set(id, { quotes: [], expires: time + DAY_MS })
    return { id, created: true }
  }

  addQuote(sessionId: string, qid: string, productId: string) {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.quotes.push({ qid, productId, issuedAt: this.now() })
    if (session.quotes.length > MAX_QUOTES)
      session.quotes.splice(0, session.quotes.length - MAX_QUOTES)
  }

  /** The quote with this ID, only if this session was given it. */
  quote(sessionId: string, qid: string): QuoteRecord | undefined {
    return this.sessions.get(sessionId)?.quotes.find((q) => q.qid === qid)
  }

  /** The newest quote this session holds for a product: the one an order reports back against. */
  latestQuote(sessionId: string, productId: string): QuoteRecord | undefined {
    const quotes = this.sessions.get(sessionId)?.quotes ?? []
    for (let i = quotes.length - 1; i >= 0; i--)
      if (quotes[i]!.productId === productId) return quotes[i]
    return undefined
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
