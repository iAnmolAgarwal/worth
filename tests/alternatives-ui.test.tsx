// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AlternativesPanel } from '../src/Alternatives'
import { Ask } from '../src/Ask'
import { Decision } from '../src/Decision'
import { api } from '../src/api'
import { compareOptions } from '../shared/finance'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type { Alternatives, AppState, ChatReply } from '../shared/types'

vi.mock('../src/paypalSdk', () => ({ loadPayPalSdk: vi.fn() }))
vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>()
  return { ...actual, api: vi.fn() }
})
vi.mock('recharts', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>
  const Nothing = () => null
  return {
    ResponsiveContainer: Pass,
    ComposedChart: ({ children }: { children?: ReactNode }) => <svg>{children}</svg>,
    Area: Nothing,
    Line: Nothing,
    ReferenceArea: Nothing,
    ReferenceDot: Nothing,
    ReferenceLine: Nothing,
    XAxis: Nothing,
    YAxis: Nothing,
  }
})

const TODAY = '2026-10-03'
const apiMock = vi.mocked(api)
function makeState(alternatives: AppState['config']['alternatives'] = 'ok'): AppState {
  const seed = createDemoState(TODAY)
  return {
    ...seed,
    reviews: [],
    today: TODAY,
    products: PRODUCTS,
    config: { ai: 'anthropic', paypal: 'demo', model: 'test-provider', alternatives },
  }
}
const found = (status: Alternatives['status'] = 'ok'): Alternatives => ({
  status,
  query: 'interchangeable lens camera',
  maxPriceCents: 42500,
  items:
    status === 'off'
      ? []
      : [
          {
            id: 'DBouSIg',
            title: 'Interchangeable Lens Camera Body',
            retailer: 'bestbuy.com',
            brand: 'Brand',
            priceCents: 32249,
            url: 'https://buy.trychannel3.com/DBouSIg',
            imageUrl: 'https://cdn.trychannel3.com/c6db56cb',
            availability: 'InStock',
            source: 'channel3',
          },
          {
            id: 'RSNbAN5',
            title: 'Mirrorless Digital Camera Body',
            retailer: 'adorama.com',
            priceCents: 15900,
            url: 'https://buy.trychannel3.com/RSNbAN5',
            availability: 'InStock',
            source: 'channel3',
          },
        ],
})
function route(state: AppState, alternatives: () => unknown = () => found()) {
  apiMock.mockImplementation(((path: string, data?: unknown) =>
    Promise.resolve().then(() => {
      if (path.startsWith('/alternatives')) return alternatives()
      const input = data as { productId?: string; amountCents?: number; itemName?: string }
      const product = PRODUCTS.find((p) => p.id === input.productId)
      return compareOptions(state.profile, state.purchases, {
        amountCents: product?.priceCents ?? input.amountCents!,
        itemName: product?.name ?? input.itemName,
        today: TODAY,
        payIn4Eligible: true,
      })
    })) as typeof api)
}

