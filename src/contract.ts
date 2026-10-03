/**
 * The Phase 3 / Phase 4 contract (specs/contract-phase3-4.md), now part of the shared types:
 * purchase lifecycle fields, the agent's checkout hand-off and Pay in 4 eligibility.
 */
import type { Purchase } from '../shared/types'

export type {
  AppState,
  ChatReply,
  CheckoutHandoff as AgentCheckout,
  Comparison,
  PayIn4Comparison as PayIn4,
  PayIn4Eligibility,
  Purchase,
} from '../shared/types'

export const ACTIVE_STATUSES: readonly Purchase['status'][] = ['created', 'pending', 'unknown']
export const isActive = (purchase: Purchase) => ACTIVE_STATUSES.includes(purchase.status)
