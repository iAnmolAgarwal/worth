// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Home } from '../src/Home'
import { compactMoney, heroSplit, holdChips, upcomingWithPlans } from '../src/Hero'
import { api } from '../src/api'
import { compareOptions } from '../shared/finance'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type { AppState } from '../shared/types'

// Home's hero: the engine's room to spend as a split of the balance, and what holds the rest back.

vi.mock('../src/paypalSdk', () => ({ loadPayPalSdk: vi.fn() }))
vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>()
  return { ...actual, api: vi.fn() }
})

const TODAY = '2026-10-03'
const apiMock = vi.mocked(api)

function makeState(balanceCents?: number): AppState {
  const seed = createDemoState(TODAY)
  return {
    ...seed,
    profile: { ...seed.profile, ...(balanceCents === undefined ? {} : { balanceCents }) },
    reviews: [],
    today: TODAY,
    products: PRODUCTS,
    saved: [],
    config: { ai: 'demo', paypal: 'demo', model: 'test-provider' },
  }
}

const room = (state: AppState) =>
  compareOptions(state.profile, state.purchases, { amountCents: 0, today: TODAY })

function renderHome(state: AppState, props: Partial<Parameters<typeof Home>[0]> = {}) {
  apiMock.mockImplementation((() => Promise.resolve(room(state))) as unknown as typeof api)
  const onAsk = vi.fn()
  const onNavigate = vi.fn()
  render(
    <Home
      state={state}
      onAsk={onAsk}
      onNavigate={onNavigate}
      onOpenProduct={vi.fn()}
      onEditPlan={vi.fn()}
      onOpenCheckout={vi.fn()}
      onConfirmPlan={vi.fn()}
      onReviewRefund={vi.fn()}
      onImportFile={vi.fn()}
      {...props}
    />,
  )
  return { onAsk, onNavigate }
}

afterEach(() => {
  cleanup()
  apiMock.mockReset()
})

describe('heroSplit', () => {
  it('splits the balance into the engine’s room, what is needed and the cushion', () => {
    const state = makeState()
    const comparison = room(state)
    const split = heroSplit(state.profile.balanceCents, comparison)
    expect(split.freeCents).toBe(comparison.spendLess.maxPriceCents)
    expect(split.cushionCents).toBe(comparison.cushionCents)
    expect(split.freeCents + split.neededCents + split.cushionCents).toBe(
      state.profile.balanceCents,
    )
    expect(split.belowCushion).toBe(false)
    expect(split.shortCents).toBe(0)
    // The forecast's own events add up to what is needed by the low point.
    const parts = split.parts!
    expect(parts.billsCents + parts.plansCents + parts.spendingCents - parts.incomeCents).toBe(
      split.neededCents,
    )
    expect(split.lowDate).toBe(comparison.buyToday.lowestDate)
  })

  it('keeps the arithmetic whole when nothing is free and the plan dips below the cushion', () => {
    const state = makeState(80000)
    const comparison = room(state)
    const split = heroSplit(80000, comparison)
    expect(split.freeCents).toBe(0)
    expect(split.neededCents).toBe(80000 - comparison.cushionCents)
    expect(split.belowCushion).toBe(true)
    expect(split.shortCents).toBe(comparison.cushionCents - split.lowCents!)
  })

  it('never draws a negative part when the balance is under the cushion', () => {
    const state = makeState(10000)
    const split = heroSplit(10000, room(state))
    expect(split).toMatchObject({ freeCents: 0, neededCents: 0, cushionCents: 10000 })
  })
})

describe('holdChips', () => {
  it('names the largest bill up to the low point, the next plan payment and the next payday', () => {
    const state = makeState()
    const split = heroSplit(state.profile.balanceCents, room(state))
    const chips = holdChips(upcomingWithPlans(state), split.lowDate)
    expect(chips.map((chip) => chip.key)).toEqual(['bill', 'plan', 'payday'])
    const [bill, plan, payday] = chips
    const upcoming = upcomingWithPlans(state)
    const biggest = Math.max(
      ...upcoming
        .filter(
          ({ flow, date }) =>
            flow.kind !== 'income' && flow.kind !== 'installment' && date <= split.lowDate!,
        )
        .map(({ flow }) => flow.amountCents),
    )
    expect(bill!.amountCents).toBe(biggest)
    expect(plan!.label).toBe('Laptop Pay in 4')
    expect(payday!.date).toBe(upcoming.find(({ flow }) => flow.kind === 'income')!.date)
  })

  it('leaves out what the plan does not have', () => {
    expect(holdChips([])).toEqual([])
  })

  it('shows cents only when there are some', () => {
    expect(compactMoney(145000)).toBe('$1,450')
    expect(compactMoney(32475)).toBe('$324.75')
  })
})

describe('the Home hero', () => {
  it('comes first, with the exact figure, the split, the chips and one action', async () => {
    const user = userEvent.setup()
    const state = makeState()
    const comparison = room(state)
    const { onAsk } = renderHome(state)
    const hero = await screen.findByRole('region', { name: 'Safe to spend today' })
    const exact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
      comparison.spendLess.maxPriceCents / 100,
    )
    await waitFor(() => expect(hero.querySelector('.hero-v .sr')?.textContent).toBe(exact))
    const split = within(hero).getByRole('list', { name: /^Your \$/ })
    expect(split.textContent).toContain('Free')
    expect(split.textContent).toMatch(/Needed through \w+ \d+/)
    expect(split.textContent).toContain('Cushion$300')
    expect(hero.textContent).toContain('in your account')
    const chips = within(hero).getByRole('list', { name: 'What holds the rest back' })
    expect(within(chips).getAllByRole('listitem')).toHaveLength(3)
    expect(chips.textContent).toContain('Laptop Pay in 4')
    expect(chips.textContent).toContain('Payday +$')
    // The hedging is behind the info, not on the face.
    const info = within(hero).getByLabelText('How Worth worked this out').closest('details')!
    expect(info.open).toBe(false)
    expect(info.textContent).toContain('cushion, if your plan holds')
    // The first section on the page is the hero.
    expect(document.querySelector('section')).toBe(hero)
    await user.click(within(hero).getByRole('link', { name: /Check a purchase/ }))
    expect(onAsk).toHaveBeenCalledWith()
  })

  it('says nothing is free, and by how much the plan is short, when the room is zero', async () => {
    const state = makeState(80000)
    renderHome(state)
    const hero = await screen.findByRole('region', { name: 'Safe to spend today' })
    await waitFor(() => expect(hero.querySelector('.hero-v .sr')?.textContent).toBe('$0.00'))
    expect(hero.textContent).toMatch(/Nothing free through \w+ \d+/)
    expect(hero.textContent).toMatch(/Short by \$[\d.,]+ on/)
    expect(hero.textContent).toContain('already dips below your $300.00 cushion')
  })

  it('has no inline composer, and the rail opens Connect an agent', async () => {
    const user = userEvent.setup()
    const { onNavigate } = renderHome(makeState())
    await screen.findByRole('region', { name: 'Safe to spend today' })
    expect(screen.queryByRole('search')).toBeNull()
    expect(screen.queryByText('Thinking about buying something?')).toBeNull()
    const rail = screen.getByRole('complementary', { name: 'Saved and your plan' })
    await user.click(within(rail).getByRole('button', { name: /Connect an agent/ }))
    expect(onNavigate).toHaveBeenCalledWith('settings')
  })
})
