// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'
import { clearSpot, nudgeLine, offerVerdict } from '../src/AgentLauncher'
import { Ask, moodFor, offerStarters, splitVerdict } from '../src/Ask'
import { Decision } from '../src/Decision'
import { Guide } from '../src/Guide'
import { api } from '../src/api'
import { assessPurchase, compareOptions } from '../shared/finance'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type { AppState, ChatReply, ScheduledFlow } from '../shared/types'

// Worth, the guide: the launcher on every screen, the Ask Worth panel it opens, the item a
// Decision or /check screen offers it, and the tighter answer inside it.

vi.mock('../src/paypalSdk', () => ({ loadPayPalSdk: vi.fn() }))
vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>()
  return { ...actual, api: vi.fn() }
})

const TODAY = '2026-10-03'
const apiMock = vi.mocked(api)
type Request = { message: string; context?: { amountCents: number; itemName?: string } }

function makeState(): AppState {
  const seed = createDemoState(TODAY)
  return {
    ...seed,
    profile: { ...seed.profile, aiConsent: false },
    reviews: [],
    today: TODAY,
    products: PRODUCTS,
    saved: [],
    retention: { keep30: false, expiresAt: `${TODAY}T16:00:00.000Z` },
    config: { ai: 'anthropic', paypal: 'demo', model: 'test-provider' },
  }
}
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
function reply(message: string, patch: Partial<ChatReply> = {}): ChatReply {
  return {
    message,
    mode: 'demo',
    intent: 'overview',
    suggestions: [],
    toolCalls: [],
    ...patch,
  }
}
function flow(patch: Partial<ScheduledFlow>): ScheduledFlow {
  return {
    id: patch.name ?? 'flow',
    name: 'Bill',
    amountCents: 1000,
    nextDate: TODAY,
    cadence: 'once',
    kind: 'bill',
    category: 'Bills',
    confirmed: true,
    active: true,
    ...patch,
  }
}
const askProps = {
  visible: true,
  onOpenDecision: vi.fn(),
  onOpenCheckout: vi.fn(),
  onNavigate: vi.fn(),
}

beforeEach(() => {
  apiMock.mockReset()
  window.history.replaceState(null, '', '/')
  try {
    sessionStorage.clear()
  } catch {
    // jsdom always has storage; the app tolerates its absence.
  }
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
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the guide drawing', () => {
  it('is decorative unless titled, and shows each expression', () => {
    const { container, rerender } = render(<Guide expression="warning" size={56} />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.dataset.expression).toBe('warning')
    rerender(<Guide expression="happy" size={56} title="Worth, it fits" />)
    expect(screen.getByRole('img', { name: 'Worth, it fits' })).toBeTruthy()
  })

  it('draws a simpler, thicker figure at 32 px and below so the spectacles still read', () => {
    const lensWidth = (size: number) => {
      const { container, unmount } = render(<Guide size={size} />)
      const lenses = container.querySelector('g[stroke-width] circle')!.parentElement!
      const result = {
        stroke: Number(lenses.getAttribute('stroke-width')),
        arms: lenses.querySelector('path')!.getAttribute('d')!.includes('h-6'),
        curl: container.querySelectorAll('path[fill="#b9effc"]').length,
      }
      unmount()
      return result
    }
    const small = lensWidth(28)
    const launcher = lensWidth(56)
    const large = lensWidth(120)
    expect(small.stroke).toBeGreaterThan(launcher.stroke)
    expect(launcher.stroke).toBeGreaterThan(large.stroke)
    expect(small.arms).toBe(false)
    expect(small.curl).toBe(0)
    expect(large.arms).toBe(true)
    expect(large.curl).toBe(1)
  })
})

describe('the nudge', () => {
  it('names the largest payment due in the next 30 days, from the plan itself', () => {
    const state = makeState()
    state.profile = {
      ...state.profile,
      flows: [
        flow({ name: 'Phone', amountCents: 6500, nextDate: '2026-10-05' }),
        flow({ name: 'Rent', amountCents: 175000, nextDate: '2026-10-21' }),
        flow({ name: 'Salary', amountCents: 390000, nextDate: '2026-10-10', kind: 'income' }),
        flow({ name: 'Far off', amountCents: 900000, nextDate: '2026-12-20' }),
      ],
    }
    expect(nudgeLine(state)).toBe('Rent is due in 18 days. Ask me before you buy.')
  })

  it('asks a plain question when there is no payment or the plan is unconfirmed', () => {
    const state = makeState()
    expect(nudgeLine({ ...state, profile: { ...state.profile, flows: [] } })).toBe(
      'Thinking about buying something? Ask me first.',
    )
    expect(nudgeLine({ ...state, profile: { ...state.profile, confirmed: false } })).toBe(
      'Thinking about buying something? Ask me first.',
    )
  })
})

