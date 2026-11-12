// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { BalanceChart } from '../src/BalanceChart'
import { isBill, stretches } from '../src/chartModel'
import { ChartTile, noPurchase } from '../src/Decision'
import { fullPayName, payIn4Lines, payIn4Thesis } from '../src/payIn4Text'
import { assessPurchase, compareOptions } from '../shared/finance'
import {
  ALEX_CAMERA_ID,
  ALEX_DEMO_DAY,
  ALEX_RETURN_DAY,
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
const WAIT = 'Wait until Tue, Dec 15'
const SENTENCES = {
  wait: 'Stays above your $300.00 cushion. Lowest $458.78 on Thu, Dec 31.',
  buy: 'Below your $300.00 cushion from Thu, Nov 19 and below zero from Fri, Nov 20. Lowest −$726.74 on Mon, Nov 30.',
  p4: 'Below your $300.00 cushion from Sun, Nov 29. Lowest $222.76 on Mon, Nov 30. Back above on Tue, Dec 1.',
}

// The frame is 660px wide without a browser: the plot starts at 44 and is 520 wide.
const clientX = (day: number, days = DAYS) => 44 + (day + 0.5) * (520 / days)
const dayOf = (date: string) => alexWait.points.findIndex((point) => point.date === date)

afterEach(cleanup)

const tile = (k: 'wait' | 'buyToday' = 'wait', open = false) => (
  <ChartTile c={alex} k={k} payIn4={open ? alexP4 : undefined} scaleWith={alexP4} />
)
const pills = () =>
  within(screen.getByRole('group', { name: 'Options on the chart' })).getAllByRole('button')
const pill = (name: string) =>
  within(screen.getByRole('group', { name: 'Options on the chart' })).getByRole('button', { name })
const svg = () => screen.getByRole('img', { name: /^Projected balance/ })
const focus = () => screen.getByRole('complementary', { name: 'Day in focus' })
const slider = () => screen.getByRole('slider', { name: /Balance by day/ })
const summaryRows = () => [...document.querySelectorAll('.wchart-summary li')]
const sentences = () => summaryRows().map((row) => row.querySelector('.words')!.textContent)
const legend = () =>
  [...document.querySelectorAll('.wchart-legend span')].map((item) => item.textContent)
/** The day ranges a line's red region is clipped to. */
const dipDays = (series: string) =>
  [...svg().querySelectorAll(`.wchart-dipdays[data-series="${series}"] rect`)].map((rect) => [
    rect.getAttribute('data-from'),
    rect.getAttribute('data-to'),
  ])
/** The engine's below-cushion stretches for an option, as first and last dates. */
const engineDips = (points: OptionResult['points']) =>
  stretches(
    points.map((point) => point.minimumCents),
    alex.cushionCents,
  ).map((run) => [points[run.from]!.date, points[run.to]!.date])
const moneyLines = (kind: 'in' | 'out') =>
  [...svg().querySelectorAll(`.wchart-money.${kind}`)].map((line) => line.getAttribute('data-date'))

describe('the default view', () => {
  it('draws the page’s option, the cushion, today and the day it fits, with nothing shaded red', () => {
    render(tile())
    // The card has no visible title or subtitle; its region keeps a name that is always true.
    const card = screen.getByRole('region', { name: 'Your balance day by day' })
    expect(card.querySelector('h2, .meta')).toBeNull()
    expect(card.firstElementChild!.classList.contains('wchart')).toBe(true)
    expect(svg().querySelectorAll('.wchart-line')).toHaveLength(1)
    expect(
      svg().querySelector('.wchart-line')!.parentElement!.classList.contains('tone-main'),
    ).toBe(true)
    expect(svg().querySelectorAll('.wchart-alt')).toHaveLength(0)
    expect(svg().querySelector('.wchart-level.cushion text')!.textContent).toBe('Cushion $300')
    // The zero line is drawn only when something goes below zero.
    expect(svg().querySelector('.wchart-level.zero')).toBeNull()
    // Waiting never dips: the fill under the line is blue on every day and nothing is red.
    expect(svg().querySelectorAll('.wchart-area')).toHaveLength(1)
    expect(svg().querySelectorAll('.wchart-dip')).toHaveLength(0)
    expect(svg().querySelectorAll('.wchart-dipdays rect')).toHaveLength(0)
    const labels = [...svg().querySelectorAll('.wchart-mark text')].map((text) => text.textContent)
    // The fit date, today and the paydays lead; the Dec 14 invoice's "Income" gives way to the
    // fit date beside it. (Bill names follow where they have room.)
    expect(labels.slice(0, 4)).toEqual(['Fits Dec 15', 'Today', 'Payday', 'Payday'])
    expect(labels).not.toContain('Income')
    expect(svg().querySelector('.wchart-mark.fits line')).toBeTruthy()
    expect(svg().querySelector('.wchart-buy.fits')).toBeTruthy()
    // No option is named inside the plot, and there is no strip of days under it.
    for (const text of svg().querySelectorAll('text'))
      expect(text.textContent).not.toMatch(/Buy today|Pay in 4|Wait/)
    expect(svg().querySelector('.wchart-track')).toBeNull()
  })

  it('puts a green line on every day money comes in and a red one on every day it goes out', () => {
    render(tile())
    const days = (wanted: (kind: string) => boolean) =>
      alexWait.points
        .filter((point) => point.events.some((event) => wanted(event.kind)))
        .map((point) => point.date)
    const credits = days((kind) => kind === 'income')
    const debits = alexWait.points
      .filter((point) => point.events.some(isBill))
      .map((point) => point.date)
    expect(credits).toEqual(['2026-11-30', '2026-12-14', '2026-12-31'])
    expect(moneyLines('in')).toEqual(credits)
    expect(moneyLines('out')).toEqual(debits)
    expect(debits.length).toBeGreaterThan(5)
    // The purchase itself is the option's marker, never a money-out line.
    expect(moneyLines('out')).not.toContain('2026-12-15')
  })

  it('says the answer in words above the chart and in the focus panel', () => {
    render(tile())
    // The single row still names its option.
    expect(sentences()).toEqual([`${WAIT}: ${SENTENCES.wait}`])
    expect(focus().querySelector('.eyebrow')!.textContent).toBe('Lowest point')
    expect(focus().querySelector('.date')!.textContent).toBe('Thu, Dec 31')
    expect(focus().querySelector('.amount')!.textContent).toBe('$458.78')
    expect(focus().querySelector('.state')!.textContent).toBe('Above cushion')
    expect(focus().querySelector('.words')!.textContent).toBe(
      'Payday: Salary $3,900.00 lands. You are $158.78 above your cushion. The day’s low comes before the pay arrives.',
    )
    expect(focus().querySelector('.also')).toBeNull()
    expect(legend()).toEqual([WAIT, 'Money in', 'Money out', 'Cushion', 'Below cushion'])
  })

  it('keeps a text alternative and a table of every day', async () => {
    const user = userEvent.setup()
    render(tile())
    expect(svg().getAttribute('aria-label')).toBe(
      `Projected balance, Nov 13 to Jan 12. Each day shows its low, with that day’s bills taken out before pay arrives. ${WAIT}: ${SENTENCES.wait}`,
    )
    await user.click(screen.getByText('View as table'))
    // The table says what it is in a few words, left-aligned above it, and names itself by them.
    const table = screen.getByRole('table', {
      name: 'Each day’s lowest balance, Nov 13 to Jan 12',
    })
    expect(table.querySelector('caption')).toBeNull()
    expect(within(table).getAllByRole('row')).toHaveLength(DAYS + 1)
    // Day, what happens, then one balance column per pressed option, amounts to the right.
    const headers = within(table).getAllByRole('columnheader')
    expect(headers.map((header) => header.textContent)).toEqual([
      'Day',
      'What happens',
      'Wait · Dec 15',
    ])
    expect(headers.map((header) => header.className)).toEqual(['', '', 'num'])
    const row = (day: string) =>
      [...within(table).getByRole('rowheader', { name: day }).closest('tr')!.cells].map(
        (cell) => cell.textContent,
      )
    expect(row('Thu, Dec 31')).toEqual([
      'Thu, Dec 31',
      'Salary +$3,900.00',
      '$458.78 · lowest point',
    ])
    expect(row('Tue, Dec 1')[1]).toContain('Rent −$1,750.00')
    // A quiet day says so with a dash; a fine balance carries no note and no red.
    expect(row('Sat, Nov 14')).toEqual(['Sat, Nov 14', '—', expect.stringMatching(/^\$[\d,.]+$/)])
    expect(table.querySelectorAll('td.below')).toHaveLength(0)
    // No option colour anywhere in the table.
    expect(table.querySelector('[class*="tone-"]')).toBeNull()
  })

  it('uses solid colours for every line but the cushion, which is the one dotted line', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/chart.css'), 'utf8')
    const plain = (rule: string) => rule.replace(/\/\*.*?\*\//gs, '')
    const rules = css.split('}').filter((rule) => /dash|dotted/.test(plain(rule)))
    expect(rules.map((rule) => plain(rule).split('{')[0]!.trim())).toEqual([
      '.wchart-level.cushion line',
      '.wchart-swatch.cushion',
    ])
    // Round dots: a near-zero dash with round caps.
    expect(rules[0]).toMatch(/stroke-linecap: round;\s+stroke-dasharray: 0\.1 6;/)
    render(tile())
    expect(svg().querySelector('[stroke-dasharray]')).toBeNull()
    expect(document.querySelector('.wchart-legend .wchart-swatch.cushion')).toBeTruthy()
  })
})

describe('the pill pressed on load is Worth’s recommendation', () => {
  const compare = (productId: string, day: string) => {
    const product = PRODUCTS.find((p) => p.id === productId)!
    return compareOptions(createCameraScenario(day).profile, [], {
      amountCents: product.priceCents,
      itemName: product.name,
      today: day,
      payIn4Eligible: true,
    })
  }
  /** The chart as the page first draws it: on the engine's recommendation. */
  const pressedOnLoad = (c: Comparison) => {
    const p4 = c.payIn4.available ? c.payIn4 : undefined
    render(<ChartTile c={c} k={c.recommendation ?? 'buyToday'} scaleWith={p4} />)
    return pills()
      .filter((button) => button.getAttribute('aria-pressed') === 'true')
      .map((button) => button.textContent)
  }

  it('is "Wait until Tue, Dec 15" for Alex’s Halden X5 on Nov 13', () => {
    const c = compare(ALEX_CAMERA_ID, ALEX_DEMO_DAY)
    expect(c.recommendation).toBe('wait')
    expect(pressedOnLoad(c)).toEqual([WAIT])
  })

  it('is "Buy today" for an item that fits today, with no Wait pill to press', () => {
    const c = compare('airpods-4', ALEX_DEMO_DAY)
    expect(c.recommendation).toBe('buyToday')
    expect(pressedOnLoad(c)).toEqual(['Buy today'])
    expect(pills().map((button) => button.textContent)).not.toContain(WAIT)
  })

  it('is "Buy today" for the Halden X5 on the Dec 15 return visit, when it fits', () => {
    const c = compare(ALEX_CAMERA_ID, ALEX_RETURN_DAY)
    expect(c.recommendation).toBe('buyToday')
    expect(pressedOnLoad(c)).toEqual(['Buy today'])
  })

  it('is the cheaper option for an item that never fits in the window', () => {
    const c = compare('macbook-pro-14', ALEX_DEMO_DAY)
    expect(c.wait.date).toBeNull()
    expect(c.recommendation).toBe('spendLess')
    expect(pressedOnLoad(c)).toEqual([expect.stringMatching(/^Spend \$[\d,.]+ today$/)])
    // Exactly one pill is pressed, and the line drawn is that option's.
    expect(svg().querySelectorAll('.wchart-line')).toHaveLength(1)
    expect(svg().querySelectorAll('.wchart-alt')).toHaveLength(0)
  })
})

describe('the pills are the options', () => {
  it('offers each way to buy, with the page’s option pressed and nothing else on a pill', () => {
    render(tile())
    expect(pills().map((button) => button.textContent)).toEqual(['Buy today', WAIT, 'Pay in 4'])
    expect(pills().map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'false',
      'true',
      'false',
    ])
    // A pill is its label and nothing else; pressed, it takes its option's colour.
    for (const button of pills()) expect(button.childElementCount).toBe(0)
    expect(pills().map((button) => button.className)).toEqual([
      'wchart-chip tone-amber',
      'wchart-chip tone-main',
      'wchart-chip tone-violet',
    ])
    expect(screen.queryByRole('button', { name: 'Bills' })).toBeNull()
    const ranges = within(screen.getByRole('group', { name: 'Days shown' })).getAllByRole('button')
    expect(ranges.map((button) => button.textContent)).toEqual(['To payday', '30 days', '60 days'])
    expect(ranges.map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'false',
      'false',
      'true',
    ])
  })

  it('lets the last pill be unpressed, and then draws the balance with nothing bought', async () => {
    const user = userEvent.setup()
    render(tile())
    await user.click(pill(WAIT))
    expect(pills().map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'false',
      'false',
      'false',
    ])
    // One neutral line, no summary box, no purchase marker; the legend names it.
    expect(svg().querySelectorAll('.wchart-line')).toHaveLength(1)
    expect(
      svg().querySelector('.wchart-line')!.parentElement!.classList.contains('tone-none'),
    ).toBe(true)
    expect(svg().querySelectorAll('.wchart-alt')).toHaveLength(0)
    expect(summaryRows()).toHaveLength(0)
    expect(svg().querySelector('.wchart-buy')).toBeNull()
    expect(svg().querySelector('.wchart-mark.fits, .wchart-mark.buy')).toBeNull()
    expect(legend()[0]).toBe('No purchase')
    expect(svg().querySelectorAll('.wchart-money.in')).toHaveLength(3)
    expect(svg().getAttribute('aria-label')).toBe(
      'Projected balance, Nov 13 to Jan 12. Each day shows its low, with that day’s bills taken out before pay arrives. No purchase: Stays above your $300.00 cushion. Lowest $1,172.26 on Mon, Nov 30.',
    )
    // The focus panel works on that line, starting at its lowest point over the whole window.
    expect(focus().querySelector('.eyebrow')!.textContent).toBe('Lowest point')
    expect(focus().querySelector('.date')!.textContent).toBe('Mon, Nov 30')
    expect(focus().querySelector('.amount')!.textContent).toBe('$1,172.26')
    fireEvent.click(slider(), { clientX: clientX(dayOf('2026-12-15')) })
    expect(focus().querySelector('.date')!.textContent).toBe('Tue, Dec 15')
    expect(focus().querySelector('.words')!.textContent).toMatch(
      /^You are \$[\d,.]+ above your cushion\.$/,
    )
    // Pressing a pill from the empty state brings its line and box back.
    await user.click(pill('Buy today'))
    expect(
      svg().querySelector('.wchart-line')!.parentElement!.classList.contains('tone-amber'),
    ).toBe(true)
    expect(sentences()).toEqual([`Buy today: ${SENTENCES.buy}`])
    await user.click(pill('Buy today'))
    expect(summaryRows()).toHaveLength(0)
  })

  it('takes the no-purchase line from the engine’s own projection, lowest point included', () => {
    const profile = createCameraScenario(ALEX_DEMO_DAY).profile
    const engine = assessPurchase(profile, [], {
      amountCents: 0,
      today: ALEX_DEMO_DAY,
      findEarliest: false,
    })
    const byDate = new Map(engine.points.map((point) => [point.date, point.minimumCents]))
    const line = noPurchase(alex)
    expect(line).toHaveLength(DAYS)
    for (const point of line) expect(point.minimumCents).toBe(byDate.get(point.date))
    expect(Math.min(...line.map((point) => point.minimumCents))).toBe(117_226)
    expect(engine.baselineLowestCents).toBe(117_226)
    expect(line.flatMap((point) => point.events).some((event) => event.kind === 'purchase')).toBe(
      false,
    )
  })

  it('keeps one pill pressed where there is no no-purchase line to fall back on', async () => {
    const user = userEvent.setup()
    render(
      <BalanceChart
        options={[
          { key: 'a', name: 'Buy today', points: alex.buyToday.points },
          { key: 'b', name: 'Wait', points: alexWait.points },
        ]}
        selected="b"
        cushionCents={alex.cushionCents}
        label="Projected balance."
      />,
    )
    await user.click(pill('Wait'))
    expect(pill('Wait').getAttribute('aria-pressed')).toBe('true')
  })

  it('adds Buy today as its own line and summary row, with its dip shaded red', async () => {
    const user = userEvent.setup()
    render(tile())
    await user.click(pill('Buy today'))
    expect(pill('Buy today').getAttribute('aria-pressed')).toBe('true')
    // One amber line for its whole length: a line never turns red, the region under it does.
    expect(svg().querySelectorAll('.wchart-alt')).toHaveLength(1)
    expect(svg().querySelectorAll('.wchart-alt.tone-amber')).toHaveLength(1)
    expect(svg().querySelector('.under')).toBeNull()
    expect(svg().querySelector('.wchart-level.zero text')!.textContent).toBe('Zero $0')
    expect(sentences()).toEqual([`${WAIT}: ${SENTENCES.wait}`, `Buy today: ${SENTENCES.buy}`])
    // A row has no line marker, and its option's name is plain bold text.
    expect(document.querySelector('.wchart-summary .wchart-swatch')).toBeNull()
    expect(summaryRows().map((row) => row.querySelector('b')!.className)).toEqual(['', ''])
    // The dip is a red region between the cushion and Buy today's line, on the engine's
    // below-cushion days; the page's option keeps its blue fill.
    expect(dipDays('buyToday')).toEqual(engineDips(alex.buyToday.points))
    expect(dipDays('buyToday')).toEqual([
      ['2026-11-19', '2026-11-30'],
      ['2026-12-10', '2026-12-14'],
    ])
    expect(dipDays('wait')).toEqual([])
    expect(svg().querySelectorAll('.wchart-dip')).toHaveLength(1)
    expect(svg().querySelector('.wchart-dip.main')).toBeNull()
    // A plain ground sits under the red, and a thin strip at the cushion keeps a shallow dip
    // from vanishing.
    expect(svg().querySelectorAll('.wchart-dip path.ground')).toHaveLength(1)
    expect(svg().querySelector('.wchart-dip rect.edge')!.getAttribute('height')).toBe('3')
    // An amount never breaks after its minus sign.
    expect(
      [...summaryRows()[1]!.querySelectorAll('.nowrap')].map((amount) => amount.textContent),
    ).toEqual(['$300.00', '−$726.74'])
    expect(legend()).toEqual([
      WAIT,
      'Buy today',
      'Money in',
      'Money out',
      'Cushion',
      'Below cushion',
    ])
    await user.click(pill('Buy today'))
    expect(svg().querySelectorAll('.wchart-alt')).toHaveLength(0)
    expect(svg().querySelector('.wchart-level.zero')).toBeNull()
    expect(summaryRows()).toHaveLength(1)
  })

  it('jumps to a stretch from its chip and pins that day', async () => {
    const user = userEvent.setup()
    render(tile())
    await user.click(pill('Buy today'))
    const jumps = within(summaryRows()[1] as HTMLElement).getAllByRole('button')
    expect(jumps.map((button) => button.textContent)).toEqual([
      'Below cushion Nov 19 – Nov 30',
      'Below cushion Dec 10 – Dec 14',
    ])
    await user.click(jumps[0]!)
    expect(slider().getAttribute('aria-valuetext')).toBe('Thu, Nov 19')
    expect(within(focus()).getByRole('button', { name: /Pinned/ })).toBeTruthy()
    // The panel gives the bold option's day, then the other option's balance that same day.
    expect(focus().querySelector('.date')!.textContent).toBe('Thu, Nov 19')
    expect(focus().querySelector('.state')!.textContent).toBe('Above cushion')
    const also = focus().querySelector('.also')!
    expect(also.querySelector('.also-head')!.textContent).toBe('Same day, other options')
    expect(also.querySelector('dt')!.textContent).toBe('Buy today')
    expect(also.querySelector('dd')!.textContent).toMatch(/^\$[\d.]+ · Below cushion$/)
    await user.click(within(summaryRows()[0] as HTMLElement).getByRole('button'))
    expect(slider().getAttribute('aria-valuetext')).toBe('Thu, Dec 31')
  })

  it('starts Pay in 4 pressed when the page has its comparison open, and says so only then', async () => {
    const user = userEvent.setup()
    const thesis = payIn4Thesis(alex, alexWait, alexP4)
    const { container, rerender } = render(tile('wait', true))
    expect(pill('Pay in 4').getAttribute('aria-pressed')).toBe('true')
    expect(svg().querySelectorAll('.wchart-alt.tone-violet')).toHaveLength(1)
    expect(sentences()[1]).toBe(`Pay in 4: ${SENTENCES.p4}`)
    expect(dipDays('payIn4')).toEqual(engineDips(alexP4.points))
    expect(dipDays('payIn4')).toEqual([['2026-11-29', '2026-11-30']])
    expect(container.querySelector('.chart-thesis')!.textContent).toBe(thesis)
    expect(svg().getAttribute('aria-label')).toContain(
      `Compared with PayPal Pay in 4. ${thesis} ${WAIT}: ${SENTENCES.wait} Pay in 4: ${SENTENCES.p4}`,
    )
    // With its line switched off, the text alternative no longer speaks of a comparison.
    await user.click(pill('Pay in 4'))
    expect(svg().getAttribute('aria-label')).not.toMatch(/Pay in 4/)
    rerender(tile('wait', false))
    expect(pill('Pay in 4').getAttribute('aria-pressed')).toBe('false')
  })
})

