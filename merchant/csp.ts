import { PAYPAL_SOURCES } from '../server/csp.ts'

/**
 * The store's Content-Security-Policy: its own files plus PayPal's SDK v6 and Messages hosts, and
 * nothing else. Inline styles are allowed because PayPal's components set them; inline scripts
 * are not. Sent in development too: the store's client is a plain module with no injected scripts.
 */
export function merchantContentSecurityPolicy() {
  const paypal = PAYPAL_SOURCES.join(' ')
  return [
    "default-src 'self'",
    `script-src 'self' ${paypal}`,
    `connect-src 'self' ${paypal}`,
    `frame-src ${paypal}`,
    `img-src 'self' data: ${paypal}`,
    "style-src 'self' 'unsafe-inline'",
    `font-src 'self' data: ${paypal}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}
