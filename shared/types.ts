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
