import Papa from 'papaparse'
import type { Cadence, ImportPreview, ScheduledFlow, Transaction } from './types.ts'
import { occurrence, todayInTimezone } from './finance.ts'
import { CSV_IMPORT_LIMITS, CSV_SIZE_MESSAGE, utf8Bytes } from './limits.ts'

/**
 * Header aliases in order of preference. PayPal's personal export has Amount, Fees and Total; the
 * business "Download activity" export has Gross, Fee and Net, plus Reference Txn ID and Balance
 * Impact. The amount is the first of Net, Total, Amount and Gross, so fees are always included.
 */
const aliases = {
  date: ['date', 'transactiondate', 'transactiondatetime'],
  time: ['time', 'transactiontime'],
  name: ['name', 'merchantname', 'merchant', 'recipientname', 'sendername', 'description'],
  title: ['itemtitle', 'subject'],
  amount: [
    'net',
    'netamount',
    'total',
    'totalamount',
    'amount',
    'transactionamount',
    'gross',
    'grossamount',
  ],
  currency: ['currency', 'currencycode', 'transactioncurrency'],
  type: ['type', 'transactiontype'],
  status: ['status', 'transactionstatus'],
  id: ['transactionid', 'transactionidd', 'txn id', 'txnid'],
  reference: ['referencetxnid', 'referencetransactionid', 'referenceid'],
  impact: ['balanceimpact'],
} satisfies Record<string, string[]>

