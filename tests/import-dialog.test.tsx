// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImportDialog } from '../src/Import'
import { api } from '../src/api'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type { AppState, ImportPreview, Transaction } from '../shared/types'

vi.mock('../src/api', () => ({ api: vi.fn() }))

const TODAY = '2026-10-03'
const apiMock = vi.mocked(api)
const CSV = 'Date,Name,Currency,Amount\n03/04/2026,Shop,USD,-1.00'

function makeState(): AppState {
  const seed = createDemoState(TODAY)
  return {
    ...seed,
    reviews: [],
    products: PRODUCTS,
    today: TODAY,
    config: { ai: 'demo', paypal: 'demo' },
  }
}

const shop: Transaction = {
  id: 'import:shop',
  date: '2026-04-03',
  name: 'Shop',
  amountCents: -100,
  currency: 'USD',
  category: 'Shopping',
  kind: 'expense',
  status: 'completed',
  source: 'import',
}

function preview(overrides: Partial<ImportPreview> = {}): ImportPreview {
  return {
    transactions: [],
    errors: [],
    duplicates: 0,
    excluded: 0,
    coverageDays: 0,
    totalRows: 1,
    suggestedDailySpendCents: 0,
    recurring: [],
    warnings: [],
    adjustments: [],
    leftOut: { memo: 0, holds: 0, otherCurrency: 0 },
    dateOrder: null,
    needsDateOrder: false,
    unresolved: [],
    converted: [],
    instalmentPlans: [],
    ...overrides,
  }
}

async function pasteAndPreview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Paste CSV text instead' }))
  await user.type(screen.getByRole('textbox', { name: 'PayPal CSV contents' }), CSV)
  await user.click(screen.getByRole('button', { name: 'Use this text' }))
}

