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
  BIG_BILL_CENTS,
  byWeight,
  chartModel,
  cushionGap,
  dateTicks,
  dockLeft,
  isBill,
  LEADER_MIN,
  leaderEnd,
  stepPath,
  textWidth,
  type ChartInput,
  type EventRule,
} from './chartLayout'
import { lower } from './engine'
import { dayLabel, money, shortDate, signed } from './format'

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

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const spendingOn = (point: ForecastPoint) =>
  point.events
    .filter((event) => event.kind === 'spending')
    .reduce((sum, event) => sum + event.amountCents, 0)
const namedOn = (point: ForecastPoint) =>
  point.events.filter((event) => event.kind !== 'spending').sort(byWeight)
const netOf = (rule: EventRule) => rule.events.reduce((sum, event) => sum + event.amountCents, 0)
const eventText = (event: ForecastEvent) =>
  `${event.name} ${signed(event.amountCents, event.amountCents > 0)}`
const joinAnd = (items: string[]) =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

/** On wide charts the day card docks under the plot at this width, shifted toward its rule. */
const DOCK_WIDTH = 340

/**
 * The balance chart for one option (§5.3), drawn as plain SVG so every label is measured and
 * placed without collisions:
 * - the daily lowest balance as a step (money moves on event days, never on a slope);
 * - a soft fill for the room above the cushion, red hatching for any dip below it;
 * - each payday and big bill as a thin rule across the plot where it moves the balance; the two
 *   behind the answer are drawn at full strength, and any rule opens a card for that day, docked
 *   under the plot so it never covers the balance it explains;
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
  fullName = 'Pay in full',
}: Omit<ChartInput, 'width'> & {
  label: string
  /** With Pay in 4 open: what the plain line means, such as "Pay in full on Oct 23". */
  fullName?: string
}) {
  const id = useId().replace(/:/g, '')
  const [wrap, width] = useWidth()
  const [active, setActive] = useState<number | null>(null)
  /** The rule whose card is open. */
  const [open, setOpen] = useState<number | null>(null)
  /** The target under the mouse; its summary takes the readout slot. */
  const [peek, setPeek] = useState<number | null>(null)
  const [focusTarget, setFocusTarget] = useState(0)
  const [spoken, setSpoken] = useState('')
  const touch = useRef(false)
  /** Set while a press focuses the scrubber, so focus does not jump to the low point. */
  const pressed = useRef(false)
  const targetButtons = useRef<(HTMLButtonElement | null)[]>([])
  const popover = useRef<HTMLDivElement>(null)
  const focusCard = useRef(false)
  const drag = useRef<{ x: number; scrubbing: boolean } | null>(null)

  const layout = useMemo(
    () => chartModel({ points, cushionCents, width, purchase, payIn4, scaleWith, highlight }),
    [points, cushionCents, width, purchase, payIn4, scaleWith, highlight],
  )

  // A new option or comparison closes any open card (adjusted during render, not in an effect).
  const [shownFor, setShownFor] = useState({ points, payIn4 })
  if (shownFor.points !== points || shownFor.payIn4 !== payIn4) {
    setShownFor({ points, payIn4 })
    setOpen(null)
    setPeek(null)
    setActive(null)
  }

  // Close an open card, or a touch readout, on a press anywhere else.
  useEffect(() => {
    const touchReadout = active !== null && touch.current
    if (open === null && !touchReadout) return
    const close = (event: globalThis.PointerEvent) => {
      const target = event.target as Node
      if (popover.current?.contains(target)) return
      if (targetButtons.current.some((button) => button?.contains(target))) return
      if (open !== null) setOpen(null)
      if (touchReadout && !wrap.current?.contains(target)) setActive(null)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open, active, wrap])

  // A keyboard-opened card takes focus, so Esc and Tab work from inside it. The docked card
  // scrolls into view if the plot pushed it below the fold.
  const isOpen = open !== null
  useEffect(() => {
    if (!isOpen) return
    if (focusCard.current) {
      focusCard.current = false
      popover.current?.focus({ preventScroll: true })
    }
    popover.current?.scrollIntoView?.({
      block: 'nearest',
      behavior: reducedMotion() ? 'auto' : 'smooth',
    })
  }, [isOpen])

  if (!layout) return null
  const { g, height, compact, values, p4Values, rules, targets, story, dot, low, placed } = layout
  const { plot } = g
  const below = values.some((value) => value < cushionCents)
  const p4Below = !!layout.p4Low?.below
  const isStory = (index: number) => index === story.bill || index === story.payday
  /** With Pay in 4 open: which line's lowest point falls on this day, in words, or ''. */
  const lowsOn = (index: number) => {
    const full = index === low.index
    const p4 = !!p4Values && index === layout.p4Low?.index
    if (!p4Values) return ''
    if (full && p4) return 'Lowest point of both lines'
    return full ? `Lowest point, ${lower(fullName)}` : p4 ? 'Lowest point with Pay in 4' : ''
  }
  const targetOf = (rule: number) => targets.findIndex((target) => target.rules.includes(rule))
  const openTarget = open === null ? -1 : targetOf(open)
  const shownRule =
    open !== null ? rules[open] : peek !== null ? rules[targets[peek]!.primary] : undefined
  const hot = new Set([
    ...(open !== null ? [open] : []),
    ...(peek !== null ? targets[peek]!.rules : []),
  ])

  const describeDay = (index: number) => {
    const point = points[index]!
    const value = values[index]!
    const parts = [
      `${dayLabel(point.date)}. Day’s low ${signed(value)}${value < cushionCents ? ', below your cushion' : ''}.`,
      ...namedOn(point).map((event) => `${eventText(event)}.`),
    ]
    const spending = spendingOn(point)
    if (spending) parts.push(`Everyday spending ${signed(spending)}.`)
    if (p4Values) parts.push(`With Pay in 4, day’s low ${signed(p4Values[index]!)}.`)
    const lows = lowsOn(index)
    if (lows) parts.push(`${lows}.`)
    return parts.join(' ')
  }
  const ruleStory = (index: number) => {
    const rule = rules[index]!
    const after = points[rule.index]!.purchaseCents
    const lowValue = values[low.index]!
    if (index === story.bill) {
      const bill = rule.events.filter(isBill).sort(byWeight)[0]
      const payday = story.payday !== undefined ? rules[story.payday] : undefined
      const name = bill?.name ?? 'This bill'
      const beforePay = payday && payday.index >= low.index ? ', just before payday' : ''
      if (low.index === rule.index)
        return `${name} sets your lowest point: ${signed(lowValue)} that day${beforePay}.`
      // Name the big bills between this one and the low, so the sentence matches the lines.
      const between = points
        .slice(rule.index + 1, low.index + 1)
        .flatMap((point) => point.events.filter(isBill))
      const big = between.filter((event) => -event.amountCents >= BIG_BILL_CENTS)
      const parts = [
        ...big.map((event) => `your ${lower(event.name)} (${signed(event.amountCents)})`),
        ...(between.length > big.length ? ['smaller bills'] : []),
      ]
      const by = `${signed(lowValue)} by ${dayLabel(points[low.index]!.date)}${beforePay}`
      const then = !parts.length
        ? `Everyday spending brings it to ${by}`
        : parts.length === 1
          ? `Spending and ${parts[0]} bring it to ${by}`
          : `Spending, ${joinAnd(parts)} bring it to ${by}`
      return `${name} leaves ${signed(after)} at day’s end. ${then}.`
    }
    if (index === story.payday) {
      const lift =
        after >= cushionCents ? 'lifts you back above your cushion' : 'lifts your balance again'
      return low.index === rule.index
        ? `Your lowest point comes just before this paycheck lands. It ${lift}.`
        : `This paycheck ${lift}.`
    }
    if (after < cushionCents) return 'You end this day below your cushion.'
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
  const describeTarget = (index: number) =>
    targets[index]!.rules.map((rule) => describeRule(rule)).join(' ')

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
    const target = openTarget
    setOpen(null)
    if (refocus && target >= 0) targetButtons.current[target]?.focus()
  }
  /** ←/→ on the lines move focus between them; focus itself announces each line. */
  const onTargetKey = (event: KeyboardEvent<HTMLElement>, index: number) => {
    if (event.key === 'Escape' && open !== null) {
      event.preventDefault()
      closeCard(true)
      return
    }
    const last = targets.length - 1
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
    setFocusTarget(next)
    targetButtons.current[next]?.focus()
    if (open !== null) setOpen(targets[next]!.primary)
  }
  /** ←/→ inside an open card step through every line; focus stays in the card, so speak it once. */
  const showRule = (next: number, speak: boolean) => {
    setOpen(next)
    setFocusTarget(targetOf(next))
    if (speak) setSpoken(describeRule(next))
  }
  const onCardKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeCard(true)
      return
    }
    if (open === null) return
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = Math.max(0, Math.min(rules.length - 1, open + step))
    if (next === open) return
    showRule(next, true)
    popover.current?.focus({ preventScroll: true })
  }

  const activeIndex = open !== null ? null : active
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
  const lineD = stepPath(values, g)
  const bandD = bandPath(values, g, cushionCents)
  const byId = new Map(placed.map((box) => [box.id, box]))
  const lowBox = byId.get('low')
  const buyBox = byId.get('buy')
  const storyBox = byId.get('story')
  const lowEnd = lowBox ? leaderEnd(lowBox, low) : null
  const lowLeader = !!lowEnd && Math.hypot(lowEnd.x - low.x, lowEnd.y - low.y) > LEADER_MIN
  const lowRed = values[low.index]! < cushionCents
  const p4Box = byId.get('p4low')
  const p4End = p4Box && layout.p4Low ? leaderEnd(p4Box, layout.p4Low) : null
  const popId = `${id}-pop`
  const ruleClass = (index: number) =>
    `${rules[index]!.kind}${isStory(index) ? ' story' : ''}${hot.has(index) ? ' on' : ''}`
  const instalmentToday =
    activeIndex === null
      ? undefined
      : layout.instalments.find((instalment) => instalment.index === activeIndex)

  const openRule = open !== null ? rules[open] : undefined
  const dock = openRule && !compact ? dockLeft(openRule.x, width, DOCK_WIDTH) : null
  const ruleCard = openRule && open !== null && (
    <RuleCard
      ref={popover}
      id={popId}
      rule={openRule}
      after={points[openRule.index]!.purchaseCents}
      lowest={values[openRule.index]!}
      note={ruleStory(open)}
      story={isStory(open)}
      cushionCents={cushionCents}
      choices={targets[openTarget]!.rules.map((index) => ({ index, rule: rules[index]! }))}
      current={open}
      caret={Math.max(14, Math.min(width - 14, openRule.x)) - (dock ?? 0)}
      dock={dock}
      onChoose={(index) => showRule(index, false)}
      onClose={() => closeCard(true)}
      onKeyDown={onCardKey}
    />
  )

  return (
    <div className="bchart">
      <div className="bchart-key" aria-hidden="true">
        <span>
          <i className="k-line" />
          {p4Values ? fullName : 'Balance (day’s low)'}
        </span>
        {p4Values && (
          <span>
            <i className="k-p4" />
            {payIn4?.instalments[0]
              ? `Pay in 4 from ${shortDate(payIn4.instalments[0].date)} · illustrative`
              : 'Pay in 4 · illustrative'}
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
            {g.ticks.map((value) => (
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

          {storyBox && story.bill !== undefined && (
            <g className="bchart-storylabel">
              <line
                className="bchart-rule bill story"
                x1={rules[story.bill]!.x}
                x2={rules[story.bill]!.x}
                y1={storyBox.y + 2}
                y2={plot.y}
              />
              <text
                x={storyBox.x + (storyBox.x >= rules[story.bill]!.x ? 0 : storyBox.w)}
                y={storyBox.y + 13}
                textAnchor={storyBox.x >= rules[story.bill]!.x ? 'start' : 'end'}
              >
                {layout.storyText}
              </text>
            </g>
          )}

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
              {lowLeader && lowEnd && <line x1={low.x} y1={low.y} x2={lowEnd.x} y2={lowEnd.y} />}
              <rect
                x={lowBox.x}
                y={lowBox.y}
                width={lowBox.w}
                height={lowBox.h}
                rx={lowBox.h / 2 > 10 ? 10 : lowBox.h / 2}
              />
              <text x={lowBox.x + 10} y={lowBox.y + 15} className="t">
                {layout.lowTop}
              </text>
              {layout.lowBottom && (
                <text x={lowBox.x + 10} y={lowBox.y + 29} className="s">
                  {layout.lowBottom}
                </text>
              )}
            </g>
          )}
          {p4Box && layout.p4Low && (
            <g className={`bchart-lowpill p4${layout.p4Low.below ? ' below' : ''}`}>
              {p4End &&
                Math.hypot(p4End.x - layout.p4Low.x, p4End.y - layout.p4Low.y) > LEADER_MIN && (
                  <line x1={layout.p4Low.x} y1={layout.p4Low.y} x2={p4End.x} y2={p4End.y} />
                )}
              <rect
                x={p4Box.x}
                y={p4Box.y}
                width={p4Box.w}
                height={p4Box.h}
                rx={p4Box.h / 2 > 10 ? 10 : p4Box.h / 2}
              />
              <text x={p4Box.x + 10} y={p4Box.y + 15} className="t">
                {layout.p4Top}
              </text>
              {layout.p4Bottom && (
                <text x={p4Box.x + 10} y={p4Box.y + 29} className="s">
                  {layout.p4Bottom}
                </text>
              )}
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
              {/* The numbered instalment already marks Pay in 4 on its days. */}
              {p4Values && !instalmentToday && (
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
            if (open !== null) setOpen(null)
            moveDay(dayAt(event.clientX), false)
          }}
          onPointerMove={(event) => {
            if (event.pointerType === 'mouse' || event.buttons) moveDay(dayAt(event.clientX), false)
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === 'mouse') setActive(null)
          }}
        />
        {targets.length > 0 && (
          <div
            className="bchart-rulebar"
            role="group"
            aria-label="Paydays and big bills. Use the arrow keys to move between them."
          >
            {targets.map((target, index) => (
              <button
                key={rules[target.rules[0]!]!.date}
                type="button"
                ref={(element) => {
                  targetButtons.current[index] = element
                }}
                className={`bchart-rulehit ${rules[target.primary]!.kind}`}
                style={{
                  left: target.left,
                  width: target.right - target.left,
                  top: plot.y,
                  height: plot.h,
                }}
                tabIndex={index === focusTarget ? 0 : -1}
                aria-label={describeTarget(index)}
                aria-expanded={openTarget === index}
                aria-controls={openTarget === index ? popId : undefined}
                onFocus={() => setFocusTarget(index)}
                onKeyDown={(event) => onTargetKey(event, index)}
                onPointerEnter={(event) => {
                  if (event.pointerType === 'mouse') setPeek(index)
                }}
                onPointerLeave={(event) => {
                  if (event.pointerType === 'mouse') setPeek(null)
                }}
                // A sideways drag that starts on a line scrubs the days instead of opening it.
                onPointerDown={(event) => {
                  drag.current = { x: event.clientX, scrubbing: false }
                }}
                onPointerMove={(event) => {
                  const start = drag.current
                  if (!start || event.pointerType === 'mouse' || !event.buttons) return
                  if (!start.scrubbing && Math.abs(event.clientX - start.x) < 8) return
                  start.scrubbing = true
                  touch.current = true
                  if (open !== null) setOpen(null)
                  moveDay(dayAt(event.clientX), false)
                }}
                onClick={(event) => {
                  const dragged = drag.current?.scrubbing
                  drag.current = null
                  if (dragged) return
                  setActive(null)
                  setPeek(null)
                  if (openTarget === index) {
                    setOpen(null)
                    return
                  }
                  // A keyboard press (detail 0) moves focus into the card.
                  focusCard.current = event.detail === 0
                  setFocusTarget(index)
                  setOpen(target.primary)
                }}
              />
            ))}
          </div>
        )}
      </div>
      {ruleCard}
      <p className="sr" aria-live="polite">
        {spoken}
      </p>
      <div className="bchart-foot">
        {activeIndex !== null ? (
          <Readout
            point={points[activeIndex]!}
            value={values[activeIndex]!}
            p4={p4Values?.[activeIndex]}
            instalment={instalmentToday}
            cushionCents={cushionCents}
          />
        ) : peek !== null && open === null ? (
          <Peek rules={targets[peek]!.rules.map((index) => rules[index]!)} points={points} />
        ) : (
          <p className="bchart-hint bchart-slot">
            <span className="on-touch">
              Drag across the chart to read any day. Tap a bill or payday line for details.
            </span>
            <span className="on-pointer">
              Move across the chart to read any day. Select a bill or payday line for details.
            </span>
          </p>
        )}
      </div>
      {layout.p4Low && (
        <dl className="bchart-compare">
          {[
            { key: 'full', name: fullName, index: low.index, value: values[low.index]! },
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
                lowest point <b>{signed(row.value)}</b> on {dayLabel(points[row.index]!.date)},{' '}
                {cushionGap(row.value, cushionCents)}
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
        fullName={fullName}
        lowIndex={low.index}
        p4LowIndex={layout.p4Low?.index}
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

function EventList({ events }: { events: ForecastEvent[] }) {
  if (!events.length) return null
  return (
    <ul className="bc-events">
      {events.map((event, index) => (
        <li key={`${event.id}-${index}`} className={event.amountCents > 0 ? 'in' : 'out'}>
          <span>{event.name}</span>
          <b>{signed(event.amountCents, event.amountCents > 0)}</b>
        </li>
      ))}
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
        <span className="d">Selected: {dayLabel(point.date)}</span>
        <b className={value < cushionCents ? 'neg' : undefined}>{signed(value)}</b>
        <span className={`vs${value < cushionCents ? ' neg' : ''}`}>
          at the day’s low{value < cushionCents ? ' · below your cushion' : ''}
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
            {instalment
              ? `Pay in 4: payment ${instalment.number} of 4 ${signed(-instalment.amountCents)}, day’s low `
              : 'With Pay in 4, day’s low '}
            {signed(p4)}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * A hovered line's one-line summary in the readout slot: the day, its movement and the balance
 * after. The full card opens on click, so a hover never covers the chart or leaves the tile.
 */
function Peek({ rules, points }: { rules: EventRule[]; points: ForecastPoint[] }) {
  const first = rules[0]!
  const last = rules.at(-1)!
  const after = points[last.index]!.purchaseCents
  const many = rules.length > 1
  const net = netOf(first)
  return (
    <div className="bchart-readout bchart-slot bchart-peek" aria-hidden="true">
      <div className="r1">
        <span className="d">
          {many ? `${dayLabel(first.date)} to ${dayLabel(last.date)}` : dayLabel(first.date)}
        </span>
        {!many && <b className={net > 0 ? 'pos' : undefined}>{signed(net, net > 0)}</b>}
        <span className="vs">balance after {signed(after)}</span>
        <span className="act">Click for details</span>
      </div>
      <div className="r2">
        {rules.flatMap((rule) =>
          rule.events.map((event, index) => (
            <span
              key={`${rule.date}-${index}`}
              className={event.amountCents > 0 ? 'in' : undefined}
            >
              {many ? `${shortDate(rule.date)} · ` : ''}
              {eventText(event)}
            </span>
          )),
        )}
      </div>
    </div>
  )
}

/**
 * What happened on a payday or bill day, opened by click, tap or Enter on its line. It leads with
 * the day's net movement, lists each event, gives the balance after the day and one line on why
 * it matters. It docks under the plot (its caret on the line), so it never covers the step it
 * explains. Lines on nearby days share one target, and the card offers a day chooser for them.
 */
function RuleCard({
  ref,
  id,
  rule,
  after,
  lowest,
  note,
  story,
  cushionCents,
  choices,
  current,
  caret,
  dock,
  onChoose,
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
  cushionCents: number
  choices: { index: number; rule: EventRule }[]
  current: number
  /** The caret's offset from the card's left edge. */
  caret: number
  /** Wide charts: the card's left offset; null on phones (full width). */
  dock: number | null
  onChoose: (index: number) => void
  onClose: () => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
}) {
  const income = rule.events.some((event) => event.kind === 'income')
  const net = netOf(rule)
  const title = `${rule.kind === 'payday' ? 'Payday' : 'Bill'} · ${dayLabel(rule.date)}`
  const style =
    dock === null
      ? { ['--caret' as string]: `${caret}px` }
      : { width: DOCK_WIDTH, marginLeft: dock, ['--caret' as string]: `${caret}px` }
  return (
    <div
      ref={ref}
      id={id}
      className={`bchart-pop ${rule.kind}${story ? ' story' : ''}`}
      style={style}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="bc-head">
        <span className="bc-kind">{title}</span>
        <button type="button" className="bc-close" aria-label="Close" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </div>
      {choices.length > 1 && (
        <div className="bc-days" role="group" aria-label="Lines on nearby days">
          {choices.map((choice) => (
            <button
              key={choice.rule.date}
              type="button"
              className={choice.rule.kind}
              aria-pressed={choice.index === current}
              onClick={() => onChoose(choice.index)}
            >
              {shortDate(choice.rule.date)}
            </button>
          ))}
        </div>
      )}
      <div className={`bc-net${net > 0 ? ' pos' : ''}`}>{signed(net, net > 0)}</div>
      {rule.events.length === 1 ? (
        <div className="bc-name">{rule.events[0]!.name}</div>
      ) : (
        <EventList events={rule.events} />
      )}
      <dl className="bc-after">
        {income && lowest !== after && (
          <div>
            <dt>Day’s low</dt>
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

/** The chart as a table: every day's low balance, how it sits against the cushion, and why. */
function ChartTable({
  points,
  values,
  p4,
  cushionCents,
  instalments,
  fullName,
  lowIndex,
  p4LowIndex,
}: {
  points: ForecastPoint[]
  values: number[]
  p4: number[] | null
  cushionCents: number
  instalments?: InstalmentDetail[]
  fullName: string
  lowIndex: number
  p4LowIndex?: number
}) {
  const spend = points[0] ? spendingOn(points[0]) : 0
  const lowText = (value: number, index: number) =>
    `Lowest point ${signed(value)} on ${dayLabel(points[index]!.date)}${value < cushionCents ? ', below your cushion' : ''}`
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
            Projected balance each day at its low, with that day’s bills taken out before pay
            arrives, against your {money(cushionCents)} cushion.
            {spend ? ` Each day also includes about ${money(-spend)} of everyday spending.` : ''}
            {p4 && p4LowIndex !== undefined
              ? ` ${fullName}: ${lower(lowText(values[lowIndex]!, lowIndex))}. With Pay in 4: ${lower(lowText(p4[p4LowIndex]!, p4LowIndex))}.`
              : ''}
          </caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">{p4 ? `${fullName} (day’s low)` : 'Balance (day’s low)'}</th>
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
                  <td className="num">
                    {signed(value)}
                    {p4 && index === lowIndex ? ' · lowest point' : ''}
                  </td>
                  <td>
                    {value === cushionCents
                      ? 'At cushion'
                      : value > cushionCents
                        ? 'Above'
                        : 'Below'}
                  </td>
                  <td>{namedOn(point).map(eventText).join(', ') || '—'}</td>
                  {p4 && (
                    <td className="num">
                      {signed(p4[index]!)}
                      {instalment ? ` · payment ${instalment.number} of 4` : ''}
                      {index === p4LowIndex ? ' · lowest point' : ''}
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
      .filter((event) => isBill(event) && -event.amountCents >= BIG_BILL_CENTS)
      .map((event) => `${event.name} ${dayLabel(rule.date)}`),
  )
  return ` Paydays: ${paydays.map((rule) => dayLabel(rule.date)).join(', ') || 'none'}. Big bills: ${
    bills.join(', ') || 'none'
  }.`
}
