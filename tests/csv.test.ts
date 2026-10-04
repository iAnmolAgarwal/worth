import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { foreignPaymentTransaction, parsePayPalCsv, withForeignPaymentGate } from '../shared/csv.ts'
import { CSV_IMPORT_LIMITS } from '../shared/limits.ts'
import type { Transaction } from '../shared/types.ts'

const HEADER = 'Date,Time,Name,Type,Status,Currency,Gross,Fee,Net,Transaction ID,Reference Txn ID'
/** Every date in these hand-written US rows could be read either way, so the order is given. */
const US = { dateOrder: 'MM/DD' } as const
function csv(...rows: string[]): string {
  return [HEADER, ...rows].join('\n')
}
function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-03T12:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('PayPal CSV normalization', () => {
  it('uses net, preserves integer cents, and separates spending, transfers, refunds and salary', () => {
    const result = parsePayPalCsv(
      csv(
        '09/01/2026,12:00:00,Grocery market,Express Checkout Payment,Completed,USD,-40.25,0,-40.25,spend-1,',
        '09/02/2026,12:00:00,Transfer from checking,Bank Deposit to PP Account,Completed,USD,500.00,0,500.00,transfer-1,',
        '09/03/2026,12:00:00,Acme payroll,Payment Received,Completed,USD,4200.00,-2.00,4198.00,pay-1,',
        '09/04/2026,12:00:00,Store,Refund,Completed,USD,40.25,0,40.25,refund-1,spend-1',
        '09/05/2026,12:00:00,Friend,Payment Received,Completed,USD,20.00,0,20.00,friend-1,',
      ),
      [],
      US,
    )
    expect(result.errors).toEqual([])
    expect(result.transactions.find((item) => item.id === 'paypal:spend-1')).toMatchObject({
      amountCents: -4025,
      kind: 'expense',
      category: 'Groceries',
    })
    expect(result.transactions.find((item) => item.id === 'paypal:pay-1')).toMatchObject({
      amountCents: 419800,
      kind: 'income',
    })
    expect(result.transactions.find((item) => item.id === 'paypal:transfer-1')!.kind).toBe(
      'transfer',
    )
    expect(result.transactions.find((item) => item.id === 'paypal:refund-1')).toMatchObject({
      kind: 'refund',
      referenceId: 'paypal:spend-1',
    })
    expect(result.transactions.find((item) => item.id === 'paypal:friend-1')!.kind).toBe('unknown')
    expect(result.suggestedDailySpendCents).toBe(0) // Referenced refund removes the original expense from the estimate.
    expect(result.excluded).toBe(3)
  })

  it('treats only funding and withdrawal types as transfers', () => {
    const kinds = (...rows: [string, string][]) =>
      parsePayPalCsv(
        'Date,Name,Type,Currency,Amount,Transaction ID\n' +
          rows
            .map(([type, amount], index) => `2026-09-01,,${type},USD,${amount},t${index}`)
            .join('\n'),
      )
        .transactions.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
        .map((item) => item.kind)
    expect(
      kinds(
        ['Bank Deposit to PP Account', '50.00'],
        ['General Card Deposit', '20.00'],
        ['General Credit Card Deposit', '20.00'],
        ['Add Funds from a Bank Account', '20.00'],
        ['General Withdrawal', '-50.00'],
        ['User Initiated Withdrawal', '-50.00'],
        ['Instant Transfer', '-50.00'],
        ['Transfer', '-50.00'],
      ),
    ).toEqual(Array(8).fill('transfer'))
    expect(
      kinds(
        ['Direct Deposit', '2100.00'],
        ['Mobile Check Deposit', '300.00'],
        ['Express Checkout Payment', '-12.00'],
      ),
    ).toEqual(['income', 'unknown', 'expense'])
  })

  it('suggests a paycheck typed as Direct Deposit as recurring income', () => {
    const rows = ['08/07', '08/21', '09/04', '09/18'].map(
      (day, index) =>
        `${day}/2026,06:00:00,ACME CORP PAYROLL,Direct Deposit,Completed,USD,"2,100.00",0,"2,100.00",dd-${index},`,
    )
    const result = parsePayPalCsv(csv(...rows), [], US)
    expect(result.errors).toEqual([])
    expect(result.transactions.every((item) => item.kind === 'income')).toBe(true)
    expect(result.recurring).toMatchObject([
      {
        name: 'ACME CORP PAYROLL',
        kind: 'income',
        cadence: 'biweekly',
        amountCents: 210000,
        nextDate: '2026-10-16',
      },
    ])
  })

  it('leaves out memo rows and authorization holds, and never counts pending rows', () => {
    const header =
      'Date,Time,Name,Type,Status,Currency,Gross,Fee,Net,Transaction ID,Reference Txn ID,Balance Impact'
    const result = parsePayPalCsv(
      [
        header,
        // A hold and its release without a reference between them.
        '09/25/2026,22:10:00,Uber,Account Hold for Open Authorization,Completed,USD,-25.00,0,-25.00,H1,,Debit',
        '09/25/2026,23:40:00,Uber,Reversal of General Account Hold,Completed,USD,25.00,0,25.00,H2,,Credit',
        '09/25/2026,23:40:00,Uber,Express Checkout Payment,Completed,USD,-23.40,0,-23.40,U1,,Debit',
        '10/02/2026,10:00:00,Netflix.com,General Authorization,Pending,USD,-15.49,0,-15.49,N1,,Memo',
        '10/01/2026,10:00:00,Bookshop,Express Checkout Payment,Completed,USD,-30.00,0,-30.00,M1,,Memo',
        '10/02/2026,18:20:00,Whole Foods Market,Express Checkout Payment,Pending,USD,-87.10,0,-87.10,P1,,Debit',
      ].join('\n'),
    )
    expect(result.errors).toEqual([])
    expect(result.totalRows).toBe(6)
    expect(result.leftOut).toEqual({ memo: 2, holds: 2, otherCurrency: 0 })
    expect(result.transactions.map((item) => [item.id, item.status])).toEqual([
      ['paypal:P1', 'pending'],
      ['paypal:U1', 'completed'],
    ])
    // Only the completed $23.40 counts: 2340 cents over Sep 25 to Oct 2 (8 days).
    expect(result.coverageDays).toBe(8)
    expect(result.suggestedDailySpendCents).toBe(Math.round(2340 / 8))
    const warnings = result.warnings.join(' ')
    expect(warnings).toContain('2 memo rows were left out')
    expect(warnings).toContain('2 temporary charges were left out')
    expect(warnings).toContain('1 pending payments are excluded')
  })

  it('handles quoted commas, BOM headers, and parentheses without float rounding', () => {
    const result = parsePayPalCsv(
      '\uFEFFDate,Name,Currency,Amount,Transaction ID\r\n2026-09-01,"Shop, Inc.",USD,"(1,234.56)",a\r\n2026-09-02,Coffee,USD,-0.29,b',
    )
    expect(result.errors).toEqual([])
    expect(result.transactions.find((item) => item.id === 'paypal:a')!.amountCents).toBe(-123456)
    expect(result.transactions.find((item) => item.id === 'paypal:b')!.amountCents).toBe(-29)
  })

  it('requires known currency, date and amount headers', () => {
    const result = parsePayPalCsv('Date,Name,Amount\n2026-09-01,Shop,-20.00')
    expect(result.transactions).toEqual([])
    expect(result.errors[0]!.message).toContain('currency')
  })

  it('rejects material invalid rows instead of silently coercing their values', () => {
    const result = parsePayPalCsv(
      'Date,Name,Currency,Amount\n2026-09-01,Euro Store,EUR,-50.00\n2026-02-30,Invalid date,USD,-10.00\n2026-09-01,Comma decimal,USD,"12,50"\n2026-09-02,Fraction,USD,-12.999\n2027-01-01,Future,USD,-10.00\n2026-09-02,Valid,USD,-25.00',
    )
    expect(result.errors.map((error) => error.row)).toEqual([3, 4, 5, 6])
    expect(result.transactions).toHaveLength(1)
    // The euro payment is no longer an error: it waits, unresolved, for its USD cost.
    expect(result.unresolved.map((payment) => payment.name)).toEqual(['Euro Store'])
    expect(result.warnings.join(' ')).toContain('Some rows could not be imported')
  })

  it('rejects outgoing payments with a positive amount', () => {
    const result = parsePayPalCsv(
      'Date,Name,Type,Currency,Amount\n2026-09-01,Store,Payment Sent,USD,50.00',
    )
    expect(result.transactions).toHaveLength(0)
    expect(result.errors[0]!.message).toContain('positive amount')
  })

  it('keeps pending payments visible and excludes failed or unknown status from estimates', () => {
    const result = parsePayPalCsv(
      'Date,Name,Currency,Amount,Status\n2026-09-01,Shop,USD,-20.00,Pending\n2026-09-02,Shop,USD,-30.00,Denied\n2026-09-03,Shop,USD,-40.00,Surprise',
    )
    expect(result.transactions.map((item) => item.status)).toEqual([
      'excluded',
      'excluded',
      'pending',
    ])
    expect(result.suggestedDailySpendCents).toBe(0)
    expect(result.excluded).toBe(3)
    expect(result.warnings.join(' ')).toContain('pending payments')
    expect(result.warnings.join(' ')).toContain('unrecognized status')
  })
})

