/**
 * The Phase 3 / Phase 4 contract (specs/contract-phase3-4.md), now part of the shared types:
 * purchase lifecycle fields, the agent's checkout hand-off and Pay in 4 eligibility.
 */
import { plainText } from '../shared/text'
import type { Alternative, Purchase, SavedItem } from '../shared/types'

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
  | {
      kind: 'custom'
      name: string
      amountCents: number
      retailer?: string
      url?: string
      channel3Id?: string
    }
/**
 * A Channel3 row saved for later (spec item 15): a custom item, "Assessment only — not sold in the
 * demo store", that keeps the product's ID so its price can be checked again from Saved.
 */
export const alternativeTarget = (item: Alternative): SaveTarget => ({
  kind: 'custom',
  // Hidden characters a listing title may carry are dropped, so a real title always saves.
  name: plainText(item.title).slice(0, 120),
  amountCents: item.priceCents,
  retailer: plainText(item.retailer).slice(0, 80),
  url: item.url,
  channel3Id: item.id,
})
export type SavePlan = { option?: SavedItem['option']; waitDate?: string }
/** The POST /api/saved body: a plan date always belongs to the wait option. */
export function saveRequest(target: SaveTarget, plan: SavePlan = {}) {
  return { ...target, ...(plan.waitDate ? { option: 'wait', waitDate: plan.waitDate } : plan) }
}
