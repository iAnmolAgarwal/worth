import type { ForecastEvent, ForecastPoint, InstalmentDetail } from '../shared/types'
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from 'react'
import { X } from 'lucide-react'
import {
  bandPath,
  COMPACT_BELOW,
  dateTicks,
  eventRules,
  geometry,
  leaderEnd,
  placeLabels,
  placePopover,
  ringCandidates,
  ruleBox,
  stepPath,
  textWidth,
  type Box,
  type EventRule,
  type LabelSpec,
  type PopoverPlacement,
} from './chartLayout'
import { dayLabel, money, shortDate, signed } from './format'

export { BIG_BILL_CENTS } from './chartLayout'

/** Chart ticks are the one place money drops its cents: "$1k", "−$1k" (brief §7). */
function tick(cents: number) {
  if (cents === 0) return '$0'
  const thousands = Math.abs(cents) / 100_000
  return `${cents < 0 ? '−' : ''}$${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`
}

/** Tracks the rendered width; tests (no ResizeObserver) get a desktop-sized default. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measured = element.getBoundingClientRect().width
    if (measured > 0) setWidth(Math.round(measured))
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry!.contentRect.width)
      if (next > 0) setWidth(next)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

const isBill = (event: ForecastEvent) =>
  event.kind === 'bill' || event.kind === 'installment' || event.kind === 'subscription'
const spendingOn = (point: ForecastPoint) =>
  point.events
    .filter((event) => event.kind === 'spending')
    .reduce((sum, event) => sum + event.amountCents, 0)
const namedOn = (point: ForecastPoint) =>
  point.events
    .filter((event) => event.kind !== 'spending')
    .sort((a, b) =>
      a.kind === 'income' ? -1 : b.kind === 'income' ? 1 : a.amountCents - b.amountCents,
    )
const billTotal = (rule: EventRule) =>
  rule.events.filter(isBill).reduce((sum, event) => sum - event.amountCents, 0)
const eventText = (event: ForecastEvent) =>
  `${event.name} ${signed(event.amountCents, event.amountCents > 0)}`

function cushionText(value: number, cushion: number) {
  if (value === cushion) return 'at your cushion'
  return value > cushion
    ? `${money(value - cushion)} above your cushion`
    : `${money(cushion - value)} below your cushion`
}

type Story = { bill?: number; payday?: number }
/** A wide chart's card docks under the chart at this width, shifted toward its rule. */
const DOCK_WIDTH = 340
type Card = { rule: number; pinned: boolean }

/**
 * The balance chart for one option (§5.3), drawn as plain SVG so every label is measured and
 * placed without collisions:
 * - the daily lowest balance as a step (money moves on event days, never on a slope);
 * - a soft fill for the room above the cushion, red hatching for any dip below it;
 * - each payday and big bill as a thin rule across the plot where it moves the balance; the two
 *   behind the answer are drawn at full strength, and any rule opens a card for that day;
 * - a day-snapped scrubber for mouse, touch and keyboard, and a table alternative.
 * When the Pay in 4 comparison is open, its illustrative line and numbered instalments join it.
 */
