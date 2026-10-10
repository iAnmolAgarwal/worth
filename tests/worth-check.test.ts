// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { linkClaims, payIn4Offered, REFRESH_BEFORE_S, WorthCheck } from '../shared/worthCheck.ts'
import type { EligibilitySource } from '../shared/worthCheck.ts'

const WORTH = 'https://worth.example'
const NOW = 1_791_000_000
/** A link shaped like the store's: the element reads exp and payLater, never the signature. */
function href(claims: { exp?: number; payLater?: { eligible: boolean } } = {}) {
  const body = Buffer.from(
    JSON.stringify({ v: 1, qid: 'q_abcdefghijklmnopqrstuv', exp: NOW + 900, ...claims }),
  ).toString('base64url')
  return `${WORTH}/check#q=${body}.${'s'.repeat(43)}`
}
/** A fake PayPal SDK v6 instance answering for Pay Later, with v6's real product codes. */
function sdk(eligible: boolean, productCode?: string, countryCode?: string) {
  const findEligibleMethods = vi.fn(async () => ({
    isEligible: (method: string) => method === 'paylater' && eligible,
    getDetails: () =>
      productCode ? { productCode, ...(countryCode ? { countryCode } : {}) } : undefined,
  }))
  return { findEligibleMethods } as EligibilitySource & {
    findEligibleMethods: typeof findEligibleMethods
  }
}
/** PayPal's v6 answer for US Pay in 4. */
const payIn4 = () => sdk(true, 'PAY_LATER_SHORT_TERM', 'US')
function mount(attributes: Record<string, string>) {
  const element = document.createElement('worth-check') as WorthCheck
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value)
  document.body.append(element)
  return element
}
const link = (element: WorthCheck) => element.shadowRoot!.querySelector('a')!
const fetchMock = vi.fn()
function answer(next: string) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ href: next }), { status: 200 }))
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  WorthCheck.now = () => NOW
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('<worth-check> (contract §3.1, C2)', () => {
  it('renders a real same-tab link to Worth, described for screen readers', () => {
    const element = mount({ href: href(), merchant: 'Larkspur Supply', amount: '1199.00' })
    const a = link(element)
    expect(a.tagName).toBe('A')
    expect(a.getAttribute('href')).toBe(href())
    expect(a.textContent).toBe('Analyse with Worth')
    expect(a.getAttribute('target')).toBeNull()
    const description = element.shadowRoot!.getElementById(a.getAttribute('aria-describedby')!)!
    expect(description.textContent).toBe(
      'Opens Worth to check when this fits your plan. You come back to Larkspur Supply to pay.',
    )
    expect(element.hidden).toBe(false)
  })

  it('never opens a window or shows PayPal artwork, and is branded with five overrides', () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    const element = mount({ href: href(), amount: '1199.00' })
    link(element).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(open).not.toHaveBeenCalled()
    // Only Worth's own inline W mark, hidden from screen readers; nothing is loaded.
    expect(element.shadowRoot!.querySelector('img, iframe, use[href^="http"]')).toBeNull()
    const marks = element.shadowRoot!.querySelectorAll('svg')
    expect(marks).toHaveLength(1)
    expect(marks[0]!.getAttribute('aria-hidden')).toBe('true')
    expect(link(element).textContent).toBe('Analyse with Worth')
    const css = element.shadowRoot!.querySelector('style')!.textContent!
    // Exactly the five theming properties the contract lists, each with a default.
    const names = [...new Set(css.match(/--worth-check-[a-z-]+/g))].sort()
    expect(names).toEqual([
      '--worth-check-bg',
      '--worth-check-bg-hover',
      '--worth-check-border',
      '--worth-check-ink',
      '--worth-check-radius',
    ])
    for (const name of names) expect(css).toMatch(new RegExp(`var\\(${name}, [^)]+\\)`))
    // Worth's own colours, never PayPal's brand blues or gold, in the button or the mark.
    const markup = element.shadowRoot!.innerHTML.toLowerCase()
    for (const hex of ['#003087', '#012169', '#009cde', '#0070e0', '#ffc439'])
      expect(markup, hex).not.toContain(hex)
    expect(css).toContain('var(--worth-check-bg, #142c8e)')
    expect(css).not.toMatch(/paypal|gold|yellow/i)
    expect(css).toMatch(/a:focus-visible \{\s*outline: 3px solid/)
  })

  it('hides itself without a usable link and never renders a javascript: link', () => {
    for (const value of ['', 'javascript:alert(1)', 'data:text/html,hi']) {
      const element = mount({ href: value })
      expect(element.hidden).toBe(true)
      expect(link(element).getAttribute('href')).toBeNull()
    }
  })

  it('follows a changed href attribute', () => {
    const element = mount({ href: href() })
    const next = href({ exp: NOW + 800 })
    element.setAttribute('href', next)
    expect(link(element).getAttribute('href')).toBe(next)
  })
})

