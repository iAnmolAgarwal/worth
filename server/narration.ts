import { collisionLine, mainCollision, PAY_IN_4_SPACING } from '../shared/collision.ts'
import {
  addDays,
  assessPurchase,
  getUpcomingFlows,
  money,
  payIn4InRange,
  payIn4Scenario,
  withoutOwnHold,
} from '../shared/finance.ts'
import type { Assessment, Interpretation, PayIn4Chat, PayIn4Comparison } from '../shared/types.ts'
import { dateLabel, shortLabel } from './dates.ts'
import type { ChatData } from './interpret.ts'
import { chatLabel } from './labels.ts'

// Every figure the user sees comes from the engine. The verdict sentence is a
// template; Claude may add prose that names figures only through placeholders.

export type CommitmentKind = 'subscriptions' | 'bills' | 'all'

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
/** "today", "tomorrow" or "on Fri, Oct 16", to follow "buy it" or "buying". */
const when = (date: string, today: string) => {
  const label = dateLabel(date, today)
  return label === 'today' || label === 'tomorrow' ? label : `on ${label}`
}

/** The single verdict sentence for an assessment. Claude never writes it. */
export function verdictFor(a: Assessment, interpretation?: Interpretation) {
  const subject = `${capitalize(a.itemName)} at ${money(a.amountCents)}`
  const day = when(a.purchaseDate, a.today)
  if (a.outcome === 'incomplete')
    return `Before I can check ${a.itemName}, your plan needs a few details confirmed.`
  const later = a.earliestDate && a.earliestDate > a.purchaseDate
  const result =
    a.outcome === 'fits'
      ? `${subject} fits your plan if you buy it ${day}.`
      : later
        ? `${subject} would dip below your cushion if you buy it ${day}. The earliest date that fits is ${dateLabel(a.earliestDate!, a.today)}.`
        : `${subject} would dip below your cushion if you buy it ${day}, and no date in the next 30 days fits this plan.`
  const max =
    interpretation?.option === 'max_price' || (a.outcome === 'tight' && a.maxAffordableCents > 0)
      ? ` The most you could spend ${day} and keep your cushion is ${money(a.maxAffordableCents)}.`
      : ''
  return result + max
}

/** The supporting engine facts behind a verdict. */
export function assessmentSummary(a: Assessment) {
  if (a.outcome === 'incomplete')
    return `Confirm ${a.missingFields.join('; ')}. The current projection is incomplete, so it cannot support a purchase decision.`
  return `Buying ${when(a.purchaseDate, a.today)} brings your projected low point to ${money(a.lowestBalanceCents)} on ${shortLabel(a.lowestDate)}, against a ${money(a.cushionCents)} cushion. With everyday spending 20% higher, the low point is ${money(a.stressLowestCents)}. This is a conditional cash-flow estimate.`
}

export function commitments(data: ChatData, kind: CommitmentKind = 'all') {
  const events = getUpcomingFlows(data.profile, data.today, 30).filter(({ flow }) =>
    kind === 'subscriptions'
      ? flow.kind === 'subscription'
      : kind === 'bills'
        ? flow.kind === 'bill'
        : flow.kind !== 'income',
  )
  return {
    kind,
    events: events.map(({ flow, date }) => ({
      name: chatLabel(flow.name),
      date,
      amountCents: flow.amountCents,
      kind: flow.kind,
    })),
    totalCents: events.reduce((sum, { flow }) => sum + flow.amountCents, 0),
  }
}

export function spending(data: ChatData) {
  const from = addDays(data.today, -29)
  const rows = data.transactions.filter(
    (t) =>
      t.date >= from &&
      t.date <= data.today &&
      t.kind === 'expense' &&
      t.status === 'completed' &&
      t.currency === 'USD',
  )
  const categories = new Map<string, number>()
  for (const row of rows)
    categories.set(row.category, (categories.get(row.category) ?? 0) + Math.abs(row.amountCents))
  return {
    from,
    through: data.today,
    totalCents: rows.reduce((sum, row) => sum + Math.abs(row.amountCents), 0),
    transactionCount: rows.length,
    categories: [...categories]
      .map(([name, amountCents]) => ({ name: chatLabel(name), amountCents }))
      .sort((a, b) => b.amountCents - a.amountCents),
  }
}

export function baseline(data: ChatData) {
  return assessPurchase(data.profile, data.purchases, {
    amountCents: 0,
    today: data.today,
    findEarliest: false,
  })
}

