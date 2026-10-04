import { describe, expect, it, vi } from 'vitest'
import { categoryOf, queryFor, roomToday, wantsAlternatives } from '../server/alternatives.ts'
import {
  CHANNEL3_IMAGE_HOST,
  createChannel3,
  loadFixtures,
  parseProducts,
  priceBucket,
  priceFloor,
} from '../server/channel3.ts'
import type { Channel3Fixtures, RawProduct, RawSearch } from '../server/channel3.ts'
import { createDemoState } from '../shared/seed.ts'

const fixtures = loadFixtures()!
/** The live response recorded for the camera, the persona's spend-less case. */
const camera = fixtures.searches.find((s) => s.query === 'interchangeable lens camera')!
const HOUR = 60 * 60_000
const MINUTE = 60_000
/** Every recorded product by ID, as the free product endpoint would return it. */
const recorded = new Map(
  fixtures.searches.flatMap((s) => (s.response.products ?? []).map((p) => [p.id as string, p])),
)

type Answer = RawSearch | RawProduct | number | Error
/**
 * Channel3 by URL: POSTs to /v1/search or /v1/similar take answers in order (the last repeats);
 * GET /v1/products/{id} answers from `product`, by default the recorded product.
 */
function fakeFetch(
  search: Answer[] = [camera.response],
  product: (id: string) => Answer = (id) => recorded.get(id) ?? 404,
) {
  const calls: { url: string; init: RequestInit }[] = []
  const reply = (next: Answer) => {
    if (next instanceof Error) throw next
    if (typeof next === 'number') return new Response('{"detail":"no"}', { status: next })
    return new Response(JSON.stringify(next), { status: 200 })
  }
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const id = url.match(/\/v1\/products\/([^?]+)/)?.[1]
    if (id) return reply(product(decodeURIComponent(id)))
    return reply(search.length > 1 ? search.shift()! : search[0]!)
  })
  const searches = () => calls.filter((c) => c.init.method === 'POST')
  const reads = () => calls.filter((c) => c.url.includes('/v1/products/'))
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, searches, reads }
}
function client(options: Parameters<typeof createChannel3>[0] = {}) {
  let time = Date.parse('2026-10-04T12:00:00Z')
  const log = vi.fn()
  const c3 = createChannel3({ apiKey: 'c3-test-key', fixtures, log, now: () => time, ...options })
  return { c3, log, advance: (ms: number) => (time += ms) }
}
const offer = (price: number, extra: Record<string, unknown> = {}) => ({
  url: 'https://buy.trychannel3.com/x',
  domain: 'www.Store.com',
  price: { price, currency: 'USD' },
  availability: 'InStock',
  condition: 'new',
  ...extra,
})
/** A product as the product endpoint returns it, with one new in-stock offer. */
const productAt = (id: string, price: number): RawProduct => ({
  ...recorded.get(id),
  offers: [offer(price, { url: `https://buy.trychannel3.com/${id}-fresh`, domain: 'bestbuy.com' })],
})

