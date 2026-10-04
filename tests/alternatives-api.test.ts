import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../server/app.ts'
import { createChannel3, loadFixtures } from '../server/channel3.ts'
import { createChatProvider } from '../server/chat.ts'
import type { Channel3Client } from '../server/channel3.ts'
import { Store } from '../server/store.ts'
import type { Alternatives, AppState } from '../shared/types.ts'

// GET /api/alternatives: the contract the Decision panel and Phase 5's "Save for later" rely on.
// The persona's room today is $440.01, so searches run under $425.

const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
const config = {
  production: false,
  origin: 'http://localhost:5173',
  paypalClientId: undefined,
  paypalSecret: undefined,
  anthropicKey: undefined,
}
const item = {
  id: 'DBouSIg',
  title: 'Interchangeable Lens Camera Body',
  retailer: 'bestbuy.com',
  priceCents: 32249,
  url: 'https://buy.trychannel3.com/DBouSIg',
  imageUrl: 'https://cdn.trychannel3.com/c6db56cb',
  availability: 'InStock' as const,
  source: 'channel3' as const,
}
function fakeChannel3(status: Alternatives['status'] = 'ok') {
  const result = (query: string, maxPriceCents: number): Alternatives => ({
    status,
    query,
    maxPriceCents: Math.floor(maxPriceCents / 2500) * 2500,
    items: status === 'off' ? [] : [item],
  })
  return {
    search: vi.fn(async (query: string, max: number) => result(query, max)),
    similar: vi.fn(async (id: string, max: number) => result(id, max)),
    checkPrice: vi.fn(async () => ({ status: 'unavailable' as const })),
    health: vi.fn(() => status),
  } satisfies Channel3Client
}
function setup(channel3: Channel3Client = fakeChannel3(), extra: Record<string, unknown> = {}) {
  const store = new Store(':memory:')
  stores.push(store)
  const app = createApp({
    store,
    config: { ...config, ...extra },
    channel3,
    now: () => new Date('2026-10-03T16:00:00Z'),
  })
  return { app, agent: request.agent(app) }
}

