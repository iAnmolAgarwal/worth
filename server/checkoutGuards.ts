import { compareOptions, money, WAIT_SEARCH_DAYS } from '../shared/finance.ts'
import type { FinancialProfile, Product, Purchase } from '../shared/types.ts'
import { dateLabel } from './dates.ts'

export type CheckoutOption = 'buyToday' | 'wait' | 'spendLess'
export type CheckoutRefusal =
  | 'CHECKOUT_ACTIVE'
  | 'FUNDS_NOT_TODAY'
  | 'PLAN_INCOMPLETE'
  | 'WAIT_NOT_REACHED'
  | 'OVER_SPEND_LESS_LIMIT'
  | 'SHORTFALL_NOT_CONFIRMED'
export type CheckoutDecision =
  | {
      ok: true
      product: Product
      profileVersion: number
      today: string
    }
  | { ok: false; code: CheckoutRefusal; message: string }

function refuse(code: CheckoutRefusal, message: string): CheckoutDecision {
  return { ok: false, code, message }
}

/**
 * The plan guards behind the "Buy with PayPal" button on a saved plan: no other active checkout,
 * funds confirmed today, a complete plan, a fresh assessment for the chosen option, and the
 * cushion kept. Agents never prepare orders (decision 0.2); they link to the store's own page.
 */
export function checkoutGuards(input: {
  profile: FinancialProfile
  purchases: Purchase[]
  today: string
  product: Product
  request: { option: CheckoutOption }
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
          : `No day in the next ${WAIT_SEARCH_DAYS} days keeps your cushion for this price, so there is no wait date to buy on.`,
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
  if (!fits)
    return refuse(
      'SHORTFALL_NOT_CONFIRMED',
      'Buying this today dips below your cushion. Worth prepares the order only if you say you want to go ahead anyway.',
    )
  return { ok: true, product, profileVersion: comparison.profileVersion, today }
}
