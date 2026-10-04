/** Hosts the PayPal JS SDK v6 loads from, talks to, frames and shows images from. */
export const PAYPAL_SOURCES = [
  'https://www.paypal.com',
  'https://www.sandbox.paypal.com',
  'https://*.paypal.com',
  'https://*.paypalobjects.com',
]

/**
 * Channel3 rehosts every product image Worth shows on its own CDN (images on retailer hosts are
 * dropped by the adapter), so one image host is enough and no image proxy is needed.
 */
export const CHANNEL3_IMAGES = 'https://cdn.trychannel3.com'

/**
 * The production Content-Security-Policy. Fonts are bundled with the app, so only 'self' and the
 * PayPal SDK domains are allowed. Inline styles are allowed because the SDK and the chart library
 * set them; inline scripts are not.
 */
export function contentSecurityPolicy() {
  const paypal = PAYPAL_SOURCES.join(' ')
  return [
    "default-src 'self'",
    `script-src 'self' ${paypal}`,
    `connect-src 'self' ${paypal}`,
    `frame-src 'self' ${paypal}`,
    `img-src 'self' data: ${paypal} ${CHANNEL3_IMAGES}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}
