import { plainText } from './text.ts'

/**
 * Pasted product links (C5). A link is only ever handed to Channel3's lookup: Worth's server never
 * fetches it, and neither the link nor anything read from its page is sent to Claude.
 */

export const LINK_MAX_LENGTH = 2048
/** Product titles from a lookup are shown for confirmation at this length or less. */
export const LINK_TITLE_MAX = 80

/** Hosts that name this machine or a private network, and are never looked up. */
const PRIVATE_SUFFIXES = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home.arpa', 'corp']

export type LinkCheck =
  | { ok: true; url: string; host: string }
  | { ok: false; reason: 'not-https' | 'too-long' | 'credentials' | 'private-host' | 'invalid' }

/**
 * Whether a pasted link may be looked up: https on the default port, at most 2,048 characters, no
 * user name or password, and a public domain name (never an IP address, localhost or a private
 * network name). The fragment is dropped; it never reaches the store.
 */
export function checkProductLink(raw: string): LinkCheck {
  const text = raw.trim()
  if (text.length > LINK_MAX_LENGTH) return { ok: false, reason: 'too-long' }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not-https' }
  if (url.username || url.password) return { ok: false, reason: 'credentials' }
  if (url.port) return { ok: false, reason: 'invalid' }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (
    // IPv6 literals keep their brackets in hostname; every IPv4 form ends in a number.
    host.startsWith('[') ||
    /^[\d.]+$/.test(host) ||
    /^0x/i.test(host.split('.').at(-1) ?? '') ||
    !host.includes('.') ||
    PRIVATE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
  )
    return { ok: false, reason: 'private-host' }
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)) return { ok: false, reason: 'invalid' }
  url.hash = ''
  return { ok: true, url: url.toString(), host }
}

/** The store's domain as shown: "shop.example.com" without a leading "www.". */
export const storeDomain = (host: string) => host.toLowerCase().replace(/^www\./, '')

/**
 * Links as people paste them: with a scheme, starting "www.", or a domain followed by a path
 * ("shop.com/p/123"). A bare word with a dot ("e.g.", "$1.5k", "Node.js") is not a link.
 */
export const LINK_PATTERN =
  /\bhttps?:\/\/[^\s<>"'`]+|\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>"'`]*|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\/[^\s<>"'`]*/gi

/** Sentence punctuation after a link is not part of it; a ")" is, when the link opened one. */
function trimLink(text: string) {
  let link = text
  for (;;) {
    if (/[.,;:!?\]'"]$/.test(link)) link = link.slice(0, -1)
    else if (link.endsWith(')') && link.split('(').length < link.split(')').length)
      link = link.slice(0, -1)
    else return link
  }
}

/**
 * The link in a composer message, when there is one. A message holding one link is a pasted
 * product (`one`, given a scheme when it had none); a message with several is `many`. Either way
 * it is never sent to Claude.
 */
export function linkIn(
  text: string,
): { kind: 'none' } | { kind: 'one'; url: string } | { kind: 'many' } {
  const found = text.match(new RegExp(LINK_PATTERN.source, 'gi')) ?? []
  if (!found.length) return { kind: 'none' }
  if (found.length > 1) return { kind: 'many' }
  const link = trimLink(found[0]!)
  return { kind: 'one', url: /^https?:\/\//i.test(link) ? link : `https://${link}` }
}

/** A title read from a store page, made safe to show and edit: plain text, at most 80 characters. */
export function productTitle(value: unknown, max = LINK_TITLE_MAX): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = plainText(value)
  if (!text) return undefined
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}
