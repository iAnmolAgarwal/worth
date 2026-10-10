// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'
import { api } from '../src/api'
import { Home } from '../src/Home'
import { weekGroups } from '../src/Month'
import { ImportReview, StartCard, type ChosenFile } from '../src/Onboarding'
import { parsePayPalCsv } from '../shared/csv'
import { compareOptions } from '../shared/finance'
import { draftFlows, draftPlans, planFlows, shiftSampleExport } from '../shared/onboarding'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type { AppState, FinancialProfile, ScheduledFlow } from '../shared/types'

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>()
  return { ...actual, api: vi.fn() }
})

const TODAY = '2026-10-10'
const apiMock = vi.mocked(api)
const SAMPLE = readFileSync(`${process.cwd()}/src/sample/paypal-activity-sample.csv`, 'utf8')
// The sample as the app loads it today: moved to end yesterday, Fri, Oct 9.
const CSV = shiftSampleExport(SAMPLE, TODAY)
const FILE: ChosenFile = { csv: CSV, name: 'Download.CSV' }
const preview = parsePayPalCsv(CSV, [], { today: TODAY })
const rent: ScheduledFlow = {
  id: 'you-rent',
  name: 'Maple Court rent',
  amountCents: 165000,
  nextDate: '2026-10-22',
  cadence: 'monthly',
  kind: 'bill',
  category: 'Other',
  icon: 'home',
  confirmed: true,
  active: true,
  origin: 'you',
}

function demoState(): AppState {
  const seed = createDemoState(TODAY)
  return {
    ...seed,
    profile: { ...seed.profile, userEdited: false, aiConsent: false },
    reviews: [],
    today: TODAY,
    products: PRODUCTS,
    saved: [],
    config: { ai: 'demo', paypal: 'demo' },
  }
}
/** The sample export imported and confirmed: everything from PayPal, rent added, $2,600 today. */
function monthState(): AppState {
  const base = demoState()
  const plans = draftPlans(preview.instalmentPlans).filter((plan) => plan.merchant)
  return {
    ...base,
    transactions: [],
    profile: {
      ...base.profile,
      name: 'Your plan',
      source: 'import',
      version: 3,
      userEdited: true,
      balanceCents: 260000,
      cushionCents: 30000,
      dailySpendCents: preview.suggestedDailySpendCents,
      coverageDays: preview.coverageDays,
      snapshotDate: TODAY,
      confirmed: true,
      missingFields: [],
      flows: [...draftFlows(preview, []), rent, ...plans.flatMap((plan) => planFlows(plan, TODAY))],
    },
    purchases: [],
  }
}
function compare(state: AppState) {
  return compareOptions(state.profile, state.purchases, { amountCents: 0, today: TODAY })
}
function phone(on: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: on,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
}
function renderHome(state: AppState, extra: Partial<Parameters<typeof Home>[0]> = {}) {
  apiMock.mockImplementation((() => Promise.resolve(compare(state))) as typeof api)
  return render(
    <Home
      state={state}
      onAsk={vi.fn()}
      onNavigate={vi.fn()}
      onOpenProduct={vi.fn()}
      onEditPlan={vi.fn()}
      onOpenCheckout={vi.fn()}
      onConfirmPlan={vi.fn()}
      onReviewRefund={vi.fn()}
      {...extra}
    />,
  )
}

