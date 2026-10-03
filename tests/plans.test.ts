import { describe, expect, it } from 'vitest'
import { addDays, assessPurchase, getUpcomingFlows } from '../shared/finance.ts'
import type { FinancialProfile, ScheduledFlow } from '../shared/types.ts'

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
