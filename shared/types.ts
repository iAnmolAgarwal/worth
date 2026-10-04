export type Currency = 'USD'
export type Outcome = 'fits' | 'tight' | 'incomplete'
export type Cadence = 'once' | 'weekly' | 'biweekly' | 'monthly' | 'yearly'
/** `installment` is one payment of an instalment plan already running, from PayPal or another provider. */
export type FlowKind = 'income' | 'subscription' | 'bill' | 'installment'
export interface ScheduledFlow {
  id: string
  name: string
  amountCents: number
  nextDate: string
  /**
   * Day of the month that monthly and yearly items fall on: 1–31 (clamped to shorter months) or
   * 'last' for the last day of each month. Without it, the day of `nextDate` is used.
   */
  anchorDay?: number | 'last'
  cadence: Cadence
  kind: FlowKind
  category: string
  confirmed: boolean
  active: boolean
  color?: string
  icon?: string
  /** Groups the payments of one instalment plan. Payments without it count as their own plan. */
  planId?: string
  /**
   * Date of an occurrence the user already paid. When it is on or before the funds snapshot, the
   * snapshot already reflects it, so the forecast skips that occurrence.
   */
  paidOn?: string
}
export interface FinancialProfile {
  name: string
  balanceCents: number
  cushionCents: number
  dailySpendCents: number
  currency: Currency
  timezone: string
  snapshotDate: string
  confirmedAt: string
  version: number
  confirmed: boolean
  coverageDays: number
  source: 'demo' | 'import'
  missingFields: string[]
  flows: ScheduledFlow[]
  reflectedPurchaseIds: string[]
  aiConsent: boolean
  /**
   * Set by the server once the user saves their own financial inputs or imports history.
   * Purchases and other server updates never set it. Absent on older records, which count as edited.
   */
  userEdited?: boolean
  /**
   * Set once the user turns Claude on or off themselves. The untouched sample profile uses Claude
   * by default; this records an explicit opt-out so it is respected.
   */
  aiChoiceMade?: boolean
}
export interface Transaction {
  id: string
  date: string
  name: string
  amountCents: number
  currency: string
  category: string
  /**
   * `adjustment` is a PayPal balance correction: listed, but neither income nor spending.
   * `installment` is a Pay in 4 or Pay Later row, proposed as a plan rather than counted.
   */
  kind: 'expense' | 'income' | 'transfer' | 'refund' | 'unknown' | 'adjustment' | 'installment'
  status: 'completed' | 'pending' | 'excluded'
  source: 'demo' | 'import' | 'purchase'
  color?: string
  referenceId?: string
}
export interface Product {
  id: string
  name: string
  description: string
  priceCents: number
  category: string
  image: string
  color: string
  merchant: string
  tag?: string
}
/**
 * A similar product from another store, found through Channel3. Discovery only: Worth does not sell
 * it and never checks it out. Phase 5 saves this exact shape as a custom Saved item.
 */
export interface Alternative {
  /** Channel3's product ID. */
  id: string
  title: string
  /** The store's domain, such as "bestbuy.com". */
  retailer: string
  brand?: string
  /** The lowest qualifying in-stock offer, in USD cents. */
  priceCents: number
  /** The retailer page (through Channel3's link), opened in a new tab. */
  url: string
  /** A Channel3-hosted product image; absent when none is hosted there. */
  imageUrl?: string
  availability: 'InStock'
  source: 'channel3'
}
/**
 * How alternatives were found. ok: a live Channel3 search. fixture: example results recorded
 * earlier, shown while Channel3 is unavailable. off: nothing to show, so the panel stays hidden.
 */
export type AlternativesStatus = 'ok' | 'fixture' | 'off'
export interface Alternatives {
  status: AlternativesStatus
  /** The generic description searched for; never a brand. */
  query: string
  /** The search's price ceiling: what fits today, rounded down to $25. */
  maxPriceCents: number
  items: Alternative[]
}
export interface PlanInstalment {
  date: string
  amountCents: number
}
/**
 * How a completed purchase is repaid. No plan means a single full-price debit. Pay in 4 replaces
 * that debit only once the user confirms the amounts and dates PayPal gave them.
 */