const LABELS: Record<CommitmentKind, [string, string]> = {
  subscriptions: ['Subscriptions', 'subscriptions'],
  bills: ['Bills', 'bills'],
  all: ['Bills and subscriptions', 'bills or subscriptions'],
}
export function commitmentsFacts(data: ChatData, kind: CommitmentKind) {
  const value = commitments(data, kind)
  const [title, plural] = LABELS[kind]
  if (!value.events.length)
    return `No ${plural} are recorded for the next 30 days. Add anything paid outside PayPal before relying on your plan.`
  const list = value.events
    .map((e) => `${e.name}, ${money(e.amountCents)} on ${shortLabel(e.date)}`)
    .join('; ')
  return `${title} due in the next 30 days: ${list}. Total: ${money(value.totalCents)}. These are recorded commitments, not a live account sync.`
}
export function spendingFacts(data: ChatData) {
  const value = spending(data)
  const top = value.categories
    .slice(0, 3)
    .map((c) => `${c.name}, ${money(c.amountCents)}`)
    .join('; ')
  return `Your recorded completed expenses from ${shortLabel(value.from)} to ${shortLabel(value.through)} total ${money(value.totalCents)} across ${value.transactionCount} transactions${top ? `. Largest categories: ${top}` : ''}. Transfers, refunds, unsupported currencies and pending payments are excluded. This covers only the history you supplied.`
}
export function overviewFacts(data: ChatData) {
  const base = baseline(data)
  if (base.outcome === 'incomplete')
    return `Your plan needs a quick review: ${base.missingFields.join('; ')}. Open Your plan to confirm the missing information, then ask about a purchase.`
  if (base.baselineLowestCents < base.cushionCents)
    return `Your confirmed plan already falls below your cushion before a new purchase. The projected low point is ${money(base.baselineLowestCents)} on ${shortLabel(base.lowestDate)}, ${money(base.cushionCents - base.baselineLowestCents)} below your ${money(base.cushionCents)} cushion. There is no room for an additional purchase while preserving that cushion in this base scenario. Review your upcoming commitments and expected income before deciding on a purchase.`
  if (base.maxAffordableCents === 0)
    return `Your confirmed plan reaches your ${money(base.cushionCents)} cushion on ${shortLabel(base.lowestDate)}, leaving no room for an additional purchase while preserving it in this base scenario. Review your upcoming commitments and expected income before deciding on a purchase.`
  return `Based on your confirmed plan, a purchase of up to ${money(base.maxAffordableCents)} today would preserve your ${money(data.profile.cushionCents)} cushion in the base scenario. Your lowest projected balance before a new purchase is ${money(base.baselineLowestCents)}. Tell me what you have your eye on and I will check its timing.`
}
export const OFF_TOPIC_REPLY =
  'I can only help with your purchases, upcoming bills and subscriptions, spending, and how much room your plan has. Ask me about something you are thinking of buying.'

// ---- Facts Claude can choose ------------------------------------------------------
//
// Every fact is a complete sentence built from engine values, with its role stated in the
// sentence itself. Claude chooses which facts answer the user's question and in what
// order; it never writes a financial claim.

export const PURCHASE_FACTS = [
  'low_point',
  'cause',
  'income',
  'wait',
  'spend_less',
  'stress',
  'bills_before',
  'pay_in_4',
  'pay_in_4_schedule',
  'pay_in_4_stacking',
] as const
export const PLAN_FACTS = ['room_today', 'low_point', 'cause', 'income'] as const
export const COMMITMENT_FACTS = ['total', 'next', 'largest', 'other_total'] as const
export const SPENDING_FACTS = ['total', 'top_category', 'daily_average'] as const
export type FactId =
  | (typeof PURCHASE_FACTS)[number]
  | (typeof PLAN_FACTS)[number]
  | (typeof COMMITMENT_FACTS)[number]
  | (typeof SPENDING_FACTS)[number]
export type FactCatalog = Partial<Record<FactId, string>>

const day = (date: string, today: string) => dateLabel(date, today)

function lowPointFact(
  low: number,
  date: string,
  cushion: number,
  today: string,
  lead = 'Your lowest balance would be',
) {
  const gap = low - cushion
  const relation =
    gap < 0
      ? `${money(-gap)} below your ${money(cushion)} cushion`
      : gap > 0
        ? `${money(gap)} above your ${money(cushion)} cushion`
        : `exactly at your ${money(cushion)} cushion`
  return `${lead} ${money(low)} on ${day(date, today)}, ${relation}.`
}
/** The largest bill or subscription due from today up to the low point, if any. */
function causeFact(a: Assessment, data: ChatData) {
  const due = a.drivers
    .filter((d) => d.kind !== 'income' && d.date >= a.today && d.date <= a.lowestDate)
    .sort((x, y) => y.amountCents - x.amountCents)[0]
  if (due)
    return `${chatLabel(due.name)} (${money(due.amountCents)}) is due ${day(due.date, a.today)}, before that low point.`
  if (data.profile.dailySpendCents > 0)
    return `Everyday spending of ${money(data.profile.dailySpendCents)} a day is what lowers your balance before then.`
  return undefined
}
function incomeFact(a: Assessment) {
  const income = a.drivers.find((d) => d.kind === 'income' && d.date >= a.today)
  return income
    ? `Your next income, ${chatLabel(income.name)} (${money(income.amountCents)}), arrives ${day(income.date, a.today)}.`
    : 'No income is recorded in the plan window.'
}

/** Facts for an assessed purchase. */
export function purchaseFacts(a: Assessment, data: ChatData): FactCatalog {
  if (a.outcome === 'incomplete') return {}
  const facts: FactCatalog = {
    low_point: lowPointFact(a.lowestBalanceCents, a.lowestDate, a.cushionCents, a.today),
    income: incomeFact(a),
    stress: `With 20% higher everyday spending, your lowest balance would be ${money(a.stressLowestCents)}, ${a.stressLowestCents < a.cushionCents ? 'below' : 'still at or above'} your ${money(a.cushionCents)} cushion.`,
  }
  const cause = causeFact(a, data)
  if (cause) facts.cause = cause
  if (a.outcome === 'tight')
    facts.wait =
      a.earliestDate && a.earliestDate > a.purchaseDate
        ? `Waiting until ${day(a.earliestDate, a.today)} would keep your cushion for the full ${money(a.amountCents)}.`
        : `No day in the next 30 days keeps your cushion at ${money(a.amountCents)}.`
  facts.spend_less =
    a.maxAffordableCents > 0
      ? `Up to ${money(a.maxAffordableCents)} would keep your cushion if you buy ${when(a.purchaseDate, a.today)}.`
      : `Your plan has no room for a purchase ${when(a.purchaseDate, a.today)} without going below your cushion.`
  const before = a.drivers
    .filter((d) => d.kind !== 'income' && d.date >= a.today && d.date <= a.lowestDate)
    .slice(0, 3)
  if (before.length)
    facts.bills_before = `Due before your low point: ${before.map((d) => `${chatLabel(d.name)} ${money(d.amountCents)} (${shortLabel(d.date)})`).join(', ')}.`
  // Only when the user asked: a comparison to open, never a way to make the purchase fit.
  if (data.payIn4)
    facts.pay_in_4 =
      data.payIn4 === 'unavailable'
        ? `PayPal Pay in 4 is not available for ${money(a.amountCents)}.`
        : `You can compare PayPal Pay in 4 for ${money(a.amountCents)} in the comparison view. It is shown for comparison only; PayPal decides availability and terms at checkout.`
  const scenario = data.payIn4 && data.payIn4 !== 'unavailable' ? payIn4For(a, data) : undefined
  if (scenario?.available) {
    facts.pay_in_4_schedule = payIn4ScheduleText(scenario, a.today)
    facts.pay_in_4_stacking = scenario.stacking
      ? scenario.stacking.message
      : 'You have no other instalment plans with payments in this window.'
  }
  return facts
}

