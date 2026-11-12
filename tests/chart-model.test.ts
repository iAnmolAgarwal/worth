// The balance chart's words and geometry, pinned to the demo story: Alex on Fri Nov 13 2026 and
// the $1,899 Halden X5, through the real engine.
import { describe, expect, it } from 'vitest'
import { compareOptions } from '../shared/finance.ts'
import { ALEX_CAMERA_ID, ALEX_DEMO_DAY, createCameraScenario, PRODUCTS } from '../shared/seed.ts'
import type { ForecastPoint } from '../shared/types.ts'
import {
  cushionGap,
  dateTicks,
  daySentence,
  dayState,
  domain,
  frame,
  incomeKind,
  lineLabelSpot,
  lowestIndex,
  positionText,
  rangeOptions,
  seriesSummary,
  smoothPath,
  stretchDates,
  stretches,
  tickLabel,
} from '../src/chartModel.ts'

const camera = PRODUCTS.find((p) => p.id === ALEX_CAMERA_ID)!
const c = compareOptions(createCameraScenario(ALEX_DEMO_DAY).profile, [], {
  amountCents: camera.priceCents,
  itemName: camera.name,
  today: ALEX_DEMO_DAY,
  payIn4Eligible: true,
})
if (!c.wait.date || !c.payIn4.available) throw new Error('Expected a wait date and Pay in 4')
const CUSHION = c.cushionCents
const buy = c.buyToday.points
const wait = c.wait.points
const p4 = c.payIn4.points
const lows = (points: ForecastPoint[]) => points.map((point) => point.minimumCents)
const on = (points: ForecastPoint[], date: string) => points.findIndex((p) => p.date === date)

describe('day states and stretches below the cushion', () => {
  it('calls a day above, below the cushion or below zero; at the cushion is above', () => {
    expect(dayState(30_001, 30_000)).toBe('above')
    expect(dayState(30_000, 30_000)).toBe('above')
    expect(dayState(29_999, 30_000)).toBe('below')
    expect(dayState(0, 30_000)).toBe('below')
    expect(dayState(-1, 30_000)).toBe('negative')
  })

  it('finds Buy today’s two stretches: Nov 19–30 (below zero from Nov 20) and Dec 10–14', () => {
    expect(stretches(lows(buy), CUSHION)).toEqual([
      {
        from: on(buy, '2026-11-19'),
        to: on(buy, '2026-11-30'),
        negativeFrom: on(buy, '2026-11-20'),
        recovers: on(buy, '2026-12-01'),
      },
      { from: on(buy, '2026-12-10'), to: on(buy, '2026-12-14'), recovers: on(buy, '2026-12-15') },
    ])
    expect(stretches(lows(wait), CUSHION)).toEqual([])
    expect(stretches(lows(p4), CUSHION)).toEqual([
      { from: on(p4, '2026-11-29'), to: on(p4, '2026-11-30'), recovers: on(p4, '2026-12-01') },
    ])
  })

  it('gives the track one state a day: 6 days below the cushion and 11 below zero for Buy today', () => {
    const states = lows(buy).map((cents) => dayState(cents, CUSHION))
    expect(states.filter((state) => state === 'below')).toHaveLength(6)
    expect(states.filter((state) => state === 'negative')).toHaveLength(11)
    expect(states[on(buy, '2026-11-18')]).toBe('above')
    expect(states[on(buy, '2026-11-19')]).toBe('below')
    expect(states[on(buy, '2026-11-20')]).toBe('negative')
    expect(states[on(buy, '2026-12-01')]).toBe('above')
    expect(new Set(lows(wait).map((cents) => dayState(cents, CUSHION)))).toEqual(new Set(['above']))
  })

  it('names a stretch by its dates, as the chips and the band do', () => {
    const [first, second] = stretches(lows(buy), CUSHION)
    expect(stretchDates(first!, buy)).toBe('Nov 19 – Nov 30')
    expect(stretchDates(second!, buy)).toBe('Dec 10 – Dec 14')
    expect(stretchDates({ from: 3, to: 3, recovers: 4 }, buy)).toBe('Nov 16')
    // A stretch that runs to the end of the window has no end date to give.
    expect(stretchDates({ from: 6, to: 60 }, buy)).toBe('from Nov 19')
  })
})

