import { draftPlans, planFlows } from '../shared/onboarding.ts'
import type { ImportPreview, Transaction } from '../shared/types.ts'
import type { SessionData } from './store.ts'

/** What a background PayPal read changed in a plan. */
export interface SyncChanges {
  /** New rows in Activity. */
  transactions: number
  /** Pay in 4 plans whose purchase this read found for the first time. */
  plans: number
  /** Payments of known Pay in 4 plans that PayPal now shows as made. */
  paid: number
}

export interface SyncOptions {
  /** Today in the plan's time zone. */
  today: string
  /** How the import merges history: the same rows are recorded once, a settled row replaces its pending one. */
  merge: (existing: Transaction[], incoming: Transaction[]) => Transaction[]
  /** Stored transactions per session. */
  maxTransactions: number
}

/**
 * Applies a background Connect PayPal read to a plan the user already confirmed, without the review
 * step, and only in ways that can't overwrite anything they confirmed:
 *
 * - new transactions are added to Activity (history only: money available is the user's figure);
 * - a Pay in 4 plan is added only when its purchase is new in this read, so a plan the user left out
 *   at review never comes back;
 * - a known plan drops a remaining payment PayPal now shows as made, only once that payment is due
 *   (an early payment changes nothing); a plan never gains payments this way.
 *
 * Bills, paydays, the cushion, money available and everyday spending are never touched, and nothing
 * is applied when the read has rows the import can't use. Returns undefined in that case.
 */
export function applyConnectedRead(
  data: SessionData,
  preview: ImportPreview,
  { today, merge, maxTransactions }: SyncOptions,
): SyncChanges | undefined {
  if (preview.errors.length || preview.needsDateOrder) return undefined
  const before = new Set(data.transactions.map((transaction) => transaction.id))
  // A store's report this read matches is kept as matched, as an import does.
  const matched = new Map((preview.storeMatches ?? []).map((m) => [m.reportId, m.importId]))
  const kept = data.transactions.map((transaction) =>
    matched.has(transaction.id)
      ? { ...transaction, matchedImportId: matched.get(transaction.id)! }
      : transaction,
  )
  const merged = merge(kept, preview.transactions)
  if (merged.length > maxTransactions) return undefined
  const changes: SyncChanges = {
    transactions: merged.filter((transaction) => !before.has(transaction.id)).length,
    plans: 0,
    paid: 0,
  }
  let flows = data.profile.flows
  for (const plan of draftPlans(preview.instalmentPlans)) {
    // A plan without its purchase needs the user's answer about what is left; never guessed here.
    if (plan.merchant === null) continue
    const planId = `paypal-plan:${plan.id}`.slice(0, 90)
    const current = flows
      .filter((flow) => flow.planId === planId)
      .sort((a, b) => a.nextDate.localeCompare(b.nextDate))
    if (!current.length) {
      const purchase = plan.id.replace(/^pay-later:/, '')
      if (before.has(purchase) || !plan.left) continue
      flows = [...flows, ...planFlows(plan, today)]
      changes.plans++
      continue
    }
    // Only payments already due are marked made: an early payment leaves the schedule as it is,
    // so room to spend never rises before the user's own balance shows the money gone.
    const due = current.filter((flow) => flow.nextDate <= today)
    const made = Math.min(due.length, current.length - (plan.left ?? current.length))
    if (made <= 0) continue
    const gone = new Set(due.slice(0, made).map((flow) => flow.id))
    flows = flows.filter((flow) => !gone.has(flow.id))
    changes.paid += made
  }
  // Merged even when nothing is new, so a pending row PayPal has since settled is updated.
  data.transactions = merged.sort((a, b) => b.date.localeCompare(a.date))
  if (flows !== data.profile.flows) {
    data.profile.flows = flows
    data.profile.version += 1
  }
  const dates = data.transactions
    .filter((transaction) => transaction.source === 'import')
    .map((transaction) => transaction.date)
    .sort()
  if (dates.length)
    data.profile.coverageDays =
      Math.round((Date.parse(dates.at(-1)!) - Date.parse(dates[0]!)) / 86_400_000) + 1
  return changes
}
