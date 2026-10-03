// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImportDialog } from '../src/PlanDialogs'
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
    ...overrides,
  }
}

async function pasteAndPreview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText('Or paste the CSV contents'))
  await user.type(screen.getByRole('textbox', { name: 'PayPal CSV contents' }), CSV)
  await user.click(screen.getByRole('button', { name: /Preview my history/ }))
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
    const importButton = screen.getByRole('button', { name: /Import & review my plan/ })
    expect((importButton as HTMLButtonElement).disabled).toBe(true)

    await user.click(screen.getByRole('radio', { name: /Day first/ }))
    expect(apiMock).toHaveBeenLastCalledWith('/import/preview', { csv: CSV, dateOrder: 'DD/MM' })
    await user.click(await screen.findByRole('checkbox', { name: /I reviewed this preview/ }))
    // The choice stays visible so it can be changed before importing.
    expect((screen.getByRole('radio', { name: /Day first/ }) as HTMLInputElement).checked).toBe(
      true,
    )
    await user.click(screen.getByRole('button', { name: /Import & review my plan/ }))
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
