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
}
export interface Transaction {
  id: string
  date: string
  name: string
  amountCents: number
  currency: string
  category: string
  kind: 'expense' | 'income' | 'transfer' | 'refund' | 'unknown'
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
export type PayIn4Comparison = PayIn4Scenario | { available: false; reason: string }
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
  wishlist: string[]
  products: Product[]
  today: string
  config: {
    ai: 'anthropic' | 'demo'
    paypal: 'sandbox' | 'demo'
    paypalClientId?: string
    model?: string
  }
}
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}
export interface ChatReply {
  message: string
  /** Short visible lead-in when the assessment card already presents the numerical facts. */
  intro?: string
  mode: 'anthropic' | 'demo'
  assessment?: Assessment
  intent: 'affordability' | 'subscriptions' | 'spending' | 'overview' | 'clarify'
  suggestions: string[]
  toolCalls: string[]
}
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
}