beforeEach(() => {
  apiMock.mockReset()
  window.history.replaceState(null, '', '/')
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  )
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Similar items that fit today', () => {
  it('lists image, title, store and price, each opening the store in a new tab, labelled as discovery', async () => {
    route(makeState())
    render(<AlternativesPanel state={makeState()} request={{ productId: 'camera' }} />)
    const panel = await screen.findByRole('region', { name: 'Similar items that fit today' })
    expect(apiMock).toHaveBeenCalledWith('/alternatives?productId=camera')
    expect(within(panel).getByText('Under $425.00 · from other stores')).toBeTruthy()
    const links = within(panel).getAllByRole('link')
    expect(links).toHaveLength(2)
    const first = links[0]!
    expect(first.getAttribute('href')).toBe('https://buy.trychannel3.com/DBouSIg')
    expect(first.getAttribute('target')).toBe('_blank')
    expect(first.getAttribute('rel')).toBe('noopener noreferrer')
    expect(first.textContent).toContain('Interchangeable Lens Camera Body')
    expect(first.textContent).toContain('bestbuy.com')
    expect(first.textContent).toContain('$322.49')
    expect(first.textContent).toContain('Opens the store’s page in a new tab.')
    expect(first.querySelector('img')!.getAttribute('src')).toBe(
      'https://cdn.trychannel3.com/c6db56cb',
    )
    expect(links[1]!.querySelector('img')).toBeNull()
    expect(
      within(panel).getByText('From other stores · via Channel3 · prices may change'),
    ).toBeTruthy()
    expect(
      within(panel).getByText(/Worth doesn’t sell these items and can’t check them out/),
    ).toBeTruthy()
    // Discovery only: no checkout, no PayPal, never the demo store.
    expect(within(panel).queryByRole('button')).toBeNull()
    expect(panel.textContent).not.toMatch(/PayPal|Larkspur|Buy/)
    expect(within(panel).queryByText('Example results')).toBeNull()
  })
  it('stays hidden without a search, when nothing is found, and when the request fails', async () => {
    route(makeState())
    const { container, unmount } = render(
      <AlternativesPanel state={makeState('off')} request={{ productId: 'camera' }} />,
    )
    expect(container.innerHTML).toBe('')
    expect(apiMock).not.toHaveBeenCalled()
    unmount()
    for (const answer of [() => found('off'), () => Promise.reject(new Error('down'))]) {
      route(makeState(), answer)
      const view = render(
        <AlternativesPanel
          state={makeState()}
          request={{ itemName: 'camera', amountCents: 119900 }}
        />,
      )
      await waitFor(() => expect(view.container.innerHTML).toBe(''))
      expect(screen.queryByRole('alert')).toBeNull()
      view.unmount()
    }
    expect(apiMock).toHaveBeenCalledWith('/alternatives?itemName=camera&amountCents=119900')
  })
  it('labels recorded example results', async () => {
    route(makeState(), () => found('fixture'))
    render(<AlternativesPanel state={makeState('fixture')} request={{ productId: 'camera' }} />)
    expect(await screen.findByText('Example results')).toBeTruthy()
    expect(
      screen.getByText(/example results recorded earlier, while Channel3 is unavailable/),
    ).toBeTruthy()
  })
  it('blurs photos, titles and store names in capture mode', async () => {
    window.history.replaceState(null, '', '/?capture=1#decision?product=camera')
    route(makeState())
    render(<AlternativesPanel state={makeState()} request={{ productId: 'camera' }} />)
    const panel = await screen.findByRole('region', { name: 'Similar items that fit today' })
    expect(panel.classList.contains('capture')).toBe(true)
    expect(panel.querySelectorAll('.alt-blur')).toHaveLength(5)
  })
  it('offers Save for later on each row only when the Saved list can take it', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    route(makeState())
    render(
      <AlternativesPanel state={makeState()} request={{ productId: 'camera' }} onSave={onSave} />,
    )
    await user.click(
      await screen.findByRole('button', {
        name: 'Save Interchangeable Lens Camera Body for later',
      }),
    )
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'DBouSIg', priceCents: 32249, retailer: 'bestbuy.com' }),
    )
  })
})

describe('where the similar items appear', () => {
  const props = {
    backLabel: 'Back',
    onBack: vi.fn(),
    onBuy: vi.fn(),
    onSave: vi.fn(),
    onViewActivity: vi.fn(),
  }
  it('shows them in the Decision view once Spend less is chosen', async () => {
    const user = userEvent.setup()
    const state = makeState()
    route(state)
    render(<Decision {...props} state={state} request={{ productId: 'camera' }} />)
    const group = await screen.findByRole('radiogroup', { name: 'Your options' })
    expect(screen.queryByRole('region', { name: 'Similar items that fit today' })).toBeNull()
    await user.click(within(group).getAllByRole('radio')[2]!)
    expect(await screen.findByRole('region', { name: 'Similar items that fit today' })).toBeTruthy()
    expect(apiMock).toHaveBeenCalledWith('/alternatives?productId=camera')
  })
  it('never offers them when the item fits today', async () => {
    const state = makeState()
    route(state)
    render(<Decision {...props} state={state} request={{ productId: 'backpack' }} />)
    await screen.findByRole('radiogroup', { name: 'Your options' })
    expect(apiMock.mock.calls.some(([path]) => path.startsWith('/alternatives'))).toBe(false)
  })
  it('lists them under an Ask answer about something cheaper', async () => {
    const user = userEvent.setup()
    const answer: ChatReply = {
      message: 'Up to $440.01 fits today and keeps your $300 cushion.',
      mode: 'anthropic',
      intent: 'alternatives',
      suggestions: [],
      toolCalls: ['find_alternatives'],
      alternatives: found(),
    }
    apiMock.mockResolvedValue(answer as never)
    render(
      <Ask
        state={makeState()}
        visible
        onOpenDecision={vi.fn()}
        onOpenCheckout={vi.fn()}
        onNavigate={vi.fn()}
      />,
    )
    await user.type(screen.getByRole('textbox', { name: 'Message Worth' }), 'Something cheaper?')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    const panel = await screen.findByRole('region', { name: 'Similar items that fit today' })
    expect(within(panel).getAllByRole('link')).toHaveLength(2)
    expect(screen.getByText('Up to $440.01 fits today and keeps your $300 cushion.')).toBeTruthy()
  })
})
