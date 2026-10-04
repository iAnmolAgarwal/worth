/**
 * Pure geometry for the balance chart: scales, the step path, event marks on the line and a small
 * collision solver for the callouts. Nothing here touches the DOM, so the layout is testable.
 */
import type { ForecastEvent, ForecastPoint } from '../shared/types'

/** Bills and plan payments at least this large get a mark on the line. */
export const BIG_BILL_CENTS = 10_000

export type Box = { x: number; y: number; w: number; h: number }
export type Plot = Box

export interface Geometry {
  width: number
  height: number
  plot: Plot
  lo: number
  hi: number
  ticks: number[]
  n: number
  x: (index: number) => number
  y: (cents: number) => number
  /** The day under a horizontal position, clamped to the window. */
  indexAt: (px: number) => number
}

/** Phones get a tighter frame and no cushion gutter. */
export const COMPACT_BELOW = 480
/** Room above the plot for the purchase label. */
const TOP = 30
const BOTTOM = 28
const LEFT = 44
const GUTTER = 76

/** A nice-number domain on whole $1k steps (UX-13); wider ranges step by $2k or $5k. */
export function niceDomain(values: number[], cushion: number) {
  const low = Math.min(0, cushion, ...values)
  const high = Math.max(cushion, ...values)
  const range = high - low
  const step = range > 1_500_000 ? 500_000 : range > 600_000 ? 200_000 : 100_000
  const lo = Math.floor(low / step) * step
  const hi = Math.max(lo + step, Math.ceil(high / step) * step)
  const ticks: number[] = []
  for (let value = lo; value <= hi; value += step) ticks.push(value)
  return { lo, hi, ticks }
}

export function geometry(
  width: number,
  height: number,
  n: number,
  values: number[],
  cushion: number,
): Geometry {
  const compact = width < COMPACT_BELOW
  const { lo, hi, ticks } = niceDomain(values, cushion)
  const plot = {
    x: LEFT,
    y: TOP,
    w: Math.max(40, width - LEFT - (compact ? 10 : GUTTER)),
    h: Math.max(40, height - TOP - BOTTOM),
  }
  const last = Math.max(1, n - 1)
  // Day 0 sits a little inside the frame, so its marks clear the y labels.
  const inset = 8
  const x = (index: number) => plot.x + inset + (index / last) * (plot.w - inset)
  const y = (cents: number) => plot.y + ((hi - cents) / (hi - lo || 1)) * plot.h
  const indexAt = (px: number) =>
    Math.max(0, Math.min(n - 1, Math.round(((px - plot.x - inset) / (plot.w - inset)) * last)))
  return { width, height, plot, lo, hi, ticks, n, x, y, indexAt }
}

const r1 = (value: number) => Math.round(value * 10) / 10

/**
 * The daily lowest balance as a centred step: each day is a flat run centred on its date, and the
 * balance moves at the boundary between days. Nothing is interpolated between days.
 */
export function stepPath(values: number[], g: Pick<Geometry, 'x' | 'y'>) {
  if (!values.length) return ''
  let path = `M${r1(g.x(0))},${r1(g.y(values[0]!))}`
  for (let index = 1; index < values.length; index++) {
    const boundary = (g.x(index - 1) + g.x(index)) / 2
    path += `H${r1(boundary)}V${r1(g.y(values[index]!))}`
  }
  return `${path}H${r1(g.x(values.length - 1))}`
}

/** The area between the step line and the cushion; clip it above or below the cushion. */
export function bandPath(values: number[], g: Geometry, cushion: number) {
  if (!values.length) return ''
  return `${stepPath(values, g)}V${r1(g.y(cushion))}H${r1(g.x(0))}Z`
}

/** Weekly date ticks on wide charts, fortnightly on phones. */
export function dateTicks(n: number, compact: boolean) {
  const every = compact ? 14 : 7
  const ticks: number[] = []
  for (let index = 0; index < n; index += every) ticks.push(index)
  return ticks
}

export type RuleKind = 'payday' | 'bill'
/** A payday or big bill: a hairline rule across the plot at its date. */
export interface EventRule {
  /** Day index in the window. */
  index: number
  date: string
  x: number
  /** The larger movement that day sets the colour; the popover lists everything. */
  kind: RuleKind
  /** Named events that day (no everyday spending), income first, then largest outflow. */
  events: ForecastEvent[]
  /** The rule's hit area; neighbours split the gap, so targets never overlap. */
  hit: { left: number; right: number }
}

const isBill = (event: ForecastEvent) =>
  event.kind === 'bill' || event.kind === 'installment' || event.kind === 'subscription'

