import { payIn4Offer, type PayLaterAnswer } from './payLater.ts'
import { SWIPE_STYLE, SwipeControl } from './worthSwipe.ts'

/**
 * `<worth-check>`: the store's "Analyse with Worth" link, next to its PayPal button
 * (specs/handoff-contract.md §3.1–§3.2, C2). No framework and no runtime dependency: the store's
 * build bundles it into worth-check.js, which a store serves as a module script.
 *
 * Attributes:
 * - `href`: the signed Worth link the store's server minted, `{WORTH_ORIGIN}/check#q={token}`;
 * - `merchant`: the store's name, for the link's description;
 * - `amount`: the price in US dollars as PayPal writes it, such as `1199.00`;
 * - `refresh-url` (optional): the store's own endpoint for a fresh link, answering `{ href }`;
 * - `mode` (optional): `swipe` wraps the store's PayPal button, slotted as the element's child, and
 *   docks Worth's W tab on its right edge (shared/worthSwipe.ts). Without it, the outline link.
 *
 * The page's PayPal SDK v6 instance (or a promise of one) goes in the `paypal` property. With it,
 * the element asks the store's own SDK whether Pay in 4 is offered for the amount, and refreshes
 * the link when the answer differs from the one signed into it. It never opens a window and
 * shows no PayPal artwork. Only the store's server signs; this file holds no secret. Its default
 * look is an outline button; see STYLE for the five properties a store may override.
 */

/** The part of PayPal's v6 SDK instance this element uses. */
export interface EligibilitySource {
  findEligibleMethods(options: { currencyCode: 'USD'; amount?: string }): Promise<PayLaterAnswer>
}

/** Refresh this long before the link expires. */
export const REFRESH_BEFORE_S = 60
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/

/**
 * By default a quiet outline pill that sits under the PayPal button without competing with it:
 * white, with a 1px border and text in Worth's own ink (src/index.css --c-text), PayPal's button
 * typography and its 45px height, full width, no mark. Stores may override exactly five custom
 * properties (contract §3.1): `--worth-check-bg`, `--worth-check-bg-hover`,
 * `--worth-check-border` (a colour), `--worth-check-ink` and `--worth-check-radius`.
 */
const STYLE = `
:host {
  display: block;
  width: 100%;
}
:host([hidden]) {
  display: none;
}
a {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 45px;
  padding: 0 16px;
  border: 1px solid var(--worth-check-border, #2c2e2f);
  border-radius: var(--worth-check-radius, 23px);
  background: var(--worth-check-bg, #ffffff);
  color: var(--worth-check-ink, #2c2e2f);
  font: 400 16px/1 'Helvetica Neue', Helvetica, Arial, sans-serif;
  letter-spacing: 0;
  text-transform: none;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
}
a:hover {
  background: var(--worth-check-bg-hover, #f0f2f9);
}
a:focus-visible {
  outline: 3px solid #097ff5;
  outline-offset: 2px;
}
a[aria-busy='true'] {
  opacity: 0.8;
}
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
`

