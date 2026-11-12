// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'
import { Settings } from '../src/Saved'
import { api } from '../src/api'
import { compareOptions } from '../shared/finance'
import { ALEX_DEMO_DAY, createCameraScenario, PRODUCTS } from '../shared/seed'
import type { AppState, DemoPreset } from '../shared/types'

// The default sample in the browser: Alex pinned to his sample day, labelled in one short line,
// with no "Back to today" and no Maya anywhere on screen.

vi.mock('../src/paypalSdk', () => ({ loadPayPalSdk: vi.fn() }))
vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>()
  return { ...actual, api: vi.fn() }
})
const apiMock = vi.mocked(api)
function routeApi(route: (path: string, data?: unknown) => unknown) {
  apiMock.mockImplementation(
    (path, data) => Promise.resolve().then(() => route(path, data)) as Promise<never>,
  )
}
function alexState(today = ALEX_DEMO_DAY, preset: DemoPreset = 'demo'): AppState {
  const seed = createCameraScenario(today)
  return {
    ...seed,
    reviews: [],
    today,
    products: PRODUCTS,
    saved: [],
    wishlist: [],
    retention: { keep30: false, expiresAt: '2026-11-14T12:00:00.000Z' },
    demoClock: { today, preset },
    config: { ai: 'demo', paypal: 'demo', sample: 'alex' },
  }
}
function compare(state: AppState, data: unknown) {
  const input = data as { productId?: string; amountCents?: number; itemName?: string }
  const product = PRODUCTS.find((p) => p.id === input.productId)
  return compareOptions(state.profile, [], {
    amountCents: product?.priceCents ?? input.amountCents ?? 0,
    itemName: product?.name ?? input.itemName,
    today: state.today,
    payIn4Eligible: true,
  })
}
beforeEach(() => {
  apiMock.mockReset()
  window.history.replaceState(null, '', '/')
  window.location.hash = ''
})
afterEach(cleanup)

describe('Alex, the default sample', () => {
  it('labels the sample and its pinned day, without Back to today or Maya', async () => {
    const state = alexState()
    routeApi((path, data) => (path === '/state' ? state : compare(state, data)))
    render(<App />)
    expect(await screen.findByRole('button', { name: 'Sample: Alex' })).toBeTruthy()
    expect((await screen.findByText('Sample day:')).parentElement!.textContent).toBe(
      'Sample day: Fri, Nov 13, 2026',
    )
    expect(screen.queryByRole('button', { name: /Back to (today|the sample day)/ })).toBeNull()
    expect(document.body.textContent).not.toMatch(/Maya/)
  })

  it('opens ?replay=demo-dec15 from a link and says so', async () => {
    const dec15 = alexState('2026-12-15', 'demo-dec15')
    routeApi((path, data) =>
      path === '/state' ? alexState() : path === '/demo-clock' ? dec15 : compare(dec15, data),
    )
    window.history.replaceState(null, '', '/?replay=demo-dec15')
    render(<App />)
    expect(await screen.findByText('Showing the sample: Alex on Tue, Dec 15, 2026.')).toBeTruthy()
    expect(apiMock).toHaveBeenCalledWith('/demo-clock', { preset: 'demo-dec15' })
    await waitFor(() => expect(window.location.search).toBe(''))
  })

  it('offers the sample day and the return visit in Settings, never the Maya replay', async () => {
    const user = userEvent.setup()
    const state = alexState()
    routeApi(() => alexState('2026-12-15', 'demo-dec15'))
    const onToast = vi.fn()
    render(
      <Settings
        state={state}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
        onEditPlan={vi.fn()}
        onImport={vi.fn()}
        onToast={onToast}
      />,
    )
    expect(screen.getByRole('button', { name: 'Sample day · Fri, Nov 13, 2026' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Video replay|Back to today/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Return visit · Tue, Dec 15, 2026' }))
    expect(apiMock).toHaveBeenCalledWith('/demo-clock', { preset: 'demo-dec15' })
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith('Showing the sample: Alex on Tue, Dec 15, 2026.'),
    )
    expect(document.body.textContent).not.toMatch(/Maya/)
  })
})
