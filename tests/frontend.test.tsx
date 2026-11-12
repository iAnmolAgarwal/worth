// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'
import { Activity } from '../src/Activity'
import { Ask } from '../src/Ask'
import { Checkout, checkoutView } from '../src/Checkout'
import { Decision } from '../src/Decision'
import { ConfirmPlanDialog, RefundDialog } from '../src/Reviews'
import { Saved, Settings } from '../src/Saved'
import { Home } from '../src/Home'
import { api, ApiError } from '../src/api'
import {
  loadPayPalSdk,
  type PayPalSdkInstance,
  type PayPalSessionCallbacks,
} from '../src/paypalSdk'
import { assessPurchase, compareOptions } from '../shared/finance'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type {
  AppState,
  ChatMessage,
  ChatReply,
  ImportPreview,
  Purchase,
  PurchaseReview,
} from '../shared/types'

vi.mock('../src/paypalSdk', () => ({ loadPayPalSdk: vi.fn() }))
vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>()
  return { ...actual, api: vi.fn() }
})

const TODAY = '2026-10-03'
const apiMock = vi.mocked(api)
type ChatRequest = {
  message: string
  history: ChatMessage[]
  context?: { amountCents: number; itemName: string; purchaseDate?: string }
}
type User = ReturnType<typeof userEvent.setup>