describe('identity and recurring spending', () => {
  const capturedPurchase: Transaction = {
    id: 'purchase-local-1',
    referenceId: 'CAPTURE-A',
    source: 'purchase',
    amountCents: -34900,
    date: '2026-10-01',
    name: 'Studio headphones',
    currency: 'USD',
    kind: 'expense',
    category: 'Shopping',
    status: 'completed',
  }

  it('deduplicates a CSV capture already recorded by the app without changing its canonical record', () => {
    const original = structuredClone(capturedPurchase)
    const result = parsePayPalCsv(
      'Date,Name,Type,Currency,Amount,Transaction ID\n2026-10-01,Worth merchant,Payment Sent,USD,-349.00,CAPTURE-A',
      [capturedPurchase],
    )
    expect(result.errors).toEqual([])
    expect(result.transactions).toHaveLength(0)
    expect(result.duplicates).toBe(1)
    expect(capturedPurchase).toEqual(original)
  })

  it('never merges different captures just because their item, date, or price matches', () => {
    const result = parsePayPalCsv(
      'Date,Name,Type,Currency,Amount,Transaction ID\n2026-10-01,Studio headphones,Payment Sent,USD,-349.00,CAPTURE-B',
      [capturedPurchase],
    )
    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0]!.id).toBe('paypal:CAPTURE-B')
    expect(result.duplicates).toBe(0)
  })

  it.each([
    ['2026-10-01', '-3490.00', 'USD', 'Payment Sent'],
    ['2026-09-20', '-349.00', 'USD', 'Payment Sent'],
    ['2026-10-01', '-349.00', 'EUR', 'Payment Sent'],
    ['2026-10-01', '-349.00', 'USD', 'Transfer'],
  ])('flags conflicting capture details (%s, %s, %s, %s)', (date, amount, currency, type) => {
    const result = parsePayPalCsv(
      `Date,Name,Type,Currency,Amount,Transaction ID\n${date},Worth merchant,${type},${currency},${amount},CAPTURE-A`,
      [capturedPurchase],
    )
    expect(result.errors).toHaveLength(1)
    expect(result.transactions).toHaveLength(0)
    expect(result.duplicates).toBe(0)
  })

  it('allows a bounded UTC-to-export date difference only for the same capture ID', () => {
    const result = parsePayPalCsv(
      'Date,Name,Type,Currency,Amount,Transaction ID\n2026-09-30,Worth merchant,Payment Sent,USD,-349.00,CAPTURE-A',
      [capturedPurchase],
    )
    expect(result.errors).toEqual([])
    expect(result.duplicates).toBe(1)
    expect(result.warnings.join(' ')).toContain('time-zone difference')
  })

  it('retains refunds with a distinct ID even when their reference matches an app capture', () => {
    const result = parsePayPalCsv(
      csv(
        '10/02/2026,12:00:00,Worth merchant,Refund,Completed,USD,349.00,0,349.00,REFUND-A,CAPTURE-A',
      ),
      [capturedPurchase],
      US,
    )
    expect(result.errors).toEqual([])
    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0]!.kind).toBe('refund')
    expect(result.duplicates).toBe(0)
  })

  it('deduplicates native transaction IDs within a file and across repeated imports', () => {
    const row =
      '09/01/2026,12:00:00,Coffee,Express Checkout Payment,Completed,USD,-6.50,0,-6.50,abc,'
    const first = parsePayPalCsv(csv(row, row), [], US)
    expect(first.duplicates).toBe(1)
    expect(first.transactions).toHaveLength(1)
    const second = parsePayPalCsv(csv(row), first.transactions, US)
    expect(second.duplicates).toBe(1)
    expect(second.transactions).toHaveLength(0)
  })

  it('does not confuse refund references or repeated same-day purchases with duplicate transaction IDs', () => {
    const result = parsePayPalCsv(
      csv(
        '09/01/2026,12:00:00,Coffee,Express Checkout Payment,Completed,USD,-6.50,0,-6.50,a,',
        '09/01/2026,12:00:00,Coffee,Express Checkout Payment,Completed,USD,-6.50,0,-6.50,b,',
        '09/02/2026,12:00:00,Coffee,Refund,Completed,USD,6.50,0,6.50,c,a',
      ),
      [],
      US,
    )
    expect(result.transactions).toHaveLength(3)
    expect(result.duplicates).toBe(0)
  })

  it('replaces a pending row with its settled state without creating another expense', () => {
    const pending =
      '09/01/2026,12:00:00,Coffee,Express Checkout Payment,Pending,USD,-6.50,0,-6.50,a,'
    const completed = pending.replace('Pending', 'Completed')
    const first = parsePayPalCsv(csv(pending), [], US)
    const second = parsePayPalCsv(csv(completed), first.transactions, US)
    expect(second.transactions).toHaveLength(1)
    expect(second.transactions[0]!.status).toBe('completed')
    const together = parsePayPalCsv(csv(pending, completed), [], US)
    expect(together.transactions).toHaveLength(1)
    expect(together.transactions[0]!.status).toBe('completed')
    const stale = parsePayPalCsv(csv(completed, pending), [], US)
    expect(stale.transactions[0]!.status).toBe('completed')
  })

  it('surfaces conflicting amounts under a shared transaction ID', () => {
    const result = parsePayPalCsv(
      'Date,Name,Currency,Amount,Transaction ID\n2026-09-01,Coffee,USD,-6.50,a\n2026-09-01,Coffee,USD,-65.00,a',
    )
    expect(result.errors[0]!.message).toContain('conflicting amounts')
  })

  it('deducts only the refunded portion when estimating spending', () => {
    const result = parsePayPalCsv(
      csv(
        '09/01/2026,12:00:00,Grocery market,Payment Sent,Completed,USD,-100.00,0,-100.00,a,',
        '09/02/2026,12:00:00,Grocery market,Refund,Completed,USD,25.00,0,25.00,b,a',
      ),
      [],
      US,
    )
    expect(result.suggestedDailySpendCents).toBe(3750)
  })

  it('keeps previous personal history in the analysis when importing incremental rows', () => {
    const first = parsePayPalCsv(
      'Date,Name,Currency,Amount,Transaction ID\n2026-09-01,Coffee,USD,-10.00,a',
    )
    const second = parsePayPalCsv(
      'Date,Name,Currency,Amount,Transaction ID\n2026-09-10,Coffee,USD,-10.00,b',
      first.transactions,
    )
    expect(second.transactions).toHaveLength(1)
    expect(second.coverageDays).toBe(10)
    expect(second.suggestedDailySpendCents).toBe(200)
  })

  it('retains indistinguishable rows without IDs and explains the limitation', () => {
    const text =
      'Date,Name,Currency,Amount\n2026-09-01,Coffee,USD,-6.50\n2026-09-01,Coffee,USD,-6.50'
    const result = parsePayPalCsv(text)
    expect(result.transactions).toHaveLength(2)
    expect(result.transactions[0]!.id).not.toBe(result.transactions[1]!.id)
    expect(result.warnings.join(' ')).toContain('no transaction ID')
    expect(parsePayPalCsv(text, result.transactions).duplicates).toBe(2)
  })

  it('proposes unconfirmed recurring bills and excludes them from everyday spending', () => {
    const rows: string[] = []
    for (const month of ['07', '08', '09']) {
      rows.push(
        `${month}/01/2026,12:00:00,Apartment rent,Payment Sent,Completed,USD,-1750.00,0,-1750.00,rent-${month},`,
      )
      rows.push(
        `${month}/01/2026,12:00:00,Music streaming,Subscription Payment,Completed,USD,-11.99,0,-11.99,music-${month},`,
      )
      rows.push(
        `${month}/01/2026,12:00:00,Grocery market,Payment Sent,Completed,USD,-30.00,0,-30.00,food-${month},`,
      )
      rows.push(
        `${month}/01/2026,12:00:00,Acme payroll,Payment Received,Completed,USD,4200.00,0,4200.00,pay-${month},`,
      )
    }
    const result = parsePayPalCsv(csv(...rows), [], US)
    expect(result.errors).toEqual([])
    expect(result.recurring).toHaveLength(3)
    expect(result.recurring.every((item) => item.confirmed === false)).toBe(true)
    expect(result.recurring.find((item) => item.name === 'Apartment rent')).toMatchObject({
      kind: 'bill',
      cadence: 'monthly',
      amountCents: 175000,
    })
    expect(result.recurring.find((item) => item.name === 'Acme payroll')!.kind).toBe('income')
    expect(result.recurring.every((item) => item.nextDate >= '2026-10-03')).toBe(true)
    expect(result.coverageDays).toBe(63)
    expect(result.suggestedDailySpendCents).toBe(Math.round(9000 / 63))
  })

  it('anchors month-end bills to the last day and others to their usual day', () => {
    const rent = (...dates: string[]) =>
      parsePayPalCsv(
        csv(
          ...dates.map(
            (date, index) =>
              `${date},12:00:00,Apartment rent,Payment Sent,Completed,USD,-1750.00,0,-1750.00,rent-${index},`,
          ),
        ),
        [],
        US,
      ).recurring
    // Jul 31, Aug 31, Sep 30 are all month ends, so the next rent is Oct 31, not Oct 30.
    expect(rent('07/31/2026', '08/31/2026', '09/30/2026')).toMatchObject([
      { anchorDay: 'last', nextDate: '2026-10-31', cadence: 'monthly' },
    ])
    expect(rent('07/30/2026', '08/30/2026', '09/30/2026')).toMatchObject([
      { anchorDay: 30, nextDate: '2026-10-30' },
    ])
    // A payment made early once does not move the usual day.
    expect(rent('07/03/2026', '08/03/2026', '09/01/2026')).toMatchObject([
      { anchorDay: 3, nextDate: '2026-10-03' },
    ])
    // A tie goes to the most recent day.
    expect(rent('07/02/2026', '08/01/2026', '09/02/2026', '10/01/2026')).toMatchObject([
      { anchorDay: 1, nextDate: '2026-11-01' },
    ])
  })

  it('leaves weekly and biweekly suggestions without a month anchor', () => {
    const rows = ['08/07', '08/21', '09/04', '09/18'].map(
      (day, index) =>
        `${day}/2026,06:00:00,Acme payroll,Payment Received,Completed,USD,2100.00,0,2100.00,pay-${index},`,
    )
    const [payroll] = parsePayPalCsv(csv(...rows), [], US).recurring
    expect(payroll).toMatchObject({ cadence: 'biweekly', nextDate: '2026-10-16' })
    expect(payroll).not.toHaveProperty('anchorDay')
  })

  it('does not turn irregular merchant purchases into fixed obligations', () => {
    const result = parsePayPalCsv(
      'Date,Name,Currency,Amount\n2026-07-01,Music subscription,USD,-11.99\n2026-07-12,Music subscription,USD,-11.99\n2026-09-01,Music subscription,USD,-11.99',
    )
    expect(result.recurring).toEqual([])
  })

  it('judges future-dated rows against the caller’s today rather than New York', () => {
    // 01:30 on Oct 4 in India is still Oct 3 in New York.
    const text =
      'Date,Time,TimeZone,Name,Type,Status,Currency,Net,Transaction ID\n2026-10-04,01:05:00,IST,Coffee,Express Checkout Payment,Completed,USD,-4.00,TZ1'
    const india = parsePayPalCsv(text, [], { today: '2026-10-04' })
    expect(india.errors).toEqual([])
    expect(india.transactions.map((t) => t.date)).toEqual(['2026-10-04'])
    expect(parsePayPalCsv(text, [], { today: '2026-10-03' }).errors[0]!.message).toContain(
      'Future-dated',
    )
  })

  it('holds every file to the shared 1 MB and 10,000-row import limit', () => {
    expect(CSV_IMPORT_LIMITS).toEqual({ maxBytes: 1_000_000, maxRows: 10_000 })
    // 600,000 two-byte characters are 1.2 MB even though the string is shorter than 1,000,000.
    const wide = `Date,Name,Currency,Amount\n2026-09-01,${'é'.repeat(600_000)},USD,-1.00`
    expect(wide.length).toBeLessThan(CSV_IMPORT_LIMITS.maxBytes)
    expect(parsePayPalCsv(wide).errors).toEqual([
      { row: 1, message: 'Use a CSV smaller than 1 MB.' },
    ])
    const rows = (count: number) =>
      'Date,Name,Currency,Amount\n' + Array(count).fill('2026-09-01,Shop,USD,-1.00').join('\n')
    expect(parsePayPalCsv(rows(10_001)).errors[0]!.message).toBe(
      'Use at most 10,000 transactions per import.',
    )
    expect(parsePayPalCsv(rows(10_000)).errors).toEqual([])
  })

  it('returns useful diagnostics for empty and malformed files', () => {
    expect(parsePayPalCsv('').errors[0]!.message).toContain('empty')
    expect(
      parsePayPalCsv('Date,Name,Currency,Amount\n2026-09-01,"unclosed,USD,-1.00').errors.length,
    ).toBeGreaterThan(0)
  })
})

