import { readFileSync } from 'node:fs'
import type { Alternative, Alternatives, AlternativesStatus } from '../shared/types.ts'

/**
 * Channel3 product search for "Similar items that fit today". Every call is made here, on the
 * server, with the key from the environment; the browser only ever sees the parsed results.
 *
 * Channel3 is told only a generic kind of item and a price band, never who is asking or why.
 * Results are cached per query and $25 price bucket, and a recorded set of example results is
 * served whenever Channel3 cannot answer (no credits, rate limited, timed out, down).
 */

export const CHANNEL3_API = 'https://api.trychannel3.com'
/** Every product image Worth shows is hosted here; images on retailer hosts are dropped. */
export const CHANNEL3_IMAGE_HOST = 'cdn.trychannel3.com'
/** Price ceilings are rounded down to this step, so a search can be reused across nearby budgets. */
export const PRICE_BUCKET_CENTS = 2500
/** The most results the panel shows. */
export const MAX_ALTERNATIVES = 4
const REQUEST_LIMIT = 12
const CACHE_TTL_MS = 6 * 60 * 60_000
const CACHE_MAX = 500
const TIMEOUT_MS = 4000
/** How long live calls pause after a failure, before Channel3 is tried again. */
const BACKOFF_MS = { auth: 6 * 60 * 60_000, rate: 60_000, other: 30_000 }
const DAY_MS = 24 * 60 * 60_000

/** The search's price ceiling: the amount rounded down to $25. */
export const priceBucket = (cents: number) =>
  Math.max(0, Math.floor(cents / PRICE_BUCKET_CENTS) * PRICE_BUCKET_CENTS)
/**
 * Results below a quarter of the ceiling are left out: they are rarely the same kind of item (a
 * $20 strap for a camera search) and catch offers listed at a placeholder price.
 */
export const priceFloor = (bucketCents: number) =>
  Math.max(500, Math.floor(bucketCents / 4 / 100) * 100)

/** The raw search response, recorded for fixtures; only the fields the parser reads are kept. */
export interface RawProduct {
  id?: unknown
  title?: unknown
  brands?: { name?: unknown }[] | null
  images?: { url?: unknown; cleaned_url?: unknown; is_main_image?: unknown }[] | null
  offers?:
    | {
        url?: unknown
        domain?: unknown
        price?: { price?: unknown; currency?: unknown } | null
        availability?: unknown
        condition?: unknown
      }[]
    | null
}
export interface RawSearch {
  products?: RawProduct[]
}
export interface FixtureSearch {
  kind: 'search' | 'similar'
  /** The query, or the source product ID for a similar-products search. */
  query: string
  minPriceCents: number
  maxPriceCents: number
  response: RawSearch
}
export interface Channel3Fixtures {
  recordedAt: string
  searches: FixtureSearch[]
}

export interface Channel3Options {
  apiKey?: string
  /** live (the default with a key), fixture (recorded examples only) or off. */
  mode?: 'live' | 'fixture' | 'off'
  /** Live searches per day across the server; beyond it, recorded examples are shown. */
  dailyLimit?: number
  fixtures?: Channel3Fixtures
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
  /** Operational log: status codes and timings only, never the key. */
  log?: (event: Record<string, unknown>) => void
}
export interface Channel3Client {
  /** Products like `query` priced at or below the bucketed ceiling. */
  search(query: string, maxPriceCents: number): Promise<Alternatives>
  /** Products like a known Channel3 product, priced at or below the bucketed ceiling. */
  similar(productId: string, maxPriceCents: number): Promise<Alternatives>
  /** ok: live searches run. fixture: recorded examples are being served. off: hidden. */
  health(): AlternativesStatus
}

export class Channel3Error extends Error {
  override name = 'Channel3Error'
  constructor(
    readonly status: number | undefined,
    message: string,
  ) {
    super(message)
  }
}

const clean = (value: unknown, max: number) => {
  if (typeof value !== 'string') return undefined
  // Control and bidirectional-override characters never reach the page.
  const text = value
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return undefined
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}
function httpsUrl(value: unknown, host?: (hostname: string) => boolean) {
  if (typeof value !== 'string' || value.length > 2000) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return undefined
    if (host && !host(url.hostname)) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}
