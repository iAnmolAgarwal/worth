// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Decision } from '../src/Decision'
import { Saved } from '../src/Saved'
import { api } from '../src/api'
import { compareOptions } from '../shared/finance'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type { AppState, SavedItem, SavedPriceCheck } from '../shared/types'

// C6 on screen: the saved card names the store and who set the price; on the ready day an item
// from another store's page links back to it, after its Channel3 price is read again.

vi.mock('../src/paypalSdk', () => ({ loadPayPalSdk: vi.fn() }))
vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>()
  return { ...actual, api: vi.fn() }
})

const TODAY = '2026-10-23'
const LINK = 'https://shop.larkspur.example/products/trailhead-daypack-28l'
const apiMock = vi.mocked(api)
const linked = (patch: Partial<SavedItem> = {}): SavedItem => ({
  id: 'saved-pack',
  kind: 'custom',
  name: 'Trailhead Daypack 28L',
  amountCents: 12900,
  createdAt: '2026-10-03T12:00:00.000Z',
  status: 'ready',
  option: 'wait',
  waitDate: TODAY,
  sourceUrl: LINK,
  merchantName: 'Larkspur Supply',
  priceSource: 'channel3',
  ...patch,
})
/** Maya on the plan's day, with today's funds already confirmed, so the fresh check runs. */
function makeState(saved: SavedItem[], confirmed = true): AppState {
  const seed = createDemoState('2026-10-03')
  return {
    ...seed,
    profile: {
      ...seed.profile,
      aiConsent: false,
      userEdited: false,
      balanceCents: 284001,
      snapshotDate: confirmed ? TODAY : '2026-10-03',
      flows: seed.profile.flows.map((flow) =>
        flow.cadence === 'once' && flow.nextDate < TODAY
          ? { ...flow, paidOn: flow.nextDate }
          : flow,
      ),
    },
    reviews: [],
    today: TODAY,
    products: PRODUCTS,
    saved,
    wishlist: [],
    config: { ai: 'demo', paypal: 'demo' },
  }
}
const props = {
  onOpenDecision: vi.fn(),
  onUpdate: vi.fn(),
  onToast: vi.fn(),
  onOpenCheckout: vi.fn(),
}
/** Answers /compare from the engine and /saved/:id/recheck with `recheck`. */
function route(state: AppState, recheck: SavedPriceCheck | Error) {
  apiMock.mockImplementation((async (path: string, data: unknown) => {
    if (path.endsWith('/recheck')) {
      if (recheck instanceof Error) throw recheck
      return recheck
    }
    if (path === '/compare') {
      const input = data as { productId?: string; amountCents?: number; itemName?: string }
      const product = PRODUCTS.find((p) => p.id === input.productId)
      return compareOptions(state.profile, state.purchases, {
        amountCents: product?.priceCents ?? input.amountCents!,
        itemName: product?.name ?? input.itemName,
        today: state.today,
      })
    }
    throw new Error(`unexpected call to ${path}`)
  }) as typeof api)
}
const compareCalls = () =>
  apiMock.mock.calls.filter(([path]) => path === '/compare').map(([, data]) => data)
const recheckCalls = () => apiMock.mock.calls.filter(([path]) => String(path).endsWith('/recheck'))

beforeEach(() => {
  apiMock.mockReset()
  vi.stubGlobal('scrollTo', vi.fn())
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the saved card', () => {
  it('names the store and says who set the price', () => {
    const state = makeState([
      linked({ status: 'active', waitDate: '2026-10-30' }),
      linked({
        id: 'typed',
        name: 'Camp stove',
        sourceUrl: 'https://www.camp.example/stove',
        merchantName: 'camp.example',
        priceSource: 'user',
        status: 'active',
        waitDate: undefined,
      }),
    ])
    render(<Saved {...props} state={state} />)
    expect(screen.getAllByText('Larkspur Supply').length).toBeGreaterThan(0)
    expect(screen.getByText('Price read by Channel3, confirmed by you')).toBeTruthy()
    expect(screen.getAllByText('camp.example').length).toBeGreaterThan(0)
    expect(screen.getByText('Price you confirmed')).toBeTruthy()
    // Not ready yet: no link back and no price read.
    expect(screen.queryByRole('link', { name: /Back to/ })).toBeNull()
    expect(apiMock).not.toHaveBeenCalled()
  })
})

