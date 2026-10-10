import { randomUUID } from 'node:crypto'
import { STORE_REFERENCE } from '../shared/csv.ts'
import { dateInTimezone } from '../shared/finance.ts'
import { DEMO_MERCHANT, PRODUCTS } from '../shared/seed.ts'
import type { OutcomePayload } from '../shared/handoff.ts'
import type { SavedItem, Transaction } from '../shared/types.ts'
import { demoToday } from './demoClock.ts'
import type { SessionData, Store, StoredPurchase, StoredQuote } from './store.ts'

/** What Worth answers a verified report: `unknown` is a qid it holds no live quote for. */
export type OutcomeAnswer = { status: 'unknown' } | { status: 'ok'; recorded: boolean }

/**
 * A store's report of its own completed PayPal capture (specs/handoff-contract.md §5), already
 * verified. Idempotent on captureId: the first answer is kept under that unique key and every
 * repeat gets it again with no effect, so the store's capture path and its webhook can both send.
 *
 * It records only when the quote's session consented, Worth signed a result for the quote
 * (`returnedAt`, the anti-forwarding rule) and the session is still live, and only once per
 * quote. Recording adds one completed purchase, which lowers room to spend once until the funds
 * snapshot reflects it, and one Activity row at the captured amount and day, and removes the
 * Saved item for the store's page. Everything happens in one transaction.
 */
export function recordOutcome(store: Store, outcome: OutcomePayload, now: Date): OutcomeAnswer {
  const time = now.getTime()
  return store.atomic(() => {
    const first = store.outcome(outcome.captureId)
    if (first) return { status: 'ok', recorded: first.recorded }
    const quote = store.quote(outcome.qid, time)
    if (!quote || quote.mid !== outcome.mid) return { status: 'unknown' }
    const live = (store.expiry(quote.sessionId) ?? 0) > time
    const data = live ? store.get(quote.sessionId) : undefined
    const recorded = Boolean(
      data && quote.consent && quote.returnedAt !== undefined && !store.quoteRecorded(quote.qid),
    )
    if (recorded) addPayment(store, quote, outcome, data!)
    store.putOutcome(outcome.captureId, quote.qid, quote.sessionId, recorded, time)
    return { status: 'ok', recorded }
  })
}

function addPayment(store: Store, quote: StoredQuote, outcome: OutcomePayload, data: SessionData) {
  // The plan's own calendar day, as for Worth's own captures; the sample persona under the demo
  // clock uses the clock's day so the row sits with every other date shown.
  const day = demoToday(data) ?? dateInTimezone(outcome.capturedAt, data.profile.timezone)
  const purchase: StoredPurchase = {
    id: randomUUID(),
    // Namespaced: the store's product IDs are its own, never Worth's catalog.
    productId: `${quote.mid}:${quote.productId}`,
    name: quote.item,
    // The captured amount is what left the shopper's account (tax or shipping may differ).
    amountCents: outcome.amountCents,
    currency: 'USD',
    mode: 'sandbox',
    status: 'completed',
    createdAt: outcome.capturedAt,
    completedAt: outcome.capturedAt,
    completedOn: day,
    profileVersion: data.profile.version,
    assessmentDate: day,
    // Worth sees one captured amount; the store's checkout is the only place a plan was chosen.
    paymentPlan: { product: 'full' },
    acknowledgedShortfall: false,
    reportedBy: quote.merchant,
    ...(outcome.amountCents !== quote.amountCents ? { quotedCents: quote.amountCents } : {}),
    reportNotice: true,
    storeReport: {
      mid: outcome.mid,
      qid: quote.qid,
      orderId: outcome.orderId,
      captureId: outcome.captureId,
    },
  }
  store.putPurchase(quote.sessionId, purchase)
  const row: Transaction = {
    id: `purchase-${purchase.id}`,
    date: day,
    name: quote.item,
    amountCents: -outcome.amountCents,
    currency: 'USD',
    category: 'Shopping',
    kind: 'expense',
    status: 'completed',
    source: 'purchase',
    // Not a PayPal transaction ID the shopper's export carries: the store's capture is its own.
    referenceId: `${STORE_REFERENCE}${outcome.captureId}`,
  }
  data.transactions.unshift(row)
  for (const item of data.saved ?? [])
    if (item.status !== 'removed' && fromQuote(item, quote)) {
      item.status = 'removed'
      delete item.waitDate
    }
  data.profile.version += 1
  store.save(quote.sessionId, data)
}

/**
 * A Saved item for what the store sold: saved from /check, with the store page's link, or, for
 * the demo store, the same item from Worth's catalog (the sample plan's Saved list).
 */
function fromQuote(item: SavedItem, quote: StoredQuote) {
  if (item.qid === quote.qid) return true
  if (item.sourceUrl && sameLink(item.sourceUrl, quote.returnUrl)) return true
  return (
    item.kind === 'catalog' &&
    item.productId === quote.productId &&
    quote.merchant === DEMO_MERCHANT &&
    PRODUCTS.some((p) => p.id === quote.productId && p.merchant === DEMO_MERCHANT)
  )
}

function sameLink(a: string, b: string) {
  try {
    const left = new URL(a)
    const right = new URL(b)
    left.hash = ''
    right.hash = ''
    return left.href === right.href
  } catch {
    return false
  }
}
