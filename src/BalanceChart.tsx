import {
  Area,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts'
import type { ForecastPoint, InstalmentDetail } from '../shared/types'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { dayLabel, shortDate, signed } from './format'

const TEXT_2 = '#545D68'
const STRONG = '#001435'

type LabelBox = { viewBox?: { x?: number; y?: number; width?: number; height?: number } }
/** A chart label with a white halo, so it stays legible where it crosses a line. */
function halo(text: string, place: 'left' | 'right' | 'top-left') {
  function HaloLabel({ viewBox }: LabelBox) {
    const x = viewBox?.x ?? 0
    const y = viewBox?.y ?? 0
    const w = viewBox?.width ?? 0
    const h = viewBox?.height ?? 0
    const at =
      place === 'top-left'
        ? { x: x + 6, y: y + 12, anchor: 'start' as const }
        : place === 'right'
          ? { x: x + w + 8, y: y + h / 2 + 4, anchor: 'start' as const }
          : { x: x - 8, y: y + h / 2 + 4, anchor: 'end' as const }
    return (
      <text
        x={at.x}
        y={at.y}
        textAnchor={at.anchor}
        fontSize={12}
        fontWeight={700}
        fill={STRONG}
        stroke="#fff"
        strokeWidth={4}
        strokeLinejoin="round"
        paintOrder="stroke"
      >
        {text}
      </text>
    )
  }
  return HaloLabel
}

/** Bills large enough to mark on the timing strip. */
export const BIG_BILL_CENTS = 10_000

/** Chart ticks are the one place money drops its cents: "$1k", "−$1k" (brief §7). */
function tick(cents: number) {
  if (cents === 0) return '$0'
  const thousands = Math.abs(cents) / 100_000
  return `${cents < 0 ? '−' : ''}$${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`
}

/** A nice-number domain on whole $1k steps (UX-13); wider ranges step by $2k or $5k. */
function niceDomain(values: number[], cushion: number) {
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

/**
 * One chart for the selected option (§5.3): the daily lowest balance, the cushion as a dashed
 * ReferenceLine with a red ReferenceArea below it, the purchase marker and the low-point ring.
 * When the Pay in 4 comparison is open, its illustrative line and instalment markers join it.
 */
export function BalanceChart({
  points,
  cushionCents,
  purchase,
  label,
  payIn4,
  highlight,
}: {
  points: ForecastPoint[]
  cushionCents: number
  purchase?: { date: string; amountCents: number }
  label: string
  payIn4?: { points: ForecastPoint[]; instalments: InstalmentDetail[] }
  /** The bill and payday that drive the answer get inline labels on the timing strip. */
  highlight?: { billDate?: string; paydayDate?: string }
}) {
  const byDate = new Map(payIn4?.points.map((point) => [point.date, point.minimumCents]))
  const data = points.map((point) => ({
    date: point.date,
    balance: point.minimumCents,
    ...(payIn4 ? { p4: byDate.get(point.date) } : {}),
  }))
  if (!data.length) return null
  const values = [
    ...data.map((point) => point.balance),
    ...(payIn4?.points.map((point) => point.minimumCents) ?? []),
  ]
  const { lo, hi, ticks } = niceDomain(values, cushionCents)
  const low = data.reduce((min, point) => (point.balance < min.balance ? point : min), data[0]!)
  const lowIndex = data.indexOf(low)
  const paydays = points.filter((point) => point.events.some((event) => event.kind === 'income'))
  const bills = points.filter((point) =>
    point.events.some(
      (event) =>
        (event.kind === 'bill' || event.kind === 'installment') &&
        -event.amountCents >= BIG_BILL_CENTS,
    ),
  )
  const last = Math.max(1, points.length - 1)
  const marks = [
    ...bills.map((point) => {
      const bill = point.events
        .filter((event) => event.kind === 'bill' || event.kind === 'installment')
        .sort((x, y) => x.amountCents - y.amountCents)[0]!
      return {
        date: point.date,
        kind: 'bill' as const,
        name: bill.name,
        amount: signed(bill.amountCents),
        labelled: point.date === highlight?.billDate,
      }
    }),
    ...paydays.map((point) => {
      const pay = point.events.find((event) => event.kind === 'income')!
      return {
        date: point.date,
        kind: 'payday' as const,
        name: 'Payday',
        amount: signed(pay.amountCents, true),
        labelled: point.date === highlight?.paydayDate,
      }
    }),
  ].map((mark) => ({ ...mark, at: points.findIndex((point) => point.date === mark.date) / last }))
  const xTicks = data.filter((_, index) => index % 14 === 0).map((point) => point.date)
  const strip = marks.length
    ? ` Paydays: ${paydays.map((point) => dayLabel(point.date)).join(', ') || 'none'}. Big bills: ${
        marks
          .filter((mark) => mark.kind === 'bill')
          .map((mark) => `${mark.name} ${dayLabel(mark.date)}`)
          .join(', ') || 'none'
      }.`
    : ''
  return (
    <>
      <div className="chart" role="img" aria-label={label + strip}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: 20, right: 12, bottom: 0, left: 0 }}
            accessibilityLayer={false}
          >
            <ReferenceArea
              y1={lo}
              y2={cushionCents}
              fill="rgba(213,1,2,.06)"
              stroke="none"
              ifOverflow="hidden"
            />
            {ticks.map((value) => (
              <ReferenceLine key={value} y={value} stroke={value === 0 ? '#CFD3D8' : '#EEF0F3'} />
            ))}
            <XAxis
              dataKey="date"
              ticks={xTicks}
              tickFormatter={(date: string) => shortDate(date)}
              tick={{ fontSize: 12, fill: TEXT_2 }}
              tickLine={false}
              axisLine={false}
              interval={0}
              tickMargin={8}
            />
            <YAxis
              domain={[lo, hi]}
              ticks={ticks}
              tickFormatter={tick}
              tick={{ fontSize: 12, fill: TEXT_2 }}
              tickLine={false}
              axisLine={false}
              width={48}
              allowDataOverflow
            />
            <Area
              type="linear"
              dataKey="balance"
              stroke="#0070E0"
              strokeWidth={2}
              fill="rgba(0,112,224,.08)"
              baseValue={lo}
              isAnimationActive={false}
              dot={false}
              activeDot={false}
            />
            {payIn4 && (
              <Line
                type="linear"
                dataKey="p4"
                stroke="#003087"
                strokeWidth={2.5}
                strokeDasharray="0.1 5"
                strokeLinecap="round"
                dot={false}
                activeDot={false}
                isAnimationActive={false}
              />
            )}
            <ReferenceLine
              y={cushionCents}
              stroke={TEXT_2}
              strokeWidth={1.5}
              strokeDasharray="4 4"
            />
            {purchase && purchase.amountCents > 0 && (
              <ReferenceLine
                x={purchase.date}
                stroke={STRONG}
                strokeDasharray="2 3"
                label={halo(
                  `Buy ${shortDate(purchase.date)} · ${signed(-purchase.amountCents).replace(/\.00$/, '')}`,
                  'top-left',
                )}
              />
            )}
            {payIn4?.instalments.map((instalment) => (
              <ReferenceDot
                key={instalment.number}
                x={instalment.date}
                y={byDate.get(instalment.date) ?? instalment.balanceCents}
                r={4}
                fill={instalment.belowCushion ? '#D50102' : '#003087'}
                stroke="#fff"
                strokeWidth={1.5}
              />
            ))}
            <ReferenceDot
              x={low.date}
              y={low.balance}
              r={5}
              fill="#fff"
              stroke={STRONG}
              strokeWidth={2}
              label={halo(
                `Lowest ${signed(low.balance)}`,
                // Beside its marker, on the side with room.
                lowIndex > data.length * 0.7 ? 'left' : 'right',
              )}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {marks.length > 0 && <TimingStrip marks={marks} />}
    </>
  )
}