describe('the range only changes what is drawn', () => {
  it('keeps every option’s sentence, the lowest point and the stretches for the whole window', async () => {
    const user = userEvent.setup()
    render(tile('wait', true))
    await user.click(pill('Buy today'))
    const whole = sentences()
    expect(whole).toEqual([
      `${WAIT}: ${SENTENCES.wait}`,
      `Buy today: ${SENTENCES.buy}`,
      `Pay in 4: ${SENTENCES.p4}`,
    ])
    const alt = svg().getAttribute('aria-label')
    await user.click(screen.getByRole('button', { name: 'To payday' }))
    // Nov 13 to Dec 2 is drawn: the payday and two days on.
    expect(slider().getAttribute('aria-valuemax')).toBe('19')
    expect(sentences()).toEqual(whole)
    expect(svg().getAttribute('aria-label')).toBe(alt)
    // The lowest point is still Dec 31: the panel says so, no other day is ringed, and the
    // plot's edge points to it.
    expect(focus().querySelector('.eyebrow')!.textContent).toBe('Lowest point')
    expect(focus().querySelector('.date')!.textContent).toBe('Thu, Dec 31')
    expect(focus().querySelector('.amount')!.textContent).toBe('$458.78')
    expect(svg().querySelector('.wchart-low')).toBeNull()
    expect(svg().querySelector('.wchart-focus')).toBeNull()
    expect(svg().querySelector('.wchart-edge')!.textContent).toBe('Lowest point Dec 31 →')
    // The fit date is out of view, so it is not marked; the red region stops at the edge.
    expect(svg().querySelector('.wchart-mark.fits')).toBeNull()
    expect(dipDays('buyToday')).toEqual([['2026-11-19', '2026-11-30']])
    // Buy today's later dip keeps its chip, and the chip widens the range to show it.
    const jumps = within(summaryRows()[1] as HTMLElement).getAllByRole('button')
    expect(jumps.map((button) => button.textContent)).toEqual([
      'Below cushion Nov 19 – Nov 30',
      'Below cushion Dec 10 – Dec 14',
    ])
    await user.click(jumps[1]!)
    expect(screen.getByRole('button', { name: '60 days' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect(slider().getAttribute('aria-valuetext')).toBe('Thu, Dec 10')
    expect(svg().querySelector('.wchart-edge')).toBeNull()
  })

  it('steps from the last day in view when the lowest day is outside it', async () => {
    const user = userEvent.setup()
    render(tile())
    await user.click(screen.getByRole('button', { name: '30 days' }))
    expect(slider().getAttribute('aria-valuemax')).toBe('30')
    act(() => slider().focus())
    await user.keyboard('{ArrowLeft}')
    expect(slider().getAttribute('aria-valuetext')).toBe('Sat, Dec 12')
    await user.click(screen.getByRole('button', { name: '60 days' }))
    expect(slider().getAttribute('aria-valuemax')).toBe(String(DAYS - 1))
    expect(slider().getAttribute('aria-valuetext')).toBe('Thu, Dec 31')
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

  it('drops a pinned day when the page shows another option', () => {
    const { rerender } = render(tile())
    fireEvent.click(slider(), { clientX: clientX(dayOf('2026-12-01')) })
    expect(focus().querySelector('.date')!.textContent).toBe('Tue, Dec 1')
    rerender(tile('buyToday'))
    expect(focus().querySelector('.eyebrow')!.textContent).toBe('Lowest point')
    expect(focus().querySelector('.date')!.textContent).toBe('Mon, Nov 30')
    expect(pills().map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
    ])
  })
})

describe('an option that goes below the cushion', () => {
  it('shades each stretch red, keeps the line its own colour and says it in red words', () => {
    render(tile('buyToday'))
    // Red from the cushion down on the below-cushion days, a little stronger below zero; the
    // blue fill is clipped to the other days.
    expect(dipDays('buyToday')).toEqual(engineDips(alex.buyToday.points))
    expect(dipDays('buyToday')).toEqual([
      ['2026-11-19', '2026-11-30'],
      ['2026-12-10', '2026-12-14'],
    ])
    expect(svg().querySelectorAll('.wchart-dip.main rect')).toHaveLength(2)
    expect(svg().querySelector('.wchart-dip.main rect.deep')!.getAttribute('clip-path')).toMatch(
      /deep-buyToday/,
    )
    expect(svg().querySelector('.wchart-area')!.getAttribute('clip-path')).toMatch(/clear/)
    // The line keeps the page option's colour all the way down.
    expect(svg().querySelectorAll('.wchart-line')).toHaveLength(1)
    expect(svg().querySelector('.under')).toBeNull()
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
    // The page's option is the pressed pill; waiting keeps its own colour.
    expect(pill('Buy today').className).toBe('wchart-chip tone-main')
    expect(pill(WAIT).className).toBe('wchart-chip tone-teal')
  })

  it('counts a day exactly at the cushion as above it: nothing is shaded', () => {
    render(
      <BalanceChart
        options={[
          {
            key: 'plan',
            name: 'Balance',
            points: alexWait.points.map((point) => ({ ...point, minimumCents: 30_000 })),
          },
        ]}
        selected="plan"
        cushionCents={30_000}
        label="Projected balance."
      />,
    )
    expect(svg().querySelectorAll('.wchart-dip')).toHaveLength(0)
    expect(svg().querySelectorAll('.wchart-dipdays rect')).toHaveLength(0)
    expect(sentences()[0]).toMatch(/^Stays above your \$300\.00 cushion\./)
  })
})

describe('the chart alone, as Plan draws it', () => {
  it('needs no purchase or comparison: one line, no pills, the range', () => {
    render(
      <BalanceChart
        options={[
          {
            key: 'plan',
            name: 'Balance',
            points: alex.buyToday.points.map((point) => ({
              ...point,
              minimumCents: point.baselineMinimumCents,
            })),
          },
        ]}
        selected="plan"
        cushionCents={alex.cushionCents}
        label="Projected balance before any purchase."
      />,
    )
    expect(screen.queryByRole('group', { name: 'Options on the chart' })).toBeNull()
    expect(screen.getByRole('group', { name: 'Days shown' })).toBeTruthy()
    expect(svg().querySelector('.wchart-buy')).toBeNull()
    expect(
      [...svg().querySelectorAll('.wchart-mark text')].map((text) => text.textContent).slice(0, 4),
    ).toEqual(['Today', 'Payday', 'Income', 'Payday'])
    expect(sentences()).toEqual([
      'Stays above your $300.00 cushion. Lowest $1,172.26 on Mon, Nov 30.',
    ])
    expect(svg().getAttribute('aria-label')).toMatch(
      /^Projected balance before any purchase\. Balance: Stays above/,
    )
  })

  it('renders nothing without days', () => {
    const { container } = render(
      <BalanceChart
        options={[{ key: 'plan', name: 'Balance', points: [] }]}
        selected="plan"
        cushionCents={30_000}
        label="Empty."
      />,
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('the table with Pay in 4 open', () => {
  it('gives each pressed option its own column, judged on its own balance, in words as well as colour', async () => {
    const user = userEvent.setup()
    render(tile('wait', true))
    await user.click(pill('Buy today'))
    await user.click(screen.getByText('View as table'))
    const table = screen.getByRole('table')
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Day', 'What happens', 'Wait · Dec 15', 'Buy today', 'Pay in 4'])
    expect(table.textContent).toContain('payment 2 of 4')
    const row = (day: string) =>
      [...within(table).getByRole('rowheader', { name: day }).closest('tr')!.cells].map(
        (cell) => cell.textContent,
      )
    expect(row('Thu, Dec 31')[2]).toBe('$458.78 · lowest point')
    expect(row('Mon, Nov 30').slice(2)).toEqual([
      expect.stringMatching(/^\$1,172\.26$/),
      '−$726.74 · lowest point · below zero',
      '$222.76 · lowest point · below cushion',
    ])
    expect(row('Sun, Nov 29')[4]).toMatch(/^\$[\d.]+ · below cushion$/)
    // Each balance cell is red only when that balance is below the cushion (audit B1), and
    // says which in words: below cushion, or below zero.
    const cushion = alex.cushionCents
    const tableRows = [...table.querySelectorAll('tbody tr')]
    const cents = (cell: Element) =>
      Math.round(
        Number(
          cell
            .textContent!.split(' ·')[0]!
            .replace(/[^\d.−-]/g, '')
            .replace('−', '-'),
        ) * 100,
      )
    tableRows.forEach((tr) => {
      for (const cell of [...tr.querySelectorAll('td')].slice(1)) {
        expect(cell.classList.contains('below')).toBe(cents(cell) < cushion)
        expect(cell.textContent!.includes('below cushion')).toBe(
          cents(cell) < cushion && cents(cell) >= 0,
        )
        expect(cell.textContent!.includes('below zero')).toBe(cents(cell) < 0)
      }
    })
    // Buy today is below on 17 days and Pay in 4 on 2; waiting never is.
    expect(table.querySelectorAll('td.below')).toHaveLength(19)
    expect(tableRows.filter((tr) => tr.querySelectorAll('td.below').length === 2)).toHaveLength(2)
    // The table always lists the whole window, whatever range is drawn.
    await user.click(screen.getByRole('button', { name: 'To payday' }))
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(DAYS + 1)
  })

  it('shows the no-purchase balance when no pill is pressed', async () => {
    const user = userEvent.setup()
    render(tile())
    await user.click(pill(WAIT))
    await user.click(screen.getByText('View as table'))
    const table = screen.getByRole('table')
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Day', 'What happens', 'No purchase'])
    const low = within(table).getByRole('rowheader', { name: 'Mon, Nov 30' }).closest('tr')!
    expect(low.cells[2]!.textContent).toBe('$1,172.26 · lowest point')
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

  it('adds a pill for the cheaper option only while the page is showing it', () => {
    const { rerender } = render(<ChartTile c={camera} k="spendLess" scaleWith={p4} />)
    expect(pills().map((button) => button.textContent)).toEqual([
      'Buy today',
      'Wait until Fri, Oct 23',
      'Spend $440.01 today',
      'Pay in 4',
    ])
    expect(pills().map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'false',
      'false',
      'true',
      'false',
    ])
    expect(legend()[0]).toBe('Spend $440.01 today')
    rerender(<ChartTile c={camera} k="wait" scaleWith={p4} />)
    expect(pills().map((button) => button.textContent)).toEqual([
      'Buy today',
      'Wait until Fri, Oct 23',
      'Pay in 4',
    ])
    // Without Pay in 4 for the price there is no pill for it.
    cleanup()
    render(<ChartTile c={camera} k="wait" />)
    expect(pills().map((button) => button.textContent)).toEqual([
      'Buy today',
      'Wait until Fri, Oct 23',
    ])
  })
})
