// Locks the demo story (final-day plan §3): Alex on Fri Nov 13 2026 and the $1,899 Halden X5,
// through the real engine. If any figure here changes, the video and the README are wrong too.
import { describe, expect, it } from 'vitest'
import {
  addDays,
  COMPARISON_WINDOW_DAYS,
  compareOptions,
  forecast,
  WAIT_SEARCH_DAYS,
} from '../shared/finance.ts'
import {
  ALEX_CAMERA_ID,
  ALEX_DEMO_DAY,
  ALEX_RETURN_DAY,
  createCameraScenario,
  PRODUCTS,
} from '../shared/seed.ts'
import { fundsProjection } from '../server/demoClock.ts'
import type { SessionData } from '../server/store.ts'

const camera = PRODUCTS.find((p) => p.id === ALEX_CAMERA_ID)!
const nov13 = createCameraScenario(ALEX_DEMO_DAY)
const compare = (data = nov13, today = ALEX_DEMO_DAY) =>
  compareOptions(data.profile, [], {
    amountCents: camera.priceCents,
    itemName: camera.name,
    today,
    payIn4Eligible: true,
  })

describe('the Halden X5 in the catalog', () => {
  it('is an invented-brand camera at $1,899, first in the store, with Pay in 4 in range', () => {
    expect(camera).toMatchObject({
      name: 'Halden X5',
      subtitle: 'Full-frame mirrorless camera',
      priceCents: 189900,
      merchant: 'Larkspur Supply',
      image: '/images/halden-x5.jpg',
    })
    expect(PRODUCTS[0]!.id).toBe(ALEX_CAMERA_ID)
    // The two real-brand items stay last, out of the video frame.
    expect(PRODUCTS.slice(-2).map((p) => p.id)).toEqual(['macbook-pro-14', 'airpods-4'])
    expect(compare().payIn4.available).toBe(true)
  })
})

describe('Alex on Fri Nov 13 2026', () => {
  it('holds the plan the story is told with', () => {
    const { profile, wishlist, purchases } = nov13
    expect(profile).toMatchObject({
      name: 'Alex',
      balanceCents: 254000,
      cushionCents: 30000,
      dailySpendCents: 4000,
      snapshotDate: ALEX_DEMO_DAY,
      source: 'demo',
      confirmed: true,
      userEdited: false,
    })
    const flows = Object.fromEntries(
      profile.flows.map((f) => [f.id, [f.amountCents, f.nextDate, f.cadence, f.kind]]),
    )
    expect(flows).toEqual({
      salary: [390000, '2026-11-30', 'monthly', 'income'],
      'photo-invoice': [165000, '2026-12-14', 'once', 'income'],
      rent: [175000, '2026-12-01', 'monthly', 'bill'],
      phone: [6500, '2026-11-18', 'monthly', 'bill'],
      internet: [7000, '2026-11-22', 'monthly', 'bill'],
      'car-insurance': [13200, '2026-11-25', 'monthly', 'bill'],
      utilities: [11000, '2026-12-05', 'monthly', 'bill'],
      'student-loan': [28000, '2026-12-10', 'monthly', 'bill'],
      gym: [4000, '2026-11-20', 'monthly', 'subscription'],
      video: [1599, '2026-11-27', 'monthly', 'subscription'],
      music: [1199, '2026-12-09', 'monthly', 'subscription'],
      'laptop-plan-2': [32475, '2026-11-20', 'once', 'installment'],
      'laptop-plan-3': [32475, '2026-12-04', 'once', 'installment'],
      'laptop-plan-4': [32475, '2026-12-18', 'once', 'installment'],
    })
    expect(profile.flows.find((f) => f.id === 'salary')!.anchorDay).toBe('last')
    expect(profile.flows.find((f) => f.id === 'photo-invoice')).toMatchObject({
      name: 'Photo shoot invoice · PayPal',
      origin: 'paypal',
    })
    for (const payment of profile.flows.filter((f) => f.kind === 'installment'))
      expect(payment).toMatchObject({ planId: 'laptop-plan', planTotalCents: 129900 })
    expect(wishlist).toEqual([])
    expect(purchases).toEqual([])
  })

  it('has about 90 days of history that matches the plan, and no brand names', () => {
    const history = nov13.transactions
    expect(
      history.every((t) => t.date < ALEX_DEMO_DAY && t.date >= addDays(ALEX_DEMO_DAY, -90)),
    ).toBe(true)
    const on = (name: string) =>
      history
        .filter((t) => t.name === name)
        .map((t) => [t.date, t.amountCents])
        .sort()
    expect(on('Salary')).toEqual([
      ['2026-08-31', 390000],
      ['2026-09-30', 390000],
      ['2026-10-31', 390000],
    ])
    expect(on('Rent')).toEqual([
      ['2026-09-01', -175000],
      ['2026-10-01', -175000],
      ['2026-11-01', -175000],
    ])
    expect(on('Laptop · Pay in 4')).toEqual([['2026-11-06', -32475]])
    // Everyday spending averages close to the plan's $40 a day.
    const everyday = history.filter((t) => /^demo:(daily|coffee):/.test(t.id))
    const perDay = -everyday.reduce((sum, t) => sum + t.amountCents, 0) / 90
    expect(perDay).toBeGreaterThan(3500)
    expect(perDay).toBeLessThan(4500)
    expect(new Set(history.map((t) => t.id)).size).toBe(history.length)
    expect(JSON.stringify(nov13)).not.toMatch(/Maya|PayPal Credit|Venmo|Canon|Nikon|Sony|Fuji/)
  })

  it('has $872.26 of room today', () => {
    const c = compare()
    expect(c.spendLess).toMatchObject({ maxPriceCents: 87226, outcome: 'fits' })
  })

  it('buying today goes below the cushion on Nov 19, below zero on Nov 20, lowest −$726.74 on Nov 30', () => {
    const c = compare()
    expect(c.buyToday).toMatchObject({
      outcome: 'tight',
      lowestBalanceCents: -72674,
      lowestDate: '2026-11-30',
    })
    const points = forecast(nov13.profile, [], {
      today: ALEX_DEMO_DAY,
      purchaseDate: ALEX_DEMO_DAY,
      amountCents: camera.priceCents,
      days: COMPARISON_WINDOW_DAYS,
    })
    expect(points.find((p) => p.minimumCents < 30000)?.date).toBe('2026-11-19')
    expect(points.find((p) => p.minimumCents < 0)?.date).toBe('2026-11-20')
  })

  it('waits until Tue Dec 15, day 32 of the 35-day search; buying then leaves $458.78 on Dec 31', () => {
    const c = compare()
    expect(c.wait).toMatchObject({
      date: '2026-12-15',
      outcome: 'fits',
      lowestBalanceCents: 45878,
      lowestDate: '2026-12-31',
    })
    expect(addDays(ALEX_DEMO_DAY, 32)).toBe('2026-12-15')
    expect(WAIT_SEARCH_DAYS).toBeGreaterThanOrEqual(32)
    expect(c.recommendation).toBe('wait')
  })

  it('Pay in 4 (4 × $474.75) is tight: payment 2 on Nov 27 takes it to $222.76 on Nov 30', () => {
    const { payIn4 } = compare()
    expect(payIn4).toMatchObject({
      outcome: 'tight',
      lowestBalanceCents: 22276,
      lowestDate: '2026-11-30',
      lowPointCause: { amountCents: 47475, date: '2026-11-27' },
    })
    if (!payIn4.available) throw new Error('Pay in 4 is in range for $1,899')
    expect(payIn4.lowPointCause?.name).toMatch(/payment 2 of 4/)
    expect(payIn4.instalments.map((i) => [i.date, i.amountCents])).toEqual([
      ['2026-11-13', 47475],
      ['2026-11-27', 47475],
      ['2026-12-11', 47475],
      ['2026-12-25', 47475],
    ])
  })
})

