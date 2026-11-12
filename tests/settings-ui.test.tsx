// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Settings } from '../src/Saved'
import { api } from '../src/api'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type { AppState } from '../shared/types'

// Settings and privacy as a settings screen: named groups of rows, details one click away.

vi.mock('../src/paypalSdk', () => ({ loadPayPalSdk: vi.fn() }))
vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>()
  return { ...actual, api: vi.fn(() => Promise.resolve({ tokens: [], endpoint: '' })) }
})
const apiMock = vi.mocked(api)
const TODAY = '2026-10-03'

function makeState(): AppState {
  const seed = createDemoState(TODAY)
  return {
    ...seed,
    reviews: [],
    today: TODAY,
    products: PRODUCTS,
    saved: [],
    config: { ai: 'anthropic', paypal: 'sandbox', model: 'test-provider' },
  }
}

function renderSettings(state = makeState(), onImport = vi.fn()) {
  render(
    <Settings
      state={state}
      onUpdate={vi.fn()}
      onReset={vi.fn()}
      onEditPlan={vi.fn()}
      onImport={onImport}
    />,
  )
  return { onImport }
}

afterEach(() => {
  cleanup()
  apiMock.mockClear()
  window.location.hash = ''
})

describe('Settings and privacy', () => {
  it('is a short list of named groups, with the danger zone last', () => {
    renderSettings()
    const groups = screen
      .getAllByRole('region')
      .filter((region) => region.classList.contains('set-group'))
      .map((region) => region.querySelector('h2')?.textContent)
    expect(groups).toEqual([
      'Assistant',
      'PayPal',
      'AI agents',
      'Sample and demo',
      'Privacy',
      'Your data',
    ])
    expect(
      screen.getByRole('switch', { name: 'Use the assistant (powered by Claude)' }),
    ).toBeTruthy()
    expect(
      screen.getByRole('switch', { name: 'Keep my plan on this device for 30 days' }),
    ).toBeTruthy()
  })

  it('keeps the transparency details one click away, closed at first', async () => {
    const user = userEvent.setup()
    renderSettings()
    for (const label of ['What Claude sees', 'Connect an agent', 'About this demo']) {
      const details = screen.getByText(label).closest('details')!
      expect(details.open).toBe(false)
      await user.click(screen.getByText(label))
      expect(details.open).toBe(true)
    }
    expect(screen.getByRole('region', { name: 'What Claude sees' }).textContent).toContain(
      'PayPal login or card numbers',
    )
    const agent = screen.getByRole('region', { name: 'Connect an agent' })
    expect(within(agent).getByText('Never')).toBeTruthy()
  })

  it('carries the sample chip’s details: the sentence, the environment and both links', async () => {
    const user = userEvent.setup()
    const { onImport } = renderSettings()
    const about = screen.getByRole('region', { name: 'About this demo' })
    expect(about.textContent).toContain(
      'This is a sample month for a made-up PayPal shopper. No real money moves, and PayPal checkout runs in the PayPal sandbox.',
    )
    expect(about.textContent).toContain('Assistant: powered by Claude')
    expect(about.textContent).toContain('PayPal checkout: sandbox')
    await user.click(screen.getByRole('button', { name: 'Use your own PayPal activity' }))
    expect(onImport).toHaveBeenCalled()
  })

  it('starts the tour on Home', async () => {
    const user = userEvent.setup()
    const started = vi.fn()
    window.addEventListener('worth:tour', started)
    renderSettings()
    await user.click(screen.getByRole('button', { name: 'Take the tour' }))
    expect(started).toHaveBeenCalled()
    expect(window.location.hash).toBe('#home')
    window.removeEventListener('worth:tour', started)
  })

  it('names imported data plainly and offers to import again', () => {
    const state = makeState()
    state.profile = { ...state.profile, source: 'import', coverageDays: 90 }
    renderSettings(state)
    expect(screen.getByText('Imported · 90 days')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Import PayPal activity' })).toBeTruthy()
    expect(screen.queryByText(/made-up PayPal shopper/)).toBeNull()
  })
})
