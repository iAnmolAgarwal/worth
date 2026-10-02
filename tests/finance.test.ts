import { describe, expect, it } from 'vitest'
import {
  addDays,
  assessPurchase,
  forecast,
  getUpcomingFlows,
  todayInTimezone,
} from '../shared/finance.ts'
import { createDemoState, PRODUCTS } from '../shared/seed.ts'
import type { FinancialProfile, Purchase, ScheduledFlow } from '../shared/types.ts'

const TODAY = '2026-10-03'
function profile(overrides: Partial<FinancialProfile> = {}): FinancialProfile {
  return {
    name: 'Test',
    balanceCents: 115000,
    cushionCents: 50000,
    dailySpendCents: 0,
    currency: 'USD',
    timezone: 'America/New_York',
    snapshotDate: TODAY,
    confirmedAt: `${TODAY}T12:00:00Z`,
    version: 1,
    confirmed: true,
    coverageDays: 90,
    source: 'demo',
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
    productId: 'headphones',
    name: 'Headphones',
    amountCents: 60000,
    currency: 'USD',
    mode: 'demo',
    status: 'completed',
    createdAt: `${TODAY}T10:00:00Z`,
    completedAt: `${TODAY}T10:01:00Z`,
    profileVersion: 1,
    assessmentDate: TODAY,
    ...overrides,
  }
}
const assess = (
  p: FinancialProfile,
  amountCents: number,
  extra: { purchaseDate?: string; findEarliest?: boolean } = {},
  purchases: Purchase[] = [],
) => assessPurchase(p, purchases, { amountCents, today: TODAY, ...extra })

describe('deterministic purchase assessment', () => {
  it('uses the minimum path and fits at the exact cushion boundary', () => {
    const tight = assess(profile(), 90000)
    expect(tight.outcome).toBe('tight')
    expect(tight.lowestBalanceCents).toBe(25000)
    expect(tight.maxAffordableCents).toBe(65000)
    expect(tight.headroomCents).toBe(-25000)
    expect(assess(profile(), 65000).outcome).toBe('fits')
  })

  it('does not let future or same-day income hide a preceding shortfall', () => {
    const p = profile({
      balanceCents: 60000,
      flows: [
        flow({ id: 'salary', kind: 'income', amountCents: 400000 }),
        flow({ amountCents: 20000 }),
      ],
    })
    const result = assess(p, 10000)
    expect(result.points[0]!.purchaseCents).toBe(430000)
    expect(result.points[0]!.minimumCents).toBe(30000)
    expect(result.lowestDate).toBe(TODAY)
    expect(result.outcome).toBe('tight')
    expect(result.earliestDate).toBeNull() // Baseline is also short before today's paycheck.
  })

  it('can suggest the day after payday without ignoring the next month of bills', () => {
    const p = profile({
      balanceCents: 115000,
      flows: [
        flow({ id: 'salary', kind: 'income', amountCents: 100000, nextDate: addDays(TODAY, 5) }),
      ],
    })
    const result = assess(p, 90000)
    expect(result.earliestDate).toBe(addDays(TODAY, 6))
    expect(assess(p, 90000, { purchaseDate: addDays(TODAY, 5) }).outcome).toBe('tight')
    expect(assess(p, 90000, { purchaseDate: addDays(TODAY, 6) }).outcome).toBe('fits')
  })

  it('extends a delayed scenario until 30 days after purchase', () => {
    const p = profile({
      balanceCents: 200000,
      flows: [flow({ nextDate: addDays(TODAY, 35), amountCents: 120000 })],
    })
    const now = assess(p, 60000)
    const later = assess(p, 60000, { purchaseDate: addDays(TODAY, 30) })
    expect(now.outcome).toBe('fits')
    expect(later.outcome).toBe('tight')
    expect(later.horizonEnd).toBe(addDays(TODAY, 60))
    expect(later.points).toHaveLength(61)
    expect(later.lowestDate).toBe(addDays(TODAY, 35))
  })

  it('does not suggest waiting when a future bill breaks every candidate window', () => {
    const p = profile({
      balanceCents: 115000,
      flows: [
        flow({ id: 'salary', amountCents: 100000, kind: 'income', nextDate: addDays(TODAY, 20) }),
        flow({ amountCents: 150000, nextDate: addDays(TODAY, 35) }),
      ],
    })
    expect(assess(p, 90000).earliestDate).toBeNull()
  })

  it('does not repeat once-only income in a later horizon', () => {
    const p = profile({
      flows: [flow({ kind: 'income', amountCents: 100000, nextDate: addDays(TODAY, 2) })],
    })
    expect(forecast(p, [], { today: TODAY, days: 60 }).at(-1)!.baselineCents).toBe(215000)
  })

  it('shows a stress shortfall alongside a base-case fit', () => {
    const p = profile({ balanceCents: 100000, dailySpendCents: 1000, cushionCents: 50000 })
    const result = assess(p, 15000)
    expect(result.outcome).toBe('fits')
    expect(result.lowestBalanceCents).toBe(54000)
    expect(result.stressLowestCents).toBe(47800)
    expect(result.explanation).toContain('20% higher')
  })

  it('prioritizes missing confirmation, current funds, and unconfirmed obligations', () => {
    const result = assess(
      profile({
        confirmed: false,
        snapshotDate: addDays(TODAY, -1),
        flows: [flow({ confirmed: false })],
        missingFields: ['Confirm outside-PayPal debts.'],
      }),
      100,
    )
    expect(result.outcome).toBe('incomplete')
    expect(result.earliestDate).toBeNull()
    expect(result.missingFields.join(' ')).toContain('Refresh available funds')
    expect(result.missingFields.join(' ')).toContain('Confirm Bill')
    expect(result.missingFields).toContain('Confirm outside-PayPal debts.')
  })

  it('requires review of overdue once-only commitments', () => {
    const result = assess(profile({ flows: [flow({ nextDate: addDays(TODAY, -1) })] }), 100)
    expect(result.outcome).toBe('incomplete')
  })

  it('rejects fractional cents, negative amounts, invalid dates, and dates outside the search window', () => {
    for (const amount of [-1, 1.5, NaN, Infinity]) expect(() => assess(profile(), amount)).toThrow()
    expect(() => assess(profile(), 100, { purchaseDate: '2026-02-30' })).toThrow()
    expect(() => assess(profile(), 100, { purchaseDate: addDays(TODAY, 31) })).toThrow()
    expect(() => assess(profile(), 100, { purchaseDate: addDays(TODAY, -1) })).toThrow()
  })

  it('supports zero-price baseline assessment for the dashboard', () => {
    const result = assess(profile(), 0)
    expect(result.outcome).toBe('fits')
    expect(result.lowestBalanceCents).toBe(result.baselineLowestCents)
    expect(result.maxAffordableCents).toBe(65000)
    expect(result.points.every((point) => point.baselineCents === point.purchaseCents)).toBe(true)
  })

  it('returns max affordable for the proposed date and preserves earlier baseline shortfalls', () => {
    const p = profile({
      flows: [
        flow({ id: 'salary', kind: 'income', amountCents: 100000, nextDate: addDays(TODAY, 2) }),
      ],
    })
    expect(assess(p, 90000, { purchaseDate: addDays(TODAY, 3) }).maxAffordableCents).toBe(165000)
    const short = { ...p, balanceCents: 40000 }
    expect(assess(short, 100, { purchaseDate: addDays(TODAY, 3) }).maxAffordableCents).toBe(0)
  })
})