// ---- Pay in 4 in chat ----------------------------------------------------------------
//
// The engine's own scenario, as the comparison computes it. Every sentence is neutral: Pay in 4
// is never recommended, and every collision is "about", because PayPal sets the exact dates.

/** The engine's Pay in 4 scenario for an assessed amount, starting on its purchase date. */
export function payIn4For(a: Assessment, data: ChatData): PayIn4Comparison {
  return payIn4Scenario(
    data.profile,
    withoutOwnHold(data.purchases, { itemName: a.itemName, amountCents: a.amountCents }),
    // The first payment is on the purchase date, so a later day gets its own schedule.
    { amountCents: a.amountCents, itemName: a.itemName, today: a.today, start: a.purchaseDate },
  )
}
type Scenario = Extract<PayIn4Comparison, { available: true }>
/** "4 payments of $299.75" or "4 payments: $2.53, then 3 of $2.50". */
function paymentsText(scenario: Scenario) {
  const [first, ...rest] = scenario.instalments
  return rest.every((p) => p.amountCents === first!.amountCents)
    ? `4 payments of ${money(first!.amountCents)}`
    : `4 payments: ${money(first!.amountCents)}, then ${rest.length} of ${money(rest[0]!.amountCents)}`
}
/** Each payment that lands near a bill: "payment 2 would land about 1 day after your rent". */
export function collisionsText(scenario: Scenario) {
  return labelled(scenario)
    .filter((p) => p.nearestBill)
    .map(collisionLine)
}
/** The scenario's payments with each nearby bill's name made safe for chat. */
function labelled(scenario: Scenario) {
  return scenario.instalments.map((p) => ({
    ...p,
    nearestBill: p.nearestBill && { ...p.nearestBill, name: chatLabel(p.nearestBill.name) },
  }))
}
function payIn4ScheduleText(scenario: Scenario, today: string) {
  const collisions = collisionsText(scenario)
  const start = scenario.instalments[0]!.date
  return [
    `PayPal Pay in 4 would be ${paymentsText(scenario)}, ${PAY_IN_4_SPACING} starting ${start === today ? 'today' : `on ${dateLabel(start, today)}`}. The total stays ${money(scenario.amountCents)} and PayPal charges no interest.`,
    collisions.length
      ? `${capitalize(collisions.join('; '))}.`
      : 'No payment would land within 3 days of a bill.',
    `${scenario.label}.`,
    'The schedule is illustrative; PayPal sets the exact dates.',
  ].join(' ')
}
/**
 * Pay in 4 for an answer: the schedule when the person asked about it, otherwise one neutral row
 * for a purchase PayPal's range covers. Out of range, an answer that asked shows it is unavailable.
 */
export function payIn4Chat(a: Assessment, data: ChatData, asked: boolean): PayIn4Chat | undefined {
  if (a.outcome === 'incomplete') return undefined
  const eligibility = asked ? (data.payIn4 ?? 'range-only') : 'range-only'
  if (!payIn4InRange(a.amountCents) || eligibility === 'unavailable')
    return asked
      ? {
          asked,
          totalCents: a.amountCents,
          eligibility: 'unavailable',
          payments: [],
          label: `PayPal Pay in 4 is not available for ${money(a.amountCents)}`,
          lowestCents: a.lowestBalanceCents,
          lowestDate: a.lowestDate,
          stacking: null,
        }
      : undefined
  const scenario = payIn4For(a, data)
  if (!scenario.available) return undefined
  return {
    asked,
    totalCents: a.amountCents,
    eligibility,
    payments: labelled(scenario).map((p) => ({
      number: p.number,
      date: p.date,
      amountCents: p.amountCents,
      nearestBill: p.nearestBill,
      belowCushion: p.belowCushion,
    })),
    label: scenario.label,
    lowestCents: scenario.lowestBalanceCents,
    lowestDate: scenario.lowestDate,
    stacking: scenario.stacking && {
      activePlans: scenario.stacking.activePlans,
      totalCents: scenario.stacking.totalCents,
      message: scenario.stacking.message,
    },
  }
}
/** The engine's Pay in 4 sentence for the answer's text, when the person asked. */
export function payIn4Text(a: Assessment, data: ChatData) {
  if (!data.payIn4 || a.outcome === 'incomplete') return undefined
  const facts = purchaseFacts(a, data)
  return facts.pay_in_4_schedule ?? facts.pay_in_4
}

