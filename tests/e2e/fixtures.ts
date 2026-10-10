import { randomInt } from 'node:crypto'
import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { createHandoff, type QuotePayload } from '../../shared/handoff.ts'

/** Where the store's page loads PayPal's SDK from (src/paypalSdk.ts). */
const PAYPAL_SDK_URL = 'https://www.sandbox.paypal.com/web-sdk/v6/core'

/**
 * The browser's half of the fake PayPal (the store's server has fakePayPal.ts): `window.paypal`
 * with the SDK v6 surface the store uses, served at the SDK's own URL. Its button is a plain
 * element; a click starts the session, which waits for the store's own order and approves it.
 */
const PAYPAL_SDK_STUB = `
customElements.define('paypal-button', class extends HTMLElement {
  connectedCallback() { this.setAttribute('role', 'button'); this.textContent = 'PayPal (test)' }
})
customElements.define('paypal-message', class extends HTMLElement {})
window.paypal = {
  createInstance: async () => ({
    createPayPalMessages: () => ({}),
    findEligibleMethods: async () => ({
      isEligible: () => true,
      getDetails: () => ({ productCode: 'PAY_LATER_SHORT_TERM', countryCode: 'US' }),
    }),
    createPayPalOneTimePaymentSession: (callbacks) => ({
      hasReturned: () => false,
      resume: async () => {},
      start: async (_options, order) => {
        const { orderId } = await order
        await callbacks.onApprove({ orderId, payerId: 'E2EPAYER' })
      },
    }),
  }),
}
`

/**
 * Runs before any page script on both origins: reports every window.open call and every CSP
 * violation to the test, so a flow that tried a popup or broke the policy fails.
 */
const GUARDS = `
{
  const open = window.open
  window.open = function (...args) {
    window.__e2eReport('window.open', String(args[0] ?? ''))
    return open.apply(this, args)
  }
  document.addEventListener('securitypolicyviolation', (event) =>
    window.__e2eReport('csp', event.violatedDirective + ' ' + event.blockedURI),
  )
}
`

export interface Origins {
  worth: string
  store: string
  /** A Worth with the hand-off off: no HANDOFF_SECRET or MERCHANT_ORIGIN. */
  worthOff: string
}
function env(name: string) {
  const value = process.env[name]
  if (!value)
    throw new Error(`${name} is not set; run Playwright through tests/e2e/global-setup.ts.`)
  return value
}
export const origins: Origins = {
  get worth() {
    return env('E2E_WORTH')
  },
  get store() {
    return env('E2E_STORE')
  },
  get worthOff() {
    return env('E2E_WORTH_OFF')
  },
}

/** What a context's guards saw; checked when the test ends. */
interface Seen {
  popups: string[]
  csp: string[]
}

/**
 * A shopper: one browser context with its own cookies on both origins and its own address (so
 * Worth's and the store's per-IP limits never carry over between tests), PayPal's SDK faked, and
 * popup and CSP guards on every page.
 */
async function shopperContext(browser: Browser, testInfo: TestInfo, seen: Seen) {
  const { viewport, hasTouch, isMobile, userAgent, deviceScaleFactor } = testInfo.project.use
  const context = await browser.newContext({
    viewport,
    hasTouch,
    isMobile,
    userAgent,
    deviceScaleFactor,
    extraHTTPHeaders: { 'X-Forwarded-For': `198.18.${randomInt(256)}.${randomInt(1, 255)}` },
  })
  await context.exposeBinding('__e2eReport', (_source, kind: string, detail: string) => {
    if (kind === 'window.open') seen.popups.push(detail)
    else seen.csp.push(detail)
  })
  await context.addInitScript(GUARDS)
  context.on('console', (message) => {
    if (/Content[- ]Security[- ]Policy/i.test(message.text())) seen.csp.push(message.text())
  })
  await context.route('https://*.paypal.com/**', (route) =>
    route.request().url() === PAYPAL_SDK_URL
      ? route.fulfill({ contentType: 'text/javascript', body: PAYPAL_SDK_STUB })
      : route.abort(),
  )
  await context.route('https://*.paypalobjects.com/**', (route) => route.abort())
  return context
}

export const test = base.extend<{
  /** The first shopper's page. */
  page: Page
  /** Another shopper, with their own cookies and address. */
  newShopper: () => Promise<Page>
}>({
  // Playwright's fixture callback is named `provide` here so lint doesn't take it for React's use().
  newShopper: async ({ browser }, provide, testInfo) => {
    const contexts: BrowserContext[] = []
    const seen: Seen = { popups: [], csp: [] }
    await provide(async () => {
      const context = await shopperContext(browser, testInfo, seen)
      contexts.push(context)
      return context.newPage()
    })
    for (const context of contexts) await context.close()
    // Same tab everywhere: nothing in the flow opens a window, so there is no popup to block.
    expect(seen.popups, 'window.open calls').toEqual([])
    expect(seen.csp, 'Content-Security-Policy violations').toEqual([])
  },
  page: async ({ newShopper }, provide) => {
    await provide(await newShopper())
  },
})
export { expect }