describe('snapshot and reservation accounting', () => {
  it('counts a completed purchase once and does not subtract a reflected capture twice', () => {
    expect(
      forecast(profile({ balanceCents: 200000 }), [purchase()], { today: TODAY, days: 0 })[0]!
        .baselineCents,
    ).toBe(140000)
    expect(
      forecast(
        profile({ balanceCents: 140000, reflectedPurchaseIds: ['purchase-1'] }),
        [purchase()],
        { today: TODAY, days: 0 },
      )[0]!.baselineCents,
    ).toBe(140000)
  })

  it.each(['created', 'pending', 'unknown'] as const)(
    'preserves one %s reservation, even if mistakenly marked reflected',
    (status) => {
      const p = profile({ balanceCents: 200000, reflectedPurchaseIds: ['purchase-1'] })
      const point = forecast(p, [purchase({ status, completedAt: undefined })], {
        today: TODAY,
        days: 0,
      })[0]!
      expect(point.baselineCents).toBe(140000)
    },
  )

  it('replaces reservation with capture and guards duplicate identities', () => {
    const records = [
      purchase({ status: 'pending', orderId: 'order-1' }),
      purchase({ status: 'completed', orderId: 'order-1', captureId: 'cap-1' }),
      purchase({ id: 'other-row', orderId: 'order-1', captureId: 'cap-1' }),
    ]
    expect(
      forecast(profile({ balanceCents: 200000 }), records, { today: TODAY, days: 0 })[0]!
        .baselineCents,
    ).toBe(140000)
  })

  it('releases failed and cancelled purchases', () => {
    expect(
      forecast(
        profile({ balanceCents: 200000 }),
        [purchase({ status: 'failed' }), purchase({ id: 'second', status: 'cancelled' })],
        { today: TODAY, days: 0 },
      )[0]!.baselineCents,
    ).toBe(200000)
  })

  it('carries reservations into baseline, purchase, and stress paths', () => {
    const point = forecast(profile({ balanceCents: 200000 }), [purchase({ status: 'pending' })], {
      today: TODAY,
      days: 0,
      amountCents: 10000,
    })[0]!
    expect(point.baselineCents).toBe(140000)
    expect(point.purchaseCents).toBe(130000)
    expect(point.stressCents).toBe(130000)
  })
})

describe('calendar behavior and demo', () => {
  it('keeps month-end and leap-day recurrence anchored', () => {
    const monthly = profile({ flows: [flow({ cadence: 'monthly', nextDate: '2026-01-31' })] })
    expect(getUpcomingFlows(monthly, '2026-01-31', 90).map((item) => item.date)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ])
    const yearly = profile({ flows: [flow({ cadence: 'yearly', nextDate: '2024-02-29' })] })
    expect(getUpcomingFlows(yearly, '2026-01-01', 365).map((item) => item.date)).toEqual([
      '2026-02-28',
    ])
  })

  it('handles DST calendar arithmetic without a local-time date shift', () => {
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09')
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02')
    expect(todayInTimezone('Asia/Kolkata')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('provides reproducible 90-day history and the intended purchase story', () => {
    const demo = createDemoState(TODAY)
    expect(createDemoState(TODAY)).toEqual(demo)
    expect(demo.transactions.at(-1)!.date).toBe(addDays(TODAY, -89))
    expect(demo.transactions[0]!.date).toBe(TODAY)
    expect(demo.transactions.some((item) => item.kind === 'transfer')).toBe(true)
    expect(demo.transactions.some((item) => item.kind === 'refund')).toBe(true)
    expect(
      assess(demo.profile, PRODUCTS.find((item) => item.id === 'headphones')!.priceCents).outcome,
    ).toBe('fits')
    const camera = assess(demo.profile, PRODUCTS.find((item) => item.id === 'camera')!.priceCents)
    expect(camera.outcome).toBe('tight')
    expect(camera.earliestDate).toBe(addDays(TODAY, 13))
  })
})
