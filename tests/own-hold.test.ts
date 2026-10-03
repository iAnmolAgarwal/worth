import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../server/app.ts'
import { Store } from '../server/store.ts'
import { withoutOwnHold } from '../shared/finance.ts'
import type { Purchase } from '../shared/types.ts'

const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function setup(now = '2026-10-03T12:00:00Z') {
  const store = new Store(':memory:')
  stores.push(store)
  const app = createApp({
    store,
    config: {
      production: false,
      port: 5173,
      host: '127.0.0.1',
      origin: 'http://localhost:5173',
      paypalClientId: undefined,
      paypalSecret: undefined,
      anthropicKey: undefined,
    },
    now: () => new Date(now),
  })
  return request.agent(app)
}
const post = (
  agent: ReturnType<typeof setup>,
  path: string,
  body: object = {},
  timezone = 'America/New_York',
) => agent.post(path).set('X-Worth-Client', 'web').set('X-Worth-Timezone', timezone).send(body)

const hold = (patch: Partial<Purchase>): Purchase => ({
  id: 'p',
  productId: 'backpack',
  name: 'Travel backpack',
  amountCents: 12900,
  currency: 'USD',
  mode: 'demo',
  status: 'created',
  createdAt: '2026-10-03T12:00:00Z',
  profileVersion: 1,
  assessmentDate: '2026-10-03',
  ...patch,
})

describe('an item is never assessed against its own checkout hold', () => {
  it('drops only an active hold for the same item', () => {
    const purchases = [
      hold({ id: 'own' }),
      hold({ id: 'paid', status: 'completed' }),
      hold({ id: 'other', productId: 'camera', name: 'Everyday camera', amountCents: 119900 }),
    ]
    expect(
      withoutOwnHold(purchases, { productId: 'backpack', amountCents: 12900 }).map((p) => p.id),
    ).toEqual(['paid', 'other'])
    expect(
      withoutOwnHold(purchases, { itemName: 'backpack', amountCents: 12900 }).map((p) => p.id),
    ).toEqual(['paid', 'other'])
    expect(
      withoutOwnHold(purchases, { itemName: 'backpack', amountCents: 9900 }).map((p) => p.id),
    ).toEqual(['own', 'paid', 'other'])
  })

  it('compares and assesses the held backpack exactly as before the hold', async () => {
    const agent = setup()
    const before = (await post(agent, '/api/compare', { productId: 'backpack' })).body
    const assessBefore = (
      await post(agent, '/api/assess', { amountCents: 12900, itemName: 'Travel backpack' })
    ).body
    const created = await post(agent, '/api/checkout/create', {
      productId: 'backpack',
      acknowledgeShortfall: true,
    })
    expect(created.status).toBe(200)
    const after = (await post(agent, '/api/compare', { productId: 'backpack' })).body
    expect(after.buyToday.lowestBalanceCents).toBe(before.buyToday.lowestBalanceCents)
    expect(after.buyToday.headroomCents).toBe(before.buyToday.headroomCents)
    const assessAfter = (
      await post(agent, '/api/assess', { amountCents: 12900, itemName: 'Travel backpack' })
    ).body
    expect(assessAfter.lowestBalanceCents).toBe(assessBefore.lowestBalanceCents)
    // Another item still sees the backpack's hold.
    const camera = (await post(agent, '/api/compare', { productId: 'headphones' })).body
    const fresh = (await post(setup(), '/api/compare', { productId: 'headphones' })).body
    expect(camera.buyToday.lowestBalanceCents).toBe(fresh.buyToday.lowestBalanceCents - 12900)
  })

  it('dates a captured purchase on the buyer’s own calendar day', async () => {
    // 8 pm UTC on Oct 3 is already Oct 4 in India.
    const agent = setup('2026-10-03T20:00:00Z')
    const zone = 'Asia/Kolkata'
    const created = await post(
      agent,
      '/api/checkout/create',
      { productId: 'backpack', acknowledgeShortfall: true },
      zone,
    )
    const captured = await post(
      agent,
      `/api/checkout/${created.body.purchase.id}/capture`,
      { acknowledgeShortfall: true },
      zone,
    )
    expect(captured.status).toBe(200)
    const row = captured.body.state.transactions.find(
      (t: { source: string }) => t.source === 'purchase',
    )
    expect(row.date).toBe('2026-10-04')
    expect(captured.body.purchase.assessmentDate).toBe('2026-10-04')
  })
})
