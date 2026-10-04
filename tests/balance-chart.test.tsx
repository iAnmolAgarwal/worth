// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { BalanceChart } from '../src/BalanceChart'
import {
  eventRules,
  geometry,
  overlaps,
  placeLabels,
  placePopover,
  ringCandidates,
  stepPath,
  type Box,
} from '../src/chartLayout'
import { compareOptions } from '../shared/finance'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type { Comparison } from '../shared/types'

const TODAY = '2026-10-03'

function comparison(productId: string): Comparison {
  const state = createDemoState(TODAY)
  const product = PRODUCTS.find((p) => p.id === productId)!
  return compareOptions(state.profile, state.purchases, {
    amountCents: product.priceCents,
    itemName: product.name,
    today: TODAY,
    payIn4Eligible: true,
  })
}

afterEach(cleanup)

describe('chart layout', () => {
  const c = comparison('chair')
  const points = c.spendLess.points
  const values = points.map((point) => point.minimumCents)

  it('draws the daily lowest balance as steps, never as slopes', () => {
    const g = geometry(880, 284, points.length, values, c.cushionCents)
    const path = stepPath(values, g)
    // Only horizontal and vertical moves after the first point.
    expect(path.replace(/^M[\d.,-]+/, '')).toMatch(/^([HV][\d.-]+)+$/)
  })

  it.each([880, 340])(
    'gives every payday and big bill a rule whose hit areas never overlap (%ipx)',
    (width) => {
      const g = geometry(width, width < 480 ? 236 : 284, points.length, values, c.cushionCents)
      const rules = eventRules(points, g, 12)
      expect(rules.some((rule) => rule.kind === 'payday')).toBe(true)
      expect(rules.some((rule) => rule.kind === 'bill')).toBe(true)
      for (const [index, rule] of rules.entries()) {
        expect(rule.hit.left).toBeLessThanOrEqual(rule.x)
        expect(rule.hit.right).toBeGreaterThanOrEqual(rule.x)
        const next = rules[index + 1]
        if (next) expect(rule.hit.right).toBeLessThanOrEqual(next.hit.left + 0.001)
      }
      // Rent drops the balance where its day begins; the paycheck lifts it where its day ends.
      const rent = rules.find((rule) => rule.events.some((e) => e.name === 'Apartment rent'))!
      expect(rent.x).toBeLessThan(g.x(rent.index))
      const pay = rules.find((rule) => rule.kind === 'payday')!
      expect(pay.x).toBeGreaterThan(g.x(pay.index))
    },
  )

  it.each([880, 340])(
    'places labels without overlapping each other or the line (%ipx)',
    (width) => {
      const g = geometry(width, width < 480 ? 236 : 284, points.length, values, c.cushionCents)
      const low = values.indexOf(Math.min(...values))
      const lx = g.x(low)
      const ly = g.y(values[low]!)
      const placed = placeLabels(
        [
          {
            id: 'low',
            w: 120,
            h: 36,
            required: true,
            candidates: ringCandidates(lx, ly, 120, 36, [10, 24, 40, 60]),
          },
          {
            id: 'buy',
            w: 140,
            h: 18,
            required: true,
            lane: true,
            candidates: [{ x: g.x(0) + 6, y: 4, cost: 0 }],
          },
          { id: 'extra', w: 110, h: 20, candidates: ringCandidates(lx, ly, 110, 20) },
        ],
        {
          g,
          values: [values],
          obstacles: [{ x: lx - 8, y: ly - 8, w: 16, h: 16 }],
          bounds: { x: g.plot.x, y: 0, w: g.plot.w, h: g.plot.y + g.plot.h },
        },
      )
      expect(placed.map((box) => box.id)).toContain('low')
      for (const a of placed)
        for (const b of placed) if (a !== b) expect(overlaps(a, b)).toBe(false)
      const lowBox = placed.find((box) => box.id === 'low')!
      expect(overlaps(lowBox, { x: lx - 8, y: ly - 8, w: 16, h: 16 })).toBe(false)
    },
  )

  it('puts a rule card beside its rule, clear of the low point, or docks it under the chart', () => {
    const g = geometry(880, 284, points.length, values, c.cushionCents)
    const avoid: Box[] = [{ x: 600, y: 200, w: 120, h: 40 }]
    const card = { w: 280, h: 160 }
    const beside = placePopover({ x: 200 }, card, g, avoid)
    expect(beside.side).toBe('right')
    if (beside.side !== 'below') {
      const box = { x: beside.left, y: beside.top, ...card }
      expect(box.x).toBeGreaterThan(200)
      expect(avoid.some((other) => overlaps(box, other))).toBe(false)
    }
    // Near the right edge it flips to the left of the rule.
    const flipped = placePopover({ x: 820 }, card, g, [])
    expect(flipped.side).toBe('left')
    if (flipped.side !== 'below') expect(flipped.left + card.w).toBeLessThan(820)
    // With no clear side it docks under the chart instead of covering anything.
    const blocked = placePopover({ x: 440 }, card, g, [{ x: 0, y: 0, w: 880, h: 284 }])
    expect(blocked.side).toBe('below')
  })
})

