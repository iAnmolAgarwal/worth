import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parsePayPalCsv } from '../shared/csv.ts'
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
    expect(result.leftOut).toEqual({ memo: 2, holds: 2 })
    expect(result.transactions.map((item) => [item.id, item.status])).toEqual([
      ['paypal:P1', 'pending'],
      ['paypal:U1', 'completed'],
    ])
    // Only the completed $23.40 counts: 2340 cents over Sep 25 to Oct 2 (8 days).
    expect(result.coverageDays).toBe(8)
    expect(result.suggestedDailySpendCents).toBe(Math.round(2340 / 8))
    const warnings = result.warnings.join(' ')
    expect(warnings).toContain('2 memo rows were left out')
    expect(warnings).toContain('2 authorization holds or releases were left out')
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
    expect(result.errors).toHaveLength(5)
    expect(result.transactions).toHaveLength(1)
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
