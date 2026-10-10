import { readFileSync } from 'node:fs'
import { checkProductLink, productTitle, storeDomain } from '../shared/link.ts'
import type {
  Alternative,
  Alternatives,
  AlternativesStatus,
  ProductLookup,
  UnverifiedAlternative,
} from '../shared/types.ts'

/**
 * Channel3 product search for "Similar items that fit today". Every call is made here, on the
 * server, with the key from the environment; the browser only ever sees the parsed results.
 *
 * Channel3 is told only a generic kind of item and a price band, never who is asking or why.
 * Results are cached per query and $25 price bucket, and a recorded set of example results is
 * served whenever Channel3 cannot answer (no credits, rate limited, timed out, down).
 *
 * Channel3 asks that prices and offer links are never served from a cache without refreshing
 * them. Recorded rows, and cached rows older than 15 minutes, are re-read with the free
 * GET /v1/products/{id} before they are shown; a row that cannot be re-read is shown without its
 * price or link.
 *
 * Pasted product links (C5) go to POST /v1/lookup. Worth never fetches the link itself; Channel3
 * reads the page and returns its catalog product, and only the store's own offer is used. Lookups
 * share the searches' daily budget, per-client allowance and back-off.
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
/** Offers younger than this are shown as found; older ones are re-read before display. */
const FRESH_MS = 15 * 60_000
const PRODUCT_BACKOFF_MS = 30_000
/** Channel3 reads the store page during a lookup; good reads took 3.6 to 7.8 s in our probe. */
const LOOKUP_TIMEOUT_MS = 10_000
/** A link Channel3 could not read is not asked about again for this long. */
const LOOKUP_MISS_MS = 60 * 60_000
const KNOWN_MAX = 5000

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
export interface RawLookup {
  product?: RawProduct | null
}
export interface FixtureLookup {
  /** The link as pasted; matched after the same checks a live lookup makes. */
  url: string
  response: RawLookup
}
export interface Channel3Fixtures {
  recordedAt: string
  searches: FixtureSearch[]
  /** Recorded lookups, served in fixture mode and when live lookups cannot run. */
  lookups?: FixtureLookup[]
}
/**
 * Why a link was not read. invalid: not a public https link. off: lookups are switched off.
 * not-found: Channel3 has no product for the page. failed: Channel3 could not answer now.
 * limit: this client's or the server's allowance is used up.
 */