describe('Channel3 response parsing (recorded live fixture)', () => {
  it('turns the recorded search into at most four in-band, in-stock, new USD alternatives', () => {
    const band = { minPriceCents: camera.minPriceCents, maxPriceCents: camera.maxPriceCents }
    const items = parseProducts(camera.response, band)
    expect(items.length).toBeGreaterThan(0)
    expect(items.length).toBeLessThanOrEqual(4)
    for (const item of items) {
      expect(item.source).toBe('channel3')
      expect(item.availability).toBe('InStock')
      expect(item.priceCents).toBeGreaterThanOrEqual(band.minPriceCents)
      expect(item.priceCents).toBeLessThanOrEqual(band.maxPriceCents)
      expect(new URL(item.url).hostname).toBe('buy.trychannel3.com')
      expect(item.retailer).toMatch(/^[a-z0-9.-]+\.[a-z]+$/)
      if (item.imageUrl) expect(new URL(item.imageUrl).hostname).toBe(CHANNEL3_IMAGE_HOST)
    }
  })
  it('keeps the cheapest new offer and drops used, unknown, foreign, mispriced and repeated listings', () => {
    const raw: RawSearch = {
      products: [
        {
          id: 'ok1',
          title: '  NTH-100 Camera‮ body\n ',
          brands: [{ name: 'Rode' }],
          images: [
            { url: 'https://retailer.example/a.jpg', is_main_image: true },
            { url: 'https://cdn.trychannel3.com/b?aid=1', cleaned_url: null },
          ],
          offers: [offer(300), offer(250), offer(200, { condition: 'used' })],
        },
        { id: 'unknown', title: 'Unknown', offers: [offer(200, { condition: null })] },
        { id: 'stock', title: 'Out', offers: [offer(200, { availability: 'OutOfStock' })] },
        {
          id: 'eur',
          title: 'Euro',
          offers: [offer(200, { price: { price: 200, currency: 'EUR' } })],
        },
        { id: 'outlier', title: 'Mispriced', offers: [offer(30), offer(299.99)] },
        { id: 'http', title: 'Plain link', offers: [offer(200, { url: 'http://buy.example/x' })] },
        {
          id: 'offsite',
          title: 'Elsewhere',
          offers: [offer(200, { url: 'https://evil.example/store.com' })],
        },
        { id: 'bad id!', title: 'Bad', offers: [offer(200)] },
        { id: 'dupe', title: 'nth-100 camera BODY', offers: [offer(210)] },
        {
          id: 'model',
          title: 'RODE NTH-100 Professional',
          brands: [{ name: 'Rode' }],
          offers: [offer(220)],
        },
        {
          id: 'ownsite',
          title: 'Own site listing',
          offers: [offer(240, { url: 'https://shop.store.com/p/1' })],
        },
      ],
    }
    const items = parseProducts(raw, { minPriceCents: 2500, maxPriceCents: 42500 })
    expect(items.map((item) => item.id)).toEqual(['ok1', 'ownsite'])
    expect(items[0]).toEqual({
      id: 'ok1',
      title: 'NTH-100 Camera body',
      retailer: 'store.com',
      brand: 'Rode',
      priceCents: 25000,
      url: 'https://buy.trychannel3.com/x',
      imageUrl: 'https://cdn.trychannel3.com/b?aid=1',
      availability: 'InStock',
      source: 'channel3',
    })
  })
  it('rounds the ceiling down to $25 and leaves out results under a quarter of it', () => {
    expect(priceBucket(44001)).toBe(42500)
    expect(priceBucket(2499)).toBe(0)
    expect(priceFloor(42500)).toBe(10600)
    expect(priceFloor(2500)).toBe(600)
  })
})

