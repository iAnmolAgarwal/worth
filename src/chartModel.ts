/**
 * The balance chart's words and geometry, with no DOM: each day's state against the cushion, the
 * stretches below it, the sentence for a day, and the scales. The chart draws what the engine
 * returned (each day's low, in cents) and never works money out its own way.
 */
import type { ForecastEvent, ForecastPoint } from '../shared/types'
import { dayLabel, money, shortDate, signed } from './format'

/**
 * Room between a balance and the cushion, naming the cushion so the gap never reads as a second
 * balance: "$650.52 more than your $300.00 cushion".
 */
export function cushionGap(value: number, cushion: number) {
  if (value === cushion) return `exactly your ${money(cushion)} cushion`
  return value > cushion
    ? `${money(value - cushion)} more than your ${money(cushion)} cushion`
    : `${money(cushion - value)} short of your ${money(cushion)} cushion`
}

export type DayState = 'above' | 'below' | 'negative'
/** At the cushion counts as above it, as the engine's "fits" does. */
export const dayState = (cents: number, cushionCents: number): DayState =>
  cents < 0 ? 'negative' : cents < cushionCents ? 'below' : 'above'

export const STATE_WORDS: Record<DayState, string> = {
  above: 'Above cushion',
  below: 'Below cushion',
  negative: 'Below zero',
}

/** Bills and plan payments at least this large are marked when Bills is on. */
export const BIG_BILL_CENTS = 10_000
export const isBill = (event: ForecastEvent) =>
  event.kind === 'bill' || event.kind === 'installment' || event.kind === 'subscription'
export const isPayday = (point: ForecastPoint) =>
  point.events.some((event) => event.kind === 'income')
/** Named events, income first, then the largest outflow; everyday spending is left out. */
export const namedEvents = (point: ForecastPoint) =>
  point.events
    .filter((event) => event.kind !== 'spending')
    .sort((a, b) =>
      a.kind === 'income' ? -1 : b.kind === 'income' ? 1 : a.amountCents - b.amountCents,
    )
export const bigBills = (point: ForecastPoint) =>
  point.events.filter((event) => isBill(event) && -event.amountCents >= BIG_BILL_CENTS)

/** One run of days below the cushion. */
export interface Stretch {
  from: number
  to: number
  /** The first day below zero in the run, if any. */
  negativeFrom?: number
  /** The first day back at or above the cushion; undefined when the run reaches the last day. */
  recovers?: number
}
export function stretches(values: number[], cushionCents: number): Stretch[] {
  const found: Stretch[] = []
  let open: Stretch | undefined
  values.forEach((value, index) => {
    if (value < cushionCents) {
      if (!open) found.push((open = { from: index, to: index }))
      open.to = index
      if (value < 0 && open.negativeFrom === undefined) open.negativeFrom = index
    } else if (open) {
      open.recovers = index
      open = undefined
    }
  })
  return found
}

export const lowestIndex = (values: number[]) =>
  values.reduce((low, value, index) => (value < values[low]! ? index : low), 0)

/** "Nov 19 – Nov 30", "Nov 19", or "from Nov 19" when the run reaches the end of the window. */
export function stretchDates(stretch: Stretch, points: ForecastPoint[]) {
  const from = shortDate(points[stretch.from]!.date)
  if (stretch.recovers === undefined && stretch.to > stretch.from) return `from ${from}`
  return stretch.to === stretch.from ? from : `${from} – ${shortDate(points[stretch.to]!.date)}`
}

/**
 * One line of words for a whole series: does it stay above the cushion and, if not, from when.
 * A single stretch also says when it is back above; later stretches are left to their chips.
 */
export function seriesSummary(points: ForecastPoint[], values: number[], cushionCents: number) {
  const runs = stretches(values, cushionCents)
  const low = lowestIndex(values)
  const lowest = `Lowest ${signed(values[low]!)} on ${dayLabel(points[low]!.date)}.`
  const first = runs[0]
  if (!first) return `Stays above your ${money(cushionCents)} cushion. ${lowest}`
  const negative = values.findIndex((value) => value < 0)
  const zero = negative >= 0 ? ` and below zero from ${dayLabel(points[negative]!.date)}` : ''
  const back =
    runs.length === 1 && first.recovers !== undefined
      ? ` Back above on ${dayLabel(points[first.recovers]!.date)}.`
      : ''
  return `Below your ${money(cushionCents)} cushion from ${dayLabel(points[first.from]!.date)}${zero}. ${lowest}${back}`
}