describe('GET /api/alternatives', () => {
  it('returns at most four items in the shared shape, searched under the room today', async () => {
    const channel3 = fakeChannel3()
    const { agent } = setup(channel3)
    const response = await agent.get('/api/alternatives?productId=camera')
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(channel3.search).toHaveBeenCalledWith(
      'interchangeable lens camera',
      44001,
      expect.anything(),
    )
    expect(response.body).toEqual({
      status: 'ok',
      query: 'interchangeable lens camera',
      maxPriceCents: 42500,
      items: [item],
    })
    expect(response.body.items.length).toBeLessThanOrEqual(4)
  })
  it('keeps a lower ceiling the person chose, and never searches above the room', async () => {
    const channel3 = fakeChannel3()
    const { agent } = setup(channel3)
    await agent.get('/api/alternatives?productId=chair&maxPriceCents=20000')
    await agent.get('/api/alternatives?productId=chair&maxPriceCents=900000')
    expect(channel3.search.mock.calls.map(([query, max]) => [query, max])).toEqual([
      ['desk chair', 20000],
      ['desk chair', 44001],
    ])
  })
  it('searches generic words for a named item, never its brand', async () => {
    const channel3 = fakeChannel3()
    const { agent } = setup(channel3)
    await agent
      .get('/api/alternatives')
      .query({ itemName: 'Bose QC45 headphones', amountCents: 32900 })
    await agent.get('/api/alternatives').query({ itemName: 'Herman Miller office chair' })
    expect(channel3.search.mock.calls.map(([query]) => query)).toEqual([
      'over-ear headphones',
      'office chair',
    ])
    const empty = await agent.get('/api/alternatives').query({ itemName: 'Sony 4K' })
    expect(empty.body).toEqual({ status: 'off', query: '', maxPriceCents: 0, items: [] })
    expect(channel3.search).toHaveBeenCalledTimes(2)
    // Names, health details and anything outside the category allowlist never leave the server.
    await agent.get('/api/alternatives').query({ itemName: 'engagement ring for Sarah' })
    for (const itemName of ['meds for my HIV', 'gift for Priya Sharma'])
      expect((await agent.get('/api/alternatives').query({ itemName })).body.status).toBe('off')
    expect(channel3.search.mock.calls.map(([query]) => query)).toEqual([
      'over-ear headphones',
      'office chair',
      'ring',
    ])
  })
  it('finds similar products for a Channel3 product ID', async () => {
    const channel3 = fakeChannel3()
    const { agent } = setup(channel3)
    // Only a product this session was shown can seed a similar search.
    const unseen = await agent.get('/api/alternatives?similarTo=DBouSIg')
    expect(unseen.body.status).toBe('off')
    expect(channel3.similar).not.toHaveBeenCalled()
    await agent.get('/api/alternatives?productId=camera')
    const response = await agent.get('/api/alternatives?similarTo=DBouSIg')
    expect(response.status).toBe(200)
    expect(channel3.similar).toHaveBeenCalledWith('DBouSIg', 44001, expect.anything())
  })
  it.each([
    ['', 400],
    ['?productId=spaceship', 404],
    ['?similarTo=../../v1/search', 400],
    ['?productId=camera&maxPriceCents=-5', 400],
    ['?productId=camera&extra=1', 400],
    [`?itemName=${'x'.repeat(151)}`, 400],
  ])('validates %s', async (query, status) => {
    const channel3 = fakeChannel3()
    const { agent } = setup(channel3)
    expect((await agent.get(`/api/alternatives${query}`)).status).toBe(status)
    expect(channel3.search).not.toHaveBeenCalled()
  })
  it('searches nothing on an incomplete plan, and each session gets its own ceiling', async () => {
    const channel3 = fakeChannel3()
    const { app, agent } = setup(channel3)
    const initial = (await agent.get('/api/state')).body as AppState
    await agent
      .patch('/api/profile')
      .set('X-Worth-Client', 'web')
      .send({ profile: { ...initial.profile, balanceCents: 200000, flows: [] } })
    await agent.get('/api/alternatives?productId=camera')
    await request.agent(app).get('/api/alternatives?productId=camera')
    expect(channel3.search.mock.calls.map(([, max]) => max)).toEqual([expect.any(Number), 44001])
    expect(channel3.search.mock.calls[0]![1]).not.toBe(44001)
    await agent
      .patch('/api/profile')
      .set('X-Worth-Client', 'web')
      .send({ profile: { ...initial.profile, confirmed: false } })
    const blocked = await agent.get('/api/alternatives?productId=camera')
    expect(channel3.search.mock.calls.at(-1)![1]).toBe(0)
    expect(blocked.status).toBe(200)
  })
  it('serves recorded example results when Channel3 fails, and reports it in health', async () => {
    const fetch = vi.fn(async () => new Response('{"detail":"credits"}', { status: 402 }))
    const channel3 = createChannel3({
      apiKey: 'c3-test-key',
      fixtures: loadFixtures(),
      fetch: fetch as unknown as typeof globalThis.fetch,
      log: () => {},
    })
    const { agent } = setup(channel3)
    expect((await agent.get('/api/health')).body).toEqual({
      ok: true,
      service: 'worth',
      channel3: 'ok',
    })
    const response = await agent.get('/api/alternatives?productId=camera')
    // Product reads fail too, so the recorded rows appear without a price or link.
    expect(response.body.status).toBe('fixture')
    expect(response.body.items).toEqual([])
    expect(response.body.unverified.length).toBeGreaterThan(0)
    expect(JSON.stringify(response.body.unverified)).not.toMatch(/priceCents|"url"/)
    expect(JSON.stringify(response.body)).not.toContain('c3-test-key')
    expect((await agent.get('/api/health')).body.channel3).toBe('fixture')
    expect((await agent.get('/api/state')).body.config.alternatives).toBe('fixture')
  })
  it('gives each client a share of the day’s live searches; cached answers stay free', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ products: [] }), { status: 200 }))
    const channel3 = createChannel3({
      apiKey: 'c3-test-key',
      fixtures: loadFixtures(),
      fetch: fetch as unknown as typeof globalThis.fetch,
      log: () => {},
    })
    const { agent } = setup(channel3, { channel3IpHourlyLimit: 2 })
    await agent.get('/api/alternatives').query({ itemName: 'desk lamp' })
    await agent.get('/api/alternatives').query({ itemName: 'desk lamp' })
    await agent.get('/api/alternatives').query({ itemName: 'office chair' })
    const third = await agent.get('/api/alternatives').query({ itemName: 'standing desk' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(third.body.status).not.toBe('ok')
  })
  it('finds similar products only for products the server has shown', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }))
    const channel3 = createChannel3({
      apiKey: 'c3-test-key',
      fetch: fetch as unknown as typeof globalThis.fetch,
      log: () => {},
    })
    const { agent } = setup(channel3)
    const response = await agent.get('/api/alternatives?similarTo=AnyIdAtAll')
    expect(response.body.status).toBe('off')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('checks whether a saved product’s price dropped, for the Saved list', async () => {
    const channel3 = fakeChannel3()
    channel3.checkPrice.mockResolvedValue({
      status: 'dropped',
      current: { priceCents: 30000, url: 'https://buy.trychannel3.com/x', retailer: 'bestbuy.com' },
      droppedByCents: 2249,
    } as never)
    const { app, agent } = setup(channel3)
    // Never for a product this session was not shown, including one another session saw.
    const unseen = await agent.get('/api/alternatives/price?id=DBouSIg&savedPriceCents=32249')
    expect(unseen.status).toBe(404)
    expect(channel3.checkPrice).not.toHaveBeenCalled()
    await agent.get('/api/alternatives?productId=camera')
    const other = request.agent(app)
    expect((await other.get('/api/alternatives/price?id=DBouSIg&savedPriceCents=1')).status).toBe(
      404,
    )
    const response = await agent.get('/api/alternatives/price?id=DBouSIg&savedPriceCents=32249')
    expect(response.body).toMatchObject({ status: 'dropped', droppedByCents: 2249 })
    expect(channel3.checkPrice).toHaveBeenCalledWith('DBouSIg', 32249)
    expect((await agent.get('/api/alternatives/price?id=../x&savedPriceCents=1')).status).toBe(400)
  })
  it('caps price checks per session and per IP, and reads each product once per 15 minutes', async () => {
    const reads: string[] = []
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/v1/products/')) {
        reads.push(url)
        return new Response(JSON.stringify({ id: 'DBouSIg', title: 'Camera body', offers: [] }), {
          status: 200,
        })
      }
      return new Response(
        JSON.stringify({
          products: [
            {
              id: 'DBouSIg',
              title: 'Camera body',
              offers: [
                {
                  url: 'https://buy.trychannel3.com/x',
                  domain: 'bestbuy.com',
                  price: { price: 322.49, currency: 'USD' },
                  availability: 'InStock',
                  condition: 'new',
                },
              ],
            },
          ],
        }),
        { status: 200 },
      )
    })
    const channel3 = createChannel3({
      apiKey: 'c3-test-key',
      fetch: fetch as unknown as typeof globalThis.fetch,
      log: () => {},
    })
    const { agent } = setup(channel3)
    await agent.get('/api/alternatives?productId=camera')
    const statuses: number[] = []
    for (let i = 0; i < 31; i++)
      statuses.push(
        (await agent.get('/api/alternatives/price?id=DBouSIg&savedPriceCents=32249')).status,
      )
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true)
    expect(statuses[30]).toBe(429)
    expect(reads).toHaveLength(1)
  })
  it('lets a session check prices of items Ask Worth listed for it', async () => {
    const channel3 = fakeChannel3()
    const { agent } = setup(channel3)
    await agent
      .post('/api/chat')
      .set('X-Worth-Client', 'web')
      .send({ message: 'Can you find a cheaper camera?', history: [] })
    const response = await agent.get('/api/alternatives/price?id=DBouSIg&savedPriceCents=32249')
    expect(response.status).toBe(200)
    expect(channel3.checkPrice).toHaveBeenCalledWith('DBouSIg', 32249)
  })
  it('reports off and hides the panel without a key', async () => {
    const { agent } = setup(createChannel3({ fixtures: loadFixtures() }))
    expect((await agent.get('/api/health')).body.channel3).toBe('off')
    expect((await agent.get('/api/alternatives?productId=camera')).body.status).toBe('off')
  })
  it('allows Channel3’s image CDN in img-src only, in the production policy', async () => {
    const { app } = setup(fakeChannel3(), {
      production: true,
      trustProxy: 1,
      origin: 'https://worth.example.com',
    })
    const policy = (await request(app).get('/api/health')).headers[
      'content-security-policy'
    ] as string
    const directives = Object.fromEntries(
      policy.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)]),
    )
    expect(directives['img-src']).toContain('https://cdn.trychannel3.com')
    for (const [name, sources] of Object.entries(directives))
      if (name !== 'img-src') expect(sources, name).not.toContain('https://cdn.trychannel3.com')
    expect(policy).not.toContain('api.trychannel3.com')
    expect(policy).not.toContain('buy.trychannel3.com')
  })
})

