// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { BalanceChart } from '../src/BalanceChart'
import { ChartTile } from '../src/Decision'
import { fullPayName, payIn4Lines, payIn4Thesis } from '../src/payIn4Text'
import { compareOptions } from '../shared/finance'
import {
  ALEX_CAMERA_ID,
  ALEX_DEMO_DAY,
  createCameraScenario,
  createDemoState,
  PRODUCTS,
} from '../shared/seed'
import type { Comparison, OptionResult } from '../shared/types'

// The demo story: Alex on Fri Nov 13 2026 and the $1,899 Halden X5.
const halden = PRODUCTS.find((p) => p.id === ALEX_CAMERA_ID)!
const alex: Comparison = compareOptions(createCameraScenario(ALEX_DEMO_DAY).profile, [], {
  amountCents: halden.priceCents,
  itemName: halden.name,
  today: ALEX_DEMO_DAY,
  payIn4Eligible: true,
})
if (!alex.wait.date || !alex.payIn4.available) throw new Error('Expected a wait date and Pay in 4')
const alexP4 = alex.payIn4
const alexWait: OptionResult = alex.wait
const DAYS = alexWait.points.length

// The frame is 660px wide without a browser: the plot starts at 44 and is 520 wide.
const clientX = (day: number) => 44 + (day + 0.5) * (520 / DAYS)
const dayOf = (date: string) => alexWait.points.findIndex((point) => point.date === date)

afterEach(cleanup)

const tile = (k: 'wait' | 'buyToday' = 'wait', open = false) => (
  <ChartTile c={alex} k={k} payIn4={open ? alexP4 : undefined} scaleWith={alexP4} />
)
const chip = (name: string) =>
  within(screen.getByRole('group', { name: 'Show on the chart' })).getByRole('button', { name })
const svg = () => screen.getByRole('img', { name: /^Projected balance/ })
const focus = () => screen.getByRole('complementary', { name: 'Day in focus' })
const slider = () => screen.getByRole('slider', { name: /Balance by day/ })
const summaryRows = () => [...document.querySelectorAll('.wchart-summary li')]

