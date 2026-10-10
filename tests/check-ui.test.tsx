// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'
import { api, ApiError } from '../src/api'
import {
  leave,
  payLaterLine,
  reloadForNewToken,
  resetHandoff,
  takeHandoffToken,
} from '../src/Check'
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
/** The rail's item card, where the price and its edit live on wide screens. */
const itemCard = () => within(screen.getByRole('complementary', { name: 'Item and reasons' }))
const answer = () => screen.findByRole('heading', { level: 1 })
/** Narrow screens (below 1024 px), where the item leads the page instead of the rail. */
function narrowScreen() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 1023px)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
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

  it('reloads for a new #q= while /check is already open, and only then', async () => {
    const reload = vi.spyOn(leave, 'reload').mockImplementation(() => undefined)
    route({ '/handoff/open': opened() })
    visit()
    await answer()
    window.location.hash = `#q=${TOKEN}x`
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    window.location.hash = '#home'
    await screen.findAllByRole('link', { name: 'Home' })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(reloadForNewToken({ pathname: '/', hash: `#q=${TOKEN}` })).toBe(false)
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
  it('leads with the answer, with the item, its price and its edit in the rail card', async () => {
    route({ '/handoff/open': opened() })
    visit()
    // The decision is the engine's own, for the store's price, with the store's Pay in 4 answer.
    const verdict = await screen.findByRole('heading', { level: 1, name: /Wait until Fri, Oct 23/ })
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    // The answer's block holds the verdict and the engine's sentence, nothing else.
    const block = screen.getByRole('region', { name: /Wait until Fri, Oct 23/ })
    expect(block.contains(verdict)).toBe(true)
    expect(block.querySelectorAll('h1, p.lead')).toHaveLength(2)
    expect(block.childElementCount).toBe(2)
    expect(within(block).queryByRole('button')).toBeNull()
    expect(calls('/compare')[0]![1]).toEqual({
      amountCents: 119900,
      itemName: 'Everyday camera',
      qid: QUOTE.qid,
    })
    // The old chip and its Pay in 4 line are gone; the item card says it once.
    expect(screen.queryByRole('group', { name: /From Larkspur Supply/ })).toBeNull()
    expect(screen.queryByText(/compare it below/)).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Not right? Edit' })).toHaveLength(1)
    expect(itemCard().getByText('Everyday camera')).toBeTruthy()
    expect(itemCard().getByText('Sold by Larkspur Supply')).toBeTruthy()
    expect(itemCard().getByText('$1,199.00')).toBeTruthy()
    expect(itemCard().getByRole('button', { name: 'Not right? Edit' })).toBeTruthy()
    // On wide screens the item lives in the rail only.
    expect(document.querySelector('.item-row')).toBeNull()
    // The store's own Pay in 4 answer sits inside the comparison box, under its heading.
    const p4 = screen.getByRole('button', { name: /Compare with PayPal Pay in 4/ })
    expect(
      within(p4).getByText('Larkspur Supply offers PayPal Pay in 4 for this amount.'),
    ).toBeTruthy()
    expect(screen.getAllByText(/offers PayPal Pay in 4 for this amount/)).toHaveLength(1)
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
    await answer()
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
    // The item card shows the price entered, with the note on what changed right under it.
    expect(await itemCard().findByText('$1,250.00')).toBeTruthy()
    expect(itemCard().getByText(/Larkspur Supply’s price was \$1,199\.00/)).toBeTruthy()
    expect(itemCard().getByText(/Worth is checking the price you entered/)).toBeTruthy()
    expect(
      itemCard().getByText(
        /Larkspur Supply won’t show Worth’s answer, because you changed the price\./,
      ),
    ).toBeTruthy()
    // The store's Pay in 4 answer was for its own price, so the box no longer quotes it.
    expect(screen.queryByText(/PayPal Pay in 4 for this amount/)).toBeNull()
    expect(screen.queryByText(/If this store offers/)).toBeNull()
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
    await userEvent.click(itemCard().getByRole('button', { name: 'Use the store’s price' }))
    expect(await itemCard().findByText('$1,199.00')).toBeTruthy()
    expect(screen.queryByText(/Worth is checking the price you entered/)).toBeNull()
    expect(screen.getByText('Larkspur Supply offers PayPal Pay in 4 for this amount.')).toBeTruthy()
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
    expect(await answer()).toBeTruthy()
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
    expect(calls('/handoff/open')).toHaveLength(0)
  })
})

