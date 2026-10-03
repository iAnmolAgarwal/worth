import { addDays, assessPurchase, getUpcomingFlows, money } from '../shared/finance.ts'
import type { Assessment, Interpretation } from '../shared/types.ts'
import { dateLabel, shortLabel } from './dates.ts'
import type { ChatData } from './interpret.ts'
import { chatLabel } from './labels.ts'

// Every figure the user sees comes from the engine. The verdict sentence is a
// template; Claude may add prose that names figures only through placeholders.

export type Placeholders = Record<string, string>
export type CommitmentKind = 'subscriptions' | 'bills' | 'all'

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
const when = (date: string, today: string) =>
  date === today ? 'today' : `on ${dateLabel(date, today)}`

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
export function assessmentFacts(a: Assessment) {
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

function nextFlow(data: ChatData, predicate: (kind: string) => boolean) {
  const found = getUpcomingFlows(data.profile, data.today, 30).find(({ flow }) =>
    predicate(flow.kind),
  )
  return found ? { name: chatLabel(found.flow.name), date: found.date } : undefined
}
function planPlaceholders(data: ChatData): Placeholders {
  const income = nextFlow(data, (kind) => kind === 'income')
  const bill = nextFlow(data, (kind) => kind !== 'income')
  return {
    cushion: money(data.profile.cushionCents),
    window_end: dateLabel(addDays(data.today, 30), data.today),
    ...(income ? { next_income_date: dateLabel(income.date, data.today) } : {}),
    ...(bill ? { next_bill: bill.name, next_bill_date: dateLabel(bill.date, data.today) } : {}),
  }
}

/** Values Claude may reference for an assessed purchase. */
export function assessmentPlaceholders(a: Assessment, data: ChatData): Placeholders {
  const values: Placeholders = {
    ...planPlaceholders(data),
    item: a.itemName,
    price: money(a.amountCents),
    purchase_date: dateLabel(a.purchaseDate, a.today),
    cushion: money(a.cushionCents),
  }
  if (a.outcome === 'incomplete') return values
  Object.assign(values, {
    low_point: money(a.lowestBalanceCents),
    low_date: dateLabel(a.lowestDate, a.today),
    stress_low: money(a.stressLowestCents),
  })
  if (a.headroomCents < 0) values.shortfall = money(-a.headroomCents)
  else values.headroom = money(a.headroomCents)
  if (a.earliestDate && a.earliestDate > a.purchaseDate)
    values.fits_on = dateLabel(a.earliestDate, a.today)
  if (a.maxAffordableCents > 0) values.max_price = money(a.maxAffordableCents)
  return values
}
export function overviewPlaceholders(data: ChatData): Placeholders {
  const base = baseline(data)
  const values = planPlaceholders(data)
  if (base.outcome === 'incomplete') return values
  return {
    ...values,
    low_point: money(base.baselineLowestCents),
    low_date: dateLabel(base.lowestDate, data.today),
    ...(base.maxAffordableCents > 0 ? { max_price: money(base.maxAffordableCents) } : {}),
  }
}
export function commitmentPlaceholders(data: ChatData, kind: CommitmentKind): Placeholders {
  const value = commitments(data, kind)
  const subscriptions = commitments(data, 'subscriptions')
  const bills = commitments(data, 'bills')
  const first = value.events[0]
  return {
    ...planPlaceholders(data),
    subscriptions_total: money(subscriptions.totalCents),
    subscription_count: String(subscriptions.events.length),
    bills_total: money(bills.totalCents),
    bill_count: String(bills.events.length),
    ...(first ? { next_bill: first.name, next_bill_date: dateLabel(first.date, data.today) } : {}),
  }
}
export function spendingPlaceholders(data: ChatData): Placeholders {
  const value = spending(data)
  return {
    ...planPlaceholders(data),
    spending_total: money(value.totalCents),
    ...(value.categories[0] ? { top_category: value.categories[0].name } : {}),
  }
}

const MEANINGS: Record<string, string> = {
  item: 'the item as the user named it',
  price: 'the total price being checked',
  purchase_date: 'the day being checked',
  low_point: 'the lowest projected balance in the plan window if they buy on that day',
  low_date: 'the day of that low point',
  cushion: "the user's chosen minimum balance",
  shortfall: 'how far that low point falls below the cushion',
  headroom: 'how much room stays above the cushion at the low point, after this purchase',
  fits_on: 'the earliest day that buying in full keeps the cushion',
  max_price: 'the most they could spend on the day being checked and keep the cushion',
  stress_low: 'the low point if everyday spending runs 20% higher',
  next_income_date: 'the next confirmed paycheck date',
  next_bill: 'the next scheduled bill or subscription',
  next_bill_date: 'the date of that next bill',
  window_end: 'the last day the plan covers',
  subscriptions_total: 'the total of subscriptions due in the next 30 days',
  subscription_count: 'how many subscriptions are due in the next 30 days',
  bills_total: 'the total of bills (not subscriptions) due in the next 30 days',
  bill_count: 'how many bills are due in the next 30 days',
  spending_total: 'recorded spending over the last 30 days',
  top_category: 'the largest spending category over the last 30 days',
}
/** Placeholder names with their meaning and current value, for tool results. */
export function describePlaceholders(values: Placeholders) {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      `${MEANINGS[name] ?? name.replaceAll('_', ' ')}: ${value}`,
    ]),
  )
}

