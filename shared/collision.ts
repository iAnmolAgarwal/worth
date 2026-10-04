// Wording for Pay in 4 payments that land next to a bill. Worth's schedule is illustrative: it
// spaces payments 14 days apart, while PayPal's own schedule can run 15–16 days apart (sandbox,
// Oct 2026). Every collision is therefore "about" a day count, never day-precise.

/** How the strip and the comparison describe the spacing. */
export const PAY_IN_4_SPACING = 'about every 2 weeks'
/** The note under every illustrative schedule in Ask Worth. */
export const PAY_IN_4_DATES_NOTE =
  'Schedule is illustrative; PayPal’s may differ by a few days. PayPal sets the exact dates at checkout.'

/**
 * "about 1 day after your apartment rent", from the days between a payment and a bill (positive
 * when the bill comes after the payment). `bill` is an already sanitized display name; another
 * plan's payment reads "your laptop plan payment".
 */
export function nearPhrase(daysFromPayment: number, bill: string, kind?: string) {
  const name =
    kind === 'installment' || kind === 'purchase'
      ? `your ${planLabel(bill)} plan payment`
      : `your ${bill.toLowerCase()}`
  const days = Math.abs(daysFromPayment)
  if (days === 0) return `about the same day as ${name}`
  return `about ${days} ${days === 1 ? 'day' : 'days'} ${daysFromPayment > 0 ? 'before' : 'after'} ${name}`
}

interface NearbyPayment {
  number: number
  nearestBill: {
    name: string
    amountCents: number
    kind: string
    daysFromInstalment: number
  } | null
}
/** "payment 2 would land about 1 day after your apartment rent". */
export function collisionLine(payment: NearbyPayment) {
  const bill = payment.nearestBill!
  return `payment ${payment.number} would land ${nearPhrase(bill.daysFromInstalment, bill.name, bill.kind)}`
}
/** The collision worth naming first: a bill before a subscription or a plan payment, the larger first. */
export function mainCollision<T extends NearbyPayment>(payments: T[]): T | undefined {
  const rank = (kind: string) => (kind === 'bill' ? 0 : kind === 'subscription' ? 2 : 1)
  return payments
    .filter((p) => p.nearestBill)
    .sort(
      (a, b) =>
        rank(a.nearestBill!.kind) - rank(b.nearestBill!.kind) ||
        b.nearestBill!.amountCents - a.nearestBill!.amountCents ||
        a.number - b.number,
    )[0]
}

/** "laptop" from a plan named "Laptop · Pay in 4". */
export function planLabel(name: string) {
  const label = name
    .split('·')[0]!
    .replace(/\bpay\s+in\s+4\b/i, '')
    .trim()
  return (label || 'instalment').toLowerCase()
}