describe('the summary sentence for a line', () => {
  it('says Wait stays above the cushion, with its lowest point', () => {
    expect(seriesSummary(wait, lows(wait), CUSHION)).toBe(
      'Stays above your $300.00 cushion. Lowest $458.78 on Thu, Dec 31.',
    )
    expect(lowestIndex(lows(wait))).toBe(on(wait, '2026-12-31'))
  })

  it('leads Buy today with the first dip and the first day below zero, and stays short', () => {
    expect(seriesSummary(buy, lows(buy), CUSHION)).toBe(
      'Below your $300.00 cushion from Thu, Nov 19 and below zero from Fri, Nov 20. Lowest −$726.74 on Mon, Nov 30.',
    )
  })

  it('says when a single stretch is over: Pay in 4 dips on Nov 29 and is back on Dec 1', () => {
    expect(seriesSummary(p4, lows(p4), CUSHION)).toBe(
      'Below your $300.00 cushion from Sun, Nov 29. Lowest $222.76 on Mon, Nov 30. Back above on Tue, Dec 1.',
    )
  })
})

describe('the sentence for the day in focus', () => {
  const sentence = (points: ForecastPoint[], date: string) => {
    const point = points[on(points, date)]!
    return daySentence(point, point.minimumCents, CUSHION, incomeKind(point, points))
  }

  it('says what moves that day, then where it leaves the balance', () => {
    expect(sentence(wait, '2026-12-01')).toBe(
      'Rent $1,750.00 goes out. You are $2,982.26 above your cushion.',
    )
  })

  it('says a payday’s low comes before the pay, and counts both gaps below zero', () => {
    expect(sentence(buy, '2026-11-30')).toBe(
      'Payday: Salary $3,900.00 lands. You are $726.74 below zero, $1,026.74 below your cushion. The day’s low comes before the pay arrives.',
    )
  })

  it('calls the Dec 14 invoice income, not a payday', () => {
    const invoice = wait[on(wait, '2026-12-14')]!
    expect(incomeKind(invoice, wait)).toBe('Income')
    expect(incomeKind(wait[on(wait, '2026-11-30')]!, wait)).toBe('Payday')
    expect(incomeKind(wait[on(wait, '2026-12-02')]!, wait)).toBeUndefined()
    expect(sentence(wait, '2026-12-14')).toMatch(/^Income: .+ \$1,650\.00 lands\. /)
  })

  it('words every position against the cushion', () => {
    expect(positionText(45_878, 30_000)).toBe('You are $158.78 above your cushion.')
    expect(positionText(30_000, 30_000)).toBe('You are exactly at your cushion.')
    expect(positionText(22_276, 30_000)).toBe('You are $77.24 below your cushion.')
    expect(positionText(-72_674, 30_000)).toBe(
      'You are $726.74 below zero, $1,026.74 below your cushion.',
    )
  })

  it('names the cushion in every gap, so it never reads as a second balance', () => {
    expect(cushionGap(95_052, 30_000)).toBe('$650.52 more than your $300.00 cushion')
    expect(cushionGap(30_000, 30_000)).toBe('exactly your $300.00 cushion')
    expect(cushionGap(-45_899, 30_000)).toBe('$758.99 short of your $300.00 cushion')
  })
})

describe('the range control', () => {
  it('offers to payday, 30 days and the whole window for Alex', () => {
    expect(rangeOptions(wait)).toEqual([
      // Nov 30 is day 17; two more days show the pay arriving.
      { key: 'payday', label: 'To payday', days: on(wait, '2026-11-30') + 3 },
      { key: 'month', label: '30 days', days: 31 },
      { key: 'all', label: '60 days', days: 61 },
    ])
  })

  it('offers only the whole window when it is short and has no payday', () => {
    const quiet = wait.slice(0, 10).map((point) => ({ ...point, events: [] }))
    expect(rangeOptions(quiet)).toEqual([{ key: 'all', label: '9 days', days: 10 }])
  })
})

