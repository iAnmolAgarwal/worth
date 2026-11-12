// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlanPage, PlanWizard } from '../src/Plan'
import { Settings } from '../src/Saved'
import { api } from '../src/api'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type { AppState, FinancialProfile, Purchase } from '../shared/types'

vi.mock('../src/api', () => ({ api: vi.fn() }))
// Chart layout is a browser concern; the review step's chart is not under test here.
vi.mock('../src/BalanceChart', () => ({ BalanceChart: () => null }))

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

const continueStep = (user: User) => user.click(screen.getByRole('button', { name: 'Continue' }))
async function reachReview(user: User) {
  await continueStep(user)
  await continueStep(user)
  await continueStep(user)
  await screen.findByRole('heading', { name: 'Check your plan' })
}
const value = (label: RegExp) =>
  (screen.getByRole('spinbutton', { name: label }) as HTMLInputElement).value
const checked = (label: RegExp) =>
  (screen.getByRole('checkbox', { name: label }) as HTMLInputElement).checked
const wizard = (state: AppState, onSaved = vi.fn()) =>
  render(<PlanWizard state={state} onClose={vi.fn()} onSaved={onSaved} />)

beforeEach(() => {
  apiMock.mockReset()
  vi.stubGlobal('scrollTo', vi.fn())
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('plan setup wizard', () => {
  it('validates the current step inline, keeps edits on Back, focuses each step title and never saves on Enter', async () => {
    const user = userEvent.setup()
    wizard(makeState())
    const progress = screen.getByRole('progressbar')
    expect(progress.getAttribute('aria-valuenow')).toBe('1')
    expect(screen.getByText('Step 1 of 4 · Funds')).toBeTruthy()
    const funds = screen.getByRole('textbox', { name: /^Money available/ })
    await user.clear(funds)
    await continueStep(user)
    expect(screen.getByRole('alert').textContent).toContain('Enter an amount of $0 or more')
    expect(funds.getAttribute('aria-invalid')).toBe('true')
    expect(progress.getAttribute('aria-valuenow')).toBe('1')
    await user.type(funds, '4800.25')
    await user.keyboard('{Enter}')
    expect(apiMock).not.toHaveBeenCalled()
    await continueStep(user)
    const income = await screen.findByRole('heading', { name: 'What money is coming in?' })
    expect(document.activeElement).toBe(income)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe(
      'Step 2 of 4: Income',
    )
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(
      (screen.getByRole('textbox', { name: /^Money available/ }) as HTMLInputElement).value,
    ).toBe('4,800.25')
    await user.click(screen.getByText(/Name and time zone/))
    const zone = screen.getByRole('combobox', { name: 'Time zone' })
    await user.clear(zone)
    await user.type(zone, 'Not/A_Zone')
    await continueStep(user)
    expect(screen.getByRole('alert').textContent).toContain('valid time zone')
    expect(apiMock).not.toHaveBeenCalled()
  })

  it('keeps one item editor open, offers every schedule and keeps a new bill across steps', async () => {
    const user = userEvent.setup()
    wizard(makeState())
    await continueStep(user)
    await continueStep(user)
    await user.click(screen.getByRole('button', { name: 'Edit Apartment rent' }))
    expect(screen.getAllByRole('group', { name: /^Edit/ })).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Edit Music streaming' }))
    expect(screen.getAllByRole('group', { name: /^Edit/ })).toHaveLength(1)
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe(
      'Music streaming',
    )
    await user.click(screen.getByRole('button', { name: 'Remove Music streaming' }))
    expect(screen.queryByRole('button', { name: 'Edit Music streaming' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Add a bill or subscription' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Annual insurance')
    await user.type(screen.getByRole('spinbutton', { name: 'Amount, USD' }), '123.45')
    // The app's date control: seven weeks and back a day, from Sat, Oct 3 to Fri, Nov 20.
    for (let i = 0; i < 7; i++)
      await user.click(screen.getByRole('button', { name: 'Next due date: a week later' }))
    await user.click(screen.getByRole('button', { name: 'Next due date: a day earlier' }))
    const often = screen.getByRole('radiogroup', { name: 'How often' })
    expect(
      within(often)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Weekly', 'Every other week', 'Monthly', 'Yearly', 'One time'])
    await user.click(within(often).getByRole('radio', { name: 'Yearly' }))
    const due = screen.getByRole('combobox', { name: 'Due on' }) as HTMLSelectElement
    expect(Array.from(due.options).at(-1)!.textContent).toBe('Last day of month')
    await user.selectOptions(due, 'last')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'subscription')
    await user.click(screen.getByRole('button', { name: 'Confirm item' }))
    await continueStep(user)
    await screen.findByRole('heading', { name: 'Check your plan' })
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(screen.getByRole('button', { name: 'Edit Annual insurance' }))
    expect(value(/^Amount/)).toBe('123.45')
    expect(
      screen.getByRole('spinbutton', { name: 'Next due date' }).getAttribute('aria-valuetext'),
    ).toBe('Fri, Nov 20')
    expect(
      within(screen.getByRole('radiogroup', { name: 'How often' }))
        .getByRole('radio', { name: 'Yearly' })
        .getAttribute('aria-checked'),
    ).toBe('true')
    await user.click(screen.getByRole('checkbox', { name: 'Include in my plan' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByText(/Yearly · Left out/)).toBeTruthy()
    expect(apiMock).not.toHaveBeenCalled()
  })

  it('asks before counting a bill due today that is already paid', async () => {
    const user = userEvent.setup()
    const state = makeState()
    state.profile.flows = state.profile.flows.map((flow) =>
      flow.id === 'rent' ? { ...flow, nextDate: TODAY } : flow,
    )
    wizard(state)
    await continueStep(user)
    await continueStep(user)
    await user.click(screen.getByRole('button', { name: 'Edit Apartment rent' }))
    await user.click(screen.getByRole('checkbox', { name: /Already paid today/ }))
    expect(checked(/Already paid today/)).toBe(true)
  })

  it('adds a running instalment plan as dated payments that share one plan', async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    const state = makeState()
    apiMock.mockResolvedValue(state)
    wizard(state, onSaved)
    await continueStep(user)
    await continueStep(user)
    await user.click(screen.getByRole('button', { name: 'Add a payment plan' }))
    await user.type(screen.getByRole('textbox', { name: 'Plan name' }), 'Shoes · Pay in 4')
    await user.type(screen.getByRole('spinbutton', { name: 'Amount per payment' }), '37.50')
    await user.clear(screen.getByRole('spinbutton', { name: 'Payments left' }))
    await user.type(screen.getByRole('spinbutton', { name: 'Payments left' }), '2')
    expect(
      screen.getByRole('spinbutton', { name: 'Next payment' }).getAttribute('aria-valuetext'),
    ).toBe('Sat, Oct 17')
    await user.click(screen.getByRole('button', { name: 'Add plan' }))
    expect(screen.getByText(/2 of 4 paid · Next Sat, Oct 17/)).toBeTruthy()
    await continueStep(user)
    await screen.findByRole('heading', { name: 'Check your plan' })
    await user.click(screen.getByRole('checkbox', { name: /My money and bills are as of today/ }))
    await user.click(screen.getByRole('button', { name: 'Save plan' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    const flows = (apiMock.mock.calls[0]![1] as { profile: FinancialProfile }).profile.flows
    const plan = flows.filter((flow) => flow.name === 'Shoes · Pay in 4')
    expect(plan.map((flow) => [flow.nextDate, flow.amountCents, flow.kind, flow.cadence])).toEqual([
      ['2026-10-17', 3750, 'installment', 'once'],
      ['2026-10-31', 3750, 'installment', 'once'],
    ])
    expect(new Set(plan.map((flow) => flow.planId)).size).toBe(1)
    // Entered by hand, so the plan is recorded as added by the user.
    expect(plan.every((flow) => flow.origin === 'you')).toBe(true)
    expect(plan.every((flow) => flow.userDate)).toBe(true)
  })

  it('records a plan reviewed from the import as from PayPal', async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    const state = makeState()
    apiMock.mockResolvedValue(state)
    render(
      <PlanWizard
        state={state}
        initialStep={2}
        suggestedPlans={[
          {
            id: 'pay-later:paypal:S1',
            name: 'Larkspur Supply',
            startDate: '2026-09-19',
            purchaseCents: 29988,
            paymentCents: 7497,
            payments: [{ date: '2026-09-19', amountCents: 7497, status: 'completed' }],
            transactionIds: ['paypal:S1'],
          },
        ]}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Review' }))
    await user.click(screen.getByRole('button', { name: 'Add plan' }))
    await continueStep(user)
    await screen.findByRole('heading', { name: 'Check your plan' })
    await user.click(screen.getByRole('checkbox', { name: /My money and bills are as of today/ }))
    await user.click(screen.getByRole('button', { name: 'Save plan' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    const flows = (apiMock.mock.calls[0]![1] as { profile: FinancialProfile }).profile.flows
    const plan = flows.filter((flow) => flow.name === 'Larkspur Supply · Pay in 4')
    expect(plan).toHaveLength(3)
    expect(plan.every((flow) => flow.origin === 'paypal')).toBe(true)
    // Worth's estimated dates, unchanged, so they still read "about".
    expect(plan.some((flow) => flow.userDate)).toBe(false)
  })

  it('blocks unconfirmed imported income and bills until each suggestion is reviewed', async () => {
    const user = userEvent.setup()
    const state = makeState()
    state.profile = {
      ...state.profile,
      source: 'import',
      confirmed: false,
      missingFields: ['Review imported suggestions.'],
      flows: state.profile.flows.map((flow) => ({ ...flow, confirmed: false })),
    }
    wizard(state)
    await continueStep(user)
    await continueStep(user)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2')
    expect(screen.getByRole('alert').textContent).toContain('Review and confirm Biweekly paycheck')
    await user.click(screen.getByRole('button', { name: 'Confirm item' }))
    await continueStep(user)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('3')
    await continueStep(user)
    expect(screen.getByRole('alert').textContent).toContain('Review and confirm Apartment rent')
    await user.click(screen.getByRole('button', { name: 'Confirm item' }))
    await user.click(screen.getByRole('button', { name: 'Confirm Music streaming' }))
    await continueStep(user)
    const save = (await screen.findByRole('button', { name: 'Save plan' })) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(apiMock).not.toHaveBeenCalled()
  })

  it('sends one reviewed payload with the opening version, purchase inclusion and opt-in consent', async () => {
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
    const onSaved = vi.fn()
    const updated = {
      ...state,
      profile: { ...state.profile, version: 8, confirmed: true, missingFields: [] },
    }
    apiMock.mockResolvedValue(updated)
    const view = wizard(state, onSaved)
    await reachReview(user)
    expect(screen.getByText(/\+\$4,200\.00/)).toBeTruthy()
    expect(screen.getByText(/\$1,461\.99/)).toBeTruthy()
    const consent = screen.getByRole('switch', { name: 'Use the assistant (powered by Claude)' })
    expect(consent.getAttribute('aria-checked')).toBe('false')
    expect(checked(/Already included headphones/)).toBe(true)
    expect(checked(/Recent camera/)).toBe(false)
    await user.click(screen.getByRole('checkbox', { name: /Recent camera/ }))
    await user.click(consent)
    await user.click(screen.getByRole('checkbox', { name: /My money and bills are as of today/ }))
    view.rerender(
      <PlanWizard
        state={{ ...state, profile: { ...state.profile, version: 9 } }}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    )
    expect(apiMock).not.toHaveBeenCalled()
    await user.dblClick(screen.getByRole('button', { name: 'Save plan' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledExactlyOnceWith(updated))
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
  })

  it('keeps an existing Claude choice through the steps', async () => {
    const user = userEvent.setup()
    const state = makeState()
    state.profile.aiConsent = true
    apiMock.mockResolvedValue(state)
    wizard(state)
    await reachReview(user)
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await continueStep(user)
    expect(
      screen
        .getByRole('switch', { name: 'Use the assistant (powered by Claude)' })
        .getAttribute('aria-checked'),
    ).toBe('true')
    await user.click(screen.getByRole('checkbox', { name: /My money and bills are as of today/ }))
    await user.click(screen.getByRole('button', { name: 'Save plan' }))
    await waitFor(() => expect(apiMock).toHaveBeenCalledOnce())
    expect((apiMock.mock.calls[0]![1] as { profile: FinancialProfile }).profile.aiConsent).toBe(
      true,
    )
  })

  it('protects an active reservation by blocking plan writes and data deletion', async () => {
    const user = userEvent.setup()
    const state = makeState()
    state.purchases = [
      { ...completedPurchase('pending-purchase'), status: 'unknown', completedAt: undefined },
    ]
    wizard(state)
    expect(screen.getByRole('status').textContent).toContain('active checkout')
    const next = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement
    expect(next.disabled).toBe(true)
    expect(
      (screen.getByRole('textbox', { name: /^Money available/ }) as HTMLInputElement).disabled,
    ).toBe(true)
    await user.click(next)
    cleanup()
    render(
      <Settings
        state={state}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
        onEditPlan={vi.fn()}
        onImport={vi.fn()}
      />,
    )
    const remove = screen.getByRole('button', { name: 'Delete my data now' }) as HTMLButtonElement
    expect(remove.disabled).toBe(true)
    await user.click(remove)
    // Only Connect an agent's read of the token list; nothing is written or deleted.
    expect(apiMock.mock.calls.filter(([path]) => path !== '/agent-tokens')).toEqual([])
  })
})

describe('plan commitments', () => {
  it('opens on the next 30 days, from Home', () => {
    const state = createDemoState(TODAY)
    render(
      <PlanPage
        state={{
          ...state,
          reviews: [],
          products: PRODUCTS,
          today: TODAY,
          config: { ai: 'demo', paypal: 'demo' },
        }}
        onEdit={vi.fn()}
        onImport={vi.fn()}
        initialTab="soon"
      />,
    )
    expect(screen.getByRole('tab', { name: 'Next 30 days' }).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(screen.getByRole('tabpanel').querySelectorAll('.row').length).toBeGreaterThan(0)
  })

  it('puts the head on the page grid and the summary in a card', () => {
    const state = createDemoState(TODAY)
    render(
      <PlanPage
        state={{
          ...state,
          reviews: [],
          products: PRODUCTS,
          today: TODAY,
          config: { ai: 'demo', paypal: 'demo' },
        }}
        onEdit={vi.fn()}
        onImport={vi.fn()}
      />,
    )
    // The title sits over the list and both buttons over the rail, in one head row.
    const head = screen.getByRole('heading', { level: 1, name: 'Your plan' }).parentElement!
    expect(head.className).toBe('plan-head')
    expect([...head.querySelectorAll('.actions .btn')].map((button) => button.textContent)).toEqual(
      ['Import PayPal activity', 'Edit your plan'],
    )
    const summary = screen.getByRole('complementary', { name: 'Plan summary' }).firstElementChild!
    expect(summary.className).toBe('plan-summary')
    expect(summary.textContent).toContain('Money available')
  })

  it('lists commitments by kind with Edit as the only action and shows running plans with progress', async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    const state = createDemoState(TODAY)
    render(
      <PlanPage
        state={{
          ...state,
          reviews: [],
          products: PRODUCTS,
          today: TODAY,
          config: { ai: 'demo', paypal: 'demo' },
        }}
        onEdit={onEdit}
        onImport={vi.fn()}
      />,
    )
    expect(screen.getByRole('tab', { name: 'Bills' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Apartment rent')).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: 'Pay in 4' }))
    expect(screen.getByText('Laptop · Pay in 4')).toBeTruthy()
    expect(screen.getByRole('img', { name: '1 of 4 paid' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Edit Laptop · Pay in 4' }))
    expect(onEdit).toHaveBeenCalledWith(2)
    await user.click(screen.getByRole('tab', { name: 'Income' }))
    await user.click(screen.getByRole('button', { name: 'Edit Biweekly paycheck' }))
    expect(onEdit).toHaveBeenLastCalledWith(1)
  })
})
