import { readFileSync } from 'node:fs'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../server/app.ts'
import { Store } from '../server/store.ts'
import { parsePayPalCsv } from '../shared/csv.ts'
import { addDays, compareOptions, planCollisions } from '../shared/finance.ts'
import {
  dayPhrase,
  draftFlows,
  draftPlans,
  originCounts,
  planDates,
  planFlows,
  SAMPLE_EXPORT_END,
  shiftSampleExport,
} from '../shared/onboarding.ts'
import type { AppState, ImportPreview, ScheduledFlow } from '../shared/types.ts'

const SAMPLE = readFileSync(
  new URL('../src/sample/paypal-activity-sample.csv', import.meta.url),
  'utf8',
)
const TODAY = '2026-10-10'
const stores: Store[] = []
const config = {
  production: false,
  origin: 'http://localhost:5173',
  paypalClientId: undefined,
  paypalSecret: undefined,
  anthropicKey: undefined,
}
function setup() {
  const store = new Store(':memory:')
  stores.push(store)
  const app = createApp({ store, config, now: () => new Date(`${TODAY}T16:00:00Z`) })
  return request.agent(app)
}
const post = (agent: ReturnType<typeof setup>, path: string, body: object) =>
  agent.post(path).set('X-Worth-Client', 'web').send(body)
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

const rent: ScheduledFlow = {
  id: 'you-rent',
  name: 'Maple Court rent',
  amountCents: 165000,
  nextDate: '2026-10-22',
  cadence: 'monthly',
  kind: 'bill',
  category: 'Other',
  confirmed: true,
  active: true,
  origin: 'you',
}

describe('the bundled sample PayPal export', () => {
  it('holds the scenario: payroll, four repeats and three Pay in 4 plans, one without its purchase', () => {
    const preview = parsePayPalCsv(SAMPLE, [], { today: TODAY })
    expect(preview.errors).toEqual([])
    expect(preview.needsDateOrder).toBe(false)
    expect(preview.recurring.map((flow) => [flow.name, flow.kind, flow.origin])).toEqual(
      expect.arrayContaining([
        ['Northwind Payroll', 'income', 'paypal'],
        ['Harbor Mutual Auto Insurance', 'bill', 'paypal'],
        ['Ridgeline Fitness', 'subscription', 'paypal'],
        ['Cobalt Mobile', 'subscription', 'paypal'],
        ['Tidewave Music', 'subscription', 'paypal'],
      ]),
    )
    expect(preview.recurring).toHaveLength(5)
    expect(
      preview.instalmentPlans.map((plan) => [
        plan.name,
        plan.title,
        plan.purchaseCents,
        plan.paymentCents,
      ]),
    ).toEqual([
      ['Northline Outfitters', 'Running shoes', 18000, 4500],
      ['PayPal Pay in 4', undefined, null, 6250],
      ['Larkspur Supply', 'Headphones', 29988, 7497],
    ])
    // Everyday spending leaves out the repeats and the plans.
    expect(preview.suggestedDailySpendCents).toBeGreaterThan(2000)
    expect(preview.suggestedDailySpendCents).toBeLessThan(4000)
  })

  it('moves to end yesterday, as a fresh download would', () => {
    expect(shiftSampleExport(SAMPLE, '2026-10-06')).toBe(SAMPLE)
    expect(shiftSampleExport(SAMPLE, '2026-11-12').split('\n')[1]).toMatch(/^"11\/11\/2026"/)
    expect(shiftSampleExport(SAMPLE, '2026-10-03').split('\n')[1]).toMatch(/^"10\/02\/2026"/)
    expect(
      SAMPLE.split('\n')[1]!.startsWith(
        `"${SAMPLE_EXPORT_END.slice(5, 7)}/${SAMPLE_EXPORT_END.slice(8)}/2026"`,
      ),
    ).toBe(true)
  })

  // A Saturday, a Wednesday, the day before a Friday payday, a month on and next year.
  it.each(['2026-10-10', '2026-10-14', '2026-10-29', '2026-11-12', '2027-02-28'])(
    'builds the same believable month on %s',
    (today) => {
      const preview = parsePayPalCsv(shiftSampleExport(SAMPLE, today), [], { today })
      expect(preview.errors).toEqual([])
      const dates = preview.transactions.map((item) => item.date).sort()
      // The file ends yesterday, with a Northwind payday on or before that.
      expect(dates.at(-1)).toBe(addDays(today, -1))
      const paydays = preview.transactions.filter((item) => item.kind === 'income')
      expect(paydays.at(-1)!.date <= dates.at(-1)!).toBe(true)
      const plans = draftPlans(preview.instalmentPlans)
      // The $62.50 plan still needs an answer.
      expect(
        plans.filter((plan) => plan.merchant === null && plan.left === undefined),
      ).toHaveLength(1)
      const flows = plans
        .map((plan) => (plan.merchant ? plan : { ...plan, left: 0 }))
        .flatMap((plan) => planFlows(plan, today))
      const larkspur = flows.filter((flow) => flow.name.startsWith('Larkspur Supply'))
      // Rent from the bank, due the day before Larkspur's next payment.
      const due = { ...rent, nextDate: addDays(larkspur[0]!.nextDate, -1) }
      const pay = preview.recurring.find((flow) => flow.kind === 'income')!
      expect(pay.nextDate < due.nextDate).toBe(true)
      const profile = {
        ...compareProfile(today),
        balanceCents: 180000,
        dailySpendCents: preview.suggestedDailySpendCents,
        flows: [...draftFlows(preview, []), due, ...flows],
      }
      const room = compareOptions(profile, [], { amountCents: 0, today })
      expect(room.spendLess.maxPriceCents).toBeGreaterThanOrEqual(25000)
      expect(room.spendLess.maxPriceCents).toBeLessThanOrEqual(60000)
      const notes = planCollisions(profile, [], today).filter(({ bill }) => bill.kind === 'bill')
      expect(notes).toHaveLength(1)
      expect(notes[0]!.payment).toMatchObject({ date: larkspur[0]!.nextDate, amountCents: 7497 })
      expect(dayPhrase(notes[0]!.bill.daysFromInstalment, notes[0]!.bill.name)).toBe(
        'the day after Maple Court rent',
      )
    },
  )
})

