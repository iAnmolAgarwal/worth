import { compareOptions, money } from '../shared/finance.ts'
import type { CheckoutHandoff, FinancialProfile, Product, Purchase } from '../shared/types.ts'
import { mentionsItem } from './interpret.ts'

export type CheckoutOption = CheckoutHandoff['option']
export const CHECKOUT_OPTIONS = ['buyToday', 'wait', 'spendLess'] as const

/** What Claude may ask for. Price, currency and merchant never come from the model. */
export interface PrepareCheckoutRequest {
  itemId: string
  option: CheckoutOption
  /**
   * Claude's reading that the user chose to go ahead despite a shortfall. Advisory only: the
   * server decides from the user's own words.
   */
  proceedDespiteShortfall: boolean
}
export type PrepareCheckoutResult =
  { ok: true; checkout: CheckoutHandoff } | { ok: false; code: PrepareRefusal; message: string }
export type PrepareRefusal =
  | 'NOT_REQUESTED'
  | 'UNKNOWN_ITEM'
  | 'ITEM_NOT_DISCUSSED'
  | 'FUNDS_NOT_TODAY'
  | 'PLAN_INCOMPLETE'
  | 'WAIT_NOT_REACHED'
  | 'OVER_SPEND_LESS_LIMIT'
  | 'SHORTFALL_NOT_CONFIRMED'
  | 'CHECKOUT_ACTIVE'
  | 'ASSESSMENT_EXPIRED'
  | 'PAYPAL_UNAVAILABLE'
  | 'ALREADY_PREPARED'

/** A request to check out now, in the user's own words, rather than a question about affording. */
const CHECKOUT_REQUEST =
  /\b(?:buy|order|purchase|check\s*out|checkout|get|go\s+ahead|proceed|prepare)\b/i
const QUESTION_ONLY =
  /\b(?:can|could|should|may|would)\s+i\s+(?:afford|buy|get|purchase|order)\b|\bafford\b|\bwhen\s+(?:can|could|should)\b|\bhow\s+much\b/i
/** The user's own words choosing to go ahead although the plan dips below the cushion. */
const EXPLICIT_PROCEED =
  /\b(?:anyway|any\s+way|regardless|despite|even\s+(?:though|if|so)|proceed|go\s+ahead|i\s+understand|i\s+accept)\b/i

export function asksToCheckOut(message: string) {
  return CHECKOUT_REQUEST.test(message) && !QUESTION_ONLY.test(message)
}
export function explicitlyProceeds(message: string) {
  return EXPLICIT_PROCEED.test(message)
}

export interface CheckoutDecisionInput {
  profile: FinancialProfile
  purchases: Purchase[]
  today: string
  product: Product | undefined
  request: PrepareCheckoutRequest
  /** The user's latest message, and the item already being discussed, if any. */
  message: string
  contextItemName?: string
}
export type CheckoutDecision =
  | {
      ok: true
      product: Product
      /** False when the user explicitly chose to go ahead despite a shortfall. */
      fits: boolean
      profileVersion: number
      today: string
    }
  | { ok: false; code: PrepareRefusal; message: string }

function refuse(code: PrepareRefusal, message: string): CheckoutDecision {
  return { ok: false, code, message }
}

/**
 * The server-side gate for an order Claude prepares. Every condition is checked against the
 * stored plan and the server catalog: funds dated today, a fresh assessment for the chosen option
 * (or the user's explicit decision to go ahead), the catalog price, and no other active checkout.
 */
export function decideAgentCheckout(input: CheckoutDecisionInput): CheckoutDecision {
  const { profile, purchases, today, product, request, message } = input
  if (!asksToCheckOut(message))
    return refuse(
      'NOT_REQUESTED',
      'Worth prepares an order only when you ask to buy or check out. Ask again when you are ready.',
    )
  if (!product)
    return refuse('UNKNOWN_ITEM', 'Worth can prepare orders only for items in its sandbox catalog.')
  if (
    !mentionsItem(message, product.name) &&
    !mentionsItem(input.contextItemName ?? '', product.name)
  )
    return refuse(
      'ITEM_NOT_DISCUSSED',
      `Say which catalog item you want, such as the ${product.name.toLowerCase()}, before Worth prepares an order.`,
    )
  if (purchases.some((p) => ['created', 'pending', 'unknown'].includes(p.status)))
    return refuse(
      'CHECKOUT_ACTIVE',
      'You already have a checkout in progress. Finish or cancel it before starting another.',
    )
  if (!profile.confirmed || profile.snapshotDate !== today)
    return refuse(
      'FUNDS_NOT_TODAY',
      'Confirm today’s available funds before Worth prepares an order.',
    )
  const comparison = compareOptions(profile, purchases, {
    amountCents: product.priceCents,
    itemName: product.name,
    today,
  })
  if (comparison.missingFields.length || comparison.buyToday.outcome === 'incomplete')
    return refuse('PLAN_INCOMPLETE', 'Complete your plan before Worth prepares an order.')
  let fits: boolean
  if (request.option === 'wait') {
    if (comparison.wait.date !== today)
      return refuse(
        'WAIT_NOT_REACHED',
        comparison.wait.date
          ? `Your plan suggests waiting until ${comparison.wait.date}. Worth prepares the order on or after that day, after a fresh check.`
          : 'No day in the next 30 days keeps your cushion for this price, so there is no wait date to buy on.',
      )
    fits = comparison.wait.outcome === 'fits'
  } else if (request.option === 'spendLess') {
    if (product.priceCents > comparison.spendLess.maxPriceCents)
      return refuse(
        'OVER_SPEND_LESS_LIMIT',
        `The ${product.name.toLowerCase()} costs ${money(product.priceCents)}, more than the ${money(comparison.spendLess.maxPriceCents)} that keeps your cushion today.`,
      )
    fits = comparison.buyToday.outcome === 'fits'
  } else fits = comparison.buyToday.outcome === 'fits'
  if (!fits) {
    // Going ahead below the cushion rests on the user's own words. Claude's flag alone is never
    // enough, and the UI still asks the user to confirm before PayPal approval.
    if (request.option !== 'buyToday' || !explicitlyProceeds(message))
      return refuse(
        'SHORTFALL_NOT_CONFIRMED',
        'Buying this today dips below your cushion. Worth prepares the order only if you say you want to go ahead anyway.',
      )
  }
  return { ok: true, product, fits, profileVersion: comparison.profileVersion, today }
}