describe('POST /api/chat for something cheaper', () => {
  it('searches through the server in local mode, sending nothing to Claude', async () => {
    const channel3 = fakeChannel3()
    const { agent } = setup(channel3)
    const response = await agent
      .post('/api/chat')
      .set('X-Worth-Client', 'web')
      .send({ message: 'Can you find a cheaper camera?', history: [] })
    expect(response.status).toBe(200)
    expect(response.body.mode).toBe('demo')
    expect(response.body.intent).toBe('alternatives')
    expect(response.body.alternatives).toEqual({
      status: 'ok',
      query: 'interchangeable lens camera',
      maxPriceCents: 42500,
      items: [item],
    })
    expect(channel3.search).toHaveBeenCalledWith(
      'interchangeable lens camera',
      44001,
      expect.anything(),
    )
  })
  it('gives the model the find_alternatives tool, backed by the same search', async () => {
    const channel3 = fakeChannel3()
    const create = vi.fn(async () => ({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'find_alternatives',
          input: {
            item: 'desk chair',
            max_price_cents: null,
            points: [],
            lead_in: 'none',
            follow_ups: [],
          },
        },
      ],
    }))
    const chat = createChatProvider(
      'unused',
      'claude-sonnet-5-5',
      {
        messages: { create },
      } as unknown as Parameters<typeof createChatProvider>[2],
      { log: () => {} },
    )
    const store = new Store(':memory:')
    stores.push(store)
    const app = createApp({
      store,
      config,
      channel3,
      chat,
      now: () => new Date('2026-10-03T16:00:00Z'),
    })
    const response = await request(app)
      .post('/api/chat')
      .set('X-Worth-Client', 'web')
      .send({ message: 'Any cheaper desk chairs?', history: [] })
    expect(response.body.mode).toBe('anthropic')
    expect(response.body.toolCalls).toEqual(['find_alternatives'])
    expect(channel3.search).toHaveBeenCalledWith('desk chair', 44001, expect.anything())
    expect(response.body.alternatives.items).toEqual([item])
  })
})

