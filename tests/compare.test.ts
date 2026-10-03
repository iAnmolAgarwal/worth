import { describe, expect, it } from 'vitest'
import {
  addDays,
  compareOptions,
  daysBetween,
  getUpcomingFlows,
  PAY_IN_4_MAX_CENTS,
  PAY_IN_4_MIN_CENTS,
  PAY_IN_4_NOTICE,
  payIn4Schedule,
} from '../shared/finance.ts'
import { createDemoState, PRODUCTS, rebaseDemoState } from '../shared/seed.ts'
import type {
  Comparison,
  FinancialProfile,
  PayIn4Scenario,
  Purchase,
  ScheduledFlow,
} from '../shared/types.ts'

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
const compare = (
  p: FinancialProfile,
  amountCents: number,
  purchases: Purchase[] = [],
  payIn4Eligible = true,
  today = TODAY,
) => compareOptions(p, purchases, { amountCents, itemName: 'Camera', today, payIn4Eligible })
const payIn4 = (result: Comparison): PayIn4Scenario => {
  if (!result.payIn4.available) throw new Error(result.payIn4.reason)
  return result.payIn4
}
describe('Pay in 4 schedule (acceptance 14)', () => {
  it('splits into whole cents on days 0, 14, 28 and 42 with any remainder first', () => {
    expect(payIn4Schedule(119900, TODAY)).toEqual([
      { date: TODAY, amountCents: 29975 },
      { date: addDays(TODAY, 14), amountCents: 29975 },
      { date: addDays(TODAY, 28), amountCents: 29975 },
      { date: addDays(TODAY, 42), amountCents: 29975 },
    ])
    expect(payIn4Schedule(1003, TODAY).map((item) => item.amountCents)).toEqual([
      253, 250, 250, 250,
    ])
  })

  it('is available only from $10.00 to $2,000.00 and only when PayPal reports eligibility', () => {
    expect(PAY_IN_4_MIN_CENTS).toBe(1000)
    expect(PAY_IN_4_MAX_CENTS).toBe(200000)
    for (const amount of [999, 200001])
      expect(compare(profile(), amount).payIn4).toEqual({
        available: false,
        reason: 'Not available for this amount',
      })
    for (const amount of [1000, 200000])
      expect(compare(profile(), amount).payIn4.available).toBe(true)
    expect(compare(profile(), 119900, [], false).payIn4).toEqual({
      available: false,
      reason: 'Not available for this amount',
    })
  })
})

describe('comparison over one fixed window (acceptance 15)', () => {
  it('fixes the window before searching and judges every option over it', () => {
    const result = compare(profile(), 119900)
    expect(result.window).toEqual({ start: TODAY, end: addDays(TODAY, 60), days: 60 })
    const options = [result.buyToday, result.spendLess, payIn4(result)]
    for (const option of options) {
      expect(option.points).toHaveLength(61)
      expect(option.points.at(-1)!.date).toBe(result.window.end)
    }
  })

  it('does not call a purchase a fit when a bill later in the window breaks the cushion', () => {
    const p = profile({
      flows: [flow({ cadence: 'yearly', nextDate: addDays(TODAY, 31), amountCents: 120000 })],
    })
    const result = compare(p, 60000)
    expect(result.buyToday).toMatchObject({
      outcome: 'tight',
      lowestBalanceCents: 20000,
      lowestDate: addDays(TODAY, 31),
      lowPointCause: { name: 'Bill', amountCents: 120000, date: addDays(TODAY, 31) },
    })
    expect(result.wait).toEqual({ date: null })
    expect(result.spendLess.maxPriceCents).toBe(30000)
    expect(result.recommendation).toBe('spendLess')
  })

  it('finds the earliest wait date that keeps the cushion through the same window end', () => {
    const p = profile({
      balanceCents: 115000,
      flows: [
        flow({ id: 'pay', kind: 'income', amountCents: 100000, nextDate: addDays(TODAY, 5) }),
      ],
    })
    const result = compare(p, 90000)
    expect(result.buyToday.outcome).toBe('tight')
    // Same-day income arrives after outflows, so payday itself is still short.
    expect(result.wait).toMatchObject({ date: addDays(TODAY, 6), outcome: 'fits' })
    if (!result.wait.date) throw new Error('Expected a wait date')
    expect(result.wait.points).toHaveLength(61)
    expect(result.wait.purchaseDate).toBe(addDays(TODAY, 6))
    expect(result.recommendation).toBe('wait')
  })

  it('reports the highest price that keeps the cushion today, exactly at the boundary', () => {
    const p = profile({ balanceCents: 115000, flows: [flow({ nextDate: addDays(TODAY, 20) })] })
    const result = compare(p, 90000)
    expect(result.spendLess.maxPriceCents).toBe(45000)
    expect(result.spendLess.outcome).toBe('fits')
    expect(result.spendLess.lowestBalanceCents).toBe(50000)
    expect(compare(p, 45000).buyToday.outcome).toBe('fits')
    expect(compare(p, 45001).buyToday.outcome).toBe('tight')
  })

  it('recommends buying today when it fits, and withholds a recommendation when inputs are missing', () => {
    expect(compare(profile(), 10000).recommendation).toBe('buyToday')
    const missing = compare(profile({ snapshotDate: addDays(TODAY, -1) }), 10000)
    expect(missing.recommendation).toBeNull()
    expect(missing.buyToday.outcome).toBe('incomplete')
    expect(missing.wait).toEqual({ date: null })
    expect(missing.spendLess.maxPriceCents).toBe(0)
    expect(missing.missingFields.join(' ')).toContain('Refresh available funds')
  })

  it('names the bill behind a low point that falls on a payday morning', () => {
    const p = profile({
      balanceCents: 160000,
      dailySpendCents: 1000,
      flows: [
        flow({ id: 'pay', kind: 'income', amountCents: 150000, nextDate: addDays(TODAY, 2) }),
        flow({ id: 'rent', name: 'Rent', amountCents: 150000, nextDate: addDays(TODAY, 10) }),
        flow({ id: 'pay-2', kind: 'income', amountCents: 150000, nextDate: addDays(TODAY, 12) }),
      ],
    })
    const { buyToday } = compare(p, 100000)
    expect(buyToday.lowestDate).toBe(addDays(TODAY, 12))
    expect(buyToday.lowPointCause).toMatchObject({ name: 'Rent', date: addDays(TODAY, 10) })
    // With no bill since the last income, everyday spending is the cause.
    const quiet = compare(profile({ dailySpendCents: 1000 }), 0).buyToday
    expect(quiet.lowPointCause).toMatchObject({ name: 'Everyday spending', kind: 'spending' })
  })
})