describe('real PayPal export formats', () => {
  it('imports the actual sandbox personal export as an uncounted account correction', () => {
    const result = parsePayPalCsv(fixture('paypal-personal-sandbox.csv'))
    expect(result.errors).toEqual([])
    expect(result.totalRows).toBe(1)
    expect(result.transactions).toEqual([
      {
        id: 'paypal:1TM185724V044315C',
        date: '2026-09-30',
        name: 'General Account Correction',
        amountCents: 500000,
        currency: 'USD',
        kind: 'adjustment',
        category: 'Account adjustment',
        color: '#c4c6bb',
        status: 'completed',
        source: 'import',
      },
    ])
    expect(result.adjustments).toEqual(result.transactions)
    expect(result.excluded).toBe(1)
    expect(result.suggestedDailySpendCents).toBe(0)
    expect(result.recurring).toEqual([])
    const warnings = result.warnings.join(' ')
    expect(warnings).toContain('1 account correction is listed but not counted')
    expect(warnings).not.toContain('not classified as salary')
  })

  it('reads a realistic expanded personal export end to end', () => {
    const result = parsePayPalCsv(fixture('paypal-personal-expanded.csv'))
    expect(result.errors).toEqual([])
    expect(result).toMatchObject({ totalRows: 25, dateOrder: 'MM/DD', needsDateOrder: false })
    // The rideshare hold and release; the euro conversion leg and the unmatched pound payment.
    expect(result.leftOut).toEqual({ memo: 0, holds: 2, otherCurrency: 2 })
    const byId = new Map(result.transactions.map((item) => [item.id, item]))
    expect(byId.get('paypal:PX0000006')).toMatchObject({
      name: 'Lisbon bakery',
      amountCents: -2061,
      currency: 'USD',
      kind: 'expense',
    })
    expect(byId.has('paypal:PX0000008')).toBe(false)
    expect(byId.get('paypal:PX0000004')).toMatchObject({ kind: 'income', amountCents: 185000 })
    expect(byId.get('paypal:PX0000002')!.kind).toBe('transfer')
    expect(byId.get('paypal:PX0000019')!.kind).toBe('transfer')
    expect(result.unresolved).toMatchObject([
      { id: 'paypal:PX0000016', name: 'London theatre box office', currency: 'GBP' },
    ])
    expect(result.adjustments.map((item) => [item.name, item.amountCents])).toEqual([
      ['General Account Correction', 500000],
    ])
    expect(result.instalmentPlans).toMatchObject([
      {
        name: 'Test Store',
        purchaseCents: 119900,
        paymentCents: 29975,
        payments: [{ date: '2026-09-28', amountCents: 29975, status: 'pending' }],
      },
    ])
    expect(
      result.recurring.map(({ name, kind, cadence, nextDate, anchorDay }) => ({
        name,
        kind,
        cadence,
        nextDate,
        anchorDay,
      })),
    ).toEqual([
      {
        name: 'Music streaming subscription',
        kind: 'subscription',
        cadence: 'monthly',
        nextDate: '2026-10-03',
        anchorDay: 3,
      },
      {
        name: 'NORTHWIND LOGISTICS PAYROLL',
        kind: 'income',
        cadence: 'biweekly',
        nextDate: '2026-10-16',
        anchorDay: undefined,
      },
      {
        name: 'Maple Court Apartments rent',
        kind: 'bill',
        cadence: 'monthly',
        nextDate: '2026-10-31',
        anchorDay: 'last',
      },
    ])
    // Everyday spending: groceries, the bakery's USD cost, the ride and the bookshop over 63 days.
    expect(result.coverageDays).toBe(63)
    expect(result.suggestedDailySpendCents).toBe(
      Math.round((6418 + 7192 + 2061 + 2640 + 2400) / 63),
    )
  })

  it('explains a sandbox export that has no rows yet', () => {
    const result = parsePayPalCsv(fixture('paypal-personal-sandbox-empty.csv'))
    expect(result.errors).toEqual([])
    expect(result.totalRows).toBe(0)
    expect(result.transactions).toEqual([])
    expect(result.warnings[0]).toContain('This export has no transactions')
  })

  it('reads the amount from Net, then Total, then Amount, then Gross', () => {
    const amount = (header: string, values: string) =>
      parsePayPalCsv(`Date,Name,Currency,${header}\n2026-09-01,Shop,USD,${values}`).transactions[0]!
        .amountCents
    expect(amount('Gross,Fee,Net', '-10.00,-0.50,-10.50')).toBe(-1050)
    expect(amount('Amount,Fees,Total', '-10.00,-0.50,-10.50')).toBe(-1050)
    expect(amount('Gross,Total,Net', '-12.00,-11.00,-10.00')).toBe(-1000)
    expect(amount('Gross,Amount', '-12.00,-10.00')).toBe(-1000)
    expect(amount('Gross', '-12.00')).toBe(-1200)
  })

  it('names rows without a counterparty after the item, then the type', () => {
    const result = parsePayPalCsv(
      'Date,Name,Type,Currency,Amount,Item Title,Transaction ID\n2026-09-01,,Express Checkout Payment,USD,-5.00,Phone case,a\n2026-09-02,,General Withdrawal,USD,-50.00,,b',
    )
    expect(result.transactions.map((item) => item.name)).toEqual([
      'General Withdrawal',
      'Phone case',
    ])
  })
})

