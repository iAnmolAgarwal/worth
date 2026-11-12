import type { Product } from '../shared/types.ts'
import { CATALOG, formatPrice, STORE_NAME } from './catalog.ts'
import type { ResultPayload } from '../shared/handoff.ts'

/**
 * Server-rendered pages. Markup uses BEM-style `lk-` classes and every colour, size and font comes
 * from tokens in merchant/public/store.css, so a restyle is a stylesheet swap.
 */
const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}
export function esc(value: string | number) {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]!)
}

export interface PageOptions {
  /** The client bundle's URL: built in production, served by Vite in development. */
  scriptSrc: string
  /** The <worth-check> module's URL, the same way; loaded on product pages only. */
  worthCheckSrc?: string
  /** Keeps `?replay=video` on in-store links so the demo stays in replay. */
  replay?: boolean
}

function layout(title: string, main: string, options: PageOptions) {
  const home = options.replay ? '/?replay=video' : '/'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="data:,">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/static/store.css">
<script type="module" src="${esc(options.scriptSrc)}"></script>
${
  options.worthCheckSrc
    ? `<script type="module" src="${esc(options.worthCheckSrc)}"></script>
`
    : ''
}</head>
<body class="lk">
<header class="lk-header">
  <a class="lk-header__brand" href="${home}">${MARK}<span class="lk-header__name">${esc(STORE_NAME)}</span></a>
  <span class="lk-header__tag">Demo store</span>
  <nav class="lk-header__nav" aria-label="Store"><a href="${home}">All products</a></nav>
</header>
<main class="lk-main">
${main}
</main>
<footer class="lk-footer">
  <p class="lk-footer__note">${esc(STORE_NAME)} is a demo store · PayPal sandbox · nothing ships</p>
  <p class="lk-footer__fine">${esc(STORE_NAME)} is a fictional store for a hackathon demo. Payments run in PayPal’s sandbox with test accounts only.</p>
</footer>
</body>
</html>
`
}

/** The store's sprig mark, drawn inline so it follows the stylesheet's colours. */
const MARK = `<svg class="lk-header__mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 22V9"/><circle cx="12" cy="5" r="2.2"/><circle cx="8.2" cy="9.2" r="1.9"/><circle cx="15.8" cy="9.2" r="1.9"/><circle cx="9" cy="13.6" r="1.6"/><circle cx="15" cy="13.6" r="1.6"/></svg>`

function productHref(product: Product, replay?: boolean) {
  return `/p/${encodeURIComponent(product.id)}${replay ? '?replay=video' : ''}`
}

/** "No. 02": the item's stock number, from its place in the catalog. */
export function stockNumber(product: Product) {
  return `No. ${String(CATALOG.indexOf(product) + 1).padStart(2, '0')}`
}

function card(product: Product, replay?: boolean) {
  return `  <li class="lk-card">
    <a class="lk-card__link" href="${esc(productHref(product, replay))}">
      <span class="lk-card__media" style="--lk-swatch: ${esc(product.color)}"><img class="lk-card__image" src="${esc(product.image)}" alt="" width="480" height="360" loading="lazy"></span>
      <span class="lk-card__no">${esc(stockNumber(product))}</span>
      <span class="lk-card__category">${esc(product.category)}</span>
      <span class="lk-card__name">${esc(product.name)}</span>
      <span class="lk-card__price">${esc(formatPrice(product.priceCents))}</span>
    </a>
  </li>`
}

export function catalogPage(options: PageOptions) {
  return layout(
    STORE_NAME,
    `<section class="lk-catalog">
  <div class="lk-catalog__head">
    <h1 class="lk-catalog__title">Everyday things, made to last</h1>
    <p class="lk-catalog__count">${CATALOG.length} products</p>
  </div>
  <ul class="lk-catalog__grid">
${CATALOG.map((product) => card(product, options.replay)).join('\n')}
  </ul>
</section>`,
    options,
  )
}

/** "Fri, Oct 23" for a calendar date, read as that date wherever the server runs. */
export function shortDate(date: string) {
  const parsed = new Date(`${date}T12:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return undefined
  return parsed.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

/** The one line a verified Worth result may add beside the PayPal button (contract §4). */
export function resultLine(result: ResultPayload): string | undefined {
  if (result.verdict === 'buy_today') return 'Worth: fits today'
  if (result.verdict === 'wait') {
    const date = result.fitsOn ? shortDate(result.fitsOn) : undefined
    return date ? `Worth: fits on ${date}` : 'Worth: suggests waiting'
  }
  return 'Worth: suggests spending less'
}

export interface ProductView {
  product: Product
  /** The signed quote for the Analyse link, minted at render. */
  quote: { token: string; exp: number }
  worthOrigin: string
  paypalClientId?: string
  /** A verified result's line, or nothing. */
  worthLine?: string
}

export function productPage(view: ProductView, options: PageOptions) {
  const { product, quote } = view
  const amount = (product.priceCents / 100).toFixed(2)
  const worthHref = `${view.worthOrigin}/check#q=${quote.token}`
  const refresh = `/api/worth-quote?productId=${encodeURIComponent(product.id)}${options.replay ? '&replay=video' : ''}`
  const worthAttributes = `href="${esc(worthHref)}" merchant="${esc(STORE_NAME)}" amount="${esc(amount)}" refresh-url="${esc(refresh)}"`
  // Without JavaScript, the plain same-tab link inside <worth-check> still goes to Worth. In swipe
  // mode it sits in a slot the element never draws, so with JavaScript only PayPal's button shows.
  const noScript = (slot = '') =>
    `<a class="worth-check"${slot} href="${esc(worthHref)}">Analyse with Worth</a>`
  // With PayPal, <worth-check mode="swipe"> wraps PayPal's own button and docks Worth's W tab on its
  // right edge (shared/worthSwipe.ts); without it, the outline link has the row to itself.
  const paypal = view.paypalClientId
    ? `<div class="lk-buy__paypal" data-slot="paypal">
        <worth-check mode="swipe" ${worthAttributes}><paypal-button class="lk-buy__button" type="pay" hidden></paypal-button>${noScript(' slot="fallback"')}</worth-check>
        <p class="lk-buy__status" role="status">Loading PayPal…</p>
      </div>
      <div class="lk-buy__message">
        <paypal-message auto-bootstrap="true" amount="${esc(amount)}" currency-code="USD" offer-types="PAY_LATER_SHORT_TERM"></paypal-message>
      </div>`
    : `<p class="lk-buy__status lk-buy__status--off" role="status">PayPal sandbox is not configured on this store.</p>`
  return layout(
    `${product.name} · ${STORE_NAME}`,
    `<article class="lk-product">
  <nav class="lk-product__back" aria-label="Breadcrumb"><a href="${options.replay ? '/?replay=video' : '/'}">All products</a><span class="lk-product__crumb">${esc(product.category)}</span></nav>
  <div class="lk-product__media" style="--lk-swatch: ${esc(product.color)}">
    <img class="lk-product__image" src="${esc(product.image)}" alt="${esc(product.name)}" width="960" height="720">
  </div>
  <div class="lk-product__info">
    <p class="lk-product__category"><span class="lk-product__no">${esc(stockNumber(product))}</span>${esc(product.category)}</p>
    <h1 class="lk-product__name">${esc(product.name)}</h1>
    ${product.subtitle ? `<p class="lk-product__subtitle">${esc(product.subtitle)}</p>` : ''}
    <p class="lk-product__price">${esc(formatPrice(product.priceCents))}</p>
    <p class="lk-product__description">${esc(product.description)}</p>
    <section class="lk-buy" id="checkout" aria-label="Checkout"
      data-product-id="${esc(product.id)}"
      data-amount="${esc(amount)}"
      data-client-id="${esc(view.paypalClientId ?? '')}">
      ${paypal}
      ${view.worthLine ? `<p class="lk-buy__worth-result">${esc(view.worthLine)}</p>` : ''}
      ${
        view.paypalClientId
          ? ''
          : `<div class="lk-buy__worth" data-slot="worth-check">
        <worth-check ${worthAttributes}>${noScript()}</worth-check>
      </div>`
      }
      <p class="lk-buy__error" role="alert" hidden></p>
    </section>
    <dl class="lk-facts">
      <div class="lk-facts__row"><dt>Category</dt><dd>${esc(product.category)}</dd></div>
      <div class="lk-facts__row"><dt>Sold by</dt><dd>${esc(STORE_NAME)}</dd></div>
      <div class="lk-facts__row"><dt>Payment</dt><dd>PayPal sandbox</dd></div>
      <div class="lk-facts__row"><dt>Shipping</dt><dd>Demo store, nothing ships</dd></div>
    </dl>
    <section class="lk-thanks" id="thanks" tabindex="-1" hidden>
      <h2 class="lk-thanks__title">Thank you for your order</h2>
      <p class="lk-thanks__body">PayPal confirmed your sandbox payment for ${esc(product.name)}. This is a demo store, so nothing ships.</p>
      <p class="lk-thanks__ref">Order <span class="lk-thanks__order"></span></p>
      <a class="lk-thanks__more" href="${options.replay ? '/?replay=video' : '/'}">Keep browsing</a>
    </section>
  </div>
</article>
<section class="lk-more">
  <h2 class="lk-more__title">More from ${esc(STORE_NAME)}</h2>
  <ul class="lk-catalog__grid lk-more__grid">
${CATALOG.filter((other) => other !== product)
  .slice(0, 4)
  .map((other) => card(other, options.replay))
  .join('\n')}
  </ul>
</section>`,
    options,
  )
}

export function notFoundPage(options: PageOptions) {
  return layout(
    `Not found · ${STORE_NAME}`,
    `<section class="lk-empty">
  <h1 class="lk-empty__title">We couldn’t find that product</h1>
  <a class="lk-empty__link" href="/">See all products</a>
</section>`,
    options,
  )
}