const onChannel3Cdn = (hostname: string) => hostname === CHANNEL3_IMAGE_HOST
const retailerName = (domain: unknown) => {
  const text =
    typeof domain === 'string'
      ? domain
          .trim()
          .toLowerCase()
          .replace(/^www\./, '')
      : ''
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(text) && text.length <= 80 ? text : undefined
}

/**
 * Turns a search response into at most four alternatives. Each keeps its cheapest in-stock, new,
 * USD offer inside the price band; products without one, without a usable link, or whose other
 * offers cost over three times as much, are dropped.
 */
export function parseProducts(
  raw: RawSearch,
  band: { minPriceCents: number; maxPriceCents: number },
): Alternative[] {
  const items: Alternative[] = []
  const titles = new Set<string>()
  for (const product of Array.isArray(raw?.products) ? raw.products : []) {
    const id = typeof product?.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(product.id)
    const title = clean(product?.title, 120)
    if (!id || !title || titles.has(title.toLowerCase())) continue
    let best: Pick<Alternative, 'priceCents' | 'url' | 'retailer'> | undefined
    for (const offer of Array.isArray(product.offers) ? product.offers : []) {
      const price = offer?.price?.price
      if (typeof price !== 'number' || !Number.isFinite(price)) continue
      const cents = Math.round(price * 100)
      const retailer = retailerName(offer.domain)
      const url = httpsUrl(offer.url)
      if (
        offer.price?.currency !== 'USD' ||
        offer.availability !== 'InStock' ||
        (offer.condition != null && offer.condition !== 'new') ||
        cents < band.minPriceCents ||
        cents > band.maxPriceCents ||
        !retailer ||
        !url
      )
        continue
      if (!best || cents < best.priceCents) best = { priceCents: cents, url, retailer }
    }
    // A listing far below the product's other prices is usually a mis-read price, not a deal.
    const others = (Array.isArray(product.offers) ? product.offers : []).flatMap((offer) =>
      offer?.price?.currency === 'USD' && typeof offer.price.price === 'number'
        ? [Math.round(offer.price.price * 100)]
        : [],
    )
    if (!best || others.some((cents) => cents > best!.priceCents * 3)) continue
    const images = Array.isArray(product.images) ? product.images : []
    const ordered = [...images.filter((i) => i?.is_main_image === true), ...images]
    const imageUrl = ordered
      .flatMap((image) => [image?.cleaned_url, image?.url])
      .map((url) => httpsUrl(url, onChannel3Cdn))
      .find(Boolean)
    const brand = clean(product.brands?.[0]?.name, 60)
    titles.add(title.toLowerCase())
    items.push({
      id: product.id as string,
      title,
      retailer: best.retailer,
      ...(brand ? { brand } : {}),
      priceCents: best.priceCents,
      url: best.url,
      ...(imageUrl ? { imageUrl } : {}),
      availability: 'InStock',
      source: 'channel3',
    })
    if (items.length === MAX_ALTERNATIVES) break
  }
  return items
}

/** The request for one search: a generic query (or source product) inside a price band, US only. */
export function requestBody(
  kind: FixtureSearch['kind'],
  query: string,
  band: { minPriceCents: number; maxPriceCents: number },
) {
  return {
    ...(kind === 'search' ? { query } : { product_id: query }),
    limit: REQUEST_LIMIT,
    filters: {
      price: { min_price: band.minPriceCents / 100, max_price: band.maxPriceCents / 100 },
      availability: ['InStock'],
      conditions: ['new'],
    },
    config: { country: 'US', currency: 'USD' },
  }
}

/** Reads the recorded example results shipped with the app. */
export function loadFixtures(
  path = new URL('./fixtures/channel3.json', import.meta.url),
): Channel3Fixtures | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Channel3Fixtures
  } catch {
    return undefined
  }
}

