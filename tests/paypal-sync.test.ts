import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { activityCsv } from '../server/paypalConnect.ts'
import type { TransactionInfo } from '../server/paypalConnect.ts'
import { applyConnectedRead } from '../server/paypalSync.ts'
import type { SessionData } from '../server/store.ts'
import { parsePayPalCsv } from '../shared/csv.ts'
import { draftPlans, planFlows } from '../shared/onboarding.ts'
import { createDemoState } from '../shared/seed.ts'
import type { ScheduledFlow, Transaction } from '../shared/types.ts'

// The merge rules for a background Connect PayPal read (server/paypalSync.ts), on the shape of the
// sandbox buyer's real activity: a $1,199 camera bought with Pay Later on Oct 3.

const TODAY = '2026-11-12'
const ZONE = 'America/New_York'
const ROWS = (
  JSON.parse(
    readFileSync(new URL('./fixtures/paypal-mcp-activity.json', import.meta.url), 'utf8'),
  ) as { transaction_details: { transaction_info: TransactionInfo }[] }
).transaction_details.map((item) => item.transaction_info)
const row = (
  id: string,
  code: string,
  date: string,
  value: string,
  subject?: string,
): TransactionInfo => ({
  transaction_id: id,
  transaction_event_code: code,
  transaction_initiation_date: date,
  transaction_amount: { currency_code: 'USD', value },
  transaction_status: 'S',
  ...(subject ? { transaction_subject: subject } : {}),
})
/** The camera's first two Pay in 4 payments, a new lamp bought with Pay Later, and a coffee. */
const LATER = [
  row('TXPAY1', 'T1800', '2026-10-03T14:00:00Z', '-299.75'),
  row('TXPAY2', 'T1800', '2026-10-17T14:00:00Z', '-299.75'),
  row('TXLAMP', 'T0006', '2026-11-10T15:00:00Z', '-400.00', 'Desk lamp'),
  row('TXLAMPF', 'T1600', '2026-11-10T15:00:00Z', '400.00'),
  row('TXCOFFEE', 'T0006', '2026-11-11T09:00:00Z', '-12.00', 'Corner coffee'),
]
const merge = (existing: Transaction[], incoming: Transaction[]) => {
  const all = new Map(existing.map((t) => [t.id, t]))
  for (const t of incoming) all.set(t.id, t)
  return [...all.values()]
}
const OPTIONS = { today: TODAY, merge, maxTransactions: 20_000 }
const preview = (rows: TransactionInfo[], existing: Transaction[] = []) =>
  parsePayPalCsv(activityCsv(rows, ZONE).csv, existing, { today: TODAY })

const bill: ScheduledFlow = {
  id: 'you-rent',
  name: 'Rent',
  amountCents: 145000,
  nextDate: '2026-12-01',
  cadence: 'monthly',
  kind: 'bill',
  category: 'Home',
  confirmed: true,
  active: true,
  origin: 'you',
}
/** The plan as the user confirmed it from the first read: the camera's plan, rent, their figures. */
function confirmed(withCamera = true): SessionData {
  const first = preview(ROWS)
  const camera = draftPlans(first.instalmentPlans)[0]!
  const seed = createDemoState(TODAY)
  return {
    profile: {
      ...seed.profile,
      source: 'import',
      importedFrom: 'paypal',
      balanceCents: 180000,
      cushionCents: 30000,
      dailySpendCents: 3500,
      dailySpendOrigin: 'you',
      flows: [bill, ...(withCamera ? planFlows(camera, TODAY) : [])],
      version: 4,
      confirmed: true,
    },
    transactions: first.transactions,
    wishlist: [],
    createdAt: 0,
  }
}
const planIds = (data: SessionData) =>
  new Set(data.profile.flows.filter((f) => f.planId).map((f) => f.planId))

describe('a background PayPal read applied to a confirmed plan', () => {
  it('adds new activity, a new Pay in 4 plan, and marks made payments paid', () => {
    const data = confirmed()
    const cameraFlows = data.profile.flows.filter((f) => f.planId)
    expect(cameraFlows).toHaveLength(3)
    // Read on Nov 15, once the camera's Nov 14 payment is due.
    const changes = applyConnectedRead(data, preview([...ROWS, ...LATER], data.transactions), {
      ...OPTIONS,
      today: '2026-11-15',
    })
    expect(changes).toEqual({ transactions: 5, plans: 1, paid: 1 })
    // The camera: PayPal shows a second payment made, so its earliest remaining one is gone.
    const camera = data.profile.flows.filter((f) => f.planId === cameraFlows[0]!.planId)
    expect(camera.map((f) => f.nextDate)).toEqual(cameraFlows.slice(1).map((f) => f.nextDate))
    // The lamp, bought with Pay Later after the last read: 1 of 4 paid, three to come.
    const lamp = data.profile.flows.filter((f) => f.name.startsWith('Desk lamp'))
    expect(lamp.map((f) => [f.nextDate, f.amountCents])).toEqual([
      ['2026-11-24', 10000],
      ['2026-12-08', 10000],
      ['2026-12-22', 10000],
    ])
    expect(data.profile.version).toBe(5)
  })

  it('leaves the schedule alone for a payment made early, before it is due', () => {
    const data = confirmed()
    const before = data.profile.flows.filter((f) => f.planId).map((f) => f.nextDate)
    expect(before[0]! > TODAY).toBe(true)
    const changes = applyConnectedRead(
      data,
      preview([...ROWS, ...LATER], data.transactions),
      OPTIONS,
    )
    expect(changes?.paid).toBe(0)
    expect(
      data.profile.flows
        .filter((f) => f.planId && !f.name.startsWith('Desk lamp'))
        .map((f) => f.nextDate),
    ).toEqual(before)
  })

  it('never changes what the user entered or confirmed', () => {
    const data = confirmed()
    const before = structuredClone(data.profile)
    applyConnectedRead(data, preview([...ROWS, ...LATER], data.transactions), OPTIONS)
    const { flows: _flows, version: _version, coverageDays: _days, ...rest } = data.profile
    const { flows: _f, version: _v, coverageDays: _d, ...was } = before
    expect(rest).toEqual(was)
    expect(data.profile.flows.find((f) => f.id === 'you-rent')).toEqual(bill)
  })

  it('never brings back a plan the user left out at review', () => {
    const data = confirmed(false)
    const changes = applyConnectedRead(data, preview(ROWS, data.transactions), OPTIONS)
    expect(changes).toEqual({ transactions: 0, plans: 0, paid: 0 })
    expect(planIds(data).size).toBe(0)
  })

  it('changes nothing when the same activity is read again', () => {
    const data = confirmed()
    applyConnectedRead(data, preview([...ROWS, ...LATER], data.transactions), OPTIONS)
    const after = structuredClone(data)
    expect(
      applyConnectedRead(data, preview([...ROWS, ...LATER], data.transactions), OPTIONS),
    ).toEqual({ transactions: 0, plans: 0, paid: 0 })
    expect(data.profile).toEqual(after.profile)
  })

  it('applies nothing from a read with rows the import can’t use, or past the size limit', () => {
    const data = confirmed()
    const before = structuredClone(data)
    const read = preview([...ROWS, ...LATER], data.transactions)
    expect(
      applyConnectedRead(data, { ...read, errors: [{ row: 2, message: 'x' }] }, OPTIONS),
    ).toBeUndefined()
    expect(applyConnectedRead(data, read, { ...OPTIONS, maxTransactions: 10 })).toBeUndefined()
    expect(data).toEqual(before)
  })
})
