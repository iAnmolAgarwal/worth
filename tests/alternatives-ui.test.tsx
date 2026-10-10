// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AlternativesPanel } from '../src/Alternatives'
import { Ask } from '../src/Ask'
import { Decision } from '../src/Decision'
import App from '../src/App'
import { Saved, Settings } from '../src/Saved'
import { api } from '../src/api'
import { alternativeTarget } from '../src/contract'
import { compareOptions } from '../shared/finance'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type { Alternatives, AppState, ChatReply } from '../shared/types'

vi.mock('../src/paypalSdk', () => ({ loadPayPalSdk: vi.fn() }))
vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>()
  return { ...actual, api: vi.fn() }
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
    // One accessible name: title, store and price as shown, then where the link opens.
    expect(first.textContent).toBe(
      'Interchangeable Lens Camera Bodybestbuy.com$322.49, opens in a new tab',
    )
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
    expect(
      within(panel)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([
      'More like Interchangeable Lens Camera Body',
      'More like Mirrorless Digital Camera Body',
    ])
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
      screen.getByText(/example results from an earlier search, prices checked just now/),
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
    // Beside other stores' items, the buy action names the demo store's own product.
    expect(screen.getAllByRole('button', { name: 'Buy the everyday camera anyway' }).length).toBe(2)
    expect(screen.queryByRole('button', { name: 'Buy today anyway' })).toBeNull()
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

  it('lists rows Channel3 could not re-check without a price or a link', async () => {
    const example: Alternatives = {
      ...found('fixture'),
      items: [],
      unverified: [{ id: 'X1', title: 'Desk Chair', retailer: 'target.com', source: 'channel3' }],
    }
    route(makeState(), () => example)
    render(<AlternativesPanel state={makeState('fixture')} request={{ productId: 'chair' }} />)
    const panel = await screen.findByRole('region', { name: 'Similar items that fit today' })
    expect(within(panel).queryAllByRole('link')).toHaveLength(0)
    expect(within(panel).getByText('Price not checked')).toBeTruthy()
    expect(panel.querySelector('.alt-item')!.textContent).not.toContain('$')
    expect(within(panel).getByText(/couldn’t confirm some prices and links/)).toBeTruthy()
  })
  it('shows a store icon when a product photo fails to load', async () => {
    route(makeState())
    render(<AlternativesPanel state={makeState()} request={{ productId: 'camera' }} />)
    const panel = await screen.findByRole('region', { name: 'Similar items that fit today' })
    fireEvent.error(panel.querySelector('img')!)
    expect(panel.querySelector('img')).toBeNull()
    expect(panel.querySelectorAll('.alt-thumb')).toHaveLength(2)
  })
  it('shows More like this from Channel3, under the same limit, and goes back', async () => {
    const user = userEvent.setup()
    const similar: Alternatives = {
      ...found(),
      query: 'DBouSIg',
      items: [{ ...found().items[1]!, id: 'S2', title: 'Compact Mirrorless Body' }],
    }
    route(makeState(), () =>
      apiMock.mock.calls.at(-1)![0].includes('similarTo') ? similar : found(),
    )
    render(<AlternativesPanel state={makeState()} request={{ productId: 'camera' }} />)
    await user.click(
      await screen.findByRole('button', { name: 'More like Interchangeable Lens Camera Body' }),
    )
    const more = await screen.findByRole('region', { name: 'More like this' })
    expect(apiMock).toHaveBeenCalledWith('/alternatives?similarTo=DBouSIg')
    expect(within(more).getByText('Compact Mirrorless Body')).toBeTruthy()
    expect(
      within(more).getByText(/Like the Interchangeable Lens Camera Body · under \$425.00/),
    ).toBeTruthy()
    await waitFor(() => expect(document.activeElement?.textContent).toBe('More like this'))
    await user.click(within(more).getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('region', { name: 'Similar items that fit today' })).toBeTruthy()
  })

  it('names Channel3 in Settings and privacy, and says it applies with the assistant off', () => {
    render(
      <Settings
        state={makeState()}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
        onEditPlan={vi.fn()}
        onImport={vi.fn()}
      />,
    )
    const section = screen.getByRole('region', {
      name: 'Similar items and pasted links (Channel3)',
    })
    expect(section.textContent).toContain(
      'A generic kind of item (such as “desk chair”) and a price limit rounded down to $25',
    )
    expect(section.textContent).toContain('even when the assistant is off')
    expect(within(section).getByText('Never')).toBeTruthy()
  })
})

