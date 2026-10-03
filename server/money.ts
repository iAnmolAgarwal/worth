// Money mentions in the user's own words. This reader validates what Claude
// reports; it never decides a price on its own when the text is ambiguous.

export type MentionCurrency = 'USD' | 'FOREIGN' | 'NONE'
export type MentionRole = 'price' | 'budget' | 'other'
export interface MoneyMention {
  raw: string
  index: number
  /** Whole USD cents for USD and unmarked numbers; null when the figure is malformed or out of range. */
  cents: number | null
  currency: MentionCurrency
  /** ISO-like code for a foreign mention, e.g. EUR or JPY. */
  code?: string
  role: MentionRole
}

const MAX_CENTS = 100_000_000
const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?`
const SCALE = String.raw`(?:\s?(k|thousand|grand|m|mm|million|bn|billion)\b)?`
const SCALES: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  grand: 1e3,
  m: 1e6,
  mm: 1e6,
  million: 1e6,
  bn: 1e9,
  billion: 1e9,
}

// Order matters: longer, more specific markers first.
const FOREIGN_PREFIXES: [string, string][] = [
  ['CA$', 'CAD'],
  ['C$', 'CAD'],
  ['AU$', 'AUD'],
  ['A$', 'AUD'],
  ['NZ$', 'NZD'],
  ['HK$', 'HKD'],
  ['S$', 'SGD'],
  ['MX$', 'MXN'],
  ['R$', 'BRL'],
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['¥', 'JPY'],
  ['₹', 'INR'],
  ['₩', 'KRW'],
  ['₽', 'RUB'],
  ['₺', 'TRY'],
  ['₱', 'PHP'],
  ['฿', 'THB'],
  ['Rs.', 'INR'],
  ['Rs', 'INR'],
]
const CODES = [
  'EUR',
  'GBP',
  'JPY',
  'INR',
  'CAD',
  'AUD',
  'NZD',
  'CHF',
  'CNY',
  'RMB',
  'MXN',
  'HKD',
  'SGD',
  'KRW',
  'BRL',
]
const FOREIGN_WORDS: [RegExp, string][] = [
  [/^(?:euros?|eur)\b/i, 'EUR'],
  [/^(?:pounds?(?:\s+sterling)?|quid|gbp|sterling)\b/i, 'GBP'],
  [/^(?:yen|jpy)\b/i, 'JPY'],
  [/^(?:rupees?|inr|lakhs?|crores?)\b/i, 'INR'],
  [/^(?:pesos?|mxn)\b/i, 'MXN'],
  [/^(?:yuan|rmb|cny|renminbi)\b/i, 'CNY'],
  [/^(?:francs?|chf)\b/i, 'CHF'],
  [/^(?:won|krw)\b/i, 'KRW'],
  [
    /^(?:canadian|australian|aussie|hong\s+kong|singapore|new\s+zealand|nz)\s+(?:dollars?|bucks?)\b/i,
    'OTHER',
  ],
  [/^(?:cad|aud|nzd|hkd|sgd|brl|reais|reals?)\b/i, 'OTHER'],
]

const BUDGET_BEFORE =
  /\b(?:budget|have|has|had|got|left|spare|saved|savings|balance|earn(?:ed)?|make|made|income|paid|salary|limit|max(?:imum)?|up\s+to|under|less\s+than|below|within|no\s+more\s+than|at\s+most)\s*(?:is|of|was|are|=)?\s*(?:about|around|roughly|like|just|only)?\s*$/i
const BUDGET_AFTER =
  /^\s*(?:budget|left|to\s+spare|to\s+spend|in\s+(?:savings|my\s+account|the\s+bank)|saved|spare|limit|max(?:imum)?|or\s+less|tops)\b/i
const OTHER_BEFORE =
  /\b(?:was|were|used\s+to\s+be|originally|down\s+from|marked\s+down\s+from|regular(?:ly)?|list\s+price(?:\s+of)?|msrp(?:\s+of)?|retail(?:s)?(?:\s+for)?|save|saving|discount\s+of|refund(?:ed)?(?:\s+of)?|deposit(?:\s+of)?|spent|spend\s+about)\s*$/i
const OTHER_AFTER = /^\s*(?:off|discount|cheaper|less|more|savings?|refund|deposit|ago)\b/i
const PRICE_CUE =
  /\b(?:costs?|price[ds]?(?:\s+(?:is|of|at))?|priced\s+at|for|at|worth|pay(?:ing)?|spend(?:ing)?|is|it's|its)\s*(?:about|around|roughly|like|only|just)?\s*$/i
const NOT_MONEY_AFTER =
  /^\s*(?:%|percent|x\b|times\b|days?\b|weeks?\b|months?\b|years?\b|hours?\b|minutes?\b|nights?\b|people\b|persons?\b|items?\b|pcs\b|pieces?\b|units?\b|of\s+them\b|st\b|nd\b|rd\b|th\b|am\b|pm\b|gb\b|tb\b|mp\b|mm\b|inch|"|'|in\b(?!\s+(?:savings|my|the)))/i

function toCents(whole: string, fraction: string | undefined, scale: string | undefined) {
  if (whole.includes(',') && !/^\d{1,3}(?:,\d{3})+$/.test(whole)) return null
  const multiplier = scale ? SCALES[scale.toLowerCase()]! : 1
  // Scaled shorthand such as $1.5k allows any decimal; plain prices allow cents only.
  if (fraction !== undefined && !scale && fraction.length > 2) return null
  const value = Number(
    `${whole.replaceAll(',', '')}${fraction !== undefined ? `.${fraction}` : ''}`,
  )
  const cents = Math.round(value * multiplier * 100)
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= MAX_CENTS ? cents : null
}

function roleFor(text: string, start: number, end: number): MentionRole {
  const before = text.slice(Math.max(0, start - 40), start)
  const after = text.slice(end, end + 30)
  if (OTHER_BEFORE.test(before) || OTHER_AFTER.test(after)) return 'other'
  if (BUDGET_BEFORE.test(before) || BUDGET_AFTER.test(after)) return 'budget'
  return 'price'
}

/** Every amount the text states, with its currency marker and role. */
export function extractMoneyMentions(text: string): MoneyMention[] {
  const mentions: MoneyMention[] = []
  const pattern = new RegExp(
    String.raw`(?<![A-Za-z\d.,])(US\$|U\.S\.\$|USD\s?|` +
      FOREIGN_PREFIXES.map(([p]) => p.replace(/[$.]/g, '\\$&') + String.raw`\s?`).join('|') +
      `|(?:${CODES.join('|')})\\s?|\\$\\s?)?` +
      NUMBER +
      SCALE,
    'gi',
  )
  for (const match of text.matchAll(pattern)) {
    const [raw, prefix, whole, fraction, scale] = match
    const index = match.index
    let end = index + raw.length
    const rest = text.slice(end)
    let currency: MentionCurrency = 'NONE'
    let code: string | undefined
    const marker = prefix?.trim().toUpperCase()
    if (marker) {
      const foreign = FOREIGN_PREFIXES.find(([p]) => p.toUpperCase() === marker)
      if (foreign) [currency, code] = ['FOREIGN', foreign[1]]
      else if (CODES.includes(marker))
        [currency, code] = ['FOREIGN', marker === 'RMB' ? 'CNY' : marker]
      else currency = 'USD'
    }
    const suffix = rest.match(/^\s?(?:\$|usd\b|dollars?\b|bucks?\b)/i)
    const foreignSuffix =
      FOREIGN_WORDS.find(([word]) => word.test(rest.trimStart())) ??
      (rest.match(/^\s?[€£¥₹₩₽₺₱฿]/) ? ([/./, 'OTHER'] as [RegExp, string]) : undefined)
    if (foreignSuffix) {
      currency = 'FOREIGN'
      code ??= foreignSuffix[1]
    } else if (suffix && currency === 'NONE') {
      currency = 'USD'
      end += suffix[0].length
    } else if (suffix && currency === 'FOREIGN') {
      // "CA$500 dollars" stays foreign.
    }
    // A preceding foreign word such as "EUR 500" or "Rs 500" was handled by the prefix.
    if (currency === 'NONE') {
      const before = text.slice(Math.max(0, index - 30), index)
      if (NOT_MONEY_AFTER.test(rest) || !PRICE_CUE.test(before)) continue
      // Unmarked numbers followed by a noun-like unit (e.g. "2 cameras") are quantities.
      if (
        !scale &&
        /^\s+[a-z]+s\b/i.test(rest) &&
        !/\b(?:costs?|price|priced|worth|pay|spend)\b/i.test(before)
      )
        continue
    }
    // "11,99" or "1.199,00" use a decimal comma: never guess which part is cents.
    const malformed = /^,\d/.test(text.slice(index + match[0].length))
    mentions.push({
      raw: text.slice(index, end),
      index,
      cents: currency === 'FOREIGN' || malformed ? null : toCents(whole!, fraction, scale),
      currency,
      ...(code ? { code } : {}),
      role: roleFor(text, index, end),
    })
  }
  return mentions
}

/** USD (or unmarked, price-cued) amounts that a stated price may be grounded in. */
export function groundableAmounts(mentions: MoneyMention[]) {
  return mentions.filter(
    (m): m is MoneyMention & { cents: number } =>
      m.currency !== 'FOREIGN' && m.cents !== null && m.role !== 'other',
  )
}

export function hasForeignAmount(mentions: MoneyMention[]) {
  return mentions.some((m) => m.currency === 'FOREIGN')
}

/** Mentions that read as a USD price, as opposed to a budget, saving or past price. */
export function priceMentions(mentions: MoneyMention[]) {
  return groundableAmounts(mentions).filter((m) => m.role === 'price')
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  single: 1,
  two: 2,
  pair: 2,
  couple: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  dozen: 12,
}

/** Whether a quantity greater than one is stated in the text. */
export function quantityStated(text: string, quantity: number) {
  if (quantity === 1) return true
  const lower = text.toLowerCase()
  if (new RegExp(String.raw`(?<![\d.,$])${quantity}(?![\d.,]|\s?k\b)`).test(lower)) return true
  return Object.entries(NUMBER_WORDS).some(
    ([word, value]) => value === quantity && new RegExp(String.raw`\b${word}\b`).test(lower),
  )
}
