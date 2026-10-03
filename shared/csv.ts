import Papa from 'papaparse'
import type {
  Cadence,
  DateOrder,
  ForeignPayment,
  ImportPreview,
  ScheduledFlow,
  Transaction,
} from './types.ts'
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

const SLASH_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/

/**
 * Reads the order of a file's slash dates. PayPal formats dates by the account's country, so the
 * file decides: a first part above 12 means DD/MM and a second part above 12 means MM/DD. When no
 * date settles it, `ambiguous` reports whether any date would read differently either way.
 */
function detectDateOrder(values: string[]): {
  order: DateOrder | null
  ambiguous: boolean
  mixed: boolean
} {
  let dayFirst = false
  let monthFirst = false
  let ambiguous = false
  for (const value of values) {
    const match = value.trim().match(SLASH_DATE)
    if (!match) continue
    const [first, second] = [Number(match[1]), Number(match[2])]
    if (first > 12) dayFirst = true
    else if (second > 12) monthFirst = true
    else if (first !== second) ambiguous = true
  }
  return {
    order: dayFirst === monthFirst ? null : dayFirst ? 'DD/MM' : 'MM/DD',
    ambiguous: !dayFirst && !monthFirst && ambiguous,
    mixed: dayFirst && monthFirst,
  }
}

