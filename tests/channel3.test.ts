import { describe, expect, it, vi } from 'vitest'
import {
  ALTERNATIVES_CUE,
  catalogItem,
  genericQuery,
  queryFor,
  roomToday,
} from '../server/alternatives.ts'
import {
  CHANNEL3_IMAGE_HOST,
  createChannel3,
  loadFixtures,
  parseProducts,
  priceBucket,
  priceFloor,
} from '../server/channel3.ts'
import type { Channel3Fixtures, RawSearch } from '../server/channel3.ts'
import { createDemoState } from '../shared/seed.ts'

const fixtures = loadFixtures()!
/** The live response recorded for the camera, the persona's spend-less case. */
const camera = fixtures.searches.find((s) => s.query === 'interchangeable lens camera')!
const HOUR = 60 * 60_000

function fakeFetch(...responses: (RawSearch | number | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const next = responses.length > 1 ? responses.shift()! : responses[0]!
    if (next instanceof Error) throw next
    if (typeof next === 'number') return new Response('{"detail":"no"}', { status: next })
    return new Response(JSON.stringify(next), { status: 200 })
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, mock: fetch }
}
function client(options: Parameters<typeof createChannel3>[0] = {}) {
  let time = Date.parse('2026-10-04T12:00:00Z')
  const log = vi.fn()
  const c3 = createChannel3({ apiKey: 'c3-test-key', fixtures, log, now: () => time, ...options })
  return { c3, log, advance: (ms: number) => (time += ms) }
}

describe('Channel3 response parsing (recorded live fixture)', () => {
  it('turns the recorded search into at most four in-band, in-stock, new USD alternatives', () => {
    const band = { minPriceCents: camera.minPriceCents, maxPriceCents: camera.maxPriceCents }
    const items = parseProducts(camera.response, band)
    expect(items.length).toBeGreaterThan(0)
    expect(items.length).toBeLessThanOrEqual(4)
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(
        expect.arrayContaining(['availability', 'id', 'priceCents', 'retailer', 'source', 'title', 'url']),
      )
      expect(item.source).toBe('channel3')
      expect(item.availability).toBe('InStock')
      expect(item.priceCents).toBeGreaterThanOrEqual(band.minPriceCents)
      expect(item.priceCents).toBeLessThanOrEqual(band.maxPriceCents)
      expect(new URL(item.url).protocol).toBe('https:')
      expect(item.retailer).toMatch(/^[a-z0-9.-]+\.[a-z]+$/)
      if (item.imageUrl) expect(new URL(item.imageUrl).hostname).toBe(CHANNEL3_IMAGE_HOST)
    }
  })
  it('keeps the cheapest qualifying offer and drops used, out-of-stock, foreign and outlier offers', () => {
    const offer = (price: number, extra: Record<string, unknown> = {}) => ({
      url: 'https://buy.trychannel3.com/x',
      domain: 'www.Store.com',
      price: { price, currency: 'USD' },
      availability: 'InStock',
      condition: 'new',
      ...extra,
    })
    const raw: RawSearch = {
      products: [
        {
          id: 'ok1',
          title: '  Camera‮ body\n ',
          brands: [{ name: 'Brand' }],
          images: [
            { url: 'https://retailer.example/a.jpg', is_main_image: true },
            { url: 'https://cdn.trychannel3.com/b?aid=1', cleaned_url: null },
          ],
          offers: [offer(300), offer(250), offer(200, { condition: 'used' })],
        },
        { id: 'stock', title: 'Out', offers: [offer(200, { availability: 'OutOfStock' })] },
        { id: 'eur', title: 'Euro', offers: [offer(200, { price: { price: 200, currency: 'EUR' } })] },
        { id: 'outlier', title: 'Mispriced', offers: [offer(30), offer(299.99)] },
        { id: 'http', title: 'Plain link', offers: [offer(200, { url: 'http://buy.example/x' })] },
        { id: 'bad id!', title: 'Bad', offers: [offer(200)] },
        { id: 'dupe', title: 'camera BODY', offers: [offer(210)] },
      ],
    }
    const items = parseProducts(raw, { minPriceCents: 2500, maxPriceCents: 42500 })
    expect(items).toEqual([
      {
        id: 'ok1',
        title: 'Camera body',
        retailer: 'store.com',
        brand: 'Brand',
        priceCents: 25000,
        url: 'https://buy.trychannel3.com/x',
        imageUrl: 'https://cdn.trychannel3.com/b?aid=1',
        availability: 'InStock',
        source: 'channel3',
      },
    ])
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
    const { fetch, calls } = fakeFetch(camera.response)
    const { c3 } = client({ fetch })
    const result = await c3.search('interchangeable lens camera', 44001)
    expect(result.status).toBe('ok')
    expect(result.maxPriceCents).toBe(42500)
    expect(result.items.length).toBeGreaterThan(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.trychannel3.com/v1/search')
    expect((calls[0]!.init.headers as Record<string, string>)['x-api-key']).toBe('c3-test-key')
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
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
    const { fetch, mock } = fakeFetch(camera.response)
    const { c3, advance } = client({ fetch })
    await Promise.all([c3.search('desk chair', 44001), c3.search('desk chair', 43000)])
    await c3.search('desk chair', 42500)
    expect(mock).toHaveBeenCalledTimes(1)
    await c3.search('desk chair', 40000)
    expect(mock).toHaveBeenCalledTimes(2)
    advance(6 * HOUR + 1)
    await c3.search('desk chair', 44001)
    expect(mock).toHaveBeenCalledTimes(3)
  })
  it.each([
    [402, 6 * HOUR],
    [429, 60_000],
    [500, 30_000],
  ])('serves labelled example results after HTTP %i and pauses live calls', async (status, pause) => {
    const { fetch, mock } = fakeFetch(status, camera.response)
    const { c3, advance, log } = client({ fetch })
    const failed = await c3.search('interchangeable lens camera', 44001)
    expect(failed.status).toBe('fixture')
    expect(failed.items.length).toBeGreaterThan(0)
    expect(c3.health()).toBe('fixture')
    await c3.search('interchangeable lens camera', 30000)
    expect(mock).toHaveBeenCalledTimes(1)
    advance(pause)
    expect(c3.health()).toBe('ok')
    expect((await c3.search('interchangeable lens camera', 30000)).status).toBe('ok')
    expect(JSON.stringify(log.mock.calls)).not.toContain('c3-test-key')
  })
  it('falls back after a timeout, and to a recording of the same kind of item', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const { fetch } = fakeFetch(timeout)
    const { c3 } = client({ fetch })
    const result = await c3.search('mirrorless camera', 44001)
    expect(result.status).toBe('fixture')
    expect(result.query).toBe('mirrorless camera')
    expect(result.items.every((item) => item.priceCents <= 42500)).toBe(true)
  })
  it('hides the panel when nothing recorded matches, the key is missing or the ceiling is under $25', async () => {
    const { fetch, mock } = fakeFetch(500)
    const failing = client({ fetch }).c3
    expect((await failing.search('garden hose', 44001)).status).toBe('off')
    const keyless = createChannel3({ fixtures, fetch })
    expect(keyless.health()).toBe('off')
    expect(await keyless.search('desk chair', 44001)).toMatchObject({ status: 'off', items: [] })
    expect((await client({ fetch }).c3.search('desk chair', 2400)).status).toBe('off')
    expect(mock).toHaveBeenCalledTimes(1)
  })
  it('serves only recordings in fixture mode and nothing in off mode', async () => {
    const { fetch, mock } = fakeFetch(camera.response)
    const recorded = client({ fetch, mode: 'fixture' }).c3
    expect(recorded.health()).toBe('fixture')
    expect((await recorded.search('desk chair', 44001)).status).toBe('fixture')
    const off = client({ fetch, mode: 'off' }).c3
    expect(off.health()).toBe('off')
    expect((await off.search('desk chair', 44001)).status).toBe('off')
    expect(mock).not.toHaveBeenCalled()
  })
  it('stops live calls at the daily limit and serves recordings until the next day', async () => {
    const { fetch, mock } = fakeFetch(camera.response)
    const { c3, advance } = client({ fetch, dailyLimit: 2 })
    await c3.search('desk chair', 30000)
    await c3.search('desk chair', 40000)
    expect((await c3.search('desk chair', 20000)).status).toBe('fixture')
    expect(mock).toHaveBeenCalledTimes(2)
    advance(24 * HOUR)
    expect((await c3.search('desk chair', 20000)).status).toBe('ok')
  })
  it('finds similar products for a known Channel3 product', async () => {
    const { fetch, calls } = fakeFetch(camera.response)
    const { c3 } = client({ fetch })
    const result = await c3.similar('DBouSIg', 44001)
    expect(result.status).toBe('ok')
    expect(calls[0]!.url).toBe('https://api.trychannel3.com/v1/similar')
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      product_id: 'DBouSIg',
      filters: { price: { max_price: 425 } },
    })
  })
  it('ships a recording for every catalog item', () => {
    const shipped: Channel3Fixtures = fixtures
    for (const id of ['camera', 'headphones', 'chair', 'backpack']) {
      const query = queryFor({ productId: id })!
      const recorded = shipped.searches.find((s) => s.query === query)
      expect(recorded, id).toBeTruthy()
      expect(parseProducts(recorded!.response, recorded!).length).toBeGreaterThan(0)
    }
  })
})