describe('the review draft', () => {
  // The sample as the app loads it on Sat, Oct 10: ending Fri, Oct 9.
  const preview = parsePayPalCsv(shiftSampleExport(SAMPLE, TODAY), [], { today: TODAY })

  it('estimates what is left of each plan and asks about the one without a purchase', () => {
    const plans = draftPlans(preview.instalmentPlans)
    expect(plans.map(({ merchant, seen, left }) => [merchant, seen, left])).toEqual([
      ['Northline Outfitters', 3, 1],
      [null, 2, undefined],
      ['Larkspur Supply', 2, 2],
    ])
    const larkspur = plans[2]!
    expect(planDates(larkspur, TODAY)).toEqual(['2026-10-23', '2026-11-06'])
    // A plan whose payments are all in the file is done.
    const done = draftPlans([
      {
        ...preview.instalmentPlans[0]!,
        payments: Array(4).fill(preview.instalmentPlans[0]!.payments[0]),
      },
    ])
    expect(done).toEqual([])
  })

  it('turns plans into payments from PayPal, none when left out or all paid', () => {
    const [northline, undated, larkspur] = draftPlans(preview.instalmentPlans)
    expect(planFlows(larkspur!, TODAY)).toMatchObject([
      {
        name: 'Larkspur Supply · Headphones · Pay in 4',
        amountCents: 7497,
        nextDate: '2026-10-23',
        origin: 'paypal',
        planTotalCents: 29988,
      },
      {
        name: 'Larkspur Supply · Headphones · Pay in 4',
        amountCents: 7497,
        nextDate: '2026-11-06',
        origin: 'paypal',
        planTotalCents: 29988,
      },
    ])
    expect(planFlows({ ...northline!, included: false }, TODAY)).toEqual([])
    expect(planFlows(undated!, TODAY)).toEqual([])
    expect(planFlows({ ...undated!, left: 0 }, TODAY)).toEqual([])
    expect(planFlows({ ...undated!, left: 1 }, TODAY)).toMatchObject([
      { name: 'Earlier purchase · Pay in 4', amountCents: 6250, nextDate: '2026-10-20' },
    ])
  })

  it('drafts the repeats as from PayPal and keeps what an imported plan already has', () => {
    const fresh = draftFlows(preview, [])
    expect(fresh.every((flow) => flow.origin === 'paypal' && flow.confirmed)).toBe(true)
    const kept = draftFlows(preview, [rent, { ...fresh[0]!, id: 'old', amountCents: 1 }])
    expect(kept.filter((flow) => flow.name === fresh[0]!.name)).toHaveLength(1)
    expect(kept[0]).toBe(rent)
  })

  it('runs planCollisions on the draft: Larkspur’s payment 3 lands the day after rent', () => {
    const plans = draftPlans(preview.instalmentPlans).map((plan) =>
      plan.merchant ? plan : { ...plan, left: 0 },
    )
    const profile = {
      ...compareProfile(),
      flows: [...draftFlows(preview, []), rent, ...plans.flatMap((plan) => planFlows(plan, TODAY))],
    }
    const found = planCollisions(profile, [], TODAY).filter(({ bill }) => bill.kind === 'bill')
    expect(found).toHaveLength(1)
    expect(found[0]!.payment).toMatchObject({ date: '2026-10-23', amountCents: 7497 })
    expect(dayPhrase(found[0]!.bill.daysFromInstalment, found[0]!.bill.name)).toBe(
      'the day after Maple Court rent',
    )
  })

  it('words a nearby day calmly', () => {
    expect(dayPhrase(0, 'rent')).toBe('the same day as rent')
    expect(dayPhrase(1, 'rent')).toBe('the day before rent')
    expect(dayPhrase(-2, 'rent')).toBe('2 days after rent')
  })

  it('counts the month by origin, keeping untagged items apart', () => {
    const flows = [
      ...draftFlows(preview, []),
      rent,
      { ...rent, id: 'old', name: 'Old loan', origin: undefined },
      { ...rent, id: 'off', name: 'Ended', active: false },
      ...draftPlans(preview.instalmentPlans).flatMap((plan) => planFlows(plan, TODAY)),
    ]
    const counts = originCounts(flows)
    expect(counts).toMatchObject({ paydays: 1, bills: 4, plans: 2 })
    expect(counts.added.map((flow) => flow.name)).toEqual(['Maple Court rent'])
    // Without an origin, Worth can't say who added it.
    expect(counts.earlier.map((flow) => flow.name)).toEqual(['Old loan'])
  })
})