function parseDate(value: string, order: DateOrder): string | null {
  let candidate: string
  const iso = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/)
  const slash = value.trim().match(SLASH_DATE)
  if (iso) candidate = `${iso[1]}-${iso[2]}-${iso[3]}`
  else if (slash) {
    const [month, day] = order === 'DD/MM' ? [slash[2]!, slash[1]!] : [slash[1]!, slash[2]!]
    candidate = `${slash[3]}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  } else return null
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

function classify(name: string, type: string, amount: number): Classification {
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

type Classification = Pick<Transaction, 'category' | 'kind' | 'color'>

/**
 * What imported history suggests: how many days it covers, everyday spending per day (recurring
 * suggestions and refunded amounts excluded) and recurring items to confirm. Only imported
 * transactions are analyzed.
 */
export function analyzeHistory(
  transactions: Transaction[],
  today: string,
): { coverageDays: number; suggestedDailySpendCents: number; recurring: ScheduledFlow[] } {
  const imported = transactions
    .filter((transaction) => transaction.source === 'import')
    .sort((a, b) => a.date.localeCompare(b.date))
  const coverageDays = imported.length
    ? dateDistance(imported[0]!.date, imported[imported.length - 1]!.date) + 1
    : 0
  const suggestions = recurringSuggestions(imported, today)
  const refunded = new Map<string, number>()
  for (const transaction of imported)
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
  const ordinaryTotal = imported
    .filter(
      (transaction) =>
        transaction.kind === 'expense' &&
        transaction.status === 'completed' &&
        !suggestions.ids.has(transaction.id),
    )
    .reduce(
      (sum, transaction) =>
        sum + Math.max(0, Math.abs(transaction.amountCents) - (refunded.get(transaction.id) ?? 0)),
      0,
    )
  return {
    coverageDays,
    suggestedDailySpendCents: coverageDays ? Math.round(ordinaryTotal / coverageDays) : 0,
    recurring: suggestions.flows,
  }
}

const FOREIGN_PAYMENT_GATE = /^Resolve \d+ foreign-currency payments? /

/**
 * The profile's missing information with one entry for unresolved foreign-currency payments, kept
 * while any remain. While it is there, no assessment can be positive.
 */
export function withForeignPaymentGate(
  missingFields: string[],
  payments: ForeignPayment[] = [],
): string[] {
  const open = payments.filter((payment) => !payment.resolution).length
  const others = missingFields.filter((field) => !FOREIGN_PAYMENT_GATE.test(field))
  if (!open) return others
  return [
    ...others,
    `Resolve ${open} foreign-currency ${open === 1 ? 'payment' : 'payments'} from your import in Activity: enter what ${open === 1 ? 'it' : 'each one'} cost in USD, or mark ${open === 1 ? 'it' : 'each one'} as a one-off.`,
  ]
}

/** The USD record of a foreign-currency payment once the user says what it cost. */
export function foreignPaymentTransaction(
  payment: ForeignPayment,
  amountCents: number,
): Transaction {
  return {
    id: payment.id,
    date: payment.date,
    name: payment.name,
    amountCents: -amountCents,
    currency: 'USD',
    ...classify(payment.name, payment.type, -amountCents),
    status: 'completed',
    source: 'import',
  }
}

/** One validated CSV row, before it becomes a transaction. */
interface Row {
  rowNumber: number
  date: string
  time: string
  name: string
  type: string
  amount: number
  currency: string
  nativeId: string
  reference: string
  statusText: string
  status: Transaction['status']
}

function readStatus(statusText: string): Transaction['status'] {
  return /pending|held|hold|processing|unclaimed|in.?progress/.test(statusText)
    ? 'pending'
    : /denied|cancel|failed|void|expired|removed|reversed/.test(statusText)
      ? 'excluded'
      : statusText === '' ||
          /^(completed|complete|cleared|paid|processed|refunded|partially refunded|success|successful)$/.test(
            statusText,
          )
        ? 'completed'
        : 'excluded'
}

function isConversion(row: Row): boolean {
  return /\bconversion\b/i.test(row.type)
}

/** A completed payment out in another currency, the kind a USD conversion pays for. */
function isForeignSpend(row: Row): boolean {
  return (
    row.currency !== 'USD' &&
    !isConversion(row) &&
    row.amount < 0 &&
    row.status === 'completed' &&
    classify(row.name, row.type, row.amount).kind === 'expense'
  )
}

/**
 * Matches USD currency-conversion legs to the foreign-currency payments they paid for. Business
 * exports link the legs to the payment through Reference Txn ID. Personal exports have no
 * reference, so a leg pairs with the one foreign payment that has exactly the same date and time.
 * A leg that converted money the user received or already held is a transfer; a USD debit with no
 * payment to pair with is `unmatched`.
 */
function pairConversions(rows: Row[]): {
  paid: Map<Row, Row[]>
  legs: Map<Row, 'paid' | 'transfer' | 'unmatched'>
} {
  const paid = new Map<Row, Row[]>()
  const legs = new Map<Row, 'paid' | 'transfer' | 'unmatched'>()
  const link = (leg: Row, payment: Row) => {
    paid.set(payment, [...(paid.get(payment) ?? []), leg])
    legs.set(leg, 'paid')
  }
  const byId = new Map(rows.filter((row) => row.nativeId).map((row) => [row.nativeId, row]))
  const usdLegs = new Set(rows.filter((row) => row.currency === 'USD' && isConversion(row)))
  for (const leg of usdLegs) {
    const target = leg.reference ? byId.get(leg.reference) : undefined
    if (!target || target === leg) continue
    if (leg.amount < 0 && isForeignSpend(target)) link(leg, target)
    else legs.set(leg, 'transfer')
  }
  const moments = new Map<string, { legs: Row[]; payments: Row[] }>()
  for (const row of rows) {
    const leg = usdLegs.has(row) && !legs.has(row) && row.amount < 0
    const payment = isForeignSpend(row) && !paid.has(row)
    if (!row.time || (!leg && !payment)) continue
    const key = `${row.date}|${row.time}`
    const moment = moments.get(key) ?? { legs: [], payments: [] }
    ;(leg ? moment.legs : moment.payments).push(row)
    moments.set(key, moment)
  }
  for (const moment of moments.values())
    if (moment.legs.length === 1 && moment.payments.length === 1)
      link(moment.legs[0]!, moment.payments[0]!)
  for (const leg of usdLegs)
    if (!legs.has(leg)) legs.set(leg, leg.amount < 0 ? 'unmatched' : 'transfer')
  return { paid, legs }
}

export interface ParseOptions {
  /** Today in the profile's time zone. Without it, today in New York is used. */
  today?: string
  /** The user's answer when every slash date in the file could be read either way. */
  dateOrder?: DateOrder
  /** Foreign-currency payments from earlier imports; resolved ones are not raised again. */
  foreignPayments?: ForeignPayment[]
}

export function parsePayPalCsv(
  text: string,
  existing: Transaction[] = [],
  options: ParseOptions = {},
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
    leftOut: { memo: 0, holds: 0, otherCurrency: 0 },
    unresolved: [],
    dateOrder: null,
    needsDateOrder: false,
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
  const dates = detectDateOrder(parsed.data.map((row) => get(row, 'date')))
  if (dates.mixed) {
    result.errors.push({
      row: 1,
      message:
        'Dates in this file mix month/day and day/month order. Export it again so every date uses one format.',
    })
    return result
  }
  // A date such as 03/04/2026 is never guessed: the file decides, or the user does.
  if (dates.ambiguous && !options.dateOrder) {
    result.needsDateOrder = true
    result.warnings.push(
      'Every date in this file could be read two ways; 03/04/2026 could be March 4 or April 3. Choose whether it uses month/day (US) or day/month order.',
    )
    return result
  }
  result.dateOrder = dates.order ?? (dates.ambiguous ? options.dateOrder! : null)
  const dateOrder = result.dateOrder ?? 'MM/DD'
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

  // 1. Validate every row. Memo rows and holds go first: they never moved money.
  const rows: Row[] = []
  for (let index = 0; index < parsed.data.length; index++) {
    const raw = parsed.data[index]!
    const rowNumber = index + 2
    const type = get(raw, 'type')
    // Funding legs and corrections often have no counterparty; fall back to the item, then the type.
    const name =
      (get(raw, 'name') || get(raw, 'title') || type).slice(0, 180) || 'PayPal transaction'
    if (get(raw, 'impact').toLowerCase() === 'memo') {
      result.leftOut.memo++
      continue
    }
    if (HOLD_TYPE.test(type)) {
      result.leftOut.holds++
      continue
    }
    const date = parseDate(get(raw, 'date'), dateOrder)
    const amount = parseCents(get(raw, 'amount'))
    const currency = get(raw, 'currency').toUpperCase()
    if (!date) {
      result.errors.push({
        row: rowNumber,
        message: `Invalid date. Use YYYY-MM-DD or ${dateOrder}/YYYY, the order the rest of this file uses.`,
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
        message: 'Invalid amount. Use signed amounts with at most two decimal places.',
      })
      continue
    }
    if (!currency) {
      result.errors.push({
        row: rowNumber,
        message: 'Currency is missing. Confirm this row is USD before importing.',
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
    const statusText = get(raw, 'status').toLowerCase()
    rows.push({
      rowNumber,
      date,
      time: get(raw, 'time'),
      name,
      type,
      amount,
      currency,
      nativeId: get(raw, 'id'),
      reference: get(raw, 'reference'),
      statusText,
      status: readStatus(statusText),
    })
  }

  // 2. Record a row once, under the identity it was exported with.
  const identify = (row: Row) => {
    const fingerprint = hash(
      [row.date, row.time, row.name, row.type, row.amount, row.currency].join('|'),
    )
    const ordinal = (occurrences.get(fingerprint) ?? 0) + 1
    occurrences.set(fingerprint, ordinal)
    return row.nativeId ? `paypal:${row.nativeId}` : `import:${fingerprint}:${ordinal}`
  }
  const record = (
    row: Row,
    override: { amount?: number; classification?: Classification } = {},
  ) => {
    const { rowNumber, date, nativeId, status, statusText } = row
    const amount = override.amount ?? row.amount
    const currency = override.amount === undefined ? row.currency : 'USD'
    const id = identify(row)
    if (
      statusText &&
      status === 'excluded' &&
      !/denied|cancel|failed|void|expired|removed|reversed/.test(statusText)
    )
      result.warnings.push(
        `Row ${rowNumber}: unrecognized status “${statusText}” is excluded from estimates.`,
      )
    const classification = override.classification ?? classify(row.name, row.type, amount)
    const transaction: Transaction = {
      id,
      date,
      name: row.name,
      amountCents: amount,
      currency,
      ...classification,
      status,
      source: 'import',
      ...(row.reference ? { referenceId: `paypal:${row.reference}` } : {}),
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
        return
      }
      // The capture reference is the identity. A merchant name or amount alone never establishes a match.
      // App captures use UTC dates; an export's local date can legitimately differ by one day.
      if (dayDifference === 1)
        result.warnings.push(
          `Row ${rowNumber}: capture ${nativeId} is already recorded in Worth. Its one-day date difference is treated as a time-zone difference.`,
        )
      result.duplicates++
      return
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
        return
      }
      if (previous.status === status || (status === 'pending' && previous.status !== 'pending')) {
        result.duplicates++
        return
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

  // 3. Foreign-currency payments count once, through the USD conversion that paid for them.
  const knownForeign = new Map((options.foreignPayments ?? []).map((item) => [item.id, item]))
  const conversions = pairConversions(rows)
  for (const row of rows) {
    if (row.currency !== 'USD') {
      const legs = conversions.paid.get(row)
      if (legs) {
        record(row, { amount: legs.reduce((sum, leg) => sum + leg.amount, 0) })
        continue
      }
      result.leftOut.otherCurrency++
      if (!isForeignSpend(row)) continue
      // Spending in another currency without its USD cost is unresolved, never silently dropped.
      const id = identify(row)
      if (row.nativeId && capturedPurchases.has(row.nativeId)) {
        result.errors.push({
          row: row.rowNumber,
          message: `Capture ${row.nativeId} matches a Worth purchase but its currency conflicts. Resolve this row before importing.`,
        })
        continue
      }
      if (knownById.has(id) || knownForeign.get(id)?.resolution) {
        result.duplicates++
        continue
      }
      if (!result.unresolved.some((payment) => payment.id === id))
        result.unresolved.push({
          id,
          date: row.date,
          name: row.name,
          type: row.type,
          currency: row.currency,
          originalCents: row.amount,
        })
      continue
    }
    const leg = conversions.legs.get(row)
    if (leg === 'paid') continue
    if (leg === 'unmatched') {
      // The foreign payment it paid for is missing from the file. Counting it is the safe side.
      result.warnings.push(
        `Row ${row.rowNumber}: this USD currency conversion has no matching foreign-currency payment in the file, so it counts as spending.`,
      )
      record(row, {
        amount: row.amount,
        classification: { kind: 'expense', category: 'Currency conversion', color: '#e7cbb1' },
      })
      continue
    }
    record(row)
  }
  // Return only inserted/updated rows, but analyze the complete retained personal history.
  const combined = [...knownById.values()].filter((transaction) => transaction.source === 'import')
  const analysis = analyzeHistory(combined, today)
  result.coverageDays = analysis.coverageDays
  result.recurring = analysis.recurring
  result.suggestedDailySpendCents = analysis.suggestedDailySpendCents
  const latest = combined.reduce<string | undefined>(
    (max, transaction) => (!max || transaction.date > max ? transaction.date : max),
    undefined,
  )
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
  if (latest && dateDistance(latest, today) > 7)
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
  const unresolved = result.unresolved.length
  if (unresolved)
    result.warnings.push(
      `${unresolved} foreign-currency ${unresolved === 1 ? 'payment has' : 'payments have'} no matching USD conversion. Worth will not show a positive result until you enter what each one cost in USD or mark it as a one-off.`,
    )
  const { memo, holds, otherCurrency } = result.leftOut
  if (otherCurrency)
    result.warnings.push(
      `${otherCurrency} ${otherCurrency === 1 ? 'row' : 'rows'} in other currencies ${otherCurrency === 1 ? 'was' : 'were'} left out. Worth plans in USD: a foreign-currency payment counts once, through the USD conversion that paid for it.`,
    )
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