describe('the default view', () => {
  it('draws one line, the cushion, today, the paydays and the day it fits, and nothing else', () => {
    const { container } = render(tile())
    expect(container.querySelector('.meta')!.textContent).toBe(
      'Each day’s lowest balance, Nov 13 to Jan 12.',
    )
    expect(svg().querySelectorAll('.wchart-line:not(.under)')).toHaveLength(1)
    expect(svg().querySelectorAll('.wchart-alt')).toHaveLength(0)
    expect(svg().querySelector('.wchart-level.cushion text')!.textContent).toBe('Cushion $300')
    // The zero line is drawn only when something goes below zero.
    expect(svg().querySelector('.wchart-level.zero')).toBeNull()
    // Waiting never dips, so no band is shaded.
    expect(svg().querySelectorAll('.wchart-band')).toHaveLength(0)
    const labels = [...svg().querySelectorAll('.wchart-mark text')].map((text) => text.textContent)
    expect(labels).toEqual(['Fits Dec 15', 'Today', 'Payday', 'Payday'])
    expect(svg().querySelector('.wchart-mark.fits')).toBeTruthy()
    // The Dec 14 invoice keeps its line; its label gives way to the fit date next to it.
    expect(svg().querySelectorAll('.wchart-mark.income line')).toHaveLength(1)
    expect(svg().querySelector('.wchart-mark.income text')).toBeNull()
    expect(svg().querySelector('.wchart-buy.fits')).toBeTruthy()
    // One pill a day, all above the cushion.
    expect(svg().querySelectorAll('.wchart-track rect')).toHaveLength(DAYS)
    expect(svg().querySelectorAll('.wchart-track rect.above')).toHaveLength(DAYS)
    expect(svg().querySelectorAll('.wchart-bill')).toHaveLength(0)
  })

  it('says the answer in words above the chart and in the focus panel', () => {
    render(tile())
    expect(summaryRows().map((row) => row.querySelector('.words')!.textContent)).toEqual([
      'Stays above your $300.00 cushion. Lowest $458.78 on Thu, Dec 31.',
    ])
    expect(focus().querySelector('.eyebrow')!.textContent).toBe('Lowest point')
    expect(focus().querySelector('.date')!.textContent).toBe('Thu, Dec 31')
    expect(focus().querySelector('.amount')!.textContent).toBe('$458.78')
    expect(focus().querySelector('.state')!.textContent).toBe('Above cushion')
    expect(focus().querySelector('.words')!.textContent).toBe(
      'Payday: Salary $3,900.00 lands. You are $158.78 above your cushion. The day’s low comes before the pay arrives.',
    )
    expect(focus().querySelector('.also')).toBeNull()
  })

  it('offers the other answers and the bills as unpressed chips, and a range control', () => {
    render(tile())
    const chips = within(screen.getByRole('group', { name: 'Show on the chart' })).getAllByRole(
      'button',
    )
    expect(chips.map((button) => button.textContent)).toEqual(['Buy today', 'Pay in 4', 'Bills'])
    for (const button of chips) expect(button.getAttribute('aria-pressed')).toBe('false')
    // A chip is its label and nothing else; pressed, it takes its line's colour.
    for (const button of chips) expect(button.childElementCount).toBe(0)
    expect(chips.map((button) => button.className)).toEqual([
      'wchart-chip tone-amber',
      'wchart-chip tone-violet',
      'wchart-chip tone-bill',
    ])
    const ranges = within(screen.getByRole('group', { name: 'Days shown' })).getAllByRole('button')
    expect(ranges.map((button) => button.textContent)).toEqual(['To payday', '30 days', '60 days'])
    expect(ranges.map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'false',
      'false',
      'true',
    ])
  })

  it('keeps a text alternative and a table of every day', async () => {
    const user = userEvent.setup()
    render(tile())
    expect(svg().getAttribute('aria-label')).toBe(
      'Projected balance if you wait until Tue, Dec 15. Each day shows its low, with that day’s bills taken out before pay arrives. Lowest point $458.78 on Thursday, Dec 31, 2026, $158.78 more than your $300.00 cushion. Wait until Tue, Dec 15: Stays above your $300.00 cushion. Lowest $458.78 on Thu, Dec 31.',
    )
    await user.click(screen.getByText('View as table'))
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(DAYS + 1)
    expect(table.querySelector('caption')!.textContent).toContain(
      'Projected balance each day at its low, with that day’s bills taken out before pay arrives, against your $300.00 cushion.',
    )
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Day', 'Balance (day’s low)', 'Against cushion', 'What happens'])
    const row = (day: string) =>
      [...within(table).getByRole('rowheader', { name: day }).closest('tr')!.cells].map(
        (cell) => cell.textContent,
      )
    expect(row('Thu, Dec 31')).toEqual([
      'Thu, Dec 31',
      '$458.78 · lowest point',
      'Above cushion',
      'Salary +$3,900.00',
    ])
    expect(row('Tue, Dec 1')[3]).toContain('Rent −$1,750.00')
    for (const tr of within(table).getAllByRole('row').slice(1))
      expect((tr as HTMLTableRowElement).cells[2]!.textContent).toBe('Above cushion')
  })

  it('uses solid colours for every line but the cushion, which is the one dotted line', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/chart.css'), 'utf8')
    const rules = css
      .split('}')
      .filter((rule) => /dash|dotted/.test(rule.replace(/\/\*.*?\*\//gs, '')))
    expect(
      rules.map((rule) =>
        rule
          .replace(/\/\*.*?\*\//gs, '')
          .split('{')[0]!
          .trim(),
      ),
    ).toEqual(['.wchart-level.cushion line', '.wchart-swatch.cushion'])
    // Round dots: a near-zero dash with round caps.
    expect(rules[0]).toMatch(/stroke-linecap: round;\s+stroke-dasharray: 0\.1 6;/)
    render(tile())
    expect(svg().querySelector('[stroke-dasharray]')).toBeNull()
    expect(
      [...document.querySelectorAll('.wchart-legend span')].map((item) => item.textContent),
    ).toEqual(['Wait until Tue, Dec 15', 'Cushion', 'Above cushion', 'Below cushion', 'Below zero'])
    expect(document.querySelector('.wchart-legend .wchart-swatch.cushion')).toBeTruthy()
  })
})

describe('the toggles', () => {
  it('adds Buy today as its own line, summary, track row and zero line', async () => {
    const user = userEvent.setup()
    render(tile())
    await user.click(chip('Buy today'))
    expect(chip('Buy today').getAttribute('aria-pressed')).toBe('true')
    expect(svg().querySelectorAll('.wchart-alt.tone-amber:not(.under)')).toHaveLength(1)
    // Its stretch under the cushion is redrawn in red.
    expect(svg().querySelectorAll('.wchart-alt.under')).toHaveLength(1)
    expect(svg().querySelector('.wchart-level.zero text')!.textContent).toBe('Zero $0')
    expect(summaryRows().map((row) => row.querySelector('.words')!.textContent)).toEqual([
      'Wait until Tue, Dec 15: Stays above your $300.00 cushion. Lowest $458.78 on Thu, Dec 31.',
      'Buy today: Below your $300.00 cushion from Thu, Nov 19 and below zero from Fri, Nov 20. Lowest −$726.74 on Mon, Nov 30.',
    ])
    // An amount never breaks after its minus sign.
    expect(
      [...summaryRows()[1]!.querySelectorAll('.nowrap')].map((amount) => amount.textContent),
    ).toEqual(['$300.00', '−$726.74'])
    // Two track rows, each named in its line's colour; Buy today's shows the dip day by day.
    const rows = svg().querySelectorAll('.wchart-track')
    expect(rows).toHaveLength(2)
    expect([...rows].map((row) => row.querySelector('text')!.textContent)).toEqual([
      'Wait to Dec 15',
      'Buy today',
    ])
    expect(rows[1]!.querySelector('text')!.classList.contains('tone-amber')).toBe(true)
    expect(rows[1]!.querySelectorAll('rect.below')).toHaveLength(6)
    expect(rows[1]!.querySelectorAll('rect.negative')).toHaveLength(11)
    // The line is named on the plot too, so it reads without its colour.
    expect(svg().querySelector('.wchart-linelabel')!.textContent).toBe('Buy today')
    expect(
      [...document.querySelectorAll('.wchart-legend span')].map((item) => item.textContent),
    ).toEqual([
      'Wait until Tue, Dec 15',
      'Buy today',
      'Cushion',
      'Above cushion',
      'Below cushion',
      'Below zero',
    ])
    await user.click(chip('Buy today'))
    expect(svg().querySelectorAll('.wchart-alt')).toHaveLength(0)
    expect(svg().querySelector('.wchart-level.zero')).toBeNull()
    expect(summaryRows()).toHaveLength(1)
  })

  it('jumps to a stretch from its chip and pins that day', async () => {
    const user = userEvent.setup()
    render(tile())
    await user.click(chip('Buy today'))
    const jumps = within(summaryRows()[1] as HTMLElement).getAllByRole('button')
    expect(jumps.map((button) => button.textContent)).toEqual([
      'Below cushion Nov 19 – Nov 30',
      'Below cushion Dec 10 – Dec 14',
    ])
    await user.click(jumps[0]!)
    expect(slider().getAttribute('aria-valuetext')).toBe('Thu, Nov 19')
    expect(within(focus()).getByRole('button', { name: /Pinned/ })).toBeTruthy()
    // The panel gives the viewed option's day, then the other option's balance that same day.
    expect(focus().querySelector('.date')!.textContent).toBe('Thu, Nov 19')
    expect(focus().querySelector('.state')!.textContent).toBe('Above cushion')
    const also = focus().querySelector('.also')!
    expect(also.querySelector('.also-head')!.textContent).toBe('Same day, other options')
    expect(also.querySelector('dt')!.textContent).toBe('Buy today')
    expect(also.querySelector('dd')!.textContent).toMatch(/^\$[\d.]+ · Below cushion$/)
    await user.click(within(summaryRows()[0] as HTMLElement).getByRole('button'))
    expect(slider().getAttribute('aria-valuetext')).toBe('Thu, Dec 31')
  })

  it('marks the bills of $100 or more under the track when Bills is on', async () => {
    const user = userEvent.setup()
    render(tile())
    await user.click(chip('Bills'))
    expect(chip('Bills').getAttribute('aria-pressed')).toBe('true')
    const bills = [...svg().querySelectorAll('.wchart-bill')]
    expect(bills.length).toBeGreaterThan(3)
    expect(bills.map((bill) => bill.querySelector('text')?.textContent)).toContain('Rent')
    await user.click(chip('Bills'))
    expect(svg().querySelectorAll('.wchart-bill')).toHaveLength(0)
  })

  it('narrows the days shown, and widens again when a chip names a later day', async () => {
    const user = userEvent.setup()
    render(tile())
    await user.click(screen.getByRole('button', { name: 'To payday' }))
    // Nov 13 to Dec 2: the payday and two days on.
    expect(slider().getAttribute('aria-valuemax')).toBe('19')
    expect(svg().querySelectorAll('.wchart-track rect')).toHaveLength(20)
    // The fit date is out of view, so it is not marked.
    expect(svg().querySelector('.wchart-mark.fits')).toBeNull()
    expect(summaryRows()[0]!.querySelector('.words')!.textContent).toMatch(/^Stays above/)
    await user.click(screen.getByRole('button', { name: '30 days' }))
    expect(slider().getAttribute('aria-valuemax')).toBe('30')
    await user.click(screen.getByRole('button', { name: '60 days' }))
    expect(slider().getAttribute('aria-valuemax')).toBe(String(DAYS - 1))
  })

  it('starts Pay in 4 on when the page has its comparison open', () => {
    const { rerender } = render(tile('wait', true))
    expect(chip('Pay in 4').getAttribute('aria-pressed')).toBe('true')
    expect(svg().querySelectorAll('.wchart-alt.tone-violet:not(.under)')).toHaveLength(1)
    expect(summaryRows()[1]!.querySelector('.words')!.textContent).toBe(
      'Pay in 4: Below your $300.00 cushion from Sun, Nov 29. Lowest $222.76 on Mon, Nov 30. Back above on Tue, Dec 1.',
    )
    rerender(tile('wait', false))
    expect(chip('Pay in 4').getAttribute('aria-pressed')).toBe('false')
  })
})

describe('the day in focus', () => {
  it('follows the mouse, pins on click and unpins from its tag', async () => {
    const user = userEvent.setup()
    render(tile())
    const rent = dayOf('2026-12-01')
    fireEvent.pointerMove(slider(), { clientX: clientX(rent), pointerType: 'mouse' })
    expect(focus().querySelector('.eyebrow')!.textContent).toBe('Day in focus')
    expect(focus().querySelector('.date')!.textContent).toBe('Tue, Dec 1')
    expect(within(focus()).queryByRole('button')).toBeNull()
    fireEvent.pointerLeave(slider())
    expect(focus().querySelector('.date')!.textContent).toBe('Thu, Dec 31')
    fireEvent.click(slider(), { clientX: clientX(rent) })
    expect(focus().querySelector('.date')!.textContent).toBe('Tue, Dec 1')
    expect(focus().querySelector('.amount')!.textContent).toBe('$3,282.26')
    expect(focus().querySelector('.words')!.textContent).toBe(
      'Rent $1,750.00 goes out. You are $2,982.26 above your cushion.',
    )
    const pin = within(focus()).getByRole('button', { name: 'Pinned. Unpin this day' })
    expect(pin.textContent).toContain('Pinned')
    await user.click(pin)
    expect(focus().querySelector('.eyebrow')!.textContent).toBe('Lowest point')
    expect(focus().querySelector('.date')!.textContent).toBe('Thu, Dec 31')
  })

  it('steps day by day from the keyboard, announces each day and unpins with Escape', async () => {
    const user = userEvent.setup()
    render(tile())
    act(() => slider().focus())
    const live = document.querySelector('[aria-live="polite"]')!
    // It starts on the lowest day.
    expect(slider().getAttribute('aria-valuetext')).toBe('Thu, Dec 31')
    await user.keyboard('{ArrowRight}')
    expect(slider().getAttribute('aria-valuetext')).toBe('Fri, Jan 1')
    expect(live.textContent).toMatch(/^Fri, Jan 1\. Day’s low \$[\d,.]+\. .*above your cushion\.$/)
    expect(within(focus()).getByRole('button', { name: /Pinned/ })).toBeTruthy()
    await user.keyboard('{PageDown}')
    expect(slider().getAttribute('aria-valuetext')).toBe('Fri, Dec 25')
    await user.keyboard('{Home}')
    expect(slider().getAttribute('aria-valuenow')).toBe('0')
    await user.keyboard('{End}')
    expect(slider().getAttribute('aria-valuenow')).toBe(String(DAYS - 1))
    await user.keyboard('{Escape}')
    expect(within(focus()).queryByRole('button')).toBeNull()
    expect(slider().getAttribute('aria-valuetext')).toBe('Thu, Dec 31')
  })

  it('says "Income" for the Dec 14 invoice, whose label gives way to the fit date', () => {
    render(tile())
    fireEvent.click(slider(), { clientX: clientX(dayOf('2026-12-14')) })
    expect(focus().querySelector('.words')!.textContent).toMatch(
      /^Income: .+ \$1,650\.00 lands\. You are \$[\d,.]+ above your cushion\./,
    )
  })
})

describe('an option that goes below the cushion', () => {
  it('shades each stretch, draws the line red under the cushion and says it in red words', () => {
    render(tile('buyToday'))
    expect(svg().querySelectorAll('.wchart-band')).toHaveLength(2)
    expect(svg().querySelector('.wchart-line.under')!.getAttribute('clip-path')).toMatch(/under/)
    expect(svg().querySelector('.wchart-level.zero text')!.textContent).toBe('Zero $0')
    // Buying today does not fit: its day is marked, never in green.
    expect(svg().querySelector('.wchart-mark.buy text')!.textContent).toBe('Buy Nov 13')
    expect(svg().querySelector('.wchart-mark.fits')).toBeNull()
    expect(svg().querySelector('.wchart-buy.fits')).toBeNull()
    expect(summaryRows()[0]!.classList.contains('dips')).toBe(true)
    expect(focus().classList.contains('negative')).toBe(true)
    expect(focus().querySelector('.date')!.textContent).toBe('Mon, Nov 30')
    expect(focus().querySelector('.amount')!.textContent).toBe('−$726.74')
    expect(focus().querySelector('.state')!.textContent).toBe('Below zero')
    // The other answers are offered as chips: waiting, in its own colour, and Pay in 4.
    expect(chip('Wait until Tue, Dec 15').className).toBe('wchart-chip tone-teal')
    expect(chip('Pay in 4')).toBeTruthy()
  })
})

describe('the chart alone, as Plan draws it', () => {
  it('needs no purchase or comparison: one line, the Bills chip and the range', () => {
    render(
      <BalanceChart
        points={alex.buyToday.points.map((point) => ({
          ...point,
          minimumCents: point.baselineMinimumCents,
        }))}
        cushionCents={alex.cushionCents}
        label="Projected balance before any purchase."
      />,
    )
    const chips = within(screen.getByRole('group', { name: 'Show on the chart' })).getAllByRole(
      'button',
    )
    expect(chips.map((button) => button.textContent)).toEqual(['Bills'])
    expect(svg().querySelector('.wchart-buy')).toBeNull()
    expect(
      [...svg().querySelectorAll('.wchart-mark text')].map((text) => text.textContent),
    ).toEqual(['Today', 'Payday', 'Income', 'Payday'])
    expect(summaryRows()[0]!.querySelector('.words')!.textContent).toBe(
      'Stays above your $300.00 cushion. Lowest $1,172.26 on Mon, Nov 30.',
    )
    expect(svg().getAttribute('aria-label')).toMatch(
      /^Projected balance before any purchase\. Balance: Stays above/,
    )
  })

  it('renders nothing without days', () => {
    const { container } = render(<BalanceChart points={[]} cushionCents={30_000} label="Empty." />)
    expect(container.firstChild).toBeNull()
  })
})

describe('the table with Pay in 4 open', () => {
  it('gives Pay in 4 its own column, judged on its own balance, in words as well as colour', async () => {
    const user = userEvent.setup()
    render(tile('wait', true))
    await user.click(screen.getByText('View as table'))
    const table = screen.getByRole('table')
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual([
      'Day',
      'Wait until Tue, Dec 15 (day’s low)',
      'Against cushion',
      'What happens',
      'Pay in 4 (day’s low)',
    ])
    expect(table.querySelector('caption')!.textContent).toContain(
      'Pay in 4: Below your $300.00 cushion from Sun, Nov 29. Lowest $222.76 on Mon, Nov 30.',
    )
    expect(table.textContent).toContain('payment 2 of 4')
    const row = (day: string) =>
      [...within(table).getByRole('rowheader', { name: day }).closest('tr')!.cells].map(
        (cell) => cell.textContent,
      )
    expect(row('Thu, Dec 31')[1]).toBe('$458.78 · lowest point')
    expect(row('Mon, Nov 30')[4]).toBe('$222.76 · lowest point · below cushion')
    expect(row('Sun, Nov 29')[4]).toMatch(/^\$[\d.]+ · below cushion$/)
    expect(row('Mon, Nov 30')[1]).not.toMatch(/lowest|below/)
    // Each balance cell is red only when that balance is below the cushion (audit B1).
    const cushion = alex.cushionCents
    const tableRows = [...table.querySelectorAll('tbody tr')]
    tableRows.forEach((tr) => {
      const [full, , , p4] = [...tr.querySelectorAll('td')]
      const cents = (cell: Element) =>
        Math.round(
          Number(
            cell
              .textContent!.split(' ·')[0]!
              .replace(/[^\d.−-]/g, '')
              .replace('−', '-'),
          ) * 100,
        )
      expect(full!.classList.contains('below')).toBe(cents(full!) < cushion)
      expect(p4!.classList.contains('below')).toBe(cents(p4!) < cushion)
      // Words too, not colour alone.
      expect(p4!.textContent!.includes('below cushion')).toBe(cents(p4!) < cushion)
    })
    expect(tableRows.filter((tr) => tr.querySelectorAll('td.below').length === 1)).toHaveLength(2)
  })

  it('says the comparison’s point in the tile and its text alternative', () => {
    const thesis = payIn4Thesis(alex, alexWait, alexP4)
    const { container } = render(tile('wait', true))
    expect(container.querySelector('.chart-thesis')!.textContent).toBe(thesis)
    expect(svg().getAttribute('aria-label')).toContain(
      `Projected balance if you wait until Tue, Dec 15, compared with PayPal Pay in 4. ${thesis}`,
    )
    expect(svg().getAttribute('aria-label')).toContain(
      'Pay in full on Dec 15: lowest point $458.78 on ',
    )
  })
})

describe('Pay in 4 comparison: its point and its two low dates', () => {
  const state = createDemoState('2026-10-03')
  const product = PRODUCTS.find((p) => p.id === 'camera')!
  const camera: Comparison = compareOptions(state.profile, state.purchases, {
    amountCents: product.priceCents,
    itemName: product.name,
    today: '2026-10-03',
    payIn4Eligible: true,
  })
  if (!camera.payIn4.available || !camera.wait.date) throw new Error('Expected both scenarios')
  const p4 = camera.payIn4
  const wait: OptionResult = camera.wait

  it('states the point in one line, naming when you would pay in full', () => {
    // The video replay's figures: Pay in 4's low is a day before the wait date, paying in full
    // on Oct 23 bottoms out at $720.53 on Nov 19.
    expect(payIn4Thesis(camera, wait, p4)).toBe(
      'With PayPal Pay in 4 from today, Oct 3, your lowest point is Thu, Oct 22 at $140.51, below your cushion; paying in full on Fri, Oct 23, it’s Thu, Nov 19 at $720.53.',
    )
    // Buying today in full bottoms out the same day, so the date is not repeated.
    expect(payIn4Thesis(camera, camera.buyToday, p4)).toBe(
      'With PayPal Pay in 4 from today, Oct 3, your lowest point is Thu, Oct 22 at $140.51, below your cushion; paying in full today, it’s the same day at −$458.99, below your cushion.',
    )
    expect(payIn4Thesis(camera, camera.spendLess, p4)).toMatch(
      /; spending \$440\.01 today instead, it’s the same day at \$300\.00\.$/,
    )
    expect(fullPayName(camera, wait)).toBe('Pay in full on Oct 23')
    expect(fullPayName(camera, camera.buyToday)).toBe('Pay in full today')
    expect(fullPayName(camera, camera.spendLess)).toBe('Spend $440.01 today')
    // Calm wording: one option among others, never a warning about Pay in 4 itself.
    for (const option of [wait, camera.buyToday, camera.spendLess])
      expect(payIn4Thesis(camera, option, p4)).not.toMatch(/danger|risk|warning|breach|careful/i)
  })

  it('names the first day below the cushion and the lowest point as two different dates', () => {
    expect(payIn4Lines(p4, camera.cushionCents)).toEqual({
      lead: 'With Pay in 4, your balance would first go below your cushion on Wed, Oct 21',
      low: 'Lowest point $140.51 on Thu, Oct 22, before payday.',
    })
    // When the first dip is the lowest day too, the second line says so instead of a new date.
    const lowDay = p4.points.findIndex((point) => point.date === p4.lowestDate)
    const sameDay = {
      ...p4,
      points: p4.points.map((point, index) =>
        index < lowDay ? { ...point, minimumCents: Math.max(point.minimumCents, 30_000) } : point,
      ),
    }
    expect(payIn4Lines(sameDay, camera.cushionCents)).toEqual({
      lead: 'With Pay in 4, your balance would first go below your cushion on Thu, Oct 22',
      low: 'Lowest point $140.51 that same day, before payday.',
    })
    // When the plan already goes below without Pay in 4, and earlier, that earlier day leads and
    // is not put down to Pay in 4.
    const early = p4.points.findIndex((point) => point.date === '2026-10-12')
    const baseFirst = {
      ...p4,
      points: p4.points.map((point, index) =>
        index === early ? { ...point, minimumCents: 20_000, baselineMinimumCents: 25_000 } : point,
      ),
    }
    expect(payIn4Lines(baseFirst, camera.cushionCents)).toEqual({
      lead: 'Your plan first goes below your cushion on Mon, Oct 12, even without this purchase',
      low: 'Lowest point $140.51 on Thu, Oct 22, before payday.',
    })
    expect(payIn4Lines(baseFirst, camera.cushionCents).lead).not.toMatch(/Wed, Oct 21/)
  })

  it('keeps the spend-less line named by what you would spend', () => {
    render(<ChartTile c={camera} k="spendLess" scaleWith={p4} />)
    expect(
      within(screen.getByRole('group', { name: 'Show on the chart' }))
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Buy today', 'Wait until Fri, Oct 23', 'Pay in 4', 'Bills'])
    expect(document.querySelector('.wchart-legend span')!.textContent).toBe('Spend $440.01 today')
  })
})