describe('date order', () => {
  it('detects a UK day/month export from any day above 12', () => {
    const result = parsePayPalCsv(fixture('paypal-uk-ddmm.csv'))
    expect(result.errors).toEqual([])
    expect(result).toMatchObject({ needsDateOrder: false, dateOrder: 'DD/MM' })
    expect(result.transactions.map((item) => item.date)).toEqual([
      '2026-09-30',
      '2026-09-21',
      '2026-09-14',
      '2026-09-05',
      '2026-09-01',
      '2026-08-31',
      '2026-08-28',
      '2026-08-14',
      '2026-08-05',
      '2026-07-31',
    ])
    expect(result.coverageDays).toBe(62)
    // Groceries only: 192.15 over 62 days. Rent and the subscription are recurring suggestions.
    expect(result.suggestedDailySpendCents).toBe(Math.round(19215 / 62))
    expect(result.recurring).toMatchObject([
      { name: 'Video streaming subscription', kind: 'subscription', anchorDay: 5 },
      { name: 'Riverside Lettings rent', kind: 'bill', amountCents: 120000, anchorDay: 'last' },
    ])
    expect(result.recurring.map((item) => item.nextDate)).toEqual(['2026-10-05', '2026-10-31'])
  })

  it('asks instead of guessing when every date reads both ways', () => {
    const text = fixture('paypal-ambiguous-dates.csv')
    const unanswered = parsePayPalCsv(text)
    expect(unanswered).toMatchObject({
      needsDateOrder: true,
      dateOrder: null,
      errors: [],
      transactions: [],
      totalRows: 10,
    })
    expect(unanswered.warnings.join(' ')).toContain('03/04/2026 could be March 4 or April 3')
    const dayFirst = parsePayPalCsv(text, [], { dateOrder: 'DD/MM' })
    expect(dayFirst).toMatchObject({
      needsDateOrder: false,
      dateOrder: 'DD/MM',
      coverageDays: 36,
      suggestedDailySpendCents: Math.round(42118 / 36),
    })
    expect(dayFirst.recurring).toMatchObject([
      { name: 'Video streaming subscription', nextDate: '2026-10-05' },
    ])
    // Read the other way, the same rows span January to September and the subscription vanishes.
    const monthFirst = parsePayPalCsv(text, [], { dateOrder: 'MM/DD' })
    expect(monthFirst).toMatchObject({ dateOrder: 'MM/DD', coverageDays: 244, recurring: [] })
  })

  it('never reads 03/04/2026 without an answer', () => {
    const file = (date: string) => `Date,Name,Currency,Amount\n${date},Shop,USD,-1.00`
    expect(parsePayPalCsv(file('03/04/2026'))).toMatchObject({
      needsDateOrder: true,
      transactions: [],
    })
    expect(
      parsePayPalCsv(file('03/04/2026'), [], { dateOrder: 'MM/DD' }).transactions[0]!.date,
    ).toBe('2026-03-04')
    expect(
      parsePayPalCsv(file('03/04/2026'), [], { dateOrder: 'DD/MM' }).transactions[0]!.date,
    ).toBe('2026-04-03')
    // Dates that read the same either way need no answer.
    for (const date of ['03/03/2026', '2026-03-04'])
      expect(parsePayPalCsv(file(date))).toMatchObject({ needsDateOrder: false, dateOrder: null })
  })

  it('lets the file overrule a contradicting answer and rejects mixed orders', () => {
    const decided = parsePayPalCsv(
      'Date,Name,Currency,Amount,Transaction ID\n03/04/2026,Shop,USD,-1.00,a\n25/04/2026,Shop,USD,-2.00,b',
      [],
      { dateOrder: 'MM/DD' },
    )
    expect(decided.dateOrder).toBe('DD/MM')
    expect(decided.transactions.map((item) => item.date)).toEqual(['2026-04-25', '2026-04-03'])
    const mixed = parsePayPalCsv(
      'Date,Name,Currency,Amount\n25/04/2026,Shop,USD,-1.00\n04/25/2026,Shop,USD,-2.00',
    )
    expect(mixed.errors).toEqual([
      {
        row: 1,
        message:
          'Dates in this file mix month/day and day/month order. Export it again so every date uses one format.',
      },
    ])
    expect(mixed.transactions).toEqual([])
  })
})