describe('Pay in 4 from the store’s own SDK (contract §3.2)', () => {
  it('asks the store’s SDK for the amount and keeps a link that already says the same', async () => {
    const element = mount({
      href: href({ payLater: { eligible: true } }),
      amount: '1199.00',
      'refresh-url': '/api/worth-quote?productId=camera',
    })
    const paypal = payIn4()
    element.paypal = paypal
    await settle()
    expect(paypal.findEligibleMethods).toHaveBeenCalledWith({
      currencyCode: 'USD',
      amount: '1199.00',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes the link with ?payLater= when the answer differs from the signed one', async () => {
    const fresh = href({ payLater: { eligible: true } })
    answer(fresh)
    const element = mount({
      href: href(),
      amount: '1199.00',
      'refresh-url': '/api/worth-quote?productId=camera',
    })
    element.paypal = Promise.resolve(payIn4())
    await vi.waitFor(() => expect(link(element).getAttribute('href')).toBe(fresh))
    const url = new URL(String(fetchMock.mock.calls[0]![0]))
    expect(url.origin).toBe(window.location.origin)
    expect(url.pathname).toBe('/api/worth-quote')
    expect(url.searchParams.get('productId')).toBe('camera')
    expect(url.searchParams.get('payLater')).toBe('true')
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'same-origin' })
    expect(element.getAttribute('href')).toBe(fresh)
  })

  it('sends payLater=false only when PayPal offers no Pay Later at all', async () => {
    answer(href({ payLater: { eligible: false } }))
    const element = mount({
      href: href({ payLater: { eligible: true } }),
      amount: '5.00',
      'refresh-url': '/q',
    })
    element.paypal = sdk(false)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('payLater')).toBe('false')
  })

  it('leaves payLater unset for PAYLATER, another country or an unknown code', async () => {
    expect(await payIn4Offered(payIn4(), '50.00')).toBe(true)
    expect(await payIn4Offered(sdk(false), '5.00')).toBe(false)
    for (const answerOf of [
      () => sdk(true, 'PAYLATER', 'US'),
      () => sdk(true, 'PAY_LATER_SHORT_TERM', 'GB'),
      () => sdk(true, 'PAY_LATER_SHORT_TERM'),
      () => sdk(true, 'PAY_IN_4', 'US'),
      () => sdk(true),
    ])
      expect(await payIn4Offered(answerOf(), '2500.00')).toBeUndefined()
    // A link signed without an answer stays as it is.
    const quiet = mount({ href: href(), amount: '2500.00', 'refresh-url': '/q' })
    quiet.paypal = sdk(true, 'PAYLATER', 'US')
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
    // A link signed with an answer is refreshed without one, never with a false no.
    answer(href())
    const signed = mount({
      href: href({ payLater: { eligible: true } }),
      amount: '2500.00',
      'refresh-url': '/q',
    })
    signed.paypal = sdk(true, 'PAYLATER', 'US')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.has('payLater')).toBe(false)
  })

  it('picks up an SDK the page set before the element was defined', async () => {
    // The page assigned the property while the element was still undefined.
    const paypal = payIn4()
    const element = document.createElement('worth-check') as WorthCheck
    Object.defineProperty(element, 'paypal', { value: paypal, writable: true, configurable: true })
    element.setAttribute('href', href())
    element.setAttribute('amount', '1199.00')
    document.body.append(element)
    await settle()
    expect(paypal.findEligibleMethods).toHaveBeenCalled()
    expect(element.paypal).toBe(paypal)
    expect(Object.prototype.hasOwnProperty.call(element, 'paypal')).toBe(false)
  })

  it('does nothing without an SDK, an amount or a refresh URL, or when the SDK fails', async () => {
    const element = mount({ href: href(), amount: '1199.00' })
    element.paypal = sdk(true)
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
    const noAmount = mount({ href: href(), 'refresh-url': '/q' })
    const paypal = sdk(true)
    noAmount.paypal = paypal
    await settle()
    expect(paypal.findEligibleMethods).not.toHaveBeenCalled()
    const failing = mount({ href: href(), amount: '1199.00', 'refresh-url': '/q' })
    failing.paypal = { findEligibleMethods: () => Promise.reject(new Error('down')) }
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the current link when the refresh fails or points somewhere else', async () => {
    const original = href()
    for (const respond of [
      () => fetchMock.mockResolvedValue(new Response('{}', { status: 500 })),
      () => fetchMock.mockRejectedValue(new Error('offline')),
      () => answer('https://evil.example/check#q=' + original.split('#q=')[1]),
      () => answer(`${WORTH}/elsewhere#q=${original.split('#q=')[1]}`),
      () => answer(`${WORTH}/check#q=not-a-token`),
      () => answer('javascript:alert(1)'),
    ]) {
      respond()
      const element = mount({ href: original, amount: '1199.00', 'refresh-url': '/q' })
      element.paypal = payIn4()
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
      await settle()
      expect(link(element).getAttribute('href')).toBe(original)
      fetchMock.mockReset()
    }
  })

  it('never sends the refresh to another origin', async () => {
    const element = mount({
      href: href(),
      amount: '1199.00',
      'refresh-url': 'https://evil.example/q',
    })
    element.paypal = payIn4()
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('refreshing near expiry', () => {
  it('refreshes when the page becomes visible within 60 s of exp, and not before', async () => {
    const fresh = href({ exp: NOW + 2000 })
    answer(fresh)
    const element = mount({ href: href({ exp: NOW + 900 }), 'refresh-url': '/q' })
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
    WorthCheck.now = () => NOW + 900 - REFRESH_BEFORE_S
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(link(element).getAttribute('href')).toBe(fresh))
    // No payLater until the store's SDK has answered.
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.has('payLater')).toBe(false)
  })

  it('stops listening once removed from the page', async () => {
    const element = mount({ href: href({ exp: NOW }), 'refresh-url': '/q' })
    element.remove()
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('renews a stale link before following it, in the same tab', async () => {
    const go = vi.spyOn(WorthCheck, 'go').mockImplementation(() => undefined)
    const fresh = href({ exp: NOW + 900 })
    answer(fresh)
    const element = mount({ href: href({ exp: NOW + 30 }), 'refresh-url': '/q' })
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    link(element).dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(go).toHaveBeenCalledWith(fresh))
    go.mockRestore()
  })

  it('lets a modified click on a stale link go as a plain link, Alt included', () => {
    for (const modifier of ['altKey', 'metaKey', 'ctrlKey', 'shiftKey']) {
      const element = mount({ href: href({ exp: NOW + 30 }), 'refresh-url': '/q' })
      const click = new MouseEvent('click', { bubbles: true, cancelable: true, [modifier]: true })
      link(element).dispatchEvent(click)
      expect(click.defaultPrevented, modifier).toBe(false)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('lets a fresh link go as a plain link', () => {
    const element = mount({ href: href(), 'refresh-url': '/q' })
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    link(element).dispatchEvent(click)
    expect(click.defaultPrevented).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads only exp and payLater from its link, and nothing from a malformed one', () => {
    expect(linkClaims(href({ payLater: { eligible: true } }))).toEqual({
      exp: NOW + 900,
      payLater: true,
    })
    expect(linkClaims(`${WORTH}/check`)).toBeUndefined()
    expect(linkClaims('not a url')).toBeUndefined()
    expect(linkClaims(`${WORTH}/check#q=${'%%%'}.${'s'.repeat(43)}`)).toBeUndefined()
  })
})
