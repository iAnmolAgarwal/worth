import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../server/app.ts'
import { createChannel3 } from '../server/channel3.ts'
import type { Channel3Client, LookupResult } from '../server/channel3.ts'
import { publicSaved } from '../server/saved.ts'
import { Store } from '../server/store.ts'
import type { AppState, ProductLookup, SavedItem } from '../shared/types.ts'

// C6, Saved with the store link: a saved item keeps the store page it came from, its store's name
// and who set its price; on the ready day it links back to the store, and a price Channel3 read is
// read again through the same lookup, limits and cache as a pasted link.

const LINK = 'https://shop.larkspur.example/products/trailhead-daypack-28l'
const READY = '2026-10-10'
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
const product = (patch: Partial<ProductLookup> = {}): ProductLookup => ({
  name: 'Trailhead Daypack 28L - Moss Green',
  priceCents: 12900,
  currency: 'USD',
  merchantName: 'shop.larkspur.example',
  merchantDomain: 'shop.larkspur.example',
  sourceUrl: LINK,
  status: 'ok',
  ...patch,
})
function fakeChannel3(result: LookupResult = { ok: true, product: product() }) {
  return {
    search: vi.fn(),
    similar: vi.fn(),
    checkPrice: vi.fn(),
    lookup: vi.fn(async () => result),
    health: vi.fn(() => 'ok' as const),
  } as unknown as Channel3Client & { lookup: ReturnType<typeof vi.fn> }
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
  const agent = request.agent(app).set('X-Worth-Client', 'web')
  /** The one session this agent made, as stored. */
  const sessionId = () =>
    (store.db.prepare('SELECT id FROM sessions').get() as { id: string } | undefined)!.id
  return { agent, store, sessionId }
}
type Agent = ReturnType<typeof setup>['agent']
const saveLinked = (agent: Agent, patch: Record<string, unknown> = {}) =>
  agent.post('/api/saved').send({
    kind: 'custom',
    name: 'Trailhead Daypack 28L',
    amountCents: 12900,
    waitDate: READY,
    sourceUrl: LINK,
    merchantName: 'Larkspur Supply',
    priceSource: 'channel3',
    ...patch,
  })
/** Moves Maya's sample day to the plan's date, so the plan is ready. */
async function toReadyDay(agent: Agent) {
  const moved = await agent.post('/api/demo-clock').send({ date: READY })
  expect(moved.status).toBe(200)
  return moved.body as AppState
}

describe('saving an item with its store link', () => {
  it('keeps the link, the store’s name and the price source, and stores them', async () => {
    const { agent, store, sessionId } = setup()
    const saved = await saveLinked(agent)
    expect(saved.status).toBe(200)
    expect(saved.body.item).toMatchObject({
      kind: 'custom',
      sourceUrl: LINK,
      merchantName: 'Larkspur Supply',
      priceSource: 'channel3',
      waitDate: READY,
    })
    const stored = store.get(sessionId())!.saved!.find((i) => i.id === saved.body.item.id)!
    expect(stored).toMatchObject({
      sourceUrl: LINK,
      merchantName: 'Larkspur Supply',
      priceSource: 'channel3',
    })
    const state = (await agent.get('/api/state')).body as AppState
    expect(state.saved!.find((i) => i.id === saved.body.item.id)).toMatchObject({
      sourceUrl: LINK,
      merchantName: 'Larkspur Supply',
      priceSource: 'channel3',
    })
  })

  it('names the store by its domain when none is sent, and drops the fragment', async () => {
    const { agent } = setup()
    const saved = await saveLinked(agent, {
      sourceUrl: `${LINK.replace('https://shop.', 'https://www.shop.')}#reviews`,
      merchantName: undefined,
      priceSource: 'user',
    })
    expect(saved.status).toBe(200)
    expect(saved.body.item).toMatchObject({
      sourceUrl: 'https://www.shop.larkspur.example/products/trailhead-daypack-28l',
      merchantName: 'shop.larkspur.example',
      priceSource: 'user',
    })
  })

  it('accepts the store button’s own price source for /check', async () => {
    const { agent } = setup()
    const saved = await saveLinked(agent, { priceSource: 'component' })
    expect(saved.status).toBe(200)
    expect(saved.body.item.priceSource).toBe('component')
  })

  it.each([
    ['http, not https', { sourceUrl: 'http://shop.larkspur.example/p' }],
    ['a user name in it', { sourceUrl: 'https://user:pw@shop.larkspur.example/p' }],
    ['a user name only', { sourceUrl: 'https://user@shop.larkspur.example/p' }],
    ['a script link', { sourceUrl: 'javascript:alert(1)' }],
    ['an IP address', { sourceUrl: 'https://169.254.169.254/latest' }],
    ['localhost', { sourceUrl: 'https://localhost/p' }],
    ['a port', { sourceUrl: 'https://shop.larkspur.example:8443/p' }],
    ['over 2,048 characters', { sourceUrl: `https://shop.larkspur.example/${'a'.repeat(2048)}` }],
    ['no price source', { priceSource: undefined }],
    ['a price source without a link', { sourceUrl: undefined }],
    ['a store name without a link', { sourceUrl: undefined, priceSource: undefined }],
    ['an unknown price source', { priceSource: 'catalog' }],
    ['a hidden character in the store name', { merchantName: 'Lark‮spur' }],
    ['a store name over 80 characters', { merchantName: 'x'.repeat(81) }],
  ])('refuses %s', async (_label, patch) => {
    const channel3 = fakeChannel3()
    const { agent } = setup(channel3)
    const response = await saveLinked(agent, patch)
    expect(response.status).toBe(400)
    // The link is never fetched or looked up when it is saved.
    expect(channel3.lookup).not.toHaveBeenCalled()
  })

  it('saves the same store page once, with the latest confirmed price and source', async () => {
    const { agent } = setup()
    await saveLinked(agent)
    const again = await saveLinked(agent, { amountCents: 11900, priceSource: 'user' })
    const linked = (again.body.state as AppState).saved!.filter((i) => i.sourceUrl === LINK)
    expect(linked).toHaveLength(1)
    expect(linked[0]).toMatchObject({ amountCents: 11900, priceSource: 'user' })
    // An item with no link at the same name and price stays a separate item.
    const plain = await agent
      .post('/api/saved')
      .send({ kind: 'custom', name: 'Trailhead Daypack 28L', amountCents: 11900 })
    expect((plain.body.state as AppState).saved!.filter((i) => i.kind === 'custom')).toHaveLength(2)
  })
})

