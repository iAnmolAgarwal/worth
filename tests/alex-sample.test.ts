// The default sample (SAMPLE_PERSONA=alex): a new session is Alex pinned to Fri Nov 13 2026, the
// demo-dec15 preset is his return visit, and the story's dates hold through the API, the store
// hand-off and the MCP check. The rest of the suite runs as Maya (vitest.config.ts).
import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../server/app.ts'
import { loadConfig } from '../server/config.ts'
import { Store } from '../server/store.ts'
import { createHandoff } from '../shared/handoff.ts'
import type { AppState, Comparison } from '../shared/types.ts'

const SECRET = Buffer.alloc(32, 7).toString('base64url')
const STORE = 'https://store.example'
const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
// The real day the judges open it does not matter: Alex's day is pinned.
const clock = { value: new Date('2027-02-20T15:00:00Z') }

function setup(handoff = true) {
  const store = new Store(':memory:')
  stores.push(store)
  const app = createApp({
    store,
    now: () => clock.value,
    config: {
      production: false,
      origin: 'http://localhost:5173',
      paypalClientId: undefined,
      paypalSecret: undefined,
      anthropicKey: undefined,
      samplePersona: 'alex',
      ...(handoff ? { handoffSecret: SECRET, merchantOrigin: STORE } : {}),
    },
  })
  return { app, store, agent: request.agent(app) }
}
type Agent = ReturnType<typeof request.agent>
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(path).set('X-Worth-Client', 'web').send(body)
const state = async (agent: Agent) => (await agent.get('/api/state')).body as AppState
const camera = async (agent: Agent) => {
  const res = await post(agent, '/api/compare', { productId: 'halden-x5' })
  expect(res.status).toBe(200)
  return (res.body.comparison ?? res.body) as Comparison
}

describe('the default sample: Alex on the demo day', () => {
  it('starts a new session as Alex on Fri Nov 13 2026, whatever the real date', async () => {
    const { agent } = setup()
    const s = await state(agent)
    expect(s.today).toBe('2026-11-13')
    expect(s.demoClock).toEqual({ today: '2026-11-13', preset: 'demo' })
    expect(s.profile).toMatchObject({ name: 'Alex', balanceCents: 254000, source: 'demo' })
    expect(s.config.sample).toBe('alex')
    // Saved holds the camera (no date yet) and the headphones, with no store name or link.
    expect(s.saved!.map((i) => [i.productId, i.waitDate, i.sourceUrl, i.merchantName])).toEqual([
      ['halden-x5', undefined, undefined, undefined],
      ['headphones', undefined, undefined, undefined],
    ])
    expect(s.products[0]!.id).toBe('halden-x5')
    expect(JSON.stringify(s)).not.toMatch(/Maya/)
  })

  it('waits the Halden X5 until Tue Dec 15, with $872.26 of room today', async () => {
    const { agent } = setup()
    const c = await camera(agent)
    expect(c.wait.date).toBe('2026-12-15')
    expect(c.spendLess.maxPriceCents).toBe(87226)
    expect(c.buyToday.lowestBalanceCents).toBe(-72674)
  })

  it('edits Alex’s plan on the pinned day, keeps the day, and starts again from $2,540', async () => {
    const { agent } = setup()
    const s = await state(agent)
    const res = await agent
      .patch('/api/profile')
      .set('X-Worth-Client', 'web')
      .send({ profile: { ...s.profile, balanceCents: 300000 } })
    expect(res.status).toBe(200)
    const edited = res.body as AppState
    expect(edited.today).toBe('2026-11-13')
    expect(edited.demoClock).toEqual({ today: '2026-11-13', preset: 'demo' })
    expect(edited.profile).toMatchObject({ balanceCents: 300000, userEdited: true })
    // Room to spend follows the edit: $460 more than the sample's $872.26.
    expect((await camera(agent)).spendLess.maxPriceCents).toBe(87226 + 46000)
    // A snapshot dated after the pinned day is refused, even though the real date is later.
    const ahead = await agent
      .patch('/api/profile')
      .set('X-Worth-Client', 'web')
      .send({ profile: { ...edited.profile, snapshotDate: '2026-11-14' } })
    expect(ahead.status).toBe(400)
    const again = (await post(agent, '/api/demo-clock', { preset: 'demo' })).body as AppState
    expect(again.profile).toMatchObject({ balanceCents: 254000, userEdited: false })
    expect(again.today).toBe('2026-11-13')
  })

  it('drops the sample’s own saved items on import, and keeps what the person saved', async () => {
    const { agent } = setup()
    await post(agent, '/api/demo-clock', { preset: 'demo-dec15' })
    expect((await post(agent, '/api/saved', { kind: 'catalog', productId: 'chair' })).status).toBe(
      200,
    )
    const csv =
      'Date,Name,Net,Currency,Type,Status,Transaction ID\n12/01/2026,Coffee,-5.00,USD,Payment,Completed,ABC123'
    const imported = await post(agent, '/api/import/commit', { csv, dateOrder: 'MM/DD' })
    expect(imported.status).toBe(200)
    const s = imported.body as AppState
    expect(s.profile.source).toBe('import')
    expect(s.saved!.map((i) => i.productId)).toEqual(['chair'])
  })

  it('"today" restarts Alex on his demo day: his dates are fixed', async () => {
    const { agent } = setup()
    await post(agent, '/api/demo-clock', { preset: 'demo-dec15' })
    const back = (await post(agent, '/api/demo-clock', { preset: 'today' })).body as AppState
    expect(back.today).toBe('2026-11-13')
    expect(back.demoClock?.preset).toBe('demo')
    expect(back.profile.balanceCents).toBe(254000)
  })

  it('keeps ?replay=video as Maya on Oct 3, for the tests and the first video', async () => {
    const { agent } = setup()
    const s = (await post(agent, '/api/demo-clock', { preset: 'video' })).body as AppState
    expect(s.profile.name).toBe('Maya')
    expect(s.today).toBe('2026-10-03')
  })
})

