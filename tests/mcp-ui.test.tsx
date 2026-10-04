// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Activity } from '../src/Activity'
import { Checkout } from '../src/Checkout'
import { Settings } from '../src/Saved'
import { api } from '../src/api'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type { AgentToken, AppState, Purchase } from '../shared/types'

// Phase MCP UI: Settings → Connect an agent, and orders an outside agent asked for in Activity.

vi.mock('../src/paypalSdk', () => ({ loadPayPalSdk: vi.fn() }))
vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>()
  return { ...actual, api: vi.fn() }
})
const apiMock = vi.mocked(api)
const TODAY = '2026-10-03'
const TOKEN = `wrth_${'A'.repeat(39)}Zx9k`

function makeState(purchases: Purchase[] = []): AppState {
  const seed = createDemoState(TODAY)
  return {
    ...seed,
    purchases,
    reviews: [],
    today: TODAY,
    products: PRODUCTS,
    saved: [],
    retention: { keep30: false, expiresAt: `${TODAY}T16:00:00.000Z` },
    config: { ai: 'demo', paypal: 'sandbox' },
  }
}
const external = (patch: Partial<Purchase> = {}): Purchase => ({
  id: 'p-ext',
  productId: 'camera',
  name: 'Everyday camera',
  amountCents: 119900,
  currency: 'USD',
  mode: 'sandbox',
  status: 'created',
  createdAt: `${TODAY}T12:00:00Z`,
  profileVersion: 1,
  assessmentDate: TODAY,
  preparedBy: 'external',
  approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1',
  ...patch,
})
const token = (patch: Partial<AgentToken> = {}): AgentToken => ({
  id: 't1',
  hint: 'Zx9k',
  createdAt: `${TODAY}T12:00:00.000Z`,
  expiresAt: '2026-10-04T12:00:00.000Z',
  status: 'active',
  ...patch,
})

beforeEach(() => {
  apiMock.mockReset()
  vi.stubGlobal('scrollTo', vi.fn())
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Settings → Connect an agent', () => {
  function renderSettings(onToast = vi.fn()) {
    return render(
      <Settings
        state={makeState()}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
        onEditPlan={vi.fn()}
        onImport={vi.fn()}
        onToast={onToast}
      />,
    )
  }

  it('creates a token, shows it once with the Claude Desktop config, and revokes it', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const endpoint = 'https://worth.example.com/mcp'
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/agent-tokens') return { endpoint, tokens: [] }
      throw new Error(`unexpected ${path}`)
    })
    const onToast = vi.fn()
    renderSettings(onToast)
    const section = screen.getByRole('region', { name: 'Connect an agent' })
    expect(within(section).getByText('Never')).toBeTruthy()
    apiMock.mockImplementation(async (path: string, body?: unknown) => {
      if (path === '/agent-tokens' && body)
        return { endpoint, token: TOKEN, item: token(), tokens: [token()] }
      if (path === '/agent-tokens/t1/revoke')
        return { endpoint, tokens: [token({ status: 'revoked' })] }
      throw new Error(`unexpected ${path}`)
    })
    await user.click(within(section).getByRole('button', { name: 'Create agent token' }))
    const input = await within(section).findByLabelText('Agent token')
    expect((input as HTMLInputElement).value).toBe(TOKEN)
    expect(within(section).getByText(/Copy this token now/)).toBeTruthy()
    const config = within(section).getByLabelText('Claude Desktop configuration').textContent!
    const parsed = JSON.parse(config)
    expect(parsed.mcpServers.worth).toEqual({
      command: 'npx',
      args: [
        '-y',
        'mcp-remote@0.14',
        endpoint,
        '--transport',
        'http-only',
        '--header',
        'Authorization:${WORTH_AUTH}',
      ],
      env: { WORTH_AUTH: `Bearer ${TOKEN}` },
    })
    await user.click(within(section).getByRole('button', { name: 'Copy config' }))
    expect(writeText).toHaveBeenCalledWith(config)
    expect(within(section).getByText('Token ending Zx9k')).toBeTruthy()
    await user.click(within(section).getByRole('button', { name: 'Revoke token ending Zx9k' }))
    await waitFor(() => expect(within(section).getByText('Revoked')).toBeTruthy())
    // The token disappears from the page once revoked.
    expect(within(section).queryByLabelText('Agent token')).toBeNull()
    expect(onToast).toHaveBeenCalledWith(
      'Token ending Zx9k revoked. Agents using it are disconnected.',
    )
  })

  it('adds --allow-http for a local endpoint and caps active tokens at three', async () => {
    const user = userEvent.setup()
    const endpoint = 'http://localhost:5179/mcp'
    const three = [
      token({ id: 'a' }),
      token({ id: 'b', hint: 'b000' }),
      token({ id: 'c', hint: 'c000' }),
    ]
    apiMock.mockResolvedValueOnce({ endpoint, tokens: three })
    renderSettings()
    const section = screen.getByRole('region', { name: 'Connect an agent' })
    const create = await within(section).findByRole('button', { name: 'Create agent token' })
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(true))
    expect(within(section).getByText(/You have 3 active tokens/)).toBeTruthy()
    apiMock.mockReset()
    apiMock.mockResolvedValueOnce({ endpoint, tokens: [] })
    cleanup()
    renderSettings()
    const again = screen.getByRole('region', { name: 'Connect an agent' })
    apiMock.mockResolvedValueOnce({ endpoint, token: TOKEN, item: token(), tokens: [token()] })
    await user.click(within(again).getByRole('button', { name: 'Create agent token' }))
    const config = (await within(again).findByLabelText('Claude Desktop configuration'))
      .textContent!
    expect(JSON.parse(config).mcpServers.worth.args).toContain('--allow-http')
  })

  it('stays usable when the token list cannot load', async () => {
    apiMock.mockRejectedValueOnce(new Error('offline'))
    renderSettings()
    expect(
      screen.getByRole('region', { name: 'Connect an agent' }).querySelector('.co-error'),
    ).toBeNull()
  })
})

