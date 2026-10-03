import type {
  ActivePlanPayment,
  Assessment,
  Comparison,
  FinancialProfile,
  ForecastPoint,
  InstalmentDetail,
  LowPointCause,
  NearbyBill,
  OptionResult,
  PayIn4Comparison,
  PlanInstalment,
  Purchase,
  PurchaseReview,
  ScheduledFlow,
  StackingWarning,
} from './types.ts'

/** Every option is judged from today through this many days ahead, fixed before any search. */
export const COMPARISON_WINDOW_DAYS = 60
/** Wait candidates run from today through this many days ahead. */
export const WAIT_SEARCH_DAYS = 30
/** PayPal's US Pay in 4 range. Eligibility also needs PayPal's own check; it is never approval. */
export const PAY_IN_4_MIN_CENTS = 1_000
export const PAY_IN_4_MAX_CENTS = 200_000
/** Illustrative payment days. PayPal's real schedule can differ (the sandbox used 16-day gaps). */
export const PAY_IN_4_OFFSETS = [0, 14, 28, 42] as const
/** An instalment is paired with the nearest bill no more than this many days away. */
export const NEARBY_BILL_DAYS = 3
export const PAY_IN_4_NOTICE = 'Illustrative. PayPal sets the exact terms at checkout.'
export const PAY_IN_4_UNAVAILABLE = 'Not available for this amount'
export const REFUND_GUIDANCE =
  'A partial refund may shorten the plan or reduce the final payment. Store credit does not reduce the loan.'

const DAY_MS = 86_400_000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function validDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T12:00:00.000Z`)
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

export function todayInTimezone(timezone = 'America/New_York'): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  return `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}-${parts.find((p) => p.type === 'day')!.value}`
}

/**
 * Returns the time zone name unchanged when the runtime supports it, or undefined. The name is not
 * canonicalized, because ICU maps current names such as Asia/Kolkata to legacy ones.
 */
export function normalizeTimezone(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 80) return undefined
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return value
  } catch {
    return undefined
  }
}

export function addDays(date: string, days: number): string {
  if (!validDate(date) || !Number.isInteger(days))
    throw new Error('Use a valid calendar date and a whole number of days.')
  return new Date(new Date(`${date}T12:00:00.000Z`).valueOf() + days * DAY_MS)
    .toISOString()
    .slice(0, 10)
}

export function money(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100)
}

/** A short, time-zone-free label such as "Oct 18". */
export function shortDay(date: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`))
}

