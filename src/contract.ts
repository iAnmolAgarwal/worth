/**
 * Phase 3 fields from specs/contract-phase3-4.md. The server adds them alongside the shared types;
 * until it does, every one is optional and the UI renders it only when present.
 */
import type {
  AppState as SharedState,
  ChatReply as SharedReply,
  Comparison as SharedComparison,
  PayIn4Comparison,
  PayIn4Scenario,
  Purchase as SharedPurchase,
} from '../shared/types'

export interface PurchaseLifecycle {
  /** PayPal's approval or payer-action link while approval is needed. */
  approveUrl?: string
  /** True after a declined capture (INSTRUMENT_DECLINED / PAYER_ACTION_REQUIRED). */
  needsReapproval?: boolean
  /** A user-facing message, never raw PayPal JSON. */
  lastError?: { code: string; message: string }
  /** 'agent' when Claude's prepare_checkout created it. */
  preparedBy?: 'agent' | 'user'
  /** Capture below the cushion needs an explicit "buy anyway" and `acknowledgeShortfall: true`. */
  proceedConfirmRequired?: boolean
}
export type Purchase = SharedPurchase & PurchaseLifecycle
export type AppState = Omit<SharedState, 'purchases'> & { purchases: Purchase[] }

export interface AgentCheckout {
  purchaseId: string
  orderId: string
  approveUrl: string
  itemName: string
  amountCents: number
  option: 'buyToday' | 'wait' | 'spendLess'
  /** The user chose to proceed despite a shortfall; the UI must ask again first. */
  requiresProceedConfirm: boolean
}
export type ChatReply = SharedReply & { checkout?: AgentCheckout }

export type PayIn4Eligibility = 'paypal' | 'range-only' | 'unavailable'
export type PayIn4 =
  | (PayIn4Scenario & { eligibility?: PayIn4Eligibility })
  | (Extract<PayIn4Comparison, { available: false }> & { eligibility?: PayIn4Eligibility })
export type Comparison = Omit<SharedComparison, 'payIn4'> & { payIn4: PayIn4 }

export const ACTIVE_STATUSES: readonly Purchase['status'][] = ['created', 'pending', 'unknown']
export const isActive = (purchase: Purchase) => ACTIVE_STATUSES.includes(purchase.status)