describe('orders an outside agent asked for', () => {
  const props = {
    onUpdate: vi.fn(),
    onAsk: vi.fn(),
    onOpenCheckout: vi.fn(),
    onConfirmPlan: vi.fn(),
    onReviewRefund: vi.fn(),
  }

  it('shows “Requested by an external agent” in Activity, pending and completed', () => {
    const pending = external()
    const done = external({
      id: 'p-done',
      status: 'completed',
      captureId: 'CAP1',
      approveUrl: undefined,
    })
    const state = makeState([pending, done])
    state.transactions = [
      {
        id: 'purchase-p-done',
        date: TODAY,
        name: 'Everyday camera',
        amountCents: -119900,
        currency: 'USD',
        category: 'Shopping',
        kind: 'expense',
        status: 'completed',
        source: 'purchase',
      },
      ...state.transactions,
    ]
    render(<Activity state={state} {...props} />)
    const pendingList = screen.getByRole('region', { name: 'Pending' })
    expect(within(pendingList).getByText('Requested by an external agent')).toBeTruthy()
    const completed = screen.getByRole('region', { name: 'Completed' })
    expect(within(completed).getByText('Requested by an external agent')).toBeTruthy()
    // Orders the person or Ask Worth started carry no such label.
    cleanup()
    render(<Activity state={makeState([external({ preparedBy: 'agent' })])} {...props} />)
    expect(screen.queryByText('Requested by an external agent')).toBeNull()
  })

  it('says so in the checkout, where the person approves and confirms', () => {
    const state = makeState([external()])
    // The checkout reads PayPal's state on open; that answer is not under test here.
    apiMock.mockReturnValue(new Promise(() => undefined))
    render(
      <Checkout
        product={PRODUCTS.find((p) => p.id === 'camera')!}
        state={state}
        purchaseId="p-ext"
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        onViewActivity={vi.fn()}
        onConfirmPlan={vi.fn()}
        onEditPlan={vi.fn()}
      />,
    )
    expect(
      screen.getByText(
        'Requested by an external agent connected to Worth. Nothing is paid until you approve in PayPal and confirm here.',
      ),
    ).toBeTruthy()
  })
})
