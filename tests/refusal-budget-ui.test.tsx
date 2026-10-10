// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Ask } from '../src/Ask'
import { api } from '../src/api'
import { fallbackReply } from '../server/chat'
import { compareOptions } from '../shared/finance'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type { AppState, ChatReply } from '../shared/types'

// Round-3 judge #8 in Ask Worth: the refusal is the answer's first line, above the verdict, and
// the options stay within the budget the person stated.

vi.mock('../src/paypalSdk', () => ({ loadPayPalSdk: vi.fn() }))
vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>()
  return { ...actual, api: vi.fn() }
})
const TODAY = '2026-10-03'
const apiMock = vi.mocked(api)
function makeState(): AppState {
  const seed = createDemoState(TODAY)
  return {
    ...seed,
    profile: { ...seed.profile, aiConsent: true },
    reviews: [],
    today: TODAY,
    products: PRODUCTS,
    saved: [],
    config: { ai: 'anthropic', paypal: 'demo', model: 'test-provider' },
  }
}
function reply(state: AppState, message: string): ChatReply {
  return fallbackReply(
    {
      message,
      history: [],
      context: { amountCents: 119900, itemName: 'Everyday camera', purchaseDate: TODAY },
    },
    {
      profile: state.profile,
      purchases: state.purchases,
      transactions: state.transactions,
      today: TODAY,
    },
  )
}
async function ask(state: AppState, answer: ChatReply) {
  const user = userEvent.setup()
  apiMock.mockImplementation(((path: string, input: unknown) => {
    if (path !== '/compare') return Promise.resolve(answer)
    const product = PRODUCTS.find((p) => p.id === (input as { productId?: string }).productId)
    return Promise.resolve(
      compareOptions(state.profile, state.purchases, {
        amountCents: product?.priceCents ?? 119900,
        itemName: product?.name,
        today: TODAY,
        payIn4Eligible: true,
      }),
    )
  }) as typeof api)
  render(
    <Ask
      visible
      state={state}
      onOpenDecision={vi.fn()}
      onOpenCheckout={vi.fn()}
      onNavigate={vi.fn()}
    />,
  )
  await user.type(screen.getByRole('textbox', { name: 'Message Worth' }), 'question')
  await user.click(screen.getByRole('button', { name: 'Send' }))
}

beforeEach(() => {
  apiMock.mockReset()
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const RENT =
  'I wouldn’t skip or delay rent to make a purchase fit, because late fees and a missed payment cost more than waiting.'

describe('Ask Worth leads with the refusal (round-3 #8)', () => {
  it('shows the refusal once, above the verdict and the options', async () => {
    const state = makeState()
    await ask(
      state,
      reply(
        state,
        'My budget is $300 but honestly I could pay rent a week late. Is that fine for the camera?',
      ),
    )
    const refusal = await screen.findByText(RENT)
    const tile = screen.getByRole('region', { name: 'Purchase assessment' })
    const verdict = within(tile).getByText(/would dip below your cushion/)
    // The refusal comes before the verdict in the reading order, outside the verdict tile.
    expect(refusal.compareDocumentPosition(verdict) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(tile.contains(refusal)).toBe(false)
    expect(screen.getAllByText(RENT)).toHaveLength(1)
  })

  it('leads a clarifying question with the refusal too', async () => {
    const state = makeState()
    const answer = fallbackReply(
      { message: 'I could pay rent late. Can I get a new phone?', history: [] },
      {
        profile: state.profile,
        purchases: state.purchases,
        transactions: state.transactions,
        today: TODAY,
      },
    )
    await ask(state, answer)
    const refusal = await screen.findByText(RENT)
    const question = screen.getByText(/What is the total price in US dollars/)
    expect(
      refusal.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(screen.getAllByText(RENT)).toHaveLength(1)
  })

  it('shows no refusal line on an ordinary question', async () => {
    const state = makeState()
    await ask(state, reply(state, 'Can I get the camera?'))
    await screen.findByRole('region', { name: 'Purchase assessment' })
    expect(document.querySelector('.refusal')).toBeNull()
  })
})

describe('Ask Worth keeps to the stated budget (round-3 #8)', () => {
  it('caps “Spend less” at the budget instead of what keeps the cushion', async () => {
    const state = makeState()
    await ask(state, reply(state, 'I only want to spend $200. Can I get the camera?'))
    const options = await screen.findByRole('list', { name: 'Your options' })
    const spendLess = within(options)
      .getAllByRole('listitem')
      .find((row) => row.textContent?.includes('Spend less'))!
    expect(spendLess.textContent).toContain('Up to $200.00 today · your budget')
    expect(spendLess.textContent).toContain('Within your budget')
    expect(options.textContent).not.toContain('$440.01')
  })

  it('keeps the cushion’s limit when the budget is above it', async () => {
    const state = makeState()
    await ask(state, reply(state, 'My budget is $500. Can I get the camera?'))
    const options = await screen.findByRole('list', { name: 'Your options' })
    expect(options.textContent).toContain('Up to $440.01 today')
    expect(options.textContent).toContain('At your limit')
    expect(options.textContent).not.toContain('your budget')
  })

  it('offers spending less on an item that fits but is over the budget', async () => {
    const state = makeState()
    const answer = fallbackReply(
      { message: 'Can I afford the headphones? I can’t go over $300.', history: [] },
      {
        profile: state.profile,
        purchases: state.purchases,
        transactions: state.transactions,
        today: TODAY,
      },
    )
    await ask(state, answer)
    const options = await screen.findByRole('list', { name: 'Your options' })
    expect(options.textContent).toContain('Up to $300.00 today · your budget')
  })
})