/** Facts about the plan before any new purchase. */
export function planFacts(data: ChatData): FactCatalog {
  const base = baseline(data)
  if (base.outcome === 'incomplete') return {}
  const facts: FactCatalog = {
    room_today:
      base.maxAffordableCents > 0
        ? `Up to ${money(base.maxAffordableCents)} today would keep your ${money(base.cushionCents)} cushion.`
        : `Your plan has no room for a new purchase today without going below your ${money(base.cushionCents)} cushion.`,
    low_point: lowPointFact(
      base.baselineLowestCents,
      base.lowestDate,
      base.cushionCents,
      data.today,
      'Before any new purchase, your lowest balance would be',
    ),
    income: incomeFact(base),
  }
  const cause = causeFact(base, data)
  if (cause) facts.cause = cause
  return facts
}

const NOUNS: Record<CommitmentKind, [string, string]> = {
  subscriptions: ['subscription', 'subscriptions'],
  bills: ['bill', 'bills'],
  all: ['bill or subscription', 'bills and subscriptions'],
}
/** Facts about upcoming commitments of one kind. */
export function commitmentFacts(data: ChatData, kind: CommitmentKind): FactCatalog {
  const value = commitments(data, kind)
  const [one, many] = NOUNS[kind]
  if (!value.events.length) return {}
  const next = value.events[0]!
  const largest = [...value.events].sort((a, b) => b.amountCents - a.amountCents)[0]!
  const facts: FactCatalog = {
    total: `${value.events.length} ${value.events.length === 1 ? one : many} ${value.events.length === 1 ? 'is' : 'are'} due in the next 30 days, ${money(value.totalCents)} in all.`,
    next: `The next is ${next.name}, ${money(next.amountCents)} on ${day(next.date, data.today)}.`,
    largest: `The largest is ${largest.name} at ${money(largest.amountCents)}.`,
  }
  if (kind !== 'all') {
    const other = commitments(data, kind === 'subscriptions' ? 'bills' : 'subscriptions')
    facts.other_total = `${kind === 'subscriptions' ? 'Bills that are not subscriptions' : 'Subscriptions'} add ${money(other.totalCents)} over the same 30 days.`
  }
  return facts
}

/** Facts about recorded spending over the last 30 days. */
export function spendingFacts30(data: ChatData): FactCatalog {
  const value = spending(data)
  if (!value.transactionCount) return {}
  const top = value.categories[0]
  return {
    total: `You spent ${money(value.totalCents)} across ${value.transactionCount} completed purchases from ${shortLabel(value.from)} to ${shortLabel(value.through)}.`,
    ...(top
      ? { top_category: `Your largest category was ${top.name} at ${money(top.amountCents)}.` }
      : {}),
    daily_average: `That averages ${money(Math.round(value.totalCents / 30))} a day; your plan assumes ${money(data.profile.dailySpendCents)} a day.`,
  }
}

export const LEAD_INS = {
  none: '',
  matters: 'Here’s what matters for this purchase:',
  drives: 'Here’s what drives this result:',
  coming_up: 'Here’s what’s coming up:',
  spending: 'Here’s where your money went:',
  room: 'Here’s how much room your plan has:',
  no_skipping:
    'I wouldn’t skip or delay a bill to make a purchase fit. Here’s what matters instead:',
  no_credit:
    'I wouldn’t use credit, a loan or instalments to make a purchase fit. Here’s what matters instead:',
  no_cushion: 'I wouldn’t dip into your cushion for this. Here’s what matters instead:',
  not_yes: 'I can’t simply say yes. Here’s what your plan shows:',
} as const
export type LeadIn = keyof typeof LEAD_INS

/** The lead-in text, or nothing when it would not fit the result. */
export function leadInText(lead: LeadIn, outcome: Assessment['outcome'] | undefined) {
  if (lead === 'not_yes' && outcome !== 'tight') return undefined
  return LEAD_INS[lead] || undefined
}

const REFUSAL_LEADS = new Set<LeadIn>(['no_skipping', 'no_credit', 'no_cushion', 'not_yes'])
export const isRefusal = (lead: LeadIn | undefined) => Boolean(lead && REFUSAL_LEADS.has(lead))
/** A refusal on its own, for an answer with no facts after it (a clarifying question). */
export function refusalLine(lead: LeadIn) {
  return LEAD_INS[lead].split(/(?<=\.) /)[0]!
}
const BILL =
  /\b(?:rent|bills?|utilit(?:y|ies)|insurance|loan|phone\s+plan|mortgage|car\s+payment|student\s+loan)\b/i
const SKIP =
  /\b(?:skip\w*|delay\w*|defer\w*|postpon\w*|late|miss(?:ing)?|hold\s+off\s+on|put\s+off)\b/i
/**
 * The refusal a message calls for, read from the user's own words: skipping or paying a bill late
 * to make a purchase fit ("I could pay rent a week late"). It applies even when Claude chose none,
 * or when the purchase itself still needs a question.
 */
export function refusalFor(message: string): LeadIn | undefined {
  return message.split(/[.!?;]+/).some((clause) => BILL.test(clause) && SKIP.test(clause))
    ? 'no_skipping'
    : undefined
}

// ---- Follow-up chips ---------------------------------------------------------------

// Chips are questions in the user's voice. Claude writes them before it sees any result,
// so they may not contain figures, dates, a verdict, or any mention of bills, credit or
// the cushion.
const CHIP_VERDICT =
  /\b(?:fits?|fitting|safe(?:ly)?|affordable|afford\w*|go\s+ahead|yes|ok(?:ay)?\s+to\s+buy|good\s+to\s+(?:buy|go)|worth\s+it|no\s+problem)\b/i
