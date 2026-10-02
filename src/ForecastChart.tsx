import { lazy, Suspense } from 'react'
import type { ForecastChartProps } from './CashFlowPlot'

const CashFlowPlot = lazy(() => import('./CashFlowPlot'))

/** Keep the chart library out of the initial interface bundle. */
export function ForecastChart(props: ForecastChartProps) {
  return (
    <Suspense
      fallback={
        <div
          className={
            props.compact ? 'forecast-chart compact chart-loading' : 'forecast-chart chart-loading'
          }
          role="status"
          aria-label="Loading forecast chart"
        />
      }
    >
      <CashFlowPlot {...props} />
    </Suspense>
  )
}
