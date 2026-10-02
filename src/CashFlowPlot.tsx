import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useId } from 'react'
import type { Assessment } from '../shared/types'
import { money, shortDate } from './format'

export type ForecastChartProps = {
  assessment: Assessment
  compact?: boolean
  showPurchase?: boolean
  showStress?: boolean
}

export default function CashFlowPlot({
  assessment,
  compact = false,
  showPurchase = true,
  showStress = false,
}: ForecastChartProps) {
  const fillId = useId().replaceAll(':', '')
  const data = assessment.points.map((p) => ({
    date: p.date,
    baseline: p.baselineMinimumCents,
    purchase: p.minimumCents,
    stress: p.stressMinimumCents,
  }))
  const values = data.flatMap((p) => [
    p.baseline,
    ...(showPurchase ? [p.purchase] : []),
    ...(showStress ? [p.stress] : []),
  ])
  const min = Math.min(0, ...values, assessment.cushionCents) / 100
  const max = Math.max(...values, assessment.cushionCents) / 100
  return (
    <div
      className={compact ? 'forecast-chart compact' : 'forecast-chart'}
      role="img"
      aria-label={`Projected balance. Daily low balances. Lowest estimate ${money(assessment.lowestBalanceCents, true)} on ${shortDate(assessment.lowestDate)}. Protected cushion ${money(assessment.cushionCents)}.`}
    >
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <AreaChart data={data} margin={{ top: 15, right: 12, bottom: 0, left: -20 }}>
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#718c53" stopOpacity={0.22} />
              <stop offset="100%" stopColor="#718c53" stopOpacity={0.01} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="#e9eae1" strokeDasharray="3 5" />
          <XAxis
            dataKey="date"
            tickFormatter={(d) => shortDate(d)}
            axisLine={false}
            tickLine={false}
            minTickGap={55}
            tick={{ fontSize: 10, fill: '#899083' }}
            dy={8}
          />
          <YAxis
            tickFormatter={(n) =>
              Math.abs(n) >= 100000
                ? `$${(n / 100000).toFixed(n % 100000 === 0 ? 0 : 1)}k`
                : money(n)
            }
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 10, fill: '#899083' }}
            domain={[min * 100, Math.ceil(max / 1000) * 100000]}
            width={66}
          />
          <Tooltip
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <div className="chart-tooltip">
                  <strong>{shortDate(String(label))} · daily low</strong>
                  {payload.map((p) => (
                    <div key={String(p.dataKey)}>
                      <span style={{ color: p.color }}>
                        {p.dataKey === 'baseline'
                          ? 'Your plan'
                          : p.dataKey === 'stress'
                            ? 'Spending +20%'
                            : 'With purchase'}
                      </span>
                      <b>{money(Number(p.value), true)}</b>
                    </div>
                  ))}
                </div>
              ) : null
            }
          />
          <ReferenceLine
            y={assessment.cushionCents}
            stroke="#a3ab73"
            strokeDasharray="5 5"
            label={{
              value: 'YOUR CUSHION',
              position: 'insideTopRight',
              fill: '#919968',
              fontSize: 8,
            }}
          />
          <Area
            type="linear"
            dataKey="baseline"
            stroke="#83935e"
            strokeWidth={showPurchase ? 1.7 : 2.5}
            strokeDasharray={showPurchase ? '5 5' : undefined}
            fill={showPurchase ? 'none' : `url(#${fillId})`}
            isAnimationActive={false}
          />
          {showPurchase && (
            <Area
              type="linear"
              dataKey="purchase"
              stroke="#284c3b"
              strokeWidth={2.5}
              fill={`url(#${fillId})`}
              isAnimationActive={false}
            />
          )}
          {showStress && (
            <Area
              type="linear"
              dataKey="stress"
              stroke="#b68f57"
              strokeWidth={1.7}
              fill="none"
              isAnimationActive={false}
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