// Spec item 15: a Channel3 row's "Save for later" saves a custom item that keeps the product's ID,
// so Saved can check its price again; it is never sold or checked out here.
describe('saving a similar item for later', () => {
  const post = (agent: ReturnType<typeof request.agent>, path: string, body: object) =>
    agent.post(path).set('X-Worth-Client', 'web').send(body)
  const row = {
    kind: 'custom',
    name: item.title,
    amountCents: item.priceCents,
    retailer: item.retailer,
    url: item.url,
    channel3Id: item.id,
  }

  it('saves the row as an assessment-only item whose price can be checked later', async () => {
    const channel3 = fakeChannel3()
    channel3.checkPrice.mockResolvedValue({ status: 'same' } as never)
    const { app, agent } = setup(channel3)
    await agent.get('/api/alternatives?productId=camera')
    const remember = vi.spyOn(app.locals, 'rememberAlternative')
    const saved = await post(agent, '/api/saved', row)
    expect(saved.status).toBe(200)
    expect(saved.body.item).toMatchObject({ ...row, status: 'active' })
    expect(remember).toHaveBeenCalledWith(expect.any(String), item.id)
    // Saving the same product again updates the one saved item.
    const again = await post(agent, '/api/saved', { ...row, name: 'Renamed' })
    expect(again.body.item.id).toBe(saved.body.item.id)
    // Never checked out: it is not in the demo store.
    const prepare = await post(agent, `/api/saved/${saved.body.item.id}/prepare`, {})
    expect(prepare.body.code).toBe('NOT_IN_STORE')
    const check = await agent.get(`/api/alternatives/price?id=${item.id}&savedPriceCents=32249`)
    expect(check.status).toBe(200)
    expect(channel3.checkPrice).toHaveBeenCalledWith(item.id, 32249)
  })

  it('keeps the price check after a restart, for a product the session saved', async () => {
    const channel3 = fakeChannel3()
    channel3.checkPrice.mockResolvedValue({ status: 'same' } as never)
    const store = new Store(':memory:')
    stores.push(store)
    const make = () =>
      createApp({ store, config, channel3, now: () => new Date('2026-10-03T16:00:00Z') })
    const first = request.agent(make())
    await first.get('/api/alternatives?productId=camera')
    expect((await post(first, '/api/saved', row)).status).toBe(200)
    const cookie = (await first.get('/api/state')).request.cookies
    // A new server process has no record of what it showed; the saved item still counts.
    const restarted = request(make())
    const check = await restarted
      .get(`/api/alternatives/price?id=${item.id}&savedPriceCents=32249`)
      .set('Cookie', cookie)
    expect(check.status).toBe(200)
  })

  it('never registers a product the session was not shown', async () => {
    const channel3 = fakeChannel3()
    const { app, agent } = setup(channel3)
    const remember = vi.spyOn(app.locals, 'rememberAlternative')
    const saved = await post(agent, '/api/saved', { ...row, channel3Id: 'SomeOtherId' })
    expect(saved.status).toBe(200)
    expect(saved.body.item.channel3Id).toBeUndefined()
    expect(remember).not.toHaveBeenCalled()
    const check = await agent.get('/api/alternatives/price?id=SomeOtherId&savedPriceCents=1')
    expect(check.status).toBe(404)
    expect(channel3.checkPrice).not.toHaveBeenCalled()
    expect((await post(agent, '/api/saved', { ...row, channel3Id: '../x' })).status).toBe(400)
    // Its link goes with it, so a stripped row keeps no link from an unchecked source.
    expect(saved.body.item.url).toBeUndefined()
  })

  // Re-judge N2: a saved row keeps only a link Channel3 itself allows.
  it('keeps Channel3’s own link rule for a saved row, and no credentials in any link', async () => {
    const { agent } = setup()
    await agent.get('/api/alternatives?productId=camera')
    for (const url of [
      'https://evil.example/phish',
      'https://bestbuy.com.evil.example/x',
      'https://user:pw@bestbuy.com/x',
    ])
      expect((await post(agent, '/api/saved', { ...row, url })).status).toBe(400)
    for (const url of ['https://www.bestbuy.com/site/123', 'https://buy.trychannel3.com/DBouSIg'])
      expect((await post(agent, '/api/saved', { ...row, url })).status).toBe(200)
    const typed = { kind: 'custom', name: 'Road bike', amountCents: 64900 }
    expect(
      (await post(agent, '/api/saved', { ...typed, url: 'https://user:pw@shop.example/bike' }))
        .status,
    ).toBe(400)
    expect(
      (await post(agent, '/api/saved', { ...typed, url: 'https://shop.example/bike' })).status,
    ).toBe(200)
  })

  // Re-judge N3: real listing titles save; hidden characters are still refused.
  it('saves real titles with trademarks, dashes and accents, never hidden characters', async () => {
    const { agent } = setup()
    for (const name of [
      'Sony™ Alpha a6400 – Mirrorless Camera Body®',
      'Café Racer Helmet — Matte Noir',
      'Bose QuietComfort® 45 Headphones – Triple Black',
    ])
      expect(
        (await post(agent, '/api/saved', { kind: 'custom', name, amountCents: 10000 })).status,
      ).toBe(200)
    for (const name of ['x\u2060y', 'Camera\uFEFF Body', 'x\u200By'])
      expect(
        (await post(agent, '/api/saved', { kind: 'custom', name, amountCents: 10000 })).status,
      ).toBe(400)
  })
})
