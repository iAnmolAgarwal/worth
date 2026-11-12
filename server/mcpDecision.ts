/**
 * The decision contract check_affordability returns to outside agents, after the "Buy or Wait?"
 * contract (HackerRank Orchestrate, September 2026). It is a mapping of Worth's own assessment and
 * nothing more: every value comes from assessPurchase, and no financial rule is added here.
 *
 * A coherence gate checks the invariants in code before anything is returned. A decision that
 * fails it is never sent; the tool refuses instead (fail closed).
 */
import { money } from '../shared/finance.ts'
import type { Assessment } from '../shared/types.ts'

export const STATUSES = ['affordable_now', 'affordable_later', 'not_affordable'] as const
export const ACTIONS = ['full_payment', 'wait', 'spend_less', 'not_recommended'] as const
export type AffordabilityStatus = (typeof STATUSES)[number]
export type RecommendedAction = (typeof ACTIONS)[number]

/** The decision fields, in cents and ISO dates; the tool converts cents to dollars. */
export interface Decision {
  /** The day the person would buy: the requested date, today by default. */
  requestDate: string
  requestedCents: number
  status: AffordabilityStatus
  action: RecommendedAction
  /** The most that keeps the cushion when paid on requestDate, capped at the requested amount. */
  safeCents: number
  /** The day the full amount keeps the cushion as one payment; null when none in 35 days. */
  earliest: string | null
  /** The payments of the action, in date order; empty when no payment of this item is advised. */
  plan: { date: string; amountCents: number }[]
  lowestCents: number
  lowestDate: string
  cushionCents: number
}

export type DecisionOutcome =
  | { ok: true; decision: Decision }
  | { ok: false; code: 'PLAN_INCOMPLETE' | 'EARLIER_DAY_FITS'; earliest?: string }

/**
 * Worth's assessment as a decision. Fits on the requested date: affordable now, pay in full. A
 * later day in the 35-day search fits: affordable later, wait. No day fits: not affordable, and
 * spending less is the option while any amount keeps the cushion. Pay in 4 never enters here.
 */
export function decide(a: Assessment): DecisionOutcome {
  // Fail closed: an incomplete plan never gets a guessed verdict.
  if (a.outcome === 'incomplete') return { ok: false, code: 'PLAN_INCOMPLETE' }
  const base = {
    requestDate: a.purchaseDate,
    requestedCents: a.amountCents,
    safeCents: Math.max(0, Math.min(a.maxAffordableCents, a.amountCents)),
    lowestCents: a.lowestBalanceCents,
    lowestDate: a.lowestDate,
    cushionCents: a.cushionCents,
  }
  if (a.outcome === 'fits')
    return {
      ok: true,
      decision: {
        ...base,
        status: 'affordable_now',
        action: 'full_payment',
        earliest: a.purchaseDate,
        plan: [{ date: a.purchaseDate, amountCents: a.amountCents }],
      },
    }
  if (a.earliestDate && a.earliestDate > a.purchaseDate)
    return {
      ok: true,
      decision: {
        ...base,
        status: 'affordable_later',
        action: 'wait',
        earliest: a.earliestDate,
        plan: [{ date: a.earliestDate, amountCents: a.amountCents }],
      },
    }
  // The engine searches from today. A day before the requested date that fits is reported to the
  // agent to ask about, never relabelled as "later" or "not affordable".
  if (a.earliestDate) return { ok: false, code: 'EARLIER_DAY_FITS', earliest: a.earliestDate }
  return {
    ok: true,
    decision: {
      ...base,
      status: 'not_affordable',
      action: base.safeCents > 0 ? 'spend_less' : 'not_recommended',
      earliest: null,
      plan: [],
    },
  }
}

/** Every broken invariant, as "rule: detail"; [] when the decision hangs together. */
export function checkDecision(d: Decision, horizonEnd: string, explanation: string): string[] {
  const problems: string[] = []
  const add = (rule: string, detail: string) => problems.push(`${rule}: ${detail}`)
  if (!Number.isSafeInteger(d.safeCents) || d.safeCents < 0)
    add('amount', 'amount_safe_to_pay must be a whole number of cents, at least 0')
  if (d.safeCents > d.requestedCents)
    add('amount', 'amount_safe_to_pay exceeds the requested amount')
  if (!STATUSES.includes(d.status)) add('enum', `unknown affordability_status ${d.status}`)
  if (!ACTIONS.includes(d.action)) add('enum', `unknown recommended_action ${d.action}`)
  const dates = d.plan.map((p) => p.date)
  if (dates.some((date, i) => i > 0 && date < dates[i - 1]!))
    add('plan', 'payments are not in date order')
  if (d.plan.some((p) => !Number.isSafeInteger(p.amountCents) || p.amountCents <= 0))
    add('plan', 'every payment must be more than 0')
  if (d.plan.length && d.plan.reduce((sum, p) => sum + p.amountCents, 0) !== d.requestedCents)
    add('plan', 'payments must add up to the requested amount')
  if (d.earliest !== null && (d.earliest < d.requestDate || d.earliest > horizonEnd))
    add('earliest', 'earliest date is outside the requested date and the 35-day search')
  const onlyPayment = (date: string | null) =>
    d.plan.length === 1 && d.plan[0]!.date === date && d.plan[0]!.amountCents === d.requestedCents
  switch (d.status) {
    case 'affordable_now':
      if (d.action !== 'full_payment') add('status/action', 'affordable_now needs full_payment')
      if (d.earliest !== d.requestDate)
        add('status/earliest', 'affordable_now needs earliest = date')
      if (!onlyPayment(d.requestDate)) add('status/plan', 'affordable_now pays in full on the date')
      if (d.safeCents !== d.requestedCents)
        add('status/amount', 'affordable_now needs the full amount to be safe')
      if (d.lowestCents < d.cushionCents) add('status/lowest', 'affordable_now keeps the cushion')
      break
    case 'affordable_later':
      if (d.action !== 'wait') add('status/action', 'affordable_later needs wait')
      if (d.earliest === null || d.earliest <= d.requestDate)
        add('status/earliest', 'affordable_later needs an earliest date after the date')
      if (!onlyPayment(d.earliest)) add('status/plan', 'affordable_later pays in full on earliest')
      if (d.safeCents >= d.requestedCents)
        add('status/amount', 'affordable_later cannot have the full amount safe on the date')
      if (d.lowestCents >= d.cushionCents) add('status/lowest', 'buying on the date dips below')
      break
    case 'not_affordable':
      if (d.action !== 'spend_less' && d.action !== 'not_recommended')
        add('status/action', 'not_affordable needs spend_less or not_recommended')
      if ((d.action === 'spend_less') !== d.safeCents > 0)
        add('status/action', 'spend_less exactly when some amount is safe')
      if (d.earliest !== null) add('status/earliest', 'not_affordable has no earliest date')
      if (d.plan.length) add('status/plan', 'not_affordable has no payment plan')
      if (d.safeCents >= d.requestedCents)
        add('status/amount', 'not_affordable cannot have the full amount safe')
      if (d.lowestCents >= d.cushionCents) add('status/lowest', 'buying on the date dips below')
      break
  }
  if (!explanation.includes(money(d.requestedCents)))
    add('explanation', 'the explanation must name the requested amount')
  return problems
}