describe('BalanceChart', () => {
  const c = comparison('chair')
  const option = c.spendLess
  const highlight = {
    billDate: option.lowPointCause?.date,
    paydayDate: option.points.find(
      (point) =>
        point.date >= option.lowestDate && point.events.some((event) => event.kind === 'income'),
    )?.date,
  }
  const chart = (extra: Partial<Parameters<typeof BalanceChart>[0]> = {}) => (
    <BalanceChart
      points={option.points}
      cushionCents={c.cushionCents}
      purchase={{ date: option.purchaseDate, amountCents: option.amountCents }}
      highlight={highlight}
      label="Projected balance if you spend less."
      {...extra}
    />
  )

  it('keeps a text alternative and a table of every day', async () => {
    const user = userEvent.setup()
    render(chart())
    expect(
      screen.getByRole('img', { name: /^Projected balance/ }).getAttribute('aria-label'),
    ).toMatch(/Big bills: .*Apartment rent/)
    await user.click(screen.getByText('View as table'))
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(option.points.length + 1)
    expect(within(table).getByRole('rowheader', { name: 'Thu, Oct 22' })).toBeTruthy()
    expect(table.textContent).toContain('at your cushion')
  })

  it('opens a bill line on click and says what it means, then closes with Escape', async () => {
    const user = userEvent.setup()
    render(chart())
    const rent = screen.getByRole('button', { name: /^Fri, Oct 16: Apartment rent/ })
    await user.click(rent)
    const card = screen.getByRole('dialog', { name: 'Bill · Fri, Oct 16' })
    expect(card.textContent).toContain('−$1,450.00')
    expect(card.textContent).toContain('Balance after this day')
    expect(card.textContent).toContain(
      'Apartment rent leaves $690.00 at day’s end. Spending and smaller bills bring it to $300.00 by Thu, Oct 22, just before payday.',
    )
    expect(rent.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(card, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(rent)
  })

  it('opens a line with Enter, moves between lines with the arrow keys and announces them', async () => {
    const user = userEvent.setup()
    render(chart())
    const lines = within(screen.getByRole('group', { name: /Paydays and big bills/ })).getAllByRole(
      'button',
    )
    lines[0]!.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(lines[1])
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toContain(
      lines[1]!.getAttribute('aria-label')!.split(':')[0]!,
    )
    const live = document.querySelector('[aria-live="polite"]')!
    expect(live.textContent).toBe(lines[1]!.getAttribute('aria-label'))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('scrubs day by day from the keyboard and announces each day', async () => {
    const user = userEvent.setup()
    render(chart())
    const scrubber = screen.getByRole('slider', { name: /Balance by day/ })
    act(() => scrubber.focus())
    const live = document.querySelector('[aria-live="polite"]')!
    // Focus starts on the lowest day.
    expect(scrubber.getAttribute('aria-valuetext')).toBe('Thu, Oct 22')
    expect(live.textContent).toContain('Thu, Oct 22. Lowest $300.00, at your cushion.')
    await user.keyboard('{ArrowRight}')
    expect(scrubber.getAttribute('aria-valuetext')).toBe('Fri, Oct 23')
    expect(live.textContent).toMatch(/^Fri, Oct 23\. Lowest \$/)
    await user.keyboard('{PageDown}')
    expect(scrubber.getAttribute('aria-valuetext')).toBe('Fri, Oct 16')
    await user.keyboard('{Home}')
    expect(scrubber.getAttribute('aria-valuenow')).toBe('0')
  })

  it('adds the Pay in 4 line, numbered instalments and its own low point when compared', async () => {
    const user = userEvent.setup()
    const camera = comparison('camera')
    if (!camera.payIn4.available) throw new Error('Expected a Pay in 4 scenario')
    render(
      <BalanceChart
        points={camera.buyToday.points}
        cushionCents={camera.cushionCents}
        purchase={{ date: camera.buyToday.purchaseDate, amountCents: camera.buyToday.amountCents }}
        payIn4={{ points: camera.payIn4.points, instalments: camera.payIn4.instalments }}
        label="Projected balance if you buy today."
      />,
    )
    const key = document.querySelector('.bchart-key') as HTMLElement
    expect(within(key).getByText('Pay in full')).toBeTruthy()
    expect(within(key).getByText('Pay in 4 · illustrative')).toBeTruthy()
    const svg = screen.getByRole('img', { name: /^Projected balance/ })
    expect(svg.querySelector('.bchart-p4')).toBeTruthy()
    const dots = svg.querySelectorAll('.bchart-inst')
    expect([...dots].map((dot) => dot.textContent)).toEqual(['1', '2', '3', '4'])
    // A dot is red when its own plotted balance is under the cushion.
    const byDate = new Map(camera.payIn4.points.map((p) => [p.date, p.minimumCents]))
    expect(svg.querySelectorAll('.bchart-inst.below')).toHaveLength(
      camera.payIn4.instalments.filter((i) => byDate.get(i.date)! < camera.cushionCents).length,
    )
    // Both scenarios state their own low point, date and cushion gap, side by side.
    const rows = within(document.querySelector('.bchart-compare') as HTMLElement).getAllByRole(
      'term',
    )
    expect(rows.map((row) => row.textContent)).toEqual(['Pay in full', 'Pay in 4'])
    expect(document.querySelector('.bchart-compare')!.textContent).toMatch(
      /Pay in fulllowest −\$458\.99 on Thu, Oct 22, \$758\.99 below your cushion/,
    )
    expect(document.querySelector('.bchart-compare')!.textContent).toMatch(
      /Pay in 4lowest \$[\d,.]+ on \w{3}, \w{3} \d+, \$[\d,.]+ below your cushion/,
    )
    await user.click(screen.getByText('View as table'))
    expect(screen.getByRole('columnheader', { name: 'With Pay in 4' })).toBeTruthy()
    expect(screen.getByRole('table').textContent).toContain('payment 2 of 4')
  })
})
