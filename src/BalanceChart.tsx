import type { ForecastPoint } from '../shared/types'
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Pin } from 'lucide-react'
import {
  bigBills,
  dateTicks,
  daySentence,
  dayState,
  frame,
  isPayday,
  lowestIndex,
  namedEvents,
  rangeOptions,
  seriesSummary,
  smoothPath,
  STATE_WORDS,
  stretchDates,
  stretches,
  tickLabel,
  type RangeKey,
} from './chartModel'
import { textWidth } from './chartLayout'
import { cx, dayLabel, money, shortDate, signed } from './format'
import './chart.css'

/** Another option's balance, drawn faintly behind the main line when its chip is on. */
export interface CompareSeries {
  key: string
  /** The chip and legend name: "Buy today". */
  name: string
  points: ForecastPoint[]
  /** Starts switched on (the page opened this comparison itself). */
  on?: boolean
}

/** Tracks the rendered width; tests (no ResizeObserver) get a desktop-sized default. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(660)
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

const TRACK_H = 8
const TRACK_GAP = 5
const eventText = (event: { name: string; amountCents: number }) =>
  `${event.name} ${signed(event.amountCents, event.amountCents > 0)}`

/**
 * The balance chart: one bold line for the option in question against the cushion, and as little
 * else as possible. Other options and the bills are opt-in chips. Under the plot a track gives
 * each day's state (above the cushion, below it, below zero) without reading the line, and the
 * day in focus is spelled out in words. Plain SVG, with a keyboard scrubber and a table.
 */
