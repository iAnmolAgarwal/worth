// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'
import { decisionRequestFrom } from '../src/contract'
import { Decision } from '../src/Decision'
import { Saved, Settings } from '../src/Saved'
import { api } from '../src/api'
import { belowWords, fitStatus, lowerName, lowestSentence } from '../src/engine'
import { nameInSentence } from '../shared/text'
import { payIn4Lines } from '../src/payIn4Text'
import { compareOptions } from '../shared/finance'
import { ALEX_DEMO_DAY, ALEX_RETURN_DAY, createCameraScenario, PRODUCTS } from '../shared/seed'
import type { AppState, DemoPreset, Purchase } from '../shared/types'

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
    expect((await screen.findByText('Alex’s sample month')).parentElement!.textContent).toBe(
      'Alex’s sample month, as of Fri, Nov 13, 2026 (not today’s date).',
    )
    expect(screen.queryByRole('button', { name: /Back to (today|the sample day)/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start the sample again' })).toBeNull()
    expect(document.body.textContent).not.toMatch(/Maya/)
  })

  it('offers "Start the sample again" once Alex’s plan was edited', async () => {
    const user = userEvent.setup()
    const state = alexState()
    state.profile = { ...state.profile, userEdited: true, balanceCents: 300000 }
    routeApi((path, data) =>
      path === '/state' ? state : path === '/demo-clock' ? alexState() : compare(state, data),
    )
    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'Start the sample again' }))
    expect(apiMock).toHaveBeenCalledWith('/demo-clock', { preset: 'demo' })
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

describe('item names inside a sentence', () => {
  it('lowers a common noun but keeps a proper name such as the Halden X5', () => {
    expect(lowerName('Everyday camera')).toBe('everyday camera')
    expect(lowerName('Halden X5')).toBe('Halden X5')
    expect(lowerName('MacBook Pro 14-inch')).toBe('MacBook Pro 14-inch')
  })
})

describe('nameInSentence, shared with the server', () => {
  it('keeps a word with a digit in it as written', () => {
    expect(nameInSentence('Halden X5')).toBe('Halden X5')
    expect(nameInSentence('Lumen x5 lens')).toBe('Lumen x5 lens')
    expect(nameInSentence('Desk chair')).toBe('desk chair')
    expect(nameInSentence('Laptop · Pay in 4')).toBe('laptop · Pay in 4')
  })
})

describe('lowerName keeps a plan payment in sentence case', () => {
  it('tests only the part before " · "', () => {
    expect(lowerName('Laptop · Pay in 4')).toBe('laptop · Pay in 4')
    expect(lowerName('Desk chair · Pay in 4 payment 2 of 4')).toBe(
      'desk chair · Pay in 4 payment 2 of 4',
    )
    expect(lowerName('Halden X5 · Pay in 4 payment 2 of 4')).toBe(
      'Halden X5 · Pay in 4 payment 2 of 4',
    )
  })
})

describe('the Pay in 4 card on Alex’s camera', () => {
  it('names the first dip, the lowest point and the payment that sets it', () => {
    const { profile } = createCameraScenario(ALEX_DEMO_DAY)
    const c = compareOptions(profile, [], {
      amountCents: 189900,
      itemName: 'Halden X5',
      today: ALEX_DEMO_DAY,
      payIn4Eligible: true,
    })
    if (!c.payIn4.available) throw new Error('Pay in 4 is in range for $1,899')
    expect(payIn4Lines(c.payIn4, c.cushionCents)).toEqual({
      lead: 'With Pay in 4, your balance would first go below your cushion on Sun, Nov 29',
      low: 'Lowest point $222.76 on Mon, Nov 30, before payday. Payment 2 ($474.75) lands about Fri, Nov 27.',
    })
  })
})