// ---- Prose guard -----------------------------------------------------------------

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g
const NUMBER_WORD = String.raw`(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|a\s+few|a\s+couple(?:\s+of)?|several|a)`
const CURRENCY_WORD = String.raw`(?:dollars?|bucks?|usd|cents?|euros?|eur|gbp|pounds?|yen|rupees?|inr|quid|pesos?|grand)`
// A bare currency name ("in US dollars") is not an amount; a spelled-out one is.
const FIGURE_WORDS = new RegExp(
  String.raw`\b(?:hundreds?|thousands?|millions?|billions?|percent(?:age)?|dozens?)\b|\b${NUMBER_WORD}\s+(?:\w+\s+)?${CURRENCY_WORD}\b`,
  'i',
)
const COUNTED_UNIT =
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|a\s+couple\s+of|a\s+few|several|couple\s+of)\s+(?:more\s+|extra\s+|short\s+)?(?:days?|weeks?|months?|years?|paychecks?|paydays?|bills?|payments?|subscriptions?)\b/i
const CALENDAR =
  /\b(?:January|February|March|April|June|July|August|September|October|November|December|(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?(?=\s))|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/i

const NEGATION =
  /(?:\b(?:not|never|no|without|avoid|avoiding|against|rather\s+than|instead\s+of|neither|nor|refuse|wouldn't|shouldn't|don't|won't|can't|cannot|isn't)\b|n't\b)/i
const WARNING =
  /\b(?:(?:is|are|would\s+be|isn't|is\s+not)\s+(?:a\s+)?(?:bad|risky|unsafe|dangerous|mistake|not\s+(?:a\s+)?(?:good|safe|wise|recommended))|(?:wouldn't|would\s+not|don't|do\s+not|can't)\s+recommend|not\s+something\s+i(?:'d|\s+would)?\s+recommend|risks?|risky|late\s+fees?|penalt(?:y|ies)|hurt|damage|harm|dangerous|unsafe|costly)\b/i
const FILL = String.raw`(?:(?:your|the|my|this|next|a|an|paying|making|on|month's|of|some|that|upcoming|scheduled|monthly|one|any)\s+){0,3}`
const OBLIGATION = String.raw`(?:(?:rent|mortgage|utilit(?:y|ies)|internet|insurance|subscriptions?)(?:\s+(?:bills?|payments?))?|(?:phone|car|electric(?:ity)?|water|gas|loan|card|credit\s+card|student\s+loan)\s+(?:bills?|payments?)|bills?|obligations?|commitments?|payments?|repayments?|essentials?|groceries|debts?)`
const DEFER_VERB = String.raw`(?:skip(?:ping|ped)?|miss(?:ing|ed)?|delay(?:ing|ed)?|defer(?:ring|red)?|postpon(?:e|ing|ed)|push(?:ing)?\s+back|put(?:ting)?\s+off|hold(?:ing)?\s+off\s+on|ignor(?:e|ing)|forgo(?:ing)?|forego(?:ing)?|stop\s+paying|not\s+pay(?:ing)?|underpay(?:ing)?|reschedul(?:e|ing)|mov(?:e|ing)|shift(?:ing)?|let(?:ting)?)`
const DEFERS = new RegExp(String.raw`\b${DEFER_VERB}\s+${FILL}${OBLIGATION}\b`, 'i')
const DEFERRED = new RegExp(
  String.raw`\b${OBLIGATION}\s+(?:[\w']+\s+){0,3}?(?:be\s+)?(?:skipped|delayed|deferred|postponed|missed|pushed\s+back|put\s+off|paid\s+late|wait|slide|slip|rescheduled)\b`,
  'i',
)
const LATE = new RegExp(
  String.raw`\bpay(?:ing)?\s+${FILL}${OBLIGATION}\s+late\b|\blate\s+on\s+${FILL}${OBLIGATION}\b`,
  'i',
)
const CUSHION = String.raw`(?:cushion|buffer|reserves?|emergency\s+(?:fund|savings)|safety\s+net)`
const SPENDS_CUSHION = new RegExp(
  String.raw`\b(?:lower(?:ing)?|reduc(?:e|ing)|shrink(?:ing)?|relax(?:ing)?|cut(?:ting)?|drop(?:ping)?|dip(?:ping)?\s+into|us(?:e|ing)|tap(?:ping)?(?:\s+into)?|spend(?:ing)?|eat(?:ing)?\s+into|draw(?:ing)?\s+(?:on|down)|borrow(?:ing)?\s+from|giv(?:e|ing)\s+up|sacrific(?:e|ing))\s+${FILL}${CUSHION}\b|\b${CUSHION}\s+(?:could|can|might)\s+be\s+(?:lowered|reduced|relaxed|used|dipped\s+into|tapped)\b`,
  'i',
)
const CREDIT =
  /\b(?:credit(?:\s+cards?)?|loans?|borrow(?:ing|ed)?|financ(?:e|ing)|bnpl|buy\s+now,?\s+pay\s+later|pay\s+later|pay\s+in\s+(?:four|4)|instal(?:l)?ments?|split(?:ting)?\s+(?:it|the\s+(?:cost|payment|purchase))|layaway|cash\s+advance|overdraft)\b/i

function clauses(text: string) {
  return text.split(/[.;!?]+|,|\bbut\b|\s[-–—]\s/i).map((c) => c.trim())
}
function affirmed(clause: string, pattern: RegExp) {
  const match = clause.match(pattern)
  if (!match) return false
  const inside = /\b(?:not|never)\b|n't\b/i.test(match[0]) && !/not\s+pay/i.test(match[0])
  return !inside && !NEGATION.test(clause.slice(0, match.index)) && !WARNING.test(clause)
}

/** Advice to skip or delay a bill, use the cushion, or take on credit, read with negation. */
export function riskyAdvice(text: string) {
  return clauses(text).some((clause) =>
    [DEFERS, DEFERRED, LATE, SPENDS_CUSHION, CREDIT].some((pattern) => affirmed(clause, pattern)),
  )
}

const APPROVAL =
  /\b(?:guarantee[ds]?|definitely|certainly|go\s+ahead|you\s+should\s+(?:buy|get|purchase)|buy\s+it\s+(?:now|today)|treat\s+yourself|no[-\s]brainer|risk[-\s]free|nothing\s+to\s+worry)\b/i
const POSITIVE =
  /\b(?:(?:you\s+)?can\s+(?:easily\s+|comfortably\s+|safely\s+|probably\s+|still\s+)?(?:afford|cover)|affordable|(?:is|it's|looks|seems)\s+(?:safe|fine|ok(?:ay)?|doable|manageable|realistic)|safe\s+to\s+(?:buy|purchase|spend)|within\s+(?:your\s+)?(?:budget|means)|fits\s+(?:comfortably|easily|well|nicely|within|in|into)|(?:it|this|that|the\s+[a-z]+)\s+fits\b(?!\s+(?:on|after|from|by|once|starting|if|when|later))|(?:would|will|does|should)\s+fit\b(?!\s+(?:on|after|from|by|once|starting|if|when|later))|stays?\s+(?:above|over|within)\s+(?:your\s+)?(?:chosen\s+)?cushion|(?:keeps?|leaves?)\s+(?:your\s+)?(?:chosen\s+)?cushion\s+(?:intact|safe|untouched|whole)|(?:plenty|enough)\s+(?:of\s+)?(?:room|space|money|cushion|buffer)|you(?:'re|\s+are)\s+(?:fine|good|okay|ok|covered|set)|no\s+problem)\b/i
const NEGATIVE =
  /\b(?:(?:would|will|could|might)\s+(?:dip|drop|fall|go|take\s+you|push\s+you|bring\s+you|put\s+you|leave\s+you)\s+(?:\w+\s+)?below|(?:dips?|drops?|falls?|goes)\s+below|below\s+(?:your\s+)?(?:chosen\s+)?cushion|can(?:'t|not)\s+(?:afford|cover)|cannot\s+(?:afford|cover)|(?:too|very|quite)\s+tight|(?:is|looks)\s+tight|(?:falls?|comes?)\s+short|short\s+of|not\s+enough|(?:would|will)\s+(?:cross|break|dent|eat\s+into)|(?:doesn't|does\s+not|won't|wouldn't|will\s+not|would\s+not)\s+fit|not\s+affordable|unaffordable|over\s+(?:your\s+)?budget)\b/i
const CONDITIONAL =
  /\b(?:if|wait(?:ing|ed)?|until|after|once|later|instead|lower|cheaper|smaller|less\s+expensive|alternative|holding\s+off|hold\s+off|by\s+then|from\s+then)\b|\{\{\s*(?:fits_on|max_price)\s*\}\}/i
const STRESS = /\b(?:if|higher|stress|more\s+than\s+(?:expected|planned|usual)|extra|unexpected)\b/i

/**
 * Whether prose claims a verdict the engine did not produce. `outcome` is undefined when
 * the answer has no assessment.
 */
export function contradiction(
  text: string,
  outcome: Assessment['outcome'] | undefined,
  stressBelow = false,
): string | undefined {
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const positive = clauses(sentence).some((clause) => asserted(clause, POSITIVE))
    const negative = clauses(sentence).some((clause) => asserted(clause, NEGATIVE))
    if (positive && outcome !== 'fits' && !(outcome === 'tight' && CONDITIONAL.test(sentence)))
      return 'positive verdict the engine did not produce'
    if (negative && outcome === 'fits' && !(stressBelow && STRESS.test(sentence)))
      return 'negative verdict that contradicts a fitting purchase'
    if (negative && outcome === 'incomplete') return 'verdict while the plan is incomplete'
  }
  return undefined
}
function asserted(clause: string, pattern: RegExp) {
  const match = clause.match(pattern)
  return Boolean(match) && !NEGATION.test(clause.slice(0, match!.index))
}

export type ProseCheck = { ok: true; text: string } | { ok: false; reason: string }

/** Reject figures written outside known placeholders; fill the placeholders with engine values. */
export function fillFigures(text: string, values: Placeholders, maxLength = 420): ProseCheck {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (!trimmed) return { ok: false, reason: 'empty' }
  if (trimmed.length > maxLength) return { ok: false, reason: 'too long' }
  for (const [, name] of trimmed.matchAll(PLACEHOLDER))
    if (!(name! in values)) return { ok: false, reason: `unavailable placeholder ${name}` }
  const residual = trimmed.replace(PLACEHOLDER, ' ')
  if (/[{}]/.test(residual)) return { ok: false, reason: 'malformed placeholder' }
  if (/[\p{N}\p{Sc}%]/u.test(residual)) return { ok: false, reason: 'raw figure' }
  if (FIGURE_WORDS.test(residual) || COUNTED_UNIT.test(residual))
    return { ok: false, reason: 'spelled-out figure' }
  if (CALENDAR.test(residual)) return { ok: false, reason: 'raw calendar date' }
  return {
    ok: true,
    text: capitalize(trimmed.replace(PLACEHOLDER, (_m, name: string) => values[name]!)),
  }
}

/**
 * Accept Claude's prose only when every figure is a known placeholder and it gives no
 * risky advice or contradicting verdict; fill the placeholders with engine values.
 */
export function checkProse(
  text: string,
  values: Placeholders,
  outcome: Assessment['outcome'] | undefined,
  options: { stressBelow?: boolean } = {},
): ProseCheck {
  const filled = fillFigures(text, values)
  if (!filled.ok) return filled
  const residual = text.replace(PLACEHOLDER, ' ')
  if (APPROVAL.test(residual)) return { ok: false, reason: 'approval language' }
  if (riskyAdvice(residual)) return { ok: false, reason: 'risky advice' }
  const conflict = contradiction(text.replace(/\s+/g, ' '), outcome, options.stressBelow)
  if (conflict) return { ok: false, reason: conflict }
  return filled
}