const PERSONAL_HEADER =
  '"Date","Time","TimeZone","Name","Type","Status","Currency","Amount","Fees","Total","Exchange Rate","Receipt ID","Balance","Transaction ID","Item Title"'
function personal(...rows: string[][]): string {
  return [PERSONAL_HEADER, ...rows.map((row) => row.map((cell) => `"${cell}"`).join(','))].join(
    '\n',
  )
}
function personalRow(
  date: string,
  time: string,
  name: string,
  type: string,
  currency: string,
  amount: string,
  id: string,
): string[] {
  return [
    date,
    time,
    'EDT',
    name,
    type,
    'Completed',
    currency,
    amount,
    '0.00',
    amount,
    '',
    '',
    '',
    id,
    '',
  ]
}

describe('foreign currencies', () => {
  it('counts a business-export conversion once, in USD, and leaves memo and hold rows out', () => {
    const result = parsePayPalCsv(fixture('paypal-business-fx-memo.csv'))
    expect(result.errors).toEqual([])
    expect(result.dateOrder).toBe('MM/DD')
    // The EUR payment is recorded through its USD leg; only its EUR conversion leg is left out.
    expect(result.leftOut).toEqual({ memo: 2, holds: 2, otherCurrency: 1 })
    expect(result.transactions.find((item) => item.id === 'paypal:7ET00001AA')).toEqual({
      id: 'paypal:7ET00001AA',
      date: '2026-08-20',
      name: 'Ceramics studio Berlin',
      amountCents: -5012,
      currency: 'USD',
      kind: 'expense',
      category: 'Shopping',
      color: '#e7cbb1',
      status: 'completed',
      source: 'import',
    })
    // Neither conversion leg is a second record of the same spending.
    expect(result.transactions.map((item) => item.id)).not.toContain('paypal:7CV00002AA')
    expect(result.transactions.map((item) => item.id)).not.toContain('paypal:7CV00001AA')
    expect(result.transactions.every((item) => item.currency === 'USD')).toBe(true)
    // Ordinary spending: the mug's USD leg, the ride and the dinner. The TV was refunded in full.
    expect(result.coverageDays).toBe(61)
    expect(result.suggestedDailySpendCents).toBe(Math.round((5012 + 2340 + 4000) / 61))
    expect(result.recurring.map((item) => [item.name, item.kind, item.nextDate])).toEqual([
      ['ACME CORP PAYROLL', 'income', '2026-10-09'],
      ['Home internet', 'bill', '2026-10-15'],
      ['Music streaming subscription', 'subscription', '2026-11-01'],
    ])
    expect(result.warnings.join(' ')).toContain('1 row in other currencies was left out')
  })

  it('pairs personal-export conversion legs by identical date and time', () => {
    const result = parsePayPalCsv(
      personal(
        personalRow(
          '09/12/2026',
          '10:01:05',
          'Tokyo stationery',
          'Express Checkout Payment',
          'JPY',
          '-4,500.00',
          'P1',
        ),
        personalRow(
          '09/12/2026',
          '10:01:05',
          '',
          'General Currency Conversion',
          'JPY',
          '4,500.00',
          'P2',
        ),
        personalRow(
          '09/12/2026',
          '10:01:05',
          '',
          'General Currency Conversion',
          'USD',
          '-31.02',
          'P3',
        ),
        personalRow(
          '09/20/2026',
          '08:30:00',
          'Lisbon bakery',
          'Express Checkout Payment',
          'EUR',
          '-12.00',
          'P4',
        ),
        personalRow(
          '09/20/2026',
          '08:30:00',
          '',
          'General Currency Conversion',
          'USD',
          '-13.37',
          'P5',
        ),
        personalRow(
          '09/20/2026',
          '08:30:00',
          '',
          'General Currency Conversion',
          'EUR',
          '12.00',
          'P6',
        ),
      ),
    )
    expect(result.errors).toEqual([])
    expect(result.transactions.map((item) => [item.id, item.name, item.amountCents])).toEqual([
      ['paypal:P4', 'Lisbon bakery', -1337],
      ['paypal:P1', 'Tokyo stationery', -3102],
    ])
    expect(result.leftOut.otherCurrency).toBe(2)
  })

  it('counts a USD conversion whose foreign payment is missing as spending', () => {
    const result = parsePayPalCsv(
      personal(
        personalRow(
          '09/12/2026',
          '10:01:05',
          '',
          'General Currency Conversion',
          'USD',
          '-50.12',
          'L1',
        ),
        personalRow(
          '09/14/2026',
          '10:00:00',
          '',
          'General Currency Conversion',
          'USD',
          '20.00',
          'L2',
        ),
      ),
    )
    expect(result.errors).toEqual([])
    expect(result.transactions.map((item) => [item.id, item.kind, item.category])).toEqual([
      ['paypal:L2', 'transfer', 'Transfers'],
      ['paypal:L1', 'expense', 'Currency conversion'],
    ])
    expect(result.suggestedDailySpendCents).toBe(Math.round(5012 / 3))
    expect(result.warnings.join(' ')).toContain('Row 2: this USD currency conversion')
  })

  it('treats converting received USD as a transfer and leaves the other-currency legs out', () => {
    const result = parsePayPalCsv(
      [
        'Date,Time,TimeZone,Name,Type,Status,Currency,Gross,Fee,Net,Transaction ID,Reference Txn ID,Balance Impact',
        '15/09/2026,21:05:00,IST,Client LLC,Express Checkout Payment,Completed,USD,500.00,-22.45,477.55,INC1,,Credit',
        '15/09/2026,21:05:00,IST,,General Currency Conversion,Completed,USD,-477.55,0.00,-477.55,INC2,INC1,Debit',
        '15/09/2026,21:05:00,IST,,General Currency Conversion,Completed,INR,"39,812.17",0.00,"39,812.17",INC3,INC1,Credit',
        '15/09/2026,21:05:00,IST,,General Withdrawal,Completed,INR,"-39,812.17",0.00,"-39,812.17",INC4,,Debit',
      ].join('\n'),
    )
    expect(result.errors).toEqual([])
    expect(result.dateOrder).toBe('DD/MM')
    expect(result.transactions.map((item) => [item.id, item.kind])).toEqual([
      ['paypal:INC1', 'unknown'],
      ['paypal:INC2', 'transfer'],
    ])
    expect(result.leftOut.otherCurrency).toBe(2)
    expect(result.suggestedDailySpendCents).toBe(0)
  })
})

