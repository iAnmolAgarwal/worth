// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlanDialog } from '../src/PlanDialogs'
import { api } from '../src/api'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type { AppState, FinancialProfile, Purchase } from '../shared/types'

vi.mock('../src/api', () => ({ api: vi.fn() }))

const TODAY = '2026-10-03'
const apiMock = vi.mocked(api)
type User = ReturnType<typeof userEvent.setup>

function makeState(): AppState {
  const seed = createDemoState(TODAY)
  return {
    ...seed,
    profile: {
      ...seed.profile,
      flows: seed.profile.flows.filter((flow) => ['salary', 'rent', 'music'].includes(flow.id)),
    },
    reviews: [],
    products: PRODUCTS,
    today: TODAY,
    config: { ai: 'anthropic', paypal: 'demo' },
  }
}

function completedPurchase(id: string): Purchase {
  return {
    id,
    productId: 'headphones',
    name: id === 'included-purchase' ? 'Already included headphones' : 'Recent camera',
    amountCents: 34900,
    currency: 'USD',
    mode: 'demo',
    status: 'completed',
    createdAt: `${TODAY}T10:00:00Z`,
    completedAt: `${TODAY}T10:01:00Z`,
    profileVersion: 1,
    assessmentDate: TODAY,
  }
}

async function continueStep(user: User) {
  await user.click(screen.getByRole('button', { name: 'Continue' }))
}
async function reachReview(user: User) {
  await continueStep(user)
  await continueStep(user)
  await continueStep(user)
  await screen.findByRole('heading', { name: 'One last look.' })
}
const value = (label: RegExp) =>
  (screen.getByRole('spinbutton', { name: label }) as HTMLInputElement).value
const checked = (label: RegExp) =>
  (screen.getByRole('checkbox', { name: label }) as HTMLInputElement).checked

