/**
 * `<worth-check>`: the store's "Analyse with Worth" link, next to its PayPal button
 * (specs/handoff-contract.md §3.1–§3.2, C2). Dependency-free and framework-free: a store serves it
 * as a module script (see worthCheckScript.ts) and themes it with CSS custom properties.
 *
 * Attributes:
 * - `href`: the signed Worth link the store's server minted, `{WORTH_ORIGIN}/check#q={token}`;
 * - `merchant`: the store's name, for the link's description;
 * - `amount`: the price in US dollars as PayPal writes it, such as `1199.00`;
 * - `refresh-url` (optional): the store's own endpoint for a fresh link, answering `{ href }`.
 *
 * The page's PayPal SDK v6 instance (or a promise of one) goes in the `paypal` property. With it,
 * the element asks the store's own SDK whether Pay in 4 is offered for the amount, and refreshes
 * the link when the answer differs from the one signed into it. It never opens a window and
 * shows no PayPal artwork. Only the store's server signs; this file holds no secret. Its default
 * look is Worth's own branded button; see STYLE for the five properties a store may override.
 */

/** The part of PayPal's v6 SDK instance this element uses. */
export interface EligibilitySource {
  findEligibleMethods(options: { currencyCode: 'USD'; amount?: string }): Promise<{
    isEligible(method: 'paylater'): boolean
    getDetails?(method: 'paylater'): { productCode?: string } | undefined
  }>
}

/** Refresh this long before the link expires. */
export const REFRESH_BEFORE_S = 60
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/

/** Worth's W (devpost-assets/worth-mark.svg): an italic W over an offset copy of itself. */
const W =
  'M2.136 9.729Q2 2 10 2L76 2Q84 2 83.777 9.812L77.733 221.071Q77.649 224 79.154 221.104L188.987 9.723Q193 2 201 2L247 2Q255 2 255.162 9.723L259.589 221.104Q259.649 224 261.026 221.071L360.328 9.812Q364 2 372 2L438 2Q446 2 442.01 9.729L282.208 319.304Q277.719 328 268.719 328L210.719 328Q201.719 328 201.234 319.393L191.001 137.869Q190.839 135 189.247 137.869L88.496 319.393Q83.719 328 74.719 328L16.719 328Q7.719 328 7.567 319.304Z'
/**
 * The mark for a dark fill: the back layer in PayPal blue, the front in white, and their overlap
 * in a pale blue so both layers still read at 18 px. Inline, so the element loads nothing.
 */
const MARK = [
  '<svg class="mark" viewBox="0 0 472 362" aria-hidden="true" focusable="false">',
  `<defs><clipPath id="front"><path d="${W}"/></clipPath></defs>`,
  `<path d="${W}" transform="translate(24 32)" fill="#009cde"/>`,
  `<path d="${W}" fill="#ffffff"/>`,
  `<g clip-path="url(#front)"><path d="${W}" transform="translate(24 32)" fill="#9bd8f2"/></g>`,
  '</svg>',
].join('')

/**
 * Branded by default, like PayPal's own button: a full-width navy pill a little shorter than
 * PayPal's, with the W mark. Stores may override exactly five custom properties (contract §3.1):
 * `--worth-check-bg`, `--worth-check-bg-hover`, `--worth-check-border` (a colour),
 * `--worth-check-ink` and `--worth-check-radius`.
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
  gap: 8px;
  width: 100%;
  height: 40px;
  padding: 0 16px;
  border: 1px solid var(--worth-check-border, #003087);
  border-radius: var(--worth-check-radius, 20px);
  background: var(--worth-check-bg, #003087);
  color: var(--worth-check-ink, #ffffff);
  font: 600 15px/1 'Helvetica Neue', Arial, system-ui, sans-serif;
  letter-spacing: 0.01em;
  text-transform: none;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
}
a:hover {
  background: var(--worth-check-bg-hover, #012169);
}
a:focus-visible {
  outline: 3px solid #009cde;
  outline-offset: 2px;
}
a[aria-busy='true'] {
  opacity: 0.8;
}
.mark {
  width: 23px;
  height: 18px;
  flex: none;
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

/** Whether PayPal offers Pay in 4 (not another Pay Later product) for the amount. */
export async function payIn4Offered(source: EligibilitySource, amount: string) {
  const methods = await source.findEligibleMethods({ currencyCode: 'USD', amount })
  if (!methods.isEligible('paylater')) return false
  const product = methods.getDetails?.('paylater')?.productCode
  return product === undefined || product === 'PAY_IN_4'
}

export class WorthCheck extends HTMLElement {
  static observedAttributes = ['href', 'merchant', 'amount']
  /** Leaves for Worth in the same tab; a seam so tests can watch it. */
  static go = (url: string) => window.location.assign(url)
  /** Seconds since the epoch; a seam for tests. */
  static now = () => Math.floor(Date.now() / 1000)

  private link: HTMLAnchorElement
  private description: HTMLSpanElement
  private source?: EligibilitySource | Promise<EligibilitySource>
  /** The store's SDK answer for the current amount, once known. */
  private offered?: boolean
  private refreshing?: Promise<void>

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = STYLE
    this.link = document.createElement('a')
    this.link.setAttribute('part', 'link')
    this.link.innerHTML = `${MARK}<span>Analyse with Worth</span>`
    this.description = document.createElement('span')
    this.description.className = 'sr'
    this.description.id = 'worth-check-description'
    this.link.setAttribute('aria-describedby', this.description.id)
    this.link.addEventListener('click', (event) => this.onClick(event))
    root.append(style, this.link, this.description)
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
    this.render()
    document.addEventListener('visibilitychange', this.onVisible)
  }
  disconnectedCallback() {
    document.removeEventListener('visibilitychange', this.onVisible)
  }
  attributeChangedCallback(name: string, previous: string | null, next: string | null) {
    this.render()
    if (name === 'amount' && previous !== next) {
      this.offered = undefined
      void this.checkEligibility()
    }
  }

  private render() {
    const href = safeHref(this.getAttribute('href'))
    // Without a usable link there is nothing to offer; the store's own checkout is unaffected.
    this.hidden = !href
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
    if (!this.stale() || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey)
      return
    event.preventDefault()
    await this.refresh()
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
    if (linkClaims(this.getAttribute('href'))?.payLater !== this.offered) await this.refresh()
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
      if (this.offered !== undefined) url.searchParams.set('payLater', String(this.offered))
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