function key(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}
function hash(value: string): string {
  // Stable non-secret identifier. This is for identity, not cryptography.
  let first = 2166136261
  let second = 5381
  for (let index = 0; index < value.length; index++) {
    first = Math.imul(first ^ value.charCodeAt(index), 16777619)
    second = Math.imul(second, 33) ^ value.charCodeAt(index)
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`
}

function parseDate(value: string): string | null {
  let candidate: string
  const iso = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/)
  const us = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (iso) candidate = `${iso[1]}-${iso[2]}-${iso[3]}`
  else if (us) candidate = `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`
  else return null
  const date = new Date(`${candidate}T12:00:00Z`)
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === candidate
    ? candidate
    : null
}

function parseCents(value: string): number | null {
  let cleaned = value.trim().replace(/^\$/, '')
  const parentheses = /^\(.*\)$/.test(cleaned)
  if (parentheses) cleaned = cleaned.slice(1, -1).replace(/^\$/, '')
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(cleaned)) return null
  const negative = parentheses || cleaned.startsWith('-')
  cleaned = cleaned.replace(/^[+-]/, '').replace(/,/g, '')
  const [whole, fraction = ''] = cleaned.split('.')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents)) return null
  return negative ? -cents : cents
}

/** Money moved in from the user's own bank or card. "Direct Deposit" (pay) is not funding. */
const FUNDING_TYPE =
  /\b(?:bank deposit to pp account|deposit to pp account|(?:general )?(?:credit |debit )?card deposit|add(?:ed)? funds?|funds? added|top.?up|funding|transfer from (?:bank|checking|savings))\b/
/** Money moved out to the user's own bank or card. */
const WITHDRAWAL_TYPE =
  /\b(?:withdrawal|withdraw|transfer to (?:bank|checking|savings|(?:debit )?card)|instant transfer|standard transfer)\b/
/** Authorization holds, their releases and voids; the completed payment is a separate row. */
const HOLD_TYPE = /\b(?:holds?|authori[sz]ations?)\b/i
/** A plain bank transfer type with no other detail. */
const BANK_TRANSFER_TYPE = /^(?:bank )?transfer$/

function classify(
  name: string,
  type: string,
  amount: number,
): Pick<Transaction, 'category' | 'kind' | 'color'> {
  const content = `${name} ${type}`.toLowerCase()
  const kind = type.toLowerCase().trim()
  // PayPal's own balance corrections (for example a sandbox top-up) are neither income nor spending.
  if (/\b(account correction|correction|adjustment)\b/.test(kind))
    return { kind: 'adjustment', category: 'Account adjustment', color: '#c4c6bb' }
  // Only funding and withdrawal move the user's own money; everything else is income or spending.
  if (
    FUNDING_TYPE.test(kind) ||
    WITHDRAWAL_TYPE.test(kind) ||
    BANK_TRANSFER_TYPE.test(kind) ||
    /\bconversion\b/.test(kind) ||
    /\btransfer (from|to)\b/.test(name.toLowerCase())
  )
    return { kind: 'transfer', category: 'Transfers', color: '#c4c6bb' }
  if (/refund|reimbursement|reversal/.test(content))
    return {
      kind: 'refund',
      category: /reimbursement/.test(content) ? 'Reimbursements' : 'Refunds',
      color: '#c4c6bb',
    }
  if (
    amount > 0 &&
    (/\b(direct deposit|payroll)\b/.test(kind) ||
      /\b(salary|payroll|paycheck|wages)\b/.test(content))
  )
    return { kind: 'income', category: 'Income', color: '#b6d58d' }
  if (amount >= 0) return { kind: 'unknown', category: 'Review incoming payment', color: '#c4c6bb' }
  if (
    /\brent\b|mortgage|internet|electric|utility|utilities|water bill|insurance|comcast|verizon/.test(
      content,
    )
  )
    return { kind: 'expense', category: 'Home', color: '#d6af8e' }
  if (/spotify|netflix|hulu|disney|youtube|apple music/.test(content))
    return { kind: 'expense', category: 'Entertainment', color: '#b8d99c' }
  if (
    /adobe|icloud|dropbox|notion|github|microsoft|subscription|recurring|automatic payment|preapproved/.test(
      content,
    )
  )
    return { kind: 'expense', category: 'Software', color: '#c4bee0' }
  if (/grocery|groceries|whole foods|trader joe|supermarket|market/.test(content))
    return { kind: 'expense', category: 'Groceries', color: '#b6ce9f' }
  if (
    /coffee|cafe|café|restaurant|kitchen|sweetgreen|doordash|uber eats|starbucks|dining|food/.test(
      content,
    )
  )
    return { kind: 'expense', category: 'Food & drink', color: '#d7b897' }
  if (/transit|uber|lyft|train|metro|parking|shell|chevron|gas station/.test(content))
    return { kind: 'expense', category: 'Transport', color: '#b1c8d9' }
  if (/gym|fitness|health|pharmacy|walgreens/.test(content))
    return { kind: 'expense', category: 'Health', color: '#b9cddd' }
  return { kind: 'expense', category: 'Shopping', color: '#e7cbb1' }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length % 2
    ? sorted[Math.floor(sorted.length / 2)]!
    : Math.round((sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2)
}
function dateDistance(first: string, last: string): number {
  return Math.round(
    (Date.parse(`${last}T12:00:00Z`) - Date.parse(`${first}T12:00:00Z`)) / 86_400_000,
  )
}
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0, 12)).getUTCDate()
}
/**
 * The day a monthly or yearly item recurs on: the last day of the month when every observation
 * was, otherwise the most common day, with ties going to the most recent observation.
 */
function recurrenceAnchor(dates: string[]): number | 'last' {
  const days = dates.map((date) => date.split('-').map(Number) as [number, number, number])
  if (days.every(([year, month, day]) => day === daysInMonth(year, month))) return 'last'
  const counts = new Map<number, number>()
  for (const [, , day] of days) counts.set(day, (counts.get(day) ?? 0) + 1)
  const most = Math.max(...counts.values())
  return days.findLast(([, , day]) => counts.get(day) === most)![2]
}
/** The anchored day in the month of `date`, clamped to that month's length. */
function anchoredInMonth(date: string, anchor: number | 'last'): string {
  const [year, month] = date.split('-').map(Number)
  const lastDay = daysInMonth(year, month)
  const day = anchor === 'last' ? lastDay : Math.min(anchor, lastDay)
  return `${date.slice(0, 8)}${String(day).padStart(2, '0')}`
}

function recurringSuggestions(
  transactions: Transaction[],
  today: string,
): { flows: ScheduledFlow[]; ids: Set<string> } {
  const groups = new Map<string, Transaction[]>()
  for (const transaction of transactions) {
    if (transaction.status !== 'completed' || !['income', 'expense'].includes(transaction.kind))
      continue
    const groupKey = `${transaction.kind}:${transaction.name.toLowerCase().trim().replace(/\s+/g, ' ')}`
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), transaction])
  }
  const flows: ScheduledFlow[] = []
  const ids = new Set<string>()
  for (const [groupKey, group] of groups) {
    if (group.length < 2) continue
    const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date))
    const intervals = sorted
      .slice(1)
      .map((item, index) => dateDistance(sorted[index]!.date, item.date))
    const days = median(intervals)
    const cadence: Cadence | undefined =
      days >= 6 && days <= 8
        ? 'weekly'
        : days >= 12 && days <= 16
          ? 'biweekly'
          : days >= 25 && days <= 35
            ? 'monthly'
            : days >= 360 && days <= 370
              ? 'yearly'
              : undefined
    if (
      !cadence ||
      intervals.some(
        (value) =>
          Math.abs(value - days) > (cadence === 'monthly' ? 5 : cadence === 'yearly' ? 10 : 2),
      )
    )
      continue
    const amount = median(sorted.map((item) => Math.abs(item.amountCents)))
    if (
      !amount ||
      sorted.some(
        (item) => Math.abs(Math.abs(item.amountCents) - amount) > Math.max(100, amount * 0.12),
      )
    )
      continue
    const latest = sorted[sorted.length - 1]!
    // Repeated groceries/coffee are variable spending, not a subscription proposal.
    const bill =
      latest.category === 'Home' ||
      /\brent\b|insurance|loan|debt|internet|utility/.test(latest.name.toLowerCase())
    const knownSubscription =
      ['Entertainment', 'Software'].includes(latest.category) ||
      /gym|fitness|membership/.test(latest.name.toLowerCase())
    if (latest.kind !== 'income' && !bill && !knownSubscription) continue
    const anchorDay =
      cadence === 'monthly' || cadence === 'yearly'
        ? recurrenceAnchor(sorted.map((item) => item.date))
        : undefined
    const flow: ScheduledFlow = {
      id: `suggested:${hash(groupKey)}`,
      name: latest.name,
      amountCents: amount,
      // The latest period on the anchor; the suggestion is the first later one from today on.
      nextDate: anchorDay === undefined ? latest.date : anchoredInMonth(latest.date, anchorDay),
      ...(anchorDay === undefined ? {} : { anchorDay }),
      cadence,
      kind: latest.kind === 'income' ? 'income' : bill ? 'bill' : 'subscription',
      category: latest.category,
      confirmed: false,
      active: true,
      color: latest.color,
    }
    let nextDate = occurrence(flow, 1)
    for (let count = 2; nextDate < today && count < 1000; count++)
      nextDate = occurrence(flow, count)
    sorted.forEach((item) => ids.add(item.id))
    flows.push({ ...flow, nextDate })
  }
  return { flows: flows.sort((a, b) => a.nextDate.localeCompare(b.nextDate)), ids }
}

export function parsePayPalCsv(
  text: string,
  existing: Transaction[] = [],
  options: { today?: string } = {},
): ImportPreview {
  const result: ImportPreview = {
    transactions: [],
    errors: [],
    duplicates: 0,
    excluded: 0,
    coverageDays: 0,
    totalRows: 0,
    suggestedDailySpendCents: 0,
    recurring: [],
    warnings: [],
    adjustments: [],
    leftOut: { memo: 0, holds: 0 },
  }
  if (!text.trim()) {
    result.errors.push({ row: 1, message: 'The file is empty.' })
    return result
  }
  if (utf8Bytes(text) > CSV_IMPORT_LIMITS.maxBytes) {
    result.errors.push({ row: 1, message: CSV_SIZE_MESSAGE })
    return result
  }
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => key(header.trim()),
  })
  for (const error of parsed.errors)
    result.errors.push({ row: (error.row ?? 0) + 2, message: error.message })
  const fields = parsed.meta.fields ?? []
  const selected = Object.fromEntries(
    Object.entries(aliases).map(([field, options]) => [
      field,
      options.find((alias) => fields.includes(alias)),
    ]),
  ) as Record<keyof typeof aliases, string | undefined>
  for (const required of ['date', 'amount', 'currency'] as const)
    if (!selected[required])
      result.errors.push({
        row: 1,
        message: `Missing ${required} column. Use a PayPal English-language activity export with Date, Currency, and Net, Total, Amount, or Gross.`,
      })
  result.totalRows = parsed.data.length
  if (result.errors.some((error) => error.row === 1)) return result
  if (parsed.data.length > CSV_IMPORT_LIMITS.maxRows) {
    result.errors.push({
      row: 1,
      message: `Use at most ${CSV_IMPORT_LIMITS.maxRows.toLocaleString('en-US')} transactions per import.`,
    })
    return result
  }
  const get = (row: Record<string, string>, field: keyof typeof aliases) =>
    (selected[field] ? (row[selected[field]!] ?? '') : '').trim()
  const knownById = new Map(existing.map((transaction) => [transaction.id, transaction]))
  const capturedPurchases = new Map(
    existing
      .filter((transaction) => transaction.source === 'purchase' && transaction.referenceId)
      .map((transaction) => [transaction.referenceId!.replace(/^paypal:/, ''), transaction]),
  )
  const occurrences = new Map<string, number>()
  let noIds = 0
  // The caller passes today in the user's time zone; New York is only the standalone default.
  const today = options.today ?? todayInTimezone('America/New_York')
  for (let index = 0; index < parsed.data.length; index++) {
    const row = parsed.data[index]!
    const rowNumber = index + 2
    const date = parseDate(get(row, 'date'))
    const amount = parseCents(get(row, 'amount'))
    const currency = get(row, 'currency').toUpperCase()
    const type = get(row, 'type')
    // Funding legs and corrections often have no counterparty; fall back to the item, then the type.
    const name =
      (get(row, 'name') || get(row, 'title') || type).slice(0, 180) || 'PayPal transaction'
    // Memo rows and authorization holds (and their releases) never moved money.
    if (get(row, 'impact').toLowerCase() === 'memo') {
      result.leftOut.memo++
      continue
    }
    if (HOLD_TYPE.test(type)) {
      result.leftOut.holds++
      continue
    }
    if (!date) {
      result.errors.push({
        row: rowNumber,
        message: 'Invalid date. Use YYYY-MM-DD or the US MM/DD/YYYY format.',
      })
      continue
    }
    if (date > today) {
      result.errors.push({
        row: rowNumber,
        message: 'Future-dated history needs review before import.',
      })
      continue
    }
    if (amount === null) {
      result.errors.push({
        row: rowNumber,
        message: 'Invalid amount. Use signed USD amounts with at most two decimal places.',
      })
      continue
    }
    if (currency !== 'USD') {
      result.errors.push({
        row: rowNumber,
        message: currency
          ? `Unsupported currency ${currency}. Only USD can be forecast; no conversion is applied.`
          : 'Currency is missing. Confirm this row is USD before importing.',
      })
      continue
    }
    if (
      amount > 0 &&
      /payment sent|purchase|debit card payment/i.test(type) &&
      !/refund|reversal/i.test(type)
    ) {
      result.errors.push({
        row: rowNumber,
        message: 'An outgoing payment has a positive amount. Confirm its sign before importing.',
      })
      continue
    }
    const nativeId = get(row, 'id')
    const fingerprint = hash([date, get(row, 'time'), name, type, amount, currency].join('|'))
    const ordinal = (occurrences.get(fingerprint) ?? 0) + 1
    occurrences.set(fingerprint, ordinal)
    const id = nativeId ? `paypal:${nativeId}` : `import:${fingerprint}:${ordinal}`
    const statusText = get(row, 'status').toLowerCase()
    const status: Transaction['status'] =
      /pending|held|hold|processing|unclaimed|in.?progress/.test(statusText)
        ? 'pending'
        : /denied|cancel|failed|void|expired|removed|reversed/.test(statusText)
          ? 'excluded'
          : statusText === '' ||
              /^(completed|complete|cleared|paid|processed|refunded|partially refunded|success|successful)$/.test(
                statusText,
              )
            ? 'completed'
            : 'excluded'
    if (
      statusText &&
      status === 'excluded' &&
      !/denied|cancel|failed|void|expired|removed|reversed/.test(statusText)
    )
      result.warnings.push(
        `Row ${rowNumber}: unrecognized status “${statusText}” is excluded from estimates.`,
      )
    const classification = classify(name, type, amount)
    const reference = get(row, 'reference')
    const transaction: Transaction = {
      id,
      date,
      name,
      amountCents: amount,
      currency,
      ...classification,
      status,
      source: 'import',
      ...(reference ? { referenceId: `paypal:${reference}` } : {}),
    }
    const capturedPurchase = nativeId ? capturedPurchases.get(nativeId) : undefined
    if (capturedPurchase) {
      const dayDifference = Math.abs(dateDistance(capturedPurchase.date, date))
      if (
        capturedPurchase.amountCents !== amount ||
        capturedPurchase.currency !== currency ||
        !Number.isFinite(dayDifference) ||
        dayDifference > 1 ||
        classification.kind !== 'expense'
      ) {
        result.errors.push({
          row: rowNumber,
          message: `Capture ${nativeId} matches a Worth purchase but its amount, currency, date, or payment type conflicts. Resolve this row before importing.`,
        })
        continue
      }
      // The capture reference is the identity. A merchant name or amount alone never establishes a match.
      // App captures use UTC dates; an export's local date can legitimately differ by one day.
      if (dayDifference === 1)
        result.warnings.push(
          `Row ${rowNumber}: capture ${nativeId} is already recorded in Worth. Its one-day date difference is treated as a time-zone difference.`,
        )
      result.duplicates++
      continue
    }
    const previous = knownById.get(id)
    if (previous) {
      if (
        previous.amountCents !== amount ||
        previous.date !== date ||
        previous.currency !== currency
      ) {
        result.errors.push({
          row: rowNumber,
          message: `Transaction ${nativeId || id} appears with conflicting amounts or dates. Resolve the conflict before importing.`,
        })
        continue
      }
      if (previous.status === status || (status === 'pending' && previous.status !== 'pending')) {
        result.duplicates++
        continue
      }
      // A later settled/failed row replaces its pending representation; never add a second payment.
      const previousIndex = result.transactions.findIndex((item) => item.id === id)
      if (previousIndex >= 0) {
        result.transactions[previousIndex] = transaction
        result.duplicates++
      } else result.transactions.push(transaction)
    } else {
      result.transactions.push(transaction)
      if (!nativeId) noIds++
    }
    knownById.set(id, transaction)
  }
  // Return only inserted/updated rows, but analyze the complete retained personal history.
  const combined = [...knownById.values()].filter((transaction) => transaction.source === 'import')
  const chronological = combined.sort((a, b) => a.date.localeCompare(b.date))
  result.coverageDays = chronological.length
    ? dateDistance(chronological[0]!.date, chronological[chronological.length - 1]!.date) + 1
    : 0
  const suggestions = recurringSuggestions(combined, today)
  result.recurring = suggestions.flows
  const refunded = new Map<string, number>()
  for (const transaction of combined)
    if (
      transaction.kind === 'refund' &&
      transaction.status === 'completed' &&
      transaction.amountCents > 0 &&
      transaction.referenceId
    )
      refunded.set(
        transaction.referenceId,
        (refunded.get(transaction.referenceId) ?? 0) + transaction.amountCents,
      )
  const ordinarySpend = combined.filter(
    (transaction) =>
      transaction.kind === 'expense' &&
      transaction.status === 'completed' &&
      !suggestions.ids.has(transaction.id),
  )
  const ordinaryTotal = ordinarySpend.reduce(
    (sum, transaction) =>
      sum + Math.max(0, Math.abs(transaction.amountCents) - (refunded.get(transaction.id) ?? 0)),
    0,
  )
  result.suggestedDailySpendCents = result.coverageDays
    ? Math.round(ordinaryTotal / result.coverageDays)
    : 0
  result.excluded = result.transactions.filter(
    (transaction) =>
      transaction.status !== 'completed' ||
      ['transfer', 'refund', 'unknown', 'adjustment'].includes(transaction.kind) ||
      transaction.amountCents === 0,
  ).length
  const unknownIncoming = combined.filter(
    (transaction) => transaction.kind === 'unknown' && transaction.amountCents > 0,
  ).length
  const pending = combined.filter((transaction) => transaction.status === 'pending').length
  result.adjustments = result.transactions.filter(
    (transaction) => transaction.kind === 'adjustment',
  )
  if (!parsed.data.length)
    result.warnings.push(
      'This export has no transactions. PayPal reports can take a few hours to include recent activity; download it again later.',
    )
  if (result.errors.length)
    result.warnings.push(
      'Some rows could not be imported. Correct them or explicitly review the missing spending before trusting a forecast.',
    )
  if (result.coverageDays < 60)
    result.warnings.push(
      'This history covers fewer than 60 days. Confirm an everyday spending estimate that includes spending outside PayPal.',
    )
  if (
    chronological.length &&
    dateDistance(chronological[chronological.length - 1]!.date, today) > 7
  )
    result.warnings.push(
      'The latest transaction is more than a week old. Review changes in your current bills and spending.',
    )
  if (noIds)
    result.warnings.push(
      `${noIds} rows have no transaction ID. Identical rows are retained separately; check for duplicate entries before confirming.`,
    )
  if (unknownIncoming)
    result.warnings.push(
      `${unknownIncoming} incoming payments are not classified as salary. Confirm dependable income separately.`,
    )
  if (pending)
    result.warnings.push(
      `${pending} pending payments are excluded from spending history. Add any outstanding commitments to your financial picture.`,
    )
  const { memo, holds } = result.leftOut
  if (memo)
    result.warnings.push(
      `${memo} memo ${memo === 1 ? 'row was' : 'rows were'} left out. Memo rows never change your balance.`,
    )
  if (holds)
    result.warnings.push(
      `${holds} authorization ${holds === 1 ? 'hold or release was' : 'holds or releases were'} left out. A payment counts once it completes.`,
    )
  if (result.adjustments.length)
    result.warnings.push(
      `${result.adjustments.length} account ${result.adjustments.length === 1 ? 'correction is' : 'corrections are'} listed but not counted as income or spending.`,
    )
  if (result.recurring.length)
    result.warnings.push(
      'Likely recurring items are suggestions, not confirmed commitments. Their historical amounts are excluded from the everyday spending estimate; confirm each item or adjust that estimate.',
    )
  result.warnings.push(
    'Transfers and refunds do not count as salary or everyday spending. Historical transactions never change your current available-funds snapshot.',
  )
  result.transactions.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
  result.adjustments.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
  return result
}