// Spec item 15: "Save for later" on a Channel3 row saves an assessment-only custom item that keeps
// the product's ID, and Saved checks its price once per page load.
describe('saving a similar item for later', () => {
  const saved = {
    kind: 'custom' as const,
    name: 'Interchangeable Lens Camera Body',
    amountCents: 32249,
    retailer: 'bestbuy.com',
    url: 'https://buy.trychannel3.com/DBouSIg',
    channel3Id: 'DBouSIg',
  }

  it('saves from the app’s Decision view with the assessment-only label', async () => {
    const user = userEvent.setup()
    const state = makeState()
    const posts: unknown[] = []
    apiMock.mockImplementation(((path: string, data?: unknown) =>
      Promise.resolve().then(() => {
        if (path === '/saved') {
          posts.push(data)
          return {
            item: { ...saved, id: 's1', createdAt: '', status: 'active' },
            state: { ...state, saved: [] },
          }
        }
        if (path.startsWith('/alternatives')) return found()
        if (path === '/compare') {
          const input = data as { productId?: string; amountCents?: number }
          const product = PRODUCTS.find((p) => p.id === input.productId)
          return compareOptions(state.profile, state.purchases, {
            amountCents: product?.priceCents ?? input.amountCents ?? 0,
            itemName: product?.name,
            today: TODAY,
            payIn4Eligible: true,
          })
        }
        return state
      })) as typeof api)
    window.history.replaceState(null, '', '/#decision?product=camera')
    render(<App />)
    const group = await screen.findByRole('radiogroup', { name: 'Your options' })
    await user.click(within(group).getAllByRole('radio')[2]!)
    await user.click(
      await screen.findByRole('button', {
        name: 'Save Interchangeable Lens Camera Body for later',
      }),
    )
    await waitFor(() => expect(posts).toEqual([saved]))
    expect(
      await screen.findByText(
        'Interchangeable Lens Camera Body is in Saved. Assessment only — not sold in the demo store.',
      ),
    ).toBeTruthy()
  })

  it('drops hidden characters from a listing title so it always saves (re-judge N3)', () => {
    const item = found().items[0]!
    expect(
      alternativeTarget({
        ...item,
        title: 'Sony™ Alpha\u2060 a6400 – Body®\uFEFF',
        retailer: 'bestbuy.com\u200B',
      }),
    ).toMatchObject({ name: 'Sony™ Alpha a6400 – Body®', retailer: 'bestbuy.com' })
  })

  it('saves from an Ask answer about something cheaper', async () => {
    const user = userEvent.setup()
    apiMock.mockResolvedValue({
      message: 'Up to $440.01 fits today.',
      mode: 'anthropic',
      intent: 'alternatives',
      suggestions: [],
      toolCalls: ['find_alternatives'],
      alternatives: found(),
    } as never)
    const onSave = vi.fn(async () => undefined)
    render(
      <Ask
        state={makeState()}
        visible
        onOpenDecision={vi.fn()}
        onOpenCheckout={vi.fn()}
        onNavigate={vi.fn()}
        onSave={onSave}
      />,
    )
    await user.type(screen.getByRole('textbox', { name: 'Message Worth' }), 'Something cheaper?')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await user.click(
      await screen.findByRole('button', {
        name: 'Save Interchangeable Lens Camera Body for later',
      }),
    )
    expect(onSave).toHaveBeenCalledWith(saved)
  })

  it('shows “Price dropped to $X” on Saved, checking each item once per page load', async () => {
    const state: AppState = {
      ...makeState(),
      saved: [
        { ...saved, id: 'c3-dropped', createdAt: '2026-10-03T12:00:00Z', status: 'active' },
        {
          ...saved,
          channel3Id: 'RSNbAN5',
          name: 'Mirrorless Digital Camera Body',
          id: 'c3-failing',
          createdAt: '2026-10-03T12:00:00Z',
          status: 'active',
        },
      ],
    }
    const checks: string[] = []
    apiMock.mockImplementation(((path: string) =>
      Promise.resolve().then(() => {
        if (!path.startsWith('/alternatives/price')) return state
        checks.push(path)
        if (path.includes('RSNbAN5')) throw new Error('Channel3 is unavailable')
        return { status: 'dropped', current: { priceCents: 29900 }, droppedByCents: 2349 }
      })) as typeof api)
    const props = {
      onOpenDecision: vi.fn(),
      onUpdate: vi.fn(),
      onToast: vi.fn(),
      onOpenCheckout: vi.fn(),
    }
    const view = render(<Saved {...props} state={state} />)
    expect(await screen.findByText('Price dropped to $299.00')).toBeTruthy()
    view.unmount()
    render(<Saved {...props} state={state} />)
    await screen.findByText('Price dropped to $299.00')
    // One check per item for the page load; the failing one shows nothing and no error.
    expect(checks).toEqual([
      '/alternatives/price?id=DBouSIg&savedPriceCents=32249',
      '/alternatives/price?id=RSNbAN5&savedPriceCents=32249',
    ])
    expect(screen.getAllByText(/Price dropped/)).toHaveLength(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