describe('the ready day for an item from another store', () => {
  it('links back to the store instead of any checkout in Worth', async () => {
    const state = makeState([linked({ priceSource: 'user' })])
    route(state, new Error('unused'))
    render(<Saved {...props} state={state} />)
    const back = screen.getByRole('link', { name: /Back to Larkspur Supply/ })
    expect(back.getAttribute('href')).toBe(LINK)
    expect(back.getAttribute('rel')).toBe('noopener noreferrer')
    await screen.findByText(/Checked just now/)
    expect(screen.queryByRole('button', { name: 'Buy with PayPal' })).toBeNull()
    expect(screen.queryByText(/Assessment only/)).toBeNull()
    // The shopper's own price is never read again.
    expect(recheckCalls()).toHaveLength(0)
  })

  it('names the store by its domain when it has no name', () => {
    const state = makeState([linked({ merchantName: undefined, priceSource: 'user' })], false)
    render(<Saved {...props} state={state} />)
    expect(screen.getByRole('link', { name: /Back to shop\.larkspur\.example/ })).toBeTruthy()
    // Before today's funds are confirmed, the link sits next to that step.
    expect(screen.getByRole('button', { name: 'Confirm today’s funds' })).toBeTruthy()
  })

  it('shows a changed price and checks the plan again at it', async () => {
    const state = makeState([linked()])
    route(state, { status: 'changed', savedPriceCents: 12900, priceCents: 10900 })
    render(<Saved {...props} state={state} />)
    expect(await screen.findByText('Price now $109.00 (was $129.00)')).toBeTruthy()
    await screen.findByText(/Checked just now/)
    expect(recheckCalls()).toEqual([['/saved/saved-pack/recheck', {}]])
    expect(compareCalls()).toEqual([
      {
        amountCents: 10900,
        itemName: 'Trailhead Daypack 28L',
        sourceUrl: LINK,
        priceSource: 'channel3',
      },
    ])
  })

  it('says when the price is the same, and checks at the saved price', async () => {
    const state = makeState([linked()])
    route(state, { status: 'same', savedPriceCents: 12900, priceCents: 12900 })
    render(<Saved {...props} state={state} />)
    expect(await screen.findByText(/still \$129\.00 at Larkspur Supply/)).toBeTruthy()
    await screen.findByText(/Checked just now/)
    expect(screen.queryByText(/Price now/)).toBeNull()
    expect(compareCalls()).toEqual([expect.objectContaining({ amountCents: 12900 })])
  })

  it.each([
    ['the server could not read it', { status: 'unavailable', savedPriceCents: 12900 } as const],
    ['the request failed', new Error('offline')],
  ])('falls back to the saved price when %s', async (_label, recheck) => {
    const state = makeState([linked()])
    route(state, recheck)
    render(<Saved {...props} state={state} />)
    expect(await screen.findByText(/Couldn’t re-check the price/)).toBeTruthy()
    await screen.findByText(/Checked just now/)
    expect(compareCalls()).toEqual([expect.objectContaining({ amountCents: 12900 })])
    expect(screen.getByRole('link', { name: /Back to Larkspur Supply/ })).toBeTruthy()
  })

  it('reads the price once when Saved opens, not again on a re-render', async () => {
    const state = makeState([linked()])
    route(state, { status: 'same', savedPriceCents: 12900, priceCents: 12900 })
    const view = render(<Saved {...props} state={state} />)
    await screen.findByText(/Checked just now/)
    view.rerender(<Saved {...props} state={{ ...state }} />)
    await screen.findByText(/Checked just now/)
    expect(recheckCalls()).toHaveLength(1)
  })

  it('keeps today’s behaviour for Maya’s demo-store items', async () => {
    const state = makeState([
      {
        id: 'saved-camera',
        kind: 'catalog',
        productId: 'camera',
        name: 'Everyday camera',
        amountCents: 119900,
        createdAt: '2026-10-03T12:00:00.000Z',
        status: 'ready',
        option: 'wait',
        waitDate: TODAY,
      },
    ])
    route(state, new Error('unused'))
    render(<Saved {...props} state={state} />)
    expect(await screen.findByRole('button', { name: 'Buy with PayPal' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Back to/ })).toBeNull()
    expect(recheckCalls()).toHaveLength(0)
  })
})

describe('Save for <date> from a pasted-link decision', () => {
  it('saves the store page, its name and the price source', async () => {
    const seed = makeState([])
    const state = { ...seed, today: '2026-10-03', profile: createDemoState('2026-10-03').profile }
    // The video scenario's $1,199 waits until Oct 23.
    apiMock.mockImplementation((async (path: string, input: unknown) => {
      if (path !== '/compare') throw new Error(`unexpected call to ${path}`)
      const request = input as { amountCents: number; itemName: string }
      return {
        ...compareOptions(state.profile, state.purchases, {
          amountCents: request.amountCents,
          itemName: request.itemName,
          today: '2026-10-03',
        }),
        source: { sourceUrl: LINK, merchantName: 'shop.larkspur.example', priceSource: 'channel3' },
      }
    }) as typeof api)
    const onSave = vi.fn()
    const user = userEvent.setup()
    render(
      <Decision
        state={state}
        request={{
          amountCents: 119900,
          itemName: 'Trailhead Daypack 28L',
          sourceUrl: LINK,
          priceSource: 'channel3',
        }}
        backLabel="Back"
        onBack={vi.fn()}
        onBuy={vi.fn()}
        onSave={onSave}
        onViewActivity={vi.fn()}
      />,
    )
    const save = await screen.findAllByRole('button', { name: /^Save for (?!later)/ })
    await user.click(save[0]!)
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const [target, plan] = onSave.mock.calls[0]!
    expect(target).toEqual({
      kind: 'custom',
      name: 'Trailhead Daypack 28L',
      amountCents: 119900,
      sourceUrl: LINK,
      merchantName: 'shop.larkspur.example',
      priceSource: 'channel3',
    })
    expect(plan).toEqual({ waitDate: '2026-10-23' })
  })
})