function makeState(source: 'demo' | 'import' = 'demo'): AppState {
  const seed = createDemoState(TODAY)
  return {
    ...seed,
    profile: {
      ...seed.profile,
      source,
      name: source === 'import' ? 'Morgan' : seed.profile.name,
      version: source === 'import' ? 4 : 1,
      aiConsent: false,
      userEdited: source === 'import' ? true : false,
    },
    transactions:
      source === 'import'
        ? seed.transactions.slice(0, 4).map((t) => ({ ...t, source: 'import' as const }))
        : seed.transactions,
    reviews: [],
    today: TODAY,
    products: PRODUCTS,
    saved: seed.wishlist.map((productId, index) => {
      const product = PRODUCTS.find((p) => p.id === productId)!
      return {
        id: `saved-${productId}`,
        kind: 'catalog' as const,
        productId,
        name: product.name,
        amountCents: product.priceCents,
        createdAt: `${TODAY}T0${index}:00:00.000Z`,
        status: 'active' as const,
      }
    }),
    retention: { keep30: false, expiresAt: `${TODAY}T16:00:00.000Z` },
    config: { ai: 'anthropic', paypal: 'demo', model: 'test-provider' },
  }
}
/** The engine's own comparison, as POST /api/compare returns it. */
function compare(state: AppState, data: unknown) {
  const input = data as { productId?: string; amountCents?: number; itemName?: string }
  const product = PRODUCTS.find((p) => p.id === input.productId)
  return compareOptions(state.profile, state.purchases, {
    amountCents: product?.priceCents ?? input.amountCents!,
    itemName: product?.name ?? input.itemName,
    today: TODAY,
    payIn4Eligible: true,
  })
}
function reply(message: string, mode: ChatReply['mode'] = 'demo'): ChatReply {
  return { message, mode, intent: 'overview', suggestions: [], toolCalls: ['read_financial_plan'] }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function routeApi(
  route: (path: string, data?: unknown, method?: string) => unknown | Promise<unknown>,
) {
  apiMock.mockImplementation(
    (path, data, method) =>
      Promise.resolve().then(() => route(path, data, method)) as Promise<never>,
  )
}
async function sendMessage(user: User, text: string) {
  await user.type(screen.getByRole('textbox', { name: 'Message Worth' }), text)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}
/** "Ask Worth" in the nav opens the panel over the current screen; the address doesn't change. */
async function openAsk(user: User) {
  const nav = await screen.findByRole('navigation', { name: 'Main' }, { timeout: 3000 })
  const button = within(nav).getByRole('button', { name: 'Ask Worth' })
  if (button.getAttribute('aria-expanded') !== 'true') await user.click(button)
  await screen.findByRole('dialog', { name: 'Ask Worth' })
}
/** The privacy table and the assistant switch sit behind one disclosure under the composer. */
async function openWhatItSees(user: User) {
  await user.click(screen.getByRole('button', { name: /what (?:the assistant|it would) see/i }))
}
function purchase(state: AppState, patch: Partial<Purchase> = {}): Purchase {
  const product = state.products.find((p) => p.id === 'headphones')!
  return {
    id: 'reservation',
    productId: product.id,
    name: product.name,
    amountCents: product.priceCents,
    currency: 'USD',
    mode: 'sandbox',
    status: 'created',
    createdAt: `${TODAY}T12:00:00Z`,
    profileVersion: state.profile.version,
    assessmentDate: TODAY,
    ...patch,
  }
}
const askProps = {
  visible: true,
  onOpenDecision: vi.fn(),
  onOpenCheckout: vi.fn(),
  onNavigate: vi.fn(),
}
function checkoutProps(state: AppState) {
  return {
    state,
    product: state.products.find((p) => p.id === 'headphones')!,
    onClose: vi.fn(),
    onUpdate: vi.fn(),
    onViewActivity: vi.fn(),
    onConfirmPlan: vi.fn(),
    onEditPlan: vi.fn(),
  }
}

beforeEach(() => {
  apiMock.mockReset()
  vi.mocked(loadPayPalSdk).mockReset()
  window.history.replaceState(null, '', '/')
  vi.stubGlobal('scrollTo', vi.fn())
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('conversation isolation across sessions', () => {
  it('clears private chat on deletion, ignores a late old reply and starts the sample with an empty history', async () => {
    const user = userEvent.setup()
    const imported = makeState('import')
    const demo = makeState()
    const late = deferred<ChatReply>()
    const requests: ChatRequest[] = []
    const question = 'My private expense is a medical bill. How does it affect my plan?'
    const answer = 'Private local explanation of your medical expense.'
    let current = imported
    routeApi((path, data) => {
      if (path === '/state') return current
      if (path === '/compare') return compare(current, data)
      if (path === '/reset') {
        current = demo
        return demo
      }
      if (path === '/chat') {
        requests.push(data as ChatRequest)
        if (requests.length === 1) return reply(answer)
        if (requests.length === 2) return late.promise
        return reply('A fresh sample answer.', 'anthropic')
      }
      throw new Error(`Unexpected API request: ${path}`)
    })
    render(<App />)
    await openAsk(user)
    await sendMessage(user, question)
    await screen.findByText(answer)
    await sendMessage(user, 'A second question about the same private expense.')
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]!.history.some((m) => m.content === question)).toBe(true)

    act(() => {
      window.location.hash = 'settings'
    })
    await user.click(await screen.findByRole('button', { name: 'Delete my data now' }))
    await user.click(screen.getByRole('button', { name: 'Delete and start over' }))
    // The Ask Worth panel is a non-modal dialog and may stay open; the confirmation is gone.
    await waitFor(() =>
      expect(
        screen.queryAllByRole('dialog').filter((d) => d.getAttribute('aria-modal') !== 'false'),
      ).toEqual([]),
    )
    expect(screen.queryByText(question)).toBeNull()
    expect(screen.queryByText(answer)).toBeNull()
    await act(async () => {
      late.resolve(reply('Late private explanation.'))
      await late.promise
    })
    expect(screen.queryByText('Late private explanation.')).toBeNull()
    await openAsk(user)
    await sendMessage(user, 'How much can the sample profile spend?')
    await screen.findByText('A fresh sample answer.')
    expect(requests[2]!.history).toEqual([])
    expect(requests[2]!.context).toBeUndefined()
    expect(screen.getByText('Claude read your question · every number is Worth’s')).toBeTruthy()
  })

  it('replaces the sample conversation on import before the plan review and a new chat', async () => {
    const user = userEvent.setup()
    const demo = makeState()
    const imported = makeState('import')
    imported.profile.confirmed = false
    imported.profile.missingFields = ['Confirm your imported plan.']
    const requests: ChatRequest[] = []
    const oldAnswer = 'This answer belongs only to the old sample profile.'
    const preview: ImportPreview = {
      transactions: imported.transactions.slice(0, 1),
      errors: [],
      duplicates: 0,
      excluded: 0,
      coverageDays: 90,
      totalRows: 1,
      suggestedDailySpendCents: 3500,
      recurring: [],
      warnings: [],
      adjustments: [],
      leftOut: { memo: 0, holds: 0, otherCurrency: 0 },
      dateOrder: null,
      needsDateOrder: false,
      unresolved: [],
      converted: [],
      instalmentPlans: [],
    }
    let current = demo
    routeApi((path, data) => {
      if (path === '/state') return current
      if (path === '/compare') return compare(current, data)
      if (path === '/import/preview') return preview
      if (path === '/import/commit') {
        current = imported
        return imported
      }
      if (path === '/chat') {
        requests.push(data as ChatRequest)
        return requests.length === 1
          ? reply(oldAnswer, 'anthropic')
          : reply('Review your plan first.')
      }
      throw new Error(`Unexpected API request: ${path}`)
    })
    render(<App />)
    await openAsk(user)
    await sendMessage(user, 'Check the sample before I import my history.')
    await screen.findByText(oldAnswer)
    await user.click(screen.getByRole('button', { name: /account menu/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Import PayPal activity' }))
    await user.click(await screen.findByText('Or paste the CSV contents'))
    await user.type(
      screen.getByRole('textbox', { name: 'PayPal CSV contents' }),
      'Date,Name,Currency,Amount\n2026-10-01,Coffee,USD,-6.50',
    )
    await user.click(screen.getByRole('button', { name: /Preview my history/ }))
    await user.click(await screen.findByRole('checkbox', { name: /I reviewed this preview/ }))
    await user.click(screen.getByRole('button', { name: /Import and review my plan/ }))
    await screen.findByRole('heading', { name: 'How much money do you have right now?' })
    expect(screen.queryByText(oldAnswer)).toBeNull()
    // The plan wizard owns the screen and hides the panel; back on Home it opens again.
    act(() => {
      window.location.hash = 'home'
    })
    await openAsk(user)
    await sendMessage(user, 'What should I confirm now?')
    await screen.findByText('Review your plan first.')
    expect(requests[1]!.history).toEqual([])
    expect(requests[1]!.context).toBeUndefined()
  })
})

describe('queued prompts', () => {
  it('runs a prompt sent while another is pending, after it, with the finished exchange', async () => {
    const state = makeState()
    const first = deferred<ChatReply>()
    const second = deferred<ChatReply>()
    const requests: ChatRequest[] = []
    routeApi((path, data) => {
      if (path === '/compare') return compare(state, data)
      if (path !== '/chat') throw new Error(`Unexpected API request: ${path}`)
      requests.push(data as ChatRequest)
      return requests.length === 1 ? first.promise : second.promise
    })
    const view = render(
      <Ask {...askProps} state={state} initialPrompt={{ text: 'First question', id: 101 }} />,
    )
    await waitFor(() => expect(requests).toHaveLength(1))
    view.rerender(
      <Ask {...askProps} state={state} initialPrompt={{ text: 'Second question', id: 102 }} />,
    )
    expect(requests).toHaveLength(1)
    const assessment = assessPurchase(state.profile, [], {
      amountCents: 34900,
      itemName: 'Studio headphones',
      today: TODAY,
    })
    await act(async () => {
      first.resolve({ ...reply('The first purchase is checked.'), assessment })
      await first.promise
    })
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]!.message).toBe('Second question')
    expect(requests[1]!.history).toEqual([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'The first purchase is checked.' },
    ])
    expect(requests[1]!.context).toMatchObject({ amountCents: 34900, purchaseDate: TODAY })
    await act(async () => {
      second.resolve(reply('The follow-up is checked.'))
      await second.promise
    })
    await screen.findByText('The follow-up is checked.')
  })
})

describe('Claude consent in chat', () => {
  const shared =
    'your messages, recent chat history (including figures), the item, price and date you ask about, the items and prices you asked about earlier in the same conversation, a forecast summary, 30-day spending totals by category, income and bill names with amounts and dates, minimized merchant labels, whether PayPal offers Pay in 4 for the price and, when you ask about Pay in 4, its illustrative payment dates and the bills they land near, whether Worth prepared a checkout for a catalog item and how it went, and, when you ask for something cheaper, the kind of item to look for and whether similar items were found (never their names, stores or prices)'
  it('lets the untouched sample profile turn Claude off, keeping focus on the switch while it saves', async () => {
    const user = userEvent.setup()
    const state = makeState()
    const saved = deferred<AppState>()
    routeApi(() => saved.promise)
    const onUpdate = vi.fn()
    render(<Ask {...askProps} state={state} onUpdate={onUpdate} />)
    await openWhatItSees(user)
    const toggle = screen.getAllByRole('switch', {
      name: 'Use the assistant (powered by Claude)',
    })[0]!
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect((toggle as HTMLButtonElement).disabled).toBe(false)
    expect(
      screen.getAllByText(/^On: Claude reads your question, picks which of Worth’s facts to show/)
        .length,
    ).toBeGreaterThan(0)
    await user.click(toggle)
    expect(document.activeElement).toBe(toggle)
    expect(toggle.getAttribute('aria-disabled')).toBe('true')
    expect(apiMock).toHaveBeenCalledWith('/consent', { aiConsent: false })
    const off = { ...state, profile: { ...state.profile, aiChoiceMade: true } }
    await act(async () => {
      saved.resolve(off)
      await saved.promise
    })
    expect(onUpdate).toHaveBeenCalledWith(off)
    expect(document.activeElement).toBe(toggle)
  })
  it('lists everything Claude receives in Settings, with the same rows as Ask', () => {
    render(
      <Settings
        state={makeState()}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
        onEditPlan={vi.fn()}
        onImport={vi.fn()}
      />,
    )
    expect(
      screen.getByText(`When the assistant is on, these go to Anthropic (Claude): ${shared}.`),
    ).toBeTruthy()
    expect(screen.getByText('Shortened labels')).toBeTruthy()
    expect(
      screen.getByText('Sample data · Assistant: powered by Claude · PayPal checkout: simulated'),
    ).toBeTruthy()
  })
  it('toggles consent alone for personal data and reports the new state', async () => {
    const user = userEvent.setup()
    const state = makeState('import')
    const updated = { ...state, profile: { ...state.profile, aiConsent: true } }
    const requests: [string, unknown][] = []
    routeApi((path, data) => {
      requests.push([path, data])
      return updated
    })
    const onUpdate = vi.fn()
    render(<Ask {...askProps} state={state} onUpdate={onUpdate} />)
    await openWhatItSees(user)
    const toggle = screen.getAllByRole('switch', {
      name: 'Use the assistant (powered by Claude)',
    })[0]!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await user.click(toggle)
    await waitFor(() => expect(onUpdate).toHaveBeenCalledExactlyOnceWith(updated))
    expect(requests).toEqual([['/consent', { aiConsent: true }]])
  })
})

describe('Ask answers', () => {
  function cameraReply(state: AppState, today = TODAY): ChatReply {
    return {
      ...reply('full text', 'anthropic'),
      intent: 'affordability',
      assessment: assessPurchase(state.profile, [], {
        amountCents: 119900,
        itemName: 'camera',
        today,
      }),
      verdict: 'Camera at $1,199 would dip below your cushion if you buy it today.',
      lead: 'Here’s what matters for this purchase:',
      points: [{ id: 'cause', text: 'Apartment rent ($1,450) is due Fri, Oct 16.' }],
      interpretation: {
        items: [{ name: 'camera', amountCents: 119900, quantity: 1 }],
        amountCents: 119900,
        currency: 'USD',
        date: TODAY,
        dateLabel: 'today',
        dateSource: 'default',
        option: 'check',
        source: 'ai',
      },
      toolCalls: ['interpret_purchase', 'interpret_purchase'],
    }
  }

  it('shows the read-as chip, the verdict with engine options, Claude’s facts and a plain trace, and lets the user correct the reading', async () => {
    const user = userEvent.setup()
    const state = makeState()
    const requests: ChatRequest[] = []
    routeApi((path, data) => {
      if (path === '/compare') return compare(state, data)
      if (path !== '/chat') throw new Error(`Unexpected API request: ${path}`)
      requests.push(data as ChatRequest)
      return cameraReply(state)
    })
    const onOpenDecision = vi.fn()
    render(<Ask {...askProps} state={state} onOpenDecision={onOpenDecision} />)
    await sendMessage(user, 'Can I afford a $1,199 camera?')
    await screen.findByText('Camera at $1,199 would dip below your cushion if you buy it today.')
    const chip = screen.getByRole('group', { name: 'How Worth read your question' })
    expect(chip.textContent).toContain('Read as')
    expect(chip.textContent).toContain('Everyday camera · $1,199.00 · today')
    const options = await screen.findByRole('list', { name: 'Your options' })
    expect(within(options).getAllByRole('listitem')).toHaveLength(3)
    expect(within(options).getByText('Recommended')).toBeTruthy()
    // Each option names its period minimum the way the chart does.
    expect(options.textContent).toMatch(/Lowest point −\$458\.99 · \w{3}, \w{3} \d+/)
    expect(options.textContent).toMatch(/Lowest point \$[\d,.]+ · \w{3}, \w{3} \d+/)
    expect(options.textContent).not.toMatch(/Pay in 4/)
    const picked = screen.getByRole('region', { name: 'Picked for your question' })
    expect(picked.textContent).toContain('Picked for your question')
    expect(within(picked).getByText(/Apartment rent/)).toBeTruthy()
    expect(screen.queryByText('full text')).toBeNull()
    expect(screen.getByText('Claude read your question · every number is Worth’s')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /See the comparison/ }))
    expect(onOpenDecision).toHaveBeenCalledWith(
      { productId: 'camera' },
      expect.objectContaining({ mode: 'anthropic', toolCalls: expect.any(Array) }),
    )

    await user.click(within(chip).getByRole('button', { name: 'Edit' }))
    expect((screen.getByLabelText('Item') as HTMLInputElement).value).toBe('Camera')
    expect((screen.getByLabelText(/Total USD price/) as HTMLInputElement).value).toBe('1199.00')
    await user.clear(screen.getByLabelText(/Total USD price/))
    await user.type(screen.getByLabelText(/Total USD price/), '1099')
    await user.click(screen.getByRole('button', { name: 'Check my plan' }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]!.context).toEqual({
      amountCents: 109900,
      itemName: 'Camera',
      purchaseDate: TODAY,
    })
  })

  it('says when Claude is off and rechecks an earlier answer with today’s date', async () => {
    const user = userEvent.setup()
    const state = { ...makeState('import'), today: '2026-10-04' }
    const requests: ChatRequest[] = []
    routeApi((path, data) => {
      if (path === '/compare') return compare(state, data)
      requests.push(data as ChatRequest)
      return { ...cameraReply(state), mode: 'demo' as const, points: undefined }
    })
    render(<Ask {...askProps} state={state} />)
    await sendMessage(user, 'Can I afford a $1,199 camera?')
    await screen.findByText('Worth’s own calculation · assistant off')
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]!.context).toMatchObject({ purchaseDate: '2026-10-04' })
  })

  it('links to the store’s own page for an item to buy, in the same tab, with no order card', async () => {
    const user = userEvent.setup()
    const state = makeState()
    routeApi(() => ({
      ...reply('Here is what buying it today does to your plan.', 'anthropic'),
      toolCalls: ['open_store_checkout'],
      storeLink: {
        url: 'https://store.example/p/camera',
        merchant: 'Larkspur Supply',
        itemName: 'Everyday camera',
        amountCents: 119900,
      },
    }))
    render(<Ask {...askProps} state={state} />)
    await sendMessage(user, 'Buy the camera.')
    const card = await screen.findByRole('region', { name: 'Buy at Larkspur Supply' })
    expect(card.textContent).toContain('Everyday camera, $1,199.00 at Larkspur Supply')
    expect(card.textContent).toContain('Worth doesn’t sell this.')
    const link = within(card).getByRole('link', { name: 'Open at Larkspur Supply' })
    expect(link.getAttribute('href')).toBe('https://store.example/p/camera')
    expect(link.getAttribute('rel')).toBe('noreferrer')
    expect(link.getAttribute('target')).toBeNull()
    expect(card.textContent).not.toContain('Worth suggests waiting')
    expect(screen.queryByText(/Checkout ready/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open checkout' })).toBeNull()
  })

  it('repeats the wait date above the store link when waiting is Worth’s advice', async () => {
    const user = userEvent.setup()
    routeApi(() => ({
      ...reply('Here is what buying it today does to your plan.', 'anthropic'),
      toolCalls: ['open_store_checkout'],
      storeLink: {
        url: 'https://store.example/p/camera',
        merchant: 'Larkspur Supply',
        itemName: 'Everyday camera',
        amountCents: 119900,
        waitDate: '2026-10-23',
      },
    }))
    render(<Ask {...askProps} state={makeState()} />)
    await sendMessage(user, 'Buy the camera.')
    const card = await screen.findByRole('region', { name: 'Buy at Larkspur Supply' })
    const line = within(card).getByText('Worth suggests waiting until Fri, Oct 23.')
    expect(line.className).toBe('meta')
    expect(within(card).getByRole('link', { name: 'Open at Larkspur Supply' })).toBeTruthy()
  })

  it('shows no store link when the answer has none', async () => {
    const user = userEvent.setup()
    routeApi(() => ({
      ...reply('Here is what buying it today does to your plan.', 'anthropic'),
      toolCalls: ['open_store_checkout'],
    }))
    render(<Ask {...askProps} state={makeState()} />)
    await sendMessage(user, 'Buy the camera.')
    await screen.findByText('Here is what buying it today does to your plan.')
    expect(screen.queryByRole('link', { name: /Open at/ })).toBeNull()
    expect(screen.queryByRole('region', { name: /Buy at/ })).toBeNull()
  })

  it('discards private history when the server rejects a chat across a session change', async () => {
    const user = userEvent.setup()
    const onSessionChange = vi.fn()
    let count = 0
    routeApi(() => {
      if (++count === 1) return reply('Private earlier answer.')
      throw new ApiError('Session changed', 409, 'SESSION_CHANGED')
    })
    render(
      <Ask
        {...askProps}
        state={{ ...makeState('import'), sessionKey: '11111111111111111111' }}
        onSessionChange={onSessionChange}
      />,
    )
    await sendMessage(user, 'My earlier private question.')
    await screen.findByText('Private earlier answer.')
    await sendMessage(user, 'My private follow-up.')
    await screen.findByText(/Your session changed/)
    expect(screen.queryByText('Private earlier answer.')).toBeNull()
    expect((screen.getByRole('textbox', { name: 'Message Worth' }) as HTMLInputElement).value).toBe(
      '',
    )
    expect(onSessionChange).toHaveBeenCalledOnce()
  })
})