export type PaymentPlan =
  | { product: 'full'; confirmedAt?: string }
  | { product: 'payIn4'; status: 'unconfirmed' }
  | {
      product: 'payIn4'
      status: 'confirmed'
      instalments: PlanInstalment[]
      confirmedAt: string
    }
export interface PurchaseRefund {
  /** PayPal refund ID; recording the same refund again changes nothing. */
  id: string
  /** What the merchant refunded. It changes nothing until the user confirms the effect. */
  amountCents: number
  status: 'review' | 'confirmed'
  createdAt: string
  /** Money that actually came back to available funds. Store credit and gift cards count as zero. */
  returnedCents?: number
  /** Pay in 4 only: the payments still due after the refund, replacing the earlier schedule. */
  remainingInstalments?: PlanInstalment[]
  confirmedAt?: string
}
export interface Purchase {
  id: string
  productId: string
  name: string
  amountCents: number
  currency: Currency
  mode: 'demo' | 'sandbox'
  status: 'created' | 'pending' | 'completed' | 'cancelled' | 'failed' | 'unknown'
  createdAt: string
  completedAt?: string
  orderId?: string
  captureId?: string
  profileVersion: number
  assessmentDate: string
  /** Made as the synthetic persona and set aside when the user switched to imported data. */
  archived?: boolean
  paymentPlan?: PaymentPlan
  refunds?: PurchaseRefund[]
  /** The PayPal approval or payer-action link, present only while approval is needed. */
  approveUrl?: string
  /**
   * True after PayPal declined the capture (INSTRUMENT_DECLINED or PAYER_ACTION_REQUIRED). The
   * buyer chooses another way to pay in PayPal, then confirms again.
   */
  needsReapproval?: boolean
  /** The last problem with this checkout, written for the user; never raw PayPal output. */
  lastError?: { code: string; message: string }
  /**
   * True for an order Claude prepared although it dips below the cushion. The UI shows a confirm
   * step, and capture requires `{ acknowledgeShortfall: true }` from the user.
   */
  proceedConfirmRequired?: boolean
  /** 'agent' when Claude's prepare_checkout created the order; absent on older purchases. */
  preparedBy?: 'agent' | 'user'
}
/** Something the user must confirm before Worth changes how a purchase affects their plan. */
export type PurchaseReview =
  | {
      kind: 'confirmPlan'
      purchaseId: string
      name: string
      amountCents: number
      title: string
      message: string
    }
  | {
      kind: 'refund'
      purchaseId: string
      refundId: string
      name: string
      refundedCents: number
      title: string
      message: string
    }
export interface ForecastEvent {
  id: string
  name: string
  amountCents: number
  kind: FlowKind | 'purchase' | 'spending'
}
export interface ForecastPoint {
  date: string
  baselineCents: number
  purchaseCents: number
  stressCents: number
  minimumCents: number
  baselineMinimumCents: number
  stressMinimumCents: number
  events: ForecastEvent[]
}
export interface Assessment {
  outcome: Outcome
  amountCents: number
  itemName: string
  purchaseDate: string
  today: string
  horizonEnd: string
  profileVersion: number
  cushionCents: number
  lowestBalanceCents: number
  lowestDate: string
  baselineLowestCents: number
  stressLowestCents: number
  headroomCents: number
  maxAffordableCents: number
  earliestDate: string | null
  points: ForecastPoint[]
  missingFields: string[]
  drivers: { name: string; amountCents: number; date: string; kind: FlowKind }[]
  explanation: string
  assumptions: string[]
}
/** The fixed range every option is judged over, set before any search. */
export interface ComparisonWindow {
  start: string
  end: string
  days: number
}
/** The largest outflow between the last income and the low point. */
export interface LowPointCause {
  name: string
  amountCents: number
  date: string
  kind: ForecastEvent['kind']
}
export interface OptionResult {
  outcome: Outcome
  /** Total price of the option, in cents. */
  amountCents: number
  /** The day the purchase is made; for Pay in 4, the first payment. */
  purchaseDate: string
  lowestBalanceCents: number
  lowestDate: string
  lowPointCause: LowPointCause | null
  stressLowestCents: number
  headroomCents: number
  points: ForecastPoint[]
}
export type WaitOption = { date: null } | ({ date: string } & OptionResult)
export interface SpendLessOption extends OptionResult {
  /** The highest all-in price that keeps the cushion when bought today. */
  maxPriceCents: number
}
export interface NearbyBill {
  name: string
  date: string
  amountCents: number
  kind: FlowKind | 'purchase'
  /** Positive when the bill falls after the instalment. */
  daysFromInstalment: number
}
export interface InstalmentDetail {
  number: number
  date: string
  amountCents: number
  /** Within 3 days; bills and other plans' payments are named before subscriptions. */
  nearestBill: NearbyBill | null
  /** Lowest projected balance from this payment until the next one (the last runs to the window end). */
  balanceCents: number
  lowestDate: string
  belowCushion: boolean
}
export interface ActivePlanPayment {
  planId: string
  name: string
  date: string
  amountCents: number
  /** True for the illustrative payments of the plan being compared. */
  proposed: boolean
}
export interface StackingWarning {
  /** Instalment plans already running with payments inside the window. */
  activePlans: number
  /** What those plans still take inside the window. */
  totalCents: number
  /** Existing and proposed payments in date order. */
  calendar: ActivePlanPayment[]
  message: string
}
export interface PayIn4Scenario extends OptionResult {
  available: true
  illustrative: true
  notice: string
  label: string
  instalments: InstalmentDetail[]
  stacking: StackingWarning | null
}
/**
 * How Pay in 4 availability was decided. 'paypal': PayPal's eligibility check offered Pay Later and
 * the amount is in range. 'range-only': the check could not run, so only the amount range decided.
 * 'unavailable': out of range, or PayPal did not offer Pay Later.
 */
