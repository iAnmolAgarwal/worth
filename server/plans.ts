import { addDays } from '../shared/finance.ts'
import type { PlanInstalment, PurchaseRefund } from '../shared/types.ts'
import type { Store, StoredPurchase } from './store.ts'

/** A rejected plan or refund change, mapped to an HTTP response by the app. */
export class PlanError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

export type PlanInput = { product: 'full' } | { product: 'payIn4'; instalments: PlanInstalment[] }

export interface RefundConfirmation {
  returnedCents: number
  remainingInstalments?: PlanInstalment[]
}

/** Payments can't be scheduled more than a year after the purchase. */
const LATEST_PAYMENT_DAYS = 366

function settled(purchase: StoredPurchase) {
  if (purchase.status !== 'completed' || purchase.archived)
    throw new PlanError(
      409,
      'Only a completed purchase in your current plan can have its repayment confirmed.',
      'PURCHASE_NOT_COMPLETED',
    )
}

/** Checks a schedule against the day of purchase: whole cents, in date order, at most four. */
function checkSchedule(purchase: StoredPurchase, instalments: PlanInstalment[]) {
  if (instalments.length > 4) throw new PlanError(400, 'Enter at most 4 payments.', 'INVALID_PLAN')
  if (instalments.some((item) => !Number.isSafeInteger(item.amountCents) || item.amountCents <= 0))
    throw new PlanError(400, 'Each payment needs an amount above $0.', 'INVALID_PLAN')
  if (instalments.some((item, index) => index > 0 && item.date <= instalments[index - 1]!.date))
    throw new PlanError(
      400,
      'List the payment dates in order, one payment per date.',
      'INVALID_PLAN',
    )
  // The first Pay in 4 payment is due at purchase, which is the day the checkout was assessed.
  const purchasedOn = purchase.assessmentDate
  if (instalments.some((item) => item.date < purchasedOn))
    throw new PlanError(400, 'Payment dates can’t be before the purchase.', 'INVALID_PLAN')
  if (instalments.some((item) => item.date > addDays(purchasedOn, LATEST_PAYMENT_DAYS)))
    throw new PlanError(400, 'Payment dates must be within a year of the purchase.', 'INVALID_PLAN')
}

/**
 * Records the product the user actually used. A confirmed Pay in 4 schedule replaces the
 * full-price debit; its amounts must add up to the captured total.
 */
export function confirmPlan(purchase: StoredPurchase, input: PlanInput, now: Date): StoredPurchase {
  settled(purchase)
  if (purchase.refunds?.some((refund) => refund.status === 'confirmed'))
    throw new PlanError(
      409,
      'A confirmed refund already set the remaining payments for this purchase.',
      'REFUND_CONFIRMED',
    )
  const confirmedAt = now.toISOString()
  if (input.product === 'full')
    return { ...purchase, paymentPlan: { product: 'full', confirmedAt } }
  if (!input.instalments.length)
    throw new PlanError(400, 'Enter the payments PayPal scheduled.', 'INVALID_PLAN')
  checkSchedule(purchase, input.instalments)
  const total = input.instalments.reduce((sum, item) => sum + item.amountCents, 0)
  if (total !== purchase.amountCents)
    throw new PlanError(
      400,
      'The payments must add up to the total you paid at checkout.',
      'PLAN_TOTAL_MISMATCH',
    )
  return {
    ...purchase,
    paymentPlan: {
      product: 'payIn4',
      status: 'confirmed',
      instalments: input.instalments.map(({ date, amountCents }) => ({ date, amountCents })),
      confirmedAt,
    },
  }
}

/**
 * Records a refund for review. It changes nothing in the forecast until the user confirms it, and
 * recording the same refund ID again returns the existing record unchanged.
 */
