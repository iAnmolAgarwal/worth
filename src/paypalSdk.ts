/** Minimal SDK v6 surface used by Worth. Capture always remains a separate server action.
 * Reference: https://developer.paypal.com/sdk/js/reference/
 */
export interface PayPalApprovalData {
  orderId: string
  payerId: string
  paymentId?: string
}
export interface PayPalCancelData {
  orderId?: string
}
export interface PayPalSdkError {
  code: string
  message: string
}
export interface PayPalSessionCallbacks {
  onApprove(data: PayPalApprovalData): void | Promise<void>
  onCancel?(data: PayPalCancelData): void | Promise<void>
  onError?(error: PayPalSdkError): void | Promise<void>
  /** false uses a Continue button when the app has an additional confirmation step. */
  commit?: boolean
  orderId?: string
}
export interface PayPalPaymentSession {
  /** Resolves after approval OR cancellation. Use callbacks to distinguish the outcome. */
  start(options: { presentationMode: 'auto' }, order: Promise<{ orderId: string }>): Promise<void>
  hasReturned(): boolean
  resume(): Promise<void>
}
export interface PayPalSdkInstance {
  findEligibleMethods(options: { currencyCode: 'USD'; amount?: string }): Promise<{
    isEligible(method: 'paypal'): boolean
  }>
  createPayPalOneTimePaymentSession(options: PayPalSessionCallbacks): PayPalPaymentSession
}
interface PayPalGlobal {
  createInstance(options: {
    clientId: string
    components: ['paypal-payments']
    pageType: 'checkout'
  }): Promise<PayPalSdkInstance>
}
declare global {
  interface Window {
    paypal?: PayPalGlobal
  }
}

const SCRIPT_ID = 'worth-paypal-sdk-v6'
const SCRIPT_URL = 'https://www.sandbox.paypal.com/web-sdk/v6/core'
const TIMEOUT_MS = 12_000
let corePromise: Promise<PayPalGlobal> | undefined
const instancePromises = new Map<string, Promise<PayPalSdkInstance>>()

function loadCore(): Promise<PayPalGlobal> {
  if (typeof window === 'undefined' || typeof document === 'undefined')
    return Promise.reject(new Error('PayPal checkout needs a browser.'))
  if (typeof window.paypal?.createInstance === 'function') return Promise.resolve(window.paypal)
  if (corePromise) return corePromise

  const loading = new Promise<PayPalGlobal>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID)
    // A previous failed attempt may have left an element after a hot reload.
    if (existing && (!(existing instanceof HTMLScriptElement) || existing.src !== SCRIPT_URL)) {
      reject(new Error('The PayPal SDK script could not be initialized.'))
      return
    }
    const script = (existing as HTMLScriptElement | null) ?? document.createElement('script')
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      script.removeEventListener('load', onLoad)
      script.removeEventListener('error', onError)
      if (error) {
        script.remove()
        reject(error)
      } else if (typeof window.paypal?.createInstance === 'function') resolve(window.paypal)
      else {
        script.remove()
        reject(
          new Error('PayPal checkout did not initialize. You can retry or use the approval link.'),
        )
      }
    }
    const onLoad = () => finish()
    const onError = () =>
      finish(new Error('PayPal checkout could not load. You can retry or use the approval link.'))
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            'PayPal checkout took too long to load. You can retry or use the approval link.',
          ),
        ),
      TIMEOUT_MS,
    )
    script.addEventListener('load', onLoad, { once: true })
    script.addEventListener('error', onError, { once: true })
    if (!existing) {
      script.id = SCRIPT_ID
      script.src = SCRIPT_URL
      script.async = true
      try {
        document.head.appendChild(script)
      } catch {
        finish(new Error('PayPal checkout could not load. You can use the approval link.'))
      }
    }
  })
  corePromise = loading
  void loading.catch(() => {
    if (corePromise === loading) corePromise = undefined
  })
  return loading
}

function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), TIMEOUT_MS)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Loads the sandbox SDK once and caches a configured instance per public client ID.
 * Failed loads/initialization are evicted so a later deliberate retry can recover.
 * This helper never creates, approves, or captures an order.
 */
export function loadPayPalSdk(clientId: string): Promise<PayPalSdkInstance> {
  if (!clientId.trim()) return Promise.reject(new Error('PayPal sandbox is not configured.'))
  const cached = instancePromises.get(clientId)
  if (cached) return cached
  const initializing = loadCore()
    .then((paypal) =>
      bounded(
        paypal.createInstance({
          clientId,
          components: ['paypal-payments'],
          pageType: 'checkout',
        }),
        'PayPal checkout took too long to initialize. You can retry or use the approval link.',
      ),
    )
    .then((instance) => {
      if (
        typeof instance.findEligibleMethods !== 'function' ||
        typeof instance.createPayPalOneTimePaymentSession !== 'function'
      )
        throw new Error('PayPal checkout is unavailable. You can use the approval link.')
      return instance
    })
  instancePromises.set(clientId, initializing)
  void initializing.catch(() => {
    if (instancePromises.get(clientId) === initializing) instancePromises.delete(clientId)
  })
  return initializing
}
