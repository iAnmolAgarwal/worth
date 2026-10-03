// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ForeignPayments } from '../src/ForeignPayments'
import { api } from '../src/api'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type { AppState, ForeignPayment } from '../shared/types'

vi.mock('../src/api', () => ({ api: vi.fn() }))

const TODAY = '2026-10-03'
const apiMock = vi.mocked(api)
const bakery: ForeignPayment = {
  id: 'paypal:F1',
  date: '2026-09-10',
  name: 'Lisbon bakery',
  type: 'Express Checkout Payment',
  currency: 'EUR',
  originalCents: -1200,
}
const stationery: ForeignPayment = {
  id: 'paypal:F2',
  date: '2026-09-12',
  name: 'Tokyo stationery',
  type: 'Express Checkout Payment',
  currency: 'JPY',
  originalCents: -450000,
}

function makeState(foreignPayments: ForeignPayment[]): AppState {
  const seed = createDemoState(TODAY)
  return {
    ...seed,
    reviews: [],
    products: PRODUCTS,
    today: TODAY,
    config: { ai: 'demo', paypal: 'demo' },
    foreignPayments,
  }
}

beforeEach(() => {
  apiMock.mockReset()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('foreign-currency payments to resolve', () => {
  it('lists only unresolved payments in their own currency', () => {
    render(
      <ForeignPayments
        state={makeState([
          bakery,
          stationery,
          { ...bakery, id: 'paypal:F0', name: 'Answered', resolution: { kind: 'oneOff' } },
        ])}
        onUpdate={vi.fn()}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Foreign-currency payments to resolve' }))
    expect(screen.getByText(/€12\.00/)).toBeTruthy()
    expect(screen.getByText(/¥4,500/)).toBeTruthy()
    expect(screen.queryByText('Answered')).toBeNull()
  })

  it('renders nothing once every payment is resolved', () => {
    const { container } = render(
      <ForeignPayments
        state={makeState([{ ...bakery, resolution: { kind: 'usd', amountCents: 1337 } }])}
        onUpdate={vi.fn()}
      />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('sends a USD cost or a one-off answer and applies the returned state', async () => {
    const user = userEvent.setup()
    const onUpdate = vi.fn()
    const updated = makeState([])
    apiMock.mockResolvedValue(updated)
    render(<ForeignPayments state={makeState([bakery, stationery])} onUpdate={onUpdate} />)
    const cost = screen.getByRole('textbox', { name: 'USD cost of Lisbon bakery' })
    await user.type(cost, 'about 13')
    await user.click(screen.getAllByRole('button', { name: 'Save USD cost' })[0]!)
    expect(screen.getByRole('alert').textContent).toContain('Enter what Lisbon bakery cost')
    expect(apiMock).not.toHaveBeenCalled()
    await user.clear(cost)
    await user.type(cost, '$13.37')
    await user.click(screen.getAllByRole('button', { name: 'Save USD cost' })[0]!)
    expect(apiMock).toHaveBeenCalledWith('/import/unresolved/paypal%3AF1', { amountCents: 1337 })
    expect(onUpdate).toHaveBeenCalledWith(updated)
    await user.click(screen.getAllByRole('button', { name: 'One-off, leave out' })[1]!)
    expect(apiMock).toHaveBeenLastCalledWith('/import/unresolved/paypal%3AF2', { oneOff: true })
  })
})
