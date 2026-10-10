// PayPal-first onboarding (P3a): the review drafted from an import preview, before anything is saved.
// Origin and certainty are separate: a row can come from PayPal and still be Worth's estimate.
import { addDays, daysBetween } from './finance.ts'
import type { ImportPreview, InstalmentPlanProposal, ScheduledFlow } from './types.ts'

/** The last day in the bundled sample export (src/sample/paypal-activity-sample.csv). */
export const SAMPLE_EXPORT_END = '2026-10-05'
/** PayPal Pay in 4 is four payments; a payment is due about every 2 weeks. */
const PAY_IN_4_PAYMENTS = 4
const PAYMENT_GAP_DAYS = 14

/**
 * Moves every date in the sample export by the same number of days so it ends yesterday, as a
 * fresh download would. The month it builds is then the same on any day: a payday in the file's
 * last days, the next one about two weeks later, and no row in the future, which the import would
 * refuse. Only the leading MM/DD/YYYY date of each row changes.
 */
export function shiftSampleExport(csv: string, today: string): string {
  const offset = daysBetween(SAMPLE_EXPORT_END, today) - 1
  if (!offset) return csv
  return csv.replace(/^"(\d{2})\/(\d{2})\/(\d{4})"/gm, (_match, month, day, year) => {
    const moved = addDays(`${year}-${month}-${day}`, offset)
    return `"${moved.slice(5, 7)}/${moved.slice(8, 10)}/${moved.slice(0, 4)}"`
  })
}

/** A Pay in 4 plan found in the file, as the review shows it. */
export interface DraftPlan {
  id: string
  /** The store, or null when the file has only the payments and not the purchase. */
  merchant: string | null
  /** What was bought, when the purchase row names it. */
  title?: string
  purchaseCents: number | null
  paymentCents: number
  /** Payments the file shows, pending or completed. */
  seen: number
  /** The last payment seen, or the purchase day when none was. */
  lastDate: string
  /**
   * Payments still to come. For a plan whose purchase is in the file it is Worth's estimate (four
   * less the payments seen); for one without, it stays undefined until the user answers.
   */
  left?: number
  included: boolean
}

/** Plans from the preview that may still have payments to come. A plan with all four seen is done. */
export function draftPlans(proposals: InstalmentPlanProposal[]): DraftPlan[] {
  return proposals.flatMap((plan) => {
    const dated = plan.purchaseCents !== null
    const seen = plan.payments.length
    if (dated && seen >= PAY_IN_4_PAYMENTS) return []
    return [
      {
        id: plan.id,
        merchant: dated ? plan.name : null,
        ...(dated && plan.title ? { title: plan.title } : {}),
        purchaseCents: plan.purchaseCents,
        paymentCents: plan.paymentCents,
        seen,
        lastDate: plan.payments.at(-1)?.date ?? plan.startDate,
        left: dated ? Math.max(1, PAY_IN_4_PAYMENTS - seen) : undefined,
        included: true,
      },
    ]
  })
}

/** The estimated dates of a plan's remaining payments: every 2 weeks, from today on. */
export function planDates(plan: Pick<DraftPlan, 'lastDate' | 'left'>, today: string): string[] {
  let next = addDays(plan.lastDate, PAYMENT_GAP_DAYS)
  while (next < today) next = addDays(next, PAYMENT_GAP_DAYS)
  return Array.from({ length: plan.left ?? 0 }, (_, index) =>
    addDays(next, PAYMENT_GAP_DAYS * index),
  )
}

/**
 * "Larkspur Supply · Headphones · Pay in 4": the store, then the item when the export names it, or a
 * neutral name when the purchase isn't in the file.
 */
export const planName = (plan: Pick<DraftPlan, 'merchant' | 'title'>) =>
  [plan.merchant ?? 'Earlier purchase', plan.title, 'Pay in 4'].filter(Boolean).join(' · ')

/** A plan's remaining payments as plan flows, from PayPal. None when it is left out or all paid. */
export function planFlows(plan: DraftPlan, today: string): ScheduledFlow[] {
  if (!plan.included || !plan.left) return []
  const planId = `paypal-plan:${plan.id}`.slice(0, 90)
  return planDates(plan, today).map((date, index) => ({
    id: `${planId}-${index + 1}`,
    planId,
    name: planName(plan),
    amountCents: plan.paymentCents,
    nextDate: date,
    cadence: 'once',
    kind: 'installment',
    category: 'Instalment plans',
    confirmed: true,
    active: true,
    origin: 'paypal',
    ...(plan.purchaseCents === null ? {} : { planTotalCents: plan.purchaseCents }),
  }))
}

/**
 * The paydays, bills and subscriptions to review: the ones already in an imported plan, then the
 * new repeats this file found (from PayPal, ticked). A repeat named like an existing item is
 * skipped, as the import itself does.
 */
export function draftFlows(preview: ImportPreview, existing: ScheduledFlow[]): ScheduledFlow[] {
  const kept = existing.filter((flow) => flow.kind !== 'installment')
  const names = new Set(kept.map((flow) => flow.name.toLowerCase()))
  return [
    ...kept,
    ...preview.recurring
      .filter((flow) => !names.has(flow.name.toLowerCase()))
      .map((flow) => ({ ...flow, origin: 'paypal' as const, confirmed: true })),
  ]
}

/** What the plan holds by where it came from: "How your month was built". Active items only. */
export function originCounts(flows: ScheduledFlow[]) {
  const active = flows.filter((flow) => flow.active)
  const paypal = active.filter((flow) => flow.origin === 'paypal')
  return {
    paydays: paypal.filter((flow) => flow.kind === 'income').length,
    bills: paypal.filter((flow) => flow.kind === 'bill' || flow.kind === 'subscription').length,
    plans: new Set(
      paypal.filter((flow) => flow.kind === 'installment').map((flow) => flow.planId ?? flow.id),
    ).size,
    /** Items the user added; anything without an origin was entered by hand before P3a. */
    added: active.filter((flow) => flow.origin !== 'paypal'),
  }
}

/** The calm timeline wording for a plan payment next to a bill: "the day after Maple Court rent". */
export function dayPhrase(daysFromPayment: number, bill: string) {
  if (daysFromPayment === 0) return `the same day as ${bill}`
  if (Math.abs(daysFromPayment) === 1)
    return `the day ${daysFromPayment > 0 ? 'before' : 'after'} ${bill}`
  return `${Math.abs(daysFromPayment)} days ${daysFromPayment > 0 ? 'before' : 'after'} ${bill}`
}
