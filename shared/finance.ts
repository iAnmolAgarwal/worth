import type {
  Assessment,
  FinancialProfile,
  ForecastPoint,
  PlanInstalment,
  Purchase,
  ScheduledFlow,
} from './types.ts'

/** Every option is judged from today through this many days ahead, fixed before any search. */
export const COMPARISON_WINDOW_DAYS = 60
/** Wait candidates run from today through this many days ahead. */
export const WAIT_SEARCH_DAYS = 30

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
 * The single cash effect of each purchase. A checkout in progress, or a completed purchase without
 * a confirmed plan, is one full-price debit today unless the funds snapshot already reflects it. A
 * confirmed Pay in 4 plan replaces that debit with its payments; payments dated before the
 * snapshot are already reflected. Confirmed refund money reduces what is still to be paid, in date
 * order, but never adds funds: a fresh funds snapshot picks that up.
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
    const refunds = completed
      ? (purchase.refunds ?? []).filter((refund) => refund.status === 'confirmed')
      : []
    const plan = completed ? purchase.paymentPlan : undefined
    const confirmedPlan =
      plan?.product === 'payIn4' && plan.status === 'confirmed'
        ? validInstalments(plan.instalments)
        : undefined
    let outflows: PurchaseOutflow[]
    if (confirmedPlan) {
      const remaining = refunds.findLast((refund) => refund.remainingInstalments)
      const schedule = validInstalments(remaining?.remainingInstalments) ?? confirmedPlan
      outflows = schedule
        .map((item, index) => ({
          id: `plan:${purchase.id}:${index + 1}`,
          purchaseId: purchase.id,
          name: `${purchase.name} · Pay in 4 payment ${index + 1} of ${schedule.length}`,
          date: item.date,
          amountCents: item.amountCents,
          planned: true,
        }))
        .filter(
          (item) =>
            item.date >= today &&
            (item.date > profile.snapshotDate ||
              (item.date === profile.snapshotDate && !reflected)),
        )
    } else
      outflows = reflected
        ? []
        : [
            {
              id: `reserved:${purchase.id}`,
              purchaseId: purchase.id,
              name: `${purchase.name} · ${completed ? 'paid' : 'reserved'}`,
              date: today,
              amountCents: purchase.amountCents,
              planned: false,
            },
          ]
    let returned = refunds.reduce(
      (total, refund) =>
        total +
        (Number.isSafeInteger(refund.returnedCents) && refund.returnedCents! > 0
          ? refund.returnedCents!
          : 0),
      0,
    )
    for (const outflow of outflows) {
      const offset = Math.min(returned, outflow.amountCents)
      outflow.amountCents -= offset
      returned -= offset
    }
    result.push(...outflows.filter((outflow) => outflow.amountCents > 0))
  }
  return result
}

export function forecast(
  profile: FinancialProfile,
  purchases: Purchase[],
  options: { today?: string; purchaseDate?: string; amountCents?: number; days?: number } = {},
): ForecastPoint[] {
  const today = options.today ?? todayInTimezone(profile.timezone)
  const purchaseDate = options.purchaseDate ?? today
  const amount = options.amountCents ?? 0
  const days = options.days ?? 30
  if (
    !validDate(purchaseDate) ||
    purchaseDate < today ||
    !Number.isSafeInteger(amount) ||
    amount < 0
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
    if (date === purchaseDate && amount > 0) {
      outflow(amount, false)
      events.push({
        id: `proposed:${date}`,
        name: 'Proposed purchase',
        amountCents: -amount,
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