export function BalanceChart({
  points,
  cushionCents,
  label,
  name = 'Balance',
  purchase,
  compare = [],
}: {
  points: ForecastPoint[]
  cushionCents: number
  /** The text alternative's first sentence. */
  label: string
  /** What the main line is: "Wait until Tue, Dec 15". */
  name?: string
  /** The day the purchase is paid for on the main line; `fits` marks it as the day it fits. */
  purchase?: { date: string; amountCents: number; fits?: boolean }
  compare?: CompareSeries[]
}) {
  const id = useId().replace(/:/g, '')
  const [wrap, width] = useWidth()
  const defaults = compare
    .filter((series) => series.on)
    .map((series) => series.key)
    .join('|')
  const [shown, setShown] = useState(() => new Set(defaults ? defaults.split('|') : []))
  const [bills, setBills] = useState(false)
  const [range, setRange] = useState<RangeKey>('all')
  const [hover, setHover] = useState<number | null>(null)
  const [pinned, setPinned] = useState<number | null>(null)
  const [spoken, setSpoken] = useState('')

  // A new option, or the page opening a comparison itself, resets what is shown (during render).
  const window = `${name}|${points[0]?.date}|${points.length}`
  const [seen, setSeen] = useState({ window, defaults })
  if (seen.window !== window || seen.defaults !== defaults) {
    if (seen.defaults !== defaults) setShown(new Set(defaults ? defaults.split('|') : []))
    if (seen.window !== window) {
      setPinned(null)
      setHover(null)
    }
    setSeen({ window, defaults })
  }

  const ranges = useMemo(() => rangeOptions(points), [points])
  const days = (ranges.find((option) => option.key === range) ?? ranges.at(-1)!).days
  const visible = points.slice(0, days)
  const values = visible.map((point) => point.minimumCents)
  const others = compare
    .map((series, index) => ({ ...series, style: `alt${index + 1}` }))
    .filter((series) => shown.has(series.key))
    .map((series) => {
      const byDate = new Map(series.points.map((point) => [point.date, point]))
      return { ...series, days: visible.map((point) => byDate.get(point.date)) }
    })
  const rows = 1 + others.length
  const underPlot = 10 + rows * (TRACK_H + TRACK_GAP) + (bills ? 30 : 0) + 24
  const g = frame(
    width,
    Math.max(1, visible.length),
    [
      ...values,
      ...others.flatMap((s) => s.days.flatMap((p) => (p ? [p.minimumCents] : []))),
    ],
    cushionCents,
    underPlot,
  )
  if (!points.length) return null

  const { plot } = g
  const narrow = width < 480
  const runs = stretches(values, cushionCents)
  const low = lowestIndex(values)
  const anyNegative =
    values.some((value) => value < 0) ||
    others.some((s) => s.days.some((p) => p && p.minimumCents < 0))
  const focus = Math.min(hover ?? pinned ?? low, visible.length - 1)
  const focusPoint = visible[focus]!
  const focusValue = values[focus]!
  const focusState = dayState(focusValue, cushionCents)
  const buyIndex = purchase ? visible.findIndex((point) => point.date === purchase.date) : -1

  const incomeOn = (point: ForecastPoint) =>
    point.events.reduce((sum, e) => sum + (e.kind === 'income' ? e.amountCents : 0), 0)
  const topIncome = Math.max(0, ...points.map(incomeOn))
  const describe = (index: number) =>
    `${dayLabel(visible[index]!.date)}. Day’s low ${signed(values[index]!)}. ${daySentence(
      visible[index]!,
      values[index]!,
      cushionCents,
    )}`
  const move = (index: number) => {
    const next = Math.max(0, Math.min(visible.length - 1, index))
    setHover(null)
    setPinned(next)
    setSpoken(describe(next))
  }
  /** A chip above the chart jumps to a day in the full window, widening the range if needed. */
  const jump = (date: string) => {
    const index = points.findIndex((point) => point.date === date)
    if (index < 0) return
    if (index >= days) setRange('all')
    setHover(null)
    setPinned(index)
    setSpoken('')
  }
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowUp: 1,
      ArrowLeft: -1,
      ArrowDown: -1,
      PageUp: 7,
      PageDown: -7,
    }
    if (event.key in step) move(focus + step[event.key]!)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(visible.length - 1)
    else if (event.key === 'Escape' && pinned !== null) setPinned(null)
    else return
    event.preventDefault()
  }
  const dayAt = (clientX: number) =>
    g.indexAt(clientX - (wrap.current?.getBoundingClientRect().left ?? 0))

  const linePoints = (cents: (number | undefined)[]) =>
    cents.flatMap((value, index) => (value === undefined ? [] : [{ x: g.x(index), y: g.y(value) }]))
  const main = linePoints(values)
  const mainPath = smoothPath(main)
  const floor = plot.y + plot.h
  const areaPath = `${mainPath}L${g.x(visible.length - 1)},${floor}L${g.x(0)},${floor}Z`

  // The lane above the plot: the purchase first, then today, then paydays; a label that would
  // touch one already placed is left out (its line stays).
  const marks = [
    ...(buyIndex >= 0
      ? [
          {
            index: buyIndex,
            kind: purchase!.fits ? 'fits' : 'buy',
            text: `${purchase!.fits ? 'Fits' : 'Buy'} ${shortDate(purchase!.date)}`,
          },
        ]
      : []),
    ...(buyIndex !== 0 ? [{ index: 0, kind: 'today', text: 'Today' }] : []),
    ...visible.flatMap((point, index) =>
      isPayday(point) && index !== buyIndex
        ? [{ index, kind: 'payday', text: incomeOn(point) * 2 >= topIncome ? 'Payday' : 'Income' }]
        : [],
    ),
  ]
  const taken: [number, number][] = []
  const lane = marks.map((mark) => {
    const w = textWidth(mark.text, 11, 600)
    const x = Math.max(plot.x + w / 2, Math.min(plot.x + plot.w - w / 2, g.x(mark.index)))
    const span: [number, number] = [x - w / 2 - 5, x + w / 2 + 5]
    const clear = taken.every(([a, b]) => span[1] < a || span[0] > b)
    if (clear) taken.push(span)
    return { ...mark, x, labelled: clear }
  })

  // Line labels sit once, in the gutter right of the plot, kept a line apart.
  const cushionY = g.y(cushionCents)
  const zeroY = Math.max(g.y(0), cushionY + 13)
  const billDays = bills
    ? visible.flatMap((point, index) => {
        const big = bigBills(point)
        const total = big.reduce((sum, event) => sum + event.amountCents, 0)
        return big.length ? [{ index, total, name: big[0]!.name, more: big.length - 1 }] : []
      })
    : []
  const namedBills = new Set<number>()
  const billSpans: [number, number][] = []
  for (const bill of [...billDays].sort((a, b) => a.total - b.total)) {
    const w = textWidth(bill.name, 10, 500)
    const span: [number, number] = [g.x(bill.index) - w / 2 - 4, g.x(bill.index) + w / 2 + 4]
    if (span[0] < plot.x - 20 || span[1] > g.width) continue
    if (billSpans.every(([a, b]) => span[1] < a || span[0] > b)) {
      billSpans.push(span)
      namedBills.add(bill.index)
    }
  }
  const trackTop = floor + 10
  const billsTop = trackTop + rows * (TRACK_H + TRACK_GAP)
  const axisY = g.height - 6
  const series = [
    { key: 'main', name, style: 'main', cents: values as (number | undefined)[] },
    ...others.map((s) => ({
      key: s.key,
      name: s.name,
      style: s.style,
      cents: s.days.map((p) => p?.minimumCents),
    })),
  ]

  const summaries = [
    {
      key: 'main',
      name,
      style: 'main',
      text: seriesSummary(visible, values, cushionCents),
      runs,
      of: visible,
    },
    ...others.map((s) => {
      const own = s.days.flatMap((p) => (p ? [p] : []))
      const cents = own.map((p) => p.minimumCents)
      return {
        key: s.key,
        name: s.name,
        style: s.style,
        text: seriesSummary(own, cents, cushionCents),
        runs: stretches(cents, cushionCents),
        of: own,
      }
    }),
  ]
  const alt = `${label} ${summaries.map((s) => `${s.name}: ${s.text}`).join(' ')}`

  return (
    <div className="wchart">
      <ul className="wchart-summary">
        {summaries.map((summary, index) => (
          <li key={summary.key} className={cx(summary.runs.length > 0 && 'dips')}>
            <span className={cx('wchart-swatch', summary.style)} aria-hidden />
            <span className="words">
              {(others.length > 0 || index > 0) && <b>{summary.name}: </b>}
              {summary.text}
            </span>
            <span className="jumps">
              {summary.runs.map((run) => (
                <button
                  type="button"
                  className="wchart-jump bad"
                  key={run.from}
                  onClick={() => jump(summary.of[run.from]!.date)}
                >
                  Below cushion {stretchDates(run, summary.of)}
                </button>
              ))}
              {index === 0 && (
                <button type="button" className="wchart-jump" onClick={() => jump(visible[low]!.date)}>
                  Lowest point {shortDate(visible[low]!.date)}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>

      <div className="wchart-controls">
        <div className="wchart-toggles" role="group" aria-label="Show on the chart">
          {compare.map((s, index) => (
            <button
              type="button"
              key={s.key}
              className="wchart-chip"
              aria-pressed={shown.has(s.key)}
              onClick={() => {
                const next = new Set(shown)
                if (!next.delete(s.key)) next.add(s.key)
                setShown(next)
              }}
            >
              <span className={cx('wchart-swatch', `alt${index + 1}`)} aria-hidden />
              {s.name}
            </button>
          ))}
          <button
            type="button"
            className="wchart-chip"
            aria-pressed={bills}
            onClick={() => setBills(!bills)}
          >
            <span className="wchart-swatch bill" aria-hidden />
            Bills
          </button>
        </div>
        {ranges.length > 1 && (
          <div className="wchart-range" role="group" aria-label="Days shown">
            {ranges.map((option) => (
              <button
                type="button"
                key={option.key}
                aria-pressed={option.key === range}
                onClick={() => {
                  setRange(option.key)
                  setPinned(null)
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="wchart-body">
        <div className="wchart-frame" ref={wrap}>
          <svg
            className="wchart-svg"
            role="img"
            aria-label={alt}
            width={g.width}
            height={g.height}
            viewBox={`0 0 ${g.width} ${g.height}`}
          >
            <defs>
              <linearGradient id={`${id}-area`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" className="wchart-area-top" />
                <stop offset="1" className="wchart-area-end" />
              </linearGradient>
              {/* Below the cushion a line is redrawn in red, so a dip reads without a label. */}
              <clipPath id={`${id}-under`}>
                <rect x={0} y={cushionY} width={g.width} height={Math.max(0, floor - cushionY + 4)} />
              </clipPath>
            </defs>

            {g.ticks.map((cents) => (
              <g key={cents}>
                <line className="wchart-grid" x1={plot.x} x2={plot.x + plot.w} y1={g.y(cents)} y2={g.y(cents)} />
                <text className="wchart-tick" x={plot.x - 8} y={g.y(cents) + 4} textAnchor="end">
                  {tickLabel(cents)}
                </text>
              </g>
            ))}

            {runs.map((run) => {
              const x = g.x(run.from) - g.step / 2
              const w = (run.to - run.from + 1) * g.step
              const text = `Below cushion ${stretchDates(run, visible)}`
              const short = stretchDates(run, visible)
              const fit = [text, short].find((words) => textWidth(words, 11, 600) + 10 <= w)
              return (
                <g key={run.from}>
                  <rect className="wchart-band" x={x} y={plot.y} width={w} height={plot.h} />
                  {fit && (
                    <text className="wchart-bandlabel" x={x + w / 2} y={plot.y + 14} textAnchor="middle">
                      {fit}
                    </text>
                  )}
                </g>
              )
            })}

            {lane.map((mark) => (
              <g key={`${mark.kind}${mark.index}`} className={cx('wchart-mark', mark.kind)}>
                <line x1={g.x(mark.index)} x2={g.x(mark.index)} y1={plot.y} y2={floor} />
                {mark.labelled && (
                  <text x={mark.x} y={plot.y - 10} textAnchor="middle">
                    {mark.text}
                  </text>
                )}
              </g>
            ))}

            <path d={areaPath} fill={`url(#${id}-area)`} />

            {anyNegative && (
              <g className="wchart-level zero">
                <line x1={plot.x} x2={plot.x + plot.w} y1={g.y(0)} y2={g.y(0)} />
                <text x={plot.x + plot.w + 8} y={zeroY + 4}>
                  {narrow ? '$0' : 'Zero $0'}
                </text>
              </g>
            )}
            <g className="wchart-level cushion">
              <line x1={plot.x} x2={plot.x + plot.w} y1={cushionY} y2={cushionY} />
              <text x={plot.x + plot.w + 8} y={cushionY + (anyNegative ? -1 : 4)}>
                {narrow ? money(cushionCents, false) : `Cushion ${money(cushionCents, false)}`}
              </text>
            </g>

            {series.slice(1).map((s) => (
              <g key={s.key}>
                <path className={cx('wchart-alt', s.style)} d={smoothPath(linePoints(s.cents))} />
                <path
                  className={cx('wchart-alt under', s.style)}
                  d={smoothPath(linePoints(s.cents))}
                  clipPath={`url(#${id}-under)`}
                />
              </g>
            ))}
            <path className="wchart-line" d={mainPath} />
            <path className="wchart-line under" d={mainPath} clipPath={`url(#${id}-under)`} />
            {g.step >= 7 &&
              main.map((point, index) => <circle key={index} className="wchart-dot" cx={point.x} cy={point.y} r={1.6} />)}

            <circle className="wchart-low" cx={g.x(low)} cy={g.y(values[low]!)} r={5} />
            {buyIndex >= 0 && (
              <circle
                className={cx('wchart-buy', purchase!.fits && 'fits')}
                cx={g.x(buyIndex)}
                cy={g.y(values[buyIndex]!)}
                r={5.5}
              />
            )}

            {series.map((s, row) => (
              <g key={s.key} className="wchart-track">
                {s.cents.map((value, index) => {
                  if (value === undefined) return null
                  const state = dayState(value, cushionCents)
                  const w = Math.max(2, g.step - 2)
                  const y = trackTop + row * (TRACK_H + TRACK_GAP)
                  return (
                    <g key={index}>
                      <rect className={state} x={g.x(index) - w / 2} y={y} width={w} height={TRACK_H} rx={Math.min(3, w / 2)} />
                      {row === 0 && isPayday(visible[index]!) && (
                        <path className="pay" d={`M${g.x(index) - 3},${y - 1}h6l-3,-4z`} />
                      )}
                      {state === 'negative' && w >= 6 && (
                        <circle className="mark" cx={g.x(index)} cy={y + TRACK_H / 2} r={1.5} />
                      )}
                    </g>
                  )
                })}
                {rows > 1 && (
                  <text x={plot.x + plot.w + 8} y={trackTop + row * (TRACK_H + TRACK_GAP) + TRACK_H}>
                    {s.name.replace(/^Wait until \w+, /, 'Wait to ')}
                  </text>
                )}
              </g>
            ))}

            {billDays.map((bill) => (
              <g key={bill.index} className="wchart-bill">
                <line x1={g.x(bill.index)} x2={g.x(bill.index)} y1={billsTop + 1} y2={billsTop + 8} />
                <circle cx={g.x(bill.index)} cy={billsTop + 10} r={-bill.total >= 100_000 ? 3.5 : 2.5} />
                {namedBills.has(bill.index) && (
                  <text x={g.x(bill.index)} y={billsTop + 25} textAnchor="middle">
                    {bill.name}
                  </text>
                )}
              </g>
            ))}

            {dateTicks(visible.length, plot.w).map((index) => (
              <text key={index} className="wchart-tick" x={g.x(index)} y={axisY} textAnchor={index === 0 ? 'start' : 'middle'} dx={index === 0 ? -g.step / 2 : 0}>
                {shortDate(visible[index]!.date)}
              </text>
            ))}

            <g className={cx('wchart-focus', pinned !== null && hover === null && 'pinned')}>
              <line x1={g.x(focus)} x2={g.x(focus)} y1={plot.y} y2={trackTop + rows * (TRACK_H + TRACK_GAP) - TRACK_GAP} />
              {series.map((s, index) =>
                s.cents[focus] === undefined ? null : (
                  <circle key={s.key} className={index === 0 ? 'main' : 'alt'} cx={g.x(focus)} cy={g.y(s.cents[focus]!)} r={index === 0 ? 5 : 3.5} />
                ),
              )}
            </g>
          </svg>
          <div
            className="wchart-scrub"
            role="slider"
            tabIndex={0}
            aria-label="Balance by day. Arrow keys move a day and pin it; Escape unpins."
            aria-valuemin={0}
            aria-valuemax={visible.length - 1}
            aria-valuenow={focus}
            aria-valuetext={dayLabel(focusPoint.date)}
            style={{ left: plot.x, width: plot.w, top: plot.y, height: trackTop + rows * (TRACK_H + TRACK_GAP) - plot.y }}
            onKeyDown={onKey}
            onPointerMove={(event) => event.pointerType === 'mouse' && setHover(dayAt(event.clientX))}
            onPointerLeave={() => setHover(null)}
            onClick={(event) => {
              const index = dayAt(event.clientX)
              setPinned(pinned === index ? null : index)
              setHover(null)
            }}
          />
        </div>

        <aside className={cx('wchart-day', focusState)} aria-label="Day in focus">
          <div className="head">
            <span className="eyebrow">
              {hover === null && pinned === null ? 'Lowest point' : 'Day in focus'}
            </span>
            {pinned !== null && hover === null && (
              <button type="button" className="wchart-pin" onClick={() => setPinned(null)} aria-label="Pinned. Unpin this day">
                <Pin aria-hidden="true" /> Pinned
              </button>
            )}
          </div>
          <div className="date">{dayLabel(focusPoint.date)}</div>
          <div className="amount num">{signed(focusValue)}</div>
          <div className="state">{STATE_WORDS[focusState]}</div>
          <p className="words">{daySentence(focusPoint, focusValue, cushionCents)}</p>
          {others.length > 0 && (
            <dl className="also">
              {others.map((s) =>
                s.days[focus] ? (
                  <div key={s.key}>
                    <dt>
                      <span className={cx('wchart-swatch', s.style)} aria-hidden />
                      {s.name}
                    </dt>
                    <dd className={cx('num', dayState(s.days[focus]!.minimumCents, cushionCents))}>
                      {signed(s.days[focus]!.minimumCents)}
                    </dd>
                  </div>
                ) : null,
              )}
            </dl>
          )}
        </aside>
      </div>

      <div className="wchart-legend" aria-hidden="true">
        <span><i className="wchart-swatch main" />{name} (each day’s low)</span>
        <span><i className="wchart-pill above" />Above cushion</span>
        <span><i className="wchart-pill below" />Below cushion</span>
        <span><i className="wchart-pill negative" />Below zero</span>
      </div>
      <div className="wchart-live" aria-live="polite">
        {spoken}
      </div>

      <details className="bchart-table">
        <summary>
          View as table
        </summary>
        <div className="bchart-scroll">
          <table>
            <caption>
              Projected balance each day at its low, with that day’s bills taken out before pay
              arrives, against your {money(cushionCents)} cushion.
            </caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">{others.length ? `${name} (day’s low)` : 'Balance (day’s low)'}</th>
                <th scope="col">Against cushion</th>
                {others.map((s) => (
                  <th scope="col" key={s.key}>
                    {s.name}
                  </th>
                ))}
                <th scope="col">What happens</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((point, index) => (
                <tr key={point.date}>
                  <th scope="row">{dayLabel(point.date)}</th>
                  <td className="num">
                    {signed(values[index]!)}
                    {index === low ? ' · lowest point' : ''}
                  </td>
                  <td>{STATE_WORDS[dayState(values[index]!, cushionCents)]}</td>
                  {others.map((s) => (
                    <td className="num" key={s.key}>
                      {s.days[index] ? signed(s.days[index]!.minimumCents) : ''}
                    </td>
                  ))}
                  <td>{namedEvents(point).map(eventText).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}
