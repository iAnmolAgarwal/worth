// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'
import { Ask } from '../src/Ask'
import { Checkout } from '../src/Checkout'
import { Home } from '../src/Home'
import { FundsDialog, migratePlanned, Saved, Settings } from '../src/Saved'
import { api, ApiError } from '../src/api'
import { assessPurchase, compareOptions } from '../shared/finance'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type { AppState, ChatReply, Purchase, SavedItem } from '../shared/types'

// Phase 5 in the interface: saved plans checked on return, "Save for later" for any assessed item,
// retention and the demo clock in Settings, mobile reachability and checkout honesty.

vi.mock('../src/paypalSdk', () => ({ loadPayPalSdk: vi.fn() }))
vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>()
  return { ...actual, api: vi.fn() }
})

const TODAY = '2026-10-23'
const apiMock = vi.mocked(api)
function routeApi(route: (path: string, data?: unknown) => unknown) {
  apiMock.mockImplementation(
    (path, data) => Promise.resolve().then(() => route(path, data)) as Promise<never>,
  )
}
const item = (patch: Partial<SavedItem>): SavedItem => ({
  id: 'saved-camera',
  kind: 'catalog',
  productId: 'camera',
  name: 'Everyday camera',
  amountCents: 119900,
  createdAt: '2026-10-03T12:00:00.000Z',
  status: 'active',
  ...patch,
})
/** Maya on the wait date, before today's funds are confirmed: the snapshot is from Oct 3. */
function makeState(saved: SavedItem[] = []): AppState {
  const seed = createDemoState('2026-10-03')
  return {
    ...seed,
    profile: { ...seed.profile, aiConsent: false, userEdited: false },
    reviews: [],
    today: TODAY,
    products: PRODUCTS,
    saved,
    wishlist: [],
    retention: { keep30: false, expiresAt: '2026-10-24T12:00:00.000Z' },
    demoClock: { today: TODAY },
    fundsProjection: { cents: 284001, from: '2026-10-03' },
    config: { ai: 'demo', paypal: 'demo' },
  }
}
/** The state after "Confirm today's funds": a snapshot dated today. */
function confirmed(state: AppState): AppState {
  return {
    ...state,
    profile: {
      ...state.profile,
      balanceCents: 284001,
      snapshotDate: TODAY,
      version: state.profile.version + 1,
      flows: state.profile.flows.map((flow) =>
        flow.cadence === 'once' && flow.nextDate < TODAY
          ? { ...flow, paidOn: flow.nextDate }
          : flow,
      ),
    },
    fundsProjection: undefined,
  }
}
function compare(state: AppState, data: unknown) {
  const input = data as { productId?: string; amountCents?: number; itemName?: string }
  const product = PRODUCTS.find((p) => p.id === input.productId)
  return compareOptions(state.profile, state.purchases, {
    amountCents: product?.priceCents ?? input.amountCents!,
    itemName: product?.name ?? input.itemName,
    today: state.today,
  })
}
const savedProps = {
  onOpenDecision: vi.fn(),
  onUpdate: vi.fn(),
  onToast: vi.fn(),
  onOpenCheckout: vi.fn(),
}