/** One rule per day with a paycheck or a bill of $100 or more. */
export function eventRules(points: ForecastPoint[], g: Geometry, maxHalf: number): EventRule[] {
  const rules: Omit<EventRule, 'hit'>[] = []
  points.forEach((point, index) => {
    const income = point.events
      .filter((event) => event.kind === 'income')
      .reduce((sum, event) => sum + event.amountCents, 0)
    const bills = point.events
      .filter((event) => isBill(event) && -event.amountCents >= BIG_BILL_CENTS)
      .reduce((sum, event) => sum - event.amountCents, 0)
    if (!income && !bills) return
    const events = point.events
      .filter((event) => event.kind !== 'spending')
      .sort((a, b) =>
        a.kind === 'income' ? -1 : b.kind === 'income' ? 1 : a.amountCents - b.amountCents,
      )
    const kind: RuleKind = income >= bills ? 'payday' : 'bill'
    // A rule sits on the edge it causes: a bill where its day begins (the drop), a paycheck
    // where its day ends (the rise, after that day's low).
    const last = points.length - 1
    const x =
      kind === 'bill'
        ? index === 0
          ? g.x(0)
          : (g.x(index - 1) + g.x(index)) / 2
        : index === last
          ? g.x(last)
          : (g.x(index) + g.x(index + 1)) / 2
    rules.push({ index, date: point.date, x, kind, events })
  })
  return rules.map((rule, i) => {
    const prev = rules[i - 1]
    const next = rules[i + 1]
    const left = Math.max(rule.x - maxHalf, prev ? (prev.x + rule.x) / 2 : g.plot.x)
    const right = Math.min(rule.x + maxHalf, next ? (rule.x + next.x) / 2 : g.plot.x + g.plot.w)
    return { ...rule, hit: { left, right } }
  })
}

/** A rule as a thin box, for label placement. */
export function ruleBox(rule: Pick<EventRule, 'x'>, plot: Plot): Box {
  return { x: rule.x - 1, y: plot.y, w: 2, h: plot.h }
}

export const overlapArea = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))

export const overlaps = (a: Box, b: Box, pad = 0) =>
  overlapArea({ x: a.x - pad, y: a.y - pad, w: a.w + pad * 2, h: a.h + pad * 2 }, b) > 0

/** Whether a segment crosses a box (Liang–Barsky clipping). */
export function segmentHitsBox(a: { x: number; y: number }, b: { x: number; y: number }, box: Box) {
  let t0 = 0
  let t1 = 1
  const dx = b.x - a.x
  const dy = b.y - a.y
  const edges: [number, number][] = [
    [-dx, a.x - box.x],
    [dx, box.x + box.w - a.x],
    [-dy, a.y - box.y],
    [dy, box.y + box.h - a.y],
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false
      continue
    }
    const t = q / p
    if (p < 0) t0 = Math.max(t0, t)
    else t1 = Math.min(t1, t)
    if (t0 > t1) return false
  }
  return t1 - t0 > 0.02
}

/** Whether the step line passes through a box (with a little air around the line). */
export function hitsLine(box: Box, values: number[], g: Geometry, pad = 3) {
  const from = Math.max(0, g.indexAt(box.x) - 1)
  const to = Math.min(values.length - 1, g.indexAt(box.x + box.w) + 1)
  for (let index = from; index <= to; index++) {
    const left = index === 0 ? g.x(0) : (g.x(index - 1) + g.x(index)) / 2
    const right = index === values.length - 1 ? g.x(index) : (g.x(index) + g.x(index + 1)) / 2
    if (right < box.x || left > box.x + box.w) continue
    const py = g.y(values[index]!)
    if (py >= box.y - pad && py <= box.y + box.h + pad) return true
    // The vertical edge into this day spans both levels.
    if (index > 0 && left >= box.x && left <= box.x + box.w) {
      const a = g.y(values[index - 1]!)
      const top = Math.min(a, py)
      const bottom = Math.max(a, py)
      if (bottom >= box.y - pad && top <= box.y + box.h + pad) return true
    }
  }
  return false
}

export interface LabelSpec {
  id: string
  w: number
  h: number
  /** Where a leader line would start; omitted for labels that sit beside their mark. */
  anchor?: { x: number; y: number }
  candidates: { x: number; y: number; cost: number; lane?: boolean }[]
  /** Required labels are always placed (at their least-bad spot); optional ones are dropped. */
  required?: boolean
  /** Labels that live above the plot (the purchase lane) are exempt from line checks. */
  lane?: boolean
}
export interface Placed extends Box {
  id: string
  anchor?: { x: number; y: number }
}

/**
 * Greedy placement in priority order. A candidate is rejected when it leaves the frame, covers
 * another label, an obstacle (marks, the low ring, Pay in 4 dots) or the line itself. Optional
 * labels with no clean spot are dropped, so labels never overlap.
 */
