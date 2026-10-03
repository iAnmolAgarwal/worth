import { addDays, assessPurchase, getUpcomingFlows, money } from '../shared/finance.ts'
import type { Assessment, Interpretation } from '../shared/types.ts'
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
  return facts
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