/** The claims the element reads from its own link; it never verifies them (the server does). */
export function linkClaims(href: string | null): { exp?: number; payLater?: boolean } | undefined {
  if (!href) return undefined
  try {
    const token = new URL(href).hash.replace(/^#q=/, '')
    if (!TOKEN.test(token)) return undefined
    const body = token.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/')
    const json = JSON.parse(atob(body.padEnd(Math.ceil(body.length / 4) * 4, '='))) as {
      exp?: unknown
      payLater?: { eligible?: unknown }
    }
    return {
      ...(typeof json.exp === 'number' ? { exp: json.exp } : {}),
      ...(typeof json.payLater?.eligible === 'boolean' ? { payLater: json.payLater.eligible } : {}),
    }
  } catch {
    return undefined
  }
}

/** A link the element may render: http(s) only, so no `javascript:` link can be planted. */
function safeHref(value: string | null) {
  if (!value) return undefined
  try {
    const url = new URL(value, document.baseURI)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether PayPal offers Pay in 4 for the amount, from the store's own SDK: true, or undefined when
 * the answer can't say. A "no" is never signed: before the shopper logs in to PayPal, the sandbox
 * answers `isEligible('paylater') === false` even for $1,199 while PayPal Messages on the same page
 * offers Pay in 4, so a signed false would make Worth contradict PayPal's own message.
 */
export async function payIn4Offered(source: EligibilitySource, amount: string) {
  return payIn4Offer(await source.findEligibleMethods({ currencyCode: 'USD', amount }))
    ? true
    : undefined
}

export class WorthCheck extends HTMLElement {
  static observedAttributes = ['href', 'merchant', 'amount', 'mode']
  /** Leaves for Worth in the same tab; a seam so tests can watch it. */
  static go = (url: string) => window.location.assign(url)
  /** Seconds since the epoch; a seam for tests. */
  static now = () => Math.floor(Date.now() / 1000)

  private link!: HTMLAnchorElement
  private description: HTMLSpanElement
  private swipe?: SwipeControl
  private source?: EligibilitySource | Promise<EligibilitySource>
  /** The store's SDK answer for the current amount: undefined until known, or when unclear. */
  private offered?: boolean
  private refreshing?: Promise<void>

  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
    this.description = document.createElement('span')
    this.description.className = 'sr'
    this.description.id = 'worth-check-description'
    this.build()
  }

  /** Draws the outline link, or the swipe row around the store's PayPal button. */
  private build() {
    this.swipe?.disconnect()
    this.swipe =
      this.getAttribute('mode') === 'swipe' ? new SwipeControl(this, this.follow) : undefined
    const style = document.createElement('style')
    style.textContent = this.swipe ? SWIPE_STYLE : STYLE
    if (this.swipe) this.link = this.swipe.tab
    else {
      this.link = document.createElement('a')
      this.link.setAttribute('part', 'link')
      this.link.textContent = 'Analyse with Worth'
    }
    this.link.setAttribute('aria-describedby', this.description.id)
    this.link.addEventListener('click', (event) => this.onClick(event))
    this.shadowRoot!.replaceChildren(style, this.swipe?.box ?? this.link, this.description)
    if (this.swipe && this.isConnected) this.swipe.connect()
  }

  /** The page's PayPal SDK v6 instance, or a promise of one. */
  get paypal() {
    return this.source
  }
  set paypal(value: EligibilitySource | Promise<EligibilitySource> | undefined) {
    this.source = value
    void this.checkEligibility()
  }

  connectedCallback() {
    // A page may set `paypal` before this module loads; that own property would hide the setter.
    if (Object.prototype.hasOwnProperty.call(this, 'paypal')) {
      const value = (this as { paypal?: WorthCheck['paypal'] }).paypal
      delete (this as { paypal?: unknown }).paypal
      this.paypal = value
    }
    this.swipe?.connect()
    this.render()
    document.addEventListener('visibilitychange', this.onVisible)
  }
  disconnectedCallback() {
    this.swipe?.disconnect()
    document.removeEventListener('visibilitychange', this.onVisible)
  }
  attributeChangedCallback(name: string, previous: string | null, next: string | null) {
    if (name === 'mode' && (previous === 'swipe') !== (next === 'swipe')) this.build()
    this.render()
    if (name === 'amount' && previous !== next) {
      this.offered = undefined
      void this.checkEligibility()
    }
  }

  private render() {
    const href = safeHref(this.getAttribute('href'))
    // Without a usable link there is nothing to offer; the store's own checkout is unaffected. In
    // swipe mode the element holds PayPal's button, so only the tab goes.
    if (this.swipe) this.swipe.sync(Boolean(href))
    else this.hidden = !href
    if (href) this.link.href = href
    else this.link.removeAttribute('href')
    const merchant = this.getAttribute('merchant')?.trim()
    this.description.textContent = `Opens Worth to check when this fits your plan. You come back${merchant ? ` to ${merchant}` : ''} to pay.`
  }

  /** Close to expiry, so the link should be renewed before it is used. */
  private stale() {
    const exp = linkClaims(this.getAttribute('href'))?.exp
    return exp !== undefined && WorthCheck.now() >= exp - REFRESH_BEFORE_S
  }

  private onVisible = () => {
    if (document.visibilityState === 'visible' && this.stale()) void this.refresh()
  }

  private async onClick(event: MouseEvent) {
    // A new-tab click and a fresh link both go as they are; the browser follows the real link.
    if (
      !this.stale() ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return
    event.preventDefault()
    await this.follow()
  }

  /** Goes to Worth in the same tab, renewing a link close to expiry first. */
  private follow = async () => {
    if (this.stale()) await this.refresh()
    const href = safeHref(this.getAttribute('href'))
    if (href) WorthCheck.go(href)
  }

  private async checkEligibility() {
    const amount = this.getAttribute('amount')
    const source = this.source
    if (!source || !amount || !/^\d{1,7}(\.\d{2})?$/.test(amount)) return
    try {
      const offered = await payIn4Offered(await source, amount)
      // A later amount or SDK has taken over; its own check decides.
      if (this.getAttribute('amount') !== amount || this.source !== source) return
      this.offered = offered
    } catch {
      return
    }
    // Only a yes is ever signed, so only a yes on one side and not the other needs a new link.
    if ((linkClaims(this.getAttribute('href'))?.payLater === true) !== (this.offered === true))
      await this.refresh()
  }

  /** Asks the store for a fresh link, passing the store's SDK answer when known. */
  refresh(): Promise<void> {
    this.refreshing ??= this.fetchFresh().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async fetchFresh() {
    const endpoint = this.getAttribute('refresh-url')
    const current = safeHref(this.getAttribute('href'))
    if (!endpoint || !current) return
    this.link.setAttribute('aria-busy', 'true')
    try {
      const url = new URL(endpoint, document.baseURI)
      if (url.origin !== window.location.origin) return
      if (this.offered === true) url.searchParams.set('payLater', 'true')
      const response = await fetch(url, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) return
      const body = (await response.json()) as { href?: unknown }
      const next = typeof body.href === 'string' ? safeHref(body.href) : undefined
      // Only a link to the same Worth page replaces the current one.
      if (!next || !linkClaims(next)) return
      const [from, to] = [new URL(current), new URL(next)]
      if (from.origin !== to.origin || from.pathname !== to.pathname) return
      this.setAttribute('href', next)
    } catch {
      // The current link still works until it expires; Worth explains an expired one.
    } finally {
      this.link.removeAttribute('aria-busy')
    }
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('worth-check'))
  customElements.define('worth-check', WorthCheck)