describe('what Worth searches for', () => {
  it('uses the catalog’s generic description, never the demo store or a brand', () => {
    expect(queryFor({ productId: 'camera' })).toBe('interchangeable lens camera')
    expect(queryFor({ itemName: 'Everyday camera' })).toBe('interchangeable lens camera')
    expect(queryFor({ itemName: 'a new Sony camera' })).toBe('interchangeable lens camera')
    expect(queryFor({ itemName: 'Studio headphones' })).toBe('over-ear headphones')
    expect(catalogItem('camera bag')).toBeUndefined()
    expect(queryFor({ itemName: 'Apple MacBook Pro 14-inch laptop' })).toBe('pro laptop')
    expect(genericQuery('Bose QC45 headphones')).toBe('headphones')
    expect(genericQuery('something cheaper')).toBeUndefined()
    expect(genericQuery(undefined)).toBeUndefined()
  })
  it.each([
    'Is there something cheaper?',
    'What can I buy under $300?',
    'What’s the cheapest thing that keeps my cushion?',
    'Show me something similar but less',
    'Can you find a cheaper camera?',
    "what's the cheapest thing in the store I could buy today without going under my cushion?",
  ])('recognises “%s” as a request for something cheaper', (message) => {
    expect(ALTERNATIVES_CUE.test(message)).toBe(true)
  })
  it.each(['Can I afford a $1,199 camera?', 'How much can I spend today?', 'What bills are coming up?'])(
    'leaves “%s” to the other answers',
    (message) => {
      expect(ALTERNATIVES_CUE.test(message)).toBe(false)
    },
  )
  it('reads the room today from the engine, and nothing on an incomplete plan', () => {
    const seed = createDemoState('2026-10-03')
    expect(roomToday(seed.profile, [], '2026-10-03')).toBe(44001)
    expect(roomToday({ ...seed.profile, confirmed: false }, [], '2026-10-03')).toBe(0)
  })
})