describe('the return visit: demo-dec15', () => {
  it('is Alex on Tue Dec 15 with the camera saved for the day, ready, and no store link', async () => {
    const { agent } = setup()
    const s = (await post(agent, '/api/demo-clock', { preset: 'demo-dec15' })).body as AppState
    expect(s.today).toBe('2026-12-15')
    expect(s.demoClock).toEqual({ today: '2026-12-15', preset: 'demo-dec15' })
    expect(s.profile.balanceCents).toBe(368552)
    expect(s.fundsProjection).toBeUndefined()
    expect(s.saved).toHaveLength(2)
    const saved = s.saved!.find((i) => i.productId === 'halden-x5')!
    expect(saved.sourceUrl).toBeUndefined()
    expect(saved.merchantName).toBeUndefined()
    expect(saved).toMatchObject({
      kind: 'catalog',
      productId: 'halden-x5',
      amountCents: 189900,
      option: 'wait',
      waitDate: '2026-12-15',
      status: 'ready',
    })
    const c = await camera(agent)
    expect(c.buyToday.outcome).toBe('fits')
  })

  it('follows the store hand-off: a quote from ?replay=demo-dec15 opens on Dec 15', async () => {
    const { agent } = setup()
    await agent.get('/api/state')
    const larkspur = createHandoff({
      secret: SECRET,
      mid: 'larkspur',
      merchantOrigin: STORE,
      now: () => clock.value.getTime(),
    })
    const token = larkspur.signQuote({
      qid: 'q_abcdefghijklmnopqrstuv',
      item: 'Halden X5',
      productId: 'halden-x5',
      amountCents: 189900,
      currency: 'USD',
      merchant: 'Larkspur Supply',
      returnUrl: `${STORE}/p/halden-x5?replay=demo-dec15`,
      replay: 'demo-dec15',
    })
    const res = await post(agent, '/api/handoff/open', { token })
    expect(res.status).toBe(200)
    expect(res.body.replay).toBe(true)
    expect((res.body.state as AppState).today).toBe('2026-12-15')
  })
})

describe('the MCP check on Alex', () => {
  it('answers Dec 15 for the camera, day 32, without INCOHERENT_RESULT', async () => {
    const { app, agent } = setup()
    await agent.get('/api/state')
    const created = await post(agent, '/api/agent-tokens')
    expect(created.status).toBe(200)
    const res = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${created.body.token}`)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'check_affordability', arguments: { item: 'Halden X5', amount_usd: 1899 } },
      })
    expect(res.status).toBe(200)
    expect(res.body.result.isError).toBeFalsy()
    expect(res.body.result.structuredContent).toMatchObject({
      as_of: '2026-11-13',
      affordability_status: 'affordable_later',
      earliest_date_for_full_payment: '2026-12-15',
    })
  })
})

describe('SAMPLE_PERSONA', () => {
  it('defaults to alex, accepts maya and refuses anything else', () => {
    expect(loadConfig({}).samplePersona).toBe('alex')
    expect(loadConfig({ SAMPLE_PERSONA: 'maya' }).samplePersona).toBe('maya')
    expect(() => loadConfig({ SAMPLE_PERSONA: 'bob' })).toThrow(/SAMPLE_PERSONA/)
  })
})
