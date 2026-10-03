import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../server/app.ts'
import { Store } from '../server/store.ts'
import type { StoredPurchase } from '../server/store.ts'
import { PayPalError } from '../server/paypal.ts'
import type { PayPalGateway, PayPalOrder, PayPalRefund } from '../server/paypal.ts'
import { addDays, payIn4Schedule } from '../shared/finance.ts'
import type { AppState, Comparison, Purchase } from '../shared/types.ts'

const TODAY = '2026-10-03'
const stores: Store[] = []
const clock = { value: new Date(`${TODAY}T12:00:00Z`) }
type Agent = ReturnType<typeof request.agent>

function fakePayPal(): PayPalGateway {
  const orders = new Map<string, PayPalOrder>()
  const refunds = new Map<string, PayPalRefund>()
  return {
    create: vi.fn(async (p: StoredPurchase) => {
      const order: PayPalOrder = {
        id: `ORDER${orders.size + 1}`,
        status: 'APPROVED',
        purchase_units: [
          {
            custom_id: p.id,
            reference_id: p.id,
            amount: { currency_code: 'USD', value: (p.amountCents / 100).toFixed(2) },
            payee: { merchant_id: 'MERCHANT1' },
          },
        ],
        links: [
          { rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=fake' },
        ],
      }
      orders.set(order.id, order)
      return structuredClone(order)
    }),
    get: vi.fn(async (id: string) => structuredClone(orders.get(id)!)),
    capture: vi.fn(async (id: string) => {
      const order = orders.get(id)!
      order.status = 'COMPLETED'
      order.purchase_units![0]!.payments = {
        captures: [
          {
            id: `CAPTURE${id}`,
            status: 'COMPLETED',
            amount: order.purchase_units![0]!.amount,
            create_time: clock.value.toISOString(),
          },
        ],
      }
      return structuredClone(order)
    }),
    verify: vi.fn(async () => true),
    getRefund: vi.fn(async (id: string) => {
      const refund = refunds.get(id)
      if (!refund) throw new PayPalError(404, 'RESOURCE_NOT_FOUND')
      return structuredClone(refund)
    }),
    eligibility: vi.fn(async () => ({
      payLater: true,
      productCode: 'PAYLATER',
      countryCode: 'US',
    })),
  }
}
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
function sessionOf(store: Store) {
  return (store.db.prepare('SELECT id FROM sessions').get() as { id: string }).id
}
/** Buys an item in full today, acknowledging any shortfall, and returns the completed purchase. */
async function buy(agent: Agent, productId: string): Promise<Purchase> {
  const created = await post(agent, '/api/checkout/create', {
    productId,
    acknowledgeShortfall: true,
  })
  expect(created.status).toBe(200)
  const captured = await post(agent, `/api/checkout/${created.body.purchase.id}/capture`)
  expect(captured.body.purchase.status).toBe('completed')
  return captured.body.purchase
}
/** Purchase outflows in the zero-price forecast, as [date, cents]. */
async function purchaseOutflows(agent: Agent) {
  const assessed = await post(agent, '/api/assess', { amountCents: 0 })
  return (assessed.body.points as Comparison['buyToday']['points']).flatMap((point) =>
    point.events
      .filter((event) => event.kind === 'purchase')
      .map((event) => [point.date, -event.amountCents]),
  )
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe('POST /api/compare', () => {
  it('compares the persona’s camera using the catalog price', async () => {
    const { agent } = setup()
    const response = await post(agent, '/api/compare', { productId: 'camera' })
    expect(response.status).toBe(200)
    const result = response.body as Comparison
    expect(result).toMatchObject({
      itemName: 'Everyday camera',
      amountCents: 119900,
      today: TODAY,
      window: { start: TODAY, end: addDays(TODAY, 60), days: 60 },
      recommendation: 'wait',
      buyToday: { outcome: 'tight' },
      wait: { date: addDays(TODAY, 20), outcome: 'fits' },
      spendLess: { maxPriceCents: 44001 },
      payIn4: { available: true, outcome: 'tight', stacking: { activePlans: 1 } },
    })
  })

  it('accepts a price alone, gates Pay in 4 on the range, and rejects a client price for a catalog item', async () => {
    const { agent } = setup()
    const small = await post(agent, '/api/compare', { amountCents: 999, itemName: 'Socks' })
    expect(small.body).toMatchObject({
      itemName: 'Socks',
      recommendation: 'buyToday',
      payIn4: { available: false, reason: 'Not available for this amount' },
    })
    expect((await post(agent, '/api/compare', { amountCents: 200001 })).body.payIn4.available).toBe(
      false,
    )
    expect((await post(agent, '/api/compare', { amountCents: 1000 })).body.payIn4.available).toBe(
      true,
    )
    const forged = await post(agent, '/api/compare', { productId: 'camera', amountCents: 100 })
    expect(forged.status).toBe(400)
    expect(forged.body.code).toBe('PRICE_MISMATCH')
    expect((await post(agent, '/api/compare', { productId: 'yacht' })).status).toBe(404)
    for (const body of [{}, { amountCents: -1 }, { amountCents: 1.5 }, { amountCents: 1, x: 1 }])
      expect((await post(agent, '/api/compare', body)).status).toBe(400)
  })

  it('keeps /api/assess on the same fixed window', async () => {
    const { agent } = setup()
    const assessed = await post(agent, '/api/assess', { amountCents: 119900 })
    expect(assessed.body).toMatchObject({
      outcome: 'tight',
      earliestDate: addDays(TODAY, 20),
      horizonEnd: addDays(TODAY, 60),
    })
    expect(assessed.body.points).toHaveLength(61)
  })
})

describe('confirming how a purchase is repaid', () => {
  it('counts a PayPal purchase in full with a persistent prompt until the plan is confirmed', async () => {
    const { agent } = setup(fakePayPal())
    const camera = await buy(agent, 'camera')
    const before = await state(agent)
    expect(before.reviews).toEqual([
      expect.objectContaining({
        kind: 'confirmPlan',
        purchaseId: camera.id,
        title: 'Confirm your plan',
      }),
    ])
    expect(await purchaseOutflows(agent)).toEqual([[TODAY, 119900]])

    const instalments = [
      { date: TODAY, amountCents: 29975 },
      { date: addDays(TODAY, 16), amountCents: 29975 },
      { date: addDays(TODAY, 32), amountCents: 29975 },
      { date: addDays(TODAY, 48), amountCents: 29975 },
    ]
    const confirmed = await post(agent, `/api/purchases/${camera.id}/plan`, {
      product: 'payIn4',
      instalments,
    })
    expect(confirmed.status).toBe(200)
    expect(confirmed.body.reviews).toEqual([])
    expect(confirmed.body.profile.version).toBe(before.profile.version + 1)
    expect(confirmed.body.purchases[0].paymentPlan).toMatchObject({
      product: 'payIn4',
      status: 'confirmed',
      instalments,
    })
    // The confirmed payments replace the debit; the purchase is never counted twice.
    expect(await purchaseOutflows(agent)).toEqual(
      instalments.map((item) => [item.date, item.amountCents]),
    )
    const compared = (await post(agent, '/api/compare', { productId: 'headphones' })).body
    expect(compared.payIn4.stacking.activePlans).toBe(2)

    // A day later, before Maya refreshes her funds, the whole price still counts.
    clock.value = new Date(`${addDays(TODAY, 1)}T05:00:00Z`)
    const nextDay = await purchaseOutflows(agent)
    expect(nextDay.reduce((total, [, cents]) => total + (cents as number), 0)).toBe(119900)
    expect(nextDay[0]).toEqual([addDays(TODAY, 1), 29975])
    expect((await post(agent, '/api/assess', { amountCents: 0 })).body.outcome).toBe('tight')
    clock.value = new Date(`${TODAY}T12:00:00Z`)

    // Correcting the product back to a full payment restores the single debit.
    const full = await post(agent, `/api/purchases/${camera.id}/plan`, { product: 'full' })
    expect(full.body.purchases[0].paymentPlan).toMatchObject({ product: 'full' })
    expect(await purchaseOutflows(agent)).toEqual([[TODAY, 119900]])
  })

  it('validates the amounts, the number and order of dates, and the purchase date', async () => {
    const { agent } = setup(fakePayPal())
    const camera = await buy(agent, 'camera')
    const schedule = payIn4Schedule(119900, TODAY)
    const attempt = async (body: object) =>
      (await post(agent, `/api/purchases/${camera.id}/plan`, body)).body.code
    expect(
      await attempt({
        product: 'payIn4',
        instalments: schedule.map((item, index) => ({
          ...item,
          amountCents: item.amountCents - Number(index === 0),
        })),
      }),
    ).toBe('PLAN_TOTAL_MISMATCH')
    expect(
      await attempt({
        product: 'payIn4',
        instalments: [...schedule, { date: addDays(TODAY, 56), amountCents: 1 }],
      }),
    ).toBe('INVALID_INPUT')
    expect(await attempt({ product: 'payIn4', instalments: [] })).toBe('INVALID_INPUT')
    expect(
      await attempt({
        product: 'payIn4',
        instalments: [schedule[1], schedule[0], ...schedule.slice(2)],
      }),
    ).toBe('INVALID_PLAN')
    expect(
      await attempt({
        product: 'payIn4',
        instalments: [{ ...schedule[0]!, date: addDays(TODAY, -1) }, ...schedule.slice(1)],
      }),
    ).toBe('INVALID_PLAN')
    expect(await attempt({ product: 'monthly' })).toBe('INVALID_INPUT')
    expect((await state(agent)).reviews).toHaveLength(1)
  })

  it('accepts plans only for completed purchases in the current plan, outside an active checkout', async () => {
    const { app, agent } = setup(fakePayPal())
    const camera = await buy(agent, 'camera')
    const other = request.agent(app)
    await state(other)
    expect(
      (await post(other, `/api/purchases/${camera.id}/plan`, { product: 'full' })).status,
    ).toBe(404)
    const open = await post(agent, '/api/checkout/create', {
      productId: 'headphones',
      acknowledgeShortfall: true,
    })
    expect(
      (await post(agent, `/api/purchases/${camera.id}/plan`, { product: 'full' })).body.code,
    ).toBe('CHECKOUT_ACTIVE')
    await post(agent, `/api/checkout/${open.body.purchase.id}/cancel`)
    const cancelled = await post(agent, `/api/purchases/${open.body.purchase.id}/plan`, {
      product: 'full',
    })
    expect(cancelled.body.code).toBe('PURCHASE_NOT_COMPLETED')
  })
})

describe('refund review', () => {
  async function plannedCamera() {
    const { app, store, agent } = setup(fakePayPal())
    const camera = await buy(agent, 'camera')
    await post(agent, `/api/purchases/${camera.id}/plan`, {
      product: 'payIn4',
      instalments: payIn4Schedule(119900, TODAY),
    })
    const recordRefund = app.locals.recordRefund as (
      sessionId: string,
      purchaseId: string,
      refundId: string,
      amountCents: number,
    ) => Purchase
    return {
      agent,
      camera,
      record: (refundId: string, cents: number) =>
        recordRefund(sessionOf(store), camera.id, refundId, cents),
    }
  }

  it('records a refund once for review and leaves spending room unchanged', async () => {
    const { agent, camera, record } = await plannedCamera()
    const room = async () =>
      (await post(agent, '/api/compare', { amountCents: 0 })).body.spendLess.maxPriceCents
    const before = await room()
    const version = (await state(agent)).profile.version
    record('REFUND-1', 34900)
    record('REFUND-1', 34900)
    const current = await state(agent)
    expect(current.purchases[0]!.refunds).toHaveLength(1)
    expect(current.profile.version).toBe(version)
    expect(current.reviews).toEqual([
      expect.objectContaining({
        kind: 'refund',
        purchaseId: camera.id,
        refundId: 'REFUND-1',
        refundedCents: 34900,
      }),
    ])
    expect(current.reviews[0]!.message).toContain(
      'may shorten the plan or reduce the final payment',
    )
    expect(current.reviews[0]!.message).toContain('Store credit does not reduce the loan')
    expect(await room()).toBe(before)
    expect(() => record('REFUND-2', 119900)).toThrow()
    expect(() => record('', 100)).toThrow()
  })

  it('applies the remaining payments the user confirms after a partial refund', async () => {
    const { agent, camera, record } = await plannedCamera()
    record('REFUND-1', 34900)
    const path = `/api/purchases/${camera.id}/refunds/REFUND-1/confirm`
    expect((await post(agent, path, { returnedCents: 0 })).body.code).toBe(
      'REMAINING_PAYMENTS_REQUIRED',
    )
    expect(
      (await post(agent, path, { returnedCents: 34901, remainingInstalments: [] })).body.code,
    ).toBe('INVALID_REFUND')
    expect(
      (await post(agent, `/api/purchases/${camera.id}/refunds/OTHER/confirm`, { returnedCents: 0 }))
        .status,
    ).toBe(404)
    const remaining = [
      { date: TODAY, amountCents: 29975 },
      { date: addDays(TODAY, 14), amountCents: 29975 },
      { date: addDays(TODAY, 28), amountCents: 25075 },
    ]
    const confirmed = await post(agent, path, { returnedCents: 0, remainingInstalments: remaining })
    expect(confirmed.status).toBe(200)
    expect(confirmed.body.reviews).toEqual([])
    expect(await purchaseOutflows(agent)).toEqual(
      remaining.map((item) => [item.date, item.amountCents]),
    )
    expect(
      (await post(agent, path, { returnedCents: 0, remainingInstalments: remaining })).body.code,
    ).toBe('REFUND_ALREADY_CONFIRMED')
    // The confirmed refund fixed the remaining payments; the plan can no longer be replaced.
    expect(
      (await post(agent, `/api/purchases/${camera.id}/plan`, { product: 'full' })).body.code,
    ).toBe('REFUND_CONFIRMED')
  })

  it('uses entered remaining payments exactly, even when money also came back', async () => {
    const { agent, camera, record } = await plannedCamera()
    record('REFUND-1', 34900)
    const remaining = [
      { date: addDays(TODAY, 14), amountCents: 29975 },
      { date: addDays(TODAY, 28), amountCents: 29975 },
      { date: addDays(TODAY, 42), amountCents: 20000 },
    ]
    // Today's payment was made: $299.75 + $149 returned + $99.75 off the last payment = $349.
    const confirmed = await post(agent, `/api/purchases/${camera.id}/refunds/REFUND-1/confirm`, {
      returnedCents: 14900,
      remainingInstalments: remaining,
    })
    expect(confirmed.status).toBe(200)
    expect(await purchaseOutflows(agent)).toEqual(
      remaining.map((item) => [item.date, item.amountCents]),
    )
  })

  it('refuses a refund that would cancel more than the merchant refunded', async () => {
    const { agent, camera, record } = await plannedCamera()
    record('REFUND-1', 100)
    const path = `/api/purchases/${camera.id}/refunds/REFUND-1/confirm`
    const wiped = await post(agent, path, { returnedCents: 0, remainingInstalments: [] })
    expect(wiped.status).toBe(400)
    expect(wiped.body.code).toBe('INVALID_REFUND')
    const schedule = payIn4Schedule(119900, TODAY)
    const lastPayment = { ...schedule[3]!, amountCents: schedule[3]!.amountCents - 100 }
    const overReturned = await post(agent, path, {
      returnedCents: 1,
      remainingInstalments: [...schedule.slice(1, 3), lastPayment],
    })
    expect(overReturned.status).toBe(400)
    const exact = await post(agent, path, {
      returnedCents: 0,
      remainingInstalments: [...schedule.slice(1, 3), lastPayment],
    })
    expect(exact.status).toBe(200)
  })

  it('lets a full payment clear the plan prompt after a refund is confirmed', async () => {
    const { app, store, agent } = setup(fakePayPal())
    const camera = await buy(agent, 'camera')
    ;(app.locals.recordRefund as (...args: unknown[]) => Purchase)(
      sessionOf(store),
      camera.id,
      'REFUND-1',
      10000,
    )
    await post(agent, `/api/purchases/${camera.id}/refunds/REFUND-1/confirm`, { returnedCents: 0 })
    const full = await post(agent, `/api/purchases/${camera.id}/plan`, { product: 'full' })
    expect(full.status).toBe(200)
    expect(full.body.reviews).toEqual([])
    const payIn4 = await post(agent, `/api/purchases/${camera.id}/plan`, {
      product: 'payIn4',
      instalments: payIn4Schedule(119900, TODAY),
    })
    expect(payIn4.body.code).toBe('REFUND_CONFIRMED')
  })

  it('leaves the payments due after a store-credit refund', async () => {
    const { agent, camera, record } = await plannedCamera()
    record('REFUND-1', 119900)
    const schedule = payIn4Schedule(119900, TODAY)
    await post(agent, `/api/purchases/${camera.id}/refunds/REFUND-1/confirm`, {
      returnedCents: 0,
      remainingInstalments: schedule,
    })
    expect(await purchaseOutflows(agent)).toEqual(
      schedule.map((item) => [item.date, item.amountCents]),
    )
  })

  it('reduces a full-price debit only by money that actually came back', async () => {
    const { app, store, agent } = setup(fakePayPal())
    const headphones = await buy(agent, 'headphones')
    await post(agent, `/api/purchases/${headphones.id}/plan`, { product: 'full' })
    ;(app.locals.recordRefund as (...args: unknown[]) => Purchase)(
      sessionOf(store),
      headphones.id,
      'REFUND-1',
      34900,
    )
    const path = `/api/purchases/${headphones.id}/refunds/REFUND-1/confirm`
    expect(
      (await post(agent, path, { returnedCents: 0, remainingInstalments: [] })).body.code,
    ).toBe('INVALID_REFUND')
    await post(agent, path, { returnedCents: 20000 })
    expect(await purchaseOutflows(agent)).toEqual([[TODAY, 14900]])
  })
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
