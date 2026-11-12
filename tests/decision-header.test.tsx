// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Decision, type DecisionRequest } from '../src/Decision'
import { api } from '../src/api'
import { compareOptions } from '../shared/finance'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type { AppState } from '../shared/types'

vi.mock('../src/paypalSdk', () => ({ loadPayPalSdk: vi.fn() }))
vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>()
  return { ...actual, api: vi.fn() }
})

// Feedback 2 on the Decision page: the verdict leads in one light-blue block, and the item with
// its edit lives on the right (the rail's card), or in a compact row above the answer on phones.

const TODAY = '2026-10-03'
const apiMock = vi.mocked(api)
function makeState(): AppState {
  const seed = createDemoState(TODAY)
  return {
    ...seed,
    reviews: [],
    today: TODAY,
    products: PRODUCTS,
    config: { ai: 'demo', paypal: 'demo', alternatives: 'off' },
  } as AppState
}
function route(state: AppState) {
  apiMock.mockImplementation(((path: string, data?: unknown) =>
    Promise.resolve().then(() => {
      if (path !== '/compare') throw new Error(`Unexpected call to ${path}`)
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
function narrowScreen(narrow: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: narrow && query === '(max-width: 1023px)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
}
function show(request: DecisionRequest) {
  const state = makeState()
  route(state)
  return render(
    <Decision
      state={state}
      request={request}
      backLabel="Back to Saved"
      onBack={vi.fn()}
      onBuy={vi.fn()}
      onSave={vi.fn()}
      onViewActivity={vi.fn()}
      explanation={{
        points: [],
        toolCalls: [],
        mode: 'demo',
        readAs: 'camera · $1,199.00 · today',
      }}
    />,
  )
}
const compares = () => apiMock.mock.calls.filter(([path]) => path === '/compare')
const rail = () => within(screen.getByRole('complementary', { name: 'Item and reasons' }))

beforeEach(() => {
  apiMock.mockReset()
  narrowScreen(false)
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the Decision page header (feedback 2)', () => {
  it('leads with the verdict alone in its block, with no item line or Read-as chip', async () => {
    const { container } = show({ productId: 'camera' })
    const verdict = await screen.findByRole('heading', { level: 1 })
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    const block = screen.getByRole('region', { name: verdict.textContent! })
    expect(block.className).toBe('verdict-block')
    expect(block.childElementCount).toBe(2)
    expect(block.querySelector('p.lead')?.textContent).toMatch(/cushion/)
    expect(screen.queryByRole('group', { name: 'How Worth read your question' })).toBeNull()
    expect(screen.queryByText('Read as')).toBeNull()
    expect(screen.queryByText('Everyday camera, $1,199.00')).toBeNull()
    expect(container.querySelector('.decision-head .item-row')).toBeNull()
  })

  it('puts the item, its price, the day and the edit in the rail’s card', async () => {
    show({ productId: 'camera' })
    await screen.findByRole('heading', { level: 1 })
    expect(rail().getByText('Everyday camera')).toBeTruthy()
    // Reached inside Worth, a listed item has no seller line: Worth never names the demo store.
    expect(rail().queryByText(/Sold by|demo.store|Larkspur/)).toBeNull()
    expect(rail().getByText('$1,199.00')).toBeTruthy()
    expect(rail().getByText('· today')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Not right? Edit' })).toHaveLength(1)
    expect(rail().getByRole('button', { name: 'Not right? Edit' })).toBeTruthy()
  })

  it('gives a typed item with no product a minimal card on the right, with its edit', async () => {
    show({ amountCents: 119900, itemName: 'camera' })
    await screen.findByRole('heading', { level: 1 })
    const card = rail().getByText('camera').closest('.tile') as HTMLElement
    expect(within(card).queryByText(/demo store/)).toBeNull()
    expect(within(card).getByText('$1,199.00')).toBeTruthy()
    expect(within(card).getByText('· today')).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Not right? Edit' })).toBeTruthy()
    expect(card.querySelector('img')).toBeNull()
  })

  it('edits in the card as the chip did, moving focus into the form and back', async () => {
    const user = userEvent.setup()
    show({ productId: 'camera' })
    await screen.findByRole('heading', { level: 1 })
    await user.click(rail().getByRole('button', { name: 'Not right? Edit' }))
    const name = rail().getByLabelText('Item')
    expect(document.activeElement).toBe(name)
    // Cancel closes the form and hands focus back to the edit.
    await user.click(rail().getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(rail().getByRole('button', { name: 'Not right? Edit' }))
    // A new price is checked as the shopper's own, and focus comes back once it is answered.
    await user.click(rail().getByRole('button', { name: 'Not right? Edit' }))
    const price = rail().getByLabelText(/^Total price, USD/)
    await user.clear(price)
    await user.type(price, '1000')
    await user.click(rail().getByRole('button', { name: 'Check again' }))
    await waitFor(() =>
      expect(compares().at(-1)![1]).toEqual({ amountCents: 100000, itemName: 'Everyday camera' }),
    )
    expect(await rail().findByText('$1,000.00')).toBeTruthy()
    await waitFor(() =>
      expect(document.activeElement).toBe(rail().getByRole('button', { name: 'Not right? Edit' })),
    )
  })

  it('shows a compact item row above the verdict on narrow screens, and no card below', async () => {
    narrowScreen(true)
    const { container } = show({ productId: 'camera' })
    const verdict = await screen.findByRole('heading', { level: 1 })
    const row = container.querySelector('.item-row') as HTMLElement
    expect(row.compareDocumentPosition(verdict) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(row).getByText('Everyday camera')).toBeTruthy()
    expect(row.querySelector('.meta')!.textContent).toBe('$1,199.00 · today')
    expect(within(row).getByRole('button', { name: 'Not right? Edit' })).toBeTruthy()
    expect(container.querySelector('.decision-rail .product')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Not right? Edit' })).toHaveLength(1)
    await userEvent.click(within(row).getByRole('button', { name: 'Not right? Edit' }))
    expect(document.activeElement).toBe(within(row).getByLabelText('Item'))
  })
})
