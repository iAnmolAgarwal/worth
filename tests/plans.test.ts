import { describe, expect, it } from 'vitest'
import { addDays, assessPurchase, forecast, getUpcomingFlows } from '../shared/finance.ts'
import type { FinancialProfile, Purchase, ScheduledFlow } from '../shared/types.ts'

const TODAY = '2026-10-03'
function profile(overrides: Partial<FinancialProfile> = {}): FinancialProfile {
  return {
    name: 'Test',
    balanceCents: 200000,
    cushionCents: 50000,
    dailySpendCents: 0,
    currency: 'USD',
    timezone: 'America/New_York',
    snapshotDate: TODAY,
    confirmedAt: `${TODAY}T12:00:00Z`,
    version: 1,
    confirmed: true,
    coverageDays: 90,
    source: 'import',
    missingFields: [],
    flows: [],
    reflectedPurchaseIds: [],
    aiConsent: false,
    ...overrides,
  }
}
function flow(overrides: Partial<ScheduledFlow> = {}): ScheduledFlow {
  return {
    id: 'bill',
    name: 'Bill',
    amountCents: 20000,
    nextDate: TODAY,
    cadence: 'once',
    kind: 'bill',
    category: 'Home',
    confirmed: true,
    active: true,
    ...overrides,
  }
}
function purchase(overrides: Partial<Purchase> = {}): Purchase {
  return {
    id: 'purchase-1',
    productId: 'camera',
    name: 'Camera',
    amountCents: 119900,
    currency: 'USD',
    mode: 'sandbox',
    status: 'completed',
    createdAt: `${TODAY}T10:00:00Z`,
    completedAt: `${TODAY}T10:01:00Z`,
    profileVersion: 1,
    assessmentDate: TODAY,
    ...overrides,
  }
}
/** Four payments of $299.75 two weeks apart, as PayPal might schedule a $1,199 purchase. */
const fourPayments = (start = TODAY) =>
  [0, 14, 28, 42].map((days) => ({ date: addDays(start, days), amountCents: 29975 }))
/** Purchase outflows in a 60-day forecast, as [date, cents]. */
const purchaseEvents = (p: FinancialProfile, purchases: Purchase[]) =>
  forecast(p, purchases, { today: TODAY, days: 60 }).flatMap((point) =>
    point.events
      .filter((event) => event.kind === 'purchase')
      .map((event) => [point.date, -event.amountCents]),
  )

describe('already paid today (C-21)', () => {
  it('skips an occurrence the user marked paid on or before the funds snapshot', () => {
    const rent = flow({ id: 'rent', cadence: 'monthly', amountCents: 150000 })
    const paid = profile({ flows: [{ ...rent, paidOn: TODAY }] })
    expect(getUpcomingFlows(paid, TODAY, 60).map((item) => item.date)).toEqual([addDays(TODAY, 31)])
    const result = assessPurchase(paid, [], { amountCents: 0, today: TODAY })
    expect(result.maxAffordableCents).toBe(0)
    expect(result.lowestDate).toBe(addDays(TODAY, 31))
    // A mark later than the snapshot is not reflected in it, so the bill still counts today.
    const ahead = profile({ flows: [{ ...rent, paidOn: TODAY }], snapshotDate: addDays(TODAY, -1) })
    expect(getUpcomingFlows(ahead, TODAY, 0)).toHaveLength(1)
  })

  it('treats a one-time item marked paid as already happened on later days', () => {
    const fee = flow({ id: 'fee', nextDate: TODAY, paidOn: TODAY })
    const tomorrow = addDays(TODAY, 1)
    const next = profile({ flows: [fee], snapshotDate: tomorrow })
    const missing = (p: FinancialProfile) =>
      assessPurchase(p, [], { amountCents: 0, today: tomorrow }).missingFields
    expect(missing(next)).toEqual([])
    const unpaid = profile({ flows: [{ ...fee, paidOn: undefined }], snapshotDate: tomorrow })
    expect(missing(unpaid)).toEqual(['Confirm whether Bill has already happened.'])
  })

  it('counts instalment plan payments like bills, once each', () => {
    const plan = [12, 26].map((days, index) =>
      flow({
        id: `laptop-${index}`,
        name: 'Laptop · Pay in 4',
        kind: 'installment',
        planId: 'laptop',
        amountCents: 16000,
        nextDate: addDays(TODAY, days),
      }),
    )
    const result = assessPurchase(profile({ flows: plan }), [], { amountCents: 0, today: TODAY })
    expect(
      result.points.flatMap((point) =>
        point.events.map((event) => [point.date, event.kind, event.amountCents]),
      ),
    ).toEqual([
      [addDays(TODAY, 12), 'installment', -16000],
      [addDays(TODAY, 26), 'installment', -16000],
    ])
    expect(result.maxAffordableCents).toBe(200000 - 32000 - 50000)
  })
})

