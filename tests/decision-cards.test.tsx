// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/api'
import { Decision, optionWhy, smallMiss, type Explanation } from '../src/Decision'
import { compareOptions } from '../shared/finance'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type { AppState, OptionResult } from '../shared/types'

// The decision page's cards after the user's end-to-end feedback (items 3, 4 and 6): two-line
// option bodies, the Something cheaper card, the stress row's coloured amount and the Pay in 4 cards.

vi.mock('../src/paypalSdk', () => ({ loadPayPalSdk: vi.fn() }))
vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>()
  return { ...actual, api: vi.fn() }
})

const TODAY = '2026-10-03'
const apiMock = vi.mocked(api)
function makeState(): AppState {
  const seed = createDemoState(TODAY)
  return {
    ...seed,
    reviews: [],
    today: TODAY,
    products: PRODUCTS,
    config: { ai: 'demo', paypal: 'demo', alternatives: 'off' },
  } as AppState
}
const compare = (amountCents: number, itemName: string) => {
  const state = makeState()
  return compareOptions(state.profile, state.purchases, {
    amountCents,
    itemName,
    today: TODAY,
    payIn4Eligible: true,
  })
}
function show(productId: string, explanation?: Explanation) {
  const state = makeState()
  apiMock.mockImplementation(((_path: string, data?: unknown) =>
    Promise.resolve().then(() => {
      const product = PRODUCTS.find((p) => p.id === (data as { productId: string }).productId)!
      return compareOptions(state.profile, state.purchases, {
        amountCents: product.priceCents,
        itemName: product.name,
        today: TODAY,
        payIn4Eligible: true,
      })
    })) as typeof api)
  return render(
    <Decision
      backLabel="Back"
      onBack={vi.fn()}
      onBuy={vi.fn()}
      onSave={vi.fn()}
      onViewActivity={vi.fn()}
      state={state}
      request={{ productId }}
      explanation={explanation}
    />,
  )
}

beforeEach(() => {
  apiMock.mockReset()
})
afterEach(cleanup)

describe('option cards (feedback item 4)', () => {
  it('names a small miss from the engine’s own gap, and drops “Lowest that day”', () => {
    const c = compare(44900, 'Desk chair')
    // The engine: $8.99 under the $300 cushion on Thu, Oct 22.
    expect(c.buyToday.headroomCents).toBe(-899)
    expect(smallMiss(c.buyToday, c.amountCents)).toBe(true)
    expect(optionWhy(c, 'buyToday', c.buyToday)).toBe(
      'Just $8.99 under your cushion on Thu, Oct 22',
    )
    // Wait is the recommendation: the verdict states its margin, so the card names only the day.
    expect(optionWhy(c, 'wait', c.wait as OptionResult)).toBe('on Thu, Oct 22')
    expect(optionWhy({ ...c, recommendation: 'spendLess' }, 'wait', c.wait as OptionResult)).toBe(
      'Thu, Oct 22, $440.01 above cushion',
    )
    expect(optionWhy(c, 'spendLess', c.spendLess)).toBe('fits today if you skip the desk chair')
  })
  it('counts a miss of exactly a tenth of the price as small, and anything more as not', () => {
    const c = compare(44900, 'Desk chair')
    const missing = (headroomCents: number) => ({ ...c.buyToday, headroomCents })
    expect(smallMiss(missing(-1000), 10000)).toBe(true)
    expect(smallMiss(missing(-1001), 10000)).toBe(false)
    expect(smallMiss(missing(0), 10000)).toBe(false)
    expect(smallMiss(missing(-1), 5)).toBe(false)
  })
  it('says “Leaves exactly your cushion” when the lowest point lands on it', () => {
    const c = compare(44001, 'Desk chair')
    expect(c.buyToday.headroomCents).toBe(0)
    expect(optionWhy(c, 'buyToday', c.buyToday)).toBe('Leaves exactly your cushion on Thu, Oct 22')
    expect(optionWhy(c, 'wait', { ...c.buyToday, headroomCents: 0 } as OptionResult)).toBe(
      'Leaves exactly your cushion on Thu, Oct 22',
    )
  })
  it('keeps a large miss to the day it starts', () => {
    const c = compare(119900, 'Everyday camera')
    expect(smallMiss(c.buyToday, c.amountCents)).toBe(false)
    expect(optionWhy(c, 'buyToday', c.buyToday)).toBe('Below cushion from today')
  })
  it('shows Something cheaper as the alternative: Fits today, Up to, the item it skips', async () => {
    show('chair')
    const group = await screen.findByRole('radiogroup', { name: 'Your options' })
    const cards = within(group).getAllByRole('radio')
    expect(cards.map((card) => card.querySelector('.ot')!.textContent)).toEqual([
      'Buy today',
      'Wait until Fri, Oct 23',
      'Something cheaper',
    ])
    const cheaper = cards[2]!
    expect(within(cheaper).getByText('Fits today')).toBeTruthy()
    expect(within(cheaper).getByText('Up to')).toBeTruthy()
    expect(within(cheaper).getByText('$440.01')).toBeTruthy()
    expect(within(cheaper).getByText('fits today if you skip the desk chair')).toBeTruthy()
    // Similar items are off here, so the card doesn't offer them.
    expect(within(cheaper).queryByText('See similar items')).toBeNull()
    expect(group.textContent).not.toContain('Spend less')
    expect(group.textContent).not.toContain('Lowest that day')
    // No stress ("Tight") label on a card.
    expect(group.textContent).not.toContain('Tight')
    expect(group.querySelectorAll('.why')).toHaveLength(3)
  })
})

