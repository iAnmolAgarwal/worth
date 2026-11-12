// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  connectAvailable,
  ConnectOnCheck,
  ConnectedSource,
  ConnectPayPalButton,
  ConnectProgress,
  returnToCheck,
} from '../src/ConnectPayPal'
import { api, ApiError } from '../src/api'
import type { AppState } from '../src/contract'

vi.mock('../src/api', async (original) => ({
  ...(await original<typeof import('../src/api')>()),
  api: vi.fn(),
}))
const apiMock = vi.mocked(api)

afterEach(() => {
  cleanup()
  apiMock.mockReset()
  sessionStorage.clear()
})

const summary = {
  transactions: 39,
  first: '2026-10-01',
  last: '2026-10-04',
  searchedDays: 186,
  skipped: 0,
  truncated: false,
}
const withConnect = (paypalConnect: 'on' | 'off' | 'unavailable') =>
  ({ config: { ai: 'demo', paypal: 'sandbox', paypalConnect } }) as unknown as AppState

describe('Connect PayPal button', () => {
  it('says what PayPal will show, and what Worth can’t do, before leaving', async () => {
    render(<ConnectPayPalButton />)
    expect(screen.queryByText(/Default Application/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Connect PayPal' }))
    const group = screen.getByRole('group', { name: 'Connect PayPal' })
    expect(group.textContent).toContain('“Default Application”')
    expect(group.textContent).toContain('access your transaction data')
    expect(group.textContent).toContain('can’t pay, invoice or move money')
    expect(screen.getByRole('button', { name: 'Continue to PayPal' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.getByRole('button', { name: 'Connect PayPal' })).toBeTruthy()
  })

  it('shows only when the server has it on and this visit hasn’t gated it off', () => {
    expect(connectAvailable(withConnect('on'))).toBe(true)
    expect(connectAvailable(withConnect('off'))).toBe(false)
    expect(connectAvailable(withConnect('unavailable'))).toBe(false)
    sessionStorage.setItem('worth.paypalConnect.hidden', '1')
    expect(connectAvailable(withConnect('on'))).toBe(false)
  })
})

describe('After PayPal’s login', () => {
  it('reads the activity once and hands it to the review as a connected file', async () => {
    apiMock.mockResolvedValue({ csv: 'Date,Net\n', summary })
    const onFile = vi.fn()
    render(<ConnectProgress result="paypal" onFile={onFile} onUseCsv={() => {}} />)
    expect(screen.getByRole('status').textContent).toContain('list_transactions')
    await waitFor(() => expect(onFile).toHaveBeenCalledTimes(1))
    expect(onFile).toHaveBeenCalledWith({
      csv: 'Date,Net\n',
      name: 'Your PayPal sandbox activity',
      connected: summary,
    })
    expect(apiMock).toHaveBeenCalledTimes(1)
    expect(apiMock).toHaveBeenCalledWith('/paypal/activity', {})
    // The login's trace leaves the address bar.
    expect(window.location.hash).toBe('#import')
  })

  it('hides Connect for the visit when PayPal’s MCP server is too slow, and offers the CSV', async () => {
    apiMock.mockRejectedValue(
      new ApiError('PayPal’s MCP server didn’t answer in time.', 503, 'MCP_TIMEOUT'),
    )
    const onUseCsv = vi.fn()
    render(<ConnectProgress result="paypal" onFile={() => {}} onUseCsv={onUseCsv} />)
    await screen.findByText(/didn’t answer in time/)
    expect(sessionStorage.getItem('worth.paypalConnect.hidden')).toBe('1')
    expect(screen.queryByRole('button', { name: 'Connect PayPal again' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Use a CSV export instead' }))
    expect(onUseCsv).toHaveBeenCalled()
  })

  it('explains a declined login without asking PayPal for anything', () => {
    render(<ConnectProgress result="denied" onFile={() => {}} onUseCsv={() => {}} />)
    expect(screen.getByText(/didn’t allow access in PayPal/)).toBeTruthy()
    expect(apiMock).not.toHaveBeenCalled()
  })

  it('says when PayPal returned nothing', async () => {
    apiMock.mockResolvedValue({ csv: '', summary: { ...summary, transactions: 0 } })
    const onFile = vi.fn()
    render(<ConnectProgress result="paypal" onFile={onFile} onUseCsv={() => {}} />)
    await screen.findByText(/no activity for the last 186 days/)
    expect(onFile).not.toHaveBeenCalled()
  })
})

describe('The review’s source line', () => {
  it('names the source, the count and the dates, and says when history is too short', () => {
    const { container } = render(<ConnectedSource summary={summary} />)
    const text = container.textContent!
    expect(text).toContain(
      'Read from your PayPal sandbox account through PayPal’s MCP server: 39 transactions, Oct 1 to Oct 4.',
    )
    expect(text).toContain('4 days of activity')
    expect(text).toContain('Worth doesn’t guess any')
  })
  it('says nothing about short history when there is enough', () => {
    const { container } = render(
      <ConnectedSource summary={{ ...summary, first: '2026-06-01', last: '2026-10-04' }} />,
    )
    expect(container.textContent).not.toContain('too short')
  })
})

describe('From /check', () => {
  it('offers Connect PayPal against the sample plan', () => {
    const { container } = render(<ConnectOnCheck />)
    expect(container.textContent).toContain('This answer uses the sample plan.')
    expect(screen.getByRole('button', { name: 'Connect PayPal' })).toBeTruthy()
  })
  it('returns to /check once, and only for its own fixed value', () => {
    expect(returnToCheck()).toBe(false)
    sessionStorage.setItem('worth.paypalConnect.return', 'check')
    expect(returnToCheck()).toBe(true)
    expect(returnToCheck()).toBe(false)
    sessionStorage.setItem('worth.paypalConnect.return', 'https://evil.example')
    expect(returnToCheck()).toBe(false)
  })
})
