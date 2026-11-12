import type { ForecastPoint, InstalmentDetail } from '../shared/types'
import { Fragment, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Pin } from 'lucide-react'
import {
  BIG_BILL_CENTS,
  dateTicks,
  daySentence,
  dayState,
  frame,
  incomeKind,
  lowestIndex,
  moneyDays,
  namedEvents,
  rangeOptions,
  seriesSummary,
  smoothPath,
  STATE_WORDS,
  stretchDates,
  stretches,
  textWidth,
  tickLabel,
  type RangeKey,
} from './chartModel'
import { cx, dayLabel, money, shortDate, signed } from './format'
import './chart.css'

export type Tone = 'amber' | 'violet' | 'teal'
const TONES: Tone[] = ['amber', 'violet', 'teal']
const NO_DAYS: ForecastPoint[] = []

/** One way to make the purchase (or the plan as it stands), as a line on the chart. */
export interface ChartOption {
  key: string
  /** The pill, summary and legend name: "Buy today". */
  name: string
  points: ForecastPoint[]
  /** Its colour when it is not the option the page is showing; red and green keep their meanings. */
  tone?: Tone
  /** Starts pressed although the page shows another option (the page opened this comparison). */
  on?: boolean
  /** The day the purchase is paid for on this line; `fits` marks it as the day it fits. */
  purchase?: { date: string; fits?: boolean }
  /** Pay in 4's payments, named on their days in the table. */
  instalments?: InstalmentDetail[]
  /** A sentence for the text alternative while this line is drawn beside the page's option. */
  note?: string
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

const eventText = (event: { name: string; amountCents: number }) =>
  `${event.name} ${signed(event.amountCents, event.amountCents > 0)}`
/** Amounts never break between the minus sign and the figure. */
const amounts = (text: string) =>
  text.split(/(−?\$[\d,.]*\d)/).map((part, index) =>
    index % 2 ? (
      <span className="num nowrap" key={index}>
        {part}
      </span>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  )

/**
 * The balance chart: one line per option against the cushion. The pills are the options; the one
 * the page is showing starts pressed and is the bold line, the others add theirs when pressed.
 * Days money comes in carry a green line and days it goes out a red one. Where a line is below
 * the cushion the region is shaded red, and the day in focus is spelled out in words. Plain SVG,
 * with a keyboard scrubber and a table.
 */
export function BalanceChart({
  options,
  selected,
  cushionCents,
  label,
}: {
  options: ChartOption[]
  /** The option the page is showing. */
  selected: string
  cushionCents: number
  /** The text alternative's first sentence. */
  label: string
}) {
  const id = useId().replace(/:/g, '')
  const [wrap, width] = useWidth()
  const defaults = options
    .filter((option) => option.key === selected || option.on)
    .map((option) => option.key)
    .join('|')
  const [shown, setShown] = useState(() => new Set(defaults.split('|')))
  const [range, setRange] = useState<RangeKey>('all')
  const [hover, setHover] = useState<number | null>(null)
  const [pinned, setPinned] = useState<number | null>(null)
  const [spoken, setSpoken] = useState('')

  // A new option on the page, or the page opening a comparison itself, resets what is pressed
  // and which day is pinned (adjusted during render, not in an effect).
  const window = `${selected}|${options[0]?.points[0]?.date}|${options[0]?.points.length}`
  const [seen, setSeen] = useState({ window, defaults })
  if (seen.window !== window || seen.defaults !== defaults) {
    setShown(new Set(defaults.split('|')))
    if (seen.window !== window) {
      setPinned(null)
      setHover(null)
    }
    setSeen({ window, defaults })
  }

  // The bold line is the page's option while it is pressed, otherwise the first pressed one.
  const pressed = options.filter((option) => shown.has(option.key))
  const primary = pressed.find((option) => option.key === selected) ?? pressed[0] ?? options[0]
  const points = primary?.points ?? NO_DAYS
  if (!primary || !points.length) return null
  const ranges = rangeOptions(points)
  const days = Math.min(
    points.length,
    (ranges.find((option) => option.key === range) ?? ranges.at(-1))?.days ?? 0,
  )
  const visible = points.slice(0, days)
  // Lowest point, stretches and the words are always for the whole window; the range only
  // changes what is drawn.
  const allValues = points.map((point) => point.minimumCents)
  const values = allValues.slice(0, days)
  const toneOf = (option: ChartOption) =>
    option.key === selected
      ? 'tone-main'
      : `tone-${option.tone ?? TONES[options.filter((o) => o.key !== selected).indexOf(option) % 3]}`
  const series = (primary ? [primary, ...pressed.filter((option) => option !== primary)] : []).map(
    (option) => {
      const byDate = new Map(option.points.map((point) => [point.date, point]))
      const all = points.map((point) => byDate.get(point.date))
      const own = all.flatMap((point) => (point ? [point] : []))
      const ownValues = own.map((point) => point.minimumCents)
      const cents = all.slice(0, days).map((point) => point?.minimumCents)
      // The days a line is below the cushion, and below zero, as the engine's numbers have
      // them: its red region starts and ends on those days, never where the curve crosses. A
      // day exactly at the cushion is not below it.
      const drawn = cents.map((value) => value ?? cushionCents)
      return {
        key: option.key,
        name: option.name,
        style: toneOf(option),
        instalments: option.instalments,
        all,
        own,
        cents,
        // Its own lowest day in the window (the first, as the engine counts a tie).
        low: all.indexOf(own[lowestIndex(ownValues)]),
        text: seriesSummary(own, ownValues, cushionCents),
        runs: stretches(ownValues, cushionCents),
        dips: stretches(drawn, cushionCents),
        deep: stretches(drawn, 0),
      }
    },
  )
  const g = frame(
    width,
    Math.max(1, days),
    series.flatMap((s) => s.cents.flatMap((value) => (value === undefined ? [] : [value]))),
    cushionCents,
    24,
  )

  const { plot } = g
  const narrow = width < 480
  const main = series[0]!
  const low = lowestIndex(allValues)
  const anyNegative = series.some((s) => s.cents.some((value) => value !== undefined && value < 0))
  const focus = Math.min(hover ?? pinned ?? low, points.length - 1)
  const focusPoint = points[focus]!
  const focusValue = allValues[focus]!
  const focusState = dayState(focusValue, cushionCents)
  const buyIndex = primary.purchase
    ? visible.findIndex((point) => point.date === primary.purchase!.date)
    : -1

  const sentence = (index: number) =>
    daySentence(points[index]!, allValues[index]!, cushionCents, incomeKind(points[index]!, points))
  const describe = (index: number) =>
    `${dayLabel(points[index]!.date)}. Day’s low ${signed(allValues[index]!)}. ${sentence(index)}`
  const move = (index: number) => {
    const next = Math.max(0, Math.min(days - 1, index))
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
  /** At least one pill always stays pressed. */
  const toggle = (key: string) =>
    setShown((previous) => {
      const next = new Set(previous)
      if (!next.delete(key)) next.add(key)
      return next.size ? next : previous
    })
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowUp: 1,
      ArrowLeft: -1,
      ArrowDown: -1,
      PageUp: 7,
      PageDown: -7,
    }
    if (event.key in step) move(Math.min(focus, days - 1) + step[event.key]!)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(days - 1)
    else if (event.key === 'Escape' && pinned !== null) setPinned(null)
    else return
    event.preventDefault()
  }
  const dayAt = (clientX: number) =>
    g.indexAt(clientX - (wrap.current?.getBoundingClientRect().left ?? 0))

  const linePoints = (cents: (number | undefined)[]) =>
    cents.flatMap((value, index) => (value === undefined ? [] : [{ x: g.x(index), y: g.y(value) }]))
  const mainPoints = linePoints(values)
  const mainPath = smoothPath(mainPoints)
  const floor = plot.y + plot.h
  const cushionY = g.y(cushionCents)
  const zeroY = Math.max(g.y(0), cushionY + 13)
  const areaPath = `${mainPath}L${g.x(days - 1)},${floor}L${g.x(0)},${floor}Z`
  /** The columns of a run of days, as a clip rectangle. */
  const columns = (run: { from: number; to: number }) => ({
    x: g.x(run.from) - g.step / 2,
    y: plot.y,
    width: (run.to - run.from + 1) * g.step,
    height: plot.h + 4,
  })
  // The blue fill covers only the days at or above the cushion.
  const clear = stretches(
    values.map((value) => (value < cushionCents ? 0 : -1)),
    0,
  )

  // Money in and money out: a green line on every day pay or other income lands, a red one on
  // every day a bill, subscription or plan payment leaves. A day with both draws both.
  const flows = moneyDays(visible)
  const both = new Set(
    flows
      .filter(
        (day) => day.kind === 'in' && flows.some((o) => o.kind === 'out' && o.index === day.index),
      )
      .map((day) => day.index),
  )
  const moneyX = (day: { index: number; kind: 'in' | 'out' }) =>
    g.x(day.index) + (both.has(day.index) ? (day.kind === 'in' ? -1.5 : 1.5) : 0)

  // The lane above the plot: the purchase first, then today, then money in, then the largest
  // money out; a label that would touch one already placed is left out (its line stays).
  const marks = [
    ...(buyIndex >= 0
      ? [
          {
            x: g.x(buyIndex),
            kind: primary.purchase!.fits ? 'fits' : 'buy',
            text: `${primary.purchase!.fits ? 'Fits' : 'Buy'} ${shortDate(primary.purchase!.date)}`,
          },
        ]
      : []),
    ...(buyIndex !== 0 ? [{ x: g.x(0), kind: 'today', text: 'Today' }] : []),
    ...flows
      .filter((day) => day.kind === 'in')
      .map((day) => {
        const text = incomeKind(visible[day.index]!, points) ?? 'Payday'
        return { x: moneyX(day), kind: text.toLowerCase(), text }
      }),
    ...flows
      .filter((day) => day.kind === 'out' && -day.cents >= BIG_BILL_CENTS)
      .sort((a, b) => a.cents - b.cents)
      .map((day) => ({ x: moneyX(day), kind: 'bill', text: day.name })),
  ]
  const taken: [number, number][] = []
  const lane = marks.map((mark) => {
    const w = textWidth(mark.text, 11, 600)
    const x = Math.max(plot.x + w / 2, Math.min(plot.x + plot.w - w / 2, mark.x))
    const span: [number, number] = [x - w / 2 - 5, x + w / 2 + 5]
    const labelled = taken.every(([a, b]) => span[1] < a || span[0] > b)
    if (labelled) taken.push(span)
    return { ...mark, labelX: x, labelled }
  })

  const others = series.slice(1)
  const notes = options
    .filter((option) => option.note && shown.has(option.key) && shown.has(selected))
    .map((option) => `${option.note} `)
    .join('')
  const alt = `${label} ${notes}${series.map((s) => `${s.name}: ${s.text}`).join(' ')}`
  const axisY = g.height - 6

  return (
    <div className="wchart">
      <ul className="wchart-summary">
        {series.map((s, index) => (
          <li key={s.key} className={cx(s.runs.length > 0 && 'dips')}>
            <span className="words">
              {series.length > 1 && <b>{s.name}: </b>}
              {amounts(s.text)}
            </span>
            <span className="jumps">
              {s.runs.map((run) => (
                <button
                  type="button"
                  className="wchart-jump bad"
                  key={run.from}
                  onClick={() => jump(s.own[run.from]!.date)}
                >
                  Below cushion {stretchDates(run, s.own)}
                </button>
              ))}
              {index === 0 && (
                <button
                  type="button"
                  className="wchart-jump"
                  onClick={() => jump(points[low]!.date)}
                >
                  Lowest point {shortDate(points[low]!.date)}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>

      <div className="wchart-controls">
        {options.length > 1 && (
          <div className="wchart-toggles" role="group" aria-label="Options on the chart">
            {options.map((option) => (
              <button
                type="button"
                key={option.key}
                className={cx('wchart-chip', toneOf(option))}
                aria-pressed={shown.has(option.key)}
                onClick={() => toggle(option.key)}
              >
                {option.name}
              </button>
            ))}
          </div>
        )}
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
                  setHover(null)
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
              {/* Below the cushion the region turns red, on the line's below days; the line itself
                  keeps its option's colour for its whole length. */}
              <clipPath id={`${id}-under`}>
                <rect
                  x={0}
                  y={cushionY}
                  width={g.width}
                  height={Math.max(0, floor - cushionY + 4)}
                />
              </clipPath>
              <clipPath id={`${id}-zero`}>
                <rect x={0} y={g.y(0)} width={g.width} height={Math.max(0, floor - g.y(0) + 4)} />
              </clipPath>
              <clipPath id={`${id}-clear`}>
                {clear.map((run) => (
                  <rect key={run.from} {...columns(run)} />
                ))}
              </clipPath>
              {series.map((s) => (
                <Fragment key={s.key}>
                  <clipPath
                    id={`${id}-dips-${s.key}`}
                    className="wchart-dipdays"
                    data-series={s.key}
                  >
                    {s.dips.map((run) => (
                      <rect
                        key={run.from}
                        {...columns(run)}
                        data-from={visible[run.from]!.date}
                        data-to={visible[run.to]!.date}
                      />
                    ))}
                  </clipPath>
                  <clipPath id={`${id}-deep-${s.key}`}>
                    {s.deep.map((run) => (
                      <rect key={run.from} {...columns(run)} />
                    ))}
                  </clipPath>
                </Fragment>
              ))}
            </defs>

            {g.ticks.map((cents) => (
              <g key={cents}>
                <line
                  className="wchart-grid"
                  x1={plot.x}
                  x2={plot.x + plot.w}
                  y1={g.y(cents)}
                  y2={g.y(cents)}
                />
                <text className="wchart-tick" x={plot.x - 8} y={g.y(cents) + 4} textAnchor="end">
                  {tickLabel(cents)}
                </text>
              </g>
            ))}

            {/* Money in (green) and money out (red), behind the fills and the option lines. */}
            {flows.map((day) => (
              <line
                key={`${day.kind}${day.index}`}
                className={cx('wchart-money', day.kind)}
                data-date={day.date}
                x1={moneyX(day)}
                x2={moneyX(day)}
                y1={plot.y}
                y2={floor}
              />
            ))}
            {lane.map((mark) => (
              <g key={`${mark.kind}${mark.x}`} className={cx('wchart-mark', mark.kind)}>
                {(mark.kind === 'today' || mark.kind === 'fits' || mark.kind === 'buy') && (
                  <line x1={mark.x} x2={mark.x} y1={plot.y} y2={floor} />
                )}
                {mark.labelled && (
                  <text x={mark.labelX} y={plot.y - 10} textAnchor="middle">
                    {mark.text}
                  </text>
                )}
              </g>
            ))}

            <path
              className="wchart-area"
              d={areaPath}
              fill={`url(#${id}-area)`}
              clipPath={`url(#${id}-clear)`}
            />
            {/* The bold option below its cushion: red from the cushion down, on those days. */}
            {main.dips.length > 0 && (
              <g className="wchart-dip main">
                <rect
                  x={plot.x}
                  y={cushionY}
                  width={plot.w}
                  height={floor - cushionY}
                  clipPath={`url(#${id}-dips-${main.key})`}
                />
                <rect
                  className="deep"
                  x={plot.x}
                  y={g.y(0)}
                  width={plot.w}
                  height={Math.max(0, floor - g.y(0))}
                  clipPath={`url(#${id}-deep-${main.key})`}
                />
              </g>
            )}
            {/* Another option below the cushion: the gap between the cushion and its line, laid
                over a plain ground so the blue fill never shows through the red. A thin strip
                at the cushion keeps a shallow dip from vanishing. */}
            {others.map((s) => {
              if (!s.dips.length) return null
              const gap = `${smoothPath(linePoints(s.cents))}L${g.x(days - 1)},${cushionY}L${g.x(0)},${cushionY}Z`
              return (
                <g key={s.key} className="wchart-dip">
                  <g clipPath={`url(#${id}-dips-${s.key})`}>
                    <path className="ground" d={gap} clipPath={`url(#${id}-under)`} />
                    <path d={gap} clipPath={`url(#${id}-under)`} />
                    <rect className="edge" x={plot.x} y={cushionY} width={plot.w} height={3} />
                  </g>
                  <g clipPath={`url(#${id}-deep-${s.key})`}>
                    <path className="deep" d={gap} clipPath={`url(#${id}-zero)`} />
                  </g>
                </g>
              )
            })}

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

            {others.map((s) => (
              <path
                key={s.key}
                className={cx('wchart-alt', s.style)}
                d={smoothPath(linePoints(s.cents))}
              />
            ))}
            <g className={main.style}>
              <path className="wchart-line" d={mainPath} />
              {g.step >= 7 &&
                mainPoints.map((point, index) => (
                  <circle key={index} className="wchart-dot" cx={point.x} cy={point.y} r={1.6} />
                ))}
              {low < days && (
                <circle className="wchart-low" cx={g.x(low)} cy={g.y(values[low]!)} r={5} />
              )}
            </g>
            {/* The lowest day is out of view: say where it is instead of marking another day. */}
            {low >= days && (
              <text
                className="wchart-edge"
                x={plot.x + plot.w - 4}
                y={plot.y + 14}
                textAnchor="end"
              >
                Lowest point {shortDate(points[low]!.date)} →
              </text>
            )}
            {buyIndex >= 0 && (
              <circle
                className={cx('wchart-buy', primary.purchase!.fits && 'fits')}
                cx={g.x(buyIndex)}
                cy={g.y(values[buyIndex]!)}
                r={5.5}
              />
            )}

            {dateTicks(days, plot.w).map((index) => (
              <text
                key={index}
                className="wchart-tick"
                x={g.x(index)}
                y={axisY}
                textAnchor={index === 0 ? 'start' : 'middle'}
                dx={index === 0 ? -g.step / 2 : 0}
              >
                {shortDate(visible[index]!.date)}
              </text>
            ))}

            {focus < days && (
              <g className={cx('wchart-focus', pinned !== null && hover === null && 'pinned')}>
                <line x1={g.x(focus)} x2={g.x(focus)} y1={plot.y} y2={floor} />
                {[...series]
                  .reverse()
                  .map((s) =>
                    s.cents[focus] === undefined ? null : (
                      <circle
                        key={s.key}
                        className={s.style}
                        cx={g.x(focus)}
                        cy={g.y(s.cents[focus]!)}
                        r={s === main ? 5 : 3.5}
                      />
                    ),
                  )}
              </g>
            )}
          </svg>
          <div
            className="wchart-scrub"
            role="slider"
            tabIndex={0}
            aria-label="Balance by day. Arrow keys move a day and pin it; Escape unpins."
            aria-valuemin={0}
            aria-valuemax={days - 1}
            aria-valuenow={Math.min(focus, days - 1)}
            aria-valuetext={dayLabel(focusPoint.date)}
            style={{ left: plot.x, width: plot.w, top: plot.y, height: plot.h }}
            onKeyDown={onKey}
            onPointerMove={(event) =>
              event.pointerType === 'mouse' && setHover(dayAt(event.clientX))
            }
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
              <button
                type="button"
                className="wchart-pin"
                onClick={() => setPinned(null)}
                aria-label="Pinned. Unpin this day"
              >
                <Pin aria-hidden="true" /> Pinned
              </button>
            )}
          </div>
          <div className="date">{dayLabel(focusPoint.date)}</div>
          <div className="amount num">{signed(focusValue)}</div>
          <div className="state">{STATE_WORDS[focusState]}</div>
          <p className="words">{amounts(sentence(focus))}</p>
          {others.length > 0 && (
            <dl className="also" aria-label="The other options on this day">
              <div className="also-head">Same day, other options</div>
              {others.map((s) => {
                const cents = s.all[focus]?.minimumCents
                return cents === undefined ? null : (
                  <div key={s.key}>
                    <dt>
                      <span className={cx('wchart-swatch', s.style)} aria-hidden />
                      {s.name}
                    </dt>
                    <dd className={cx('num', dayState(cents, cushionCents))}>
                      {signed(cents)}
                      <span> · {STATE_WORDS[dayState(cents, cushionCents)]}</span>
                    </dd>
                  </div>
                )
              })}
            </dl>
          )}
        </aside>
      </div>

      <div className="wchart-legend" aria-hidden="true">
        {series.map((s) => (
          <span key={s.key} className={s.style}>
            <i className="wchart-swatch" />
            {s.name}
          </span>
        ))}
        <span>
          <i className="wchart-swatch in" />
          Money in
        </span>
        <span>
          <i className="wchart-swatch out" />
          Money out
        </span>
        <span>
          <i className="wchart-swatch cushion" />
          Cushion
        </span>
        <span>
          <i className="wchart-pill below" />
          Below cushion
        </span>
      </div>
      <div className="wchart-live" aria-live="polite">
        {spoken}
      </div>

      <details className="wchart-table">
        <summary>View as table</summary>
        <div
          className="wchart-scroll"
          tabIndex={0}
          role="region"
          aria-label="Balance by day, as a table"
        >
          <table>
            <caption>
              Projected balance each day at its low, with that day’s bills taken out before pay
              arrives, against your {money(cushionCents)} cushion.{' '}
              {series.map((s) => `${s.name}: ${s.text}`).join(' ')}
            </caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">
                  {series.length > 1 ? `${main.name} (day’s low)` : 'Balance (day’s low)'}
                </th>
                <th scope="col">Against cushion</th>
                <th scope="col">What happens</th>
                {others.map((s) => (
                  <th scope="col" key={s.key}>
                    {s.name} (day’s low)
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((point, index) => (
                // Each balance is red only when it is itself below the cushion, and says so in
                // words: every column is judged on its own value, as the engine judges it.
                <tr key={point.date}>
                  <th scope="row">{dayLabel(point.date)}</th>
                  <td className={cx('num', allValues[index]! < cushionCents && 'below')}>
                    {signed(allValues[index]!)}
                    {index === low ? ' · lowest point' : ''}
                  </td>
                  <td>{STATE_WORDS[dayState(allValues[index]!, cushionCents)]}</td>
                  <td>{namedEvents(point).map(eventText).join(', ') || '—'}</td>
                  {others.map((s) => {
                    const cents = s.all[index]?.minimumCents
                    if (cents === undefined) return <td key={s.key}>—</td>
                    const instalment = s.instalments?.find((i) => i.date === point.date)
                    return (
                      <td className={cx('num', cents < cushionCents && 'below')} key={s.key}>
                        {signed(cents)}
                        {instalment ? ` · payment ${instalment.number} of 4` : ''}
                        {index === s.low ? ' · lowest point' : ''}
                        {cents < cushionCents ? ' · below cushion' : ''}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}