describe('Pay in 4 comparison (acceptance 16)', () => {
  const rentNearby = profile({
    balanceCents: 160000,
    cushionCents: 30000,
    flows: [
      flow({ id: 'rent', name: 'Rent', amountCents: 100000, nextDate: addDays(TODAY, 13) }),
      flow({ id: 'phone', name: 'Phone', amountCents: 5000, nextDate: addDays(TODAY, 30) }),
      flow({ id: 'gym', name: 'Gym', amountCents: 3000, nextDate: addDays(TODAY, 26) }),
      flow({ id: 'tv', name: 'TV', amountCents: 1500, nextDate: addDays(TODAY, 30) }),
    ],
  })

  it('places every instalment in the window and pairs it with the nearest bill within 3 days', () => {
    const scenario = payIn4(compare(rentNearby, 119900))
    expect(scenario.notice).toBe(PAY_IN_4_NOTICE)
    expect(scenario.illustrative).toBe(true)
    expect(scenario.instalments.map((item) => [item.number, item.date, item.amountCents])).toEqual([
      [1, TODAY, 29975],
      [2, addDays(TODAY, 14), 29975],
      [3, addDays(TODAY, 28), 29975],
      [4, addDays(TODAY, 42), 29975],
    ])
    expect(scenario.instalments.map((item) => item.nearestBill?.name ?? null)).toEqual([
      null,
      'Rent',
      // Phone and TV are both two days away; the larger bill is named.
      'Phone',
      null,
    ])
    expect(scenario.instalments[1]!.nearestBill!.daysFromInstalment).toBe(-1)
    expect(scenario.instalments[2]!.nearestBill!.daysFromInstalment).toBe(2)
    const outflows = scenario.points.flatMap((point) =>
      point.events.filter((event) => event.id.startsWith('payin4:')).map(() => point.date),
    )
    expect(outflows).toEqual(scenario.instalments.map((item) => item.date))
  })

  it('pairs an instalment with a bill before a subscription renewing nearer to it', () => {
    const p = profile({
      flows: [
        flow({ id: 'rent', name: 'Rent', amountCents: 100000, nextDate: addDays(TODAY, 16) }),
        flow({
          id: 'music',
          name: 'Music',
          kind: 'subscription',
          amountCents: 1199,
          nextDate: addDays(TODAY, 14),
        }),
        flow({
          id: 'video',
          name: 'Video',
          kind: 'subscription',
          amountCents: 1549,
          nextDate: addDays(TODAY, 29),
        }),
      ],
    })
    const [, second, third] = payIn4(compare(p, 119900)).instalments
    expect(second!.nearestBill).toMatchObject({ name: 'Rent', daysFromInstalment: 2 })
    // With no bill nearby, a subscription is still named.
    expect(third!.nearestBill).toMatchObject({ name: 'Video', daysFromInstalment: 1 })
  })

  it('does not blame the instalments for a dip the plan already has without the purchase', () => {
    const short = payIn4(compare(profile({ balanceCents: 40000 }), 1000))
    expect(short.outcome).toBe('tight')
    expect(short.label).toBe(
      'Your plan dips below your cushion on Oct 3 even without this purchase',
    )
    // A later dip that only the instalments cause is still attributed to them.
    const later = profile({
      balanceCents: 80000,
      flows: [flow({ id: 'pay', kind: 'income', amountCents: 5000, nextDate: addDays(TODAY, 1) })],
    })
    expect(payIn4(compare(later, 119900)).label).toBe(
      'An instalment would dip below your cushion on Oct 17',
    )
  })

  it('labels a scenario that stays above the cushion and one that dips, with the dip date', () => {
    const above = payIn4(compare(profile({ balanceCents: 500000 }), 119900))
    expect(above.outcome).toBe('fits')
    expect(above.label).toBe('Instalment scenario stays above your cushion')
    expect(above.instalments.every((item) => !item.belowCushion)).toBe(true)
    const dips = payIn4(compare(rentNearby, 119900))
    expect(dips.outcome).toBe('tight')
    expect(dips.label).toBe('An instalment would dip below your cushion on Oct 17')
    // The payment the day after rent is the first to leave the balance under the cushion.
    expect(dips.instalments.map((item) => item.belowCushion)).toEqual([false, true, true, true])
  })

  it('is never recommended or ranked, even when it is the only option that stays above the cushion', () => {
    const p = profile({
      balanceCents: 70000,
      cushionCents: 0,
      flows: [
        flow({ id: 'pay-1', kind: 'income', amountCents: 30000, nextDate: addDays(TODAY, 20) }),
        flow({ id: 'pay-2', kind: 'income', amountCents: 30000, nextDate: addDays(TODAY, 34) }),
      ],
    })
    const result = compare(p, 119900)
    expect(result.buyToday.outcome).toBe('tight')
    expect(result.wait).toEqual({ date: null })
    expect(payIn4(result).outcome).toBe('fits')
    expect(result.recommendation).toBe('spendLess')
    const text = JSON.stringify(result)
    expect(text).not.toMatch(/afford it with Pay in 4/i)
    expect(text).not.toMatch(/approved/i)
  })
})

