import type { OptionResult } from '../shared/types'
import type { Comparison, PayIn4 } from './contract'
import { paydayOn } from './engine'
import { dayLabel, money, shortDate, signed } from './format'

/** The Pay in 4 comparison's words, kept apart from the components that show them. */
type P4 = Extract<PayIn4, { available: true }>

/** What the plain line means with Pay in 4 open, so "Pay in full" always says when you'd pay. */
export function fullPayName(c: Comparison, option: OptionResult) {
  if (option === c.buyToday) return 'Pay in full today'
  if (option === c.wait && c.wait.date) return `Pay in full on ${shortDate(c.wait.date)}`
  return `Spend ${money(c.spendLess.maxPriceCents)} today`
}

/**
 * The Pay in 4 comparison's point in one line: each line's lowest point, its day and amount, and
 * whether it goes below the cushion. Pay in 4 is one option, stated as plainly as paying in full.
 */
export function payIn4Thesis(c: Comparison, option: OptionResult, p4: P4) {
  const start = p4.instalments[0]?.date ?? c.today
  const from = start === c.today ? `from today, ${shortDate(start)}` : `from ${dayLabel(start)}`
  const how =
    option === c.buyToday
      ? 'paying in full today'
      : option === c.wait && c.wait.date
        ? `paying in full on ${dayLabel(c.wait.date)}`
        : `spending ${money(c.spendLess.maxPriceCents)} today instead`
  const below = (value: number) => (value < c.cushionCents ? ', below your cushion' : '')
  const p4Low = `${dayLabel(p4.lowestDate)} at ${signed(p4.lowestBalanceCents)}${below(p4.lowestBalanceCents)}`
  const fullLow = `${option.lowestDate === p4.lowestDate ? 'the same day' : dayLabel(option.lowestDate)} at ${signed(option.lowestBalanceCents)}${below(option.lowestBalanceCents)}`
  return `With PayPal Pay in 4 ${from}, your lowest point is ${p4Low}; ${how}, it’s ${fullLow}.`
}

/**
 * The Pay in 4 summary in two lines that name their dates for what they are: the day the balance
 * first goes below the cushion, then the lowest point. The engine's own label is unchanged.
 */
export function payIn4Lines(p4: P4, cushion: number) {
  // Pay in 4 only adds payments, so its first day below the cushion is the earliest of all. It is
  // put down to Pay in 4 only when the plan without it is still above the cushion that day.
  const first = p4.points.find((point) => point.minimumCents < cushion)
  const lead =
    p4.outcome === 'incomplete' || !first
      ? p4.label
      : first.baselineMinimumCents >= cushion
        ? `With Pay in 4, your balance would first go below your cushion on ${dayLabel(first.date)}`
        : `Your plan first goes below your cushion on ${dayLabel(first.date)}, even without this purchase`
  const day =
    first && first.date === p4.lowestDate ? 'that same day' : `on ${dayLabel(p4.lowestDate)}`
  const payday = paydayOn(p4.points, p4.lowestDate) ? ', before payday' : ''
  // The payment that sets the low, so a first dip and a later lowest day never read as a clash.
  const payment = p4.lowPointCause?.name.match(/Pay in 4 payment (\d) of 4$/)?.[1]
  const cause =
    payment && p4.lowPointCause!.date !== p4.lowestDate
      ? // After the first, every date is PayPal's to set, so it is "about", as on the schedule.
        ` Payment ${payment} (${money(p4.lowPointCause!.amountCents)}) lands ${payment === '1' ? '' : 'about '}${dayLabel(p4.lowPointCause!.date)}.`
      : ''
  return { lead, low: `Lowest point ${signed(p4.lowestBalanceCents)} ${day}${payday}.${cause}` }
}