describe('Saved says whether each item fits', () => {
  it('reads Fits today, Fits <wait day> or Over by $X from the engine', () => {
    const state = alexState()
    expect(fitStatus(state, 34900)).toEqual({ tone: 'ok', text: 'Fits today' })
    expect(fitStatus(state, 189900)).toEqual({ tone: 'sug', text: 'Fits Tue, Dec 15' })
    const over = fitStatus(state, 900000)!
    expect(over.tone).toBe('bad')
    expect(over.text).toBe('Over by $8,127.74')
  })

  it('leaves an item’s own open checkout out of its status, and counts it once for the rest', () => {
    const state = alexState(ALEX_RETURN_DAY, 'demo-dec15')
    const camera = { productId: 'halden-x5', itemName: 'Halden X5' }
    const headphones = { productId: 'headphones', itemName: 'Studio headphones' }
    expect(fitStatus(state, 189900, camera)).toEqual({ tone: 'ok', text: 'Fits today' })
    expect(fitStatus(state, 34900, headphones)).toEqual({ tone: 'ok', text: 'Fits today' })
    // Buy with PayPal on the camera: its $1,899 is held while the checkout is open.
    const hold: Purchase = {
      id: 'p-camera',
      productId: 'halden-x5',
      name: 'Halden X5',
      amountCents: 189900,
      currency: 'USD',
      mode: 'sandbox',
      status: 'pending',
      createdAt: '2026-12-15T10:00:00.000Z',
      profileVersion: state.profile.version,
      assessmentDate: ALEX_RETURN_DAY,
    }
    const open = { ...state, purchases: [...state.purchases, hold] }
    // The camera is what the checkout pays for: it still fits.
    expect(fitStatus(open, 189900, camera)).toEqual({ tone: 'ok', text: 'Fits today' })
    // The headphones are judged with the camera's $1,899 reserved once: $158.78 of room is left.
    const engine = compareOptions(open.profile, open.purchases, {
      amountCents: 34900,
      today: ALEX_RETURN_DAY,
    })
    expect(engine.spendLess.maxPriceCents).toBe(15878)
    expect(fitStatus(open, 34900, headphones)).toEqual({ tone: 'bad', text: 'Over by $190.22' })
    // Cancelling the checkout releases the hold: both are back to their normal status.
    const cancelled = {
      ...state,
      purchases: [...state.purchases, { ...hold, status: 'cancelled' as const }],
    }
    expect(fitStatus(cancelled, 189900, camera)).toEqual({ tone: 'ok', text: 'Fits today' })
    expect(fitStatus(cancelled, 34900, headphones)).toEqual({ tone: 'ok', text: 'Fits today' })
  })

  it('shows it on each saved card as the main status', () => {
    const state = alexState()
    state.saved = [
      {
        id: 'cam',
        kind: 'catalog',
        productId: 'halden-x5',
        name: 'Halden X5',
        amountCents: 189900,
        createdAt: '2026-11-13T12:00:00Z',
        status: 'active',
      },
      {
        id: 'hp',
        kind: 'catalog',
        productId: 'headphones',
        name: 'Studio headphones',
        amountCents: 34900,
        createdAt: '2026-11-13T11:00:00Z',
        status: 'active',
      },
    ]
    render(
      <Saved
        state={state}
        onOpenDecision={vi.fn()}
        onOpenCheckout={vi.fn()}
        onUpdate={vi.fn()}
        onToast={vi.fn()}
      />,
    )
    expect(screen.getByText('Fits Tue, Dec 15')).toBeTruthy()
    expect(screen.getByText('Fits today')).toBeTruthy()
  })
})

describe('Home’s Coming up list', () => {
  it('has one link to the full list: "And N more" when the list is cut, no second "Show all"', async () => {
    const state = alexState()
    routeApi((path, data) => (path === '/state' ? state : compare(state, data)))
    render(<App />)
    const coming = await screen.findByRole('region', { name: 'Coming up' })
    expect(
      within(coming).getByRole('button', { name: /^And \d+ more in the next 30 days$/ }),
    ).toBeTruthy()
    expect(within(coming).queryByRole('button', { name: 'Show all' })).toBeNull()
  })
})

describe('below zero reads as overdrawn', () => {
  it('names under $0 "Overdrawn" and keeps "Below cushion" for between $0 and the cushion', () => {
    expect(belowWords(-72674)).toBe('Overdrawn')
    expect(belowWords(22276)).toBe('Below cushion')
    expect(lowestSentence(-72674, '2026-11-30')).toBe('Overdrawn by $726.74 on Mon, Nov 30')
    expect(lowestSentence(45878, '2026-12-31')).toBe('Lowest $458.78 on Thu, Dec 31')
  })
})

describe('Home’s saved rows', () => {
  it('show the same fit label as the Saved page', async () => {
    const state = alexState()
    state.saved = [
      {
        id: 'cam',
        kind: 'catalog',
        productId: 'halden-x5',
        name: 'Halden X5',
        amountCents: 189900,
        createdAt: '2026-11-13T12:00:00Z',
        status: 'active',
      },
      {
        id: 'hp',
        kind: 'catalog',
        productId: 'headphones',
        name: 'Studio headphones',
        amountCents: 34900,
        createdAt: '2026-11-13T11:00:00Z',
        status: 'active',
      },
    ]
    routeApi((path, data) => (path === '/state' ? state : compare(state, data)))
    render(<App />)
    expect(await screen.findByText('Fits Tue, Dec 15')).toBeTruthy()
    expect(screen.getByText('Fits today')).toBeTruthy()
  })
})