beforeEach(() => {
  apiMock.mockReset()
  window.history.replaceState(null, '', '/')
  vi.stubGlobal('scrollTo', vi.fn())
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
  Element.prototype.scrollIntoView = vi.fn()
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a saved wait plan on return', () => {
  it('asks for today’s funds first, then shows the fresh check and the PayPal button', async () => {
    const user = userEvent.setup()
    let state = makeState([item({ option: 'wait', waitDate: TODAY, status: 'ready' })])
    const calls: string[] = []
    const prepared: Purchase = {
      id: 'p1',
      productId: 'camera',
      name: 'Everyday camera',
      amountCents: 119900,
      currency: 'USD',
      mode: 'demo',
      status: 'created',
      createdAt: `${TODAY}T12:00:00Z`,
      profileVersion: 3,
      assessmentDate: TODAY,
    }
    routeApi((path, data) => {
      calls.push(path)
      if (path === '/funds/confirm') {
        expect(data).toMatchObject({ balanceCents: 284001 })
        state = confirmed(state)
        return state
      }
      if (path === '/compare') return compare(state, data)
      if (path === '/saved/saved-camera/prepare') return { purchase: prepared, state }
      throw new Error(`Unexpected ${path}`)
    })
    const onUpdate = vi.fn((next: AppState) => {
      state = next
    })
    const onOpenCheckout = vi.fn()
    const view = render(
      <Saved {...savedProps} state={state} onUpdate={onUpdate} onOpenCheckout={onOpenCheckout} />,
    )
    const plan = screen.getByRole('region', { name: 'Everyday camera: your saved plan' })
    expect(
      within(plan).getByText('Your plan suggests this may fit now — confirm today’s funds'),
    ).toBeTruthy()
    // Nothing can be bought before funds are confirmed.
    expect(within(plan).queryByRole('button', { name: 'Buy with PayPal' })).toBeNull()
    await user.click(within(plan).getByRole('button', { name: 'Confirm today’s funds' }))
    const dialog = await screen.findByRole('dialog', { name: 'Confirm today’s funds' })
    expect(
      (within(dialog).getByLabelText(/^Money available today/) as HTMLInputElement).value,
    ).toBe('2840.01')
    expect(within(dialog).getByText(/Maya’s sample plan projects this/)).toBeTruthy()
    expect(
      (within(dialog).getByRole('checkbox', { name: /Laptop · Pay in 4/ }) as HTMLInputElement)
        .checked,
    ).toBe(true)
    await user.click(within(dialog).getByRole('button', { name: 'Confirm and check again' }))
    view.rerender(
      <Saved {...savedProps} state={state} onUpdate={onUpdate} onOpenCheckout={onOpenCheckout} />,
    )
    await screen.findByText(/Checked just now: buying today keeps your \$300\.00 cushion/)
    expect(screen.getByText('Fresh check: this fits today')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Buy with PayPal' }))
    await waitFor(() => expect(onOpenCheckout).toHaveBeenCalledWith(prepared))
    expect(calls.indexOf('/funds/confirm')).toBeLessThan(
      calls.indexOf('/saved/saved-camera/prepare'),
    )
  })

  // Pre-merge judge finding 2: on real data nothing that changes the money starts ticked.
  it('starts every "already in this amount" box unticked on imported data', async () => {
    const user = userEvent.setup()
    const sample = makeState()
    const state: AppState = {
      ...sample,
      demoClock: undefined,
      fundsProjection: undefined,
      profile: { ...sample.profile, source: 'import' },
      purchases: [
        {
          id: 'bought-1',
          productId: 'headphones',
          name: 'Studio headphones',
          amountCents: 34900,
          currency: 'USD',
          mode: 'sandbox',
          status: 'completed',
          createdAt: '2026-10-20T12:00:00Z',
          completedAt: '2026-10-20T12:05:00Z',
          profileVersion: 1,
          assessmentDate: '2026-10-20',
        },
      ],
    }
    const posted: unknown[] = []
    routeApi((path, data) => {
      if (path !== '/funds/confirm') throw new Error(`Unexpected ${path}`)
      posted.push(data)
      return state
    })
    const onConfirmed = vi.fn()
    render(<FundsDialog state={state} onClose={vi.fn()} onConfirmed={onConfirmed} />)
    const dialog = screen.getByRole('dialog', { name: 'Confirm today’s funds' })
    const amount = within(dialog).getByLabelText(/^Money available today/) as HTMLInputElement
    // A stale real snapshot is never offered as today's amount.
    expect(amount.value).toBe('')
    const boxes = within(dialog).getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.map((box) => box.checked)).toEqual([false, false])
    expect(within(dialog).queryByText(/sample projection/)).toBeNull()
    await user.type(amount, '1,250.00')
    await user.click(within(dialog).getByRole('button', { name: 'Confirm and check again' }))
    await waitFor(() => expect(onConfirmed).toHaveBeenCalled())
    expect(posted).toEqual([{ balanceCents: 125000, paidFlowIds: [], reflectedPurchaseIds: [] }])
  })

  it('starts unticked on a hand-edited sample plan, even with a projection', () => {
    const sample = makeState()
    const state: AppState = { ...sample, profile: { ...sample.profile, userEdited: true } }
    render(<FundsDialog state={state} onClose={vi.fn()} onConfirmed={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'Confirm today’s funds' })
    const boxes = within(dialog).getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.map((box) => box.checked)).toEqual([false])
    expect(within(dialog).queryByText(/Ticked because/)).toBeNull()
  })

  it('never offers checkout for an assessment-only item', async () => {
    const user = userEvent.setup()
    let state = makeState([
      item({
        id: 'saved-bike',
        kind: 'custom',
        productId: undefined,
        name: 'Road bike',
        amountCents: 64900,
        option: 'wait',
        waitDate: TODAY,
        status: 'ready',
      }),
    ])
    routeApi((path, data) => {
      if (path === '/funds/confirm') return (state = confirmed(state))
      if (path === '/compare') return compare(state, data)
      throw new Error(`Unexpected ${path}`)
    })
    const view = render(<Saved {...savedProps} state={state} />)
    expect(screen.getAllByText('Road bike').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Assessment only — no checkout in Worth/).length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: 'Confirm today’s funds' }))
    await user.click(await screen.findByRole('button', { name: 'Confirm and check again' }))
    view.rerender(<Saved {...savedProps} state={state} />)
    await screen.findByText(/Checked just now/)
    expect(screen.queryByRole('button', { name: 'Buy with PayPal' })).toBeNull()
  })

  // Pre-merge judge finding 11a: one "Confirm today's funds" on Home, on the plan's own card.
  it('asks for today’s funds once on Home when a saved plan is ready', async () => {
    routeApi((_path, data) => compare(makeState(), data))
    const state = makeState([item({ option: 'wait', waitDate: TODAY, status: 'ready' })])
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
    await screen.findByText(/once this is done, from your saved plan below/)
    expect(screen.getAllByRole('button', { name: 'Confirm today’s funds' })).toHaveLength(1)
  })

  it('shows the ready prompt on Home, under the hero', () => {
    routeApi((_path, data) => compare(makeState(), data))
    const state = makeState([item({ option: 'wait', waitDate: TODAY, status: 'ready' })])
    const onNavigate = vi.fn()
    render(
      <Home
        state={state}
        onAsk={vi.fn()}
        onNavigate={onNavigate}
        onOpenProduct={vi.fn()}
        onEditPlan={vi.fn()}
        onOpenCheckout={vi.fn()}
        onConfirmPlan={vi.fn()}
        onReviewRefund={vi.fn()}
      />,
    )
    const prompt = screen.getByRole('region', {
      name: 'Your plan suggests this may fit now — confirm today’s funds',
    })
    within(prompt).getByRole('button', { name: 'Confirm today’s funds' }).click()
    expect(onNavigate).toHaveBeenCalledWith('saved?check=saved-camera')
    // The hero comes first on the page; the prompt follows it.
    const hero = document.querySelector('section')!
    expect(hero.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(document.querySelector('.chip-suggest')).toBeNull()
  })
})

