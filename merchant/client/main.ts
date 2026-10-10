import { loadPayPalSdk, type PayPalSdkInstance } from '../../src/paypalSdk.ts'

/**
 * Larkspur's checkout: PayPal's own SDK v6 button and popup, with the order created and captured
 * on the store's server. The page is server-rendered; this module only wires PayPal up, shows the
 * thank-you state, and hands the SDK instance to <worth-check>, which asks it about Pay in 4 and
 * keeps its own link fresh (shared/worthCheck.ts).
 */
export interface CheckoutDeps {
  loadSdk: (clientId: string) => Promise<PayPalSdkInstance>
  fetch: typeof fetch
}

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
  const status = root.querySelector<HTMLElement>('.lk-buy__status')
  const errorBox = root.querySelector<HTMLElement>('.lk-buy__error')
  const button = root.querySelector<HTMLElement>('paypal-button')
  const thanks = root.ownerDocument.getElementById('thanks')

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
      // The store's own SDK answers <worth-check>'s Pay in 4 question (contract §3.2).
      const worthCheck = root.querySelector<HTMLElement & { paypal?: unknown }>('worth-check')
      if (worthCheck) worthCheck.paypal = instance
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
  })