beforeEach(() => {
  apiMock.mockReset()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('financial picture wizard', () => {
  it('validates the current step, keeps edits when going Back, focuses the new heading, and never saves on Enter', async () => {
    const user = userEvent.setup()
    render(<PlanDialog state={makeState()} onClose={vi.fn()} onUpdate={vi.fn()} />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1')
    expect(screen.queryByRole('button', { name: /Edit Biweekly paycheck/ })).toBeNull()
    const funds = screen.getByRole('spinbutton', { name: /^Available funds/ })
    await user.clear(funds)
    await continueStep(user)
    expect(screen.getByRole('alert').textContent).toContain('Enter available funds')
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1')
    await user.type(funds, '4800.25')
    await user.keyboard('{Enter}')
    expect(apiMock).not.toHaveBeenCalled()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1')
    await continueStep(user)
    const incomeHeading = await screen.findByRole('heading', { name: 'Know what’s coming in.' })
    expect(document.activeElement).toBe(incomeHeading)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe(
      'Step 2 of 4: Income',
    )
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(value(/^Available funds/)).toBe('4800.25')
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1')
    await user.click(screen.getByText('Name & time zone'))
    const zone = screen.getByRole('combobox', { name: 'Time zone' })
    await user.clear(zone)
    await user.type(zone, 'Not/A_Zone')
    await continueStep(user)
    expect(screen.getByRole('alert').textContent).toContain('valid time zone')
    expect(apiMock).not.toHaveBeenCalled()
  })

  it('keeps a single flow editor, supports all schedules and types, and preserves a new item across navigation', async () => {
    const user = userEvent.setup()
    render(<PlanDialog state={makeState()} onClose={vi.fn()} onUpdate={vi.fn()} />)
    await continueStep(user)
    await continueStep(user)
    await user.click(screen.getByRole('button', { name: 'Edit Apartment rent' }))
    expect(screen.getAllByRole('group')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Edit Music streaming' }))
    expect(screen.getAllByRole('group')).toHaveLength(1)
    expect((screen.getByRole('textbox', { name: 'Item name' }) as HTMLInputElement).value).toBe(
      'Music streaming',
    )
    await user.click(screen.getByRole('button', { name: 'Remove Music streaming' }))
    expect(screen.queryByRole('button', { name: 'Edit Music streaming' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Add a bill or subscription' }))
    await user.type(screen.getByRole('textbox', { name: 'Item name' }), 'Annual insurance')
    await user.type(screen.getByRole('spinbutton', { name: 'Amount · USD' }), '123.45')
    fireEvent.change(screen.getByLabelText('Next date'), { target: { value: '2026-11-20' } })
    const repeats = screen.getByRole('combobox', { name: 'Repeats' }) as HTMLSelectElement
    expect(Array.from(repeats.options).map((option) => option.value)).toEqual([
      'once',
      'weekly',
      'biweekly',
      'monthly',
      'yearly',
    ])
    const type = screen.getByRole('combobox', { name: 'Type' }) as HTMLSelectElement
    expect(Array.from(type.options).map((option) => option.value)).toEqual([
      'income',
      'bill',
      'subscription',
      'installment',
    ])
    await user.selectOptions(repeats, 'yearly')
    await user.selectOptions(type, 'subscription')
    await user.click(screen.getByRole('button', { name: 'Confirm item' }))
    await continueStep(user)
    await screen.findByRole('heading', { name: 'One last look.' })
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(screen.getByRole('button', { name: 'Edit Annual insurance' }))
    expect(value(/^Amount/)).toBe('123.45')
    expect((screen.getByLabelText('Next date') as HTMLInputElement).value).toBe('2026-11-20')
    expect((screen.getByRole('combobox', { name: 'Repeats' }) as HTMLSelectElement).value).toBe(
      'yearly',
    )
    expect(checked(/I’ve checked this item/)).toBe(true)
    await user.click(screen.getByRole('checkbox', { name: 'Include in my plan' }))
    expect(checked(/I’ve checked this item/)).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByText(/Yearly · Excluded/)).toBeTruthy()
    expect(apiMock).not.toHaveBeenCalled()
  })

  it('blocks unconfirmed imported income and bills until the user explicitly reviews each suggestion', async () => {
    const user = userEvent.setup()
    const state = makeState()
    state.profile = {
      ...state.profile,
      source: 'import',
      confirmed: false,
      missingFields: ['Review imported suggestions.'],
      flows: state.profile.flows.map((flow) => ({ ...flow, confirmed: false })),
    }
    render(<PlanDialog state={state} onClose={vi.fn()} onUpdate={vi.fn()} />)
    await continueStep(user)
    await continueStep(user)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2')
    expect(screen.getByRole('alert').textContent).toContain('Review and confirm Biweekly paycheck')
    await user.click(screen.getByRole('button', { name: 'Confirm item' }))
    await continueStep(user)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('3')
    await continueStep(user)
    expect(screen.getByRole('alert').textContent).toContain('Review and confirm Apartment rent')
    expect(screen.queryByRole('button', { name: 'Save my plan' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Confirm item' }))
    await user.click(screen.getByRole('button', { name: 'Confirm Music streaming' }))
    await continueStep(user)
    const save = (await screen.findByRole('button', { name: 'Save my plan' })) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(apiMock).not.toHaveBeenCalled()
  })

  it('sends one final reviewed payload with the opening version, explicit purchase inclusion, and opt-in consent', async () => {
    const user = userEvent.setup()
    const state = makeState()
    state.profile = {
      ...state.profile,
      version: 7,
      source: 'import',
      confirmed: false,
      missingFields: ['Review all inputs.'],
      reflectedPurchaseIds: ['included-purchase'],
    }
    state.purchases = [completedPurchase('included-purchase'), completedPurchase('new-purchase')]
    const onUpdate = vi.fn()
    const onClose = vi.fn()
    const updated = {
      ...state,
      profile: { ...state.profile, version: 8, confirmed: true, missingFields: [] },
    }
    apiMock.mockResolvedValue(updated)
    const view = render(<PlanDialog state={state} onUpdate={onUpdate} onClose={onClose} />)
    await reachReview(user)
    expect(screen.getByText('+$4,200.00')).toBeTruthy()
    expect(screen.getByText('$1,461.99')).toBeTruthy()
    expect(checked(/Use my financial context with Claude/)).toBe(false)
    expect(checked(/Already included headphones/)).toBe(true)
    expect(checked(/Recent camera/)).toBe(false)
    await user.click(screen.getByRole('checkbox', { name: /Recent camera/ }))
    await user.click(screen.getByRole('checkbox', { name: /Use my financial context with Claude/ }))
    await user.click(screen.getByRole('checkbox', { name: /I’ve reviewed this financial picture/ }))
    view.rerender(
      <PlanDialog
        state={{ ...state, profile: { ...state.profile, version: 9 } }}
        onUpdate={onUpdate}
        onClose={onClose}
      />,
    )
    expect(apiMock).not.toHaveBeenCalled()
    await user.dblClick(screen.getByRole('button', { name: 'Save my plan' }))
    await waitFor(() => expect(onUpdate).toHaveBeenCalledExactlyOnceWith(updated))
    expect(apiMock).toHaveBeenCalledTimes(1)
    const [path, body, method] = apiMock.mock.calls[0]!
    const submitted = (body as { profile: FinancialProfile }).profile
    expect(path).toBe('/profile')
    expect(method).toBe('PATCH')
    expect(submitted).toMatchObject({
      version: 7,
      source: 'import',
      snapshotDate: TODAY,
      confirmed: true,
      aiConsent: true,
      missingFields: [],
      reflectedPurchaseIds: ['included-purchase', 'new-purchase'],
      balanceCents: 130000,
      cushionCents: 30000,
      dailySpendCents: 3000,
    })
    expect(Number.isFinite(Date.parse(submitted.confirmedAt))).toBe(true)
    expect(submitted.flows).toEqual(state.profile.flows)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('preserves an existing AI sharing choice without silently changing it through the steps', async () => {
    const user = userEvent.setup()
    const state = makeState()
    state.profile.aiConsent = true
    apiMock.mockResolvedValue(state)
    render(<PlanDialog state={state} onUpdate={vi.fn()} onClose={vi.fn()} />)
    await reachReview(user)
    expect(checked(/Use my financial context with Claude/)).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await continueStep(user)
    expect(checked(/Use my financial context with Claude/)).toBe(true)
    await user.click(screen.getByRole('checkbox', { name: /I’ve reviewed this financial picture/ }))
    await user.click(screen.getByRole('button', { name: 'Save my plan' }))
    await waitFor(() => expect(apiMock).toHaveBeenCalledOnce())
    expect((apiMock.mock.calls[0]![1] as { profile: FinancialProfile }).profile.aiConsent).toBe(
      true,
    )
  })

  it('keeps an active reservation protected by blocking plan writes and deletion', async () => {
    const user = userEvent.setup()
    const state = makeState()
    state.purchases = [
      { ...completedPurchase('pending-purchase'), status: 'unknown', completedAt: undefined },
    ]
    render(<PlanDialog state={state} onUpdate={vi.fn()} onClose={vi.fn()} onReset={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toContain('active checkout')
    const next = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement
    const reset = screen.getByRole('button', {
      name: 'Delete my data & start a fresh demo',
    }) as HTMLButtonElement
    expect(next.disabled).toBe(true)
    expect(reset.disabled).toBe(true)
    expect(
      (screen.getByRole('spinbutton', { name: /^Available funds/ }) as HTMLInputElement).disabled,
    ).toBe(true)
    await user.click(next)
    await user.click(reset)
    expect(apiMock).not.toHaveBeenCalled()
  })
})