describe('unresolved foreign-currency spending', () => {
  const header = 'Date,Time,Name,Type,Status,Currency,Net,Transaction ID'
  const text = [
    header,
    '2026-09-10,09:00:00,Lisbon bakery,Express Checkout Payment,Completed,EUR,-12.00,F1',
    '2026-09-11,09:00:00,London theatre,Express Checkout Payment,Completed,GBP,-40.00,F2',
    '2026-09-12,09:00:00,Lisbon bakery,Express Checkout Payment,Pending,EUR,-8.00,F3',
    '2026-09-13,09:00:00,Paris client,Payment Received,Completed,EUR,300.00,F4',
    '2026-09-14,09:00:00,Coffee,Express Checkout Payment,Completed,USD,-4.00,U1',
  ].join('\n')

  it('lists completed foreign spending without a USD conversion instead of dropping it', () => {
    const result = parsePayPalCsv(text)
    expect(result.errors).toEqual([])
    expect(result.unresolved).toEqual([
      {
        id: 'paypal:F1',
        date: '2026-09-10',
        name: 'Lisbon bakery',
        type: 'Express Checkout Payment',
        currency: 'EUR',
        originalCents: -1200,
      },
      {
        id: 'paypal:F2',
        date: '2026-09-11',
        name: 'London theatre',
        type: 'Express Checkout Payment',
        currency: 'GBP',
        originalCents: -4000,
      },
    ])
    // Pending and incoming foreign rows are left out without needing an answer.
    expect(result.leftOut.otherCurrency).toBe(4)
    expect(result.transactions.map((item) => item.id)).toEqual(['paypal:U1'])
    expect(result.warnings.join(' ')).toContain(
      '2 foreign-currency payments have no matching USD conversion',
    )
  })

  it('does not raise a payment again once it is resolved', () => {
    const converted = foreignPaymentTransaction(parsePayPalCsv(text).unresolved[0]!, 1337)
    expect(converted).toEqual({
      id: 'paypal:F1',
      date: '2026-09-10',
      name: 'Lisbon bakery',
      amountCents: -1337,
      currency: 'USD',
      kind: 'expense',
      category: 'Shopping',
      color: '#e7cbb1',
      status: 'completed',
      source: 'import',
    })
    const again = parsePayPalCsv(text, [converted], {
      foreignPayments: [{ ...parsePayPalCsv(text).unresolved[1]!, resolution: { kind: 'oneOff' } }],
    })
    expect(again.unresolved).toEqual([])
    expect(again.duplicates).toBe(2)
  })

  it('keeps a missing-information entry exactly while payments are unresolved', () => {
    const payments = parsePayPalCsv(text).unresolved
    const gated = withForeignPaymentGate(['Confirm your funds.'], payments)
    expect(gated).toEqual([
      'Confirm your funds.',
      'Resolve 2 foreign-currency payments from your import in Activity: enter what each one cost in USD, or mark each one as a one-off.',
    ])
    // Applying it again replaces the entry rather than repeating it.
    const one = withForeignPaymentGate(gated, [
      { ...payments[0]!, resolution: { kind: 'usd', amountCents: 1337 } },
      payments[1]!,
    ])
    expect(one).toEqual([
      'Confirm your funds.',
      'Resolve 1 foreign-currency payment from your import in Activity: enter what it cost in USD, or mark it as a one-off.',
    ])
    expect(withForeignPaymentGate(one, [])).toEqual(['Confirm your funds.'])
  })
})