describe('items saved before the store link (migration)', () => {
  it('leaves Maya’s seed items unchanged', async () => {
    const { agent } = setup()
    const state = (await agent.get('/api/state')).body as AppState
    expect(state.saved!.map((i) => i.productId)).toEqual(['camera', 'headphones'])
    for (const item of state.saved!) {
      expect(Object.keys(item).sort()).toEqual(
        ['amountCents', 'createdAt', 'id', 'kind', 'name', 'productId', 'status'].sort(),
      )
    }
  })

  it('reads stored items without the fields, or with damaged ones, safely', async () => {
    const { agent, store, sessionId } = setup()
    await agent.get('/api/state')
    const data = store.get(sessionId())!
    const base = {
      kind: 'custom' as const,
      amountCents: 5000,
      createdAt: '2026-10-03T12:00:00.000Z',
      status: 'active' as const,
    }
    data.saved = [
      { ...base, id: 'old', name: 'Old custom item' },
      { ...base, id: 'bad-link', name: 'Bad link', sourceUrl: 'http://evil.example/x' },
      {
        ...base,
        id: 'no-name',
        name: 'No store name',
        sourceUrl: 'https://www.shop.example.com/p',
        priceSource: 'bogus' as never,
      },
    ]
    store.save(sessionId(), data)
    const saved = ((await agent.get('/api/state')).body as AppState).saved!
    const byId = Object.fromEntries(saved.map((i) => [i.id, i]))
    expect(byId.old).toEqual({ ...base, id: 'old', name: 'Old custom item' })
    expect(byId['bad-link']).toEqual({ ...base, id: 'bad-link', name: 'Bad link' })
    expect(byId['no-name']).toMatchObject({
      sourceUrl: 'https://www.shop.example.com/p',
      merchantName: 'shop.example.com',
      priceSource: 'user',
    })
  })

  it('returns an item without a link exactly as stored', () => {
    const item: SavedItem = {
      id: 'a',
      kind: 'catalog',
      productId: 'camera',
      name: 'Everyday camera',
      amountCents: 119900,
      createdAt: '2026-10-03T12:00:00.000Z',
      status: 'active',
    }
    expect(publicSaved([item], '2026-10-03', [])).toEqual([item])
  })
})