/** Where a balance sits, in words: "You are $158.78 above your cushion." */
export function positionText(cents: number, cushionCents: number) {
  if (cents < 0)
    return `You are ${money(-cents)} below zero, ${money(cushionCents - cents)} below your cushion.`
  if (cents === cushionCents) return 'You are exactly at your cushion.'
  return cents > cushionCents
    ? `You are ${money(cents - cushionCents)} above your cushion.`
    : `You are ${money(cushionCents - cents)} below your cushion.`
}

/** A payday is the window's main income; smaller money coming in is "Income". */
export function incomeKind(point: ForecastPoint, points: ForecastPoint[]) {
  const income = (day: ForecastPoint) =>
    day.events.reduce((sum, e) => sum + (e.kind === 'income' ? e.amountCents : 0), 0)
  const own = income(point)
  if (!own) return undefined
  return own * 2 >= Math.max(...points.map(income)) ? 'Payday' : 'Income'
}

function eventSentence(event: ForecastEvent, income?: 'Payday' | 'Income') {
  if (event.kind === 'income')
    return `${income ?? 'Payday'}: ${event.name} ${money(event.amountCents)} lands`
  if (event.kind === 'purchase') return `You pay ${money(-event.amountCents)} for ${event.name}`
  return event.amountCents < 0
    ? `${event.name} ${money(-event.amountCents)} goes out`
    : `${event.name} ${money(event.amountCents)} comes in`
}

/** The sentence for one day: what moves, then where that leaves the balance. */
export function daySentence(
  point: ForecastPoint,
  cents: number,
  cushionCents: number,
  income?: 'Payday' | 'Income',
) {
  const events = namedEvents(point)
  const shown = events.slice(0, 2).map((event) => eventSentence(event, income))
  if (events.length > 2) shown.push(`${events.length - 2} more`)
  const moves = shown.length ? `${shown.join('. ')}. ` : ''
  // The day's low is taken before pay arrives, so a payday's number does not include the pay.
  const beforePay = isPayday(point) ? ' The day’s low comes before the pay arrives.' : ''
  return `${moves}${positionText(cents, cushionCents)}${beforePay}`
}

export type RangeKey = 'payday' | 'month' | 'all'
export interface RangeOption {
  key: RangeKey
  label: string
  /** How many days from the start are shown. */
  days: number
}
/** To the next payday (and two days on, so its lift shows), 30 days, or the whole window. */
export function rangeOptions(points: ForecastPoint[]): RangeOption[] {
  const all: RangeOption = { key: 'all', label: `${points.length - 1} days`, days: points.length }
  const options: RangeOption[] = []
  const payday = points.findIndex((point, index) => index > 0 && isPayday(point))
  if (payday > 0 && payday + 3 < points.length)
    options.push({ key: 'payday', label: 'To payday', days: payday + 3 })
  if (points.length > 38) options.push({ key: 'month', label: '30 days', days: 31 })
  return [...options, all]
}

/** Whole-dollar steps that give at most five gridlines; zero is always in the domain. */
export function domain(values: number[], cushionCents: number) {
  const low = Math.min(0, cushionCents, ...values)
  const high = Math.max(cushionCents, ...values)
  const step =
    [50_000, 100_000, 200_000, 500_000, 1_000_000, 2_000_000, 5_000_000].find(
      (size) => Math.ceil(high / size) - Math.floor(low / size) <= 5,
    ) ?? 10_000_000
  const lo = Math.floor(low / step) * step
  const hi = Math.max(lo + step, Math.ceil(high / step) * step)
  const ticks: number[] = []
  for (let tick = lo; tick <= hi; tick += step) ticks.push(tick)
  return { lo, hi, ticks }
}

export interface Frame {
  width: number
  height: number
  plot: { x: number; y: number; w: number; h: number }
  step: number
  x: (index: number) => number
  y: (cents: number) => number
  ticks: number[]
  indexAt: (px: number) => number
}
export const NARROW_BELOW = 480
/** The plot's box inside the drawing: a lane for marker labels above, a gutter for line labels right. */
export function frame(
  width: number,
  days: number,
  values: number[],
  cushionCents: number,
  below: number,
): Frame {
  const narrow = width < NARROW_BELOW
  const left = narrow ? 36 : 44
  const right = narrow ? 58 : 96
  const top = 30
  const h = narrow ? 190 : 236
  const plot = { x: left, y: top, w: Math.max(40, width - left - right), h }
  const { lo, hi, ticks } = domain(values, cushionCents)
  const step = plot.w / days
  return {
    width,
    height: top + h + below,
    plot,
    step,
    ticks,
    x: (index) => plot.x + (index + 0.5) * step,
    y: (cents) => plot.y + plot.h - ((cents - lo) / (hi - lo)) * plot.h,
    indexAt: (px) => Math.max(0, Math.min(days - 1, Math.floor((px - plot.x) / step))),
  }
}