export function createChannel3(options: Channel3Options = {}): Channel3Client {
  const mode = options.mode ?? (options.apiKey ? 'live' : 'off')
  const fetcher = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  const dailyLimit = options.dailyLimit ?? 300
  const fixtures = options.fixtures?.searches ?? []
  const log = options.log ?? ((event) => console.warn('Worth Channel3:', JSON.stringify(event)))
  const cache = new Map<string, { value: Alternatives; until: number }>()
  const inFlight = new Map<string, Promise<Alternatives>>()
  let blockedUntil = 0
  let day = { start: 0, count: 0 }
  const live = mode === 'live' && Boolean(options.apiKey)

  type Band = { minPriceCents: number; maxPriceCents: number }
  /**
   * Recorded results for a query: the same query first, then one for the same kind of thing (its
   * last word, such as "camera"), so a search phrased differently still shows examples.
   */
  function fixtureFor(kind: FixtureSearch['kind'], query: string, band: Band): Alternatives {
    const said = new Set(query.toLowerCase().split(/\s+/))
    const head = (recorded: FixtureSearch) => recorded.query.toLowerCase().split(/\s+/).at(-1)!
    const candidates = fixtures.filter((recorded) => recorded.kind === kind)
    for (const recorded of [
      ...candidates.filter((r) => r.query === query),
      ...(kind === 'search' ? candidates.filter((r) => said.has(head(r))) : []),
    ]) {
      const items = parseProducts(recorded.response, band)
      if (items.length)
        return { status: 'fixture', query, maxPriceCents: band.maxPriceCents, items }
    }
    return { status: 'off', query, maxPriceCents: band.maxPriceCents, items: [] }
  }
  function underDailyLimit() {
    const time = now()
    if (time - day.start >= DAY_MS) day = { start: time, count: 0 }
    if (day.count >= dailyLimit) return false
    day.count++
    return true
  }
  async function call(path: string, body: unknown): Promise<RawSearch> {
    const started = now()
    let response: Response
    try {
      response = await fetcher(`${CHANNEL3_API}${path}`, {
        method: 'POST',
        headers: { 'x-api-key': options.apiKey!, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const timeout = error instanceof Error && /timeout|abort/i.test(error.name)
      throw new Channel3Error(undefined, timeout ? 'timeout' : 'network')
    }
    log({ event: 'channel3_call', path, status: response.status, ms: now() - started })
    if (!response.ok) throw new Channel3Error(response.status, `HTTP ${response.status}`)
    return (await response.json()) as RawSearch
  }
  function backOff(error: unknown) {
    const status = error instanceof Channel3Error ? error.status : undefined
    const wait =
      status === 401 || status === 402 || status === 403
        ? BACKOFF_MS.auth
        : status === 429
          ? BACKOFF_MS.rate
          : BACKOFF_MS.other
    blockedUntil = now() + wait
    log({
      event: 'channel3_unavailable',
      status: status ?? (error instanceof Error ? error.message : 'error'),
      retryInMs: wait,
    })
  }
  async function run(
    kind: FixtureSearch['kind'],
    query: string,
    maxPriceCents: number,
    body: (band: Band) => unknown,
  ): Promise<Alternatives> {
    const bucket = priceBucket(maxPriceCents)
    const band = { minPriceCents: priceFloor(bucket), maxPriceCents: bucket }
    const none: Alternatives = { status: 'off', query, maxPriceCents: bucket, items: [] }
    if (mode === 'off' || bucket < PRICE_BUCKET_CENTS) return none
    if (!live || now() < blockedUntil) return fixtureFor(kind, query, band)
    const key = `${kind}:${query}:${bucket}`
    const cached = cache.get(key)
    if (cached && cached.until > now()) return cached.value
    const pending = inFlight.get(key)
    if (pending) return pending
    if (!underDailyLimit()) return fixtureFor(kind, query, band)
    const promise = (async () => {
      try {
        const raw = await call(kind === 'search' ? '/v1/search' : '/v1/similar', body(band))
        const value: Alternatives = {
          status: 'ok',
          query,
          maxPriceCents: bucket,
          items: parseProducts(raw, band),
        }
        cache.delete(key)
        cache.set(key, { value, until: now() + CACHE_TTL_MS })
        while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
        return value
      } catch (error) {
        backOff(error)
        return fixtureFor(kind, query, band)
      } finally {
        inFlight.delete(key)
      }
    })()
    inFlight.set(key, promise)
    return promise
  }
  return {
    search: (query, maxPriceCents) =>
      run('search', query, maxPriceCents, (band) => requestBody('search', query, band)),
    similar: (productId, maxPriceCents) =>
      run('similar', productId, maxPriceCents, (band) => requestBody('similar', productId, band)),
    health() {
      if (mode === 'off') return 'off'
      if (live && now() >= blockedUntil) return 'ok'
      return fixtures.length ? 'fixture' : 'off'
    },
  }
}