describe('Alex on Tue Dec 15 2026, the return visit', () => {
  const dec15 = createCameraScenario(ALEX_RETURN_DAY)

  it('opens on the balance the Nov 13 plan projects for that morning, with the flows moved on', () => {
    const session = { ...nov13, createdAt: 0 } as SessionData
    expect(dec15.profile.balanceCents).toBe(fundsProjection(session, [], ALEX_RETURN_DAY)!.cents)
    expect(dec15.profile).toMatchObject({ snapshotDate: ALEX_RETURN_DAY, name: 'Alex' })
    const laptop = dec15.profile.flows.filter((f) => f.planId === 'laptop-plan')
    expect(laptop.map((f) => f.nextDate)).toEqual(['2026-12-18'])
    expect(dec15.profile.flows.find((f) => f.id === 'photo-invoice')).toBeUndefined()
    expect(dec15.profile.flows.find((f) => f.id === 'salary')!.nextDate).toBe('2026-12-31')
    expect(dec15.profile.flows.find((f) => f.id === 'rent')!.nextDate).toBe('2027-01-01')
    const paid = dec15.transactions.filter((t) => t.name === 'Laptop · Pay in 4').map((t) => t.date)
    expect(paid.sort()).toEqual(['2026-11-06', '2026-11-20', '2026-12-04'])
    expect(
      dec15.transactions.find((t) => t.date === '2026-12-14' && t.amountCents === 165000),
    ).toBeDefined()
  })

  it('the camera fits today', () => {
    const c = compare(dec15, ALEX_RETURN_DAY)
    expect(c.buyToday.outcome).toBe('fits')
    expect(c.wait.date).toBe(ALEX_RETURN_DAY)
    expect(c.buyToday.lowestBalanceCents).toBe(45878)
  })

  it('refuses a day before the demo day', () => {
    expect(() => createCameraScenario('2026-11-12')).toThrow()
  })
})