describe('Compare with PayPal Pay in 4 (feedback item 6)', () => {
  it('drops “illustrative” from the header, keeps the disclosure, and fixes each block’s lines', async () => {
    const user = userEvent.setup()
    show('chair')
    const head = await screen.findByRole('button', { name: /Compare with PayPal Pay in 4/ })
    expect(head.textContent).toContain('4 payments of $112.25, about every 2 weeks from today')
    expect(head.textContent).not.toContain('illustrative')
    await user.click(head)
    expect(screen.getByText(/Schedule is illustrative/)).toBeTruthy()
    const cards = within(
      screen.getByRole('list', { name: 'Illustrative Pay in 4 schedule' }),
    ).getAllByRole('listitem')
    expect(cards).toHaveLength(4)
    for (const [index, card] of cards.entries()) {
      // The date block: "Today" alone, or "About" over the date.
      const when = card.querySelector('.when')!
      if (index === 0) expect(when.textContent).toBe('Today')
      else expect(when.querySelector('.about')!.textContent).toBe('About')
      // The relation: the gap on one line, the bill on the next.
      const near = card.querySelector('.near')!
      expect(near.querySelector('.rel')!.textContent).toMatch(/^About \d+ days? (before|after)$/)
      expect(near.querySelector('.bill')!.textContent).toBeTruthy()
      // "Lowest after" over "$X · Thu, Oct 15".
      const after = card.querySelector('.after')!
      expect(after.querySelector('.lbl')!.textContent).toBe('Lowest after')
      expect(after.querySelector('.val')!.textContent).toMatch(
        /^\$[\d,]+\.\d\d · [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/,
      )
    }
  })
})

describe('Why this answer, under the verdict', () => {
  it('reads Worth’s own sentence straight after the verdict, open, with nothing left in the rail', async () => {
    show('chair')
    const why = await screen.findByRole('region', { name: 'Why this answer' })
    const verdict = document.querySelector('.verdict-block')!
    expect(verdict.nextElementSibling).toBe(why)
    expect(why.textContent).toContain('Worth projected your balance each day for the next 60 days')
    expect(why.textContent).toContain('Worth’s own calculation · next 60 days')
    expect(screen.queryByRole('button', { name: /What went into this|Why this answer/ })).toBeNull()
    expect(document.querySelector('.decision-rail .fold, .decision-rail .kvlist')).toBeNull()
  })

  it('shows the assistant’s lead and points, at most three when they are long', async () => {
    const long = (n: number) =>
      `Point ${n} ${'is a long explanation that runs on '.repeat(3)}`.trim()
    show('chair', {
      mode: 'anthropic',
      lead: 'Rent leaves before your paycheck lands.',
      points: [long(1), long(2), long(3), long(4)],
      toolCalls: [],
    })
    const why = await screen.findByRole('region', { name: 'Why this answer' })
    expect(why.textContent).toContain('Rent leaves before your paycheck lands.')
    expect(within(why).getAllByRole('listitem')).toHaveLength(3)
    expect(why.textContent).toContain('Worth’s assistant picked these facts for your question')
  })

  it('shows every point when all of them are short', async () => {
    show('chair', {
      mode: 'anthropic',
      points: ['One.', 'Two.', 'Three.', 'Four.'],
      toolCalls: [],
    })
    const why = await screen.findByRole('region', { name: 'Why this answer' })
    expect(within(why).getAllByRole('listitem')).toHaveLength(4)
  })
})
