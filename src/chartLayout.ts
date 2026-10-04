/**
 * Pure geometry for the balance chart: scales, the step path, event rules and their hit columns,
 * and a small collision solver for the callouts. Nothing here touches the DOM, so the whole
 * layout (`chartModel`) is testable against real forecasts.
 */
import type { ForecastEvent, ForecastPoint, InstalmentDetail } from '../shared/types'
import { dayLabel, shortDate, signed } from './format'

/** Bills and plan payments at least this large get a rule on the chart. */
export const BIG_BILL_CENTS = 10_000
/** WCAG 2.5.8: every pointer target is at least this wide. */
export const MIN_TARGET = 24

export type Box = { x: number; y: number; w: number; h: number }
export type Plot = Box
type Point = { x: number; y: number }

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
/** Room above the plot for the label lane (the purchase and the bill behind the answer). */
const LANE = 30
const NO_LANE = 12
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
  top = LANE,
): Geometry {
  const compact = width < COMPACT_BELOW
  const { lo, hi, ticks } = niceDomain(values, cushion)
  const plot = {
    x: LEFT,
    y: top,
    w: Math.max(40, width - LEFT - (compact ? 10 : GUTTER)),
    h: Math.max(40, height - top - BOTTOM),
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

/** The step line as straight pieces (flat runs and the vertical moves between days). */
export function stepSegments(values: number[], g: Pick<Geometry, 'x' | 'y'>) {
  const out: [Point, Point][] = []
  for (let index = 0; index < values.length; index++) {
    const left = index === 0 ? g.x(0) : (g.x(index - 1) + g.x(index)) / 2
    const right = index === values.length - 1 ? g.x(index) : (g.x(index) + g.x(index + 1)) / 2
    const y = g.y(values[index]!)
    if (index > 0)
      out.push([
        { x: left, y: g.y(values[index - 1]!) },
        { x: left, y },
      ])
    out.push([
      { x: left, y },
      { x: right, y },
    ])
  }
  return out
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
  /** The larger movement that day sets the colour; the card lists everything. */
  kind: RuleKind
  /** Named events that day (no everyday spending), income first, then largest outflow. */
  events: ForecastEvent[]
}

export const isBill = (event: ForecastEvent) =>
  event.kind === 'bill' || event.kind === 'installment' || event.kind === 'subscription'

/** Named events first income, then the largest outflow. */
export const byWeight = (a: ForecastEvent, b: ForecastEvent) =>
  a.kind === 'income' ? -1 : b.kind === 'income' ? 1 : a.amountCents - b.amountCents

/** One rule per day with a paycheck or a bill of $100 or more. */
export function eventRules(points: ForecastPoint[], g: Pick<Geometry, 'x'>): EventRule[] {
  const rules: EventRule[] = []
  const last = points.length - 1
  points.forEach((point, index) => {
    const income = point.events
      .filter((event) => event.kind === 'income')
      .reduce((sum, event) => sum + event.amountCents, 0)
    const bills = point.events
      .filter((event) => isBill(event) && -event.amountCents >= BIG_BILL_CENTS)
      .reduce((sum, event) => sum - event.amountCents, 0)
    if (!income && !bills) return
    const events = point.events.filter((event) => event.kind !== 'spending').sort(byWeight)
    const kind: RuleKind = income >= bills ? 'payday' : 'bill'
    // A rule sits on the edge it causes: a bill where its day begins (the drop), a paycheck
    // where its day ends (the rise, after that day's low).
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
  return rules
}

/**
 * A pointer target over one or more rules. Rules closer than `MIN_TARGET` share one target (and
 * one card with a day chooser), so every target is at least 24 px wide and none overlap.
 */
export interface HitTarget {
  /** Rule indices, left to right. */
  rules: number[]
  /** The rule its card opens on: a story rule if it holds one, else the largest movement. */
  primary: number
  left: number
  right: number
}

const netOf = (rule: EventRule) =>
  Math.abs(rule.events.reduce((sum, event) => sum + event.amountCents, 0))

export function hitTargets(
  rules: EventRule[],
  bounds: { left: number; right: number },
  storyRules: number[] = [],
  min = MIN_TARGET,
): HitTarget[] {
  const half = min / 2
  const groups: number[][] = []
  rules.forEach((rule, index) => {
    const group = groups.at(-1)
    if (group && rule.x - rules[group.at(-1)!]!.x < min) group.push(index)
    else groups.push([index])
  })
  return groups.map((group, i) => {
    const first = rules[group[0]!]!.x
    const last = rules[group.at(-1)!]!.x
    const prev = groups[i - 1]
    const next = groups[i + 1]
    const prevX = prev ? rules[prev.at(-1)!]!.x : -Infinity
    const nextX = next ? rules[next[0]!]!.x : Infinity
    // Neighbours are at least `min` apart, so splitting the gap leaves each side half a target.
    let left = Math.max(first - half, (prevX + first) / 2, bounds.left)
    let right = Math.min(last + half, (last + nextX) / 2, bounds.right)
    if (right - left < min) {
      // Only at the frame's edges: grow inward, into the half-gap the neighbour does not use.
      if (left === bounds.left) right = Math.min(left + min, (last + nextX) / 2)
      else left = Math.max(right - min, (prevX + first) / 2)
    }
    const story = storyRules.find((index) => group.includes(index))
    const primary =
      story ??
      group.reduce((best, index) => (netOf(rules[index]!) > netOf(rules[best]!) ? index : best))
    return { rules: group, primary, left, right }
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
export function segmentHitsBox(a: Point, b: Point, box: Box) {
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

const cross = (o: Point, a: Point, b: Point) =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
/** Whether two segments touch or cross. */
export function segmentsCross(a: Point, b: Point, c: Point, d: Point) {
  const d1 = cross(c, d, a)
  const d2 = cross(c, d, b)
  const d3 = cross(a, b, c)
  const d4 = cross(a, b, d)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))
    return true
  const on = (p: Point, q: Point, r: Point) =>
    Math.min(p.x, q.x) - 0.01 <= r.x &&
    r.x <= Math.max(p.x, q.x) + 0.01 &&
    Math.min(p.y, q.y) - 0.01 <= r.y &&
    r.y <= Math.max(p.y, q.y) + 0.01
  return (
    (d1 === 0 && on(c, d, a)) ||
    (d2 === 0 && on(c, d, b)) ||
    (d3 === 0 && on(a, b, c)) ||
    (d4 === 0 && on(a, b, d))
  )
}

/** Whether the step line passes through a box (with a little air around the line). */
export function hitsLine(box: Box, values: number[], g: Geometry, pad = 3) {
  const from = Math.max(0, g.indexAt(box.x) - 1)
  const to = Math.min(values.length - 1, g.indexAt(box.x + box.w) + 1)
  for (let index = from; index <= to; index++) {
    const left = index === 0 ? g.x(0) : (g.x(index - 1) + g.x(index)) / 2
    const right = index === values.length - 1 ? g.x(index) : (g.x(index) + g.x(index + 1)) / 2
    if (right < box.x - pad || left > box.x + box.w + pad) continue
    const py = g.y(values[index]!)
    if (py >= box.y - pad && py <= box.y + box.h + pad) return true
    // The vertical edge into this day spans both levels.
    if (index > 0 && left >= box.x - pad && left <= box.x + box.w + pad) {
      const a = g.y(values[index - 1]!)
      const top = Math.min(a, py)
      const bottom = Math.max(a, py)
      if (bottom >= box.y - pad && top <= box.y + box.h + pad) return true
    }
  }
  return false
}

/** Whether a leader from `anchor` (a mark on the line) crosses the line once clear of its mark. */
export function leaderHitsLine(anchor: Point, end: Point, values: number[], g: Geometry, skip = 9) {
  const length = Math.hypot(end.x - anchor.x, end.y - anchor.y)
  if (length <= skip) return false
  const start = {
    x: anchor.x + ((end.x - anchor.x) * skip) / length,
    y: anchor.y + ((end.y - anchor.y) * skip) / length,
  }
  const lo = Math.min(start.x, end.x) - 1
  const hi = Math.max(start.x, end.x) + 1
  return stepSegments(values, g).some(
    ([a, b]) =>
      Math.max(a.x, b.x) >= lo && Math.min(a.x, b.x) <= hi && segmentsCross(start, end, a, b),
  )
}

/** Leaders shorter than this are not drawn; the label sits beside its mark. */
export const LEADER_MIN = 16

export interface LabelSpec {
  id: string
  w: number
  h: number
  /** Where a leader line would start; omitted for labels that sit beside their mark. */
  anchor?: Point
  candidates: { x: number; y: number; cost: number; lane?: boolean }[]
  /** Required labels are always placed (at their least-bad spot); optional ones are dropped. */
  required?: boolean
  /** Labels that live above the plot (the label lane) are exempt from line checks. */
  lane?: boolean
}
export interface Placed extends Box {
  id: string
  anchor?: Point
}

/**
 * Greedy placement in priority order. A candidate is rejected when it leaves the frame, covers
 * another label, an obstacle (marks, the story rules, the low ring, Pay in 4 dots) or the line
 * itself, or when its leader would cross the line. Optional labels with no clean spot are
 * dropped, so labels never overlap.
 */
export function placeLabels(
  specs: LabelSpec[],
  ctx: {
    g: Geometry
    values: number[][]
    obstacles: Box[]
    /** Crossing these costs a little (quiet rules: 6 each, or their own cost); they never block. */
    soft?: (Box & { cost?: number })[]
    /** Series that may be crossed at a high cost (the illustrative Pay in 4 line, as a fallback). */
    softValues?: number[][]
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
      const reach =
        spec.anchor && end ? Math.hypot(end.x - spec.anchor.x, end.y - spec.anchor.y) : 0
      const drawn = reach > LEADER_MIN
      const leaderHits = (other: Box) =>
        !!(spec.anchor && end && drawn && segmentHitsBox(spec.anchor, end, other))
      // A placed label's own leader must not cross this box either.
      const crossesLeader = placed.some((other) => {
        if (!other.anchor) return false
        const otherEnd = leaderEnd(other, other.anchor)
        return (
          Math.hypot(otherEnd.x - other.anchor.x, otherEnd.y - other.anchor.y) > LEADER_MIN &&
          segmentHitsBox(other.anchor, otherEnd, box)
        )
      })
      const onLabel =
        placed.some((other) => overlaps(box, other, 3) || leaderHits(other)) || crossesLeader
      const onObstacle = ctx.obstacles.some((obstacle) => overlaps(box, obstacle, 2))
      const lane = candidate.lane ?? spec.lane
      const onLine =
        !lane &&
        ctx.values.some(
          (series) =>
            hitsLine(box, series, ctx.g) ||
            (drawn && !!spec.anchor && !!end && leaderHitsLine(spec.anchor, end, series, ctx.g)),
        )
      const clean = inside && !onLabel && !onObstacle && !onLine
      const softHits = (ctx.soft ?? [])
        .filter((obstacle) => overlaps(box, obstacle, 1))
        .reduce((sum, obstacle) => sum + (obstacle.cost ?? 6), 0)
      const softLine =
        !lane && (ctx.softValues ?? []).some((series) => hitsLine(box, series, ctx.g)) ? 200 : 0
      const cost =
        candidate.cost +
        reach / 4 +
        softHits +
        softLine +
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

/**
 * Where the low-point pill may go: right beside its ring first, then a widening sweep on both
 * sides over the plot's full height, for a pill on a leader when the nearby space is taken by the
 * line or a story rule.
 */
export function lowCandidates(low: Point, w: number, h: number, plot: Plot) {
  const near = [
    { x: low.x + 12, y: low.y + 6, cost: 0 },
    { x: low.x - w - 12, y: low.y + 6, cost: 1 },
    { x: low.x + 14, y: low.y - h / 2, cost: 3 },
    { x: low.x - w - 14, y: low.y - h / 2, cost: 3 },
    { x: low.x + 12, y: low.y - h - 6, cost: 4 },
    { x: low.x - w - 12, y: low.y - h - 6, cost: 4 },
  ]
  const ring = ringCandidates(low.x, low.y, w, h, [12, 30, 50]).map((c) => ({
    ...c,
    cost: c.cost + 8,
  }))
  const far: { x: number; y: number; cost: number }[] = []
  const ys: number[] = []
  for (let y = plot.y + 2; y <= plot.y + plot.h - h; y += 6) ys.push(y)
  for (const dx of [24, 44, 64, 90, 120, 160, 210, 270])
    for (const y of ys)
      for (const side of [1, -1])
        far.push({
          x: side > 0 ? low.x + dx : low.x - w - dx,
          y,
          cost: 30 + dx / 6 + Math.abs(y + h / 2 - low.y) / 6 + (side < 0 ? 1 : 0),
        })
  return [...near, ...ring, ...far]
}

/** Where the leader line meets the label: the nearest point on the box edge. */
export function leaderEnd(box: Box, anchor: Point) {
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

/** A docked card's left edge: under its rule, shifted toward it, inside the frame. */
export function dockLeft(ruleX: number, width: number, cardW: number) {
  return Math.round(Math.max(0, Math.min(width - cardW, ruleX - 48)))
}

export interface ChartInput {
  points: ForecastPoint[]
  cushionCents: number
  width: number
  purchase?: { date: string; amountCents: number }
  payIn4?: { points: ForecastPoint[]; instalments: InstalmentDetail[] }
  /** Series the scale makes room for even while hidden (the closed Pay in 4 comparison). */
  scaleWith?: ForecastPoint[]
  /** The bill and payday that drive the answer; found from the low point when omitted. */
  highlight?: { billDate?: string; paydayDate?: string }
}
export type Story = { bill?: number; payday?: number }

/** The story: the bill behind the low point and the payday that lifts it back. */
export function storyRules(
  rules: EventRule[],
  lowIndex: number,
  highlight?: ChartInput['highlight'],
): Story {
  const at = (date?: string) => rules.findIndex((rule) => rule.date === date)
  const story: Story = {}
  if (highlight) {
    const bill = at(highlight.billDate)
    const pay = at(highlight.paydayDate)
    if (bill >= 0) story.bill = bill
    if (pay >= 0) story.payday = pay
    return story
  }
  // The low is the pre-paycheck minimum, so a payday on the low day comes after it: the bill
  // behind the low is the largest one since the last payday strictly before that day.
  const lastPay =
    rules.findLast((rule) => rule.kind === 'payday' && rule.index < lowIndex)?.index ?? -1
  const bills = rules.filter(
    (rule) => rule.kind === 'bill' && rule.index > lastPay && rule.index <= lowIndex,
  )
  const total = (rule: EventRule) =>
    rule.events.filter(isBill).reduce((sum, event) => sum - event.amountCents, 0)
  const biggest = bills.sort((a, b) => total(b) - total(a))[0]
  if (biggest) story.bill = rules.indexOf(biggest)
  const pay = rules.findIndex((rule) => rule.kind === 'payday' && rule.index >= lowIndex)
  if (pay >= 0) story.payday = pay
  return story
}

/** The story bill's lane caption: its largest bill, named, with the day's bill total. */
export function storyCaption(rule: EventRule) {
  const bills = rule.events.filter(isBill)
  const total = bills.reduce((sum, event) => sum + event.amountCents, 0)
  return `${bills[0]?.name ?? 'Bill'} ${signed(total)}`
}

/**
 * Everything the chart draws, from the data and the frame width: scales, rules and their hit
 * columns, the story, Pay in 4 marks and the placed labels.
 */
export function chartModel(input: ChartInput) {
  const { points, cushionCents, width, purchase, payIn4, scaleWith, highlight } = input
  if (!points.length) return null
  const compact = width < COMPACT_BELOW
  const values = points.map((point) => point.minimumCents)
  const p4ByDate = new Map(payIn4?.points.map((point) => [point.date, point.minimumCents]))
  const p4Values = payIn4
    ? points.map((point) => p4ByDate.get(point.date) ?? point.minimumCents)
    : null
  const scaleValues = [
    ...values,
    ...(p4Values ?? []),
    ...(scaleWith ?? []).map((point) => point.minimumCents),
  ]
  const buyIndex =
    purchase && purchase.amountCents > 0
      ? points.findIndex((point) => point.date === purchase.date)
      : -1
  const lowIndex = values.reduce((min, value, index) => (value < values[min]! ? index : min), 0)
  // The story only needs the rule order, which the width does not change.
  const story = storyRules(eventRules(points, { x: (index) => index }), lowIndex, highlight)
  // The label lane above the plot only takes room when it has something to say.
  const lane = buyIndex >= 0 || story.bill !== undefined
  const base = compact ? 236 : 284
  const height = lane ? base : base - (LANE - NO_LANE)
  const g = geometry(width, height, points.length, scaleValues, cushionCents, lane ? LANE : NO_LANE)
  const { plot } = g
  const rules = eventRules(points, g)
  const storySet = [story.bill, story.payday].filter((i): i is number => i !== undefined)
  const targets = hitTargets(rules, { left: 0, right: width + 8 }, storySet)
  const low = { index: lowIndex, x: g.x(lowIndex), y: g.y(values[lowIndex]!) }
  const dot = compact ? 6 : 7.5
  const instalments = (payIn4?.instalments ?? []).flatMap((instalment) => {
    const index = points.findIndex((point) => point.date === instalment.date)
    if (index < 0) return []
    const value = p4ByDate.get(instalment.date) ?? instalment.balanceCents
    return [{ ...instalment, index, value, x: g.x(index), y: g.y(value) }]
  })
  const obstacles: Box[] = [
    { x: low.x - 8, y: low.y - 8, w: 16, h: 16 },
    // The two rules that tell the story are never covered.
    ...storySet.map((index) => ruleBox(rules[index]!, plot)),
    ...instalments.map((i) => ({ x: i.x - dot, y: i.y - dot, w: dot * 2, h: dot * 2 })),
    ...(buyIndex >= 0
      ? [{ x: g.x(buyIndex) - 6, y: g.y(values[buyIndex]!) - 6, w: 12, h: 12 }]
      : []),
  ]
  /** The purchase's dotted line, from its lane label down to its marker. */
  const buyLine: Box[] =
    buyIndex >= 0 ? [{ x: g.x(buyIndex) - 1, y: 0, w: 2, h: g.y(values[buyIndex]!) }] : []
  if (!compact) {
    const cy = g.y(cushionCents)
    obstacles.push({ x: plot.x + plot.w, y: cy - 16, w: width - plot.x - plot.w, h: 34 })
  }
  // Labels may sit across a quiet rule (they are opaque); crossing one only costs a little.
  const soft = rules.filter((_, i) => !storySet.includes(i)).map((rule) => ruleBox(rule, plot))
  // Pay in 4 gets its own low point, so each scenario states its minimum.
  let p4Low: { index: number; x: number; y: number; below: boolean } | null = null
  if (p4Values) {
    const index = p4Values.reduce((min, value, i) => (value < p4Values[min]! ? i : min), 0)
    p4Low = {
      index,
      x: g.x(index),
      y: g.y(p4Values[index]!),
      below: p4Values[index]! < cushionCents,
    }
    obstacles.push({ x: p4Low.x - 6, y: p4Low.y - 6, w: 12, h: 12 })
  }
  const bounds = {
    x: plot.x,
    y: 0,
    // Wide charts may use the empty right gutter too, clear of its cushion label.
    w: compact ? plot.w : width - plot.x - 4,
    h: plot.y + plot.h,
  }
  const ctx = {
    g,
    values: [values, ...(p4Values ? [p4Values] : [])],
    obstacles: [...obstacles, ...buyLine],
    soft,
    bounds,
  }
  /** Only when nothing is clean: the purchase line and the Pay in 4 line become costly, not hard. */
  const lenient = {
    g,
    values: [values],
    softValues: p4Values ? [p4Values] : [],
    obstacles,
    soft: [...soft, ...buyLine.map((box) => ({ ...box, cost: 120 }))],
    bounds,
  }
  // The low point: always labelled, clear of the line, the story rules and every mark. When the
  // two-line pill has no clean spot (a phone with both Pay in 4 lines), it drops to one line; the
  // date is in the comparison rows and the readout.
  const lowTop = `Lowest ${signed(values[lowIndex]!)}`
  const lowSpec = (bottom: string): LabelSpec => {
    const w =
      Math.ceil(Math.max(textWidth(lowTop, 12, 700), bottom ? textWidth(bottom, 11, 500) : 0)) + 20
    const h = bottom ? 36 : 22
    return {
      id: 'low',
      w,
      h,
      required: true,
      anchor: { x: low.x, y: low.y },
      candidates: lowCandidates(low, w, h, plot),
    }
  }
  const date = dayLabel(points[lowIndex]!.date)
  const tries = [
    { bottom: date, ctx },
    { bottom: '', ctx },
    { bottom: date, ctx: lenient },
    { bottom: '', ctx: lenient },
  ]
  const fit =
    tries.find(
      (attempt) =>
        placeLabels([{ ...lowSpec(attempt.bottom), required: false }], attempt.ctx).length,
    ) ?? tries[0]!
  const lowBottom = fit.bottom
  const lowPlaced = placeLabels([lowSpec(lowBottom)], fit.ctx)
  // The purchase, in the lane above the plot.
  const buySpec = (text: string): LabelSpec => {
    const w = Math.ceil(textWidth(text, 12, 700)) + 4
    const bx = g.x(buyIndex)
    return {
      id: 'buy',
      w,
      h: 18,
      required: true,
      lane: true,
      candidates: [
        { x: bx + 6, y: 4, cost: 0 },
        { x: bx - w - 6, y: 4, cost: 1 },
        { x: bx - w / 2, y: 4, cost: 2 },
      ],
    }
  }
  const amount = buyIndex >= 0 ? signed(-purchase!.amountCents) : ''
  const shortBuy = buyIndex >= 0 ? `${p4Values ? 'Pay in full' : 'Buy'} · ${amount}` : ''
  const longBuy =
    buyIndex >= 0 && !p4Values && !compact
      ? `Buy ${shortDate(purchase!.date)} · ${amount}`
      : shortBuy
  // The bill behind the answer, named in the lane on its own rule, when there is room.
  const storyText = story.bill !== undefined ? storyCaption(rules[story.bill]!) : ''
  const storySpec = (): LabelSpec => {
    const w = Math.ceil(textWidth(storyText, 12, 700)) + 4
    const sx = rules[story.bill!]!.x
    return {
      id: 'story',
      w,
      h: 18,
      lane: true,
      candidates: [
        { x: sx + 5, y: 4, cost: 0 },
        { x: sx - w - 5, y: 4, cost: 1 },
      ],
    }
  }
  // The lane labels go around the placed low pill (and its leader).
  const solve = (buyText: string) => [
    ...lowPlaced,
    ...placeLabels(
      [
        ...lowPlaced.map((box) => ({
          id: box.id,
          w: box.w,
          h: box.h,
          anchor: box.anchor,
          required: true,
          lane: true,
          candidates: [{ x: box.x, y: box.y, cost: 0 }],
        })),
        ...(buyIndex >= 0 ? [buySpec(buyText)] : []),
        ...(story.bill !== undefined ? [storySpec()] : []),
      ],
      ctx,
    ).filter((box) => box.id !== 'low'),
  ]
  const hasStory = (labels: Placed[]) => labels.some((box) => box.id === 'story')
  // A purchase's date is on the axis under its marker; drop it to make room for the bill's name.
  let buyText = longBuy
  let placed = solve(longBuy)
  if (story.bill !== undefined && longBuy !== shortBuy && !hasStory(placed)) {
    const retry = solve(shortBuy)
    if (hasStory(retry)) {
      placed = retry
      buyText = shortBuy
    }
  }
  return {
    g,
    height,
    compact,
    values,
    p4Values,
    rules,
    targets,
    story,
    dot,
    low,
    lowTop,
    lowBottom,
    buyIndex,
    buyText,
    storyText,
    instalments,
    cy: g.y(cushionCents),
    p4Low,
    obstacles,
    buyLine,
    placed,
  }
}
export type ChartModel = NonNullable<ReturnType<typeof chartModel>>