const CHIP_NUMBER =
  /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|dozens?|half|quarter|double|twice)\b/i
const CHIP_REJECT =
  /[\p{N}\p{Sc}%{}]|\b(?:skip\w*|delay\w*|defer\w*|postpon\w*|late|credit|loans?|borrow\w*|financ\w*|bnpl|pay\s+later|pay\s+in|instal+ments?|split\w*|cushion|emergency|savings?|overdraft|hundreds?|thousands?|dollars?|bucks?|grand|percent|january|february|march|april|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu
export function chipAllowed(text: string) {
  const chip = text.replace(/\s+/g, ' ').trim()
  return (
    chip.length > 3 &&
    chip.length <= 90 &&
    chip.endsWith('?') &&
    !CHIP_REJECT.test(chip) &&
    !CHIP_VERDICT.test(chip) &&
    !CHIP_NUMBER.test(chip)
  )
}

// ---- One Claude sentence (C-13) ------------------------------------------------------
//
// After the engine answers, Claude may add one sentence on why the result is what it is. It names
// every figure, date, count and name through a placeholder; the server checks the sentence and
// fills in the engine's values. Any failed check shows the engine's template sentence instead.

export interface Placeholder {
  value: string
  about: string
  /** The day the value belongs to, so "before" and "after" in Claude's sentence can be checked. */
  date?: string
}
export type Placeholders = Record<string, Placeholder>

/** Placeholders for an assessed purchase. */
export function purchasePlaceholders(a: Assessment, data: ChatData): Placeholders {
  if (a.outcome === 'incomplete') return {}
  const out: Placeholders = {
    item: { value: chatLabel(a.itemName), about: 'the item', date: a.purchaseDate },
    price: { value: money(a.amountCents), about: 'its total price', date: a.purchaseDate },
    buy_day: {
      value: dateLabel(a.purchaseDate, a.today),
      about: 'the day they would buy it',
      date: a.purchaseDate,
    },
    cushion: { value: money(a.cushionCents), about: 'the cushion they keep' },
    low_point: {
      value: money(a.lowestBalanceCents),
      about: 'the lowest projected balance',
      date: a.lowestDate,
    },
    low_day: {
      value: day(a.lowestDate, a.today),
      about: 'the day of that low point',
      date: a.lowestDate,
    },
    gap: {
      value: money(Math.abs(a.lowestBalanceCents - a.cushionCents)),
      about: `how far the low point is ${a.lowestBalanceCents < a.cushionCents ? 'below' : 'above'} the cushion`,
    },
    stress_low: {
      value: money(a.stressLowestCents),
      about: 'the low point if everyday spending runs 20% higher',
    },
  }
  const cause = a.drivers
    .filter((d) => d.kind !== 'income' && d.date >= a.today && d.date <= a.lowestDate)
    .sort((x, y) => y.amountCents - x.amountCents)[0]
  if (cause) {
    out.cause_bill = {
      value: chatLabel(cause.name),
      about: 'the largest bill before the low point',
      date: cause.date,
    }
    out.cause_amount = {
      value: money(cause.amountCents),
      about: 'that bill’s amount',
      date: cause.date,
    }
    out.cause_day = {
      value: day(cause.date, a.today),
      about: 'the day that bill is due',
      date: cause.date,
    }
  }
  const income = a.drivers.find((d) => d.kind === 'income' && d.date >= a.today)
  if (income) {
    out.income_name = {
      value: chatLabel(income.name),
      about: 'the next income, which arrives on {income_day}',
      date: income.date,
    }
    out.income_day = {
      value: day(income.date, a.today),
      about: 'the day it arrives',
      date: income.date,
    }
  }
  const after = a.drivers.find((d) => d.kind === 'income' && d.date >= a.lowestDate)
  if (after && after.date !== income?.date)
    out.payday_after_low = {
      value: day(after.date, a.today),
      about: 'the first payday on or after the low point',
      date: after.date,
    }
  if (a.outcome === 'tight' && a.earliestDate && a.earliestDate > a.purchaseDate)
    out.wait_day = {
      value: day(a.earliestDate, a.today),
      about: 'the earliest day that fits',
      date: a.earliestDate,
    }
  if (a.maxAffordableCents > 0)
    out.max_spend = {
      value: money(a.maxAffordableCents),
      about: 'the most that keeps the cushion on that day',
    }
  if (data.payIn4 && data.payIn4 !== 'unavailable') {
    const scenario = payIn4For(a, data)
    if (scenario.available) {
      // Asked about Pay in 4, the full-price low point and the instalment one are kept apart.
      for (const key of ['low_point', 'low_day', 'gap'] as const)
        out[key] = { ...out[key]!, about: `${out[key]!.about}, if paid in full` }
      out.p4_payment = {
        value: money(scenario.instalments.at(-1)!.amountCents),
        about: 'one illustrative PayPal Pay in 4 payment',
      }
      out.p4_low_point = {
        value: money(scenario.lowestBalanceCents),
        about: 'the lowest projected balance with the Pay in 4 payments instead',
        date: scenario.lowestDate,
      }
      out.p4_low_day = {
        value: day(scenario.lowestDate, a.today),
        about: 'the day of that Pay in 4 low point',
        date: scenario.lowestDate,
      }
      const main = mainCollision(labelled(scenario))
      if (main)
        out.p4_collision = {
          value: collisionLine(main),
          about: 'the first Pay in 4 payment that lands near a bill (a whole phrase)',
        }
      if (scenario.stacking)
        out.p4_existing = {
          value: money(scenario.stacking.totalCents),
          about: 'what instalment plans already running take in this window',
        }
    }
  }
  return out
}
/** Placeholders for the plan before any purchase (room to spend and cheaper searches). */
export function planPlaceholders(data: ChatData): Placeholders {
  const base = baseline(data)
  if (base.outcome === 'incomplete') return {}
  const out: Placeholders = {
    room_today: { value: money(base.maxAffordableCents), about: 'what fits today' },
    cushion: { value: money(base.cushionCents), about: 'the cushion they keep' },
    low_point: {
      value: money(base.baselineLowestCents),
      about: 'the lowest projected balance',
      date: base.lowestDate,
    },
    low_day: {
      value: day(base.lowestDate, data.today),
      about: 'the day of that low point',
      date: base.lowestDate,
    },
  }
  const cause = base.drivers
    .filter((d) => d.kind !== 'income' && d.date >= base.today && d.date <= base.lowestDate)
    .sort((x, y) => y.amountCents - x.amountCents)[0]
  if (cause) {
    out.cause_bill = {
      value: chatLabel(cause.name),
      about: 'the largest bill before the low point',
      date: cause.date,
    }
    out.cause_day = {
      value: day(cause.date, data.today),
      about: 'the day that bill is due',
      date: cause.date,
    }
  }
  const income = base.drivers.find((d) => d.kind === 'income' && d.date >= base.today)
  if (income) {
    out.income_name = {
      value: chatLabel(income.name),
      about: 'the next income, which arrives on {income_day}',
      date: income.date,
    }
    out.income_day = {
      value: day(income.date, data.today),
      about: 'the day it arrives',
      date: income.date,
    }
  }
  return out
}
export function commitmentPlaceholders(data: ChatData, kind: CommitmentKind): Placeholders {
  const value = commitments(data, kind)
  if (!value.events.length) return {}
  const next = value.events[0]!
  const largest = [...value.events].sort((a, b) => b.amountCents - a.amountCents)[0]!
  return {
    count: { value: String(value.events.length), about: 'how many are due in the next 30 days' },
    total: { value: money(value.totalCents), about: 'their total' },
    next_name: { value: next.name, about: 'the next one due', date: next.date },
    next_day: { value: day(next.date, data.today), about: 'the day it is due', date: next.date },
    next_amount: { value: money(next.amountCents), about: 'its amount', date: next.date },
    largest_name: { value: largest.name, about: 'the largest one' },
    largest_amount: { value: money(largest.amountCents), about: 'its amount' },
  }
}
export function spendingPlaceholders(data: ChatData): Placeholders {
  const value = spending(data)
  if (!value.transactionCount) return {}
  const top = value.categories[0]
  return {
    total: { value: money(value.totalCents), about: 'spending over the last 30 days' },
    count: { value: String(value.transactionCount), about: 'how many purchases' },
    daily_average: {
      value: money(Math.round(value.totalCents / 30)),
      about: 'the daily average',
    },
    plan_daily: {
      value: money(data.profile.dailySpendCents),
      about: 'the everyday spending the plan assumes',
    },
    ...(top
      ? {
          top_category: { value: top.name, about: 'the largest category' },
          top_amount: { value: money(top.amountCents), about: 'its total' },
        }
      : {}),
  }
}

/** The engine's own sentence for an answer, used whenever Claude's does not pass. */
export function templateSentence(
  kind: 'purchase' | 'plan' | 'commitments' | 'spending',
  values: Placeholders,
  outcome?: Assessment['outcome'],
): string | undefined {
  const has = (...keys: string[]) => keys.every((key) => key in values)
  if (kind === 'purchase') {
    // Asked about Pay in 4, the sentence names where its payments land.
    if (outcome !== 'incomplete' && has('p4_collision'))
      return 'With PayPal Pay in 4, {p4_collision}.'
    if (outcome === 'fits' && has('low_point', 'low_day', 'cushion'))
      return 'Even at its lowest, {low_point} on {low_day}, your balance keeps your {cushion} cushion.'
    if (outcome === 'tight' && has('cause_bill', 'cause_amount', 'cause_day', 'low_day'))
      return '{cause_bill} ({cause_amount}) on {cause_day} is the largest bill due before your balance reaches its low point on {low_day}.'
    if (outcome === 'tight' && has('low_day'))
      return 'Everyday spending is what brings your balance down to its low point on {low_day}.'
    return undefined
  }
  if (kind === 'plan')
    return has('cause_bill', 'cause_day')
      ? '{cause_bill} on {cause_day} is the largest bill before your lowest point, which is what limits your room today.'
      : has('low_day')
        ? 'Your balance reaches its lowest point on {low_day}, which is what limits your room today.'
        : undefined
  if (kind === 'commitments')
    return has('next_name', 'next_day')
      ? '{next_name} on {next_day} is the next one due.'
      : undefined
  return has('top_category', 'top_amount')
    ? '{top_category} was your largest category, at {top_amount}.'
    : undefined
}

export type SentenceRejection =
  | 'no_sentence'
  | 'length'
  | 'not_one_sentence'
  | 'not_plain'
  | 'unknown_placeholder'
  | 'wrong_value'
  | 'free_number'
  | 'free_date'
  | 'advice'
  | 'pay_in_4'
  | 'contradicts_result'
const PLACEHOLDER = /\{([a-z0-9_]+)\}/g
/** PayPal's product name, which holds a digit; the time unit after "pay in 4 days" still counts. */
const PAY_IN_4_NAME = /\bpay\s+in\s+4\b/gi
const NUMBER_WORD =
  /\b(?:zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|dozens?|half|halves|quarters?|double|twice|triple|percent|pct|dollars?|bucks|grand|cents?|usd|eur\w*|gbp|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|\w+teenth|\w+tieth|few|couple|several|numerous|handful)\b/i
const DATE_WORD =
  /\b(?:today|tonight|tomorrow|yesterday|weekends?|weekdays?|weeks?|months?|years?|fortnight|days?|nights?|hours?|mornings?|afternoons?|evenings?|noon|midnight|soon|shortly|later|earlier|lately|recently|ago|momentarily|holidays?|halloween|christmas|xmas|thanksgiving|easter|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i
/** Advice and judgement: Worth states the engine's result and never recommends or rates options. */
const ADVICE =
  /\b(?:skip\w*|delay\w*|defer\w*|postpon\w*|late|miss(?:ing)?|borrow\w*|loans?|credit|financ\w*|overdraft|recommend\w*|suggest\w*|advis\w*|should|ought|smart\w*|wise\w*|better|best|ideal\w*|easier|easy|safer|prefer\w*|worth\s+it|go\s+with|opt\s+for|works?\s+out|lifts?|lifting|helps?|helping|softens?|good|great|fine|nice|ok(?:ay)?|no\s+(?:issue|problem|worries|concern)s?|covered|doable|manageable|dip\w*\s+into|tap\w*\s+into|use\s+(?:your|the)\s+cushion)\b|\b(?:use|using|try|consider|choose|pick|switch\s+to|split\w*)\b[^.]{0,40}\b(?:pay\s+in\s+4|pay\s+later|instal+ments?|bnpl)\b/i
/** A sentence about Pay in 4 or paying later. */
const PAY_IN_4_MENTION =
  /\bpay\s+in\s+4\b|\bpay(?:ing)?\s+later\b|\bsplit\w*|\bspread\w*|\binstal+ments?\b|\bbnpl\b|\bpaypal\b/i
const POSITIVE =
  /\b(?:fits?|fitting|afford\w*|safe(?:ly)?|comfortabl\w*|go\s+ahead|easily|plenty|stays?\s+above|keeps?\s+your\s+cushion|in\s+good\s+shape|remains?\s+(?:above|over))\b/i
const NEGATIVE =
  /\b(?:dips?|dipping|below|under|short(?:fall)?|overdrawn|negative|too\s+much|too\s+little|tight|risky|breaks?)\b|\b(?:not|never|cannot|can['’]?t|won['’]?t|\w+n['’]t)\b(?:\s+[A-Za-z']+){0,2}\s+(?:fit|afford|enough|keep|hold|cover|stay|make|leave)\w*/i

/**
 * Checks Claude's sentence and fills in the engine's values (scope C-13). The sentence must be one
 * plain sentence: ASCII words and punctuation around placeholders this answer offers, so every
 * figure, date and name is the engine's. On top of that structure it may not give advice, rate Pay
 * in 4 or the options, use a value in the wrong place, or contradict the engine's outcome.
 */
export function checkSentence(
  raw: string | null | undefined,
  values: Placeholders,
  outcome?: Assessment['outcome'],
): { ok: true; text: string } | { ok: false; reason: SentenceRejection } {
  const reject = (reason: SentenceRejection) => ({ ok: false as const, reason })
  if (!raw?.trim()) return reject('no_sentence')
  if (/[\r\n]/.test(raw.trim())) return reject('not_one_sentence')
  const sentence = raw
    .normalize('NFKC')
    .replace(/[ \t]+/g, ' ')
    .trim()
  if (sentence.length < 12 || sentence.length > 240) return reject('length')
  const names = [...sentence.matchAll(PLACEHOLDER)].map((m) => m[1]!)
  if (names.some((name) => !(name in values)) || /[{}]/.test(sentence.replace(PLACEHOLDER, '')))
    return reject('unknown_placeholder')
  const prose = sentence.replace(PLACEHOLDER, ' ')
  // Structure first: plain ASCII words and a few punctuation marks, nothing else.
  const plain = prose.replace(PAY_IN_4_NAME, 'PayPal')
  if (/[^A-Za-z ,;:'’\-–—().!]/.test(plain)) return reject('not_plain')
  if (/\b[A-Z]{2,}\b/.test(plain.replace(/\bPayPal\b/g, ''))) return reject('free_number')
  if (!/[.!]$/.test(sentence) || /[.!?]\s+\S/.test(prose.slice(0, -1)))
    return reject('not_one_sentence')
  if ((prose.match(/[;:]/g) ?? []).length > 1) return reject('not_one_sentence')
  if (ADVICE.test(prose)) return reject('advice')
  if (NUMBER_WORD.test(plain)) return reject('free_number')
  // "Today" is the engine's own day when the answer is about today (room to spend, a purchase
  // today); about a later day it would be a free date.
  const aboutToday = values.buy_day ? values.buy_day.value === 'today' : true
  const dated = aboutToday ? plain.replace(/\b(?:today|right\s+now|now)\b/gi, ' ') : plain
  if (DATE_WORD.test(dated)) return reject('free_date')
  const payIn4 = payIn4Problem(sentence, values)
  if (payIn4) return reject(payIn4)
  if (wrongValue(sentence, values)) return reject('wrong_value')
  if (misordered(sentence, values)) return reject('contradicts_result')
  // A tight result may still say what would fit: waiting, or spending less.
  const conditional = /\{(?:wait_day|max_spend)\}/.test(sentence)
  if (
    (outcome === 'tight' && POSITIVE.test(prose) && !conditional) ||
    (outcome === 'fits' && NEGATIVE.test(prose))
  )
    return reject('contradicts_result')
  return { ok: true, text: fill(sentence, values) }
}
/**
 * Pay in 4 may be named only when the person asked about it (the answer then offers p4
 * placeholders), only next to one of those engine values, only as "no interest" and "not
 * cheaper", and its low point only as "the lowest balance would be …", never as unchanged.
 */
function payIn4Problem(sentence: string, values: Placeholders): SentenceRejection | undefined {
  const asked = Object.keys(values).some((name) => name.startsWith('p4_'))
  const usesValue = /\{p4_[a-z_]+\}/.test(sentence)
  if (!PAY_IN_4_MENTION.test(sentence) && !usesValue) return undefined
  // Unasked, Pay in 4 is never named; asked, it may be named in the neutral terms below.
  if (!asked) return 'pay_in_4'
  if (
    /\binterest\b/i.test(sentence) &&
    !/\b(?:no|without)\s+interest\b|\binterest[-\s]free\b/i.test(sentence)
  )
    return 'pay_in_4'
  if (
    /\bcheaper\b/i.test(sentence) &&
    !/\b(?:not|no|isn['’]t|never)\s+(?:any\s+)?cheaper\b/i.test(sentence)
  )
    return 'pay_in_4'
  // The full-price low point belongs to paying in full, never to the instalments.
  if (/\{(?:low_point|low_day|gap|stress_low)\}/.test(sentence)) return 'contradicts_result'
  if (/\{p4_low_point\}/.test(sentence)) {
    if (
      !/\b(?:lowest\s+(?:balance|point)|low\s+point)(?:\s+with\s+pay\s+in\s+4)?\s+(?:would\s+be|is|of)\s+\{p4_low_point\}/i.test(
        sentence,
      )
    )
      return 'pay_in_4'
    if (
      /\b(?:still|unchanged|identical|match\w*|equal\w*|too|also|again|same\s+as)\b/i.test(sentence)
    )
      return 'contradicts_result'
  }
  return undefined
}
/** A value placed where it doesn't belong: a day for another event, a price as a limit, a gap's direction. */
function wrongValue(sentence: string, values: Placeholders) {
  // "{income_name} arrives on {low_day}": a day must belong to the value it is attached to.
  for (const m of sentence.matchAll(
    /\{([a-z0-9_]+)\}((?:\s+[A-Za-z']+){0,4}?)\s+(?:on|by|around)\s+\{([a-z0-9_]+_day)\}/g,
  )) {
    const owner = values[m[1]!]?.date
    const day = values[m[3]!]?.date
    if (owner && day && owner !== day) return true
  }
  // "Your cushion is {low_point}" or "the {low_point} cushion".
  if (/\bcushion\s+(?:is|of|at|sits\s+at|stands\s+at|would\s+be)\s+\{(?!cushion\})/i.test(sentence))
    return true
  if (/\{(?!cushion\})[a-z0-9_]+\}\s+cushion\b/i.test(sentence)) return true
  // "The most you can spend is {price}": only the engine's limits are limits.
  for (const m of sentence.matchAll(
    /\b(?:the\s+most|at\s+most|up\s+to|limit|maximum|max)\b(?:\s+[A-Za-z']+){0,5}\s+\{([a-z0-9_]+)\}/gi,
  ))
    if (!['max_spend', 'room_today'].includes(m[1]!)) return true
  // "{gap} over your cushion" when the low point is below it, and the reverse.
  const gap = values.gap?.about ?? ''
  if (
    /below/.test(gap) &&
    /\{gap\}\s+(?:over|above|more\s+than|to\s+spare|ahead|extra)/i.test(sentence)
  )
    return true
  if (/above/.test(gap) && /\{gap\}\s+(?:under|below|short|less\s+than)/i.test(sentence))
    return true
  return false
}
/**
 * Whether "before" or "after" in the sentence puts two dated values in the wrong order, as in
 * "{cause_bill} on {cause_day}, before {income_name}" when the income arrives first.
 */
const PAYDAY_WORDS =
  /\b(before|after|until|ahead\s+of)\s+(?:your\s+|the\s+|a\s+)?(?:next\s+)?(?:paycheck|pay\s*day|income|salary)\b/gi
function misordered(sentence: string, values: Placeholders) {
  // "before your next paycheck" written in words means the next income placeholder's day.
  const income = values.income_name?.date
  const matches = [
    ...[
      ...sentence.matchAll(
        /\b(before|after|until|ahead\s+of|followed\s+by)\s+(?:[a-z']+\s+){0,3}\{([a-z0-9_]+)\}/gi,
      ),
    ].map((m) => ({ index: m.index, word: m[1]!, date: values[m[2]!]?.date })),
    ...[...sentence.matchAll(PAYDAY_WORDS)].map((m) => ({
      index: m.index,
      word: m[1]!,
      date: income,
    })),
  ]
  for (const m of matches) {
    const later = m.date
    const earlier = [...sentence.slice(0, m.index).matchAll(PLACEHOLDER)]
      .map((p) => values[p[1]!]?.date)
      .filter(Boolean)
      .at(-1)
    if (!later || !earlier) continue
    const word = m.word.toLowerCase()
    const forward = !/^after/.test(word)
    if (forward ? earlier > later : earlier < later) return true
  }
  return false
}
/** The sentence with each placeholder replaced by the engine's value. */
export function fill(sentence: string, values: Placeholders) {
  const text = sentence.replace(PLACEHOLDER, (_, name: string) => values[name]?.value ?? '')
  return capitalize(text)
}
