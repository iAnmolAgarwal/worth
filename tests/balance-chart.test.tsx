// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { BalanceChart } from '../src/BalanceChart'
import {
  chartModel,
  eventRules,
  geometry,
  hitsLine,
  hitTargets,
  leaderEnd,
  leaderHitsLine,
  LEADER_MIN,
  MIN_TARGET,
  overlaps,
  ruleBox,
  stepPath,
  storyRules,
  type ChartInput,
} from '../src/chartLayout'
import { compareOptions } from '../shared/finance'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type { Comparison, OptionResult } from '../shared/types'
import { dayLabel } from '../src/format'

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

/** The props Decision passes for one option, with the Pay in 4 comparison open or closed. */
function decisionInput(
  c: Comparison,
  option: OptionResult,
  width: number,
  p4Open: boolean,
): ChartInput {
  const cause = option.lowPointCause
  const p4 = c.payIn4.available ? c.payIn4 : undefined
  return {
    points: option.points,
    cushionCents: c.cushionCents,
    width,
    purchase: { date: option.purchaseDate, amountCents: option.amountCents },
    payIn4: p4Open && p4 ? { points: p4.points, instalments: p4.instalments } : undefined,
    scaleWith: p4?.points,
    highlight: {
      billDate:
        cause && cause.kind !== 'spending' && cause.kind !== 'purchase' ? cause.date : undefined,
      paydayDate: option.points.find(
        (point) =>
          point.date >= option.lowestDate && point.events.some((event) => event.kind === 'income'),
      )?.date,
    },
  }
}

/** Every Decision state the demo can show (3 options, Pay in 4 open or not) for both products. */
function decisionStates() {
  return ['chair', 'camera'].flatMap((product) => {
    const c = comparison(product)
    const options: [string, OptionResult][] = [
      ['buy today', c.buyToday],
      ['spend less', c.spendLess],
      ...(c.wait.date ? [['wait', c.wait] as [string, OptionResult]] : []),
    ]
    return options.flatMap(([name, option]) =>
      [false, true].map((p4) => ({
        name: `${product} ${name}${p4 ? ' + Pay in 4' : ''}`,
        c,
        option,
        p4,
      })),
    )
  })
}

