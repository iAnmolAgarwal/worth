// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'
import { api, ApiError } from '../src/api'
import { leave, payLaterLine, resetHandoff, takeHandoffToken } from '../src/Check'
import { compareOptions } from '../shared/finance'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type { AppState, HandoffQuote } from '../shared/types'

vi.mock('../src/paypalSdk', () => ({ loadPayPalSdk: vi.fn() }))
vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>()
  return { ...actual, api: vi.fn() }
})

const TODAY = '2026-10-03'
const TOKEN = 'eyJ2IjoxfQ.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmUtc2lnbmF0dXI'
const STORE = 'https://store.example'
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
const QUOTE: HandoffQuote = {
  qid: 'q_abcdefghijklmnopqrstuv',
  merchant: 'Larkspur Supply',
  item: 'Everyday camera',
  amountCents: 119900,
  returnUrl: `${STORE}/p/camera`,
  imageUrl: `${STORE}/img/camera.png`,
  payLater: 'offered',
  consent: false,
  canConsent: true,
}
type Handler = (data: unknown) => unknown
/** Routes the app's API calls; `/handoff/open` and friends come from the test. */
function route(handlers: Record<string, Handler> = {}) {
  const state = makeState()
  apiMock.mockImplementation(((path: string, data?: unknown) =>
    Promise.resolve().then(() => {
      for (const [prefix, handler] of Object.entries(handlers))
        if (path.startsWith(prefix)) return handler(data)
      if (path === '/state') return state
      if (path === '/compare') {
        const input = data as { amountCents: number; itemName?: string }
        return compareOptions(state.profile, state.purchases, {
          amountCents: input.amountCents,
          itemName: input.itemName,
          today: TODAY,
          payIn4Eligible: true,
        })
      }
      if (path.startsWith('/saved/migrate')) return state
      throw new Error(`Unexpected call to ${path}`)
    })) as typeof api)
  return state
}
const opened =
  (quote: Partial<HandoffQuote> = {}, extra: object = {}) =>
  () => ({
    quote: { ...QUOTE, ...quote },
    state: makeState(),
    ...extra,
  })
const fails =
  (status: number, code: string, message: string, details: object = {}) =>
  () => {
    throw new ApiError(message, status, code, { error: message, code, ...details })
  }
function visit(hash = `#q=${TOKEN}`) {
  window.history.replaceState(null, '', `/check${hash}`)
  return render(<App />)
}
const calls = (path: string) => apiMock.mock.calls.filter(([p]) => p === path)
const storeLinks = () =>
  screen.queryAllByRole('link').filter((link) => link.getAttribute('href')?.startsWith(STORE))

beforeEach(() => {
  apiMock.mockReset()
  resetHandoff()
  sessionStorage.clear()
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
  vi.restoreAllMocks()
})

describe('reading the store’s token', () => {
  it('takes #q= once and removes it from the address bar, keeping the path and query', () => {
    const replaceState = vi.fn()
    const location = { pathname: '/check', search: '?a=1', hash: `#q=${TOKEN}` }
    expect(takeHandoffToken(location, { replaceState })).toBe(TOKEN)
    expect(replaceState).toHaveBeenCalledWith(null, '', '/check?a=1')
    const none = vi.fn()
    expect(
      takeHandoffToken({ pathname: '/check', search: '', hash: '#home' }, { replaceState: none }),
    ).toBeUndefined()
    expect(none).not.toHaveBeenCalled()
  })

  it('clears the fragment before the quote is even verified', async () => {
    route({ '/handoff/open': () => new Promise(() => undefined) })
    visit()
    expect(window.location.hash).toBe('')
    expect(window.location.pathname).toBe('/check')
    await screen.findByText('Checking the link from the store…')
    await waitFor(() =>
      expect(calls('/handoff/open')).toEqual([['/handoff/open', { token: TOKEN }]]),
    )
  })
})