describe('Save for later in Ask Worth', () => {
  it('saves any assessed item as an assessment only, with the wait date', async () => {
    const user = userEvent.setup()
    const state = { ...makeState(), today: '2026-10-03', demoClock: undefined }
    state.profile = { ...state.profile, snapshotDate: '2026-10-03' }
    const reply: ChatReply = {
      message: 'full',
      mode: 'demo',
      intent: 'affordability',
      assessment: assessPurchase(state.profile, [], {
        amountCents: 119900,
        itemName: 'Road bike',
        today: '2026-10-03',
      }),
      verdict: 'Road bike at $1,199 would dip below your cushion if you buy it today.',
      interpretation: {
        items: [{ name: 'Road bike', amountCents: 119900, quantity: 1 }],
        amountCents: 119900,
        currency: 'USD',
        date: '2026-10-03',
        dateLabel: 'today',
        dateSource: 'default',
        option: 'check',
        source: 'local',
      },
      suggestions: [],
      toolCalls: [],
    }
    routeApi((path, data) => {
      if (path === '/compare') return compare(state, data)
      if (path === '/chat') return reply
      throw new Error(`Unexpected ${path}`)
    })
    const onSave = vi.fn(async () =>
      item({ kind: 'custom', name: 'Road bike', waitDate: '2026-10-23', productId: undefined }),
    )
    render(
      <Ask
        state={state}
        visible
        onOpenDecision={vi.fn()}
        onOpenCheckout={vi.fn()}
        onNavigate={vi.fn()}
        onSave={onSave}
      />,
    )
    await user.type(screen.getByRole('textbox', { name: 'Message Worth' }), 'A $1,199 road bike?')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await user.click(await screen.findByRole('button', { name: 'Save for Fri, Oct 23' }))
    expect(onSave).toHaveBeenCalledWith(
      { kind: 'custom', name: 'Road bike', amountCents: 119900 },
      { waitDate: '2026-10-23' },
    )
    await screen.findByText(/Saved for Fri, Oct 23/)
    expect(screen.getByText('Assessment only — no checkout in Worth.')).toBeTruthy()
  })

  it('labels a store price and remembers earlier items', async () => {
    const user = userEvent.setup()
    const state = { ...makeState(), today: '2026-10-03', demoClock: undefined }
    state.profile = { ...state.profile, snapshotDate: '2026-10-03' }
    const bodies: { items?: unknown }[] = []
    const answer = (name: string, cents: number, catalog: boolean): ChatReply => ({
      message: 'full',
      mode: 'demo',
      intent: 'affordability',
      assessment: assessPurchase(state.profile, [], {
        amountCents: cents,
        itemName: name,
        today: '2026-10-03',
      }),
      verdict: 'verdict',
      interpretation: {
        items: [
          {
            name,
            amountCents: cents,
            quantity: 1,
            ...(catalog ? { priceSource: 'catalog' as const } : {}),
          },
        ],
        amountCents: cents,
        currency: 'USD',
        date: '2026-10-03',
        dateLabel: 'today',
        dateSource: 'default',
        option: 'check',
        source: 'local',
      },
      suggestions: [],
      toolCalls: [],
      // The server signs each assessed item; the browser sends it back unchanged.
      remember: { amountCents: cents, itemName: name, tag: `signed-${name}` },
    })
    const replies = [answer('Everyday camera', 119900, true), answer('headphones', 34900, false)]
    routeApi((path, data) => {
      if (path === '/compare') return compare(state, data)
      bodies.push(data as { items?: unknown })
      return replies.shift()
    })
    render(
      <Ask
        state={state}
        visible
        onOpenDecision={vi.fn()}
        onOpenCheckout={vi.fn()}
        onNavigate={vi.fn()}
      />,
    )
    const box = screen.getByRole('textbox', { name: 'Message Worth' })
    await user.type(box, 'Can I afford the camera?')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    const chip = await screen.findByRole('group', { name: 'How Worth read your question' })
    expect(chip.textContent).toContain('Everyday camera · $1,199.00 (listed price) · today')
    await user.type(box, 'And $349 headphones?')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1]!.items).toEqual([
      { amountCents: 119900, itemName: 'Everyday camera', tag: 'signed-Everyday camera' },
    ])
  })
})