/** Frame widths measured live: Decision at 1440 and 390, Plan's review step at 1440. */
const WIDTHS = [662, 316, 590]

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

  it('puts a bill on the drop it causes and a paycheck on the rise after its day', () => {
    const g = geometry(880, 284, points.length, values, c.cushionCents)
    const rules = eventRules(points, g)
    expect(rules.some((rule) => rule.kind === 'payday')).toBe(true)
    const rent = rules.find((rule) => rule.events.some((e) => e.name === 'Apartment rent'))!
    expect(rent.x).toBeLessThan(g.x(rent.index))
    const pay = rules.find((rule) => rule.kind === 'payday')!
    expect(pay.x).toBeGreaterThan(g.x(pay.index))
  })

  it.each(WIDTHS)(
    'gives every line a pointer target at least 24px wide, merging close lines (%ipx)',
    (width) => {
      for (const state of decisionStates()) {
        const model = chartModel(decisionInput(state.c, state.option, width, state.p4))!
        const { rules, targets } = model
        // Every rule belongs to exactly one target, in order.
        expect(targets.flatMap((target) => target.rules)).toEqual(rules.map((_, i) => i))
        targets.forEach((target, i) => {
          expect(target.right - target.left).toBeGreaterThanOrEqual(MIN_TARGET)
          for (const rule of target.rules) {
            expect(rules[rule]!.x).toBeGreaterThanOrEqual(target.left)
            expect(rules[rule]!.x).toBeLessThanOrEqual(target.right)
          }
          expect(target.rules).toContain(target.primary)
          const next = targets[i + 1]
          if (next) expect(target.right).toBeLessThanOrEqual(next.left + 0.001)
        })
      }
    },
  )

  it('merges lines one day apart and opens the cluster on its story line', () => {
    const rules = [100, 110, 160, 230, 236, 241].map((x, index) => ({
      index,
      date: `2026-10-${10 + index}`,
      x,
      kind: 'bill' as const,
      events: [
        {
          id: `${index}`,
          name: `Bill ${index}`,
          amountCents: -(index + 1) * 10_000,
          kind: 'bill' as const,
        },
      ],
    }))
    const targets = hitTargets(rules as never, { left: 0, right: 400 }, [0])
    expect(targets.map((target) => target.rules)).toEqual([[0, 1], [2], [3, 4, 5]])
    // The story line leads its cluster; otherwise the largest movement does.
    expect(targets[0]!.primary).toBe(0)
    expect(targets[2]!.primary).toBe(5)
    expect(targets[1]!.right - targets[1]!.left).toBeGreaterThanOrEqual(24)
  })

  it.each(WIDTHS)(
    'keeps the low-point label off the line, the story lines and every mark in all Decision states (%ipx)',
    (width) => {
      for (const state of decisionStates()) {
        const model = chartModel(decisionInput(state.c, state.option, width, state.p4))!
        const { g, placed, rules, story, low, obstacles } = model
        const series = [model.values, ...(model.p4Values ? [model.p4Values] : [])]
        const lowBox = placed.find((box) => box.id === 'low')
        expect(lowBox, state.name).toBeTruthy()
        // The balance line is never covered. The illustrative Pay in 4 line and the purchase's
        // dotted line are clear too, except on a phone with both scenarios drawn, where no spot
        // clear of all of them exists and the pill may cross them (never a story line or a dot).
        const strict = width >= 480 || !state.p4
        expect(hitsLine(lowBox!, model.values, g, 1), state.name).toBe(false)
        if (strict) {
          for (const values of series)
            expect(hitsLine(lowBox!, values, g, 1), state.name).toBe(false)
          for (const line of model.buyLine) expect(overlaps(lowBox!, line), state.name).toBe(false)
        }
        for (const index of [story.bill, story.payday])
          if (index !== undefined)
            expect(overlaps(lowBox!, ruleBox(rules[index]!, g.plot)), state.name).toBe(false)
        for (const obstacle of obstacles)
          expect(overlaps(lowBox!, obstacle), state.name).toBe(false)
        // A leader, when drawn, never crosses the line either.
        const end = leaderEnd(lowBox!, low)
        if (Math.hypot(end.x - low.x, end.y - low.y) > LEADER_MIN)
          for (const values of strict ? series : [model.values])
            expect(leaderHitsLine(low, end, values, g), state.name).toBe(false)
        // Labels never overlap each other, and all stay in the frame.
        for (const a of placed) {
          expect(a.x, state.name).toBeGreaterThanOrEqual(g.plot.x)
          expect(a.x + a.w, state.name).toBeLessThanOrEqual(g.width)
          for (const b of placed) if (a !== b) expect(overlaps(a, b), state.name).toBe(false)
        }
      }
    },
  )

  it('clears the line on the recommended camera Wait answer, with and without Pay in 4', () => {
    const camera = comparison('camera')
    if (!camera.wait.date) throw new Error('Expected a wait date')
    for (const p4 of [false, true]) {
      const model = chartModel(decisionInput(camera, camera.wait, 662, p4))!
      const lowBox = model.placed.find((box) => box.id === 'low')!
      expect(hitsLine(lowBox, model.values, model.g, 1)).toBe(false)
      if (model.p4Values) expect(hitsLine(lowBox, model.p4Values, model.g, 1)).toBe(false)
      expect(overlaps(lowBox, ruleBox(model.rules[model.story.payday!]!, model.g.plot))).toBe(false)
      expect(overlaps(lowBox, ruleBox(model.rules[model.story.bill!]!, model.g.plot))).toBe(false)
    }
  })

  it('finds the bill behind the low even when the low falls on a payday (Plan)', () => {
    const plain = c.spendLess.points
    const g = geometry(
      662,
      284,
      plain.length,
      plain.map((p) => p.minimumCents),
      c.cushionCents,
    )
    const rules = eventRules(plain, g)
    const lowIndex = plain.findIndex((point) => point.date === c.spendLess.lowestDate)
    const story = storyRules(rules, lowIndex)
    expect(rules[story.bill!]!.events.map((e) => e.name)).toContain('Apartment rent')
    expect(rules[story.payday!]!.index).toBe(lowIndex)
  })

  it('names the bill behind the answer in the label lane when there is room', () => {
    const model = chartModel(decisionInput(c, c.spendLess, 662, false))!
    expect(model.storyText).toBe('Apartment rent −$1,450.00')
    expect(model.placed.find((box) => box.id === 'story')).toBeTruthy()
  })

  it('drops the empty label lane when there is nothing to label', () => {
    const quiet = points.map((point) => ({ ...point, events: [] }))
    const model = chartModel({ points: quiet, cushionCents: c.cushionCents, width: 662 })!
    expect(model.g.plot.y).toBeLessThan(20)
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

  const lineButton = (name: RegExp) =>
    within(screen.getByRole('group', { name: /Paydays and big bills/ }))
      .getAllByRole('button')
      .find((button) => name.test(button.getAttribute('aria-label') ?? ''))!

  it('opens a bill line on click, docks the card under the plot and closes with Escape', async () => {
    const user = userEvent.setup()
    const { container } = render(chart())
    const rent = lineButton(/Fri, Oct 16: Apartment rent/)
    await user.click(rent)
    const card = screen.getByRole('dialog', { name: 'Bill · Fri, Oct 16' })
    expect(card.textContent).toContain('−$1,450.00')
    expect(card.textContent).toContain('Balance after this day')
    // The sentence names the big bill between the rent and the low, as the lines show it.
    expect(card.textContent).toContain(
      'Apartment rent leaves $690.00 at day’s end. Spending and your student loan (−$210.00) bring it to $300.00 by Thu, Oct 22, just before payday.',
    )
    // The card sits under the plot, never over the step it explains.
    const frame = container.querySelector('.bchart-frame')!
    expect(frame.contains(card)).toBe(false)
    expect(frame.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(rent.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(card, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(rent)
  })

  it('shares one target between lines a day apart and lets the card pick the day', async () => {
    const user = userEvent.setup()
    render(chart())
    // At this width Oct 15 (Pay in 4) and Oct 16 (rent) are 8 px apart: one 24 px+ target.
    const cluster = lineButton(/Thu, Oct 15: .*Fri, Oct 16: Apartment rent/)
    await user.click(cluster)
    // It opens on the story line, rent, and offers both days.
    expect(screen.getByRole('dialog', { name: 'Bill · Fri, Oct 16' })).toBeTruthy()
    const days = within(screen.getByRole('group', { name: 'Lines on nearby days' })).getAllByRole(
      'button',
    )
    expect(days.map((day) => day.textContent)).toEqual(['Oct 15', 'Oct 16'])
    expect(days[1]!.getAttribute('aria-pressed')).toBe('true')
    await user.click(days[0]!)
    expect(screen.getByRole('dialog', { name: 'Bill · Thu, Oct 15' }).textContent).toContain(
      'Laptop · Pay in 4',
    )
  })

  it('moves between lines with the arrow keys and announces each move once', async () => {
    const user = userEvent.setup()
    render(chart())
    const lines = within(screen.getByRole('group', { name: /Paydays and big bills/ })).getAllByRole(
      'button',
    )
    const live = document.querySelector('[aria-live="polite"]')!
    lines[0]!.focus()
    // On the lines, focus moves and the focused button announces itself; nothing else speaks.
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(lines[1])
    expect(live.textContent).toBe('')
    await user.keyboard('{Enter}')
    const card = screen.getByRole('dialog')
    expect(document.activeElement).toBe(card)
    const before = card.getAttribute('aria-label')
    // Inside the card focus stays put, so the live region says where it went, once.
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
    expect(screen.getByRole('dialog').getAttribute('aria-label')).not.toBe(before)
    expect(live.textContent).toMatch(/^\w{3}, \w{3} \d+: /)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('summarises a hovered line in the readout slot instead of opening a card', () => {
    const { container } = render(chart())
    const rent = lineButton(/Fri, Oct 16: Apartment rent/)
    fireEvent.pointerOver(rent, { pointerType: 'mouse' })
    expect(screen.queryByRole('dialog')).toBeNull()
    const peek = container.querySelector('.bchart-foot .bchart-peek')!
    expect(peek.textContent).toContain('Apartment rent −$1,450.00')
    expect(peek.textContent).toContain('balance after $690.00')
    fireEvent.pointerOut(rent, { pointerType: 'mouse' })
    expect(container.querySelector('.bchart-peek')).toBeNull()
  })

  it('draws the bill behind the low at full strength on Plan, where no highlight is passed', () => {
    const { container } = render(chart({ highlight: undefined, purchase: undefined }))
    const story = [...container.querySelectorAll('.bchart-rules .bchart-rule.story')]
    expect(story.map((line) => line.classList.contains('bill'))).toEqual([true, false])
    expect(container.querySelector('.bchart-storylabel')!.textContent).toBe(
      'Apartment rent −$1,450.00',
    )
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
    // Scrubbing onto an instalment day keeps its numbered badge clear of the beacon.
    const scrubber = screen.getByRole('slider', { name: /Balance by day/ })
    act(() => scrubber.focus())
    await user.keyboard('{Home}')
    const second = camera.payIn4.instalments[1]!
    const steps = camera.buyToday.points.findIndex((point) => point.date === second.date)
    for (let i = 0; i < steps; i++) await user.keyboard('{ArrowRight}')
    expect(scrubber.getAttribute('aria-valuetext')).toBe(dayLabel(second.date))
    expect(svg.querySelector('.bchart-scrub circle.p4')).toBeNull()
    await user.keyboard('{ArrowRight}')
    expect(svg.querySelector('.bchart-scrub circle.p4')).toBeTruthy()
    await user.click(screen.getByText('View as table'))
    expect(screen.getByRole('columnheader', { name: 'With Pay in 4' })).toBeTruthy()
    expect(screen.getByRole('table').textContent).toContain('payment 2 of 4')
  })
})
