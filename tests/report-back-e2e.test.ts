import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../server/app.ts'
import { Store } from '../server/store.ts'
import type { ChatProvider } from '../server/chat.ts'
import type { PayPalGateway, PayPalOrder } from '../server/paypal.ts'
import { createMerchantApp } from '../merchant/app.ts'
import type { AppState, Comparison } from '../shared/types.ts'

// C4 end to end, across both origins: Larkspur signs its capture report with the real shared
// module, and Worth verifies and records it. Only PayPal is fake; the report travels from the
// store's sender straight into Worth's app.

const SECRET = Buffer.alloc(32, 7).toString('base64url')
const STORE = 'https://larkspur.example'
const WORTH = 'https://worth.example'
const clock = { ms: Date.parse('2026-10-03T16:00:00Z') }

/** A sandbox stand-in: one order at a time, captured on request, read back on a webhook. */
function fakePayPal(captureId = 'CAP-E2E-1') {
  const created: Parameters<PayPalGateway['create']>[0][] = []
  const order = (captured: boolean): PayPalOrder => {
    const source = created.at(-1)!
    const value = (source.amountCents / 100).toFixed(2)
    return {
      id: 'ORDER-E2E-1',
      status: captured ? 'COMPLETED' : 'PAYER_ACTION_REQUIRED',
      purchase_units: [
        {
          reference_id: source.id,
          custom_id: source.id,
          amount: { currency_code: 'USD', value },
          payee: { merchant_id: 'LARKSPUR' },
          ...(captured
            ? {
                payments: {
                  captures: [
                    {
                      id: captureId,
                      status: 'COMPLETED',
                      amount: { currency_code: 'USD', value },
                      // PayPal may answer with an offset; the store sends it in UTC.
                      create_time: '2026-10-03T12:00:00-04:00',
                    },
                  ],
                },
              }
            : {}),
        },
      ],
    }
  }
  const gateway = {
    create: vi.fn(async (source: Parameters<PayPalGateway['create']>[0]) => {
      created.push(source)
      return order(false)
    }),
    capture: vi.fn(async () => order(true)),
    get: vi.fn(async () => order(true)),
    getRefund: vi.fn(),
    verify: vi.fn(async () => true),
    eligibility: vi.fn(async () => ({ payLater: true })),
  }
  return { gateway: gateway as unknown as PayPalGateway, created }
}

const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function setup() {
  clock.ms = Date.parse('2026-10-03T16:00:00Z')
  const store = new Store(':memory:')
  stores.push(store)
  const worth = createApp({
    store,
    config: {
      production: false,
      origin: WORTH,
      paypalClientId: undefined,
      paypalSecret: undefined,
      anthropicKey: undefined,
      handoffSecret: SECRET,
      merchantOrigin: STORE,
    },
    paypal: { eligibility: vi.fn() } as unknown as PayPalGateway,
    chat: { reply: vi.fn() } as unknown as ChatProvider,
    now: () => new Date(clock.ms),
  })
  /** The store server's fetch, delivered to Worth's app as the real request it makes. */
  const delivered: { status: number; body: unknown }[] = []
  const bridge = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const target = new URL(String(url))
    expect(target.origin).toBe(WORTH)
    const answer = await request(worth)
      .post(target.pathname)
      .set(init.headers as Record<string, string>)
      .send(String(init.body))
    delivered.push({ status: answer.status, body: answer.body })
    return new Response(JSON.stringify(answer.body), { status: answer.status })
  })
  const paypal = fakePayPal()
  const larkspur = (gateway = paypal.gateway) =>
    createMerchantApp({
      env: {},
      config: {
        origin: STORE,
        worthOrigin: WORTH,
        handoffSecret: Buffer.from(SECRET, 'base64url'),
        paypalClientId: 'public-client-id',
      },
      paypal: gateway,
      now: () => clock.ms,
      report: {
        fetch: bridge as unknown as typeof fetch,
        sleep: async () => {},
        log: () => {},
      },
    })
  return { worth, store, larkspur, paypal, delivered, bridge }
}