describe('who is who: Worth is the shopper’s side, Larkspur Supply is the demo store', () => {
  it('says at checkout that the payment goes to the demo store, not Worth', () => {
    routeApi(() => new Promise(() => undefined))
    render(
      <Checkout
        state={makeState()}
        product={PRODUCTS[0]!}
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        onViewActivity={vi.fn()}
        onConfirmPlan={vi.fn()}
        onEditPlan={vi.fn()}
      />,
    )
    expect(screen.getByText('Payment to Larkspur Supply')).toBeTruthy()
    expect(screen.getByText(/Worth sells nothing and never holds your money/)).toBeTruthy()
  })

  it('keeps the demo store out of Saved: items read as what they are, not where they are sold', () => {
    render(<Saved {...savedProps} state={makeState()} />)
    expect(screen.getByRole('heading', { name: 'More to check' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/Larkspur|Demo store/)
  })
})

describe('checkout honesty (fix #9)', () => {
  it('drops the PayPal note once the checkout is cancelled', () => {
    const state = makeState()
    const cancelled: Purchase = {
      id: 'p1',
      productId: 'headphones',
      name: 'Studio headphones',
      amountCents: 34900,
      currency: 'USD',
      mode: 'sandbox',
      status: 'cancelled',
      createdAt: `${TODAY}T12:00:00Z`,
      profileVersion: 1,
      assessmentDate: TODAY,
      lastError: { code: 'PAYPAL_CANCELLED', message: 'You cancelled in PayPal.' },
    }
    state.purchases = [cancelled]
    routeApi(() => new Promise(() => undefined))
    render(
      <Checkout
        state={state}
        product={PRODUCTS[0]!}
        purchaseId="p1"
        returnedCancelled
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        onViewActivity={vi.fn()}
        onConfirmPlan={vi.fn()}
        onEditPlan={vi.fn()}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Checkout cancelled' })).toBeTruthy()
    expect(
      screen.queryByText(/You left PayPal|You closed PayPal|You cancelled in PayPal/),
    ).toBeNull()
  })

  it('says when an open checkout is already in room to spend', async () => {
    const state = { ...makeState(), today: '2026-10-03', demoClock: undefined }
    state.profile = { ...state.profile, snapshotDate: '2026-10-03' }
    state.purchases = [
      {
        id: 'p1',
        productId: 'headphones',
        name: 'Studio headphones',
        amountCents: 34900,
        currency: 'USD',
        mode: 'sandbox',
        status: 'created',
        createdAt: '2026-10-03T12:00:00Z',
        profileVersion: 1,
        assessmentDate: '2026-10-03',
      },
    ]
    routeApi((_path, data) => compare(state, data))
    const onOpenCheckout = vi.fn()
    render(
      <Home
        state={state}
        onAsk={vi.fn()}
        onNavigate={vi.fn()}
        onOpenProduct={vi.fn()}
        onEditPlan={vi.fn()}
        onOpenCheckout={onOpenCheckout}
        onConfirmPlan={vi.fn()}
        onReviewRefund={vi.fn()}
      />,
    )
    expect(
      await screen.findByText(/Includes the \$349 studio headphones checkout you haven’t finished/),
    ).toBeTruthy()
    screen.getByRole('button', { name: /Review the Studio headphones checkout/ }).click()
    expect(onOpenCheckout).toHaveBeenCalledWith(state.purchases[0])
  })
})

describe('settings, demo clock and mobile reach', () => {
  it('offers 30-day retention off by default, and the demo clock with the video replay', async () => {
    const user = userEvent.setup()
    const state = makeState()
    const calls: [string, unknown][] = []
    routeApi((path, data) => {
      // Connect an agent reads its token list on open; that read is not under test here.
      if (path !== '/agent-tokens') calls.push([path, data])
      return state
    })
    render(
      <Settings
        state={state}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
        onEditPlan={vi.fn()}
        onImport={vi.fn()}
      />,
    )
    const keep = screen.getByRole('switch', { name: 'Keep my plan on this device for 30 days' })
    expect(keep.getAttribute('aria-checked')).toBe('false')
    // The deletion time is real time, even while the clock moves Maya's day (finding 11c).
    expect(screen.getByText(/deleted on .*\(real time\)/)).toBeTruthy()
    await user.click(keep)
    await user.click(screen.getByRole('button', { name: 'Video replay · Sat, Oct 3, 2026' }))
    expect(calls).toEqual([
      ['/retention', { keep30: true }],
      ['/demo-clock', { preset: 'video' }],
    ])
  })

  it('keeps the demo clock away from imported data', () => {
    const state = makeState()
    state.profile = { ...state.profile, source: 'import' }
    render(
      <Settings
        state={state}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
        onEditPlan={vi.fn()}
        onImport={vi.fn()}
      />,
    )
    expect(screen.getByText(/The demo clock works only on the sample persona/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Video replay/ })).toBeNull()
  })

  it('shows no demo clock in Settings unless a replay is running', () => {
    const state = { ...makeState(), demoClock: undefined }
    render(
      <Settings
        state={state}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
        onEditPlan={vi.fn()}
        onImport={vi.fn()}
      />,
    )
    expect(screen.queryByRole('heading', { name: 'Demo clock' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Video replay/ })).toBeNull()
  })

  it('offers no replay in the sample chip details', async () => {
    const user = userEvent.setup()
    const state = { ...makeState(), demoClock: undefined }
    routeApi((path) => (path === '/compare' ? compare(state, { amountCents: 0 }) : state))
    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'Sample: Maya' }))
    expect(screen.getByRole('link', { name: 'About this demo' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /video scenario/i })).toBeNull()
  })

  it('puts Saved in the tab bar and starts the replay from ?replay=video', async () => {
    const state = makeState()
    const calls: string[] = []
    routeApi((path) => {
      calls.push(path)
      if (path === '/compare') return compare(state, { amountCents: 0 })
      return state
    })
    window.history.replaceState(null, '', '/?replay=video')
    render(<App />)
    const tabs = await screen.findByRole('navigation', { name: 'Tab bar' })
    expect(within(tabs).getByRole('link', { name: 'Saved' })).toBeTruthy()
    await waitFor(() => expect(calls).toContain('/demo-clock'))
    expect(window.location.search).toBe('')
    expect(await screen.findByText(/Demo clock:/)).toBeTruthy()
  })
})