describe('existing instalment plans (acceptance 17)', () => {
  const existing = (planId = 'laptop') =>
    [12, 26, 40].map((days, index) =>
      flow({
        id: `${planId}-${index + 2}`,
        name: `${planId} · Pay in 4`,
        kind: 'installment',
        planId,
        amountCents: 16000,
        nextDate: addDays(TODAY, days),
      }),
    )

  it('counts plan payments like bills and warns about stacking with a combined calendar', () => {
    const p = profile({ balanceCents: 400000, flows: existing() })
    const scenario = payIn4(compare(p, 119900))
    expect(scenario.stacking).toMatchObject({ activePlans: 1, totalCents: 48000 })
    expect(scenario.stacking!.message).toBe(
      'You already have 1 instalment plan with $480 due in this window. A new plan would add 4 more payments on top.',
    )
    expect(
      scenario.stacking!.calendar.map((item) => [daysBetween(TODAY, item.date), item.proposed]),
    ).toEqual([
      [0, true],
      [12, false],
      [14, true],
      [26, false],
      [28, true],
      [40, false],
      [42, true],
    ])
    // Every instalment, old and new, enters the forecast exactly once.
    const outflows = scenario.points.flatMap((point) =>
      point.events.filter((event) => event.amountCents < 0).map((event) => event.amountCents),
    )
    expect(outflows).toHaveLength(7)
    expect(-outflows.reduce((total, cents) => total + cents, 0)).toBe(119900 + 48000)
    expect(scenario.instalments[2]!.nearestBill).toMatchObject({
      name: 'laptop · Pay in 4',
      daysFromInstalment: -2,
    })
  })

  it('counts each plan once and includes confirmed purchase plans', () => {
    const plan = purchase({
      paymentPlan: {
        product: 'payIn4',
        status: 'confirmed',
        confirmedAt: `${TODAY}T11:00:00Z`,
        instalments: payIn4Schedule(40000, addDays(TODAY, -14)),
      },
    })
    const p = profile({ balanceCents: 400000, flows: [...existing('a'), ...existing('b')] })
    const stacking = payIn4(compare(p, 119900, [plan])).stacking!
    expect(stacking.activePlans).toBe(3)
    // The funds don't include the purchase yet, so its earlier payment still counts today.
    expect(stacking.totalCents).toBe(96000 + 40000)
  })

  it('shows no stacking warning without active plans', () => {
    expect(payIn4(compare(profile(), 119900)).stacking).toBeNull()
    const inactive = existing().map((item) => ({ ...item, active: false }))
    expect(payIn4(compare(profile({ flows: inactive }), 119900)).stacking).toBeNull()
  })
})