export function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T12:00:00Z`).valueOf() - new Date(`${from}T12:00:00Z`).valueOf()) / DAY_MS,
  )
}

// Always anchor monthly/yearly dates to the original day. Jan 31 -> Feb 28 -> Mar 31.
function occurrence(flow: ScheduledFlow, offset: number): string {
  if (flow.cadence === 'weekly') return addDays(flow.nextDate, offset * 7)
  if (flow.cadence === 'biweekly') return addDays(flow.nextDate, offset * 14)
  if (flow.cadence === 'once') return flow.nextDate
  const [year, month, day] = flow.nextDate.split('-').map(Number)
  const months = offset * (flow.cadence === 'yearly' ? 12 : 1)
  const monthStart = new Date(Date.UTC(year, month - 1 + months, 1, 12))
  const lastDay = new Date(
    Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0, 12),
  ).getUTCDate()
  return new Date(
    Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), Math.min(day, lastDay), 12),
  )
    .toISOString()
    .slice(0, 10)
}

export function getUpcomingFlows(
  profile: FinancialProfile,
  today: string,
  days = 30,
): { flow: ScheduledFlow; date: string }[] {
  if (!validDate(today) || !Number.isInteger(days) || days < 0 || days > 366)
    throw new Error('Invalid forecast window.')
  const end = addDays(today, days)
  const result: { flow: ScheduledFlow; date: string }[] = []
  for (const flow of profile.flows) {
    if (
      !flow.active ||
      !flow.confirmed ||
      !validDate(flow.nextDate) ||
      !Number.isSafeInteger(flow.amountCents) ||
      flow.amountCents < 0
    )
      continue
    if (flow.cadence === 'once') {
      if (flow.nextDate >= today && flow.nextDate <= end) result.push({ flow, date: flow.nextDate })
      continue
    }
    // Jump near today's occurrence to avoid replaying years of historical events.
    const elapsed = daysBetween(flow.nextDate, today)
    let offset = Math.max(
      0,
      Math.floor(
        elapsed /
          (flow.cadence === 'weekly'
            ? 7
            : flow.cadence === 'biweekly'
              ? 14
              : flow.cadence === 'yearly'
                ? 366
                : 31),
      ) - 1,
    )
    for (; offset < 100_000; offset++) {
      const date = occurrence(flow, offset)
      if (date > end) break
      if (date >= today) result.push({ flow, date })
    }
  }
  return result
    .filter(({ flow, date }) => !alreadyPaid(profile, flow, date))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        Number(a.flow.kind === 'income') - Number(b.flow.kind === 'income') ||
        a.flow.id.localeCompare(b.flow.id),
    )
}

/** An occurrence the user marked paid is already in a funds snapshot taken on or after that day. */
function alreadyPaid(profile: FinancialProfile, flow: ScheduledFlow, date: string): boolean {
  return flow.paidOn === date && date <= profile.snapshotDate
}

/** Purchases that still affect the plan, with duplicate order or capture identities removed. */
function livePurchases(purchases: Purchase[]): Purchase[] {
  const seen = new Set<string>()
  // A reconciled capture wins over an older pending copy of the same payment.
  return [...purchases]
    .sort((a, b) => Number(b.status === 'completed') - Number(a.status === 'completed'))
    .filter((purchase) => {
      if (purchase.archived || purchase.status === 'failed' || purchase.status === 'cancelled')
        return false
      const identities = [
        `id:${purchase.id}`,
        ...(purchase.orderId ? [`order:${purchase.orderId}`] : []),
        ...(purchase.captureId ? [`capture:${purchase.captureId}`] : []),
      ]
      if (identities.some((key) => seen.has(key))) return false
      identities.forEach((key) => seen.add(key))
      return Number.isSafeInteger(purchase.amountCents) && purchase.amountCents >= 0
    })
}

/** A dated outflow from a purchase made earlier. */
interface PurchaseOutflow {
  id: string
  purchaseId: string
  name: string
  date: string
  amountCents: number
  /** Set for the payments of a confirmed Pay in 4 plan. */
  planned: boolean
}

function validInstalments(items: PlanInstalment[] | undefined): PlanInstalment[] | undefined {
  return items?.every(
    (item) =>
      validDate(item.date) && Number.isSafeInteger(item.amountCents) && item.amountCents > 0,
  )
    ? items
    : undefined
}

/**
 * The payments still due on a purchase's confirmed Pay in 4 plan: the remaining payments entered
 * with the latest confirmed refund, or else the confirmed schedule. Undefined without such a plan.
 */
export function confirmedSchedule(purchase: Purchase): PlanInstalment[] | undefined {
  const plan = purchase.paymentPlan
  if (purchase.status !== 'completed' || plan?.product !== 'payIn4' || plan.status !== 'confirmed')
    return undefined
  const instalments = validInstalments(plan.instalments)
  if (!instalments) return undefined
  const remaining = (purchase.refunds ?? []).findLast(
    (refund) => refund.status === 'confirmed' && refund.remainingInstalments,
  )
  return remaining ? validInstalments(remaining.remainingInstalments) : instalments
}

/**
 * The single cash effect of each purchase. A checkout in progress, or a completed purchase without
 * a confirmed plan, is one full-price debit today unless the funds snapshot already reflects it. A
 * confirmed Pay in 4 plan replaces that debit with its payments, using the remaining payments
 * exactly as the user entered them after a refund. Until the snapshot reflects the purchase, a
 * payment dated before today still counts, today, like the full debit would; once it does,
 * payments dated on or before the snapshot are already in it. Money a confirmed refund returned
 * only reduces an unreflected full-price debit and never adds funds: a fresh funds snapshot picks
 * it up.
 */
function purchaseOutflows(
  profile: FinancialProfile,
  purchases: Purchase[],
  today: string,
): PurchaseOutflow[] {
  const result: PurchaseOutflow[] = []
  for (const purchase of livePurchases(purchases)) {
    const completed = purchase.status === 'completed'
    const reflected = completed && profile.reflectedPurchaseIds.includes(purchase.id)
    const schedule = confirmedSchedule(purchase)
    if (schedule) {
      result.push(
        ...schedule
          .map((item, index) => ({
            id: `plan:${purchase.id}:${index + 1}`,
            purchaseId: purchase.id,
            name: `${purchase.name} · Pay in 4 payment ${index + 1} of ${schedule.length}`,
            date: item.date < today ? today : item.date,
            amountCents: item.amountCents,
            planned: true,
            due: item.date,
          }))
          .filter((item) => !reflected || item.due > profile.snapshotDate)
          .map(({ due: _due, ...item }) => item),
      )
      continue
    }
    if (reflected) continue
    const returned = completed
      ? (purchase.refunds ?? []).reduce(
          (total, refund) =>
            total +
            (refund.status === 'confirmed' &&
            Number.isSafeInteger(refund.returnedCents) &&
            refund.returnedCents! > 0
              ? refund.returnedCents!
              : 0),
          0,
        )
      : 0
    const amountCents = Math.max(0, purchase.amountCents - returned)
    if (amountCents > 0)
      result.push({
        id: `reserved:${purchase.id}`,
        purchaseId: purchase.id,
        name: `${purchase.name} · ${completed ? 'paid' : 'reserved'}`,
        date: today,
        amountCents,
        planned: false,
      })
  }
  return result
}

/** A proposed payment in a scenario: the whole purchase, or one illustrative instalment. */
export interface ScenarioOutflow {
  id: string
  name: string
  date: string
  amountCents: number
}

export function forecast(
  profile: FinancialProfile,
  purchases: Purchase[],
  options: {
    today?: string
    purchaseDate?: string
    amountCents?: number
    /** Replaces `purchaseDate` and `amountCents` with several dated payments. */
    outflows?: ScenarioOutflow[]
    days?: number
  } = {},
): ForecastPoint[] {
  const today = options.today ?? todayInTimezone(profile.timezone)
  const purchaseDate = options.purchaseDate ?? today
  const amount = options.amountCents ?? 0
  const days = options.days ?? 30
  const proposals: ScenarioOutflow[] = options.outflows ?? [
    {
      id: `proposed:${purchaseDate}`,
      name: 'Proposed purchase',
      date: purchaseDate,
      amountCents: amount,
    },
  ]
  if (
    !validDate(today) ||
    proposals.some(
      (item) =>
        !validDate(item.date) ||
        item.date < today ||
        !Number.isSafeInteger(item.amountCents) ||
        item.amountCents < 0,
    )
  )
    throw new Error('Enter a valid future purchase date and a non-negative price in cents.')
  const upcoming = getUpcomingFlows(profile, today, days)
  const previous = purchaseOutflows(profile, purchases, today)
  const dailySpend =
    Number.isSafeInteger(profile.dailySpendCents) && profile.dailySpendCents >= 0
      ? profile.dailySpendCents
      : 0
  const stressDaily = Math.ceil(dailySpend * 1.2)
  let baseline = Number.isSafeInteger(profile.balanceCents) ? profile.balanceCents : 0
  let scenario = baseline
  let stress = baseline
  const points: ForecastPoint[] = []
  for (let day = 0; day <= days; day++) {
    const date = addDays(today, day)
    const events: ForecastPoint['events'] = []
    let baselineMinimum = baseline
    let minimum = scenario
    let stressMinimum = stress
    const outflow = (cents: number, baselineToo = true, stressCents = cents) => {
      if (baselineToo) baseline -= cents
      scenario -= cents
      stress -= stressCents
      baselineMinimum = Math.min(baselineMinimum, baseline)
      minimum = Math.min(minimum, scenario)
      stressMinimum = Math.min(stressMinimum, stress)
    }
    for (const item of previous.filter((item) => item.date === date)) {
      outflow(item.amountCents)
      events.push({
        id: item.id,
        name: item.name,
        amountCents: -item.amountCents,
        kind: 'purchase',
      })
    }
    const dayFlows = upcoming.filter((item) => item.date === date)
    for (const { flow } of dayFlows.filter((item) => item.flow.kind !== 'income')) {
      outflow(flow.amountCents)
      events.push({
        id: `${flow.id}:${date}`,
        name: flow.name,
        amountCents: -flow.amountCents,
        kind: flow.kind,
      })
    }
    outflow(dailySpend, true, stressDaily)
    if (dailySpend)
      events.push({
        id: `daily:${date}`,
        name: 'Everyday spending',
        amountCents: -dailySpend,
        kind: 'spending',
      })
    for (const item of proposals.filter((item) => item.date === date && item.amountCents > 0)) {
      outflow(item.amountCents, false)
      events.push({
        id: item.id,
        name: item.name,
        amountCents: -item.amountCents,
        kind: 'purchase',
      })
    }
    // Date-only paychecks never erase an earlier shortfall on the same day.
    for (const { flow } of dayFlows.filter((item) => item.flow.kind === 'income')) {
      baseline += flow.amountCents
      scenario += flow.amountCents
      stress += flow.amountCents
      events.push({
        id: `${flow.id}:${date}`,
        name: flow.name,
        amountCents: flow.amountCents,
        kind: 'income',
      })
    }
    points.push({
      date,
      baselineCents: baseline,
      purchaseCents: scenario,
      stressCents: stress,
      minimumCents: minimum,
      baselineMinimumCents: baselineMinimum,
      stressMinimumCents: stressMinimum,
      events,
    })
  }
  return points
}

function missingInputs(profile: FinancialProfile, purchases: Purchase[], today: string): string[] {
  const missing = [...profile.missingFields]
  if (!profile.confirmed)
    missing.push('Confirm your funds, spending estimate, income, and upcoming commitments.')
  if (!Number.isSafeInteger(profile.balanceCents))
    missing.push('Enter your current available funds.')
  if (!Number.isSafeInteger(profile.cushionCents) || profile.cushionCents < 0)
    missing.push('Choose a valid minimum cash cushion.')
  if (!Number.isSafeInteger(profile.dailySpendCents) || profile.dailySpendCents < 0)
    missing.push('Confirm your everyday spending estimate.')
  if (profile.currency !== 'USD') missing.push('Only USD plans are supported.')
  if (!validDate(profile.snapshotDate) || profile.snapshotDate !== today)
    missing.push('Refresh available funds for today and confirm which purchases are included.')
  if (!profile.confirmedAt) missing.push('Review and confirm your financial picture.')
  for (const flow of profile.flows.filter((item) => item.active)) {
    if (!flow.confirmed) missing.push(`Confirm ${flow.name} before relying on this plan.`)
    if (
      !validDate(flow.nextDate) ||
      !Number.isSafeInteger(flow.amountCents) ||
      flow.amountCents < 0
    )
      missing.push(`Correct the amount or date for ${flow.name}.`)
    if (
      flow.cadence === 'once' &&
      validDate(flow.nextDate) &&
      flow.nextDate < today &&
      flow.paidOn !== flow.nextDate
    )
      missing.push(`Confirm whether ${flow.name} has already happened.`)
  }
  for (const purchase of purchases.filter(
    (item) => !item.archived && !['failed', 'cancelled'].includes(item.status),
  )) {
    if (
      !Number.isSafeInteger(purchase.amountCents) ||
      purchase.amountCents < 0 ||
      purchase.currency !== 'USD'
    )
      missing.push(`Resolve the amount or currency for ${purchase.name}.`)
  }
  return [...new Set(missing.filter(Boolean))]
}

function cushionOf(profile: FinancialProfile): number {
  return Number.isSafeInteger(profile.cushionCents) ? Math.max(0, profile.cushionCents) : 0
}

function lowestPoint(points: ForecastPoint[]): ForecastPoint {
  return points.reduce((min, point) => (point.minimumCents < min.minimumCents ? point : min))
}

/**
 * The earliest day from today through WAIT_SEARCH_DAYS on which buying in full keeps the cushion
 * across the whole window. The window end never moves with the candidate.
 */
function earliestFittingDate(
  profile: FinancialProfile,
  purchases: Purchase[],
  today: string,
  amountCents: number,
): string | null {
  const cushion = cushionOf(profile)
  for (let day = 0; day <= WAIT_SEARCH_DAYS; day++) {
    const candidate = addDays(today, day)
    const points = forecast(profile, purchases, {
      today,
      purchaseDate: candidate,
      amountCents,
      days: COMPARISON_WINDOW_DAYS,
    })
    if (points.every((point) => point.minimumCents >= cushion)) return candidate
  }
  return null
}

export function assessPurchase(
  profile: FinancialProfile,
  purchases: Purchase[],
  options: {
    amountCents: number
    itemName?: string
    purchaseDate?: string
    today?: string
    findEarliest?: boolean
  },
): Assessment {
  const today = options.today ?? todayInTimezone(profile.timezone)
  const purchaseDate = options.purchaseDate ?? today
  if (
    !validDate(today) ||
    !validDate(purchaseDate) ||
    purchaseDate < today ||
    purchaseDate > addDays(today, WAIT_SEARCH_DAYS)
  )
    throw new Error('Choose a purchase date within the next 30 days.')
  if (!Number.isSafeInteger(options.amountCents) || options.amountCents < 0)
    throw new Error('Enter a non-negative total purchase price in cents.')
  // One window for every purchase date, so a later date is never judged over a longer horizon.
  const windowEnd = addDays(today, COMPARISON_WINDOW_DAYS)
  const points = forecast(profile, purchases, {
    today,
    purchaseDate,
    amountCents: options.amountCents,
    days: COMPARISON_WINDOW_DAYS,
  })
  const lowest = lowestPoint(points)
  const baselineLowestCents = Math.min(...points.map((point) => point.baselineMinimumCents))
  const stressLowestCents = Math.min(...points.map((point) => point.stressMinimumCents))
  const cushion = cushionOf(profile)
  const missingFields = missingInputs(profile, purchases, today)
  const outcome: Assessment['outcome'] = missingFields.length
    ? 'incomplete'
    : lowest.minimumCents >= cushion
      ? 'fits'
      : 'tight'
  const baselineBeforePurchase = points.filter((point) => point.date < purchaseDate)
  const maxAffordableCents = baselineBeforePurchase.some(
    (point) => point.baselineMinimumCents < cushion,
  )
    ? 0
    : Math.max(
        0,
        Math.min(
          ...points
            .filter((point) => point.date >= purchaseDate)
            .map((point) => point.baselineMinimumCents),
        ) - cushion,
      )
  const earliestDate =
    !missingFields.length && options.findEarliest !== false
      ? earliestFittingDate(profile, purchases, today, options.amountCents)
      : null
  const drivers = getUpcomingFlows(profile, today, COMPARISON_WINDOW_DAYS).map(
    ({ flow, date }) => ({
      name: flow.name,
      amountCents: flow.amountCents,
      date,
      kind: flow.kind,
    }),
  )
  const explanation =
    outcome === 'incomplete'
      ? 'Review the missing information before using this estimate to decide.'
      : outcome === 'fits'
        ? `This purchase keeps your estimated balance at or above your ${money(cushion)} cushion. Your lowest projected balance is ${money(lowest.minimumCents)} on ${lowest.date}.${stressLowestCents < cushion ? ' With 20% higher everyday spending, the plan falls below your cushion.' : ''}`
        : `This purchase would bring your estimated balance to ${money(lowest.minimumCents)} on ${lowest.date}, ${money(cushion - lowest.minimumCents)} below your ${money(cushion)} cushion.${baselineLowestCents < cushion ? ' Your plan also dips below the cushion without this purchase.' : ''}`
  return {
    outcome,
    amountCents: options.amountCents,
    itemName: options.itemName?.trim() || 'Your purchase',
    purchaseDate,
    today,
    horizonEnd: windowEnd,
    profileVersion: profile.version,
    cushionCents: cushion,
    lowestBalanceCents: lowest.minimumCents,
    lowestDate: lowest.date,
    baselineLowestCents,
    stressLowestCents,
    headroomCents: lowest.minimumCents - cushion,
    maxAffordableCents,
    earliestDate,
    points,
    missingFields,
    drivers,
    explanation,
    assumptions: assumptions(profile, windowEnd),
  }
}

function assumptions(profile: FinancialProfile, windowEnd: string): string[] {
  return [
    `Available funds are a snapshot for ${profile.snapshotDate}; past transactions are not deducted again.`,
    `${money(profile.dailySpendCents)} of everyday spending is allocated each calendar day, including today; scheduled bills are separate.`,
    'Bills, purchases, and everyday spending happen before income when only a date is known.',
    'The full purchase total is reserved once. Your cushion is a threshold, not an expense.',
    `Every option is judged from today through ${windowEnd}, the same ${COMPARISON_WINDOW_DAYS} days whatever the purchase date. Confirmed recurring items repeat on their schedule.`,
    'The stress scenario assumes 20% higher everyday spending; it is not a statistical confidence interval.',
    'Estimates depend on the income, bills, and outside-PayPal commitments you confirmed.',
  ]
}

/**
 * The largest outflow since the last income before the low point, so a payday-morning low names
 * the rent paid days earlier rather than that morning's everyday spending.
 */
function lowPointCause(points: ForecastPoint[], lowest: ForecastPoint): LowPointCause | null {
  const end = points.indexOf(lowest)
  let start = 0
  for (let index = end - 1; index >= 0; index--)
    if (points[index]!.events.some((event) => event.kind === 'income')) {
      start = index + 1
      break
    }
  let cause: LowPointCause | null = null
  let everyday: LowPointCause | null = null
  for (const point of points.slice(start, end + 1))
    for (const event of point.events) {
      if (event.amountCents >= 0) continue
      const candidate = {
        name: event.name,
        amountCents: -event.amountCents,
        date: point.date,
        kind: event.kind,
      }
      if (event.kind === 'spending') everyday ??= candidate
      // On a tie the later outflow, nearer the low point, is named.
      else if (!cause || candidate.amountCents >= cause.amountCents) cause = candidate
    }
  return cause ?? everyday
}

function evaluate(
  profile: FinancialProfile,
  purchases: Purchase[],
  today: string,
  missing: boolean,
  outflows: ScenarioOutflow[],
  purchaseDate: string,
): OptionResult {
  const points = forecast(profile, purchases, {
    today,
    outflows,
    days: COMPARISON_WINDOW_DAYS,
  })
  const cushion = cushionOf(profile)
  const lowest = lowestPoint(points)
  return {
    outcome: missing ? 'incomplete' : lowest.minimumCents >= cushion ? 'fits' : 'tight',
    amountCents: outflows.reduce((total, item) => total + item.amountCents, 0),
    purchaseDate,
    lowestBalanceCents: lowest.minimumCents,
    lowestDate: lowest.date,
    lowPointCause: lowPointCause(points, lowest),
    stressLowestCents: Math.min(...points.map((point) => point.stressMinimumCents)),
    headroomCents: lowest.minimumCents - cushion,
    points,
  }
}

function fullPurchase(date: string, amountCents: number, itemName: string): ScenarioOutflow[] {
  return [{ id: `proposed:${date}`, name: itemName, date, amountCents }]
}

/**
 * The illustrative Pay in 4 schedule: four whole-cent payments on days 0, 14, 28 and 42, with any
 * remainder on the first. $1,199.00 is 4 × $299.75; $10.03 is $2.53 then 3 × $2.50.
 */
export function payIn4Schedule(totalCents: number, today: string): PlanInstalment[] {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0)
    throw new Error('Enter a non-negative total purchase price in cents.')
  const base = Math.floor(totalCents / PAY_IN_4_OFFSETS.length)
  return PAY_IN_4_OFFSETS.map((offset, index) => ({
    date: addDays(today, offset),
    amountCents: index === 0 ? totalCents - base * (PAY_IN_4_OFFSETS.length - 1) : base,
  }))
}

export function payIn4InRange(amountCents: number): boolean {
  return (
    Number.isSafeInteger(amountCents) &&
    amountCents >= PAY_IN_4_MIN_CENTS &&
    amountCents <= PAY_IN_4_MAX_CENTS
  )
}

/** Obligations an instalment can land next to: bills, subscriptions and other plans' payments. */
function obligations(
  profile: FinancialProfile,
  purchases: Purchase[],
  today: string,
): Omit<NearbyBill, 'daysFromInstalment'>[] {
  return [
    ...getUpcomingFlows(profile, today, COMPARISON_WINDOW_DAYS)
      .filter(({ flow }) => flow.kind !== 'income')
      .map(({ flow, date }) => ({
        name: flow.name,
        date,
        amountCents: flow.amountCents,
        kind: flow.kind,
      })),
    ...purchaseOutflows(profile, purchases, today)
      .filter((item) => item.planned)
      .map((item) => ({
        name: item.name,
        date: item.date,
        amountCents: item.amountCents,
        kind: 'purchase' as const,
      })),
  ]
}

/**
 * The bill an instalment lands next to, at most NEARBY_BILL_DAYS away. Bills and other plans'
 * payments come before subscriptions, so a small renewal on the same day never hides rent two days
 * later; then the nearer one wins, then the larger.
 */
function nearestBill(
  date: string,
  candidates: Omit<NearbyBill, 'daysFromInstalment'>[],
): NearbyBill | null {
  return (
    candidates
      .map((bill) => ({ ...bill, daysFromInstalment: daysBetween(date, bill.date) }))
      .filter((bill) => Math.abs(bill.daysFromInstalment) <= NEARBY_BILL_DAYS)
      .sort(
        (x, y) =>
          Number(x.kind === 'subscription') - Number(y.kind === 'subscription') ||
          Math.abs(x.daysFromInstalment) - Math.abs(y.daysFromInstalment) ||
          y.amountCents - x.amountCents,
      )[0] ?? null
  )
}

/** Instalment plans already running: profile instalments grouped by plan, and confirmed purchase plans. */
function activePlanPayments(
  profile: FinancialProfile,
  purchases: Purchase[],
  today: string,
): ActivePlanPayment[] {
  return [
    ...getUpcomingFlows(profile, today, COMPARISON_WINDOW_DAYS)
      .filter(({ flow }) => flow.kind === 'installment')
      .map(({ flow, date }) => ({
        planId: flow.planId ?? flow.id,
        name: flow.name,
        date,
        amountCents: flow.amountCents,
        proposed: false,
      })),
    ...purchaseOutflows(profile, purchases, today)
      .filter((item) => item.planned)
      .map((item) => ({
        planId: `purchase:${item.purchaseId}`,
        name: item.name,
        date: item.date,
        amountCents: item.amountCents,
        proposed: false,
      })),
  ]
}

function stackingWarning(
  existing: ActivePlanPayment[],
  proposed: ActivePlanPayment[],
): StackingWarning | null {
  const plans = new Set(existing.map((payment) => payment.planId)).size
  if (!plans) return null
  const totalCents = existing.reduce((total, payment) => total + payment.amountCents, 0)
  return {
    activePlans: plans,
    totalCents,
    calendar: [...existing, ...proposed].sort(
      (a, b) => a.date.localeCompare(b.date) || Number(a.proposed) - Number(b.proposed),
    ),
    message: `You already have ${plans === 1 ? '1 instalment plan' : `${plans} instalment plans`} with ${money(totalCents)} due in this window. A new plan would add ${PAY_IN_4_OFFSETS.length} more payments on top.`,
  }
}

function payIn4Comparison(
  profile: FinancialProfile,
  purchases: Purchase[],
  today: string,
  missing: boolean,
  amountCents: number,
  itemName: string,
  eligible: boolean,
): PayIn4Comparison {
  if (!eligible || !payIn4InRange(amountCents))
    return { available: false, reason: PAY_IN_4_UNAVAILABLE }
  const schedule = payIn4Schedule(amountCents, today)
  const option = evaluate(
    profile,
    purchases,
    today,
    missing,
    schedule.map((item, index) => ({
      id: `payin4:${index + 1}:${item.date}`,
      name: `${itemName} · Pay in 4 payment ${index + 1} of ${schedule.length}`,
      ...item,
    })),
    today,
  )
  const cushion = cushionOf(profile)
  const nearby = obligations(profile, purchases, today)
  const instalments: InstalmentDetail[] = schedule.map((item, index) => {
    // Each payment is judged until the next one, so a dip a few days after rent still shows on it.
    const until = schedule[index + 1]?.date ?? option.points.at(-1)!.date
    const stretch = option.points.filter(
      (point) =>
        point.date >= item.date &&
        (point.date < until || (!schedule[index + 1] && point.date === until)),
    )
    const low = lowestPoint(stretch)
    return {
      number: index + 1,
      date: item.date,
      amountCents: item.amountCents,
      nearestBill: nearestBill(item.date, nearby),
      balanceCents: low.minimumCents,
      lowestDate: low.date,
      belowCushion: low.minimumCents < cushion,
    }
  })
  // A dip counts against the instalments only where the plan stays above the cushion without them.
  const firstDip = option.points.find(
    (point) => point.minimumCents < cushion && point.baselineMinimumCents >= cushion,
  )
  const baselineDip = option.points.find((point) => point.baselineMinimumCents < cushion)
  return {
    ...option,
    available: true,
    illustrative: true,
    notice: PAY_IN_4_NOTICE,
    label:
      option.outcome === 'incomplete'
        ? 'Review the missing information before using this estimate.'
        : firstDip
          ? `An instalment would dip below your cushion on ${shortDay(firstDip.date)}`
          : baselineDip
            ? `Your plan dips below your cushion on ${shortDay(baselineDip.date)} even without this purchase`
            : 'Instalment scenario stays above your cushion',
    instalments,
    stacking: stackingWarning(
      activePlanPayments(profile, purchases, today),
      schedule.map((item, index) => ({
        planId: 'proposed',
        name: `${itemName} · Pay in 4 payment ${index + 1} of ${schedule.length}`,
        ...item,
        proposed: true,
      })),
    ),
  }
}

/**
 * Compares buying today, waiting and spending less over one window fixed before any search. Pay in
 * 4 is an extra comparison for the user to open; it is never recommended or ranked.
 */
export function compareOptions(
  profile: FinancialProfile,
  purchases: Purchase[],
  options: { amountCents: number; itemName?: string; today?: string; payIn4Eligible?: boolean },
): Comparison {
  const today = options.today ?? todayInTimezone(profile.timezone)
  if (!validDate(today)) throw new Error('Use a valid calendar date.')
  const { amountCents } = options
  if (!Number.isSafeInteger(amountCents) || amountCents < 0)
    throw new Error('Enter a non-negative total purchase price in cents.')
  const itemName = options.itemName?.trim() || 'Your purchase'
  const window = {
    start: today,
    end: addDays(today, COMPARISON_WINDOW_DAYS),
    days: COMPARISON_WINDOW_DAYS,
  }
  const missingFields = missingInputs(profile, purchases, today)
  const missing = missingFields.length > 0
  const buyToday = evaluate(
    profile,
    purchases,
    today,
    missing,
    fullPurchase(today, amountCents, itemName),
    today,
  )
  const waitDate = missing ? null : earliestFittingDate(profile, purchases, today, amountCents)
  const baseline = forecast(profile, purchases, { today, days: COMPARISON_WINDOW_DAYS })
  const cushion = cushionOf(profile)
  const maxPriceCents = missing
    ? 0
    : Math.max(0, Math.min(...baseline.map((point) => point.baselineMinimumCents)) - cushion)
  return {
    itemName,
    amountCents,
    today,
    window,
    profileVersion: profile.version,
    cushionCents: cushion,
    missingFields,
    buyToday,
    wait: waitDate
      ? {
          date: waitDate,
          ...evaluate(
            profile,
            purchases,
            today,
            missing,
            fullPurchase(waitDate, amountCents, itemName),
            waitDate,
          ),
        }
      : { date: null },
    spendLess: {
      maxPriceCents,
      ...evaluate(
        profile,
        purchases,
        today,
        missing,
        fullPurchase(today, maxPriceCents, itemName),
        today,
      ),
    },
    payIn4: payIn4Comparison(
      profile,
      purchases,
      today,
      missing,
      amountCents,
      itemName,
      options.payIn4Eligible === true,
    ),
    recommendation: missing
      ? null
      : buyToday.outcome === 'fits'
        ? 'buyToday'
        : waitDate
          ? 'wait'
          : 'spendLess',
    assumptions: [
      ...assumptions(profile, window.end),
      'Pay in 4 is shown for comparison only. Its schedule is illustrative, and PayPal sets the exact terms at checkout.',
    ],
  }
}

/** Plans to confirm and refunds to review. Until the user acts, each purchase keeps its cash effect. */
export function purchaseReviews(purchases: Purchase[]): PurchaseReview[] {
  const reviews: PurchaseReview[] = []
  for (const purchase of purchases) {
    if (purchase.archived || purchase.status !== 'completed') continue
    const plan = purchase.paymentPlan
    if (
      (plan?.product === 'payIn4' && plan.status === 'unconfirmed') ||
      (!plan && purchase.mode === 'sandbox')
    )
      reviews.push({
        kind: 'confirmPlan',
        purchaseId: purchase.id,
        name: purchase.name,
        amountCents: purchase.amountCents,
        title: 'Confirm your plan',
        message: `PayPal doesn’t tell Worth whether you paid in full or chose Pay in 4. Until you confirm, Worth counts the full ${money(purchase.amountCents)} as one payment today, unless your available funds already include it.`,
      })
    for (const refund of purchase.refunds ?? [])
      if (refund.status === 'review')
        reviews.push({
          kind: 'refund',
          purchaseId: purchase.id,
          refundId: refund.id,
          name: purchase.name,
          refundedCents: refund.amountCents,
          title: 'Review a refund',
          message: `The merchant refunded ${money(refund.amountCents)}. Confirm how much came back to your available funds and, for Pay in 4, which payments remain. ${REFUND_GUIDANCE} Until you confirm, your spending room doesn’t change.`,
        })
  }
  return reviews
}