export function placeLabels(
  specs: LabelSpec[],
  ctx: {
    g: Geometry
    values: number[][]
    obstacles: Box[]
    /** Crossing these costs a little (quiet rules); they never block a label. */
    soft?: Box[]
    bounds: Box
  },
) {
  const placed: Placed[] = []
  for (const spec of specs) {
    let best: { box: Box; cost: number; clean: boolean } | null = null
    for (const candidate of spec.candidates) {
      const box = { x: candidate.x, y: candidate.y, w: spec.w, h: spec.h }
      const inside =
        box.x >= ctx.bounds.x &&
        box.y >= ctx.bounds.y &&
        box.x + box.w <= ctx.bounds.x + ctx.bounds.w &&
        box.y + box.h <= ctx.bounds.y + ctx.bounds.h
      const end = spec.anchor ? leaderEnd(box, spec.anchor) : null
      const leaderHits = (other: Box) =>
        !!(spec.anchor && end && segmentHitsBox(spec.anchor, end, other))
      // A placed label's own leader must not cross this box either.
      const crossesLeader = placed.some(
        (other) =>
          other.anchor && segmentHitsBox(other.anchor, leaderEnd(other, other.anchor), box),
      )
      const onLabel =
        placed.some((other) => overlaps(box, other, 3) || leaderHits(other)) || crossesLeader
      const onObstacle = ctx.obstacles.some((obstacle) => overlaps(box, obstacle, 2))
      const reach =
        spec.anchor && end ? Math.hypot(end.x - spec.anchor.x, end.y - spec.anchor.y) : 0
      const onLine =
        !(candidate.lane ?? spec.lane) && ctx.values.some((series) => hitsLine(box, series, ctx.g))
      const clean = inside && !onLabel && !onObstacle && !onLine
      const softHits = (ctx.soft ?? []).filter((obstacle) => overlaps(box, obstacle, 1)).length
      const cost =
        candidate.cost +
        reach / 4 +
        softHits * 6 +
        (inside ? 0 : 10_000) +
        (onLabel ? 5_000 : 0) +
        (onObstacle ? 2_000 : 0) +
        (onLine ? 800 : 0)
      if (!best || (clean && !best.clean) || (clean === best.clean && cost < best.cost))
        best = { box, cost, clean }
    }
    if (!best) continue
    if (!best.clean && !spec.required) continue
    placed.push({ ...best.box, id: spec.id, anchor: spec.anchor })
  }
  return placed
}

/** Candidates in a ring around a point: beside, above and below, nearest first. */
export function ringCandidates(ax: number, ay: number, w: number, h: number, gaps = [10, 24]) {
  const out: { x: number; y: number; cost: number }[] = []
  gaps.forEach((gap, step) => {
    const base = step * 20
    out.push(
      { x: ax - w / 2, y: ay - gap - h, cost: base + 0 },
      { x: ax - w * 0.25, y: ay - gap - h, cost: base + 0.5 },
      { x: ax - w * 0.75, y: ay - gap - h, cost: base + 0.5 },
      { x: ax - 12, y: ay - gap - h, cost: base + 1.5 },
      { x: ax - w + 12, y: ay - gap - h, cost: base + 1.5 },
      { x: ax + gap - 4, y: ay - gap - h + 4, cost: base + 1 },
      { x: ax - w - gap + 4, y: ay - gap - h + 4, cost: base + 1 },
      { x: ax - w / 2, y: ay + gap, cost: base + 3 },
      { x: ax + gap, y: ay + gap - 4, cost: base + 4 },
      { x: ax - w - gap, y: ay + gap - 4, cost: base + 4 },
      { x: ax + gap, y: ay - h / 2, cost: base + 5 },
      { x: ax - w - gap, y: ay - h / 2, cost: base + 5 },
    )
  })
  return out
}

/** Where the leader line meets the label: the nearest point on the box edge. */
export function leaderEnd(box: Box, anchor: { x: number; y: number }) {
  return {
    x: Math.max(box.x, Math.min(anchor.x, box.x + box.w)),
    y: Math.max(box.y, Math.min(anchor.y, box.y + box.h)),
  }
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

export type PopoverPlacement =
  { side: 'right' | 'left'; left: number; top: number } | { side: 'below'; left: 0; top: 0 }

/**
 * Where a rule's card goes on a wide chart: beside the rule, on the side with room, never over
 * the rule itself or anything in `avoid` (the low point and its label). Candidates run top,
 * middle, bottom of the plot on the preferred side, then the other side, then a short shift up
 * into the label lane. When nothing fits, the card docks under the chart.
 */
export function placePopover(
  rule: { x: number },
  card: { w: number; h: number },
  frame: { width: number; plot: Plot },
  avoid: Box[],
  gap = 12,
): PopoverPlacement {
  const { plot, width } = frame
  const right = rule.x + gap
  const left = rule.x - gap - card.w
  const roomRight = width - right - card.w
  const roomLeft = left
  const sides: ('right' | 'left')[] = roomRight >= roomLeft ? ['right', 'left'] : ['left', 'right']
  const floor = plot.y + plot.h
  const tops = [plot.y, plot.y + (plot.h - card.h) / 2, floor - card.h, Math.max(0, plot.y - 26)]
  for (const side of sides) {
    const x = side === 'right' ? right : left
    if (x < 0 || x + card.w > width) continue
    for (const top of tops) {
      if (top < 0 || top + card.h > floor + 4) continue
      const box = { x, y: top, w: card.w, h: card.h }
      if (avoid.some((other) => overlaps(box, other, 4))) continue
      return { side, left: Math.round(x), top: Math.round(top) }
    }
  }
  return { side: 'below', left: 0, top: 0 }
}