describe('Pay in 4 and Pay Later rows', () => {
  it('proposes a plan from a Pay in 4 purchase and its pending first payment', () => {
    const result = parsePayPalCsv(
      personal(
        personalRow('09/28/2026', '14:02:11', 'Test Store', 'Pay in 4', 'USD', '-1,199.00', 'S1'),
        [
          ...personalRow(
            '09/28/2026',
            '14:02:11',
            'Pay in 4',
            'Authorization',
            'USD',
            '-299.75',
            'S2',
          ),
        ].map((cell) => (cell === 'Completed' ? 'Pending' : cell)),
        personalRow(
          '09/29/2026',
          '09:00:00',
          'Corner grocery',
          'Express Checkout Payment',
          'USD',
          '-20.00',
          'S3',
        ),
      ),
    )
    expect(result.errors).toEqual([])
    // The authorization is kept as evidence of the plan, not left out as an ordinary hold.
    expect(result.leftOut.holds).toBe(0)
    expect(result.instalmentPlans).toEqual([
      {
        id: 'pay-later:paypal:S1',
        name: 'Test Store',
        startDate: '2026-09-28',
        purchaseCents: 119900,
        paymentCents: 29975,
        payments: [{ date: '2026-09-28', amountCents: 29975, status: 'pending' }],
        transactionIds: ['paypal:S1', 'paypal:S2'],
      },
    ])
    expect(
      result.transactions.filter((item) => item.kind === 'installment').map((item) => item.id),
    ).toEqual(['paypal:S1', 'paypal:S2'])
    // Only the groceries are everyday spending: 20.00 over Sep 28 to 29.
    expect(result.suggestedDailySpendCents).toBe(1000)
    expect(result.warnings.join(' ')).toContain('Found a possible Pay in 4 or Pay Later plan')
  })

  it('treats a Pay Later credit and the purchase it paid for as one plan', () => {
    const result = parsePayPalCsv(
      personal(
        personalRow(
          '09/20/2026',
          '18:30:00',
          'PayPal Pay Later',
          'Pay Later Funding',
          'USD',
          '450.00',
          'C1',
        ),
        personalRow(
          '09/20/2026',
          '18:30:00',
          'Outdoor gear shop',
          'Express Checkout Payment',
          'USD',
          '-450.00',
          'C2',
        ),
        personalRow(
          '09/20/2026',
          '18:30:00',
          'Coffee kiosk',
          'Express Checkout Payment',
          'USD',
          '-4.50',
          'C3',
        ),
      ),
    )
    expect(result.instalmentPlans).toMatchObject([
      {
        name: 'Outdoor gear shop',
        purchaseCents: 45000,
        paymentCents: 11250,
        transactionIds: ['paypal:C2', 'paypal:C1'],
      },
    ])
    expect(result.transactions.map((item) => [item.id, item.kind])).toEqual([
      ['paypal:C1', 'installment'],
      ['paypal:C2', 'installment'],
      ['paypal:C3', 'expense'],
    ])
    expect(result.suggestedDailySpendCents).toBe(450)
  })

  it('groups payments of an earlier plan by amount when its purchase is not in the file', () => {
    const result = parsePayPalCsv(
      personal(
        personalRow('09/02/2026', '08:00:00', 'PayPal Pay in 4', 'Payment', 'USD', '-62.50', 'R1'),
        personalRow('09/16/2026', '08:00:00', 'PayPal Pay in 4', 'Payment', 'USD', '-62.50', 'R2'),
        personalRow('09/16/2026', '08:05:00', 'PayPal Pay in 4', 'Payment', 'USD', '-25.00', 'R3'),
      ),
    )
    expect(
      result.instalmentPlans.map(({ name, purchaseCents, paymentCents, payments }) => ({
        name,
        purchaseCents,
        paymentCents,
        dates: payments.map((payment) => payment.date),
      })),
    ).toEqual([
      {
        name: 'PayPal Pay in 4',
        purchaseCents: null,
        paymentCents: 6250,
        dates: ['2026-09-02', '2026-09-16'],
      },
      { name: 'PayPal Pay in 4', purchaseCents: null, paymentCents: 2500, dates: ['2026-09-16'] },
    ])
    // Fixed payments of a plan are not proposed as a subscription.
    expect(result.recurring).toEqual([])
    expect(result.suggestedDailySpendCents).toBe(0)
  })

  it('does not mistake similar names for Pay in 4 or Pay Later', () => {
    const names = ['Pay 4 Less Market', 'Payday advance', 'Pay in full discount', 'Paylater Gifts']
    const result = parsePayPalCsv(
      personal(
        ...names.map((name, index) =>
          personalRow(
            '09/20/2026',
            '10:00:00',
            name,
            'Express Checkout Payment',
            'USD',
            '-10.00',
            `N${index}`,
          ),
        ),
      ),
    )
    expect(result.instalmentPlans).toEqual([])
    expect(result.transactions.every((item) => item.kind === 'expense')).toBe(true)
  })
})