type Agent = ReturnType<typeof request.agent>
const json = { 'Content-Type': 'application/json', Origin: STORE }
function worthPost(agent: Agent, path: string, body: object = {}) {
  return agent.post(path).set('X-Worth-Client', 'web').send(body)
}
async function worthState(agent: Agent): Promise<AppState> {
  return (await agent.get('/api/state')).body
}
async function room(agent: Agent) {
  const response = await worthPost(agent, '/api/compare', { amountCents: 0, itemName: 'Room' })
  return (response.body as Comparison).spendLess.maxPriceCents
}

/**
 * The shopper's whole trip: Larkspur's product page → Analyse with Worth → consent → Back to
 * Larkspur Supply with Worth's result. Returns the store-side and Worth-side browsers.
 */
async function analyseAndComeBack(
  store: ReturnType<typeof createMerchantApp>,
  worth: ReturnType<typeof createApp>,
  { consent = true, productId = 'backpack' } = {},
) {
  const shopperAtStore = request.agent(store)
  const shopperAtWorth = request.agent(worth)
  const page = await shopperAtStore.get(`/p/${productId}`).expect(200)
  const link = page.text.match(/href="https:\/\/worth\.example\/check#q=([^"]+)"/)
  expect(link).not.toBeNull()
  const opened = await worthPost(shopperAtWorth, '/api/handoff/open', { token: link![1] })
  expect(opened.status).toBe(200)
  const qid = opened.body.quote.qid as string
  if (consent)
    await worthPost(shopperAtWorth, '/api/handoff/consent', { qid, consent: true }).expect(200)
  const back = await worthPost(shopperAtWorth, '/api/handoff/return', { qid }).expect(200)
  const url = new URL(back.body.url as string)
  expect(url.origin).toBe(STORE)
  expect(url.searchParams.get('worth')).toBeTruthy()
  const returned = await shopperAtStore.get(url.pathname + url.search).expect(200)
  expect(returned.text).toContain('Worth:')
  return { shopperAtStore, shopperAtWorth, qid, amountCents: opened.body.quote.amountCents }
}