export function BalanceChart({
  points,
  cushionCents,
  purchase,
  label,
  payIn4,
  scaleWith,
  highlight,
}: {
  points: ForecastPoint[]
  cushionCents: number
  purchase?: { date: string; amountCents: number }
  label: string
  payIn4?: { points: ForecastPoint[]; instalments: InstalmentDetail[] }
  /** Series the scale makes room for even while hidden (the closed Pay in 4 comparison). */
  scaleWith?: ForecastPoint[]
  /** The bill and payday that drive the answer are drawn at full strength. */
  highlight?: { billDate?: string; paydayDate?: string }
}) {
  const id = useId().replace(/:/g, '')
  const [wrap, width] = useWidth()
  const [active, setActive] = useState<number | null>(null)
  /** The rule whose card is showing; pinned cards stay until closed. */
  const [card, setCard] = useState<Card | null>(null)
  const [focusRule, setFocusRule] = useState(0)
  const [spoken, setSpoken] = useState('')
  const touch = useRef(false)
  /** Set while a press focuses the scrubber, so focus does not jump to the low point. */
  const pressed = useRef(false)
  const ruleButtons = useRef<(HTMLButtonElement | null)[]>([])
  const popover = useRef<HTMLDivElement>(null)
  const focusCard = useRef(false)
  const drag = useRef<{ x: number; scrubbing: boolean } | null>(null)
  const compact = width < COMPACT_BELOW
  const height = compact ? 236 : 284

  const layout = useMemo(() => {
    if (!points.length) return null
    const values = points.map((point) => point.minimumCents)
    const p4ByDate = new Map(payIn4?.points.map((point) => [point.date, point.minimumCents]))
    const p4Values = payIn4
      ? points.map((point) => p4ByDate.get(point.date) ?? point.minimumCents)
      : null
    const g = geometry(
      width,
      height,
      points.length,
      [...values, ...(p4Values ?? []), ...(scaleWith ?? []).map((point) => point.minimumCents)],
      cushionCents,
    )
    const { plot } = g
    const rules = eventRules(points, g, 12)
    const lowIndex = values.reduce((min, value, index) => (value < values[min]! ? index : min), 0)
    const low = { index: lowIndex, x: g.x(lowIndex), y: g.y(values[lowIndex]!) }
    // The story: the bill behind the low point and the payday that lifts it back.
    const at = (date?: string) => rules.findIndex((rule) => rule.date === date)
    const story: Story = {}
    if (highlight) {
      const bill = at(highlight.billDate)
      const pay = at(highlight.paydayDate)
      if (bill >= 0) story.bill = bill
      if (pay >= 0) story.payday = pay
    } else {
      const before = rules.filter((rule) => rule.index <= lowIndex)
      const lastPay = before.findLast((rule) => rule.kind === 'payday')?.index ?? -1
      const bills = before.filter((rule) => rule.kind === 'bill' && rule.index > lastPay)
      const biggest = bills.sort((a, b) => billTotal(b) - billTotal(a))[0]
      if (biggest) story.bill = rules.indexOf(biggest)
      const pay = rules.findIndex((rule) => rule.kind === 'payday' && rule.index >= lowIndex)
      if (pay >= 0) story.payday = pay
    }
    const storyRules = new Set([story.bill, story.payday].filter((i) => i !== undefined))
    const buyIndex =
      purchase && purchase.amountCents > 0
        ? points.findIndex((point) => point.date === purchase.date)
        : -1
    const dot = compact ? 6 : 7.5
    const instalments = (payIn4?.instalments ?? []).flatMap((instalment) => {
      const index = points.findIndex((point) => point.date === instalment.date)
      if (index < 0) return []
      const value = p4ByDate.get(instalment.date) ?? instalment.balanceCents
      return [{ ...instalment, index, value, x: g.x(index), y: g.y(value) }]
    })
    const obstacles: Box[] = [
      { x: low.x - 8, y: low.y - 8, w: 16, h: 16 },
      ...instalments.map((i) => ({ x: i.x - dot, y: i.y - dot, w: dot * 2, h: dot * 2 })),
      ...(buyIndex >= 0
        ? [
            { x: g.x(buyIndex) - 6, y: g.y(values[buyIndex]!) - 6, w: 12, h: 12 },
            { x: g.x(buyIndex) - 1, y: plot.y, w: 2, h: g.y(values[buyIndex]!) - plot.y },
          ]
        : []),
    ]
    // Labels may sit across a rule (they are opaque); crossing one only costs a little, more for
    // the two story rules.
    const soft = rules.flatMap((rule, i) =>
      storyRules.has(i) ? [ruleBox(rule, plot), ruleBox(rule, plot)] : [ruleBox(rule, plot)],
    )
    const specs: LabelSpec[] = []
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
    // The low point: always labelled, beside its ring, clear of the line and the story rules.
    const lowTop = `Lowest ${signed(values[lowIndex]!)}`
    const lowBottom = `${p4Low ? 'Pay in full · ' : ''}${dayLabel(points[lowIndex]!.date)}`
    const lowW = Math.ceil(Math.max(textWidth(lowTop, 12, 700), textWidth(lowBottom, 11, 500))) + 20
    const lowH = 36
    specs.push({
      id: 'low',
      w: lowW,
      h: lowH,
      required: true,
      candidates: [
        { x: low.x + 12, y: low.y + 6, cost: 0 },
        { x: low.x - lowW - 12, y: low.y + 6, cost: 1 },
        { x: low.x + 14, y: low.y - lowH / 2, cost: 3 },
        { x: low.x - lowW - 14, y: low.y - lowH / 2, cost: 3 },
        { x: low.x + 12, y: low.y - lowH - 6, cost: 4 },
        { x: low.x - lowW - 12, y: low.y - lowH - 6, cost: 4 },
        ...ringCandidates(low.x, low.y, lowW, lowH, [12, 30, 50]).map((c) => ({
          ...c,
          cost: c.cost + 8,
        })),
      ],
    })
    // The purchase, in the lane above the plot.
    const buyText =
      buyIndex >= 0
        ? `${p4Values ? 'Pay in full' : compact ? 'Buy' : `Buy ${shortDate(purchase!.date)}`} · ${signed(-purchase!.amountCents)}`
        : ''
    if (buyIndex >= 0) {
      const w = Math.ceil(textWidth(buyText, 12, 700)) + 4
      const bx = g.x(buyIndex)
      specs.push({
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
      })
    }
    const placed = placeLabels(specs, {
      g,
      values: [values, ...(p4Values ? [p4Values] : [])],
      obstacles,
      soft,
      bounds: { x: plot.x, y: 0, w: plot.w, h: plot.y + plot.h },
    })
    return {
      g,
      values,
      p4Values,
      rules,
      story,
      dot,
      low,
      lowTop,
      lowBottom,
      buyIndex,
      buyText,
      instalments,
      cy: g.y(cushionCents),
      p4Low,
      placed,
    }
  }, [points, payIn4, scaleWith, width, height, compact, cushionCents, purchase, highlight])

  // A new option or comparison closes any open card (adjusted during render, not in an effect).
  const [shownFor, setShownFor] = useState({ points, payIn4 })
  if (shownFor.points !== points || shownFor.payIn4 !== payIn4) {
    setShownFor({ points, payIn4 })
    setCard(null)
    setActive(null)
  }

  // Close a pinned card, or a touch readout, on a press anywhere else.
  useEffect(() => {
    const pinned = card?.pinned
    const touchReadout = active !== null && touch.current
    if (!pinned && !touchReadout) return
    const close = (event: globalThis.PointerEvent) => {
      const target = event.target as Node
      if (popover.current?.contains(target)) return
      if (ruleButtons.current.some((button) => button?.contains(target))) return
      if (pinned) setCard(null)
      if (touchReadout && !wrap.current?.contains(target)) setActive(null)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [card, active, wrap])

  // Wide charts: measure the card, then put it beside its rule, clear of the low point. Phones
  // always dock it under the chart.
  const [measured, setMeasured] = useState<{ key: string; at: PopoverPlacement } | null>(null)
  const cardKey = card && layout ? `${card.rule}:${width}:${layout.low.index}` : ''
  const placement: PopoverPlacement | null = !card
    ? null
    : compact
      ? { side: 'below', left: 0, top: 0 }
      : measured?.key === cardKey
        ? measured.at
        : null
  useLayoutEffect(() => {
    if (!card || !layout || compact || measured?.key === cardKey) return
    const element = popover.current
    const size = { w: element?.offsetWidth || 280, h: element?.offsetHeight || 220 }
    const lowBox = layout.placed.find((box) => box.id === 'low')
    const { low } = layout
    const at = placePopover(layout.rules[card.rule]!, size, layout.g, [
      { x: low.x - 8, y: low.y - 8, w: 16, h: 16 },
      ...(lowBox ? [lowBox] : []),
    ])
    // Measuring the rendered card is the one thing that cannot be derived during render.
    // oxlint-disable-next-line react/set-state-in-effect
    setMeasured({ key: cardKey, at })
  }, [card, layout, compact, cardKey, measured])

  // A keyboard-opened card takes focus, so Esc and Tab work from inside it; a docked card on a
  // phone scrolls into view.
  const side = placement?.side
  useEffect(() => {
    if (!card?.pinned || !side) return
    if (focusCard.current) {
      focusCard.current = false
      popover.current?.focus({ preventScroll: true })
    }
    if (side === 'below')
      popover.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [card, side])

  if (!layout) return null
  const { g, values, p4Values, rules, story, dot, low, placed } = layout
  const { plot } = g
  const below = values.some((value) => value < cushionCents)
  const p4Below = !!layout.p4Low?.below
  const isStory = (index: number) => index === story.bill || index === story.payday
  const shownRule = card ? rules[card.rule] : undefined

  const describeDay = (index: number) => {
    const point = points[index]!
    const value = values[index]!
    const parts = [
      `${dayLabel(point.date)}. Lowest ${signed(value)}, ${cushionText(value, cushionCents)}.`,
      ...namedOn(point).map((event) => `${eventText(event)}.`),
    ]
    const spending = spendingOn(point)
    if (spending) parts.push(`Everyday spending ${signed(spending)}.`)
    if (p4Values) parts.push(`With Pay in 4, lowest ${signed(p4Values[index]!)}.`)
    return parts.join(' ')
  }
  const ruleStory = (index: number) => {
    const rule = rules[index]!
    const after = points[rule.index]!.purchaseCents
    const lowValue = values[low.index]!
    if (index === story.bill) {
      const bill = rule.events.filter(isBill).sort((a, b) => a.amountCents - b.amountCents)[0]
      const payday = story.payday !== undefined ? rules[story.payday] : undefined
      const name = bill?.name ?? 'this bill'
      const beforePay = payday && payday.index >= low.index ? ', just before payday' : ''
      if (low.index === rule.index)
        return `${name} sets your lowest point: ${signed(lowValue)} that day${beforePay}.`
      return `${name} leaves ${signed(after)} at day’s end. Spending and smaller bills bring it to ${signed(lowValue)} by ${dayLabel(points[low.index]!.date)}${beforePay}.`
    }
    if (index === story.payday) {
      const lift =
        after >= cushionCents ? 'lifts you back above your cushion' : 'lifts your balance again'
      return low.index === rule.index
        ? `Your lowest point comes just before this paycheck lands. It ${lift}.`
        : `This paycheck ${lift}.`
    }
    if (after < cushionCents)
      return `You end this day ${money(cushionCents - after)} below your cushion.`
    return ''
  }
  const describeRule = (index: number) => {
    const rule = rules[index]!
    const point = points[rule.index]!
    const note = ruleStory(index)
    return `${dayLabel(rule.date)}: ${rule.events.map(eventText).join(', ')}. Balance after this day ${signed(
      point.purchaseCents,
    )}.${note ? ` ${note}` : ''}`
  }

  const moveDay = (index: number, speak: boolean) => {
    const next = Math.max(0, Math.min(points.length - 1, index))
    setActive(next)
    if (speak) setSpoken(describeDay(next))
  }
  const onDayKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = active ?? low.index
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowUp: 1,
      ArrowLeft: -1,
      ArrowDown: -1,
      PageUp: 7,
      PageDown: -7,
    }
    if (event.key in step) moveDay(from + step[event.key]!, true)
    else if (event.key === 'Home') moveDay(0, true)
    else if (event.key === 'End') moveDay(points.length - 1, true)
    else if (event.key === 'Escape' && active !== null) setActive(null)
    else return
    event.preventDefault()
  }
  /** The day under a pointer, measured against the chart frame. */
  const dayAt = (clientX: number) => {
    const box = wrap.current?.getBoundingClientRect()
    return g.indexAt(clientX - (box?.left ?? 0))
  }
  const closeCard = (refocus: boolean) => {
    const rule = card?.rule
    setCard(null)
    if (refocus && rule !== undefined) ruleButtons.current[rule]?.focus()
  }
  const onRuleKey = (event: KeyboardEvent<HTMLElement>, index: number) => {
    if (event.key === 'Escape' && card) {
      event.preventDefault()
      closeCard(true)
      return
    }
    const last = rules.length - 1
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? Math.min(last, index + 1)
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? Math.max(0, index - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null
    if (next === null) return
    event.preventDefault()
    setFocusRule(next)
    setSpoken(describeRule(next))
    ruleButtons.current[next]?.focus()
    if (card?.pinned) setCard({ rule: next, pinned: true })
  }

  const activeIndex = card ? null : active
  const tickIndices = dateTicks(points.length, compact)
  const endLabel = shortDate(points.at(-1)!.date)
  const endRoom = textWidth(endLabel, 12, 500) + 8
  // Weekly dates that neither touch each other nor the closing date.
  const pill = activeIndex === null ? null : dayLabel(points[activeIndex]!.date)
  const pillW = pill ? textWidth(pill, 12, 700) + 16 : 0
  const pillLeft = pill
    ? Math.max(2, Math.min(width - 2 - pillW, g.x(activeIndex!) - pillW / 2))
    : 0
  const underPill = (from: number, w: number) =>
    pill !== null && from < pillLeft + pillW + 4 && from + w > pillLeft - 4
  const xTicks: number[] = []
  let edge = -Infinity
  for (const index of tickIndices) {
    const w = textWidth(shortDate(points[index]!.date), 12, 500)
    const from = index === 0 ? g.x(0) : g.x(index) - w / 2
    if (from < edge + 10 || underPill(from, w)) continue
    if (g.x(points.length - 1) - (from + w) < endRoom) continue
    xTicks.push(index)
    edge = from + w
  }
  const cushionShort = money(cushionCents, cushionCents % 100 !== 0)
  // Phones tag the cushion on the y-axis. A tick that would touch the tag stays (so $0 is always
  // labelled) and the tag steps aside by a few pixels instead.
  const clash = compact ? g.ticks.find((value) => Math.abs(g.y(value) - layout.cy) < 16) : undefined
  const tagY =
    clash === undefined ? layout.cy : g.y(clash) > layout.cy ? g.y(clash) - 17 : g.y(clash) + 17
  const yTicks = g.ticks
  const lineD = stepPath(values, g)
  const bandD = bandPath(values, g, cushionCents)
  const byId = new Map(placed.map((box) => [box.id, box]))
  const lowBox = byId.get('low')
  const buyBox = byId.get('buy')
  const lowRed = values[low.index]! < cushionCents
  const popId = `${id}-pop`
  const docked = placement?.side === 'below'
  const ruleClass = (index: number) =>
    `${rules[index]!.kind}${isStory(index) ? ' story' : ''}${card?.rule === index ? ' on' : ''}`

  const ruleCard = shownRule && card && (
    <RuleCard
      ref={popover}
      id={popId}
      rule={shownRule}
      after={points[shownRule.index]!.purchaseCents}
      lowest={values[shownRule.index]!}
      note={ruleStory(card.rule)}
      story={isStory(card.rule)}
      pinned={card.pinned}
      cushionCents={cushionCents}
      placement={placement}
      caret={Math.max(14, Math.min(width - 14, shownRule.x))}
      dock={compact ? null : Math.max(0, Math.min(width - DOCK_WIDTH, shownRule.x - 48))}
      onClose={() => closeCard(true)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          closeCard(true)
        } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft')
          onRuleKey(event, card.rule)
      }}
    />
  )

  return (
    <div className="bchart">
      <div className="bchart-key" aria-hidden="true">
        <span>
          <i className="k-line" />
          {p4Values ? 'Pay in full' : 'Lowest balance each day'}
        </span>
        {p4Values && (
          <span>
            <i className="k-p4" />
            Pay in 4 · illustrative
          </span>
        )}
        <span>
          <i className="k-rule payday" />
          Payday
        </span>
        <span>
          <i className="k-rule bill" />
          Bill $100+
        </span>
        {(below || p4Below) && (
          <span>
            <i className="k-below" />
            Below cushion
          </span>
        )}
      </div>
      <div className="bchart-frame" ref={wrap} style={{ height }}>
        <svg
          className="bchart-svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={label + summary(rules)}
        >
          <defs>
            <clipPath id={`${id}-above`}>
              <rect x={0} y={0} width={width} height={layout.cy} />
            </clipPath>
            <clipPath id={`${id}-below`}>
              <rect x={0} y={layout.cy} width={width} height={height} />
            </clipPath>
            <linearGradient
              id={`${id}-fill`}
              x1="0"
              x2="0"
              y1={plot.y}
              y2={layout.cy}
              gradientUnits="userSpaceOnUse"
            >
              <stop offset="0" stopColor="#0070e0" stopOpacity={0.16} />
              <stop offset="1" stopColor="#0070e0" stopOpacity={0.03} />
            </linearGradient>
            <pattern
              id={`${id}-hatch`}
              width={6}
              height={6}
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width={6} height={6} fill="rgba(213,1,2,.06)" />
              <line
                x1={0}
                y1={0}
                x2={0}
                y2={6}
                stroke="#d50102"
                strokeOpacity={0.3}
                strokeWidth={2}
              />
            </pattern>
          </defs>

          <g className="bchart-grid">
            {g.ticks.map((value) => (
              <line
                key={value}
                x1={plot.x}
                x2={plot.x + plot.w}
                y1={g.y(value)}
                y2={g.y(value)}
                className={value === 0 ? 'zero' : undefined}
              />
            ))}
            {yTicks.map((value) => (
              <text key={value} x={plot.x - 8} y={g.y(value) + 4} textAnchor="end">
                {tick(value)}
              </text>
            ))}
            {xTicks.map((index) => (
              <text
                key={index}
                x={g.x(index)}
                y={plot.y + plot.h + 19}
                textAnchor={index === 0 ? 'start' : 'middle'}
              >
                {shortDate(points[index]!.date)}
              </text>
            ))}
            {!underPill(plot.x + plot.w - endRoom + 8, endRoom - 8) && (
              <text x={plot.x + plot.w} y={plot.y + plot.h + 19} textAnchor="end">
                {endLabel}
              </text>
            )}
          </g>

          <path d={bandD} fill={`url(#${id}-fill)`} clipPath={`url(#${id}-above)`} />
          <path d={bandD} fill={`url(#${id}-hatch)`} clipPath={`url(#${id}-below)`} />

          <g className="bchart-rules">
            {rules.map((rule, index) => (
              <line
                key={rule.date}
                className={`bchart-rule ${ruleClass(index)}`}
                x1={rule.x}
                x2={rule.x}
                y1={plot.y}
                y2={plot.y + plot.h}
              />
            ))}
          </g>

          <line
            className="bchart-cushion"
            x1={plot.x}
            x2={compact ? plot.x + plot.w : plot.x + plot.w + 6}
            y1={layout.cy}
            y2={layout.cy}
          />
          {compact ? (
            <g className="bchart-cushion-tag">
              {tagY !== layout.cy && <line x1={plot.x - 4} x2={plot.x} y1={tagY} y2={layout.cy} />}
              <rect x={2} y={tagY - 9} width={plot.x - 6} height={18} rx={9} />
              <text x={(plot.x - 4) / 2 + 1} y={tagY + 4} textAnchor="middle">
                {cushionShort}
              </text>
            </g>
          ) : (
            <text className="bchart-gutter" x={plot.x + plot.w + 10} y={layout.cy - 3}>
              <tspan className="k">Cushion</tspan>
              <tspan x={plot.x + plot.w + 10} dy={15} className="v">
                {cushionShort}
              </tspan>
            </text>
          )}

          {p4Values && <path className="bchart-p4" d={stepPath(p4Values, g)} />}
          <path
            key={`${points[0]!.date}-${values[low.index]}-${low.index}`}
            className="bchart-line draw"
            d={lineD}
            pathLength={1}
            clipPath={`url(#${id}-above)`}
          />
          <path
            key={`below-${values[low.index]}-${low.index}`}
            className="bchart-line below draw"
            d={lineD}
            pathLength={1}
            clipPath={`url(#${id}-below)`}
          />

          {shownRule && (
            <circle
              className={`bchart-hit ${shownRule.kind}`}
              cx={shownRule.x}
              cy={g.y(values[shownRule.index]!)}
              r={4.5}
            />
          )}

          {layout.buyIndex >= 0 && buyBox && (
            <g className="bchart-buy">
              <line
                x1={g.x(layout.buyIndex)}
                x2={g.x(layout.buyIndex)}
                y1={buyBox.y + buyBox.h / 2}
                y2={g.y(values[layout.buyIndex]!) - 5}
              />
              <circle cx={g.x(layout.buyIndex)} cy={g.y(values[layout.buyIndex]!)} r={4.5} />
              <text
                x={buyBox.x + (buyBox.x >= g.x(layout.buyIndex) ? 0 : buyBox.w)}
                y={buyBox.y + 13}
                textAnchor={buyBox.x >= g.x(layout.buyIndex) ? 'start' : 'end'}
              >
                {layout.buyText}
              </text>
            </g>
          )}

          {layout.instalments.map((instalment) => (
            <g
              key={instalment.number}
              className={`bchart-inst${instalment.value < cushionCents ? ' below' : ''}`}
            >
              <circle cx={instalment.x} cy={instalment.y} r={dot} />
              <text x={instalment.x} y={instalment.y + (compact ? 3 : 3.5)} textAnchor="middle">
                {instalment.number}
              </text>
            </g>
          ))}

          {layout.p4Low && (
            <circle
              className={`bchart-p4low${layout.p4Low.below ? ' below' : ''}`}
              cx={layout.p4Low.x}
              cy={layout.p4Low.y}
              r={4.5}
            />
          )}
          <circle className={`bchart-low${lowRed ? ' below' : ''}`} cx={low.x} cy={low.y} r={5.5} />
          {lowBox && (
            <g className={`bchart-lowpill${lowRed ? ' below' : ''}`}>
              {Math.hypot(leaderEnd(lowBox, low).x - low.x, leaderEnd(lowBox, low).y - low.y) >
                16 && (
                <line
                  x1={low.x}
                  y1={low.y}
                  x2={leaderEnd(lowBox, low).x}
                  y2={leaderEnd(lowBox, low).y}
                />
              )}
              <rect x={lowBox.x} y={lowBox.y} width={lowBox.w} height={lowBox.h} rx={10} />
              <text x={lowBox.x + 10} y={lowBox.y + 15} className="t">
                {layout.lowTop}
              </text>
              <text x={lowBox.x + 10} y={lowBox.y + 29} className="s">
                {layout.lowBottom}
              </text>
            </g>
          )}

          {activeIndex !== null && (
            <g className="bchart-scrub" aria-hidden="true">
              <line
                x1={g.x(activeIndex)}
                x2={g.x(activeIndex)}
                y1={plot.y - 4}
                y2={plot.y + plot.h}
              />
              {p4Values && (
                <circle
                  className="p4"
                  cx={g.x(activeIndex)}
                  cy={g.y(p4Values[activeIndex]!)}
                  r={4}
                />
              )}
              <circle
                className={values[activeIndex]! < cushionCents ? 'below' : undefined}
                cx={g.x(activeIndex)}
                cy={g.y(values[activeIndex]!)}
                r={5}
              />
              <DatePill
                x={g.x(activeIndex)}
                y={plot.y + plot.h + 5}
                text={dayLabel(points[activeIndex]!.date)}
                min={2}
                max={width - 2}
              />
            </g>
          )}
        </svg>
        <div
          className="bchart-scrubber"
          style={{ left: plot.x, top: 0, width: plot.w, height: plot.y + plot.h }}
          role="slider"
          tabIndex={0}
          aria-label="Balance by day. Use the arrow keys to move one day, Page Up and Page Down to move a week."
          aria-valuemin={0}
          aria-valuemax={points.length - 1}
          aria-valuenow={active ?? low.index}
          aria-valuetext={dayLabel(points[active ?? low.index]!.date)}
          onFocus={() => {
            if (pressed.current) pressed.current = false
            else if (active === null) moveDay(low.index, true)
          }}
          onBlur={() => setActive(null)}
          onKeyDown={onDayKey}
          onPointerDown={(event) => {
            pressed.current = true
            touch.current = event.pointerType !== 'mouse'
            if (card?.pinned) setCard(null)
            moveDay(dayAt(event.clientX), false)
          }}
          onPointerMove={(event) => {
            if (event.pointerType === 'mouse' || event.buttons) moveDay(dayAt(event.clientX), false)
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === 'mouse') setActive(null)
          }}
        />
        {rules.length > 0 && (
          <div
            className="bchart-rulebar"
            role="group"
            aria-label="Paydays and big bills. Use the arrow keys to move between them."
          >
            {rules.map((rule, index) => (
              <button
                key={rule.date}
                type="button"
                ref={(element) => {
                  ruleButtons.current[index] = element
                }}
                className={`bchart-rulehit ${ruleClass(index)}`}
                style={{
                  left: rule.hit.left,
                  width: Math.max(2, rule.hit.right - rule.hit.left),
                  top: plot.y,
                  height: plot.h,
                }}
                tabIndex={index === focusRule ? 0 : -1}
                aria-label={describeRule(index)}
                aria-expanded={card?.rule === index && card.pinned}
                aria-controls={card?.rule === index ? popId : undefined}
                onFocus={() => setFocusRule(index)}
                onKeyDown={(event) => onRuleKey(event, index)}
                onPointerEnter={(event) => {
                  if (event.pointerType === 'mouse' && !compact && !card?.pinned)
                    setCard({ rule: index, pinned: false })
                }}
                // A sideways drag that starts on a rule scrubs the days instead of opening it.
                onPointerDown={(event) => {
                  drag.current = { x: event.clientX, scrubbing: false }
                }}
                onPointerMove={(event) => {
                  const start = drag.current
                  if (!start || event.pointerType === 'mouse' || !event.buttons) return
                  if (!start.scrubbing && Math.abs(event.clientX - start.x) < 8) return
                  start.scrubbing = true
                  touch.current = true
                  if (card) setCard(null)
                  moveDay(dayAt(event.clientX), false)
                }}
                onPointerLeave={(event) => {
                  if (event.pointerType === 'mouse' && !card?.pinned) setCard(null)
                }}
                onClick={(event) => {
                  const dragged = drag.current?.scrubbing
                  drag.current = null
                  if (dragged) return
                  setActive(null)
                  if (card?.rule === index && card.pinned) {
                    setCard(null)
                    return
                  }
                  // A keyboard press (detail 0) moves focus into the card.
                  focusCard.current = event.detail === 0
                  setCard({ rule: index, pinned: true })
                }}
              />
            ))}
          </div>
        )}
        {(!docked || !card?.pinned) && ruleCard}
      </div>
      {docked && card?.pinned && ruleCard}
      <p className="sr" aria-live="polite">
        {spoken}
      </p>
      <div className="bchart-foot">
        {activeIndex === null ? (
          <p className="bchart-hint bchart-slot">
            <span className="on-touch">
              Drag across the chart to read any day. Tap a bill or payday line for details.
            </span>
            <span className="on-pointer">
              Move across the chart to read any day. Select a bill or payday line for details.
            </span>
          </p>
        ) : (
          <Readout
            point={points[activeIndex]!}
            value={values[activeIndex]!}
            p4={p4Values?.[activeIndex]}
            instalment={layout.instalments.find((instalment) => instalment.index === activeIndex)}
            cushionCents={cushionCents}
          />
        )}
      </div>
      {layout.p4Low && (
        <dl className="bchart-compare">
          {[
            { key: 'full', name: 'Pay in full', index: low.index, value: values[low.index]! },
            {
              key: 'p4',
              name: 'Pay in 4',
              index: layout.p4Low.index,
              value: p4Values![layout.p4Low.index]!,
            },
          ].map((row) => (
            <div key={row.key} className={row.value < cushionCents ? 'below' : undefined}>
              <dt>
                <i className={`k-${row.key === 'p4' ? 'p4' : 'line'}`} aria-hidden="true" />
                {row.name}
              </dt>
              <dd>
                lowest <b>{signed(row.value)}</b> on {dayLabel(points[row.index]!.date)},{' '}
                {cushionText(row.value, cushionCents)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <ChartTable
        points={points}
        values={values}
        p4={p4Values}
        cushionCents={cushionCents}
        instalments={payIn4?.instalments}
      />
    </div>
  )
}

/** The selected day on the x-axis, kept inside the chart. */
function DatePill({
  x,
  y,
  text,
  min,
  max,
}: {
  x: number
  y: number
  text: string
  min: number
  max: number
}) {
  const w = Math.ceil(textWidth(text, 12, 700)) + 16
  const left = Math.max(min, Math.min(max - w, x - w / 2))
  return (
    <g className="bchart-datepill">
      <rect x={left} y={y} width={w} height={20} rx={10} />
      <text x={left + w / 2} y={y + 14} textAnchor="middle">
        {text}
      </text>
    </g>
  )
}

function EventList({ events, spending }: { events: ForecastEvent[]; spending: number }) {
  if (!events.length && !spending) return null
  return (
    <ul className="bc-events">
      {events.map((event, index) => (
        <li key={`${event.id}-${index}`} className={event.amountCents > 0 ? 'in' : 'out'}>
          <span>{event.name}</span>
          <b>{signed(event.amountCents, event.amountCents > 0)}</b>
        </li>
      ))}
      {spending !== 0 && (
        <li className="quiet">
          <span>Everyday spending</span>
          <b>{signed(spending)}</b>
        </li>
      )}
    </ul>
  )
}

/** The scrub readout for any day, in a fixed slot under the plot so it never covers the line. */
function Readout({
  point,
  value,
  p4,
  instalment,
  cushionCents,
}: {
  point: ForecastPoint
  value: number
  p4?: number
  instalment?: InstalmentDetail
  cushionCents: number
}) {
  const named = namedOn(point)
  const spending = spendingOn(point)
  const moves = [
    ...named.map((event) => ({ text: eventText(event), income: event.amountCents > 0 })),
    ...(spending ? [{ text: `Everyday spending ${signed(spending)}`, income: false }] : []),
  ]
  return (
    <div className="bchart-readout bchart-slot" aria-hidden="true">
      <div className="r1">
        <span className="d">{dayLabel(point.date)}</span>
        <b className={value < cushionCents ? 'neg' : undefined}>{signed(value)}</b>
        <span className={`vs${value < cushionCents ? ' neg' : ''}`}>
          lowest that day · {cushionText(value, cushionCents)}
        </span>
      </div>
      <div className="r2">
        {moves.map((move, index) => (
          <span key={index} className={move.income ? 'in' : undefined}>
            {move.text}
          </span>
        ))}
        {p4 !== undefined && (
          <span className={`p4${p4 < cushionCents ? ' neg' : ''}`}>
            {instalment ? `Pay in 4 payment ${instalment.number} of 4 · ` : 'With Pay in 4 · '}
            {signed(p4)}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * What happened on a payday or bill day, opened by click, tap or Enter on its rule. It leads with
 * the day's net movement, lists each event, gives the balance after the day and one line on why
 * it matters. Wide charts float it beside the rule; phones dock it under the chart.
 */
function RuleCard({
  ref,
  id,
  rule,
  after,
  lowest,
  note,
  story,
  pinned,
  cushionCents,
  placement,
  caret,
  dock,
  onClose,
  onKeyDown,
}: {
  ref: Ref<HTMLDivElement>
  id: string
  rule: EventRule
  after: number
  lowest: number
  note: string
  story: boolean
  pinned: boolean
  cushionCents: number
  placement: PopoverPlacement | null
  caret: number
  /** Wide charts: the docked card's left offset; null on phones (full width). */
  dock: number | null
  onClose: () => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
}) {
  const income = rule.events.some((event) => event.kind === 'income')
  const net = rule.events.reduce((sum, event) => sum + event.amountCents, 0)
  const title = `${rule.kind === 'payday' ? 'Payday' : 'Bill'} · ${dayLabel(rule.date)}`
  const docked = placement?.side === 'below'
  // A hover preview overlays the space under the chart; only an opened card takes room in the page.
  const overlay = docked && !pinned
  const style = docked
    ? dock === null
      ? { ['--caret' as string]: `${caret}px` }
      : overlay
        ? { width: DOCK_WIDTH, left: dock, ['--caret' as string]: `${caret - dock}px` }
        : { width: DOCK_WIDTH, marginLeft: dock, ['--caret' as string]: `${caret - dock}px` }
    : {
        left: placement?.left ?? 0,
        top: placement?.top ?? 0,
        visibility: placement ? undefined : ('hidden' as const),
      }
  return (
    <div
      ref={ref}
      id={id}
      className={`bchart-pop ${rule.kind}${story ? ' story' : ''}${pinned ? ' pinned' : ''}${
        docked ? ' docked' : placement?.side === 'left' ? ' left' : ' right'
      }${overlay ? ' overlay' : ''}`}
      style={style}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="bc-head">
        <span className="bc-kind">{title}</span>
        {pinned && (
          <button type="button" className="bc-close" aria-label="Close" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        )}
      </div>
      <div className={`bc-net${net > 0 ? ' pos' : ''}`}>{signed(net, net > 0)}</div>
      {rule.events.length === 1 ? (
        <div className="bc-name">{rule.events[0]!.name}</div>
      ) : (
        <EventList events={rule.events} spending={0} />
      )}
      <dl className="bc-after">
        {income && lowest !== after && (
          <div>
            <dt>Lowest that day</dt>
            <dd className={lowest < cushionCents ? 'neg' : undefined}>{signed(lowest)}</dd>
          </div>
        )}
        <div>
          <dt>Balance after this day</dt>
          <dd className={after < cushionCents ? 'neg' : undefined}>{signed(after)}</dd>
        </div>
      </dl>
      {note && <p className="bc-story">{note}</p>}
    </div>
  )
}

/** The chart as a table: every day's lowest balance, how it sits against the cushion, and why. */
function ChartTable({
  points,
  values,
  p4,
  cushionCents,
  instalments,
}: {
  points: ForecastPoint[]
  values: number[]
  p4: number[] | null
  cushionCents: number
  instalments?: InstalmentDetail[]
}) {
  const spend = points[0] ? spendingOn(points[0]) : 0
  return (
    <details className="bchart-table">
      <summary>View as table</summary>
      <div
        className="bchart-scroll"
        tabIndex={0}
        role="region"
        aria-label="Balance by day, as a table"
      >
        <table>
          <caption className="sr">
            Lowest projected balance each day against your {money(cushionCents)} cushion.
            {spend ? ` Each day also includes about ${money(-spend)} of everyday spending.` : ''}
          </caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">{p4 ? 'Pay in full: lowest' : 'Lowest balance'}</th>
              <th scope="col">Against your cushion</th>
              <th scope="col">What happens</th>
              {p4 && <th scope="col">With Pay in 4</th>}
            </tr>
          </thead>
          <tbody>
            {points.map((point, index) => {
              const value = values[index]!
              const instalment = instalments?.find((i) => i.date === point.date)
              return (
                <tr key={point.date} className={value < cushionCents ? 'below' : undefined}>
                  <th scope="row">{dayLabel(point.date)}</th>
                  <td className="num">{signed(value)}</td>
                  <td>{cushionText(value, cushionCents)}</td>
                  <td>{namedOn(point).map(eventText).join(', ') || '—'}</td>
                  {p4 && (
                    <td className="num">
                      {signed(p4[index]!)}
                      {instalment ? ` · payment ${instalment.number} of 4` : ''}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </details>
  )
}

/** The rules, in words, for the chart's text alternative. */
function summary(rules: EventRule[]) {
  if (!rules.length) return ''
  const paydays = rules.filter((rule) => rule.events.some((event) => event.kind === 'income'))
  const bills = rules.flatMap((rule) =>
    rule.events
      .filter((event) => isBill(event) && -event.amountCents >= 10_000)
      .map((event) => `${event.name} ${dayLabel(rule.date)}`),
  )
  return ` Paydays: ${paydays.map((rule) => dayLabel(rule.date)).join(', ') || 'none'}. Big bills: ${
    bills.join(', ') || 'none'
  }.`
}
