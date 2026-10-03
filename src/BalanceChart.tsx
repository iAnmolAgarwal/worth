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
import { shortDate, signed } from './format'

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

/** Payday: a small upward mark on the axis. Big bill: a small square. Shapes carry the meaning. */
function PaydayMark({ cx = 0, cy = 0 }: { cx?: number; cy?: number }) {
  return <path d={`M${cx} ${cy - 9} l5 8 h-10 z`} fill="#0C6E11" stroke="#fff" strokeWidth={1.5} />
}
function BillMark({ cx = 0, cy = 0 }: { cx?: number; cy?: number }) {
  return (
    <rect
      x={cx - 4}
      y={cy - 9}
      width={8}
      height={8}
      rx={1.5}
      fill="#003087"
      stroke="#fff"
      strokeWidth={1.5}
    />
  )
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
}: {
  points: ForecastPoint[]
  cushionCents: number
  purchase?: { date: string; amountCents: number }
  label: string
  payIn4?: { points: ForecastPoint[]; instalments: InstalmentDetail[] }
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
  const xTicks = data.filter((_, index) => index % 14 === 0).map((point) => point.date)
  return (
    <div className="chart" role="img" aria-label={label}>
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
          <ReferenceLine y={cushionCents} stroke={TEXT_2} strokeWidth={1.5} strokeDasharray="4 4" />
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
          {bills.map((point) => (
            <ReferenceDot
              key={`bill-${point.date}`}
              x={point.date}
              y={lo}
              r={0}
              shape={<BillMark />}
              ifOverflow="visible"
            />
          ))}
          {paydays.map((point) => (
            <ReferenceDot
              key={`pay-${point.date}`}
              x={point.date}
              y={lo}
              r={0}
              shape={<PaydayMark />}
              ifOverflow="visible"
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
  )
}