describe('Channel3 client', () => {
  it('searches server-side with the key in a header, a generic query and the bucketed band', async () => {
    const channel3 = fakeFetch()
    const { c3 } = client({ fetch: channel3.fetch })
    const result = await c3.search('interchangeable lens camera', 44001)
    expect(result.status).toBe('ok')
    expect(result.maxPriceCents).toBe(42500)
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.unverified).toBeUndefined()
    const [call] = channel3.calls
    expect(channel3.calls).toHaveLength(1)
    expect(call!.url).toBe('https://api.trychannel3.com/v1/search')
    expect((call!.init.headers as Record<string, string>)['x-api-key']).toBe('c3-test-key')
    expect(call!.init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(call!.init.body as string)).toEqual({
      query: 'interchangeable lens camera',
      limit: 12,
      filters: {
        price: { min_price: 106, max_price: 425 },
        availability: ['InStock'],
        conditions: ['new'],
      },
      config: { country: 'US', currency: 'USD' },
    })
    expect(JSON.stringify(result)).not.toContain('c3-test-key')
  })
  it('caches per query and $25 bucket for six hours, and shares one request in flight', async () => {
    const channel3 = fakeFetch()
    const { c3, advance } = client({ fetch: channel3.fetch })
    await Promise.all([c3.search('desk chair', 44001), c3.search('desk chair', 43000)])
    await c3.search('desk chair', 42500)
    expect(channel3.searches()).toHaveLength(1)
    await c3.search('desk chair', 40000)
    expect(channel3.searches()).toHaveLength(2)
    advance(6 * HOUR + 1)
    await c3.search('desk chair', 44001)
    expect(channel3.searches()).toHaveLength(3)
  })
  it('re-reads cached offers older than 15 minutes before showing them, with current prices', async () => {
    const first = parseProducts(camera.response, {
      minPriceCents: priceFloor(42500),
      maxPriceCents: 42500,
    })
    const [kept, dropped, gone, unread] = first.map((item) => item.id)
    const channel3 = fakeFetch([camera.response], (id) =>
      id === kept
        ? productAt(id, 199.99)
        : id === dropped
          ? productAt(id, 999)
          : id === gone
            ? 404
            : id === unread
              ? 503
              : 404,
    )
    const { c3, advance } = client({ fetch: channel3.fetch })
    const fresh = await c3.search('interchangeable lens camera', 44001)
    expect(fresh.items.map((i) => i.priceCents)).toEqual(first.map((i) => i.priceCents))
    advance(14 * MINUTE)
    await c3.search('interchangeable lens camera', 44001)
    expect(channel3.reads()).toHaveLength(0)
    advance(2 * MINUTE)
    const later = await c3.search('interchangeable lens camera', 44001)
    expect(channel3.searches()).toHaveLength(1)
    expect(channel3.reads().map((c) => c.init.method)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(channel3.reads()[0]!.url).toContain('?country=US&currency=USD')
    // Current price and link; a product priced above the limit or gone is dropped; one that
    // cannot be read is listed without its price or link.
    expect(later.items).toEqual([
      expect.objectContaining({
        id: kept,
        priceCents: 19999,
        url: `https://buy.trychannel3.com/${kept}-fresh`,
      }),
    ])
    expect(later.unverified).toEqual([expect.objectContaining({ id: unread })])
    expect(later.unverified![0]).not.toHaveProperty('priceCents')
    expect(later.unverified![0]).not.toHaveProperty('url')
  })
  it.each([
    [402, 6 * HOUR],
    [429, 60_000],
    [500, 30_000],
  ])(
    'after HTTP %i, re-reads the recorded examples for current prices and pauses searches',
    async (status, pause) => {
      const channel3 = fakeFetch([status, camera.response])
      const { c3, advance, log } = client({ fetch: channel3.fetch })
      const failed = await c3.search('interchangeable lens camera', 44001)
      expect(failed.status).toBe('fixture')
      expect(failed.items.length).toBeGreaterThan(0)
      expect(channel3.reads().length).toBeGreaterThan(0)
      expect(c3.health()).toBe('fixture')
      await c3.search('interchangeable lens camera', 30000)
      expect(channel3.searches()).toHaveLength(1)
      advance(pause)
      expect(c3.health()).toBe('ok')
      expect((await c3.search('interchangeable lens camera', 30000)).status).toBe('ok')
      expect(JSON.stringify(log.mock.calls)).not.toContain('c3-test-key')
    },
  )
  it('never shows a recorded price or link it could not re-read', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const channel3 = fakeFetch([timeout], () => timeout)
    const { c3 } = client({ fetch: channel3.fetch })
    const result = await c3.search('mirrorless camera', 44001)
    expect(result.status).toBe('fixture')
    expect(result.query).toBe('mirrorless camera')
    expect(result.items).toEqual([])
    expect(result.unverified!.length).toBeGreaterThan(0)
    for (const row of result.unverified!) {
      expect(row).not.toHaveProperty('priceCents')
      expect(row).not.toHaveProperty('url')
    }
    // Rows are read in parallel; after a failed read, the next display waits instead of retrying.
    const reads = channel3.reads().length
    await c3.search('mirrorless camera', 44001)
    expect(channel3.reads()).toHaveLength(reads)
  })
  it('hides the panel when nothing recorded matches, the key is missing or the ceiling is under $25', async () => {
    const channel3 = fakeFetch([500])
    expect((await client({ fetch: channel3.fetch }).c3.search('garden hose', 44001)).status).toBe(
      'off',
    )
    const keyless = createChannel3({ fixtures, fetch: channel3.fetch })
    expect(keyless.health()).toBe('off')
    expect(await keyless.search('desk chair', 44001)).toMatchObject({ status: 'off', items: [] })
    expect((await client({ fetch: channel3.fetch }).c3.search('desk chair', 2400)).status).toBe(
      'off',
    )
    expect(channel3.searches()).toHaveLength(1)
  })
  it('serves recordings without searching in fixture mode, re-read when a key is set', async () => {
    const channel3 = fakeFetch()
    const recordedOnly = client({ fetch: channel3.fetch, mode: 'fixture' }).c3
    expect(recordedOnly.health()).toBe('fixture')
    const result = await recordedOnly.search('desk chair', 44001)
    expect(result.status).toBe('fixture')
    expect(result.items.length).toBeGreaterThan(0)
    const keyless = createChannel3({ fixtures, mode: 'fixture', fetch: channel3.fetch })
    const examples = await keyless.search('desk chair', 44001)
    expect(examples.items).toEqual([])
    expect(examples.unverified!.length).toBeGreaterThan(0)
    const off = client({ fetch: channel3.fetch, mode: 'off' }).c3
    expect(off.health()).toBe('off')
    expect((await off.search('desk chair', 44001)).status).toBe('off')
    expect(channel3.searches()).toHaveLength(0)
  })
  it('stops live searches at the daily limit and serves recordings until the next day', async () => {
    const channel3 = fakeFetch()
    const { c3, advance } = client({ fetch: channel3.fetch, dailyLimit: 2 })
    await c3.search('desk chair', 30000)
    await c3.search('desk chair', 40000)
    expect((await c3.search('desk chair', 20000)).status).toBe('fixture')
    expect(channel3.searches()).toHaveLength(2)
    advance(24 * HOUR)
    expect((await c3.search('desk chair', 20000)).status).toBe('ok')
  })
  it('asks the caller’s allowance only for a live search, never for a cached one', async () => {
    const channel3 = fakeFetch()
    const { c3 } = client({ fetch: channel3.fetch })
    const allowLive = vi.fn(() => true)
    await c3.search('desk chair', 44001, { allowLive })
    await c3.search('desk chair', 44001, { allowLive })
    expect(allowLive).toHaveBeenCalledTimes(1)
    const refused = await c3.search('desk chair', 30000, { allowLive: () => false })
    expect(refused.status).toBe('fixture')
    expect(channel3.searches()).toHaveLength(1)
  })
  it('finds similar products only for products it has shown', async () => {
    const channel3 = fakeFetch()
    const { c3 } = client({ fetch: channel3.fetch })
    expect((await c3.similar('NeverShown', 44001)).status).toBe('off')
    expect(channel3.calls).toHaveLength(0)
    const shown = await c3.search('interchangeable lens camera', 44001)
    const result = await c3.similar(shown.items[0]!.id, 44001)
    expect(result.status).toBe('ok')
    expect(channel3.calls.at(-1)!.url).toBe('https://api.trychannel3.com/v1/similar')
    expect(JSON.parse(channel3.calls.at(-1)!.init.body as string)).toMatchObject({
      product_id: shown.items[0]!.id,
      filters: { price: { max_price: 425 } },
    })
  })
  it('checks a saved product’s price with the free product endpoint (price-drop helper)', async () => {
    const [id] = [...recorded.keys()]
    let price = 300
    const channel3 = fakeFetch([camera.response], (asked) =>
      asked === id ? productAt(asked, price) : 404,
    )
    const { c3, advance } = client({ fetch: channel3.fetch })
    expect(await c3.checkPrice(id!, 32000)).toEqual({
      status: 'dropped',
      current: {
        priceCents: 30000,
        url: `https://buy.trychannel3.com/${id}-fresh`,
        retailer: 'bestbuy.com',
      },
      droppedByCents: 2000,
    })
    price = 320
    advance(16 * MINUTE)
    expect((await c3.checkPrice(id!, 32000)).status).toBe('same')
    expect((await c3.checkPrice('Missing', 32000)).status).toBe('unavailable')
    expect(channel3.searches()).toHaveLength(0)
    expect(await createChannel3({ fixtures }).checkPrice(id!, 32000)).toEqual({
      status: 'unavailable',
    })
  })
  it('ships a recording for every catalog item', () => {
    const shipped: Channel3Fixtures = fixtures
    for (const id of ['camera', 'headphones', 'chair', 'backpack']) {
      const query = queryFor({ productId: id })!
      const search = shipped.searches.find((s) => s.query === query)
      expect(search, id).toBeTruthy()
      expect(parseProducts(search!.response, search!).length).toBeGreaterThan(0)
    }
  })
})