describe('scales', () => {
  it('keeps zero in view and steps in whole thousands', () => {
    expect(domain(lows(wait), CUSHION)).toEqual({
      lo: 0,
      hi: 400_000,
      ticks: [0, 100_000, 200_000, 300_000, 400_000],
    })
    expect(domain([...lows(wait), ...lows(buy)], CUSHION).lo).toBe(-100_000)
    expect(tickLabel(0)).toBe('$0')
    expect(tickLabel(200_000)).toBe('$2k')
    expect(tickLabel(-100_000)).toBe('−$1k')
    expect(tickLabel(50_000)).toBe('$500')
  })

  it('keeps date ticks sparse', () => {
    expect(dateTicks(61, 520)).toEqual([0, 14, 28, 42, 56])
    expect(dateTicks(61, 240).length).toBeLessThanOrEqual(3)
  })
})

/** Every cubic segment of a path, sampled. */
function sampled(path: string) {
  const numbers = path.match(/-?\d+(\.\d+)?/g)!.map(Number)
  const segments: { from: [number, number]; to: [number, number]; ys: number[] }[] = []
  let [x0, y0] = [numbers[0]!, numbers[1]!]
  for (let i = 2; i < numbers.length; i += 6) {
    const [, c1y, , c2y, x1, y1] = numbers.slice(i, i + 6) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ]
    const ys = Array.from({ length: 21 }, (_, step) => {
      const t = step / 20
      const u = 1 - t
      return u ** 3 * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t ** 3 * y1
    })
    segments.push({ from: [x0, y0], to: [x1, y1], ys })
    ;[x0, y0] = [x1, y1]
  }
  return segments
}

describe('the smooth line is honest', () => {
  const g = frame(662, 61, [...lows(wait), ...lows(buy), ...lows(p4)], CUSHION, 40)
  const path = (points: ForecastPoint[]) =>
    smoothPath(lows(points).map((cents, index) => ({ x: g.x(index), y: g.y(cents) })))

  it.each([
    ['Wait', wait],
    ['Buy today', buy],
    ['Pay in 4', p4],
  ])('never leaves the range between two neighbouring days (%s)', (_name, points) => {
    const segments = sampled(path(points))
    expect(segments).toHaveLength(60)
    for (const segment of segments) {
      const low = Math.min(segment.from[1], segment.to[1]) - 0.06
      const high = Math.max(segment.from[1], segment.to[1]) + 0.06
      for (const y of segment.ys) {
        expect(y).toBeGreaterThanOrEqual(low)
        expect(y).toBeLessThanOrEqual(high)
      }
    }
  })

  it('bottoms out exactly on the real lowest day, and Wait never reaches the cushion', () => {
    const ys = sampled(path(wait)).flatMap((segment) => segment.ys)
    // SVG y grows downwards: the largest y is the lowest balance drawn.
    expect(Math.max(...ys)).toBeCloseTo(g.y(45_878), 1)
    expect(Math.max(...ys)).toBeLessThan(g.y(CUSHION))
    const bought = sampled(path(buy)).flatMap((segment) => segment.ys)
    expect(Math.max(...bought)).toBeCloseTo(g.y(-72_674), 1)
  })

  it('passes through every day’s real value', () => {
    const segments = sampled(path(buy))
    segments.forEach((segment, index) => {
      expect(segment.from[1]).toBeCloseTo(g.y(lows(buy)[index]!), 1)
    })
  })
})

describe('naming a compare line on the plot', () => {
  const g = frame(662, 61, [...lows(wait), ...lows(buy)], CUSHION, 40)
  const ys = (points: ForecastPoint[]) => lows(points).map((cents) => g.y(cents))

  it('finds a spot clear of the other line, the cushion and zero', () => {
    const levels = [g.y(CUSHION), g.y(0)]
    const spot = lineLabelSpot(ys(buy), [ys(wait)], levels, g, 60)!
    expect(spot).toBeTruthy()
    const box = { top: spot.y - 10, bottom: spot.y + 2 }
    const start = Math.round((spot.x - g.x(0)) / g.step)
    for (const y of [...levels, ...ys(wait).slice(start, start + Math.ceil(60 / g.step) + 1)])
      expect(y < box.top - 2 || y > box.bottom + 2).toBe(true)
    expect(box.top).toBeGreaterThanOrEqual(g.plot.y)
    expect(box.bottom).toBeLessThanOrEqual(g.plot.y + g.plot.h)
  })

  it('leaves the name out when the line sits on another all the way', () => {
    expect(lineLabelSpot(ys(wait), [ys(wait)], [], g, 60)).toBeUndefined()
  })
})
