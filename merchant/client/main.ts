import { loadPayPalSdk, type PayPalSdkInstance } from '../../src/paypalSdk.ts'

/**
 * Larkspur's checkout: PayPal's own SDK v6 button and popup, with the order created and captured
 * on the store's server. The page is server-rendered; this module only wires PayPal up, shows the
 * thank-you state, and keeps the "Analyse with Worth" link's quote fresh.
 */
export interface CheckoutDeps {
  loadSdk: (clientId: string) => Promise<PayPalSdkInstance>
  fetch: typeof fetch
  /** Seconds since the epoch. */
  now: () => number
}

/** A quote this close to expiry is refreshed before the shopper leaves for Worth. */
const REFRESH_MARGIN_S = 60

async function post<T>(http: typeof fetch, path: string, body: unknown): Promise<T> {
  const response = await http(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  const data = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(data.error ?? 'Something went wrong. Try again.')
  return data
}

export function mountCheckout(root: HTMLElement, deps: CheckoutDeps) {
  const productId = root.dataset.productId ?? ''
  const amount = root.dataset.amount ?? ''
  const clientId = root.dataset.clientId ?? ''
  const replay = root.dataset.replay === 'video'
  const status = root.querySelector<HTMLElement>('.lk-buy__status')
  const errorBox = root.querySelector<HTMLElement>('.lk-buy__error')
  const button = root.querySelector<HTMLElement>('paypal-button')
  const thanks = root.ownerDocument.getElementById('thanks')
  let quoteExp = Number(root.dataset.quoteExp) || 0

  const showError = (message: string) => {
    if (!errorBox) return
    errorBox.textContent = message
    errorBox.hidden = !message
  }
  const showStatus = (message: string) => {
    if (!status) return
    status.textContent = message
    status.hidden = !message
  }

  // The result token has been read by the server; it has no further use in the address bar.
  const url = new URL(root.ownerDocument.location.href)
  if (url.searchParams.has('worth')) {
    url.searchParams.delete('worth')
    root.ownerDocument.defaultView?.history.replaceState(null, '', url.pathname + url.search)
  }

  // The Analyse link is a real same-tab link (contract §3.1). Near expiry it gets a fresh quote.
  const link = root.querySelector<HTMLAnchorElement>('a.worth-check')
  link?.addEventListener('click', (event) => {
    if (quoteExp - deps.now() > REFRESH_MARGIN_S) return
    event.preventDefault()
    const query = new URLSearchParams({ productId, ...(replay ? { replay: 'video' } : {}) })
    deps
      .fetch(`/api/worth-quote?${query}`, { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error())))
      .then((quote: { href: string; exp: number }) => {
        quoteExp = quote.exp
        link.href = quote.href
      })
      .catch(() => undefined)
      .finally(() => root.ownerDocument.defaultView?.location.assign(link.href))
  })

  function complete(orderId: string) {
    root.hidden = true
    if (!thanks) return
    const ref = thanks.querySelector('.lk-thanks__order')
    if (ref) ref.textContent = orderId
    thanks.hidden = false
    thanks.focus()
  }

  async function capture(orderId: string) {
    showError('')
    showStatus('Confirming your payment…')
    try {
      const result = await post<{ status: string; orderId: string }>(
        deps.fetch,
        `/api/orders/${encodeURIComponent(orderId)}/capture`,
        {},
      )
      if (result.status === 'COMPLETED') complete(result.orderId)
      else showStatus('PayPal is still processing this payment. We’ll email you when it clears.')
    } catch (failure) {
      showStatus('')
      showError((failure as Error).message)
    }
  }

  if (!clientId || !button) return Promise.resolve()
  return deps
    .loadSdk(clientId)
    .then(async (instance) => {
      try {
        instance.createPayPalMessages?.()
      } catch {
        /* Messages are optional; checkout stands without them. */
      }
      const methods = await instance.findEligibleMethods({ currencyCode: 'USD', amount })
      if (!methods.isEligible('paypal')) {
        showStatus('PayPal isn’t available for this order right now.')
        return
      }
      const session = instance.createPayPalOneTimePaymentSession({
        onApprove: ({ orderId }) => capture(orderId),
        onCancel: () => showStatus(''),
        onError: () => showError('PayPal couldn’t finish. Try the button again.'),
      })
      // After a full-page redirect approval PayPal returns here; the session picks it up.
      if (session.hasReturned()) await session.resume()
      button.hidden = false
      showStatus('')
      button.addEventListener('click', () => {
        showError('')
        const order = post<{ orderId: string }>(deps.fetch, '/api/orders', { productId })
        order.catch((failure: Error) => showError(failure.message))
        void session.start({ presentationMode: 'auto' }, order).catch(() => undefined)
      })
    })
    .catch(() => showStatus('PayPal couldn’t load. Refresh the page to try again.'))
}

const root = typeof document !== 'undefined' ? document.getElementById('checkout') : null
if (root)
  void mountCheckout(root, {
    loadSdk: loadPayPalSdk,
    fetch: (...args) => fetch(...args),
    now: () => Math.floor(Date.now() / 1000),
  })