describe('decision view', () => {
  const props = {
    backLabel: 'Back to Ask',
    onBack: vi.fn(),
    onBuy: vi.fn(),
    onSave: vi.fn(),
    onEditPlan: vi.fn(),
    onViewActivity: vi.fn(),
  }
  it('says “bought on” with the plan’s own day, the demo clock’s under a replay', async () => {
    const state = makeState()
    const bought = {
      ...purchase(state, { productId: 'camera', name: 'Everyday camera', amountCents: 119900 }),
      status: 'completed' as const,
      completedAt: '2026-10-04T16:00:00Z',
      completedOn: '2026-10-23',
    }
    routeApi((_path, data) => compare(state, data))
    render(
      <Decision
        {...props}
        state={{ ...state, purchases: [bought] }}
        request={{ productId: 'camera' }}
      />,
    )
    const tile = await screen.findByRole('region', { name: 'Bought' })
    expect(tile.textContent).toContain('Fri, Oct 23')
    expect(tile.textContent).not.toContain('Oct 4')
  })

  it('selects the engine’s recommendation, leads with the margin and draws one chart', async () => {
    const user = userEvent.setup()
    const state = makeState()
    routeApi((_path, data) => compare(state, data))
    render(<Decision {...props} state={state} request={{ productId: 'camera' }} />)
    const group = await screen.findByRole('radiogroup', { name: 'Your options' })
    const radios = within(group).getAllByRole('radio')
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    expect(screen.getByRole('heading', { level: 1, name: /^Wait until/ })).toBeTruthy()
    expect(screen.getAllByRole('img', { name: /^Projected balance/ })).toHaveLength(1)
    fireEvent.keyDown(radios[1]!, { key: 'ArrowRight' })
    expect(radios[2]!.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('heading', { name: /If you spend/ })).toBeTruthy()
    await user.click(screen.getAllByRole('button', { name: /^Save for / })[0]!)
    expect(props.onSave).toHaveBeenCalledWith(
      { kind: 'catalog', productId: 'camera' },
      { waitDate: expect.stringMatching(/^2026-/) },
    )
  })

  it('keeps Pay in 4 collapsed until asked, then shows its two dates, four payments and stacking, never as a recommendation', async () => {
    const user = userEvent.setup()
    const state = makeState()
    routeApi((_path, data) => ({
      ...compare(state, data),
      payIn4: { ...compare(state, data).payIn4, eligibility: 'range-only' },
    }))
    render(<Decision {...props} state={state} request={{ productId: 'camera' }} />)
    const toggle = await screen.findByRole('button', { name: /Compare with PayPal Pay in 4/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const scenario = compare(state, { productId: 'camera' }).payIn4
    if (!scenario.available) throw new Error('Expected a Pay in 4 scenario')
    // Two dates, each named for what it is: the first day below the cushion, then the lowest point.
    expect(
      screen.getByText(
        /^With Pay in 4, your balance would first go below your cushion on \w{3}, \w{3} \d+\.$/,
      ),
    ).toBeTruthy()
    expect(
      screen.getByText(
        new RegExp(`Lowest point \\$140\\.51 (on \\w{3}, \\w{3} \\d+|that same day)`),
      ),
    ).toBeTruthy()
    // The chart states the comparison's point in one line, above the plot.
    expect(document.querySelector('.chart-thesis')!.textContent).toMatch(
      /^With PayPal Pay in 4 from today, \w{3} \d+, your lowest point is \w{3}, \w{3} \d+ at \$140\.51, below your cushion; paying in full on \w{3}, \w{3} \d+, it’s \w{3}, \w{3} \d+ at \$720\.53\.$/,
    )
    const schedule = screen.getByRole('list', { name: 'Illustrative Pay in 4 schedule' })
    expect(within(schedule).getAllByRole('listitem')).toHaveLength(4)
    expect(screen.getByText(scenario.stacking!.message)).toBeTruthy()
    expect(screen.getByText(/Already running: Laptop · Pay in 4/)).toBeTruthy()
    expect(screen.getByText(/Worth never recommends it/).textContent).toContain(
      'Availability is decided by PayPal at checkout.',
    )
  })

  it('shows Pay in 4 as unavailable when PayPal does not offer it', async () => {
    const state = makeState()
    routeApi((_path, data) => ({
      ...compare(state, data),
      payIn4: {
        available: false,
        reason: 'Not available for this amount',
        eligibility: 'unavailable',
      },
    }))
    render(<Decision {...props} state={state} request={{ productId: 'camera' }} />)
    await screen.findByText('Not available for this amount')
    expect(screen.queryByRole('button', { name: /Compare with PayPal Pay in 4/ })).toBeNull()
  })

  // Pre-merge judge finding 5: consent below the cushion is given on the checkout review itself.
  it('starts the below-cushion consent unticked, even after “Buy today anyway”', async () => {
    const user = userEvent.setup()
    const state = makeState()
    const camera = state.products.find((p) => p.id === 'camera')!
    routeApi((path, data) => {
      if (path === '/assess')
        return assessPurchase(state.profile, [], { amountCents: 119900, today: TODAY })
      if (path === '/compare') return compare(state, data)
      throw new Error(`Unexpected API request: ${path}`)
    })
    render(<Checkout {...checkoutProps(state)} product={camera} acknowledge />)
    const consent = (await screen.findByRole('checkbox', {
      name: /I understand buying today takes me below my \$300\.00 cushion/,
    })) as HTMLInputElement
    expect(consent.checked).toBe(false)
    expect(screen.getByText(/You chose to buy today anyway/)).toBeTruthy()
    const start = screen.getByRole('button', { name: /Continue to PayPal|simulated checkout/ })
    await user.click(screen.getByRole('checkbox', { name: /My money and bills are still/ }))
    expect((start as HTMLButtonElement).disabled).toBe(true)
    await user.click(consent)
    expect((start as HTMLButtonElement).disabled).toBe(false)
  })

  it('restates the breach before buying today anyway', async () => {
    const user = userEvent.setup()
    const state = makeState()
    const onBuy = vi.fn()
    routeApi((_path, data) => compare(state, data))
    render(<Decision {...props} onBuy={onBuy} state={state} request={{ productId: 'camera' }} />)
    await user.click((await screen.findAllByRole('button', { name: 'Buy today anyway' }))[0]!)
    const dialog = screen.getByRole('dialog', { name: 'Buy today anyway?' })
    expect(dialog.textContent).toContain('below your $300.00 cushion')
    await user.click(within(dialog).getByRole('button', { name: 'Continue to checkout' }))
    expect(onBuy).toHaveBeenCalledWith(expect.objectContaining({ id: 'camera' }), true)
  })
})

/** Checkout inside a parent that applies onUpdate, as the app does. */
function Harness({ initial }: { initial: AppState }) {
  const [state, setState] = useState(initial)
  return (
    <Checkout
      {...checkoutProps(state)}
      onUpdate={setState}
      purchaseId="reservation"
      returnedApproved
    />
  )
}

describe('checkout status', () => {
  it.each([
    [undefined, false, 'review'],
    [{ status: 'created' }, false, 'approve'],
    [{ status: 'created' }, true, 'approved'],
    [{ status: 'created', mode: 'demo' }, false, 'approved'],
    [{ status: 'created', needsReapproval: true }, true, 'declined'],
    [{ status: 'failed' }, false, 'failed'],
    [{ status: 'pending' }, false, 'checking'],
    [{ status: 'unknown' }, false, 'checking'],
    [{ status: 'cancelled' }, false, 'cancelled'],
    [{ status: 'completed' }, false, 'completed'],
  ] as const)('maps %o (approved: %s) to %s', (patch, approved, view) => {
    const state = makeState()
    expect(
      checkoutView(
        patch ? purchase(state, patch as Partial<Purchase>) : undefined,
        approved,
        false,
      ),
    ).toBe(view)
  })
  it('shows Waiting for PayPal only once PayPal was opened from this screen', () => {
    expect(checkoutView(purchase(makeState()), false, true)).toBe('waiting')
  })
  it('leads an order prepared elsewhere with the official PayPal button, not a waiting state', async () => {
    const state = makeState()
    state.config = { ...state.config, paypal: 'sandbox', paypalClientId: 'public-test-client' }
    const prepared = purchase(state, { preparedBy: 'agent', orderId: 'ORDER' })
    const current = { ...state, purchases: [prepared] }
    routeApi((path, data) =>
      path === '/compare'
        ? compare(current, data)
        : assessPurchase(state.profile, [], { amountCents: 34900, today: TODAY }),
    )
    const instance: PayPalSdkInstance = {
      findEligibleMethods: async () => ({ isEligible: () => true }),
      createPayPalOneTimePaymentSession: vi.fn(),
    }
    const { container } = render(
      <Checkout
        {...checkoutProps(current)}
        purchaseId="reservation"
        instance={instance}
        sdkStatus="ready"
      />,
    )
    expect(screen.getByRole('heading', { name: 'Approve in PayPal' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Waiting for PayPal' })).toBeNull()
    await waitFor(() => expect(container.ownerDocument.querySelector('paypal-button')).toBeTruthy())
  })

  it('recovers a reservation after an uncertain create and keeps the error in view', async () => {
    const user = userEvent.setup()
    const state = makeState()
    state.config.paypal = 'sandbox'
    const recovered: AppState = { ...state, purchases: [purchase(state, { status: 'unknown' })] }
    const props = checkoutProps(state)
    routeApi((path, data) => {
      if (path === '/assess')
        return assessPurchase(state.profile, [], {
          ...(data as { amountCents: number; purchaseDate: string }),
          today: TODAY,
        })
      if (path === '/compare') return compare(recovered, data)
      if (path === '/checkout/create')
        throw new ApiError(
          'PayPal did not return a confirmed order result.',
          502,
          'PAYPAL_UNCERTAIN',
        )
      if (path === '/state') return recovered
      throw new Error(`Unexpected API request: ${path}`)
    })
    render(<Checkout {...props} />)
    await user.click(
      await screen.findByRole('checkbox', {
        name: 'My money and bills are still as entered today.',
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Continue to PayPal sandbox' }))
    await screen.findByRole('heading', { name: 'PayPal is still confirming' })
    expect(props.onUpdate).toHaveBeenCalledWith(recovered)
    expect(screen.getByRole('button', { name: 'Check payment status' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain(
      'PayPal did not return a confirmed order result.',
    )
    expect(apiMock.mock.calls.filter(([path]) => path === '/checkout/create')).toHaveLength(1)
  })

  it.each(['approve', 'cancel'] as const)(
    'keeps the official button’s %s separate from capture and reuses the created order',
    async (outcome) => {
      const user = userEvent.setup()
      const state = makeState()
      state.config = { ...state.config, paypal: 'sandbox', paypalClientId: 'public-test-client' }
      const created = purchase(state, { id: 'sdk-checkout', orderId: 'SANDBOX_ORDER' })
      let callbacks: PayPalSessionCallbacks | undefined
      const start = vi.fn(async (_options: unknown, order: Promise<{ orderId: string }>) => {
        const resolved = await order
        if (outcome === 'approve') await callbacks!.onApprove({ ...resolved, payerId: 'buyer' })
        else await callbacks!.onCancel?.(resolved)
      })
      const createSession = vi.fn((options: PayPalSessionCallbacks) => {
        callbacks = options
        return { start, hasReturned: () => false, resume: async () => undefined }
      })
      const findEligibleMethods = vi.fn(async () => ({ isEligible: () => true }))
      const instance: PayPalSdkInstance = {
        findEligibleMethods,
        createPayPalOneTimePaymentSession: createSession,
      }
      let current: AppState = state
      routeApi((path, data) => {
        if (path === '/assess')
          return assessPurchase(state.profile, [], { amountCents: 34900, today: TODAY })
        if (path === '/compare') return compare(current, data)
        if (path === '/checkout/create') {
          current = { ...state, purchases: [created] }
          return {
            purchase: created,
            mode: 'sandbox',
            approvalUrl: 'https://www.sandbox.paypal.com/x',
          }
        }
        if (path === '/state') return current
        if (path === '/checkout/sdk-checkout/capture') {
          const paid = { ...created, status: 'completed' as const, captureId: 'CAPTURE' }
          current = { ...state, purchases: [paid] }
          return { purchase: paid, state: current }
        }
        throw new Error(`Unexpected API request: ${path}`)
      })
      const props = checkoutProps(state)
      const { container } = render(<Checkout {...props} instance={instance} sdkStatus="ready" />)
      await user.click(
        await screen.findByRole('checkbox', {
          name: 'My money and bills are still as entered today.',
        }),
      )
      await waitFor(() =>
        expect(container.ownerDocument.querySelector('paypal-button')).toBeTruthy(),
      )
      expect(findEligibleMethods).toHaveBeenCalledWith({ currencyCode: 'USD', amount: '349.00' })
      await user.click(container.ownerDocument.querySelector('paypal-button')!)
      await screen.findByRole('heading', {
        name: outcome === 'approve' ? 'Approved in PayPal' : 'Approve in PayPal',
      })
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ commit: false }))
      expect(start).toHaveBeenCalledOnce()
      expect(apiMock.mock.calls.filter(([path]) => path.endsWith('/capture'))).toHaveLength(0)
      if (outcome === 'approve') {
        await user.click(screen.getByRole('button', { name: 'Pay $349.00' }))
        await screen.findByRole('heading', { name: 'Paid $349.00' })
        expect(apiMock.mock.calls.filter(([path]) => path.endsWith('/capture'))).toHaveLength(1)
      } else {
        expect(screen.getByText(/You closed PayPal before approving/)).toBeTruthy()
        expect(container.ownerDocument.querySelector('paypal-button')).toBeTruthy()
      }
    },
  )

  it('asks “Buy anyway?” before capturing below the cushion and sends the acknowledgement', async () => {
    const user = userEvent.setup()
    const state = makeState()
    const reserved = purchase(state, { proceedConfirmRequired: true, preparedBy: 'agent' })
    const current = { ...state, purchases: [reserved] }
    const bodies: unknown[] = []
    routeApi((path, data) => {
      if (path === '/assess')
        return assessPurchase(state.profile, [], { amountCents: 34900, today: TODAY })
      if (path === '/compare') return compare(current, data)
      if (path.endsWith('/capture')) {
        bodies.push(data)
        const paid = { ...reserved, status: 'completed' as const }
        return { purchase: paid, state: { ...state, purchases: [paid] } }
      }
      throw new Error(`Unexpected API request: ${path}`)
    })
    render(<Checkout {...checkoutProps(current)} purchaseId="reservation" returnedApproved />)
    expect(screen.getByText(/Prepared by Worth’s assistant/)).toBeTruthy()
    await user.click(await screen.findByRole('button', { name: 'Pay $349.00' }))
    expect(bodies).toEqual([])
    expect(await screen.findByText(/Buy anyway\?/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Buy anyway' }))
    await waitFor(() => expect(bodies).toEqual([{ acknowledgeShortfall: true }]))
  })

  it('shows the confirm step when the server requires the acknowledgement', async () => {
    const user = userEvent.setup()
    const state = makeState()
    const current = { ...state, purchases: [purchase(state)] }
    routeApi((path, data) => {
      if (path === '/assess')
        return assessPurchase(state.profile, [], { amountCents: 34900, today: TODAY })
      if (path === '/compare') return compare(current, data)
      if (path === '/state') return current
      throw new ApiError('Confirm first.', 409, 'SHORTFALL_ACKNOWLEDGEMENT_REQUIRED')
    })
    render(<Checkout {...checkoutProps(current)} purchaseId="reservation" returnedApproved />)
    await user.click(await screen.findByRole('button', { name: 'Pay $349.00' }))
    expect(await screen.findByRole('button', { name: 'Buy anyway' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('turns a declined capture into re-approval with the contract copy', async () => {
    const user = userEvent.setup()
    const state = makeState()
    const reserved = purchase(state)
    let current: AppState = { ...state, purchases: [reserved] }
    const declined = {
      ...reserved,
      needsReapproval: true,
      approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=AGAIN',
      lastError: { code: 'INSTRUMENT_DECLINED', message: 'The card was declined.' },
    }
    routeApi((path, data) => {
      if (path === '/assess')
        return assessPurchase(state.profile, [], { amountCents: 34900, today: TODAY })
      if (path === '/compare') return compare(current, data)
      if (path === '/state') return current
      if (path.endsWith('/capture')) {
        current = { ...state, purchases: [declined] }
        throw new ApiError('Declined', 409, 'PAYMENT_DECLINED', { purchase: declined })
      }
      throw new Error(`Unexpected API request: ${path}`)
    })
    render(<Harness initial={current} />)
    await user.click(await screen.findByRole('button', { name: 'Pay $349.00' }))
    await screen.findByRole('heading', { name: 'That card was declined' })
    expect(
      screen.getByText('Your payment method was declined. Choose another way to pay in PayPal.'),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Choose another way to pay' })).toBeTruthy()
  })

  it('frees the amount in copy once cancelled', () => {
    const state = makeState()
    const current = { ...state, purchases: [purchase(state, { status: 'cancelled' })] }
    routeApi((path, data) =>
      path === '/compare'
        ? compare(current, data)
        : assessPurchase(state.profile, [], { amountCents: 34900, today: TODAY }),
    )
    render(<Checkout {...checkoutProps(current)} purchaseId="reservation" />)
    expect(screen.getByRole('heading', { name: 'Checkout cancelled' })).toBeTruthy()
    expect(
      screen.getByText('Nothing was charged. The $349.00 set aside in your plan is free again.'),
    ).toBeTruthy()
  })
})

describe('after a purchase', () => {
  const completed = (state: AppState) =>
    purchase(state, { status: 'completed', completedAt: `${TODAY}T12:05:00Z`, captureId: 'CAP' })

  it('confirms Pay in 4 with editable dates and amounts pre-filled from the illustrative schedule', async () => {
    const user = userEvent.setup()
    const state = makeState()
    const paid = completed(state)
    state.purchases = [paid]
    const onUpdate = vi.fn()
    routeApi(() => state)
    render(
      <ConfirmPlanDialog
        state={state}
        purchaseId={paid.id}
        onClose={vi.fn()}
        onUpdate={onUpdate}
      />,
    )
    await user.click(screen.getByRole('radio', { name: 'Pay in 4' }))
    expect((screen.getByLabelText(/^Payment 1 amount/) as HTMLInputElement).value).toBe('87.25')
    expect(
      screen.getByRole('spinbutton', { name: 'Payment 4 date' }).getAttribute('aria-valuetext'),
    ).toBe('Sat, Nov 14')
    await user.click(screen.getByRole('button', { name: 'Payment 2 date: a day later' }))
    await user.click(screen.getByRole('button', { name: 'Payment 2 date: a day later' }))
    await user.click(screen.getByRole('button', { name: 'Confirm plan' }))
    await waitFor(() => expect(onUpdate).toHaveBeenCalled())
    expect(apiMock).toHaveBeenCalledWith(`/purchases/${paid.id}/plan`, {
      product: 'payIn4',
      instalments: [
        { date: '2026-10-03', amountCents: 8725 },
        { date: '2026-10-19', amountCents: 8725 },
        { date: '2026-10-31', amountCents: 8725 },
        { date: '2026-11-14', amountCents: 8725 },
      ],
    })
  })

  it('confirms what a refund actually returned, with the partial refund and store credit copy', async () => {
    const user = userEvent.setup()
    const state = makeState()
    const paid = {
      ...completed(state),
      refunds: [
        {
          id: 'R1',
          amountCents: 10000,
          status: 'review' as const,
          createdAt: `${TODAY}T13:00:00Z`,
        },
      ],
    }
    state.purchases = [paid]
    routeApi(() => state)
    render(
      <RefundDialog
        state={state}
        purchaseId={paid.id}
        refundId="R1"
        onClose={vi.fn()}
        onUpdate={vi.fn()}
      />,
    )
    expect(screen.getByText(/Store credit does not reduce the loan/)).toBeTruthy()
    const returned = screen.getByLabelText(/Money that came back/)
    await user.clear(returned)
    await user.type(returned, '0')
    await user.click(screen.getByRole('button', { name: 'Confirm refund' }))
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(`/purchases/${paid.id}/refunds/R1/confirm`, {
        returnedCents: 0,
      }),
    )
  })

  it('lists pending checkouts, refund reviews and unconfirmed plans in Activity', async () => {
    const user = userEvent.setup()
    const state = makeState()
    const paid = completed(state)
    const reviews: PurchaseReview[] = [
      {
        kind: 'confirmPlan',
        purchaseId: paid.id,
        name: paid.name,
        amountCents: paid.amountCents,
        title: 'Confirm your plan',
        message: 'm',
      },
      {
        kind: 'refund',
        purchaseId: paid.id,
        refundId: 'R1',
        name: paid.name,
        refundedCents: 5000,
        title: 'Review a refund',
        message: 'm',
      },
    ]
    const live = { ...purchase(state, { id: 'live', status: 'created' }) }
    const current: AppState = {
      ...state,
      reviews,
      purchases: [paid, live],
      transactions: [
        {
          id: `purchase-${paid.id}`,
          date: TODAY,
          name: paid.name,
          amountCents: -paid.amountCents,
          currency: 'USD',
          category: 'Shopping',
          kind: 'expense',
          status: 'completed',
          source: 'purchase',
        },
        ...state.transactions,
      ],
    }
    const props = {
      onUpdate: vi.fn(),
      onAsk: vi.fn(),
      onOpenCheckout: vi.fn(),
      onConfirmPlan: vi.fn(),
      onReviewRefund: vi.fn(),
    }
    render(<Activity state={current} {...props} />)
    const pending = screen.getByRole('region', { name: 'Pending' })
    expect(within(pending).getByText(/Waiting for PayPal/)).toBeTruthy()
    expect(within(pending).getByText('Refund to review')).toBeTruthy()
    await user.click(within(pending).getByText('Refund to review'))
    expect(props.onReviewRefund).toHaveBeenCalledWith(paid.id, 'R1')
    await user.click(screen.getAllByText('Confirm your plan')[0]!)
    expect(props.onConfirmPlan).toHaveBeenCalledWith(paid.id)
    await user.type(screen.getByRole('searchbox', { name: 'Search activity' }), 'zzzz')
    expect(screen.getByRole('heading', { name: 'No matches for “zzzz”' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.getByRole('region', { name: 'Completed' })).toBeTruthy()
  })
})

describe('app shell', () => {
  it('reopens a checkout on return from PayPal and strips the PayPal parameters', async () => {
    const state = makeState()
    state.config.paypal = 'sandbox'
    const reserved = purchase(state, { id: 'returned' })
    const current = { ...state, purchases: [reserved] }
    routeApi((path, data) => {
      if (path === '/state') return current
      if (path === '/compare') return compare(current, data)
      if (path === '/assess')
        return assessPurchase(state.profile, [], { amountCents: 34900, today: TODAY })
      throw new Error(`Unexpected API request: ${path}`)
    })
    window.history.replaceState(null, '', '/?checkout=returned&paypal=approved#home')
    render(<App />)
    await screen.findByRole('heading', { name: 'Approved in PayPal' })
    expect(window.location.search).toBe('')
    expect(window.location.hash).toBe('#home')
  })

  it('shows room to spend from the engine on Home with the cushion behind the info', async () => {
    const state = makeState()
    routeApi((path, data) => (path === '/state' ? state : compare(state, data)))
    render(<App />)
    const hero = await screen.findByRole('region', { name: 'Safe to spend today' })
    const expected = compare(state, { amountCents: 0 })
    await waitFor(() =>
      expect(hero.textContent).toContain(
        new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
          expected.spendLess.maxPriceCents / 100,
        ),
      ),
    )
    const info = within(hero).getByLabelText('How Worth worked this out').closest('details')!
    expect(info.open).toBe(false)
    expect(info.textContent).toContain('Keeps your $300.00 cushion, if your plan holds.')
    expect(info.textContent).toContain('you confirmed today')
  })
})

describe('blocking fixes', () => {
  const decisionProps = {
    backLabel: 'Back to Ask',
    onBack: vi.fn(),
    onBuy: vi.fn(),
    onSave: vi.fn(),
    onEditPlan: vi.fn(),
    onViewActivity: vi.fn(),
  }
  it('shows a Bought state for an item already bought, with View in Activity', async () => {
    const user = userEvent.setup()
    const state = makeState()
    const paid = purchase(state, {
      status: 'completed',
      completedAt: '2026-10-04T02:00:00Z',
      assessmentDate: TODAY,
    })
    const current = { ...state, purchases: [paid] }
    const onViewActivity = vi.fn()
    routeApi((_path, data) => compare(current, data))
    render(
      <Decision
        {...decisionProps}
        onViewActivity={onViewActivity}
        state={current}
        request={{ productId: paid.productId }}
      />,
    )
    const bought = await screen.findByRole('region', { name: 'Bought' })
    // 2 am UTC on Oct 4 is still Oct 3 in New York, the profile's time zone.
    expect(bought.textContent).toContain('Sat, Oct 3')
    expect(screen.queryByText(/Wait until/)).toBeNull()
    await user.click(within(bought).getByRole('button', { name: 'View in Activity' }))
    expect(onViewActivity).toHaveBeenCalledOnce()
  })

  it('marks Wait as not needed when buying today fits', async () => {
    const state = makeState()
    routeApi((_path, data) => compare(state, data))
    render(<Decision {...decisionProps} state={state} request={{ productId: 'backpack' }} />)
    const group = await screen.findByRole('radiogroup', { name: 'Your options' })
    expect(within(group).getByText('Not needed')).toBeTruthy()
    expect(screen.queryByText(/Wait until/)).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Buy now' }).length).toBeGreaterThan(0)
  })

  it('returns focus to the trigger when “Buy today anyway?” closes with Escape', async () => {
    const user = userEvent.setup()
    const state = makeState()
    routeApi((_path, data) => compare(state, data))
    render(<Decision {...decisionProps} state={state} request={{ productId: 'camera' }} />)
    const trigger = (await screen.findAllByRole('button', { name: 'Buy today anyway' }))[0]!
    trigger.focus()
    await user.click(trigger)
    await screen.findByRole('dialog', { name: 'Buy today anyway?' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('prefills the Pay in 4 schedule from the purchase’s local day, not the UTC timestamp', async () => {
    const user = userEvent.setup()
    const state = makeState()
    const paid = purchase(state, {
      status: 'completed',
      completedAt: '2026-10-04T02:00:00Z',
      assessmentDate: TODAY,
    })
    state.purchases = [paid]
    render(
      <ConfirmPlanDialog state={state} purchaseId={paid.id} onClose={vi.fn()} onUpdate={vi.fn()} />,
    )
    await user.click(screen.getByRole('radio', { name: 'Pay in 4' }))
    expect(
      screen.getByRole('spinbutton', { name: 'Payment 1 date' }).getAttribute('aria-valuetext'),
    ).toBe('Sat, Oct 3')
  })

  it('shows confirmed Pay in 4 payments in Coming up and counts the plan on Home', async () => {
    const state = makeState()
    const paid = purchase(state, {
      status: 'completed',
      completedAt: `${TODAY}T15:00:00Z`,
      paymentPlan: {
        product: 'payIn4',
        status: 'confirmed',
        confirmedAt: `${TODAY}T15:05:00Z`,
        instalments: [
          { date: TODAY, amountCents: 8725 },
          { date: '2026-10-17', amountCents: 8725 },
          { date: '2026-10-31', amountCents: 8725 },
          { date: '2026-11-14', amountCents: 8725 },
        ],
      },
    })
    const current = { ...state, purchases: [paid] }
    routeApi((_path, data) => compare(current, data))
    render(
      <Home
        state={current}
        onAsk={vi.fn()}
        onNavigate={vi.fn()}
        onOpenProduct={vi.fn()}
        onEditPlan={vi.fn()}
        onOpenCheckout={vi.fn()}
        onConfirmPlan={vi.fn()}
        onReviewRefund={vi.fn()}
      />,
    )
    // Coming up shows five rows; payment 1, charged at checkout, is never one of them.
    expect(screen.queryByText(/Payment 1 of 4/)).toBeNull()
    expect(screen.getByText('2 running')).toBeTruthy()
  })
})

describe('iteration 2 fixes', () => {
  const homeProps = {
    onAsk: vi.fn(),
    onOpenProduct: vi.fn(),
    onEditPlan: vi.fn(),
    onOpenCheckout: vi.fn(),
    onConfirmPlan: vi.fn(),
    onReviewRefund: vi.fn(),
  }
  it('names an unresolved foreign payment on Home and links to Activity, not the wizard', async () => {
    const user = userEvent.setup()
    const state = makeState('import')
    state.profile.confirmed = true
    const blocker = 'Resolve 1 foreign-currency payment (Lisbon bakery) in Activity.'
    routeApi((_path, data) => ({
      ...compare(state, data),
      recommendation: null,
      missingFields: [blocker],
    }))
    const onNavigate = vi.fn()
    render(<Home {...homeProps} state={state} onNavigate={onNavigate} />)
    await screen.findByRole('heading', { name: blocker })
    expect(screen.queryByText(/Confirm today’s money/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Resolve in Activity' }))
    expect(onNavigate).toHaveBeenCalledWith('activity?focus=fx')
    expect(homeProps.onEditPlan).not.toHaveBeenCalled()
  })

  it('labels options above, at or below the cushion and never recommends nothing', async () => {
    const state = makeState()
    routeApi((_path, data) => compare(state, data))
    render(
      <Decision
        backLabel="Back"
        onBack={vi.fn()}
        onBuy={vi.fn()}
        onSave={vi.fn()}
        onViewActivity={vi.fn()}
        state={state}
        request={{ productId: 'camera' }}
      />,
    )
    const group = await screen.findByRole('radiogroup', { name: 'Your options' })
    expect(within(group).getByText('Below cushion')).toBeTruthy()
    expect(within(group).getByText('Above cushion')).toBeTruthy()
    // Something cheaper is the alternative, not a competing verdict: up to its limit fits today.
    expect(within(group).getByText('Fits today')).toBeTruthy()
    expect(within(group).queryByText('At your limit')).toBeNull()
    // Buy today and Wait name their period minimum as the chart does; Something cheaper its limit.
    expect(within(group).getAllByText('Lowest point')).toHaveLength(2)
    expect(within(group).getByText('Up to')).toBeTruthy()
    expect(within(group).getByText('fits today if you skip the everyday camera')).toBeTruthy()
    expect(within(group).queryByText('Lowest balance')).toBeNull()
  })

  it('marks a bought item in Saved and drops it from Home’s Saved list', () => {
    const state = makeState()
    state.purchases = [purchase(state, { status: 'completed', completedAt: `${TODAY}T15:00:00Z` })]
    // The server marks a saved item bought once its checkout completes.
    state.saved = state.saved!.map((item) =>
      item.productId === 'headphones' ? { ...item, status: 'bought' as const } : item,
    )
    routeApi((_path, data) => compare(state, data))
    const { unmount } = render(
      <Saved
        state={state}
        onOpenDecision={vi.fn()}
        onUpdate={vi.fn()}
        onToast={vi.fn()}
        onOpenCheckout={vi.fn()}
      />,
    )
    expect(screen.getByText('Bought')).toBeTruthy()
    unmount()
    render(<Home {...homeProps} state={state} onNavigate={vi.fn()} />)
    const rail = screen.getByRole('complementary', { name: 'Saved and your plan' })
    expect(within(rail).queryByText('Studio headphones')).toBeNull()
  })

  it('shows nothing as sent to Anthropic while the assistant is off', async () => {
    const user = userEvent.setup()
    const state = makeState('import')
    render(<Ask {...askProps} state={state} />)
    const toggle = screen.getByRole('button', { name: 'Assistant off · what it would see' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await user.click(toggle)
    const details = document.getElementById(toggle.getAttribute('aria-controls')!)!
    expect(within(details).getAllByText('Not sent').length).toBe(3)
    expect(within(details).getByText('Never')).toBeTruthy()
  })
})

describe('iteration 4 fixes', () => {
  it('closes the sample chip details on Escape and returns focus to the chip', async () => {
    const user = userEvent.setup()
    const state = makeState()
    routeApi((path, data) => (path === '/state' ? state : compare(state, data)))
    render(<App />)
    const chip = await screen.findByRole('button', { name: 'Sample: Maya' })
    await user.click(chip)
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    await user.keyboard('{Escape}')
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(chip)
  })

  it('leads the decision with the verdict and makes the bill and payday lines one tab stop', async () => {
    const user = userEvent.setup()
    const state = makeState()
    routeApi((_path, data) => compare(state, data))
    render(
      <Decision
        backLabel="Back"
        onBack={vi.fn()}
        onBuy={vi.fn()}
        onSave={vi.fn()}
        onViewActivity={vi.fn()}
        state={state}
        request={{ productId: 'camera' }}
      />,
    )
    expect(
      await screen.findByRole('heading', { level: 1, name: /^Wait until \w{3}, \w{3} \d+$/ }),
    ).toBeTruthy()
    const group = screen.getByRole('group', { name: /Paydays and big bills/ })
    const lines = within(group).getAllByRole('button')
    expect(lines.filter((line) => line.tabIndex === 0)).toHaveLength(1)
    lines[0]!.focus()
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(lines[1])
    expect(lines[1]!.tabIndex).toBe(0)
  })
})

describe('first screen: the sample and PayPal (third-party feedback)', () => {
  it('explains the sample in one chip and offers the PayPal import from it', async () => {
    const user = userEvent.setup()
    const state = makeState()
    routeApi((path, data) => (path === '/state' ? state : compare(state, data)))
    render(<App />)
    const chip = await screen.findByRole('button', { name: 'Sample: Maya' })
    expect(chip.closest('.show-m, .d')).toBeNull()
    await user.click(chip)
    const details = document.getElementById('env-details')!
    expect(details.textContent).toContain(
      'This is a sample month for a made-up PayPal shopper. No real money moves, and PayPal checkout is simulated.',
    )
    expect(within(details).queryByText('Sample data')).toBeNull()
    expect(within(details).getByText('PayPal checkout: simulated')).toBeTruthy()
    expect(within(details).getByRole('link', { name: 'About this demo' })).toBeTruthy()
    await user.click(within(details).getByRole('button', { name: 'Use your own PayPal activity' }))
    expect(await screen.findByRole('dialog', { name: 'Import PayPal activity' })).toBeTruthy()
    expect(chip.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes the chip details when Tab moves focus out of them', async () => {
    const user = userEvent.setup()
    const state = makeState()
    routeApi((path, data) => (path === '/state' ? state : compare(state, data)))
    render(<App />)
    const chip = await screen.findByRole('button', { name: 'Sample: Maya' })
    await user.click(chip)
    expect(document.getElementById('env-details')!.getAttribute('role')).toBeNull()
    await user.tab()
    expect(document.activeElement?.textContent).toBe('Use your own PayPal activity')
    expect(document.getElementById('env-details')).not.toBeNull()
    await user.tab()
    expect(document.activeElement?.textContent).toBe('About this demo')
    await user.tab()
    expect(document.getElementById('env-details')).toBeNull()
    expect(chip.getAttribute('aria-expanded')).toBe('false')
  })

  it.each([
    [0, 'None'],
    [1, '1 running'],
    [2, '2 running'],
  ])('counts %i running Pay in 4 plans in the sample plan rail', (count, text) => {
    const state = makeState()
    const plan = state.profile.flows.filter((flow) => flow.kind === 'installment')
    const others = state.profile.flows.filter((flow) => flow.kind !== 'installment')
    const copies = Array.from({ length: count }, (_, index) =>
      plan.map((flow) => ({
        ...flow,
        id: `${flow.id}-copy-${index}`,
        planId: `${flow.planId}-${index}`,
      })),
    ).flat()
    state.profile = { ...state.profile, flows: [...others, ...copies] }
    apiMock.mockImplementation(((_path: string, input: unknown) =>
      Promise.resolve(compare(state, input))) as typeof api)
    render(
      <Home
        state={state}
        onAsk={vi.fn()}
        onNavigate={vi.fn()}
        onOpenProduct={vi.fn()}
        onEditPlan={vi.fn()}
        onOpenCheckout={vi.fn()}
        onConfirmPlan={vi.fn()}
        onReviewRefund={vi.fn()}
      />,
    )
    const rail = screen.getByRole('complementary', { name: 'Saved and your plan' })
    expect(within(rail).getByText('Pay in 4 plans').nextElementSibling?.textContent).toBe(text)
  })

  it('names the PayPal sandbox in the chip when checkout runs there', async () => {
    const user = userEvent.setup()
    const state = makeState()
    state.config.paypal = 'sandbox'
    routeApi((path, data) => (path === '/state' ? state : compare(state, data)))
    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'Sample: Maya' }))
    expect(document.getElementById('env-details')!.textContent).toContain(
      'No real money moves, and PayPal checkout runs in the PayPal sandbox.',
    )
  })

  it('labels own data plainly and offers no sample import', async () => {
    const user = userEvent.setup()
    const state = makeState('import')
    routeApi((path, data) => (path === '/state' ? state : compare(state, data)))
    render(<App />)
    const chip = await screen.findByRole('button', { name: 'Your data' })
    await user.click(chip)
    const details = document.getElementById('env-details')!
    expect(details.textContent).toContain('This is the PayPal activity you imported.')
    expect(details.textContent).not.toContain('Maya')
    expect(within(details).queryByRole('button', { name: /own PayPal activity/ })).toBeNull()
    await user.keyboard('{Escape}')
    expect(document.getElementById('env-details')).toBeNull()
    expect(document.activeElement).toBe(chip)
  })

  it('starts Home with the hero, then a slim strip naming the sample', async () => {
    const user = userEvent.setup()
    const state = makeState()
    routeApi((path, data) => (path === '/state' ? state : compare(state, data)))
    render(<App />)
    const hero = await screen.findByRole('region', { name: 'Safe to spend today' })
    const card = screen.getByRole('region', { name: 'Start with your PayPal activity' })
    expect(card.textContent).toContain(
      `This is ${state.profile.name}’s sample plan. Bring your own PayPal activity.`,
    )
    expect(card.textContent).toContain('Raw CSV files aren’t saved')
    // The hero comes first; the PayPal start sits under it.
    expect(hero.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await user.click(within(card).getByText('More'))
    await user.click(within(card).getByRole('button', { name: 'Enter your bills yourself' }))
    await waitFor(() => expect(window.location.hash).toBe('#plan/edit'))
  })

  it('shows no sample intro over imported data', async () => {
    const state = makeState('import')
    routeApi((path, data) => (path === '/state' ? state : compare(state, data)))
    render(<App />)
    await screen.findByRole('region', { name: 'Safe to spend today' })
    expect(screen.queryByText(/sample plan/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Use your own PayPal activity/ })).toBeNull()
  })

  it('keeps the intro without an import action when Home has no import handler', () => {
    const state = makeState()
    apiMock.mockImplementation(((_path: string, input: unknown) =>
      Promise.resolve(compare(state, input))) as typeof api)
    render(
      <Home
        state={state}
        onAsk={vi.fn()}
        onNavigate={vi.fn()}
        onOpenProduct={vi.fn()}
        onEditPlan={vi.fn()}
        onOpenCheckout={vi.fn()}
        onConfirmPlan={vi.fn()}
        onReviewRefund={vi.fn()}
      />,
    )
    expect(screen.getByText(/sample plan\./)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Use your own PayPal activity/ })).toBeNull()
  })
})
