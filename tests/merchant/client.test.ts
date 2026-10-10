// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountCheckout } from '../../merchant/client/main.ts'
import { productPage } from '../../merchant/pages.ts'
import { PRODUCTS } from '../../shared/seed.ts'
import type { PayPalSessionCallbacks, PayPalSdkInstance } from '../../src/paypalSdk.ts'

const camera = PRODUCTS.find((p) => p.id === 'camera')!

/** Renders the server's product page markup into the test document. */
function render(options: { clientId?: string; exp?: number } = {}) {
  const html = productPage(
    {
      product: camera,
      quote: { token: 'TOKEN', exp: options.exp ?? 2000 },
      worthOrigin: 'https://worth.example',
      paypalClientId: options.clientId ?? 'client',
    },
    { scriptSrc: '/assets/store.js' },
  )
  document.body.innerHTML = new DOMParser()
    .parseFromString(html, 'text/html')
    .querySelector('main')!.outerHTML
  return document.getElementById('checkout')!
}

function sdk(eligible = true) {
  let callbacks: PayPalSessionCallbacks | undefined
  const start = vi.fn(async (_options: unknown, order: Promise<{ orderId: string }>) => {
    await order
  })
  const instance = {
    findEligibleMethods: vi.fn(async () => ({ isEligible: () => eligible })),
    createPayPalOneTimePaymentSession: vi.fn((options: PayPalSessionCallbacks) => {
      callbacks = options
      return { start, hasReturned: () => false, resume: vi.fn() }
    }),
    createPayPalMessages: vi.fn(),
  } as unknown as PayPalSdkInstance
  return {
    instance,
    start,
    approve: (orderId: string) => callbacks!.onApprove({ orderId, payerId: 'P' }),
  }
}

function api(routes: Record<string, unknown>) {
  return vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${String(url)}`
    const body = routes[key]
    if (body === undefined) return Response.json({ error: 'nope' }, { status: 404 })
    return Response.json(body)
  }) as unknown as typeof fetch
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('store checkout client', () => {
  it('shows PayPal’s button once eligible, creates the order on click, captures on approval', async () => {
    const root = render()
    const paypal = sdk()
    const fetch = api({
      'POST /api/orders': { orderId: 'ORDER1' },
      'POST /api/orders/ORDER1/capture': { status: 'COMPLETED', orderId: 'ORDER1' },
    })
    await mountCheckout(root, { loadSdk: async () => paypal.instance, fetch })
    const button = root.querySelector<HTMLElement>('paypal-button')!
    expect(button.hidden).toBe(false)
    expect(paypal.instance.findEligibleMethods).toHaveBeenCalledWith({
      currencyCode: 'USD',
      amount: '1199.00',
    })
    expect(paypal.instance.createPayPalMessages).toHaveBeenCalled()
    button.click()
    expect(paypal.start).toHaveBeenCalledWith({ presentationMode: 'auto' }, expect.any(Promise))
    const [, createInit] = vi.mocked(fetch).mock.calls[0]!
    expect(JSON.parse(String(createInit!.body))).toEqual({ productId: 'camera' })
    await paypal.approve('ORDER1')
    expect(root.hidden).toBe(true)
    const thanks = document.getElementById('thanks')!
    expect(thanks.hidden).toBe(false)
    expect(thanks.textContent).toContain('Thank you for your order')
    expect(thanks.querySelector('.lk-thanks__order')!.textContent).toBe('ORDER1')
  })

  it('shows the store’s message when capture fails and keeps the checkout open', async () => {
    const root = render()
    const paypal = sdk()
    const fetch = vi.fn(async () =>
      Response.json({ error: 'PayPal couldn’t use that payment method.' }, { status: 422 }),
    ) as unknown as typeof globalThis.fetch
    await mountCheckout(root, { loadSdk: async () => paypal.instance, fetch })
    await paypal.approve('ORDER1')
    expect(root.hidden).toBe(false)
    expect(root.querySelector('.lk-buy__error')!.textContent).toContain('payment method')
  })

  it('keeps the button hidden when PayPal is not eligible or does not load', async () => {
    const root = render()
    await mountCheckout(root, {
      loadSdk: async () => sdk(false).instance,
      fetch: api({}),
    })
    expect(root.querySelector<HTMLElement>('paypal-button')!.hidden).toBe(true)
    const again = render()
    await mountCheckout(again, {
      loadSdk: async () => Promise.reject(new Error('blocked')),
      fetch: api({}),
    })
    expect(again.querySelector('.lk-buy__status')!.textContent).toContain('couldn’t load')
  })

  it('renders the real <worth-check> with its link, amount and refresh URL', () => {
    const root = render()
    const element = root.querySelector('worth-check')!
    expect(element.getAttribute('href')).toBe('https://worth.example/check#q=TOKEN')
    expect(element.getAttribute('merchant')).toBe('Larkspur Supply')
    expect(element.getAttribute('amount')).toBe('1199.00')
    expect(element.getAttribute('refresh-url')).toBe('/api/worth-quote?productId=camera')
    // Without JavaScript, the plain link inside still goes to Worth in the same tab.
    const fallback = element.querySelector('a')!
    expect(fallback.getAttribute('href')).toBe('https://worth.example/check#q=TOKEN')
    expect(fallback.getAttribute('target')).toBeNull()
  })

  it('hands the store’s own SDK instance to <worth-check>', async () => {
    const root = render()
    const { instance } = sdk()
    await mountCheckout(root, { loadSdk: async () => instance, fetch: api({}) })
    expect((root.querySelector('worth-check') as HTMLElement & { paypal?: unknown }).paypal).toBe(
      instance,
    )
  })

  it('removes the Worth result token from the address bar', async () => {
    window.history.replaceState(null, '', '/p/camera?replay=video&worth=abc.def')
    const root = render({ clientId: '' })
    await mountCheckout(root, { loadSdk: async () => sdk().instance, fetch: api({}) })
    expect(window.location.pathname + window.location.search).toBe('/p/camera?replay=video')
  })
})