beforeEach(() => {
  apiMock.mockReset()
  window.history.replaceState(null, '', '/')
  vi.stubGlobal('scrollTo', vi.fn())
  phone(false)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Check what Worth found', () => {
  function reviewApi() {
    const calls: { path: string; data: unknown; method?: string }[] = []
    const imported = monthState()
    imported.profile = {
      ...imported.profile,
      confirmed: false,
      flows: preview.recurring,
      version: 2,
    }
    apiMock.mockImplementation(((path: string, data: unknown, method?: string) => {
      calls.push({ path, data, method })
      if (path === '/import/preview') return Promise.resolve(preview)
      if (path === '/import/commit') return Promise.resolve(imported)
      if (path === '/profile') {
        const { profile } = data as { profile: FinancialProfile }
        return Promise.resolve({ ...imported, profile: { ...profile, version: 3 } })
      }
      return Promise.reject(new Error(`Unexpected ${path}`))
    }) as typeof api)
    return calls
  }
  function renderReview(onDone = vi.fn()) {
    return render(
      <ImportReview
        state={demoState()}
        file={FILE}
        onFile={vi.fn()}
        onEnterYourself={vi.fn()}
        onCancel={vi.fn()}
        onImported={vi.fn()}
        onDone={onDone}
      />,
    )
  }

  it('lists what PayPal shows, ticked and tagged, with the estimate labelled', async () => {
    reviewApi()
    renderReview()
    await screen.findByText('Northwind Payroll')
    const paydays = screen.getByRole('region', { name: 'Paydays' })
    expect(within(paydays).getByText('1 from PayPal')).toBeTruthy()
    expect(within(paydays).getByText(/Every other Tuesday · next about Tue, Oct 20/)).toBeTruthy()
    const bills = screen.getByRole('region', { name: 'Bills and subscriptions' })
    expect(within(bills).getAllByRole('checkbox')).toHaveLength(4)
    expect(
      within(bills)
        .getAllByRole('checkbox')
        .every((box) => (box as HTMLInputElement).checked),
    ).toBe(true)
    expect(within(bills).getAllByText('From PayPal')).toHaveLength(4)
    const plans = screen.getByRole('region', { name: 'PayPal Pay in 4 plans in progress (2)' })
    expect(
      within(plans).getByText(/2 of 4 paid · \$74\.97 each · next about Fri, Oct 23/),
    ).toBeTruthy()
    expect(
      within(plans).getByText(/3 of 4 paid · \$45\.00 each · last one about Fri, Oct 16/),
    ).toBeTruthy()
    expect(within(plans).getByText(/PayPal sets the actual schedule/)).toBeTruthy()
    expect(screen.getByText(/About \$\d+\.\d\d a day/)).toBeTruthy()
    expect(screen.getByText(/Raw CSV files aren’t saved/)).toBeTruthy()
  })

  it('adds a bill PayPal doesn’t see, notes the plan payment the day after it and saves both origins', async () => {
    const user = userEvent.setup()
    const calls = reviewApi()
    const onDone = vi.fn()
    renderReview(onDone)
    await screen.findByText('Northwind Payroll')
    expect(screen.queryByText(/the day after Maple Court rent/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Add a bill PayPal doesn’t see' }))
    await user.type(screen.getByRole('textbox', { name: 'Bill name' }), 'Maple Court rent')
    await user.type(screen.getByRole('textbox', { name: 'Bill amount' }), '1650')
    for (let day = 0; day < 12; day++)
      await user.click(screen.getByRole('button', { name: 'Next due date: a day later' }))
    await user.click(screen.getByRole('button', { name: 'Add bill' }))
    const bills = screen.getByRole('region', { name: 'Bills and subscriptions' })
    expect(within(bills).getByText('Maple Court rent')).toBeTruthy()
    expect(within(bills).getByText('You added')).toBeTruthy()
    // The collision note runs on the draft, before anything is saved.
    expect(
      screen.getByText('Payment 3 of 4: $74.97 on Fri, Oct 23, the day after Maple Court rent.'),
    ).toBeTruthy()

    // Untick a subscription that ended.
    await user.click(screen.getByRole('checkbox', { name: 'Include Tidewave Music' }))
    // The undated plan must be answered before Continue goes on.
    await user.type(screen.getByRole('textbox', { name: /Money available today/ }), '2600')
    await user.type(screen.getByRole('textbox', { name: /Cushion/ }), '300')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('alert').textContent).toContain(
      'Choose how many payments of $62.50 are left, or All paid.',
    )
    expect(calls.some((call) => call.path === '/import/commit')).toBe(false)
    // Chips work from the keyboard.
    const chip = screen.getByRole('radio', { name: '1 left' })
    chip.focus()
    await user.keyboard('{Enter}')
    expect(chip.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(/Next about Tue, Oct 20\./)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(calls.map((call) => call.path)).toEqual([
      '/import/preview',
      '/import/commit',
      '/profile',
    ])
    const { profile } = calls[2]!.data as { profile: FinancialProfile }
    expect(profile).toMatchObject({ balanceCents: 260000, cushionCents: 30000, confirmed: true })
    const byName = (name: string) => profile.flows.filter((flow) => flow.name === name)
    expect(byName('Maple Court rent')[0]).toMatchObject({ origin: 'you', amountCents: 165000 })
    expect(byName('Tidewave Music')[0]).toMatchObject({ origin: 'paypal', active: false })
    expect(byName('Larkspur Supply · Headphones · Pay in 4')).toMatchObject([
      { nextDate: '2026-10-23', planTotalCents: 29988 },
      { nextDate: '2026-11-06', planTotalCents: 29988 },
    ])
    expect(byName('Earlier purchase · Pay in 4')).toMatchObject([
      { nextDate: '2026-10-20', amountCents: 6250, origin: 'paypal' },
    ])
  })

  it('leaves a plan out when it is unticked or all paid', async () => {
    const user = userEvent.setup()
    const calls = reviewApi()
    renderReview()
    await screen.findByText('Northwind Payroll')
    await user.click(
      screen.getByRole('checkbox', { name: 'Include Northline Outfitters Pay in 4 plan' }),
    )
    await user.click(screen.getByRole('radio', { name: 'All paid' }))
    await user.type(screen.getByRole('textbox', { name: /Money available today/ }), '2600')
    await user.type(screen.getByRole('textbox', { name: /Cushion/ }), '0')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(calls.at(-1)?.path).toBe('/profile'))
    const { profile } = calls.at(-1)!.data as { profile: FinancialProfile }
    const plans = new Set(
      profile.flows.filter((flow) => flow.kind === 'installment').map((flow) => flow.name),
    )
    expect([...plans]).toEqual(['Larkspur Supply · Headphones · Pay in 4'])
  })

  it('asks for today’s money before importing', async () => {
    const user = userEvent.setup()
    const calls = reviewApi()
    renderReview()
    await screen.findByText('Northwind Payroll')
    await user.click(screen.getByRole('radio', { name: 'All paid' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('alert').textContent).toBe(
      'Enter your money available today, such as 1800.00.',
    )
    expect(
      screen.getByRole('textbox', { name: /Money available today/ }).getAttribute('aria-invalid'),
    ).toBe('true')
    expect(calls.map((call) => call.path)).toEqual(['/import/preview'])
  })
})

describe('Start with your PayPal activity', () => {
  it('runs the bundled sample export through the import', async () => {
    const user = userEvent.setup()
    const onFile = vi.fn()
    render(<StartCard state={demoState()} onFile={onFile} onEnterYourself={vi.fn()} />)
    const card = screen.getByRole('region', { name: 'Start with your PayPal activity' })
    expect(
      within(card)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Log in at paypal.com and open Activity.',
      'Choose Statements › Download. It’s next to the search box.',
      'Pick CSV and the last 90 days, then save the file.',
    ])
    await user.click(within(card).getByRole('button', { name: 'Try with a sample PayPal export' }))
    await waitFor(() => expect(onFile).toHaveBeenCalled())
    const file = onFile.mock.calls[0]![0] as ChosenFile
    expect(file).toMatchObject({ name: 'Sample PayPal export (fictional)', sample: true })
    expect(file.csv).toContain('"Northwind Payroll","Direct Deposit"')
  })

  it('reads a chosen CSV and refuses one over 1 MB', async () => {
    const user = userEvent.setup()
    const onFile = vi.fn()
    render(<StartCard state={demoState()} onFile={onFile} onEnterYourself={vi.fn()} />)
    const input = screen.getByLabelText('Choose your PayPal activity CSV')
    await user.upload(input, new File(['x'.repeat(1_100_000)], 'big.csv', { type: 'text/csv' }))
    expect(screen.getByRole('alert').textContent).toContain('smaller than 1 MB')
    await user.upload(input, new File([SAMPLE], 'Download.CSV', { type: 'text/csv' }))
    await waitFor(() => expect(onFile).toHaveBeenCalledWith({ csv: SAMPLE, name: 'Download.CSV' }))
  })

  it('is one compact row: the actions first, the steps and privacy behind a disclosure', async () => {
    const user = userEvent.setup()
    const onFile = vi.fn()
    renderHome(demoState(), { onImportFile: onFile })
    const hero = await screen.findByRole('region', { name: 'Room to spend today' })
    const card = screen.getByRole('region', { name: 'Start with your PayPal activity' })
    expect(card.compareDocumentPosition(hero) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(card).getByText(/^You’re viewing Maya’s sample month\./)).toBeTruthy()
    const how = card.querySelector('details')!
    expect(how.open).toBe(false)
    expect(within(how).getByText('How to get the file from PayPal').tagName).toBe('SUMMARY')
    expect(within(how).getAllByRole('listitem', { hidden: true })).toHaveLength(3)
    expect(how.textContent).toContain('Raw CSV files aren’t saved')
    await user.click(within(how).getByText('How to get the file from PayPal'))
    expect(how.open).toBe(true)
    // A CSV dropped anywhere on the card is read like a chosen one.
    const file = new File([CSV], 'Download.CSV', { type: 'text/csv' })
    fireEvent.drop(card, { dataTransfer: { files: [file] } })
    await waitFor(() => expect(onFile).toHaveBeenCalledWith({ csv: CSV, name: 'Download.CSV' }))
  })

  it('opens the review at #import from the sample button in the app', async () => {
    const user = userEvent.setup()
    const state = demoState()
    apiMock.mockImplementation(((path: string) =>
      Promise.resolve(
        path === '/state' ? state : path === '/import/preview' ? preview : compare(state),
      )) as typeof api)
    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'Try with a sample PayPal export' }))
    await waitFor(() => expect(window.location.hash).toBe('#import'))
    expect(await screen.findByRole('heading', { name: 'Check what Worth found' })).toBeTruthy()
    expect(await screen.findByText('Sample PayPal export (fictional)')).toBeTruthy()
    expect(apiMock).toHaveBeenCalledWith('/import/preview', {
      csv: expect.stringContaining('Northwind Payroll'),
    })
  })
})