beforeEach(() => {
  apiMock.mockReset()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('import dialog', () => {
  it('asks for the date order when the file cannot decide and sends the answer with the import', async () => {
    const user = userEvent.setup()
    const onReview = vi.fn()
    apiMock.mockImplementation(async (path, data) => {
      const order = (data as { dateOrder?: string }).dateOrder
      if (path === '/import/preview')
        return order
          ? preview({ dateOrder: 'DD/MM', transactions: [shop], coverageDays: 1 })
          : preview({ needsDateOrder: true })
      if (path === '/import/commit') return makeState()
      throw new Error(`Unexpected API request: ${path}`)
    })
    render(
      <ImportDialog state={makeState()} onClose={vi.fn()} onUpdate={vi.fn()} onReview={onReview} />,
    )
    await pasteAndPreview(user)
    await screen.findByRole('group', { name: 'How does this file write dates?' })
    expect(screen.queryByRole('checkbox', { name: /I reviewed this preview/ })).toBeNull()
    const importButton = screen.getByRole('button', { name: /Import and review my plan/ })
    expect((importButton as HTMLButtonElement).disabled).toBe(true)

    await user.click(screen.getByRole('radio', { name: /Day first/ }))
    expect(apiMock).toHaveBeenLastCalledWith('/import/preview', { csv: CSV, dateOrder: 'DD/MM' })
    await user.click(await screen.findByRole('checkbox', { name: /I reviewed this preview/ }))
    // The choice stays visible so it can be changed before importing.
    expect((screen.getByRole('radio', { name: /Day first/ }) as HTMLInputElement).checked).toBe(
      true,
    )
    await user.click(screen.getByRole('button', { name: /Import and review my plan/ }))
    expect(apiMock).toHaveBeenLastCalledWith('/import/commit', { csv: CSV, dateOrder: 'DD/MM' })
    expect(onReview).toHaveBeenCalledTimes(1)
  })

  it('does not ask when the file decides its own date order', async () => {
    const user = userEvent.setup()
    apiMock.mockResolvedValue(preview({ dateOrder: 'MM/DD', transactions: [shop] }))
    render(
      <ImportDialog state={makeState()} onClose={vi.fn()} onUpdate={vi.fn()} onReview={vi.fn()} />,
    )
    await pasteAndPreview(user)
    await screen.findByRole('checkbox', { name: /I reviewed this preview/ })
    expect(screen.queryByRole('group', { name: 'How does this file write dates?' })).toBeNull()
    expect(apiMock).toHaveBeenCalledWith('/import/preview', { csv: CSV })
  })
})

describe('import preview details', () => {
  it('lists unresolved foreign payments, possible Pay in 4 plans and balance corrections', async () => {
    const user = userEvent.setup()
    apiMock.mockResolvedValue(
      preview({
        transactions: [shop],
        unresolved: [
          {
            id: 'paypal:F1',
            date: '2026-09-10',
            name: 'Lisbon bakery',
            type: 'Express Checkout Payment',
            currency: 'EUR',
            originalCents: -1200,
          },
        ],
        instalmentPlans: [
          {
            id: 'pay-later:paypal:S1',
            name: 'Test Store',
            startDate: '2026-09-28',
            purchaseCents: 119900,
            paymentCents: 29975,
            payments: [],
            transactionIds: ['paypal:S1'],
          },
        ],
        adjustments: [
          {
            ...shop,
            id: 'paypal:A1',
            name: 'General Account Correction',
            amountCents: 500000,
            kind: 'adjustment',
          },
        ],
      }),
    )
    render(
      <ImportDialog state={makeState()} onClose={vi.fn()} onUpdate={vi.fn()} onReview={vi.fn()} />,
    )
    await pasteAndPreview(user)
    await screen.findByText('Needs attention (3)')
    expect(screen.getByText(/Lisbon bakery · Sep 10 · €12\.00 has no USD cost yet/)).toBeTruthy()
    expect(
      screen.getByText(/Test Store · \$1,199\.00 purchase · payments of about \$299\.75/),
    ).toBeTruthy()
    expect(screen.getByText(/General Account Correction · Apr 3 · \+\$5,000\.00/)).toBeTruthy()
    // Unresolved payments do not block the import itself.
    await user.click(screen.getByRole('checkbox', { name: /I reviewed this preview/ }))
    const importButton = screen.getByRole('button', { name: /Import and review my plan/ })
    expect((importButton as HTMLButtonElement).disabled).toBe(false)
  })

  it('can import a file whose only spending is an unresolved foreign payment', async () => {
    const user = userEvent.setup()
    apiMock.mockResolvedValue(
      preview({
        unresolved: [
          {
            id: 'paypal:F1',
            date: '2026-09-10',
            name: 'Lisbon bakery',
            type: 'Express Checkout Payment',
            currency: 'EUR',
            originalCents: -1200,
          },
        ],
      }),
    )
    render(
      <ImportDialog state={makeState()} onClose={vi.fn()} onUpdate={vi.fn()} onReview={vi.fn()} />,
    )
    await pasteAndPreview(user)
    await user.click(await screen.findByRole('checkbox', { name: /I reviewed this preview/ }))
    const importButton = screen.getByRole('button', { name: /Import and review my plan/ })
    expect((importButton as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('a payment a store reported (C4)', () => {
  it('names the row it counted once, in view, not only in the collapsed list', async () => {
    const user = userEvent.setup()
    const warning =
      'Row 2: matched “Corner Shoes” $129.00 on 2026-10-01 to Larkspur Supply’s report of Travel backpack, so it is counted once.'
    apiMock.mockImplementation(async () =>
      preview({
        duplicates: 1,
        warnings: [warning],
        storeMatches: [
          {
            row: 2,
            name: 'Corner Shoes',
            date: '2026-10-01',
            amountCents: -12900,
            store: 'Larkspur Supply',
            item: 'Travel backpack',
            reportId: 'purchase-p1',
            importId: 'paypal:SHOES-1',
          },
        ],
      }),
    )
    render(
      <ImportDialog state={makeState()} onClose={vi.fn()} onUpdate={vi.fn()} onReview={vi.fn()} />,
    )
    await pasteAndPreview(user)
    const note = await screen.findByText(/Matched “Corner Shoes” \$129\.00 on Oct 1/)
    expect(note.textContent).toContain('to Larkspur Supply’s report of Travel backpack')
    expect(note.closest('details')).toBeNull()
    // Said once: the same warning isn't repeated under "Needs attention".
    expect(screen.queryByText(warning)).toBeNull()
  })
})

describe('one way in', () => {
  it('previews a chosen file at once, with one action and the short promises', async () => {
    const user = userEvent.setup()
    apiMock.mockResolvedValue(preview({ dateOrder: 'MM/DD', transactions: [shop] }))
    render(
      <ImportDialog state={makeState()} onClose={vi.fn()} onUpdate={vi.fn()} onReview={vi.fn()} />,
    )
    const dialog = screen.getByRole('dialog', { name: 'Import PayPal activity' })
    // No separate preview step, and no Connect PayPal while the server has it off.
    expect(within(dialog).queryByRole('button', { name: /Preview/ })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: /Connect PayPal/ })).toBeNull()
    expect(dialog.textContent).toContain('PayPal activity CSV, in USD, up to 1 MB')
    expect(dialog.textContent).toContain('Your history replaces the sample.')
    expect(within(dialog).getByRole('link', { name: 'Privacy' }).getAttribute('href')).toBe(
      '#settings',
    )
    await user.upload(
      within(dialog).getByLabelText('Choose your PayPal activity CSV'),
      new File([CSV], 'Download.CSV', { type: 'text/csv' }),
    )
    await screen.findByRole('checkbox', { name: /I reviewed this preview/ })
    expect(apiMock).toHaveBeenCalledWith('/import/preview', { csv: CSV })
    expect(screen.getByText('Download.CSV')).toBeTruthy()
  })

  it('says why a file over 1 MB is refused, before reading it', async () => {
    const user = userEvent.setup()
    render(
      <ImportDialog state={makeState()} onClose={vi.fn()} onUpdate={vi.fn()} onReview={vi.fn()} />,
    )
    await user.upload(
      screen.getByLabelText('Choose your PayPal activity CSV'),
      new File(['x'.repeat(1_100_000)], 'big.csv', { type: 'text/csv' }),
    )
    expect(screen.getByRole('alert').textContent).toContain('smaller than 1 MB')
    expect(apiMock).not.toHaveBeenCalled()
  })

  it('offers Connect PayPal first when the server has it on', () => {
    const state = makeState()
    state.config = { ...state.config, paypalConnect: 'on' }
    render(<ImportDialog state={state} onClose={vi.fn()} onUpdate={vi.fn()} onReview={vi.fn()} />)
    const connect = screen.getByRole('button', { name: /Connect PayPal/ })
    const choose = screen.getByLabelText('Choose your PayPal activity CSV')
    expect(connect.compareDocumentPosition(choose) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try a sample export' })).toBeTruthy()
    expect(screen.getByText('How to get this file from PayPal').closest('details')).toBeTruthy()
  })
})