export type LookupFailure = 'invalid' | 'off' | 'not-found' | 'failed' | 'limit'
export type LookupResult =
  { ok: true; product: ProductLookup } | { ok: false; reason: LookupFailure }

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
export interface SearchOptions {
  /**
   * Asked only when a live, uncached search would run, so one client cannot spend the whole day's
   * searches; false serves the recorded examples instead.
   */
  allowLive?: () => boolean
}
/** The current price of a product someone saved, read with the free product endpoint. */
export interface PriceCheck {
  status: 'dropped' | 'same' | 'higher' | 'unavailable'
  /** Present unless unavailable: the cheapest in-stock, new, USD offer now. */
  current?: Pick<Alternative, 'priceCents' | 'url' | 'retailer'>
  /** How much lower than the saved price, when it dropped. */
  droppedByCents?: number
}
export interface Channel3Client {
  /** Products like `query` priced at or below the bucketed ceiling. */
  search(query: string, maxPriceCents: number, options?: SearchOptions): Promise<Alternatives>
  /**
   * Products like a Channel3 product this server has shown, priced at or below the bucketed
   * ceiling. Any other ID returns nothing without a call.
   */
  similar(productId: string, maxPriceCents: number, options?: SearchOptions): Promise<Alternatives>
  /**
   * For Saved items (Phase 5): whether a saved Channel3 product's price has dropped since it was
   * saved. Uses the free product endpoint; never spends search credits.
   */
  checkPrice(productId: string, savedPriceCents: number): Promise<PriceCheck>
  /** The product on a pasted store page, read by Channel3; Worth never fetches the page. */
  lookup(url: string, options?: SearchOptions): Promise<LookupResult>
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

/** The model of a product, for spotting the same item listed twice: "rode|nth-100". */
function modelKey(title: string, brand: string | undefined) {
  const brandWords = new Set((brand ?? '').toLowerCase().split(/\s+/))
  const model = title
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .find((word) => /\d/.test(word) && /[a-z]/.test(word) && !brandWords.has(word))
  return model ? `${(brand ?? '').toLowerCase()}|${model}` : title.toLowerCase()
}
/** The store's own page link: Channel3's buy link, or a page on the offer's own domain. */
/** A buy link Channel3 allows: its own redirect or the store's own domain, https, no credentials. */
export const storeLink = (url: unknown, retailer: string) =>
  httpsUrl(
    url,
    (host) => host === 'buy.trychannel3.com' || host === retailer || host.endsWith(`.${retailer}`),
  )

/**
 * Turns a search response into at most `limit` alternatives. Each keeps its cheapest in-stock,
 * new, USD offer inside the price band; products without one, without a usable link, whose other
 * offers cost over three times as much, or that repeat a model already listed, are dropped.
 */
export function parseProducts(
  raw: RawSearch,
  band: { minPriceCents: number; maxPriceCents: number },
  limit = MAX_ALTERNATIVES,
): Alternative[] {
  const items: Alternative[] = []
  const seen = new Set<string>()
  for (const product of Array.isArray(raw?.products) ? raw.products : []) {
    const id = typeof product?.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(product.id)
    const title = clean(product?.title, 120)
    const brand = clean(product?.brands?.[0]?.name, 60)
    if (!id || !title) continue
    const keys = [title.toLowerCase(), modelKey(title, brand)]
    if (keys.some((key) => seen.has(key))) continue
    let best: Pick<Alternative, 'priceCents' | 'url' | 'retailer'> | undefined
    for (const offer of Array.isArray(product.offers) ? product.offers : []) {
      const price = offer?.price?.price
      if (typeof price !== 'number' || !Number.isFinite(price)) continue
      const cents = Math.round(price * 100)
      const retailer = retailerName(offer.domain)
      const url = retailer ? storeLink(offer.url, retailer) : undefined
      if (
        offer.price?.currency !== 'USD' ||
        offer.availability !== 'InStock' ||
        // Unknown condition is not shown as new.
        offer.condition !== 'new' ||
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
    for (const key of keys) seen.add(key)
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
    if (items.length === limit) break
  }
  return items
}

/**
 * Turns a lookup response into what the shopper confirms. Only an offer on the pasted link's own
 * host is used, preferring a USD price; another store's price is never shown as this one's. A
 * product with no title is no product.
 */
export function parseLookup(
  raw: RawLookup,
  link: { url: string; host: string },
  status: ProductLookup['status'] = 'ok',
): ProductLookup | undefined {
  const product = raw?.product
  const name = productTitle(product?.title)
  if (!product || !name) return undefined
  const domain = storeDomain(link.host)
  const priced = (Array.isArray(product.offers) ? product.offers : []).flatMap((offer) => {
    const retailer = retailerName(offer?.domain)
    const price = offer?.price?.price
    const currency = offer?.price?.currency
    // The same host, ignoring "www.": a suffix match would let "co.uk" match every UK store.
    if (!retailer || retailer !== domain) return []
    if (typeof price !== 'number' || !Number.isFinite(price) || typeof currency !== 'string')
      return []
    const cents = Math.round(price * 100)
    if (cents <= 0 || cents > 100_000_000 || !/^[A-Z]{3}$/.test(currency)) return []
    return [{ cents, currency, inStock: offer.availability === 'InStock' }]
  })
  const offer =
    priced.find((o) => o.currency === 'USD' && o.inStock) ??
    priced.find((o) => o.currency === 'USD') ??
    priced[0]
  const images = Array.isArray(product.images) ? product.images : []
  const imageUrl = [...images.filter((i) => i?.is_main_image === true), ...images]
    .flatMap((image) => [image?.cleaned_url, image?.url])
    .map((url) => httpsUrl(url, onChannel3Cdn))
    .find(Boolean)
  return {
    name,
    ...(offer ? { priceCents: offer.cents, currency: offer.currency } : {}),
    merchantName: domain,
    merchantDomain: domain,
    ...(imageUrl ? { imageUrl } : {}),
    sourceUrl: link.url,
    status,
  }
}

/** A row whose price and link could not be re-read: shown as an example, never as current. */
const unverifiedRow = ({ id, title, retailer, brand, imageUrl }: Alternative) =>
  ({
    id,
    title,
    retailer,
    ...(brand ? { brand } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    source: 'channel3',
  }) satisfies UnverifiedAlternative

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
  type Band = { minPriceCents: number; maxPriceCents: number }
  /** A search as found: its rows and when they were read. */
  type Found = {
    status: AlternativesStatus
    query: string
    band: Band
    rows: Alternative[]
    at: number
  }
  const cache = new Map<string, { value: Found; until: number }>()
  const inFlight = new Map<string, Promise<Found>>()
  /** Product reads: the product, null when Channel3 no longer has it. */
  const products = new Map<string, { value: RawProduct | null; until: number }>()
  /** Products this server has shown; only these can seed a similar-products search. */
  const known = new Set<string>()
  let blockedUntil = 0
  let productsBlockedUntil = 0
  let day = { start: 0, count: 0 }
  const live = mode === 'live' && Boolean(options.apiKey)

  function remember(rows: { id: string }[]) {
    for (const { id } of rows) {
      known.delete(id)
      known.add(id)
    }
    while (known.size > KNOWN_MAX) known.delete(known.values().next().value!)
  }
  for (const recorded of fixtures)
    remember(parseProducts(recorded.response, { minPriceCents: 0, maxPriceCents: 1e9 }, 50))

  /**
   * Recorded results for a query: the same query first, then one for the same kind of thing (its
   * last word, such as "camera"), so a search phrased differently still shows examples.
   */
  function fixtureFor(kind: FixtureSearch['kind'], query: string, band: Band): Found {
    const said = new Set(query.toLowerCase().split(/\s+/))
    const head = (recorded: FixtureSearch) => recorded.query.toLowerCase().split(/\s+/).at(-1)!
    const candidates = fixtures.filter((recorded) => recorded.kind === kind)
    for (const recorded of [
      ...candidates.filter((r) => r.query === query),
      ...(kind === 'search' ? candidates.filter((r) => said.has(head(r))) : []),
    ]) {
      // A few spare rows, since some may have changed by the time they are re-read.
      const rows = parseProducts(recorded.response, band, MAX_ALTERNATIVES + 2)
      if (rows.length) return { status: 'fixture', query, band, rows, at: 0 }
    }
    return { status: 'off', query, band, rows: [], at: 0 }
  }
  function underDailyLimit() {
    const time = now()
    if (time - day.start >= DAY_MS) day = { start: time, count: 0 }
    if (day.count >= dailyLimit) return false
    day.count++
    return true
  }
  async function request(
    path: string,
    init: RequestInit = {},
    wait = timeoutMs,
  ): Promise<Response> {
    const started = now()
    let response: Response
    try {
      response = await fetcher(`${CHANNEL3_API}${path}`, {
        ...init,
        headers: { 'x-api-key': options.apiKey!, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(wait),
      })
    } catch (error) {
      const timeout = error instanceof Error && /timeout|abort/i.test(error.name)
      throw new Channel3Error(undefined, timeout ? 'timeout' : 'network')
    }
    log({
      event: 'channel3_call',
      path: path.replace(/\/v1\/products\/.*/, '/v1/products/{id}'),
      status: response.status,
      ms: now() - started,
    })
    return response
  }
  async function call(path: string, body: unknown): Promise<RawSearch> {
    const response = await request(path, { method: 'POST', body: JSON.stringify(body) })
    if (!response.ok) throw new Channel3Error(response.status, `HTTP ${response.status}`)
    return (await response.json()) as RawSearch
  }
  /** One product, re-read with the free endpoint; undefined when it could not be read now. */
  async function product(id: string): Promise<RawProduct | null | undefined> {
    if (!options.apiKey || mode === 'off') return undefined
    const cached = products.get(id)
    if (cached && cached.until > now()) return cached.value
    if (now() < productsBlockedUntil) return undefined
    try {
      const response = await request(
        `/v1/products/${encodeURIComponent(id)}?country=US&currency=USD`,
      )
      if (response.status === 404) {
        products.set(id, { value: null, until: now() + FRESH_MS })
        return null
      }
      if (!response.ok) throw new Channel3Error(response.status, `HTTP ${response.status}`)
      const value = (await response.json()) as RawProduct
      products.delete(id)
      products.set(id, { value, until: now() + FRESH_MS })
      while (products.size > CACHE_MAX) products.delete(products.keys().next().value!)
      return value
    } catch (error) {
      productsBlockedUntil = now() + PRODUCT_BACKOFF_MS
      log({
        event: 'channel3_product_unavailable',
        status: error instanceof Channel3Error ? (error.status ?? error.message) : 'error',
      })
      return undefined
    }
  }
  /**
   * What is shown: rows read within 15 minutes as they are; older or recorded rows re-read first.
   * A re-read row keeps its current price and link (or is dropped if it no longer fits); a row that
   * cannot be re-read is listed without them.
   */
  async function present(found: Found): Promise<Alternatives> {
    const base = {
      status: found.status,
      query: found.query,
      maxPriceCents: found.band.maxPriceCents,
    }
    if (found.status === 'off') return { ...base, items: [] }
    if (found.status === 'ok' && now() - found.at < FRESH_MS) {
      remember(found.rows)
      return { ...base, items: found.rows.slice(0, MAX_ALTERNATIVES) }
    }
    const checked = await Promise.all(
      found.rows.map(async (row) => {
        const fresh = await product(row.id)
        if (fresh === undefined) return { unverified: unverifiedRow(row) }
        const item = fresh ? parseProducts({ products: [fresh] }, found.band, 1)[0] : undefined
        return item ? { item: { ...item, id: row.id } } : {}
      }),
    )
    const items = checked.flatMap((c) => (c.item ? [c.item] : [])).slice(0, MAX_ALTERNATIVES)
    const unverified = checked
      .flatMap((c) => (c.unverified ? [c.unverified] : []))
      .slice(0, MAX_ALTERNATIVES - items.length)
    remember([...items, ...unverified])
    if (!items.length && !unverified.length) return { ...base, status: 'off', items: [] }
    return { ...base, items, ...(unverified.length ? { unverified } : {}) }
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
  async function find(
    kind: FixtureSearch['kind'],
    query: string,
    maxPriceCents: number,
    searchOptions: SearchOptions,
  ): Promise<Found> {
    const bucket = priceBucket(maxPriceCents)
    const band = { minPriceCents: priceFloor(bucket), maxPriceCents: bucket }
    if (mode === 'off' || bucket < PRICE_BUCKET_CENTS)
      return { status: 'off', query, band, rows: [], at: 0 }
    if (!live || now() < blockedUntil) return fixtureFor(kind, query, band)
    const key = `${kind}:${query}:${bucket}`
    const cached = cache.get(key)
    if (cached && cached.until > now()) return cached.value
    const pending = inFlight.get(key)
    if (pending) return pending
    if (searchOptions.allowLive && !searchOptions.allowLive()) return fixtureFor(kind, query, band)
    if (!underDailyLimit()) return fixtureFor(kind, query, band)
    const promise = (async (): Promise<Found> => {
      try {
        const raw = await call(
          kind === 'search' ? '/v1/search' : '/v1/similar',
          requestBody(kind, query, band),
        )
        const value: Found = {
          status: 'ok',
          query,
          band,
          rows: parseProducts(raw, band),
          at: now(),
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
  /** Lookups by link: a found product for 15 minutes, a miss for an hour. */
  const lookups = new Map<string, { value: LookupResult; until: number }>()
  const lookupsInFlight = new Map<string, Promise<LookupResult>>()
  const recordedLookups = options.fixtures?.lookups ?? []
  function fixtureLookup(link: { url: string; host: string }): LookupResult | undefined {
    for (const recorded of recordedLookups) {
      const checked = checkProductLink(recorded.url)
      if (!checked.ok || checked.url !== link.url) continue
      const product = parseLookup(recorded.response, link, 'fixture')
      return product ? { ok: true, product } : { ok: false, reason: 'not-found' }
    }
    return undefined
  }
  function rememberLookup(url: string, value: LookupResult, ttl: number) {
    lookups.delete(url)
    lookups.set(url, { value, until: now() + ttl })
    while (lookups.size > CACHE_MAX) lookups.delete(lookups.keys().next().value!)
  }
  async function lookup(raw: string, searchOptions: SearchOptions = {}): Promise<LookupResult> {
    const link = checkProductLink(raw)
    if (!link.ok) return { ok: false, reason: 'invalid' }
    if (mode === 'off') return { ok: false, reason: 'off' }
    const recorded = fixtureLookup(link)
    if (!live) return recorded ?? { ok: false, reason: mode === 'fixture' ? 'not-found' : 'off' }
    const cached = lookups.get(link.url)
    if (cached && cached.until > now()) return cached.value
    if (now() < blockedUntil) return recorded ?? { ok: false, reason: 'failed' }
    const pending = lookupsInFlight.get(link.url)
    if (pending) return pending
    if (searchOptions.allowLive && !searchOptions.allowLive())
      return recorded ?? { ok: false, reason: 'limit' }
    if (!underDailyLimit()) return recorded ?? { ok: false, reason: 'limit' }
    const promise = (async (): Promise<LookupResult> => {
      try {
        const response = await request(
          '/v1/lookup',
          { method: 'POST', body: JSON.stringify({ url: link.url }) },
          LOOKUP_TIMEOUT_MS,
        )
        if ([401, 402, 403, 429].includes(response.status))
          throw new Channel3Error(response.status, `HTTP ${response.status}`)
        if (!response.ok) {
          // 404 and 422: no product page Channel3 knows; 500 and 504: it could not read this one.
          const value: LookupResult = {
            ok: false,
            reason: response.status === 404 || response.status === 422 ? 'not-found' : 'failed',
          }
          rememberLookup(link.url, value, value.reason === 'not-found' ? LOOKUP_MISS_MS : FRESH_MS)
          return value
        }
        const product = parseLookup((await response.json()) as RawLookup, link)
        const value: LookupResult = product
          ? { ok: true, product }
          : { ok: false, reason: 'not-found' }
        rememberLookup(link.url, value, product ? FRESH_MS : LOOKUP_MISS_MS)
        return value
      } catch (error) {
        // A slow page is this link's problem; refused keys and rate limits pause every call.
        if (error instanceof Channel3Error && error.status !== undefined) backOff(error)
        else log({ event: 'channel3_lookup_unavailable', status: (error as Error).message })
        return recorded ?? { ok: false, reason: 'failed' }
      } finally {
        lookupsInFlight.delete(link.url)
      }
    })()
    lookupsInFlight.set(link.url, promise)
    return promise
  }
  return {
    lookup,
    search: async (query, maxPriceCents, searchOptions = {}) =>
      present(await find('search', query, maxPriceCents, searchOptions)),
    async similar(productId, maxPriceCents, searchOptions = {}) {
      if (!known.has(productId))
        return {
          status: 'off',
          query: productId,
          maxPriceCents: priceBucket(maxPriceCents),
          items: [],
        }
      return present(await find('similar', productId, maxPriceCents, searchOptions))
    },
    async checkPrice(productId, savedPriceCents) {
      const fresh = await product(productId)
      const current = fresh
        ? parseProducts({ products: [fresh] }, { minPriceCents: 1, maxPriceCents: 1e9 }, 1)[0]
        : undefined
      if (!current) return { status: 'unavailable' }
      const { priceCents, url, retailer } = current
      const status =
        priceCents < savedPriceCents ? 'dropped' : priceCents > savedPriceCents ? 'higher' : 'same'
      return {
        status,
        current: { priceCents, url, retailer },
        ...(status === 'dropped' ? { droppedByCents: savedPriceCents - priceCents } : {}),
      }
    },
    health() {
      if (mode === 'off') return 'off'
      if (live && now() >= blockedUntil) return 'ok'
      return fixtures.length ? 'fixture' : 'off'
    },
  }
}
