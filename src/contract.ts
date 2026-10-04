/**
 * The Phase 3 / Phase 4 contract (specs/contract-phase3-4.md), now part of the shared types:
 * purchase lifecycle fields, the agent's checkout hand-off and Pay in 4 eligibility.
 */
import type { Purchase, SavedItem } from '../shared/types'

export type {
  Alternative,
  Alternatives,
  AppState,
  ChatReply,
  CheckoutHandoff as AgentCheckout,
  Comparison,
  PayIn4Comparison as PayIn4,
  PayIn4Eligibility,
  Purchase,
  SavedItem,
} from '../shared/types'

export const ACTIVE_STATUSES: readonly Purchase['status'][] = ['created', 'pending', 'unknown']
export const isActive = (purchase: Purchase) => ACTIVE_STATUSES.includes(purchase.status)

/** What to send to save an item: a catalog product, or any assessed item as a custom one. */
export type SaveTarget =
  | { kind: 'catalog'; productId: string }
  | { kind: 'custom'; name: string; amountCents: number; retailer?: string; url?: string }
export type SavePlan = { option?: SavedItem['option']; waitDate?: string }
/** The POST /api/saved body: a plan date always belongs to the wait option. */
export function saveRequest(target: SaveTarget, plan: SavePlan = {}) {
  return { ...target, ...(plan.waitDate ? { option: 'wait', waitDate: plan.waitDate } : plan) }
}