describe('the answer page after saving', () => {
  it('reads "Saved" instead of offering to save again', async () => {
    const state = alexState()
    state.saved = [
      {
        id: 'cam',
        kind: 'catalog',
        productId: 'halden-x5',
        name: 'Halden X5',
        amountCents: 189900,
        option: 'wait',
        waitDate: '2026-12-15',
        createdAt: '2026-11-13T12:00:00Z',
        status: 'active',
      },
    ]
    routeApi((_path, data) => compare(state, data))
    render(
      <Decision
        backLabel="Back"
        onBack={vi.fn()}
        onBuy={vi.fn()}
        onSave={vi.fn()}
        onViewActivity={vi.fn()}
        state={state}
        request={{ productId: 'halden-x5' }}
      />,
    )
    expect((await screen.findAllByRole('button', { name: 'Saved' })).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Save for Tue, Dec 15' })).toBeNull()
  })
})

describe('the on= link parameter', () => {
  const read = (query: string) =>
    decisionRequestFrom(new URLSearchParams(query), undefined, '2026-11-13')
  it('keeps a later day inside the wait window', () => {
    expect(read('product=halden-x5&on=2026-11-15')).toEqual({
      productId: 'halden-x5',
      onDate: '2026-11-15',
    })
    expect(read('amount=60000&item=TV&on=2026-12-18')).toMatchObject({ onDate: '2026-12-18' })
  })
  it('ignores today, the past, a day past the window, nonsense, and a link read without a today', () => {
    for (const on of ['2026-11-13', '2026-11-12', '2026-12-19', '2026-02-30', 'Sunday', ''])
      expect(read(`product=halden-x5&on=${on}`)).toEqual({ productId: 'halden-x5' })
    expect(decisionRequestFrom(new URLSearchParams('product=halden-x5&on=2026-11-15'))).toEqual({
      productId: 'halden-x5',
    })
  })
})

describe('a day agreed in Ask, on the comparison page', () => {
  const show = (productId: string, onDate: string) => {
    const state = alexState()
    routeApi((_path, data) => {
      const input = data as { productId?: string; onDate?: string }
      const product = PRODUCTS.find((p) => p.id === input.productId)!
      return compareOptions(state.profile, [], {
        amountCents: product.priceCents,
        itemName: product.name,
        today: state.today,
        payIn4Eligible: true,
        ...(input.onDate ? { onDate: input.onDate } : {}),
      })
    })
    render(
      <Decision
        backLabel="Back"
        onBack={vi.fn()}
        onBuy={vi.fn()}
        onSave={vi.fn()}
        onViewActivity={vi.fn()}
        state={state}
        request={{ productId, onDate }}
      />,
    )
  }

  it('renames the first card to that day, leads with it when it fits, and saves for it', async () => {
    show('headphones', '2026-11-15')
    const group = await screen.findByRole('radiogroup', { name: 'Your options' })
    const radios = within(group).getAllByRole('radio')
    expect(radios).toHaveLength(1)
    expect(radios[0]!.textContent).toContain('Buy Sun, Nov 15')
    expect(radios[0]!.getAttribute('aria-checked')).toBe('true')
    expect(group.textContent).not.toContain('Buy today')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Buy Sun, Nov 15')
    expect(screen.getAllByRole('button', { name: 'Save for Sun, Nov 15' }).length).toBeGreaterThan(
      0,
    )
    expect(screen.queryByRole('button', { name: 'Buy now' })).toBeNull()
  })

  it('shows one card when the day is the wait date', async () => {
    show('halden-x5', '2026-12-15')
    const group = await screen.findByRole('radiogroup', { name: 'Your options' })
    const radios = within(group).getAllByRole('radio')
    expect(radios).toHaveLength(1)
    expect(radios[0]!.textContent).toContain('Buy Tue, Dec 15')
    expect(group.textContent).not.toMatch(/Wait until/)
  })

  it('keeps waiting the answer when that day does not fit, with the day as the first card', async () => {
    show('halden-x5', '2026-11-20')
    const group = await screen.findByRole('radiogroup', { name: 'Your options' })
    const radios = within(group).getAllByRole('radio')
    expect(radios[0]!.textContent).toContain('Buy Fri, Nov 20')
    expect(radios[1]!.textContent).toContain('Wait until Tue, Dec 15')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Wait until Tue, Dec 15')
    // "Buying today …" still describes today, not the agreed day.
    expect(document.querySelector('.verdict-block .lead')!.textContent).toContain(
      'Buying today puts you below it from Thu, Nov 19',
    )
  })
})