describe('a verified quote on /check', () => {
  it('shows where the item is from, then the normal decision for that item and price', async () => {
    route({ '/handoff/open': opened() })
    visit()
    const from = await screen.findByRole('group', {
      name: 'From Larkspur Supply · Everyday camera · $1,199.00',
    })
    expect(within(from).getByRole('button', { name: 'Not right? Edit' })).toBeTruthy()
    // The decision is the engine's own, for the store's price, with the store's Pay in 4 answer.
    expect(
      await screen.findByRole('heading', { level: 1, name: /Wait until Fri, Oct 23/ }),
    ).toBeTruthy()
    expect(calls('/compare')[0]![1]).toEqual({
      amountCents: 119900,
      itemName: 'Everyday camera',
      qid: QUOTE.qid,
    })
    expect(screen.getByText('Larkspur Supply offers PayPal Pay in 4 for this amount.')).toBeTruthy()
    expect(screen.getAllByText('Sold by Larkspur Supply').length).toBeGreaterThan(0)
    // No Buy button in Worth: the way to pay is back at the store.
    expect(screen.queryByRole('button', { name: /buy/i })).toBeNull()
    const back = screen.getAllByRole('link', { name: 'Back to Larkspur Supply' })
    expect(back.length).toBeGreaterThan(0)
    for (const link of back) {
      expect(link.getAttribute('href')).toBe(`${STORE}/p/camera`)
      expect(link.getAttribute('target')).toBeNull()
    }
  })

  it('leaves report-back consent unticked by default and records a tick for this quote', async () => {
    route({
      '/handoff/open': opened(),
      '/handoff/consent': (data) => data,
    })
    visit()
    const box = await screen.findByRole('checkbox', {
      name: /Let Larkspur Supply tell Worth if I buy this, so it shows once in my Activity/,
    })
    expect((box as HTMLInputElement).checked).toBe(false)
    expect(calls('/handoff/consent')).toHaveLength(0)
    await userEvent.click(box)
    expect((box as HTMLInputElement).checked).toBe(true)
    expect(calls('/handoff/consent')).toEqual([
      ['/handoff/consent', { qid: QUOTE.qid, consent: true }],
    ])
  })

  it('unticks again when the server refuses the choice', async () => {
    route({
      '/handoff/open': opened(),
      '/handoff/consent': fails(404, 'NOT_FOUND', 'This store link isn’t open in this session.'),
    })
    visit()
    const box = await screen.findByRole('checkbox')
    await userEvent.click(box)
    await waitFor(() => expect((box as HTMLInputElement).checked).toBe(false))
    expect(await screen.findByText('This store link isn’t open in this session.')).toBeTruthy()
  })

  it('offers no consent where another Worth session opened the link first', async () => {
    route({ '/handoff/open': opened({ canConsent: false }) })
    visit()
    await screen.findByRole('group', { name: /From Larkspur Supply/ })
    expect(screen.queryByRole('checkbox')).toBeNull()
    // The decision still works there, compared like an item typed in.
    expect(await screen.findByRole('heading', { level: 1, name: /Wait until/ })).toBeTruthy()
    expect(calls('/compare')[0]![1]).toEqual({ amountCents: 119900, itemName: 'Everyday camera' })
  })

  it('goes back to the store with the signed verdict on a normal click', async () => {
    const to = vi.spyOn(leave, 'to').mockImplementation(() => undefined)
    route({
      '/handoff/open': opened(),
      '/handoff/return': () => ({ url: `${STORE}/p/camera?worth=RESULT.TOKEN` }),
    })
    visit()
    const [back] = await screen.findAllByRole('link', { name: 'Back to Larkspur Supply' })
    fireEvent.click(back!)
    await waitFor(() => expect(to).toHaveBeenCalledWith(`${STORE}/p/camera?worth=RESULT.TOKEN`))
    expect(calls('/handoff/return')).toEqual([['/handoff/return', { qid: QUOTE.qid }]])
  })

  it('falls back to the plain store link when the verdict can’t be signed or points elsewhere', async () => {
    const to = vi.spyOn(leave, 'to').mockImplementation(() => undefined)
    route({
      '/handoff/open': opened(),
      '/handoff/return': () => ({ url: 'https://evil.example/?worth=x' }),
    })
    visit()
    const [back] = await screen.findAllByRole('link', { name: 'Back to Larkspur Supply' })
    fireEvent.click(back!)
    await waitFor(() => expect(to).toHaveBeenCalledWith(`${STORE}/p/camera`))
    cleanup()
    resetHandoff()
    to.mockClear()
    route({
      '/handoff/open': opened(),
      '/handoff/return': fails(
        429,
        'RATE_LIMITED',
        'Please wait a moment before making more requests.',
      ),
    })
    visit()
    const [again] = await screen.findAllByRole('link', { name: 'Back to Larkspur Supply' })
    fireEvent.click(again!)
    await waitFor(() => expect(to).toHaveBeenCalledWith(`${STORE}/p/camera`))
  })

  it('turns an edit into a user-claimed price that the decision and the way back both use', async () => {
    const to = vi.spyOn(leave, 'to').mockImplementation(() => undefined)
    route({
      '/handoff/open': opened(),
      '/handoff/return': () => ({ url: `${STORE}/p/camera?worth=R.T` }),
    })
    visit()
    await userEvent.click(await screen.findByRole('button', { name: 'Not right? Edit' }))
    const price = screen.getByLabelText(/^Total price, USD/)
    await userEvent.clear(price)
    await userEvent.type(price, '1250')
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(
      await screen.findByRole('group', { name: 'You entered · Everyday camera · $1,250.00' }),
    ).toBeTruthy()
    expect(screen.getByText(/Larkspur Supply’s price was \$1,199\.00/)).toBeTruthy()
    expect(
      screen.getByText(
        /Larkspur Supply won’t show Worth’s answer, because you changed the price\./,
      ),
    ).toBeTruthy()
    // The store's Pay in 4 answer was for its own price, so it no longer applies.
    expect(screen.getByText('If this store offers PayPal Pay in 4, compare it below.')).toBeTruthy()
    await waitFor(() =>
      expect(calls('/compare').at(-1)![1]).toEqual({
        amountCents: 125000,
        itemName: 'Everyday camera',
        qid: QUOTE.qid,
      }),
    )
    const [back] = await screen.findAllByRole('link', { name: 'Back to Larkspur Supply' })
    fireEvent.click(back!)
    await waitFor(() => expect(to).toHaveBeenCalled())
    expect(calls('/handoff/return')).toEqual([
      ['/handoff/return', { qid: QUOTE.qid, amountCents: 125000 }],
    ])
    await userEvent.click(screen.getByRole('button', { name: 'Use the store’s price' }))
    expect(
      await screen.findByRole('group', {
        name: 'From Larkspur Supply · Everyday camera · $1,199.00',
      }),
    ).toBeTruthy()
  })

  it('starts the video replay toast when the quote asked for it and the sample persona took it', async () => {
    route({ '/handoff/open': opened({}, { replay: true }) })
    visit()
    expect(
      await screen.findByText('Showing the video scenario: Maya on Sat, Oct 3, 2026.'),
    ).toBeTruthy()
  })

  it('shows the quote again after a reload, for the session that opened it', async () => {
    sessionStorage.setItem('worth.check.qid', QUOTE.qid)
    route({ [`/handoff/quotes/${QUOTE.qid}`]: () => ({ quote: { ...QUOTE, consent: true } }) })
    visit('')
    expect(await screen.findByRole('group', { name: /From Larkspur Supply/ })).toBeTruthy()
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
    expect(calls('/handoff/open')).toHaveLength(0)
  })
})

