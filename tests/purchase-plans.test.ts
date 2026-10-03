import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../server/app.ts'
import { Store } from '../server/store.ts'
import type { PayPalGateway } from '../server/paypal.ts'
import { addDays } from '../shared/finance.ts'
import type { AppState } from '../shared/types.ts'

const TODAY = '2026-10-03'
const stores: Store[] = []
const clock = { value: new Date(`${TODAY}T12:00:00Z`) }
type Agent = ReturnType<typeof request.agent>

function setup(paypal?: PayPalGateway) {
  clock.value = new Date(`${TODAY}T12:00:00Z`)
  const store = new Store(':memory:')
  stores.push(store)
  const app = createApp({
    store,
    paypal,
    now: () => clock.value,
    config: {
      production: false,
      origin: 'http://localhost:5173',
      paypalClientId: undefined,
      paypalSecret: undefined,
      anthropicKey: undefined,
    },
  })
  return { app, store, agent: request.agent(app) }
}
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(path).set('X-Worth-Client', 'web').send(body)
async function state(agent: Agent): Promise<AppState> {
  const result = await agent.get('/api/state')
  expect(result.status).toBe(200)
  return result.body
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe('profile instalment plans and items already paid today', () => {
  it('saves instalment plan payments and honours a paid mark no later than the funds date', async () => {
    const { agent } = setup()
    const initial = await state(agent)
    let version = initial.profile.version
    const save = async (extra: AppState['profile']['flows']) => {
      const response = await agent
        .patch('/api/profile')
        .set('X-Worth-Client', 'web')
        .send({
          profile: { ...initial.profile, version, flows: [...initial.profile.flows, ...extra] },
        })
      if (response.status === 200) version = response.body.profile.version
      return response
    }
    const room = async () =>
      (await post(agent, '/api/assess', { amountCents: 0 })).body.maxAffordableCents as number
    const before = await room()
    const payment = {
      id: 'sofa-2',
      name: 'Sofa · Pay in 4',
      amountCents: 2500,
      nextDate: addDays(TODAY, 3),
      cadence: 'once' as const,
      kind: 'installment' as const,
      category: 'Instalment plans',
      confirmed: true,
      active: true,
      planId: 'sofa',
    }
    const saved = await save([payment])
    expect(saved.status).toBe(200)
    expect(saved.body.profile.flows.at(-1)).toEqual(payment)
    expect(await room()).toBe(before - 2500)

    const dueToday = {
      id: 'fee-today',
      name: 'Parking permit',
      amountCents: 5000,
      nextDate: TODAY,
      cadence: 'once' as const,
      kind: 'bill' as const,
      category: 'Transport',
      confirmed: true,
      active: true,
    }
    const ahead = await save([{ ...dueToday, paidOn: addDays(TODAY, 1) }])
    expect(ahead.status).toBe(400)
    expect(ahead.body.code).toBe('INVALID_PAID_DATE')
    expect((await save([dueToday])).status).toBe(200)
    expect(await room()).toBe(before - 5000)
    const paid = await save([{ ...dueToday, paidOn: TODAY }])
    expect(paid.status).toBe(200)
    expect(paid.body.profile.flows.at(-1).paidOn).toBe(TODAY)
    expect(await room()).toBe(before)
  })
})