describe('the month-led Home for imported PayPal activity', () => {
  it('groups days by calendar week, as PayPal Activity does', () => {
    const days = [
      '2026-10-07',
      '2026-10-10',
      '2026-10-11',
      '2026-10-17',
      '2026-10-24',
      '2026-11-05',
    ]
    expect(
      weekGroups(
        days.map((date) => ({ date })),
        '2026-10-07',
      ).map((group) => [group.label, group.items.length]),
    ).toEqual([
      ['This week', 2],
      ['Oct 11 – Oct 17', 2],
      ['Oct 18 – Oct 24', 1],
      ['Nov 1 – Nov 7', 1],
    ])
  })

  it('leads with the month from PayPal, the next 30 days by week and the plans in progress', async () => {
    renderHome(monthState())
    const hero = await screen.findByRole('region', {
      name: 'Your month from PayPal · room to spend today, estimated',
    })
    await waitFor(() => expect(hero.textContent).toContain('With what you’ve confirmed'))
    expect(hero.textContent).toMatch(/Your lowest point is about \$[\d,]+ on/)
    const next = screen.getByRole('region', { name: 'Next 30 days' })
    expect(
      within(next)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(['Oct 11 – Oct 17', 'Oct 18 – Oct 24'])
    expect(within(next).getByText(/Payment 3 of 4 · from PayPal/)).toBeTruthy()
    expect(within(next).getByText('The day after Maple Court rent.')).toBeTruthy()
    expect(within(next).getByText(/Bill · monthly · you added/)).toBeTruthy()
    const cards = screen.getAllByRole('article')
    expect(cards.map((card) => card.getAttribute('aria-label'))).toEqual([
      'Northline Outfitters Pay in 4 plan',
      'Larkspur Supply Pay in 4 plan',
    ])
    expect(within(cards[1]!).getByText('2 of 4 paid')).toBeTruthy()
    expect(
      within(cards[1]!).getByText(
        'Payment 3 of 4: $74.97 on Fri, Oct 23, the day after Maple Court rent.',
      ),
    ).toBeTruthy()
    const built = screen.getByRole('region', { name: 'How your month was built' })
    expect(built.textContent).toContain('1 payday, 4 bills and subscriptions, 2 Pay in 4 plans')
    expect(built.textContent).toContain('Maple Court rent, paid outside PayPal')
    expect(built.textContent).toContain('Money available today: $2,600.00 · cushion $300.00')
    // Maya's own pieces are not on this Home.
    expect(screen.queryByRole('region', { name: 'Coming up' })).toBeNull()
    expect(screen.queryByText(/You’re viewing Maya’s sample month/)).toBeNull()
  })

  it('orders a phone screen: the answer, the plan summary, the next days, then the composer', async () => {
    renderHome(monthState())
    const hero = await screen.findByRole('region', { name: /Your month from PayPal/ })
    const line = screen.getByText(/in progress · next about Oct 16/).closest('p')!
    const next = screen.getByRole('region', { name: 'Next 30 days' })
    const ask = screen.getByRole('region', { name: 'Thinking about buying something?' })
    const plans = screen.getByRole('region', { name: 'PayPal Pay in 4 plans in progress (2)' })
    const order = [hero, line, next, ask, plans]
    for (let index = 1; index < order.length; index++)
      expect(
        order[index - 1]!.compareDocumentPosition(order[index]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    expect(line.className).toContain('show-m')
    expect(line.textContent).toBe('PayPal Pay in 4: 2 in progress · next about Oct 16')
  })

  it('keeps Maya’s sample Home as it was', async () => {
    renderHome(demoState(), { onImportFile: vi.fn() })
    expect(await screen.findByRole('region', { name: 'Room to spend today' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Coming up' })).toBeTruthy()
    expect(screen.getByRole('complementary', { name: 'Saved and your plan' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Next 30 days' })).toBeNull()
    expect(screen.queryByText(/How your month was built/)).toBeNull()
  })
})