describe('Pay in 4 wording (contract §3.2)', () => {
  it('names the store only when it said eligible and the amount is in range', () => {
    expect(payLaterLine(QUOTE, 119900)).toBe(
      'Larkspur Supply offers PayPal Pay in 4 for this amount.',
    )
    expect(payLaterLine({ ...QUOTE, payLater: 'unknown' }, 119900)).toBe(
      'If this store offers PayPal Pay in 4, compare it below.',
    )
    expect(payLaterLine({ ...QUOTE, payLater: 'not-offered' }, 119900)).toBe(
      'Larkspur Supply doesn’t offer PayPal Pay in 4 for this amount.',
    )
    expect(payLaterLine(QUOTE, 125000)).toBe(
      'If this store offers PayPal Pay in 4, compare it below.',
    )
    expect(payLaterLine({ ...QUOTE, amountCents: 250000 }, 250000)).toBeUndefined()
    expect(payLaterLine({ ...QUOTE, amountCents: 999 }, 999)).toBeUndefined()
  })
})

describe('/check error states (contract §3.4)', () => {
  const UNVERIFIED =
    'We couldn’t verify this link from the store. You can still check the item yourself.'

  it('shows an unverified link with an empty composer and no way back to the store', async () => {
    route({ '/handoff/open': fails(400, 'HANDOFF_UNVERIFIED', UNVERIFIED) })
    visit()
    expect(await screen.findByText(UNVERIFIED)).toBeTruthy()
    expect(storeLinks()).toHaveLength(0)
    expect(screen.queryByRole('link', { name: /Back to/ })).toBeNull()
    expect(document.body.textContent).not.toContain(TOKEN)
    const item = screen.getByLabelText('Item') as HTMLInputElement
    const price = screen.getByLabelText(/^Total price, USD/) as HTMLInputElement
    expect(item.value).toBe('')
    expect(price.value).toBe('')
    await userEvent.type(item, 'Desk lamp')
    await userEvent.type(price, '45')
    await userEvent.click(screen.getByRole('button', { name: 'Check it' }))
    await waitFor(() => expect(window.location.hash).toMatch(/^#decision\?/))
    const params = new URLSearchParams(window.location.hash.split('?')[1])
    expect(params.get('amount')).toBe('4500')
    expect(params.get('item')).toBe('Desk lamp')
  })

  it('shows the unverified state without asking the server when there is no link at all', async () => {
    route()
    visit('')
    expect(await screen.findByText(UNVERIFIED)).toBeTruthy()
    expect(calls('/handoff/open')).toHaveLength(0)
    expect(storeLinks()).toHaveLength(0)
  })

  it('never sends a token over 4 KB, and treats a body the server refused as unverified', async () => {
    route()
    visit(`#q=${'A'.repeat(5000)}.${'s'.repeat(43)}`)
    expect(await screen.findByText(UNVERIFIED)).toBeTruthy()
    expect(calls('/handoff/open')).toHaveLength(0)
    cleanup()
    resetHandoff()
    route({ '/handoff/open': fails(413, 'TOO_LARGE', 'This file is too large.') })
    visit()
    expect(await screen.findByText(UNVERIFIED)).toBeTruthy()
    expect(screen.queryByText('This file is too large.')).toBeNull()
  })

  it('treats a quote the server no longer has as unverified', async () => {
    sessionStorage.setItem('worth.check.qid', QUOTE.qid)
    route({
      '/handoff/quotes/': fails(404, 'NOT_FOUND', 'This store link isn’t open in this session.'),
    })
    visit('')
    expect(await screen.findByText(UNVERIFIED)).toBeTruthy()
    expect(storeLinks()).toHaveLength(0)
  })

  it('says an expired link has expired and offers the plain way back', async () => {
    const message =
      'This link from Larkspur Supply has expired. Go back and tap Analyse with Worth again.'
    route({
      '/handoff/open': fails(400, 'HANDOFF_EXPIRED', message, {
        merchant: 'Larkspur Supply',
        returnUrl: `${STORE}/p/camera`,
      }),
    })
    visit()
    expect(await screen.findByText(message)).toBeTruthy()
    const back = screen.getByRole('link', { name: 'Back to Larkspur Supply' })
    expect(back.getAttribute('href')).toBe(`${STORE}/p/camera`)
    expect(screen.queryByLabelText('Item')).toBeNull()
  })

  it('says Worth checks US dollars only, with manual entry and the way back', async () => {
    route({
      '/handoff/open': fails(400, 'HANDOFF_CURRENCY', 'Worth checks US dollar prices for now.', {
        merchant: 'Larkspur Supply',
        item: 'Everyday camera',
        returnUrl: `${STORE}/p/camera`,
      }),
    })
    visit()
    expect(await screen.findByText('Worth checks US dollar prices for now.')).toBeTruthy()
    expect((screen.getByLabelText('Item') as HTMLInputElement).value).toBe('Everyday camera')
    expect((screen.getByLabelText(/^Total price, USD/) as HTMLInputElement).value).toBe('')
    expect(screen.getByRole('link', { name: 'Back to Larkspur Supply' }).getAttribute('href')).toBe(
      `${STORE}/p/camera`,
    )
  })

  it('shows the existing limit message, no way back before verification, and a retry', async () => {
    let limited = true
    route({
      '/handoff/open': () => {
        if (limited)
          return fails(429, 'RATE_LIMITED', 'Please wait a moment before making more requests.')()
        return opened()()
      },
    })
    visit()
    expect(
      await screen.findByText('Please wait a moment before making more requests.'),
    ).toBeTruthy()
    expect(storeLinks()).toHaveLength(0)
    limited = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('group', { name: /From Larkspur Supply/ })).toBeTruthy()
    expect(calls('/handoff/open')).toHaveLength(2)
  })
})
