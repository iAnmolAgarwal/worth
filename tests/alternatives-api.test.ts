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
    expect(channel3.search).toHaveBeenCalledWith('interchangeable lens camera', 44001)
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
    expect(channel3.search.mock.calls).toEqual([
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
  })
  it('finds similar products for a Channel3 product ID', async () => {
    const channel3 = fakeChannel3()
    const { agent } = setup(channel3)
    const response = await agent.get('/api/alternatives?similarTo=DBouSIg')
    expect(response.status).toBe(200)
    expect(channel3.similar).toHaveBeenCalledWith('DBouSIg', 44001)
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
    expect(response.body.status).toBe('fixture')
    expect(response.body.items.length).toBeGreaterThan(0)
    expect(JSON.stringify(response.body)).not.toContain('c3-test-key')
    expect((await agent.get('/api/health')).body.channel3).toBe('fixture')
    expect((await agent.get('/api/state')).body.config.alternatives).toBe('fixture')
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
    expect(channel3.search).toHaveBeenCalledWith('interchangeable lens camera', 44001)
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
    expect(channel3.search).toHaveBeenCalledWith('desk chair', 44001)
    expect(response.body.alternatives.items).toEqual([item])
  })
})
