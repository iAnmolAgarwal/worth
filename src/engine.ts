/**
 * Small readers over engine output. They pick values the engine already computed (dates, causes,
 * amounts) and never compute money of their own.
 */
import { useEffect, useState } from 'react'
import {
  Banknote,
  CalendarCheck,
  Car,
  Dumbbell,
  GraduationCap,
  KeyRound,
  Music,
  ReceiptText,
  Repeat,
  Smartphone,
  Tv,
  Wifi,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { confirmedSchedule } from '../shared/finance'
import { nameInSentence } from '../shared/text'
import type { ForecastPoint, OptionResult, ScheduledFlow } from '../shared/types'
import { api } from './api'
import type { AppState, Comparison } from './contract'
import { dayLabel } from './format'

/** The first day the balance goes below the cushion, if it does. */
export const firstBelow = (points: ForecastPoint[], cushionCents: number) =>
  points.find((point) => point.minimumCents < cushionCents)

/** The bill that leaves on a day: the largest scheduled outflow, before everyday spending. */
export function billOn(point: ForecastPoint | undefined): string | undefined {
  if (!point) return undefined
  const outflows = point.events.filter((event) => event.amountCents < 0)
  const named = outflows
    .filter((event) => event.kind !== 'spending' && event.kind !== 'purchase')
    .sort((a, b) => a.amountCents - b.amountCents)[0]
  return named?.name
}

/** Income lands that day, after the outflows (the engine orders outflows first). */
export const paydayOn = (points: ForecastPoint[], date: string) =>
  points.find((point) => point.date === date)?.events.some((event) => event.kind === 'income') ??
  false

export const lowestPoint = (option: OptionResult) =>
  option.points.find((point) => point.date === option.lowestDate)

export const fits = (option: OptionResult) => option.outcome === 'fits'

/** Readable label for a bill name inside a sentence: "rent" from "Apartment rent" stays as is. */
export const lower = (name: string) => name.charAt(0).toLowerCase() + name.slice(1)
/** An item or bill name inside a sentence, keeping a proper name's case (shared/text.ts). */
export const lowerName = nameInSentence

const ICONS: Record<string, LucideIcon> = {
  briefcase: Banknote,
  home: KeyRound,
  car: Car,
  dumbbell: Dumbbell,
  smartphone: Smartphone,
  music: Music,
  'graduation-cap': GraduationCap,
  wifi: Wifi,
  tv: Tv,
  zap: Zap,
  laptop: CalendarCheck,
}
export function flowIcon(flow: Pick<ScheduledFlow, 'icon' | 'kind'>): LucideIcon {
  if (flow.kind === 'income') return Banknote
  if (flow.kind === 'installment') return CalendarCheck
  return (flow.icon && ICONS[flow.icon]) || (flow.kind === 'subscription' ? Repeat : ReceiptText)
}

export const kindLabel = (kind: ScheduledFlow['kind']) =>
  kind === 'income'
    ? 'Income'
    : kind === 'subscription'
      ? 'Subscription'
      : kind === 'installment'
        ? 'Payment plan'
        : 'Bill'

const WEEKDAY = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' })
export function cadenceLabel(flow: Pick<ScheduledFlow, 'cadence' | 'nextDate'>) {
  switch (flow.cadence) {
    case 'weekly':
      return `Every ${WEEKDAY(flow.nextDate)}`
    case 'biweekly':
      return `Every other ${WEEKDAY(flow.nextDate)}`
    case 'monthly':
      return 'Monthly'
    case 'yearly':
      return 'Yearly'
    default:
      return 'One time'
  }
}

/** Instalment plans in the profile, grouped: payments left and the next one. */
export interface RunningPlan {
  planId: string
  name: string
  amountCents: number
  left: number
  /** Known only for Pay in 4 (four payments). */
  total?: number
  next: string
  dates: string[]
  /** Per payment, when they differ (purchase plans). */
  amounts?: number[]
}
export function runningPlans(flows: ScheduledFlow[], today: string): RunningPlan[] {
  const groups = new Map<string, ScheduledFlow[]>()
  for (const flow of flows)
    if (flow.kind === 'installment' && flow.active && flow.nextDate >= today)
      groups.set(flow.planId ?? flow.id, [...(groups.get(flow.planId ?? flow.id) ?? []), flow])
  return [...groups.entries()].map(([planId, items]) => {
    const sorted = items.sort((a, b) => a.nextDate.localeCompare(b.nextDate))
    const payIn4 = /pay in 4/i.test(sorted[0]!.name)
    return {
      planId,
      name: sorted[0]!.name,
      amountCents: sorted[0]!.amountCents,
      left: sorted.length,
      total: payIn4 ? Math.max(4, sorted.length) : undefined,
      next: sorted[0]!.nextDate,
      dates: sorted.map((flow) => flow.nextDate),
    }
  })
}

/** Engine comparison from POST /api/compare, refreshed when the plan version changes. */
export function useComparison(
  request: {
    productId?: string
    amountCents?: number
    itemName?: string
    budgetCents?: number
  } | null,
  version: number,
) {
  const key = request ? JSON.stringify(request) : ''
  const [result, setResult] = useState<{ key: string; data?: Comparison; error?: string }>({
    key: '',
  })
  useEffect(() => {
    if (!key) return
    let cancelled = false
    api<Comparison>('/compare', JSON.parse(key))
      .then((data) => !cancelled && setResult({ key: `${key}|${version}`, data }))
      .catch(
        (error: Error) =>
          !cancelled && setResult({ key: `${key}|${version}`, error: error.message }),
      )
    return () => {
      cancelled = true
    }
  }, [key, version])
  const current = result.key === `${key}|${version}`
  return {
    comparison: current ? result.data : undefined,
    error: current ? result.error : undefined,
    loading: Boolean(key) && !current,
  }
}

export const optionTitle = (key: 'buyToday' | 'wait' | 'spendLess', c: Comparison) =>
  key === 'buyToday'
    ? 'Buy today'
    : key === 'spendLess'
      ? 'Something cheaper'
      : c.wait.date
        ? `Wait until ${dayLabel(c.wait.date)}`
        : 'Wait'

/**
 * Pay in 4 plans confirmed for Worth purchases: the payments still to come, read from the
 * engine's confirmed schedule (after any confirmed refund).
 */
export function purchasePlans(state: AppState): RunningPlan[] {
  return state.purchases.flatMap((purchase) => {
    if (purchase.archived) return []
    const schedule = confirmedSchedule(purchase)
    // Payment 1 on the purchase day was charged at checkout, so it is never "coming up".
    const upcoming =
      schedule?.filter(
        (item, index) =>
          item.date > state.today ||
          (item.date === state.today && !(index === 0 && item.date === purchase.assessmentDate)),
      ) ?? []
    if (!schedule || !upcoming.length) return []
    return [
      {
        planId: `purchase:${purchase.id}`,
        name: `${purchase.name} · Pay in 4`,
        amountCents: upcoming[0]!.amountCents,
        left: upcoming.length,
        total: Math.max(schedule.length, 4),
        next: upcoming[0]!.date,
        dates: upcoming.map((item) => item.date),
        amounts: upcoming.map((item) => item.amountCents),
      },
    ]
  })
}
/** Every instalment plan in view: the ones in the plan and the ones bought through Worth. */
export const allPlans = (state: AppState) => [
  ...runningPlans(state.profile.flows, state.today),
  ...purchasePlans(state),
]

/** Claude answers for this profile: the server's consent rule, read from state. */
export function claudeOn(state: AppState) {
  const { profile } = state
  return (
    state.config.ai === 'anthropic' &&
    (profile.aiConsent ||
      (profile.source === 'demo' && profile.userEdited === false && !profile.aiChoiceMade))
  )
}
/** The one environment label, shared by the top bar and Settings. */
export function envLabel(state: AppState) {
  const assistant =
    state.config.ai !== 'anthropic'
      ? 'Assistant not connected · Worth’s own calculations'
      : claudeOn(state)
        ? 'Assistant: powered by Claude'
        : 'Assistant off · Worth’s own calculations'
  return `${state.profile.source === 'demo' ? 'Sample data' : 'Your data'} · ${assistant} · PayPal checkout: ${
    state.config.paypal === 'sandbox' ? 'sandbox' : 'simulated'
  }`
}

/**
 * Where to fix each kind of missing input the engine reports, so a blocked answer always leads
 * to the exact screen instead of back to the start of the plan.
 */
export function missingFix(field: string): { label: string; hash: string } | undefined {
  if (/foreign-currency|amount or currency/i.test(field))
    return { label: 'Resolve in Activity', hash: 'activity?focus=fx' }
  if (/instal|pay in 4|pay later/i.test(field))
    return { label: 'Review your plans', hash: 'plan/edit?step=2' }
  if (/everyday spending/i.test(field))
    return { label: 'Review everyday spending', hash: 'plan/edit?step=0' }
  if (/before relying|amount or date for|already happened/i.test(field))
    return { label: 'Review your bills and income', hash: 'plan/edit?step=1' }
  if (/only usd/i.test(field)) return undefined
  if (/funds|cushion|payment changed|financial picture|commitments/i.test(field))
    return { label: 'Confirm your money', hash: 'plan/edit?step=0' }
  return { label: 'Review your plan', hash: 'plan/edit' }
}

/** Products bought through Worth (completed, not archived). */
export const boughtProductIds = (state: AppState) =>
  new Set(
    state.purchases
      .filter((purchase) => purchase.status === 'completed' && !purchase.archived)
      .map((purchase) => purchase.productId),
  )
