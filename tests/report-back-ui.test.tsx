// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'
import { Activity } from '../src/Activity'
import { api } from '../src/api'
import { compareOptions } from '../shared/finance'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type { AppState, Purchase, Transaction } from '../shared/types'

// C4 in the browser: the store's reported payment in Activity, and the one-time notice.

vi.mock('../src/paypalSdk', () => ({ loadPayPalSdk: vi.fn() }))
vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>()
  return { ...actual, api: vi.fn() }
})
const apiMock = vi.mocked(api)
const TODAY = '2026-10-03'

const reported = (patch: Partial<Purchase> = {}): Purchase => ({
  id: 'p-store',
  productId: 'larkspur:camera',
  name: 'Everyday camera',
  amountCents: 119900,
  currency: 'USD',
  mode: 'sandbox',
  status: 'completed',
  createdAt: `${TODAY}T15:04:05Z`,
  completedAt: `${TODAY}T15:04:05Z`,
  completedOn: TODAY,
  profileVersion: 2,
  assessmentDate: TODAY,
  paymentPlan: { product: 'full' },
  reportedBy: 'Larkspur Supply',
  reportNotice: true,
  ...patch,
})
const row: Transaction = {
  id: 'purchase-p-store',
  date: TODAY,
  name: 'Everyday camera',
  amountCents: -119900,
  currency: 'USD',
  category: 'Shopping',
  kind: 'expense',
  status: 'completed',
  source: 'purchase',
  referenceId: 'store:CAP1',
}
function makeState(purchases: Purchase[] = [reported()]): AppState {
  const seed = createDemoState(TODAY)
  return {
    ...seed,
    transactions: [row, ...seed.transactions],
    purchases,
    reviews: [],
    today: TODAY,
    products: PRODUCTS,
    saved: [],
    retention: { keep30: false, expiresAt: `${TODAY}T16:00:00.000Z` },
    config: { ai: 'demo', paypal: 'sandbox', handoff: 'on' },
  }
}
const props = {
  onUpdate: vi.fn(),
  onAsk: vi.fn(),
  onOpenCheckout: vi.fn(),
  onConfirmPlan: vi.fn(),
  onReviewRefund: vi.fn(),
}

beforeEach(() => {
  apiMock.mockReset()
  vi.stubGlobal('scrollTo', vi.fn())
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

describe('Activity', () => {
  it('shows the store’s reported payment as Payment to Larkspur Supply · PayPal', async () => {
    const user = userEvent.setup()
    render(<Activity state={makeState()} {...props} />)
    const completed = screen.getByRole('region', { name: 'Completed' })
    const payment = within(completed).getByRole('button', { name: /Everyday camera/ })
    expect(within(payment).getByText(/Payment to Larkspur Supply · PayPal/)).toBeTruthy()
    expect(within(payment).getByText('−$1,199.00')).toBeTruthy()
    // Nothing to confirm: it opens the row's details, which show no store price for a match.
    await user.click(payment)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText(/quoted price/)).toBeNull()
  })

  it('shows the store’s quoted price when the captured amount differs', async () => {
    const user = userEvent.setup()
    const state = makeState([reported({ amountCents: 125000, quotedCents: 119900 })])
    state.transactions[0] = { ...row, amountCents: -125000 }
    render(<Activity state={state} {...props} />)
    await user.click(screen.getByRole('button', { name: /Everyday camera/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Larkspur Supply’s quoted price')).toBeTruthy()
    expect(within(dialog).getByText('$1,199.00')).toBeTruthy()
    expect(within(dialog).getByText('−$1,250.00')).toBeTruthy()
  })
})

describe('the one-time notice', () => {
  function serve(state: AppState) {
    const seen: unknown[] = []
    apiMock.mockImplementation((async (path: string, data?: unknown) => {
      if (path === '/handoff/notices/seen') {
        seen.push(data)
        return { ...state, purchases: state.purchases.map(({ reportNotice: _n, ...p }) => p) }
      }
      if (path === '/compare') {
        const input = data as { amountCents?: number }
        return compareOptions(state.profile, state.purchases, {
          amountCents: input.amountCents ?? 0,
          today: TODAY,
          payIn4Eligible: true,
        })
      }
      return state
    }) as typeof api)
    return seen
  }

  it('says once that Larkspur Supply told Worth about the payment, then clears it', async () => {
    const state = makeState()
    const seen = serve(state)
    render(<App />)
    expect(
      await screen.findByText('Larkspur Supply told Worth about your $1,199.00 payment.'),
    ).toBeTruthy()
    await waitFor(() => expect(seen).toEqual([{ purchaseIds: ['p-store'] }]))
    // A refresh that still carries the notice (the clear is in flight) doesn't repeat it.
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() =>
      expect(apiMock.mock.calls.filter(([path]) => path === '/state').length).toBeGreaterThan(1),
    )
    expect(seen).toHaveLength(1)
    expect(screen.getAllByText(/told Worth about your/)).toHaveLength(1)
  })

  it('names every new report in one notice and clears exactly those', async () => {
    const second = reported({ id: 'p-store-2', name: 'Travel backpack', amountCents: 12900 })
    const seen = serve(
      makeState([second, reported(), reported({ id: 'p-old', reportNotice: undefined })]),
    )
    render(<App />)
    expect(
      await screen.findByText(
        'Larkspur Supply told Worth about 2 payments. They’re in your Activity.',
      ),
    ).toBeTruthy()
    await waitFor(() => expect(seen).toEqual([{ purchaseIds: ['p-store-2', 'p-store'] }]))
  })

  it('clears more than 20 reports in calls of at most 20 ids', async () => {
    const many = Array.from({ length: 23 }, (_, index) => reported({ id: `p-${index}` }))
    const seen = serve(makeState(many)) as { purchaseIds: string[] }[]
    render(<App />)
    expect(
      await screen.findByText(
        'Larkspur Supply told Worth about 23 payments. They’re in your Activity.',
      ),
    ).toBeTruthy()
    await waitFor(() => expect(seen).toHaveLength(2))
    expect(seen.map((call) => call.purchaseIds.length)).toEqual([20, 3])
    expect(seen.flatMap((call) => call.purchaseIds).sort()).toEqual(many.map((p) => p.id).sort())
  })

  it('says nothing for Worth’s own purchases or a notice already seen', async () => {
    const own = reported({ reportedBy: undefined, reportNotice: undefined })
    const seenBefore = reported({ id: 'p-old', reportNotice: undefined })
    const seen = serve(makeState([own, seenBefore]))
    render(<App />)
    // Home has the state: room to spend is showing.
    expect((await screen.findAllByText(/Room to spend today/)).length).toBeGreaterThan(0)
    expect(screen.queryByText(/told Worth about your/)).toBeNull()
    expect(seen).toEqual([])
  })
})