/** A smooth line through every day that never overshoots a day's value (monotone cubic). */
export function smoothPath(points: { x: number; y: number }[]) {
  const n = points.length
  if (!n) return ''
  const at = (value: number) => Math.round(value * 10) / 10
  if (n < 3) return `M${points.map((p) => `${at(p.x)},${at(p.y)}`).join('L')}`
  const slope = points.slice(1).map((p, i) => (p.y - points[i]!.y) / (p.x - points[i]!.x))
  const tangent = points.map((_, i) => {
    if (i === 0) return slope[0]!
    if (i === n - 1) return slope[n - 2]!
    const a = slope[i - 1]!
    const b = slope[i]!
    return a * b <= 0 ? 0 : (2 * a * b) / (a + b)
  })
  let path = `M${at(points[0]!.x)},${at(points[0]!.y)}`
  for (let i = 0; i < n - 1; i++) {
    const a = points[i]!
    const b = points[i + 1]!
    const third = (b.x - a.x) / 3
    path += `C${at(a.x + third)},${at(a.y + tangent[i]! * third)} ${at(b.x - third)},${at(b.y - tangent[i + 1]! * third)} ${at(b.x)},${at(b.y)}`
  }
  return path
}

/**
 * Where a line's name fits on the plot: just above or below its own line, on the stretch with the
 * most clear space from every other line and level. Undefined when nowhere is clear.
 */
export function lineLabelSpot(
  own: (number | undefined)[],
  others: (number | undefined)[][],
  levels: number[],
  f: Pick<Frame, 'plot' | 'step' | 'x'>,
  width: number,
) {
  const span = Math.max(1, Math.ceil(width / f.step))
  const top = f.plot.y + 2
  const bottom = f.plot.y + f.plot.h - 2
  let best: { x: number; y: number; clear: number } | undefined
  for (let start = 0; start + span < own.length; start++) {
    const ys = own.slice(start, start + span + 1)
    if (ys.some((y) => y === undefined)) continue
    // The name belongs where its line runs on its own, not where it sits on another.
    const shared = others.some((line) =>
      ys.some((y, index) => {
        const other = line[start + index]
        return other !== undefined && Math.abs(other - y!) < 6
      }),
    )
    if (shared) continue
    const high = Math.min(...(ys as number[]))
    const low = Math.max(...(ys as number[]))
    for (const base of [high - 7, low + 16]) {
      const box = { top: base - 10, bottom: base + 2 }
      if (box.top < top || box.bottom > bottom) continue
      const apart = (y: number) => (y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0)
      const near = [
        ...levels,
        ...others.flatMap((line) =>
          line.slice(start, start + span + 1).flatMap((y) => (y === undefined ? [] : [y])),
        ),
      ]
      const clear = Math.min(...near.map(apart))
      if (!best || clear > best.clear) best = { x: f.x(start), y: base, clear }
    }
  }
  return best && best.clear >= 3 ? { x: best.x, y: best.y } : undefined
}

/** Sparse date ticks: the first day, then every one, two or four weeks. */
export function dateTicks(days: number, plotWidth: number) {
  const room = Math.max(2, Math.floor(plotWidth / 84))
  const every = [7, 14, 28, 56].find((gap) => days / gap <= room) ?? 84
  const ticks: number[] = []
  for (let index = 0; index < days - 3; index += every) ticks.push(index)
  return ticks
}

/** Chart ticks are the one place money drops its cents: "$1k", "−$500". */
export function tickLabel(cents: number) {
  if (cents === 0) return '$0'
  const dollars = Math.abs(cents) / 100
  const text = dollars >= 1000 ? `${Number((dollars / 1000).toFixed(1))}k` : `${dollars}`
  return `${cents < 0 ? '−' : ''}$${text}`
}

let canvas: CanvasRenderingContext2D | null | undefined
/** Text width in px; a per-character estimate where canvas is unavailable (tests). */
export function textWidth(text: string, size = 12, weight = 700) {
  if (canvas === undefined) {
    try {
      canvas =
        typeof document !== 'undefined' && !/jsdom/i.test(navigator.userAgent)
          ? (document.createElement('canvas').getContext('2d') ?? null)
          : null
    } catch {
      canvas = null
    }
  }
  if (canvas) {
    canvas.font = `${weight} ${size}px "Figtree Variable", Figtree, "Helvetica Neue", Arial, sans-serif`
    return canvas.measureText(text).width
  }
  return text.length * size * (weight >= 600 ? 0.6 : 0.55)
}