describe('foreign payments across moments and imports', () => {
  const bakery = (status = 'Completed') =>
    [
      ...personalRow(
        '09/15/2026',
        '12:00:00',
        'Lisbon bakery',
        'Express Checkout Payment',
        'EUR',
        '-18.50',
        'P1',
      ),
    ].map((cell) => (cell === 'Completed' ? status : cell))
  const bakeryLegs = [
    personalRow('09/15/2026', '12:00:00', '', 'General Currency Conversion', 'EUR', '18.50', 'C1'),
    personalRow('09/15/2026', '12:00:01', '', 'General Currency Conversion', 'USD', '-20.61', 'C2'),
  ]
  const spent = (result: ReturnType<typeof parsePayPalCsv>) =>
    result.transactions.map((item) => [item.id, item.amountCents, item.status])

  it('pairs two conversions at one moment through their foreign-currency legs', () => {
    const result = parsePayPalCsv(
      personal(
        bakery(),
        ...bakeryLegs,
        personalRow(
          '09/15/2026',
          '12:00:01',
          'Porto shop',
          'Express Checkout Payment',
          'EUR',
          '-100.00',
          'P2',
        ),
        personalRow(
          '09/15/2026',
          '12:00:02',
          '',
          'General Currency Conversion',
          'EUR',
          '100.00',
          'C3',
        ),
        personalRow(
          '09/15/2026',
          '12:00:02',
          '',
          'General Currency Conversion',
          'USD',
          '-111.40',
          'C4',
        ),
      ),
    )
    expect(result.errors).toEqual([])
    expect(result.unresolved).toEqual([])
    expect(spent(result)).toEqual([
      ['paypal:P1', -2061, 'completed'],
      ['paypal:P2', -11140, 'completed'],
    ])
    expect(result.converted).toEqual(['paypal:P1', 'paypal:P2'])
  })

  it('counts a leftover USD leg once and does not raise the payments it may cover', () => {
    const result = parsePayPalCsv(
      personal(
        bakery(),
        personalRow(
          '09/15/2026',
          '12:00:00',
          'Porto shop',
          'Express Checkout Payment',
          'EUR',
          '-100.00',
          'P2',
        ),
        personalRow(
          '09/15/2026',
          '12:00:01',
          '',
          'General Currency Conversion',
          'USD',
          '-131.97',
          'C9',
        ),
      ),
    )
    expect(result.unresolved).toEqual([])
    expect(spent(result)).toEqual([['paypal:C9', -13197, 'completed']])
    expect(result.warnings.join(' ')).toContain(
      'Row 2: this foreign-currency payment shares its time',
    )
  })

  it('pairs a pending payment so its completed export replaces it instead of adding to it', () => {
    const first = parsePayPalCsv(personal(bakery('Pending'), ...bakeryLegs))
    expect(spent(first)).toEqual([['paypal:P1', -2061, 'pending']])
    const second = parsePayPalCsv(personal(bakery(), ...bakeryLegs), first.transactions)
    expect(spent(second)).toEqual([['paypal:P1', -2061, 'completed']])
    expect(second.suggestedDailySpendCents).toBe(2061)
  })

  it('does not add a payment whose USD leg is already in history as spending', () => {
    const legOnly = parsePayPalCsv(personal(bakeryLegs[1]!))
    expect(spent(legOnly)).toEqual([['paypal:C2', -2061, 'completed']])
    const later = parsePayPalCsv(personal(bakery(), ...bakeryLegs), legOnly.transactions)
    expect(later.transactions).toEqual([])
    expect(later.converted).toEqual(['paypal:P1'])
    expect(later.unresolved).toEqual([])
  })

  it('replaces a USD cost the user entered with the conversion a later export shows', () => {
    const payment = parsePayPalCsv(personal(bakery())).unresolved[0]!
    const entered = foreignPaymentTransaction(payment, 2000)
    const later = parsePayPalCsv(personal(bakery(), ...bakeryLegs), [entered], {
      foreignPayments: [{ ...payment, resolution: { kind: 'usd', amountCents: 2000 } }],
    })
    expect(later.errors).toEqual([])
    expect(spent(later)).toEqual([['paypal:P1', -2061, 'completed']])
  })

  it('reports one foreign transaction ID with two different amounts as a conflict', () => {
    const result = parsePayPalCsv(
      personal(
        bakery(),
        personalRow(
          '09/15/2026',
          '12:00:00',
          'Lisbon bakery',
          'Express Checkout Payment',
          'EUR',
          '-5.00',
          'P1',
        ),
      ),
    )
    expect(result.errors).toEqual([
      {
        row: 3,
        message:
          'Transaction P1 appears with conflicting amounts or dates. Resolve the conflict before importing.',
      },
    ])
  })

  it('keeps proposing a Pay in 4 plan when the same file is imported again', () => {
    const text = personal(
      personalRow('09/28/2026', '14:02:11', 'Test Store', 'Pay in 4', 'USD', '-1,199.00', 'S1'),
    )
    const first = parsePayPalCsv(text)
    const again = parsePayPalCsv(text, first.transactions)
    expect(again.duplicates).toBe(1)
    expect(again.instalmentPlans).toEqual(first.instalmentPlans)
  })
})