describe('moving the old browser wait dates (G5-6)', () => {
  it('sends them once and clears them', async () => {
    localStorage.setItem('worth:planned', JSON.stringify({ camera: '2026-10-23' }))
    const state = makeState()
    routeApi((path, data) => {
      expect(path).toBe('/saved/migrate')
      expect(data).toEqual({ planned: { camera: '2026-10-23' } })
      return { moved: 1, state }
    })
    const onUpdate = vi.fn()
    await migratePlanned(onUpdate)
    expect(onUpdate).toHaveBeenCalledWith(state)
    expect(localStorage.getItem('worth:planned')).toBeNull()
  })

  it('clears a malformed value without sending it, and keeps it after a network failure', async () => {
    localStorage.setItem('worth:planned', '{not json')
    await migratePlanned(vi.fn())
    expect(apiMock).not.toHaveBeenCalled()
    expect(localStorage.getItem('worth:planned')).toBeNull()
    localStorage.setItem('worth:planned', '["camera"]')
    await migratePlanned(vi.fn())
    expect(localStorage.getItem('worth:planned')).toBeNull()
    localStorage.setItem('worth:planned', '{"camera":"2026-10-23"}')
    routeApi(() => {
      throw new ApiError('offline', 0, 'NETWORK')
    })
    await migratePlanned(vi.fn())
    expect(localStorage.getItem('worth:planned')).not.toBeNull()
  })
})