export type PayIn4Eligibility = 'paypal' | 'range-only' | 'unavailable'
export type PayIn4Comparison =
  | (PayIn4Scenario & { eligibility?: PayIn4Eligibility })
  | { available: false; reason: string; eligibility?: PayIn4Eligibility }
export type Recommendation = 'buyToday' | 'wait' | 'spendLess'
export interface Comparison {
  itemName: string
  amountCents: number
  today: string
  window: ComparisonWindow
  profileVersion: number
  cushionCents: number
  missingFields: string[]
  buyToday: OptionResult
  wait: WaitOption
  spendLess: SpendLessOption
  /** A comparison the user opens deliberately. It is never recommended or ranked. */
  payIn4: PayIn4Comparison
  /** Null while information is missing. Pay in 4 is never a recommendation. */
  recommendation: Recommendation | null
  assumptions: string[]
}
export interface AppState {
  /** Public session fingerprint for clearing browser-only context; never an authentication token. */
  sessionKey?: string
  profile: FinancialProfile
  transactions: Transaction[]
  purchases: Purchase[]
  /** Persistent prompts: plans to confirm and refunds to review. */
  reviews: PurchaseReview[]
  wishlist: string[]
  products: Product[]
  today: string
  /** Imported foreign-currency payments; unresolved ones withhold any positive result. */
  foreignPayments?: ForeignPayment[]
  config: {
    ai: 'anthropic' | 'demo'
    paypal: 'sandbox' | 'demo'
    paypalClientId?: string
    model?: string
    /** Whether similar items from other stores can be shown (Channel3). */
    alternatives?: AlternativesStatus
  }
}
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}
export interface InterpretedItem {
  name: string
  /** Unit price in USD cents, as the user stated or confirmed it. */
  amountCents: number
  quantity: number
}
/** How a purchase question was read. Every value is the user's stated or confirmed input. */
export interface Interpretation {
  items: InterpretedItem[]
  amountCents: number
  currency: 'USD'
  date: string
  /** Echo of the date, e.g. "today" or "Fri, Oct 16". */
  dateLabel: string
  dateSource: 'stated' | 'context' | 'default'
  option: 'check' | 'earliest_date' | 'max_price'
  source: 'ai' | 'local'
}
export interface PurchaseContext {
  amountCents: number
  itemName?: string
  purchaseDate?: string
}
export type ChatIntent =
  | 'affordability'
  | 'subscriptions'
  | 'spending'
  | 'overview'
  | 'alternatives'
  | 'clarify'
  | 'off_topic'
