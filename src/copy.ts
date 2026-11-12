import type { AppState } from './contract'
import { sampleDate } from './format'

/** Everything that reaches Anthropic when Claude answers. Update it with any change to the chat tools. */
export const CLAUDE_SHARED_DATA =
  'your messages, recent chat history (including figures), the item, price and date you ask about, the items and prices you asked about earlier in the same conversation, a forecast summary, 30-day spending totals by category, income and bill names with amounts and dates, minimized merchant labels, whether PayPal offers Pay in 4 for the price and, when you ask about Pay in 4, its illustrative payment dates and the bills they land near, whether Worth prepared a checkout for a catalog item and how it went, and, when you ask for something cheaper, the kind of item to look for and whether similar items were found (never their names, stores or prices)'

/** The short list shown wherever Claude's access is summarised; Ask and Settings use the same rows. */
export const CLAUDE_USES: [string, string][] = [
  ['Plan totals and dates', 'Yes'],
  ['Bill and subscription names', 'Shortened labels'],
  ['Your messages', 'Yes'],
  ['PayPal login or card numbers', 'Never'],
]

/** The rows as they stand: with Claude off, nothing is sent. */
export const claudeUses = (on: boolean): [string, string][] =>
  CLAUDE_USES.map(([label, value]) => [label, on || value === 'Never' ? value : 'Not sent'])

/** What reaches Channel3 when Worth looks for similar items. It applies with the assistant off too. */
export const CHANNEL3_SHARED_DATA =
  'A generic kind of item (such as “desk chair”) and a price limit rounded down to $25, even when the assistant is off'
/** What reaches Channel3 when someone pastes a product link (C5). Nothing from the page goes to Claude. */
export const CHANNEL3_LINK_DATA =
  'The link only, so Channel3 can read the product. Worth never opens it, and nothing from the page goes to the assistant'
/**
 * Who's who in the demo: Worth is on the shopper's side and sells nothing; the sandbox merchant
 * stands in for any store that takes PayPal. Shown wherever the store and Worth meet.
 */
export const demoStoreRole = (store: string) =>
  `Worth sells nothing and never holds your money. ${store} is a demo store standing in for any shop that takes PayPal, and PayPal pays the store directly.`
/** A saved item the demo store doesn't sell (amendment A3): Worth assesses it, never checks it out. */
export const ASSESSMENT_ONLY = 'Assessment only — not sold in the demo store'
/** A saved wait plan whose day has come (C-17). */
export const MAY_FIT_NOW = 'Your plan suggests this may fit now — confirm today’s funds'
/** The plan editor while the demo clock runs (the server refuses the edit too). */
export const DEMO_CLOCK_EDIT =
  'The demo clock is replaying the sample plan as it is. Choose Back to today before editing a plan.'
/** The sample persona in a sentence; the top-bar chip and the Home intro both say it (feedback F1). */
export const SAMPLE_WHO = 'a sample month for a made-up PayPal shopper'
/** Whether checkout reaches the PayPal sandbox; without sandbox keys it is simulated, never live. */
export const paypalModeLine = (mode: 'sandbox' | 'demo') =>
  mode === 'sandbox' ? 'PayPal checkout runs in the PayPal sandbox' : 'PayPal checkout is simulated'
/** What the sample month holds; plan edits can change the count, so it is read from state. */
export const sampleHolds = (plans: number) =>
  plans === 0
    ? 'a paycheck and bills'
    : `a paycheck, bills and ${plans === 1 ? 'one PayPal Pay in 4 plan' : `${plans} PayPal Pay in 4 plans`}`

/** Alex's pinned days (`demo`, `demo-dec15`): the sample is tuned for them, so no "Back to today". */
export const pinnedSample = (state: AppState) =>
  state.demoClock?.preset === 'demo' || state.demoClock?.preset === 'demo-dec15'
/** What the toast says when a pinned sample day starts, from the day the server pinned. */
export const replayToast = (state: AppState) =>
  `Showing ${state.demoClock?.preset === 'video' ? 'the video scenario' : 'the sample'}: ${state.profile.name} on ${sampleDate(state.today)}.`