/** The test HANDOFF_SECRET both servers share: for tokens a store couldn't mint today. */
export function testHandoff(now = Date.now) {
  return createHandoff({
    secret: env('E2E_HANDOFF_SECRET'),
    mid: 'larkspur',
    merchantOrigin: origins.store,
    now,
  })
}

/** A quote token's claims, read without verifying (the test minted or received it). */
export function claims(token: string): QuotePayload {
  return JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'))
}

export const CAMERA = 'From Larkspur Supply · Everyday camera · $1,199.00'

const tokenOf = (href: string | null) => decodeURIComponent(new URL(href!).hash.slice(3))

/**
 * The store's Analyse link on a product page, and its token, once settled: <worth-check> asks the
 * store's PayPal SDK about Pay in 4 and swaps in a fresh quote that carries the yes (§3.2).
 */
export async function analyseLink(page: Page, productId = 'camera') {
  await page.goto(`${origins.store}/p/${productId}`)
  const link = page.locator('worth-check').getByRole('link', { name: /Analyse with Worth/ })
  await expect(link).toBeVisible()
  await expect
    .poll(async () => claims(tokenOf(await link.getAttribute('href'))).payLater)
    .toEqual({ eligible: true, source: 'merchant-sdk' })
  const href = (await link.getAttribute('href'))!
  return { link, href, token: tokenOf(href) }
}

/** Store product page → Analyse with Worth → /check with the store's quote shown. */
export async function analyse(page: Page, productId = 'camera') {
  const { link, token } = await analyseLink(page, productId)
  // A real link in the same tab: no target, no popup.
  expect(await link.getAttribute('target')).toBeNull()
  await link.click()
  await page.waitForURL(`${origins.worth}/check`)
  return { qid: claims(token).qid }
}

export function consentBox(page: Page) {
  return page.getByRole('checkbox', { name: /Let Larkspur Supply tell Worth if I buy this/ })
}

/** Ticks report-back consent and waits for Worth to record it. */
export async function consent(page: Page) {
  const box = consentBox(page)
  await expect(box).not.toBeChecked()
  const recorded = page.waitForResponse(
    (response) => response.url().endsWith('/api/handoff/consent') && response.ok(),
  )
  await box.check()
  await recorded
}

/** Worth → Back to Larkspur Supply → the store's product page. */
export async function backToStore(page: Page, productId = 'camera') {
  await page.getByRole('link', { name: 'Back to Larkspur Supply' }).click()
  // The store removes the result token from the address bar once it has read it.
  await page.waitForURL(`${origins.store}/p/${productId}`)
  await expect(page.locator('paypal-button')).toBeVisible()
}

export function worthLine(page: Page) {
  return page.locator('.lk-buy__worth-result')
}

/** "Pays" with the fake PayPal button; returns the store's order ID once the store says thanks. */
export async function pay(page: Page) {
  await page.getByRole('button', { name: 'PayPal (test)' }).click()
  await expect(page.getByRole('heading', { name: 'Thank you for your order' })).toBeVisible()
  return (await page.locator('.lk-thanks__order').textContent())!
}

/** Worth's API as this shopper's browser calls it, with its cookie. */
export async function worthApi<T>(page: Page, path: string, body?: object): Promise<T> {
  const url = `${origins.worth}/api${path}`
  const response = body
    ? await page.request.post(url, {
        data: body,
        headers: { 'X-Worth-Client': 'web', Origin: origins.worth },
      })
    : await page.request.get(url)
  expect(response.ok(), `${path} answered ${response.status()}`).toBe(true)
  return (await response.json()) as T
}

/** The lowest the plan's balance goes if nothing more is bought today. */
export async function lowestBalance(page: Page) {
  const comparison = await worthApi<{ buyToday: { lowestBalanceCents: number } }>(
    page,
    '/compare',
    { amountCents: 0, itemName: 'Room to spend' },
  )
  return comparison.buyToday.lowestBalanceCents
}

/** Activity rows for Larkspur's reported payments, read from the page. */
export function reportedRows(page: Page) {
  return page.locator('.row').filter({ hasText: 'Payment to Larkspur Supply · PayPal' })
}

/** Payments stores reported into this shopper's plan. */
export async function reported(page: Page) {
  const state = await worthApi<{ purchases: { reportedBy?: string }[] }>(page, '/state')
  return state.purchases.filter((purchase) => purchase.reportedBy).length
}

/** Waits, by polling and never by sleeping, until Worth has this shopper's reported payment. */
export async function reportLanded(page: Page) {
  await expect.poll(() => reported(page), { timeout: 15_000 }).toBe(1)
}