export function recordRefund(
  store: Store,
  sessionId: string,
  purchaseId: string,
  refundId: string,
  amountCents: number,
  now: Date,
): { purchase: StoredPurchase; created: boolean } {
  if (!refundId || refundId.length > 100)
    throw new PlanError(400, 'A refund needs its PayPal refund ID.', 'INVALID_REFUND')
  return store.atomic(() => {
    const purchase = store.purchase(purchaseId, sessionId)
    if (!purchase) throw new PlanError(404, 'Purchase not found.', 'NOT_FOUND')
    if (purchase.refunds?.some((refund) => refund.id === refundId))
      return { purchase, created: false }
    if (
      store
        .purchases(sessionId)
        .some((other) => other.refunds?.some((refund) => refund.id === refundId))
    )
      throw new PlanError(409, 'This refund belongs to another purchase.', 'REFUND_CONFLICT')
    if (purchase.status !== 'completed')
      throw new PlanError(
        409,
        'Only a completed purchase can be refunded.',
        'PURCHASE_NOT_COMPLETED',
      )
    const refunded = (purchase.refunds ?? []).reduce((sum, refund) => sum + refund.amountCents, 0)
    if (
      !Number.isSafeInteger(amountCents) ||
      amountCents <= 0 ||
      refunded + amountCents > purchase.amountCents
    )
      throw new PlanError(
        400,
        'A refund must be above $0 and can’t exceed what was paid.',
        'INVALID_REFUND',
      )
    const refund: PurchaseRefund = {
      id: refundId,
      amountCents,
      status: 'review',
      createdAt: now.toISOString(),
    }
    const updated = { ...purchase, refunds: [...(purchase.refunds ?? []), refund] }
    store.putPurchase(sessionId, updated)
    return { purchase: updated, created: true }
  })
}

/**
 * Applies what the user says actually happened: the money that came back and, for Pay in 4, the
 * payments still due. Store credit counts as nothing returned and leaves the payments due.
 */
export function confirmRefund(
  purchase: StoredPurchase,
  refundId: string,
  input: RefundConfirmation,
  now: Date,
): StoredPurchase {
  settled(purchase)
  const refund = purchase.refunds?.find((item) => item.id === refundId)
  if (!refund) throw new PlanError(404, 'Refund not found.', 'NOT_FOUND')
  if (refund.status === 'confirmed')
    throw new PlanError(409, 'This refund is already confirmed.', 'REFUND_ALREADY_CONFIRMED')
  if (
    !Number.isSafeInteger(input.returnedCents) ||
    input.returnedCents < 0 ||
    input.returnedCents > refund.amountCents
  )
    throw new PlanError(
      400,
      'The money returned can’t be more than the merchant refunded.',
      'INVALID_REFUND',
    )
  const plan = purchase.paymentPlan
  const payIn4 = plan?.product === 'payIn4' && plan.status === 'confirmed'
  if (payIn4 && !input.remainingInstalments)
    throw new PlanError(
      400,
      'Enter the Pay in 4 payments that are still due after this refund.',
      'REMAINING_PAYMENTS_REQUIRED',
    )
  if (!payIn4 && input.remainingInstalments)
    throw new PlanError(
      400,
      'Remaining payments apply only to a confirmed Pay in 4 plan.',
      'INVALID_REFUND',
    )
  if (input.remainingInstalments) {
    checkSchedule(purchase, input.remainingInstalments)
    const total = input.remainingInstalments.reduce((sum, item) => sum + item.amountCents, 0)
    if (total > purchase.amountCents)
      throw new PlanError(
        400,
        'The remaining payments can’t add up to more than the purchase.',
        'INVALID_REFUND',
      )
  }
  const confirmed: PurchaseRefund = {
    ...refund,
    status: 'confirmed',
    returnedCents: input.returnedCents,
    ...(input.remainingInstalments
      ? {
          remainingInstalments: input.remainingInstalments.map(({ date, amountCents }) => ({
            date,
            amountCents,
          })),
        }
      : {}),
    confirmedAt: now.toISOString(),
  }
  return {
    ...purchase,
    refunds: purchase.refunds!.map((item) => (item.id === refundId ? confirmed : item)),
  }
}