type Mark = {
  date: string
  kind: 'bill' | 'payday'
  name: string
  amount: string
  labelled: boolean
  at: number
}
/** Events this many days apart or closer share one marker, so none overlap on a phone. */
const MERGE_DAYS = 3
const maxAt = (marks: Mark[]) =>
  Math.max(...marks.map((mark) => mark.at)) - Math.min(...marks.map((mark) => mark.at))
const dayIndex = (date: string) => Math.round(Date.parse(`${date}T12:00:00Z`) / 86_400_000)

/**
 * Paydays and big bills under the chart. Neighbouring events merge into one marker whose tooltip
 * lists them all; the bill and payday behind the answer carry a label tied to their marker. The
 * strip is one tab stop: arrow keys move between markers.
 */
function TimingStrip({ marks }: { marks: Mark[] }) {
  // Merge by distance on screen: markers closer than one marker's width share one.
  const list = useRef<HTMLOListElement>(null)
  const [width, setWidth] = useState(600)
  useEffect(() => {
    const element = list.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const sorted = [...marks].sort((a, b) => a.date.localeCompare(b.date))
  const span = Math.max(1, dayIndex(sorted.at(-1)!.date) - dayIndex(sorted[0]!.date))
  const plot = Math.max(1, width - 60)
  const pxPerDay =
    sorted.length > 1 && marks.some((m) => m.at > 0) ? (plot * maxAt(marks)) / span : plot / 60
  const mergeDays = Math.max(MERGE_DAYS, Math.ceil(30 / Math.max(pxPerDay, 0.1)))
  const groups: Mark[][] = []
  for (const mark of sorted) {
    const group = groups.at(-1)
    if (group && dayIndex(mark.date) - dayIndex(group.at(-1)!.date) <= mergeDays) group.push(mark)
    else groups.push([mark])
  }
  const [active, setActive] = useState(0)
  const items = useRef<(HTMLLIElement | null)[]>([])
  const move = (event: KeyboardEvent<HTMLLIElement>, index: number) => {
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? Math.min(groups.length - 1, index + 1)
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? Math.max(0, index - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? groups.length - 1
              : index
    if (next === index) return
    event.preventDefault()
    setActive(next)
    items.current[next]?.focus()
  }
  const describe = (mark: Mark) => `${mark.name} · ${dayLabel(mark.date)} · ${mark.amount}`
  return (
    <ol
      className="strip"
      aria-label="Paydays and big bills. Use the arrow keys to move between them."
    >
      {groups.map((group, index) => {
        const label = group.find((mark) => mark.labelled)
        // The bill behind the low point keeps its label on phones; the payday label is extra.
        const primary = label?.kind === 'bill'
        const at = group.reduce((sum, mark) => sum + mark.at, 0) / group.length
        return (
          <li
            key={group[0]!.date}
            ref={(element) => {
              items.current[index] = element
            }}
            className={`mark${label ? ' labelled' : ''}${primary ? ' primary' : ''}${
              at > 0.7 ? ' edge-end' : at < 0.25 ? ' edge-start' : ''
            }`}
            style={{ left: `calc(48px + (100% - 60px) * ${at.toFixed(4)})` }}
            tabIndex={index === active ? 0 : -1}
            onFocus={() => setActive(index)}
            onKeyDown={(event) => move(event, index)}
            data-tip={group.map(describe).join('  ·  ')}
            aria-label={group.map(describe).join('; ')}
          >
            <span className="shapes" aria-hidden="true">
              {group.some((mark) => mark.kind === 'payday') && <i className="shape payday" />}
              {group.some((mark) => mark.kind === 'bill') && <i className="shape bill" />}
            </span>
            {label && (
              <span className="mark-label" aria-hidden="true">
                {label.name} · {dayLabel(label.date)}
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}
