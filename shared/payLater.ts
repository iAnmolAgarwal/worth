/** The part of PayPal's SDK v6 `findEligibleMethods` answer that says which Pay Later is offered. */
export interface PayLaterAnswer {
  isEligible(method: 'paylater'): boolean
  getDetails?(method: 'paylater'): { productCode?: string; countryCode?: string } | undefined
}

/**
 * Whether PayPal's v6 answer offers Pay in 4. PayPal names it `PAY_LATER_SHORT_TERM` (US); its
 * other code, `PAYLATER`, and anything unknown don't say which product, so they give undefined
 * (unknown) rather than a no. Only "not eligible for Pay Later at all" is a no.
 */
export function payIn4Offer(answer: PayLaterAnswer): boolean | undefined {
  if (!answer.isEligible('paylater')) return false
  const details = answer.getDetails?.('paylater')
  return details?.productCode === 'PAY_LATER_SHORT_TERM' && details.countryCode === 'US'
    ? true
    : undefined
}