describe('Save for <date> on /check (contract §4)', () => {
  it('offers Save for the wait day and sends only the quote and the day', async () => {
    route({
      '/handoff/open': opened(),
      '/handoff/save': () => ({ item: {}, state: makeState() }),
    })
    visit()
    const [save] = await screen.findAllByRole('button', { name: 'Save for Fri, Oct 23' })
    await userEvent.click(save!)
    expect(calls('/handoff/save')).toEqual([
      ['/handoff/save', { qid: QUOTE.qid, waitDate: '2026-10-23' }],
    ])
    expect(await screen.findByText('Saved for Fri, Oct 23. Find it in Saved.')).toBeTruthy()
    // Saved once: the button says so and can't save again.
    const done = await screen.findAllByRole('button', { name: 'Saved' })
    expect(done.every((button) => (button as HTMLButtonElement).disabled)).toBe(true)
    expect(screen.queryByRole('button', { name: 'Save for Fri, Oct 23' })).toBeNull()
  })

  it('sends a changed price as the shopper’s own', async () => {
    route({
      '/handoff/open': opened(),
      '/handoff/save': () => ({ item: {}, state: makeState() }),
    })
    visit()
    await userEvent.click(await screen.findByRole('button', { name: 'Not right? Edit' }))
    const price = screen.getByLabelText(/^Total price, USD/)
    await userEvent.clear(price)
    await userEvent.type(price, '1250')
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    const [save] = await screen.findAllByRole('button', { name: /^Save for / })
    await userEvent.click(save!)
    expect(calls('/handoff/save')[0]![1]).toMatchObject({ qid: QUOTE.qid, amountCents: 125000 })
    expect(calls('/handoff/save')[0]![1]).not.toHaveProperty('priceSource')
  })

  it('offers no Save when it fits today, or in a session that doesn’t hold the quote', async () => {
    route({ '/handoff/open': opened({ amountCents: 2000 }) })
    visit()
    expect(await screen.findByRole('heading', { level: 1, name: 'Buy today' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Save for / })).toBeNull()
    cleanup()
    resetHandoff()
    route({ '/handoff/open': opened({ canConsent: false }) })
    visit()
    await screen.findByRole('heading', { level: 1, name: /Wait until/ })
    expect(screen.queryByRole('button', { name: /^Save for / })).toBeNull()
  })
})

describe('Pay in 4 wording (contract §3.2)', () => {
  it('names the store only when it answered and the amount is its own and in range', () => {
    expect(payLaterLine(QUOTE, 119900)).toBe(
      'Larkspur Supply offers PayPal Pay in 4 for this amount.',
    )
    // No answer from the store, or a price it wasn't asked about: nothing is said.
    expect(payLaterLine({ ...QUOTE, payLater: 'unknown' }, 119900)).toBeUndefined()
    expect(payLaterLine({ ...QUOTE, payLater: 'not-offered' }, 119900)).toBe(
      'Larkspur Supply doesn’t offer PayPal Pay in 4 for this amount.',
    )
    expect(payLaterLine(QUOTE, 125000)).toBeUndefined()
    expect(payLaterLine({ ...QUOTE, amountCents: 250000 }, 250000)).toBeUndefined()
    expect(payLaterLine({ ...QUOTE, amountCents: 999 }, 999)).toBeUndefined()
  })
})