describe('report-back across both origins', () => {
  it('Larkspur’s capture lands once in Worth Activity and room to spend drops once', async () => {
    const t = setup()
    const larkspur = t.larkspur()
    const { shopperAtStore, shopperAtWorth, qid, amountCents } = await analyseAndComeBack(
      larkspur,
      t.worth,
    )
    const before = await room(shopperAtWorth)
    await shopperAtStore.post('/api/orders').set(json).send({ productId: 'backpack' }).expect(201)
    const captured = await shopperAtStore
      .post('/api/orders/ORDER-E2E-1/capture')
      .set(json)
      .send({})
      .expect(200)
    // Checkout answers before the report is settled; the report then lands.
    expect(captured.body).toEqual({ status: 'COMPLETED', orderId: 'ORDER-E2E-1' })
    expect(await larkspur.locals.lastReport).toBe('sent')
    expect(t.delivered).toEqual([{ status: 200, body: { recorded: true } }])
    const sent = JSON.parse(String(t.bridge.mock.calls[0]![1]!.body))
    expect(sent).toMatchObject({
      qid,
      captureId: 'CAP-E2E-1',
      capturedAt: '2026-10-03T16:00:00.000Z',
    })

    const after = await worthState(shopperAtWorth)
    const rows = after.transactions.filter((row) => row.source === 'purchase')
    expect(rows).toEqual([
      expect.objectContaining({ name: 'Travel backpack', amountCents: -amountCents }),
    ])
    expect(after.purchases[0]).toMatchObject({
      reportedBy: 'Larkspur Supply',
      amountCents,
      reportNotice: true,
    })
    expect(await room(shopperAtWorth)).toBe(before - amountCents)

    // PayPal's webhook for the same capture sends nothing more from this store.
    await request(larkspur)
      .post('/api/paypal/webhook')
      .set('Content-Type', 'application/json')
      .send(
        JSON.stringify({
          id: 'WH-1',
          event_type: 'PAYMENT.CAPTURE.COMPLETED',
          resource: {
            id: 'CAP-E2E-1',
            supplementary_data: { related_ids: { order_id: 'ORDER-E2E-1' } },
          },
        }),
      )
      .expect(200)
    expect(t.delivered).toHaveLength(1)
  })

  it('records once when one store instance’s capture path and another’s webhook race', async () => {
    const t = setup()
    const first = t.larkspur()
    // A second instance (or a restarted store) has no memory of what the first one sent.
    const second = t.larkspur()
    const { shopperAtStore, shopperAtWorth } = await analyseAndComeBack(first, t.worth)
    await shopperAtStore.post('/api/orders').set(json).send({ productId: 'backpack' }).expect(201)
    const [capture, webhook] = await Promise.all([
      shopperAtStore.post('/api/orders/ORDER-E2E-1/capture').set(json).send({}),
      request(second)
        .post('/api/paypal/webhook')
        .set('Content-Type', 'application/json')
        .send(
          JSON.stringify({
            id: 'WH-RACE',
            event_type: 'PAYMENT.CAPTURE.COMPLETED',
            resource: { supplementary_data: { related_ids: { order_id: 'ORDER-E2E-1' } } },
          }),
        ),
    ])
    expect(capture.status).toBe(200)
    expect(webhook.status).toBe(200)
    await Promise.all([first.locals.lastReport, second.locals.lastReport])
    expect(t.delivered).toEqual([
      { status: 200, body: { recorded: true } },
      { status: 200, body: { recorded: true } },
    ])
    const rows = (await worthState(shopperAtWorth)).transactions.filter(
      (row) => row.source === 'purchase',
    )
    expect(rows).toHaveLength(1)
  })

  it('without consent, the store still completes checkout and Worth records nothing', async () => {
    const t = setup()
    const larkspur = t.larkspur()
    const { shopperAtStore, shopperAtWorth } = await analyseAndComeBack(larkspur, t.worth, {
      consent: false,
    })
    await shopperAtStore.post('/api/orders').set(json).send({ productId: 'backpack' })
    const res = await shopperAtStore.post('/api/orders/ORDER-E2E-1/capture').set(json).send({})
    expect(res.body.status).toBe('COMPLETED')
    expect(await larkspur.locals.lastReport).toBe('sent')
    expect(t.delivered).toEqual([{ status: 200, body: { recorded: false } }])
    expect(
      (await worthState(shopperAtWorth)).transactions.filter((row) => row.source === 'purchase'),
    ).toEqual([])
  })

  it('a store with the wrong key is refused, and its checkout still completes', async () => {
    const t = setup()
    const larkspur = t.larkspur()
    const { shopperAtStore } = await analyseAndComeBack(larkspur, t.worth)
    const impostor = createMerchantApp({
      env: {},
      config: {
        origin: STORE,
        worthOrigin: WORTH,
        handoffSecret: Buffer.alloc(32, 8),
        paypalClientId: 'public-client-id',
      },
      paypal: t.paypal.gateway,
      now: () => clock.ms,
      report: { fetch: t.bridge as unknown as typeof fetch, sleep: async () => {}, log: () => {} },
    })
    await shopperAtStore.post('/api/orders').set(json).send({ productId: 'backpack' })
    // The impostor learns of the order through a webhook and reports it under its own key.
    await request(impostor)
      .post('/api/paypal/webhook')
      .set('Content-Type', 'application/json')
      .send(
        JSON.stringify({
          id: 'WH-X',
          event_type: 'PAYMENT.CAPTURE.COMPLETED',
          resource: { supplementary_data: { related_ids: { order_id: 'ORDER-E2E-1' } } },
        }),
      )
      .expect(200)
    expect(await impostor.locals.lastReport).toBe('rejected')
    expect(t.delivered).toEqual([
      { status: 401, body: { error: 'This report was not accepted.', code: 'OUTCOME_REJECTED' } },
    ])
  })
})