function compareProfile(today = TODAY) {
  return {
    name: 'Your plan',
    balanceCents: 260000,
    cushionCents: 30000,
    dailySpendCents: 2800,
    currency: 'USD' as const,
    timezone: 'America/New_York',
    snapshotDate: today,
    confirmedAt: `${today}T16:00:00.000Z`,
    version: 1,
    confirmed: true,
    coverageDays: 90,
    source: 'import' as const,
    missingFields: [],
    flows: [],
    reflectedPurchaseIds: [],
    aiConsent: false,
  }
}

describe('sample export, end to end through the real import', () => {
  it('previews, imports and saves the reviewed month with each item’s origin', async () => {
    const agent = setup()
    const csv = shiftSampleExport(SAMPLE, TODAY)
    const preview = (await post(agent, '/api/import/preview', { csv })).body as ImportPreview
    expect(preview.errors).toEqual([])
    // The review: everything from PayPal kept, rent added, the undated plan answered "1 left".
    const plans = draftPlans(preview.instalmentPlans).map((plan) =>
      plan.merchant ? plan : { ...plan, left: 1 },
    )
    const flows = [
      ...draftFlows(preview, []),
      rent,
      ...plans.flatMap((plan) => planFlows(plan, TODAY)),
    ]
    const committed = await post(agent, '/api/import/commit', { csv })
    expect(committed.status).toBe(200)
    const imported = committed.body as AppState
    expect(imported.profile.source).toBe('import')
    expect(imported.profile.flows.every((flow) => flow.origin === 'paypal')).toBe(true)
    const saved = await agent
      .patch('/api/profile')
      .set('X-Worth-Client', 'web')
      .send({
        profile: {
          ...imported.profile,
          balanceCents: 260000,
          cushionCents: 30000,
          dailySpendCents: preview.suggestedDailySpendCents,
          flows,
          snapshotDate: imported.today,
          confirmed: true,
          missingFields: [],
        },
      })
    expect(saved.status).toBe(200)
    const state = saved.body as AppState
    expect(state.profile.confirmed).toBe(true)
    expect(state.profile.missingFields).toEqual([])
    expect(state.profile.flows.find((flow) => flow.id === 'you-rent')?.origin).toBe('you')
    expect(originCounts(state.profile.flows)).toMatchObject({ paydays: 1, bills: 4, plans: 3 })
    // The month answers: room to spend is computed, no field is missing.
    const room = compareOptions(state.profile, state.purchases, { amountCents: 0, today: TODAY })
    expect(room.recommendation).not.toBeNull()
    // Raw CSV is never kept in the session.
    expect(JSON.stringify(state)).not.toContain('Northwind Payroll","Direct Deposit')
  })

  it('rejects an origin that is neither paypal nor you', async () => {
    const agent = setup()
    const state = (await agent.get('/api/state')).body as AppState
    const bad = await agent
      .patch('/api/profile')
      .set('X-Worth-Client', 'web')
      .send({
        profile: {
          ...state.profile,
          flows: [{ ...rent, origin: 'bank' }],
        },
      })
    expect(bad.status).toBe(400)
  })
})
