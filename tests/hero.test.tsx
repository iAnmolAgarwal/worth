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

  it('counts the cushion the plan eats as needed when it dips into the cushion', () => {
    const state = makeState(80000)
    const comparison = room(state)
    const split = heroSplit(80000, comparison)
    const low = split.lowCents!
    expect(low).toBeGreaterThan(0)
    expect(low).toBeLessThan(comparison.cushionCents)
    // Only what is left at the low point is cushion; the rest is needed.
    expect(split).toMatchObject({ freeCents: 0, cushionCents: low, neededCents: 80000 - low })
    expect(split.belowCushion).toBe(true)
    expect(split.shortCents).toBe(comparison.cushionCents - low)
  })

  it('shows the whole balance as needed when the plan goes below zero', () => {
    const state = makeState(10000)
    const comparison = room(state)
    const split = heroSplit(10000, comparison)
    expect(split.lowCents!).toBeLessThan(0)
    expect(split).toMatchObject({ freeCents: 0, cushionCents: 0, neededCents: 10000 })
    expect(split.shortCents).toBe(comparison.cushionCents - split.lowCents!)
  })

  it('shows the whole balance as needed for a plan with no pay coming in', () => {
    const state = makeState()
    state.profile = {
      ...state.profile,
      flows: state.profile.flows.filter((flow) => flow.kind !== 'income'),
    }
    const comparison = room(state)
    const split = heroSplit(state.profile.balanceCents, comparison)
    expect(split.parts!.incomeCents).toBe(0)
    expect(split.lowCents!).toBeLessThan(0)
    expect(split).toMatchObject({
      freeCents: 0,
      cushionCents: 0,
      neededCents: state.profile.balanceCents,
    })
    expect(split.freeCents + split.neededCents + split.cushionCents).toBe(
      state.profile.balanceCents,
    )
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

  it.each([
    [80000, 'dips into the cushion'],
    [10000, 'goes below zero'],
  ])('says the plan is short, never that $0 is needed, at %i cents (%s)', async (cents) => {
    const state = makeState(cents)
    const split = heroSplit(cents, room(state))
    renderHome(state)
    const hero = await screen.findByRole('region', { name: 'Safe to spend today' })
    await waitFor(() => expect(hero.querySelector('.hero-v .sr')?.textContent).toBe('$0.00'))
    const legend = within(hero).getByRole('list', { name: /^Your \$/ })
    expect(legend.textContent).toContain('Nothing free')
    expect(legend.textContent).not.toMatch(/Nothing free through/)
    expect(legend.textContent).toContain(`Needed through`)
    expect(legend.textContent).toContain(compactMoney(split.neededCents))
    expect(legend.textContent).not.toMatch(/\$0(?![\d.,])/)
    expect(legend.textContent).toContain(`Short by ${compactMoney(split.shortCents)} on`)
    if (split.cushionCents) expect(legend.textContent).toContain('Cushion left')
    else expect(legend.textContent).not.toContain('Cushion')
    expect(hero.textContent).toContain('already dips below your $300.00 cushion')
    // The bar draws each part by its amount, so none is clipped.
    const bar = hero.querySelector('.hero-bar')!
    expect([...bar.children].map((part) => (part as HTMLElement).style.flexGrow)).toEqual(
      [split.neededCents, split.cushionCents].filter(Boolean).map(String),
    )
  })

  it('closes the info on Escape and on a click outside, focus back on its summary', async () => {
    const user = userEvent.setup()
    renderHome(makeState())
    const hero = await screen.findByRole('region', { name: 'Safe to spend today' })
    const summary = await within(hero).findByLabelText('How Worth worked this out')
    const details = summary.closest('details')!
    await user.click(summary)
    expect(details.open).toBe(true)
    await user.keyboard('{Escape}')
    expect(details.open).toBe(false)
    expect(document.activeElement).toBe(summary)
    await user.click(summary)
    expect(details.open).toBe(true)
    await user.click(within(hero).getByText('Safe to spend today'))
    expect(details.open).toBe(false)
    await waitFor(() => expect(document.activeElement).toBe(summary))
    // A click inside the popover keeps it open.
    await user.click(summary)
    await user.click(details.querySelector('.hero-pop p')!)
    expect(details.open).toBe(true)
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