describe('the ready day’s price re-check', () => {
  it('reports a changed price through the lookup path', async () => {
    const channel3 = fakeChannel3({ ok: true, product: product({ priceCents: 10900 }) })
    const { agent } = setup(channel3)
    const { item } = (await saveLinked(agent)).body
    await toReadyDay(agent)
    const response = await agent.post(`/api/saved/${item.id}/recheck`).send({})
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      status: 'changed',
      savedPriceCents: 12900,
      priceCents: 10900,
    })
    expect(channel3.lookup).toHaveBeenCalledOnce()
    expect(channel3.lookup).toHaveBeenCalledWith(LINK, expect.anything())
    // The saved price stays the one the shopper confirmed.
    const state = (await agent.get('/api/state')).body as AppState
    expect(state.saved!.find((i) => i.id === item.id)!.amountCents).toBe(12900)
  })

  it('reports the same price', async () => {
    const { agent } = setup(fakeChannel3())
    const { item } = (await saveLinked(agent)).body
    await toReadyDay(agent)
    const response = await agent.post(`/api/saved/${item.id}/recheck`).send({})
    expect(response.body).toEqual({ status: 'same', savedPriceCents: 12900, priceCents: 12900 })
  })

  it.each([
    ['a failed read', { ok: false, reason: 'failed' }],
    ['the limit', { ok: false, reason: 'limit' }],
    ['Channel3 off', { ok: false, reason: 'off' }],
    ['no product', { ok: false, reason: 'not-found' }],
    ['no price for this store', { ok: true, product: product({ priceCents: undefined }) }],
    ['a price in pounds', { ok: true, product: product({ currency: 'GBP' }) }],
    ['a recorded example', { ok: true, product: product({ priceCents: 9900, status: 'fixture' }) }],
  ] as const)('keeps the saved price after %s', async (_label, result) => {
    const { agent } = setup(fakeChannel3(result as LookupResult))
    const { item } = (await saveLinked(agent)).body
    await toReadyDay(agent)
    const response = await agent.post(`/api/saved/${item.id}/recheck`).send({})
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'unavailable', savedPriceCents: 12900 })
  })

  it('runs only on or after the plan’s day', async () => {
    const channel3 = fakeChannel3()
    const { agent } = setup(channel3)
    const { item } = (await saveLinked(agent)).body
    const early = await agent.post(`/api/saved/${item.id}/recheck`).send({})
    expect(early.status).toBe(409)
    expect(early.body.code).toBe('NOT_READY')
    expect(channel3.lookup).not.toHaveBeenCalled()
  })

  it('reads only a price Channel3 read, never the shopper’s or the store button’s', async () => {
    const channel3 = fakeChannel3()
    const { agent } = setup(channel3)
    const user = (await saveLinked(agent, { priceSource: 'user' })).body.item
    const other = 'https://shop.larkspur.example/products/other'
    const component = (await saveLinked(agent, { sourceUrl: other, priceSource: 'component' })).body
      .item
    const plain = (
      await agent
        .post('/api/saved')
        .send({ kind: 'custom', name: 'Bike', amountCents: 5000, waitDate: READY })
    ).body.item
    await toReadyDay(agent)
    for (const item of [user, component, plain]) {
      const response = await agent.post(`/api/saved/${item.id}/recheck`).send({})
      expect(response.status).toBe(409)
      expect(response.body.code).toBe('NOT_RECHECKABLE')
    }
    expect((await agent.post('/api/saved/nope/recheck').send({})).status).toBe(404)
    expect((await agent.post(`/api/saved/${user.id}/recheck`).send({ url: LINK })).status).toBe(400)
    expect(channel3.lookup).not.toHaveBeenCalled()
  })

  it('shares the pasted link’s cache and this client’s hourly share of lookups', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            product: {
              title: 'Trailhead Daypack 28L',
              offers: [
                {
                  domain: 'shop.larkspur.example',
                  price: { price: 109, currency: 'USD' },
                  availability: 'InStock',
                },
              ],
            },
          }),
          { status: 200 },
        ),
    )
    const channel3 = createChannel3({
      apiKey: 'k',
      fetch: fetch as unknown as typeof globalThis.fetch,
      log: () => {},
    })
    const { agent } = setup(channel3, { channel3IpHourlyLimit: 1 })
    const { item } = (await saveLinked(agent)).body
    // A second saved page, read by nobody yet.
    const other = 'https://shop.larkspur.example/products/other'
    const second = (await saveLinked(agent, { sourceUrl: other })).body.item
    await toReadyDay(agent)
    // The pasted link spends the client's one live lookup this hour.
    expect((await agent.post('/api/lookup').send({ url: LINK })).status).toBe(200)
    // The same page on the ready day comes from that lookup's cache.
    const cached = await agent.post(`/api/saved/${item.id}/recheck`).send({})
    expect(cached.body).toEqual({ status: 'changed', savedPriceCents: 12900, priceCents: 10900 })
    // Another page would need a live lookup, and the client's share is used up.
    const limited = await agent.post(`/api/saved/${second.id}/recheck`).send({})
    expect(limited.body).toEqual({ status: 'unavailable', savedPriceCents: 12900 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
