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
  setSyncHandlers,
  syncDue,
  syncFromPayPal,
  syncSentence,
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
    // Three short lines, each readable on its own.
    expect([...group.querySelectorAll('p')].map((line) => line.textContent)).toEqual([
      'Sign in on PayPal and choose Agree. PayPal calls the connection “Default Application”.',
      'Worth only reads your activity to keep your plan up to date. It can’t pay or move money.',
      'Sandbox accounts only. Disconnect any time in Settings.',
    ])
    expect(screen.getByRole('button', { name: 'Continue to PayPal' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.getByRole('button', { name: 'Connect PayPal' })).toBeTruthy()
  })

  it('in the start strip, opens the same line under the button and keeps the button', async () => {
    render(<ConnectPayPalButton pop />)
    const button = screen.getByRole('button', { name: 'Connect PayPal' })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    const group = screen.getByRole('group', { name: 'Connect PayPal' })
    expect(group.className).toContain('connect-pop')
    expect(group.textContent).toContain('“Default Application”')
    await userEvent.click(button)
    expect(screen.queryByRole('group', { name: 'Connect PayPal' })).toBeNull()
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

describe('Staying connected: background reads', () => {
  const linked = (importedAt: string | undefined, paypalLinked = true) =>
    ({
      config: { ai: 'demo', paypal: 'sandbox', paypalConnect: 'on', paypalLinked },
      profile: { source: 'import', importedFrom: 'paypal', importedAt },
    }) as unknown as AppState

  it('says what a sync changed in one plain sentence, and nothing when it changed nothing', () => {
    expect(syncSentence({ transactions: 0, plans: 1, paid: 0 })).toBe(
      'Updated from PayPal: 1 new Pay in 4 plan.',
    )
    expect(syncSentence({ transactions: 3, plans: 0, paid: 2 })).toBe(
      'Updated from PayPal: 2 Pay in 4 payments made, 3 new transactions.',
    )
    expect(syncSentence({ transactions: 0, plans: 0, paid: 0 })).toBeUndefined()
  })

  it('re-reads only a connected PayPal plan whose last read is over 15 minutes old', () => {
    const now = Date.parse('2026-11-12T12:00:00Z')
    expect(syncDue(linked('2026-11-12T11:40:00Z'), now)).toBe(true)
    expect(syncDue(linked('2026-11-12T11:50:00Z'), now)).toBe(false)
    expect(syncDue(linked('2026-11-12T11:40:00Z', false), now)).toBe(false)
    const file = linked('2026-11-12T11:00:00Z')
    file.profile.importedFrom = 'file'
    expect(syncDue(file, now)).toBe(false)
  })

  it('runs one sync at a time and applies its state and sentence', async () => {
    const next = linked('2026-11-12T12:00:00Z')
    let finish: (value: unknown) => void = () => {}
    apiMock.mockImplementation(
      () => new Promise((resolve) => (finish = resolve)) as ReturnType<typeof api>,
    )
    const onState = vi.fn()
    const onToast = vi.fn()
    setSyncHandlers({ onState, onToast })
    const first = syncFromPayPal()
    await syncFromPayPal()
    expect(apiMock).toHaveBeenCalledTimes(1)
    expect(apiMock).toHaveBeenCalledWith('/paypal/sync', {})
    finish({ state: next, changes: { transactions: 0, plans: 1, paid: 0 } })
    await first
    expect(onState).toHaveBeenCalledWith(next)
    expect(onToast).toHaveBeenCalledWith('Updated from PayPal: 1 new Pay in 4 plan.')
    setSyncHandlers(undefined)
  })

  it('quietly returns to Connect PayPal when PayPal no longer honours the link', async () => {
    const fresh = linked(undefined, false)
    apiMock.mockImplementation(((path: string) =>
      path === '/paypal/sync'
        ? Promise.reject(new ApiError('Worth no longer has access.', 409, 'NOT_CONNECTED'))
        : Promise.resolve(fresh)) as typeof api)
    const onState = vi.fn()
    const onToast = vi.fn()
    setSyncHandlers({ onState, onToast })
    await syncFromPayPal()
    expect(onState).toHaveBeenCalledWith(fresh)
    expect(onToast).not.toHaveBeenCalled()
    setSyncHandlers(undefined)
  })
})