describe('purchase cash effect (acceptance 28)', () => {
  const confirmed = (instalments = fourPayments()): Purchase['paymentPlan'] => ({
    product: 'payIn4',
    status: 'confirmed',
    instalments,
    confirmedAt: `${TODAY}T11:00:00Z`,
  })

  it('reserves the full price during checkout whatever plan is attached', () => {
    for (const status of ['created', 'pending', 'unknown'] as const)
      expect(
        purchaseEvents(profile(), [
          purchase({ status, completedAt: undefined, paymentPlan: confirmed() }),
        ]),
      ).toEqual([[TODAY, 119900]])
  })

  it('keeps an unconfirmed plan as one full-price debit', () => {
    const unconfirmed = purchase({ paymentPlan: { product: 'payIn4', status: 'unconfirmed' } })
    expect(purchaseEvents(profile(), [unconfirmed])).toEqual([[TODAY, 119900]])
    expect(purchaseEvents(profile(), [purchase()])).toEqual([[TODAY, 119900]])
  })

  it('replaces the debit with the confirmed payments, never both', () => {
    const plan = purchase({ paymentPlan: confirmed() })
    expect(purchaseEvents(profile(), [plan])).toEqual(
      fourPayments().map((item) => [item.date, item.amountCents]),
    )
    // Today's payment is already in a snapshot that reflects the purchase.
    expect(purchaseEvents(profile({ reflectedPurchaseIds: [plan.id] }), [plan])).toEqual(
      fourPayments()
        .slice(1)
        .map((item) => [item.date, item.amountCents]),
    )
  })

  it('treats payments dated before the funds snapshot as already reflected', () => {
    const started = purchase({
      assessmentDate: addDays(TODAY, -16),
      paymentPlan: confirmed([
        { date: addDays(TODAY, -16), amountCents: 29975 },
        { date: TODAY, amountCents: 29975 },
        { date: addDays(TODAY, 16), amountCents: 29975 },
        { date: addDays(TODAY, 32), amountCents: 29975 },
      ]),
    })
    expect(purchaseEvents(profile(), [started])).toEqual([
      [TODAY, 29975],
      [addDays(TODAY, 16), 29975],
      [addDays(TODAY, 32), 29975],
    ])
  })
})

describe('refund review (engine side of acceptance 23)', () => {
  const plan = (refunds: Purchase['refunds']) =>
    purchase({
      paymentPlan: {
        product: 'payIn4',
        status: 'confirmed',
        instalments: fourPayments(),
        confirmedAt: `${TODAY}T11:00:00Z`,
      },
      refunds,
    })
  const refund = { id: 'R1', amountCents: 34900, createdAt: `${TODAY}T12:00:00Z` }

  it('changes spending room by $0 until the user confirms', () => {
    const room = (purchases: Purchase[]) =>
      assessPurchase(profile(), purchases, { amountCents: 0, today: TODAY }).maxAffordableCents
    expect(room([plan([{ ...refund, status: 'review' }])])).toBe(room([plan([])]))
    const full = purchase({ refunds: [{ ...refund, status: 'review' }] })
    expect(purchaseEvents(profile(), [full])).toEqual([[TODAY, 119900]])
  })

  it('applies the remaining payments the user confirms after a partial refund', () => {
    const remaining = [
      { date: addDays(TODAY, 14), amountCents: 29975 },
      { date: addDays(TODAY, 28), amountCents: 25075 },
    ]
    const partial = plan([
      { ...refund, status: 'confirmed', returnedCents: 0, remainingInstalments: remaining },
    ])
    expect(purchaseEvents(profile({ reflectedPurchaseIds: [partial.id] }), [partial])).toEqual(
      remaining.map((item) => [item.date, item.amountCents]),
    )
  })

  it('leaves the payments due after a store-credit refund', () => {
    const credit = plan([
      {
        ...refund,
        status: 'confirmed',
        returnedCents: 0,
        remainingInstalments: fourPayments().slice(1),
      },
    ])
    expect(purchaseEvents(profile({ reflectedPurchaseIds: [credit.id] }), [credit])).toEqual(
      fourPayments()
        .slice(1)
        .map((item) => [item.date, item.amountCents]),
    )
  })

  it('lets money actually returned reduce an unreflected debit but never add funds', () => {
    const returned = (cents: number) =>
      purchase({ refunds: [{ ...refund, status: 'confirmed', returnedCents: cents }] })
    expect(purchaseEvents(profile(), [returned(34900)])).toEqual([[TODAY, 85000]])
    expect(
      purchaseEvents(profile({ reflectedPurchaseIds: ['purchase-1'] }), [returned(34900)]),
    ).toEqual([])
    const point = forecast(
      profile(),
      [
        purchase({
          amountCents: 100,
          refunds: [{ ...refund, amountCents: 100, status: 'confirmed', returnedCents: 100 }],
        }),
      ],
      {
        today: TODAY,
        days: 0,
      },
    )[0]!
    expect(point.baselineCents).toBe(200000)
  })
})
