import type {
  Assessment,
  FinancialProfile,
  ForecastPoint,
  Purchase,
  ScheduledFlow,
} from './types.ts'

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

function daysBetween(from: string, to: string): number {
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
  return result.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      Number(a.flow.kind === 'income') - Number(b.flow.kind === 'income') ||
      a.flow.id.localeCompare(b.flow.id),
  )
}

function reservedPurchases(profile: FinancialProfile, purchases: Purchase[]): Purchase[] {
  const seen = new Set<string>()
  // A reconciled capture wins over an older pending copy of the same payment.
  return [...purchases]
    .sort((a, b) => Number(b.status === 'completed') - Number(a.status === 'completed'))
    .filter((purchase) => {
      if (purchase.status === 'failed' || purchase.status === 'cancelled') return false
      const identities = [
        `id:${purchase.id}`,
        ...(purchase.orderId ? [`order:${purchase.orderId}`] : []),
        ...(purchase.captureId ? [`capture:${purchase.captureId}`] : []),
      ]
      if (identities.some((key) => seen.has(key))) return false
      identities.forEach((key) => seen.add(key))
      if (purchase.status === 'completed' && profile.reflectedPurchaseIds.includes(purchase.id))
        return false
      return Number.isSafeInteger(purchase.amountCents) && purchase.amountCents >= 0
    })
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
  const reservations = reservedPurchases(profile, purchases)
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
    if (day === 0)
      for (const purchase of reservations) {
        outflow(purchase.amountCents)
        events.push({
          id: `reserved:${purchase.id}`,
          name: `${purchase.name} · ${purchase.status === 'completed' ? 'paid' : 'reserved'}`,
          amountCents: -purchase.amountCents,
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
    if (flow.cadence === 'once' && validDate(flow.nextDate) && flow.nextDate < today)
      missing.push(`Confirm whether ${flow.name} has already happened.`)
  }
  for (const purchase of purchases.filter(
    (item) => !['failed', 'cancelled'].includes(item.status),
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
    purchaseDate > addDays(today, 30)
  )
    throw new Error('Choose a purchase date within the next 30 days.')
  if (!Number.isSafeInteger(options.amountCents) || options.amountCents < 0)
    throw new Error('Enter a non-negative total purchase price in cents.')
  const horizonDays = daysBetween(today, purchaseDate) + 30
  const points = forecast(profile, purchases, {
    today,
    purchaseDate,
    amountCents: options.amountCents,
    days: horizonDays,
  })
  const lowest = points.reduce(
    (min, point) => (point.minimumCents < min.minimumCents ? point : min),
    points[0]!,
  )
  const baselineLowestCents = Math.min(...points.map((point) => point.baselineMinimumCents))
  const stressLowestCents = Math.min(...points.map((point) => point.stressMinimumCents))
  const cushion = Number.isSafeInteger(profile.cushionCents) ? Math.max(0, profile.cushionCents) : 0
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
  let earliestDate: string | null = null
  if (!missingFields.length && options.findEarliest !== false) {
    for (let day = 0; day <= 30; day++) {
      const candidate = addDays(today, day)
      const candidatePoints = forecast(profile, purchases, {
        today,
        purchaseDate: candidate,
        amountCents: options.amountCents,
        days: day + 30,
      })
      if (candidatePoints.every((point) => point.minimumCents >= cushion)) {
        earliestDate = candidate
        break
      }
    }
  }
  const drivers = getUpcomingFlows(profile, today, horizonDays).map(({ flow, date }) => ({
    name: flow.name,
    amountCents: flow.amountCents,
    date,
    kind: flow.kind,
  }))
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
    horizonEnd: addDays(purchaseDate, 30),
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
    assumptions: [
      `Available funds are a snapshot for ${profile.snapshotDate}; past transactions are not deducted again.`,
      `${money(profile.dailySpendCents)} of everyday spending is allocated each calendar day, including today; scheduled bills are separate.`,
      'Bills, purchases, and everyday spending happen before income when only a date is known.',
      'The full purchase total is reserved once. Your cushion is a threshold, not an expense.',
      `The plan runs through ${addDays(purchaseDate, 30)}, 30 days after the proposed purchase. Confirmed recurring items repeat on their schedule.`,
      'The stress scenario assumes 20% higher everyday spending; it is not a statistical confidence interval.',
      'Estimates depend on the income, bills, and outside-PayPal commitments you confirmed.',
    ],
  }
}