export interface ChatReply {
  /** Full plain-text answer: verdict or facts, plus any explanation. */
  message: string
  mode: 'anthropic' | 'demo'
  intent: ChatIntent
  assessment?: Assessment
  interpretation?: Interpretation
  /** Deterministic sentence built from the engine's assessment. Never model-written. */
  verdict?: string
  /** A lead-in Claude chose from a fixed set, shown before the points. */
  lead?: string
  /**
   * Engine facts Claude chose as most relevant to the question, in its order. The server
   * writes every sentence from engine values; Claude only picks which ones to show.
   */
  points?: { id: string; text: string }[]
  /** A partly understood purchase the next message may complete, e.g. a price awaiting a date. */
  pending?: PurchaseContext
  suggestions: string[]
  /** Tools that ran successfully for this answer. */
  toolCalls: string[]
  /** A PayPal order Claude prepared for the user to approve. Capture stays a separate user action. */
  checkout?: CheckoutHandoff
  /** Similar items under what fits today, from other stores. Shown only when some were found. */
  alternatives?: Alternatives
}
/** What the UI needs to hand a prepared order to PayPal for approval. */
export interface CheckoutHandoff {
  purchaseId: string
  orderId: string
  approveUrl: string
  itemName: string
  amountCents: number
  option: 'buyToday' | 'wait' | 'spendLess'
  /** True when the user chose to go ahead despite a shortfall; the UI confirms that first. */
  requiresProceedConfirm: boolean
}
/**
 * A completed payment in another currency with no matching USD conversion in the export. Until it
 * is resolved, no assessment can be positive.
 */
export interface ForeignPayment {
  /** The identity it would have as a transaction, such as `paypal:<Transaction ID>`. */
  id: string
  date: string
  name: string
  type: string
  currency: string
  /** Hundredths of the payment's own currency, as exported; negative for money out. */
  originalCents: number
  /**
   * How it was resolved: the user's answer (what it cost in USD, or a one-off left out of the
   * history), or `matched` once a later export paired it with its USD conversion.
   */
  resolution?: { kind: 'usd'; amountCents: number } | { kind: 'oneOff' } | { kind: 'matched' }
}
/** A Pay in 4 or Pay Later plan found in an import, proposed to the user for confirmation. */
export interface InstalmentPlanProposal {
  id: string
  /** The merchant, or the row's own label when the purchase is not in the file. */
  name: string
  /** The purchase date, or the first payment seen. */
  startDate: string
  /** The full price, when the purchase row is in the file. */
  purchaseCents: number | null
  /** One payment: PayPal's usual split of the price (remainder on the first), or as seen. */
  paymentCents: number
  /** Payment rows found in the file, pending or completed. PayPal sets the real schedule. */
  payments: { date: string; amountCents: number; status: Transaction['status'] }[]
  transactionIds: string[]
}
/** The order of day and month in a CSV's slash dates. */
export type DateOrder = 'MM/DD' | 'DD/MM'
export interface ImportPreview {
  transactions: Transaction[]
  errors: { row: number; message: string }[]
  duplicates: number
  excluded: number
  coverageDays: number
  totalRows: number
  suggestedDailySpendCents: number
  recurring: ScheduledFlow[]
  warnings: string[]
  /** Balance corrections from this file, such as "General Account Correction". Never counted. */
  adjustments: Transaction[]
  /**
   * Rows not imported: memo rows and authorization holds never moved money, and rows in other
   * currencies are counted only through a matched USD conversion.
   */
  leftOut: { memo: number; holds: number; otherCurrency: number }
  /** The order used for slash dates; null when the file has none that could read differently. */
  dateOrder: DateOrder | null
  /**
   * Every slash date could be read either way. Nothing was imported; preview again with an
   * explicit `dateOrder`. The commit refuses such a file without one.
   */
  needsDateOrder: boolean
  /** Foreign-currency spending without a matching USD conversion, to be resolved after import. */
  unresolved: ForeignPayment[]
  /** Foreign payments whose USD cost this file supplies through a matched conversion. */
  converted: string[]
  /** Possible existing Pay in 4 or Pay Later plans. Their rows are never ordinary spending. */
  instalmentPlans: InstalmentPlanProposal[]
}