describe('where the nudge sits', () => {
  it('takes a spot only when it is on screen and covers no control outside the launcher', () => {
    const dock = document.createElement('div')
    const own = document.createElement('button')
    dock.append(own)
    const page = document.createElement('a')
    page.href = '#saved'
    document.body.append(dock, page)
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect
    own.getBoundingClientRect = () => rect(900, 600, 56, 56)
    page.getBoundingClientRect = () => rect(700, 500, 80, 20)
    // Over the page's link: not clear. Over the launcher's own button only: clear.
    expect(clearSpot(rect(650, 480, 260, 80), dock)).toBe(false)
    expect(clearSpot(rect(800, 560, 200, 30), dock)).toBe(true)
    // Off screen to the left: not clear.
    expect(clearSpot(rect(-20, 560, 200, 30), dock)).toBe(false)
    dock.remove()
    page.remove()
  })
})

describe('the tighter answer', () => {
  it('keeps only the verdict’s first sentence as the headline', () => {
    expect(
      splitVerdict(
        'Camera at $1,199.00 would dip below your cushion if you buy it today. The earliest date that fits is Wed, Dec 2.',
      ),
    ).toEqual([
      'Camera at $1,199.00 would dip below your cushion if you buy it today.',
      'The earliest date that fits is Wed, Dec 2.',
    ])
    expect(splitVerdict('It fits today.')).toEqual(['It fits today.', ''])
  })

  it('shows one headline, one comparison link and folds Claude’s picked facts away', async () => {
    const user = userEvent.setup()
    const state = makeState()
    const assessment = assessPurchase(state.profile, [], {
      amountCents: 119900,
      itemName: 'camera',
      today: TODAY,
    })
    apiMock.mockImplementation(((path: string, data: unknown) =>
      Promise.resolve(
        path === '/compare'
          ? compare(state, data)
          : reply('full', {
              intent: 'affordability',
              assessment,
              verdict:
                'Camera at $1,199 would dip below your cushion if you buy it today. The most you could spend today is $440.01.',
              points: [{ id: 'cause', text: 'Apartment rent ($1,450) is due Fri, Oct 16.' }],
            }),
      )) as never)
    render(<Ask {...askProps} state={state} layout="panel" />)
    await user.type(screen.getByRole('textbox', { name: 'Message Worth' }), 'camera $1,199?')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('list', { name: 'Your options' })
    expect(screen.queryByText(/The most you could spend today/)).toBeNull()
    expect(screen.getAllByRole('button', { name: /comparison|Compare/ })).toHaveLength(1)
    const facts = screen.getByRole('button', { name: /Picked for your question \(1\)/ })
    expect(facts.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText(/Apartment rent/).closest('[hidden]')).toBeTruthy()
    await user.click(facts)
    expect(screen.getByText(/Apartment rent/).closest('[hidden]')).toBeNull()
    // The panel has no rail: follow-ups and Start over sit under the answer.
    expect(screen.queryByRole('complementary')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Start over' }))
    expect(screen.getByText('What are you thinking of buying?')).toBeTruthy()
  })
})

describe('the guide’s face', () => {
  it('thinks while Worth works, then shows the latest verdict', () => {
    const state = makeState()
    const tight = assessPurchase(state.profile, [], {
      amountCents: 119900,
      itemName: 'camera',
      today: TODAY,
    })
    const fits = assessPurchase(state.profile, [], {
      amountCents: 1000,
      itemName: 'book',
      today: TODAY,
    })
    const entry = (assessment?: typeof tight) => ({
      role: 'assistant' as const,
      content: '',
      id: 1,
      reply: reply('x', { assessment }),
    })
    expect(moodFor([], true)).toBe('thinking')
    expect(moodFor([entry(tight)], false)).toBe('warning')
    expect(moodFor([entry(fits)], false)).toBe('happy')
    expect(moodFor([entry()], false)).toBe('neutral')
  })
})

describe('the item a screen offers the panel', () => {
  const offer = {
    itemName: 'Everyday camera',
    amountCents: 119900,
    store: 'Larkspur Supply',
    verdict: 'Not today · fits Wed, Oct 21',
  }

  it('sends the item’s name and price as the question’s context, once, and shows what was sent', async () => {
    const user = userEvent.setup()
    const requests: Request[] = []
    apiMock.mockImplementation(((_path: string, data: unknown) => {
      requests.push(data as Request)
      return Promise.resolve(reply(`Answer ${requests.length}`))
    }) as never)
    render(<Ask {...askProps} state={makeState()} layout="panel" offer={offer} />)
    expect(screen.getByText(/Larkspur Supply · Not today · fits Wed, Oct 21/)).toBeTruthy()
    const starters = offerStarters(offer)
    await user.click(screen.getByRole('button', { name: starters[1]!.replace(/'/g, '’') }))
    await screen.findByText('Answer 1')
    expect(requests[0]).toMatchObject({
      message: 'What if I wait a week?',
      context: { amountCents: 119900, itemName: 'Everyday camera' },
    })
    // Store and verdict are shown, never sent: the server works out its own verdict.
    expect(JSON.stringify(requests[0])).not.toMatch(/Larkspur|Not today/)
    expect(screen.getByText('About', { exact: false }).closest('.bubble-user')).toBeTruthy()
    // Used once: the chip is gone and the next question carries the server's own context.
    expect(screen.queryByRole('button', { name: /Don’t ask about/ })).toBeNull()
  })

  it('offers the item again after Start over', async () => {
    const user = userEvent.setup()
    apiMock.mockImplementation((() => Promise.resolve(reply('Answer'))) as never)
    render(<Ask {...askProps} state={makeState()} layout="panel" offer={offer} />)
    await user.click(screen.getByRole('button', { name: 'What if I wait a week?' }))
    await screen.findByText('Answer')
    expect(screen.queryByRole('button', { name: 'Don’t ask about Everyday camera' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Start over' }))
    expect(screen.getByRole('button', { name: 'Don’t ask about Everyday camera' })).toBeTruthy()
    expect(screen.getByText('Ask about the Everyday camera, or anything else.')).toBeTruthy()
  })

  it('can be removed before asking, and then nothing about it is sent', async () => {
    const user = userEvent.setup()
    const requests: Request[] = []
    apiMock.mockImplementation(((_path: string, data: unknown) => {
      requests.push(data as Request)
      return Promise.resolve(reply('Answer'))
    }) as never)
    render(<Ask {...askProps} state={makeState()} layout="panel" offer={offer} />)
    await user.click(screen.getByRole('button', { name: 'Don’t ask about Everyday camera' }))
    await user.type(screen.getByRole('textbox', { name: 'Message Worth' }), 'What is due?')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('Answer')
    expect(requests[0]!.context).toBeUndefined()
  })

  it('is offered by Decision with the item and verdict, naming no store, while it is on screen', async () => {
    const state = makeState()
    apiMock.mockImplementation(((_path: string, data: unknown) =>
      Promise.resolve(compare(state, data))) as never)
    const onOffer = vi.fn()
    const { unmount } = render(
      <Decision
        state={state}
        request={{ productId: 'camera' }}
        backLabel="Back"
        onBack={vi.fn()}
        onBuy={vi.fn()}
        onSave={vi.fn()}
        onViewActivity={vi.fn()}
        onOffer={onOffer}
      />,
    )
    const c = compare(state, { productId: 'camera' })
    await waitFor(() =>
      expect(onOffer).toHaveBeenLastCalledWith({
        itemName: 'Everyday camera',
        amountCents: 119900,
        store: undefined,
        verdict: offerVerdict(c),
      }),
    )
    expect(offerVerdict(c)).toMatch(/^Not today/)
    unmount()
    expect(onOffer).toHaveBeenLastCalledWith(undefined)
  })
})

describe('the launcher and panel in the app', () => {
  function routeApp(state: AppState) {
    apiMock.mockImplementation(((path: string, data: unknown) =>
      Promise.resolve(
        path === '/state'
          ? state
          : path === '/compare'
            ? compare(state, data)
            : reply(`Answer to ${(data as Request).message}`),
      )) as never)
  }

  it('opens a non-modal panel from the launcher, focuses the composer and returns focus on Escape', async () => {
    const user = userEvent.setup()
    routeApp(makeState())
    render(<App />)
    await screen.findByRole('navigation', { name: 'Main' })
    const launcher = document.querySelector<HTMLElement>('[data-tour="guide"]')!
    expect(launcher.getAttribute('aria-label')).toBe('Ask Worth')
    expect(launcher.getAttribute('aria-expanded')).toBe('false')
    await user.click(launcher)
    const panel = screen.getByRole('dialog', { name: 'Ask Worth' })
    expect(panel.getAttribute('aria-modal')).toBe('false')
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(panel).getByRole('textbox', { name: 'Message Worth' }),
      ),
    )
    // The page behind stays usable.
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
    // It overlaps the page: nothing behind it is restyled or moved. No second banner either.
    expect(document.querySelector('.panel-open')).toBeNull()
    expect(document.querySelector('main')!.getAttribute('style')).toBeNull()
    expect(within(panel).queryByRole('banner')).toBeNull()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Ask Worth' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(launcher))
  })

  it('keeps the conversation across navigation, and opens over the current screen from #ask', async () => {
    const user = userEvent.setup()
    routeApp(makeState())
    render(<App />)
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    await user.click(within(nav).getByRole('button', { name: 'Ask Worth' }))
    await user.type(screen.getByRole('textbox', { name: 'Message Worth' }), 'Hello there')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('Answer to Hello there')
    await user.click(screen.getByRole('button', { name: 'Close Ask Worth' }))
    act(() => {
      window.location.hash = 'activity'
    })
    await waitFor(() => expect(window.location.hash).toBe('#activity'))
    // An old link to #ask opens the panel and leaves the screen behind as it was.
    act(() => {
      window.location.hash = 'ask'
    })
    await screen.findByRole('dialog', { name: 'Ask Worth' })
    expect(window.location.hash).toBe('#activity')
    expect(screen.getByText('Answer to Hello there')).toBeTruthy()
  })

  it('opens over Home on a first load at #ask', async () => {
    window.history.replaceState(null, '', '/#ask')
    routeApp(makeState())
    render(<App />)
    await screen.findByRole('dialog', { name: 'Ask Worth' })
    expect(window.location.hash).toBe('')
  })

  it('shows the nudge once per session, from the plan', async () => {
    const state = makeState()
    routeApp(state)
    const { unmount } = render(<App />)
    const line = await screen.findByText(nudgeLine(state), {}, { timeout: 3000 })
    const nudge = line.closest<HTMLElement>('.agent-nudge')!
    expect(nudge.getAttribute('role')).toBe('status')
    await userEvent.setup().click(within(nudge).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(nudgeLine(state))).toBeNull()
    unmount()
    render(<App />)
    await screen.findByRole('navigation', { name: 'Main' })
    await new Promise((resolve) => setTimeout(resolve, 1800))
    expect(screen.queryByText(nudgeLine(state))).toBeNull()
  })
})

describe('a question back in the panel (first-glance #6)', () => {
  it('offers its days as buttons and no "Needs an answer" tag', async () => {
    const user = userEvent.setup()
    const requests: Request[] = []
    apiMock.mockImplementation(((_path: string, data: unknown) => {
      requests.push(data as Request)
      return Promise.resolve(
        requests.length === 1
          ? reply('Which day do you mean: tomorrow or Sun, Nov 15?', {
              intent: 'clarify',
              suggestions: ['Tomorrow', 'Sun, Nov 15'],
            })
          : reply('Checked.'),
      )
    }) as never)
    render(<Ask {...askProps} state={makeState()} layout="panel" />)
    await user.type(
      screen.getByRole('textbox', { name: 'Message Worth' }),
      'A $600 TV this weekend?',
    )
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('Which day do you mean: tomorrow or Sun, Nov 15?')
    expect(screen.queryByText('Needs an answer')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Sun, Nov 15' }))
    await screen.findByText('Checked.')
    expect(requests[1]!.message).toBe('Sun, Nov 15')
  })
})