describe('what Worth searches for (privacy)', () => {
  it('uses the catalog’s generic description for catalog items', () => {
    expect(queryFor({ productId: 'camera' })).toBe('interchangeable lens camera')
    expect(queryFor({ itemName: 'Everyday camera' })).toBe('interchangeable lens camera')
    expect(queryFor({ itemName: 'a new Sony camera' })).toBe('interchangeable lens camera')
    expect(queryFor({ itemName: 'Studio headphones' })).toBe('over-ear headphones')
  })
  it.each([
    ['engagement ring for Sarah', 'ring'],
    ['meds for my HIV', undefined],
    ['gift for Priya Sharma', undefined],
    ['Vitra Eames lounge chair', 'lounge chair'],
    ['Hasselblad X2D camera', 'interchangeable lens camera'],
    ['Herman Miller office chair', 'office chair'],
    ['Bose QC45 headphones', 'over-ear headphones'],
    ['camera bag for Mom', 'camera bag'],
    ['standing desk', 'standing desk'],
    ['phone case', undefined],
    ['flights to Denver', undefined],
    ['Apple MacBook Pro 14-inch laptop', 'laptop'],
  ])('sends only an allowlisted kind of item for “%s”', (name, expected) => {
    expect(queryFor({ itemName: name })).toBe(expected)
  })
  it('never lets a capitalised name or brand through, whatever surrounds it', () => {
    for (const name of ['Sarah', 'Priya Sharma', 'Vitra', 'Hasselblad', 'Eames', 'HIV'])
      expect(categoryOf(`a ${name} chair for ${name}`)).not.toMatch(new RegExp(name, 'i'))
  })
  it.each([
    'Is there something cheaper?',
    'What can I buy under $300?',
    'What’s the cheapest thing that keeps my cushion?',
    'Show me something similar but less',
    'Can you find a cheaper camera?',
    "what's the cheapest thing in the store I could buy today without going under my cushion?",
    'Find headphones under $300',
  ])('treats “%s” as a request for something cheaper', (message) => {
    expect(wantsAlternatives(message)).toBe(true)
  })
  it.each([
    'Is Pay in 4 cheaper than paying now?',
    'Is it cheaper to wait?',
    'Would it be cheaper to wait until next month?',
    'Is the camera cheaper if I wait?',
    'Which option is cheapest for the desk chair?',
    'Which option is cheapest for the chair?',
    'I need a cheaper phone plan',
    'cheaper phone plan',
    'Show me cheaper flights to Denver',
    'Can I afford a $1,199 camera?',
    'How much can I spend today?',
    'What bills are coming up?',
  ])('leaves “%s” to the other answers', (message) => {
    expect(wantsAlternatives(message)).toBe(false)
  })
  it('reads the room today from the engine, and nothing on an incomplete plan', () => {
    const seed = createDemoState('2026-10-03')
    expect(roomToday(seed.profile, [], '2026-10-03')).toBe(44001)
    expect(roomToday({ ...seed.profile, confirmed: false }, [], '2026-10-03')).toBe(0)
  })
})