describe('the answer and the item on /check (feedback 2)', () => {
  it('moves focus into the edit form, and back to the edit when it closes', async () => {
    route({ '/handoff/open': opened() })
    visit()
    await answer()
    await userEvent.click(itemCard().getByRole('button', { name: 'Not right? Edit' }))
    expect(document.activeElement).toBe(itemCard().getByLabelText('Item'))
    await userEvent.click(itemCard().getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(itemCard().getByRole('button', { name: 'Not right? Edit' }))
    await userEvent.click(itemCard().getByRole('button', { name: 'Not right? Edit' }))
    const price = itemCard().getByLabelText(/^Total price, USD/)
    await userEvent.clear(price)
    await userEvent.type(price, '1250')
    await userEvent.click(itemCard().getByRole('button', { name: 'Check again' }))
    expect(await itemCard().findByText('$1,250.00')).toBeTruthy()
    await waitFor(() =>
      expect(document.activeElement).toBe(
        itemCard().getByRole('button', { name: 'Not right? Edit' }),
      ),
    )
  })

  it('puts the store’s “doesn’t offer” answer inside the Pay in 4 box', async () => {
    route({ '/handoff/open': opened({ payLater: 'not-offered' }) })
    visit()
    await answer()
    const box = document.querySelector('.disclosure') as HTMLElement
    expect(
      within(box).getByText('Larkspur Supply doesn’t offer PayPal Pay in 4 for this amount.'),
    ).toBeTruthy()
    expect(screen.getAllByText(/offer PayPal Pay in 4 for this amount/)).toHaveLength(1)
  })

  it('says nothing about the store’s Pay in 4 when it gave no answer', async () => {
    route({ '/handoff/open': opened({ payLater: 'unknown' }) })
    visit()
    await answer()
    expect(screen.getByRole('button', { name: /Compare with PayPal Pay in 4/ })).toBeTruthy()
    expect(screen.queryByText(/PayPal Pay in 4 for this amount|compare it below/)).toBeNull()
  })

  it('leads with a compact item row on narrow screens, and drops the rail’s item card', async () => {
    narrowScreen()
    route({ '/handoff/open': opened() })
    visit()
    const verdict = await answer()
    const row = document.querySelector('.item-row') as HTMLElement
    expect(row).toBeTruthy()
    // The row comes before the answer, with the item, its price, the store and the edit.
    expect(row.compareDocumentPosition(verdict) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(row).getByText('Everyday camera')).toBeTruthy()
    expect(within(row).getByText('$1,199.00')).toBeTruthy()
    expect(within(row).getByText(/Larkspur Supply/)).toBeTruthy()
    expect(row.querySelector('img')?.getAttribute('src')).toBe(QUOTE.imageUrl)
    // Said once: no second card in the rail, and one edit on the page.
    expect(screen.queryByText('Sold by Larkspur Supply')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Not right? Edit' })).toHaveLength(1)
    // The way back to the store stays in the rail for tablets, which have no action bar.
    const rail = within(screen.getByRole('complementary', { name: 'Item and reasons' }))
    expect(rail.getByRole('link', { name: 'Back to Larkspur Supply' })).toBeTruthy()
    // Editing happens in the row, and the note on the price entered stays there.
    await userEvent.click(within(row).getByRole('button', { name: 'Not right? Edit' }))
    const price = within(row).getByLabelText(/^Total price, USD/)
    await userEvent.clear(price)
    await userEvent.type(price, '1250')
    await userEvent.click(within(row).getByRole('button', { name: 'Check again' }))
    const edited = await waitFor(() => {
      const next = document.querySelector('.item-row') as HTMLElement
      expect(within(next).getByText('$1,250.00')).toBeTruthy()
      return next
    })
    expect(within(edited).getByText(/Worth is checking the price you entered/)).toBeTruthy()
    expect(within(edited).getByRole('button', { name: 'Use the store’s price' })).toBeTruthy()
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
    expect(await answer()).toBeTruthy()
    expect(calls('/handoff/open')).toHaveLength(2)
  })
})
