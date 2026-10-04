import { compareOptions, money } from '../shared/finance.ts'
import type { CheckoutHandoff, FinancialProfile, Product, Purchase } from '../shared/types.ts'
import { dateLabel } from './dates.ts'
import { mentionsItem } from './interpret.ts'

export type CheckoutOption = CheckoutHandoff['option']
export const CHECKOUT_OPTIONS = ['buyToday', 'wait', 'spendLess'] as const

/** What Claude may ask for. Price, currency and merchant never come from the model. */
export interface PrepareCheckoutRequest {
  itemId: string
  option: CheckoutOption
  /**
   * Claude's reading that the user chose to go ahead despite a shortfall. Required, but never
   * enough alone: the user's own words must say so too.
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

/**
 * The user's own words: quoted text and anything pasted after "says:", "page says", "wrote:" or a
 * role label such as "system:" is dropped, so merchant copy or injected text never counts.
 */
export function ownWords(message: string) {
  return message
    .replace(/[“"«][^”"»]*[”"»]/g, ' ')
    .replace(/(^|[\s:([])[‘'`][^’'`]*[’'`](?=$|[\s.,!?;:)\]])/g, '$1 ')
    .replace(
      /(?:\bpage\s+says|\b(?:says|said|wrote|reads)\s*:|\b(?:system|assistant|developer|tool|admin)\s*:)[\s\S]*$/i,
      ' ',
    )
}

/** Clauses: split at sentence and clause punctuation, so a negation applies to its own clause. */
function clauses(text: string) {
  return text
    .split(/[.,;:!?\n]+|\s[-–—]\s/)
    .map((clause) => clause.trim())
    .filter(Boolean)
}
/** Words that make a clause negative, conditional or contrastive. */
const QUALIFIER =
  /\b(?:don['’]?t|do\s+not|doesn['’]?t|not|never|no|if|unless|but|won['’]?t|wouldn['’]?t|shouldn['’]?t|can['’]?t|cannot|without|until|yet)\b/i
/** A purchase instruction at the start of a clause, optionally after "please" or "go ahead and". */
const INSTRUCTION =
  /^(?:(?:ok(?:ay)?|yes|please|so|now|then|great)\s+)*(?:(?:go\s+ahead\s+and|let['’]?s|i\s+(?:want|would\s+like)\s+to|i['’]d\s+like\s+to|i['’]?ll|i\s+will)\s+)?(?:buy|order|purchase|check\s*out|get|place\s+the\s+order|prepare\s+the\s+order)\b|^(?:(?:please|ok(?:ay)?|yes)\s+)*(?:check\s*out|place\s+(?:the|an|my)\s+order)\b/i
/** A message phrased as a question asks for advice, never for an order. */
const QUESTION_START =
  /^\s*(?:should|shall|is|are|am|do|does|did|can|could|would|will|may|might|when|what|how|which|why|where|who|whether)\b/i
/** Explicit words choosing to go ahead although the purchase dips below the cushion. */
const PROCEED =
  /\b(?:anyway|regardless|go\s+ahead|proceed|despite\s+(?:the|it|that|this)|even\s+though|even\s+so|i\s+accept)\b/i

/**
 * True only for an explicit purchase instruction in the user's own words: not a question, and no
 * clause tells Worth not to buy, or to buy only under a condition.
 */
export function asksToCheckOut(message: string) {
  const own = ownWords(message)
  if (/\?/.test(own) || QUESTION_START.test(own)) return false
  const parts = clauses(own)
  const instructions = parts.filter((clause) => INSTRUCTION.test(clause))
  if (!instructions.length || instructions.some((clause) => QUALIFIER.test(clause))) return false
  // "Don't buy …", "I won't order …" and the like anywhere in the message cancel the request.
  return !parts.some(
    (clause) =>
      QUALIFIER.test(clause) &&
      /\b(?:buy|order|purchase|check\s*out|get|go\s+ahead|proceed)\b/i.test(clause),
  )
}

/**
 * True only when the user's own words say, without negation or condition, to go ahead although
 * the purchase dips below the cushion. Any qualified proceed phrase in the message refuses.
 */
export function explicitlyProceeds(message: string) {
  const parts = clauses(ownWords(message))
  const proceeding = parts.filter((clause) => PROCEED.test(clause))
  return proceeding.length > 0 && !proceeding.some((clause) => QUALIFIER.test(clause))
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
  const { product, message } = input
  if (!asksToCheckOut(message))
    return refuse(
      'NOT_REQUESTED',
      'Worth prepares an order only when you ask to buy or check out. Ask again when you are ready.',
    )
  if (!product)
    return refuse('UNKNOWN_ITEM', 'Worth can prepare orders only for items in its sandbox catalog.')
  if (
    !mentionsItem(ownWords(message), product.name) &&
    !mentionsItem(input.contextItemName ?? '', product.name)
  )
    return refuse(
      'ITEM_NOT_DISCUSSED',
      `Say which catalog item you want, such as the ${product.name.toLowerCase()}, before Worth prepares an order.`,
    )
  return checkoutGuards({
    ...input,
    product,
    proceedDespiteShortfall: input.request.proceedDespiteShortfall && explicitlyProceeds(message),
  })
}

/**
 * The plan guards every prepared order passes, from Claude's tool or the "Buy with PayPal" button
 * on a saved plan: no other active checkout, funds confirmed today, a complete plan, and a fresh
 * assessment for the chosen option. Going ahead below the cushion needs an explicit decision.
 */
export function checkoutGuards(input: {
  profile: FinancialProfile
  purchases: Purchase[]
  today: string
  product: Product
  request: Pick<PrepareCheckoutRequest, 'option'>
  /** The user's own explicit decision to go ahead although the purchase dips below the cushion. */
  proceedDespiteShortfall: boolean
}): CheckoutDecision {
  const { profile, purchases, today, product, request } = input
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
          ? `Your plan suggests waiting until ${dateLabel(comparison.wait.date, today)}. Worth prepares the order on or after that day, after a fresh check.`
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
    // Going ahead below the cushion needs both Claude's reading and the user's own unqualified
    // words. Even then the order is stored unacknowledged, and capture asks the user again.
    if (request.option !== 'buyToday' || !input.proceedDespiteShortfall)
      return refuse(
        'SHORTFALL_NOT_CONFIRMED',
        'Buying this today dips below your cushion. Worth prepares the order only if you say you want to go ahead anyway.',
      )
  }
  return { ok: true, product, fits, profileVersion: comparison.profileVersion, today }
}

/**
 * The checks behind an order Claude asked for, in the order the server runs them: in
 * decideAgentCheckout, then checkoutGuards, then the checkout itself. Ask Worth's trace lists them.
 */
export const CHECKOUT_GUARDS = [
  { id: 'asked', label: 'You asked to buy or check out, in your own words' },
  { id: 'catalog_item', label: 'The item is in Worth’s sandbox catalog' },
  { id: 'item_named', label: 'You named this item in the conversation' },
  { id: 'one_checkout', label: 'No other checkout is in progress' },
  { id: 'funds_today', label: 'Your funds are confirmed for today' },
  { id: 'plan_complete', label: 'Your plan is complete' },
  { id: 'option_ready', label: 'A fresh check of the option you chose' },
  { id: 'cushion', label: 'Keeps your cushion, or you said to go ahead anyway' },
  { id: 'paypal', label: 'The PayPal sandbox is connected' },
  { id: 'plan_unchanged', label: 'Your plan didn’t change since that check' },
  {
    id: 'catalog_price',
    label: 'Price, currency and store come from the catalog, not from Claude',
  },
  { id: 'no_capture', label: 'Nothing is paid until you approve in PayPal and confirm in Worth' },
] as const
export type CheckoutGuardId = (typeof CHECKOUT_GUARDS)[number]['id']
const GUARD_FOR: Record<PrepareRefusal, CheckoutGuardId> = {
  NOT_REQUESTED: 'asked',
  UNKNOWN_ITEM: 'catalog_item',
  ITEM_NOT_DISCUSSED: 'item_named',
  CHECKOUT_ACTIVE: 'one_checkout',
  ALREADY_PREPARED: 'one_checkout',
  FUNDS_NOT_TODAY: 'funds_today',
  PLAN_INCOMPLETE: 'plan_complete',
  WAIT_NOT_REACHED: 'option_ready',
  OVER_SPEND_LESS_LIMIT: 'option_ready',
  SHORTFALL_NOT_CONFIRMED: 'cushion',
  PAYPAL_UNAVAILABLE: 'paypal',
  ASSESSMENT_EXPIRED: 'plan_unchanged',
}
/**
 * The guard decisions for one prepare_checkout result: every guard passed for a prepared order;
 * for a refusal, the guards before the one that refused passed and later ones did not run.
 */
export function checkoutGuardTrail(
  result: { ok: true } | { ok: false; code: PrepareRefusal },
): { id: CheckoutGuardId; label: string; passed: boolean }[] {
  if (result.ok) return CHECKOUT_GUARDS.map((guard) => ({ ...guard, passed: true }))
  const failed = CHECKOUT_GUARDS.findIndex((guard) => guard.id === GUARD_FOR[result.code])
  return CHECKOUT_GUARDS.slice(0, failed + 1).map((guard, index) => ({
    ...guard,
    passed: index < failed,
  }))
}