describe('synthetic persona: Maya at Larkspur Supply', () => {
  const camera = PRODUCTS.find((item) => item.id === 'camera')!
  const headphones = PRODUCTS.find((item) => item.id === 'headphones')!

  it('sells generic items from a separately branded store', () => {
    expect(new Set(PRODUCTS.map((item) => item.merchant))).toEqual(new Set(['Larkspur Supply']))
    expect(PRODUCTS.map((item) => [item.id, item.priceCents])).toEqual([
      ['headphones', 34900],
      ['camera', 119900],
      ['chair', 44900],
      ['backpack', 12900],
    ])
  })

  it('produces the demo story from the engine', () => {
    const demo = createDemoState(TODAY)
    expect(demo.profile.name).toBe('Maya')
    const result = compareOptions(demo.profile, demo.purchases, {
      amountCents: camera.priceCents,
      itemName: camera.name,
      today: TODAY,
      payIn4Eligible: true,
    })
    expect(result.buyToday).toMatchObject({
      outcome: 'tight',
      lowestBalanceCents: -45899,
      lowestDate: addDays(TODAY, 19),
      lowPointCause: { name: 'Apartment rent', date: addDays(TODAY, 13) },
    })
    expect(result.wait).toMatchObject({ date: addDays(TODAY, 20), outcome: 'fits' })
    expect(result.spendLess).toMatchObject({ maxPriceCents: 44001, outcome: 'fits' })
    expect(result.recommendation).toBe('wait')
    const scenario = payIn4(result)
    expect(scenario.outcome).toBe('tight')
    expect(scenario.label).toBe('An instalment would dip below your cushion on Oct 21')
    expect(
      scenario.instalments.map((item) => [
        item.date,
        item.amountCents,
        item.nearestBill?.name ?? null,
        item.belowCushion,
      ]),
    ).toEqual([
      ['2026-10-03', 29975, 'Car insurance', false],
      ['2026-10-17', 29975, 'Apartment rent', true],
      ['2026-10-31', 29975, 'Laptop · Pay in 4', false],
      ['2026-11-14', 29975, 'Apartment rent', false],
    ])
    expect(scenario.stacking).toMatchObject({ activePlans: 1, totalCents: 48000 })
    expect(
      compareOptions(demo.profile, demo.purchases, {
        amountCents: headphones.priceCents,
        today: TODAY,
      }).buyToday.outcome,
    ).toBe('fits')
  })

  it('keeps the story on every start date of a year once rolled forward', () => {
    const demo = createDemoState(TODAY)
    for (let day = 0; day < 366; day += 5) {
      const today = addDays(TODAY, day)
      const moved = rebaseDemoState(demo, today, demo.profile.timezone) ?? demo
      const result = compareOptions(moved.profile, [], {
        amountCents: camera.priceCents,
        today,
        payIn4Eligible: true,
      })
      const scenario = payIn4(result)
      const rentDates = getUpcomingFlows(moved.profile, today, 60)
        .filter(({ flow: item }) => item.id === 'rent')
        .map((item) => item.date)
      const summary = {
        today,
        buyToday: result.buyToday.outcome,
        waitWithin30: result.wait.date !== null && result.wait.date <= addDays(today, 30),
        spendLess: result.spendLess.maxPriceCents > 0,
        payIn4: scenario.outcome,
        nearRent: scenario.instalments.some((item) =>
          rentDates.some((date) => Math.abs(daysBetween(item.date, date)) <= 3),
        ),
        headphones: compareOptions(moved.profile, [], {
          amountCents: headphones.priceCents,
          today,
        }).buyToday.outcome,
        missing: result.missingFields,
      }
      expect(summary).toEqual({
        today,
        buyToday: 'tight',
        waitWithin30: true,
        spendLess: true,
        payIn4: 'tight',
        nearRent: true,
        headphones: 'fits',
        missing: [],
      })
    }
  })
})
