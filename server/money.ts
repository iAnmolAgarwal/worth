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
  ['NT$', 'TWD'],
  ['zł', 'PLN'],
  ['Rs.', 'INR'],
  ['Rs', 'INR'],
  ['kr', 'SEK'],
  ['R', 'ZAR'],
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
const NATIONALITY = String.raw`(?:swiss|mexican|canadian|australian|aussie|hong\s+kong|singapore(?:an)?|new\s+zealand|nz|taiwan(?:ese)?|japanese|chinese|indian|swedish|norwegian|danish|polish|south\s+african|brazilian|turkish|russian|philippine|thai|korean|uae|emirati|saudi|israeli|egyptian|nigerian|kenyan|argentine|argentinian|chilean|colombian|peruvian|jamaican|caribbean|euro(?:pean)?|british|uk)`
const FOREIGN_WORDS: [RegExp, string][] = [
  [
    new RegExp(
      String.raw`^${NATIONALITY}\s+(?:dollars?|bucks?|pesos?|francs?|krona|kronor|krone|kroner|rand|rupees?|yen|yuan|won|pounds?|reais|real)\b`,
      'i',
    ),
    'OTHER',
  ],
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
  [/^(?:kr|kroner|krone|krona|kronor|sek|nok|dkk)\b/i, 'SEK'],
  [/^(?:zloty|złoty|zlotys|pln)\b/i, 'PLN'],
  [/^(?:rand|zar)\b/i, 'ZAR'],
  [
    /^(?:dirhams?|aed|riyals?|sar|shekels?|ils|baht|thb|ringgit|myr|rupiah|idr|dong|vnd|lira|liras|try|naira|ngn|cedis?|shillings?|forint|huf|koruna|czk|lei|leu|ron|dinars?|taka|ntd|twd|soles?|bolivars?)\b/i,
    'OTHER',
  ],
  [
    /^(?:usdt|usdc|tether|btc|bitcoins?|eth|ether|ethereum|sats|satoshis?|crypto|tokens?|coins?)\b/i,
    'CRYPTO',
  ],
]
// Upper-case codes after a number that are units, not currencies.
const NOT_CURRENCY_CODES = new Set(
  'USD GB TB MB KB GHZ MHZ MPH HDR RAM SSD HDD LED OLED LCD EST PST CST MST UTC GMT CET USB TV PC MAX PRO XL XXL LBS OZ PCS MPG KWH BTU DPI FPS'.split(
    ' ',
  ),
)
const CURRENCY_MARKERS = new RegExp(
  String.raw`(?:[€£¥₹₩₽₺₱฿]|\b(?:CA|C|AU|A|NZ|HK|S|MX|R|NT)\$|\b(?:euros?|yen|rupees?|pesos?|francs?|zloty|złoty|rand|dirhams?|riyals?|shekels?|baht|ringgit|rupiah|lira|naira|shillings?|forint|dinars?|usdt|usdc|btc|bitcoins?|ethereum|crypto)\b|\b${NATIONALITY}\s+(?:dollars?|currency)\b|\b(?:EUR|GBP|JPY|INR|CAD|AUD|NZD|CHF|CNY|RMB|MXN|HKD|SGD|KRW|BRL|SEK|NOK|DKK|PLN|ZAR|AED|SAR|ILS|THB|TWD|TRY)\b)`,
  'i',
)

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

// "between $800 and $900" or "from $800 to $900" is a price range, not two prices.
const RANGE_BEFORE = /\b(?:between|from)\s*$|\b(?:between|from)\s+\S+\s+(?:and|to|-)\s*$/i
const RANGE_AFTER = /^\s*(?:and|to|-|–)\s*(?:US)?\$?\s?\d/i

function roleFor(text: string, start: number, end: number): MentionRole {
  const before = text.slice(Math.max(0, start - 40), start)
  const after = text.slice(end, end + 30)
  if (OTHER_BEFORE.test(before) || OTHER_AFTER.test(after)) return 'other'
  if (
    RANGE_BEFORE.test(before) ||
    (/\b(?:between|from)\s*$/i.test(before) && RANGE_AFTER.test(after))
  )
    return 'budget'
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
    // "1.199,00 €": read the currency after a decimal-comma tail too.
    const tail = rest.replace(/^,\d+/, '')
    const suffix = rest.match(/^\s?(?:\$|usd\b|dollars?\b|bucks?\b)/i)
    const code3 = tail.match(/^\s?([A-Z]{3,4})\b/)?.[1]
    const foreignSuffix =
      FOREIGN_WORDS.find(([word]) => word.test(tail.trimStart())) ??
      (tail.match(/^\s?[€£¥₹₩₽₺₱฿]/) ? ([/./, 'OTHER'] as [RegExp, string]) : undefined) ??
      (code3 && !NOT_CURRENCY_CODES.has(code3) && !/^USDT?$/.test(code3)
        ? ([/./, code3] as [RegExp, string])
        : undefined) ??
      (code3 === 'USDT' ? ([/./, 'CRYPTO'] as [RegExp, string]) : undefined)
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
    // "11,99" or "1.199,00" use a decimal comma, and "$1 199" a space separator:
    // never guess which part is the amount.
    const malformed =
      /^(?:,\d|\s\d)/.test(text.slice(index + match[0].length)) ||
      /[-−]\s?$/.test(text.slice(0, index))
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

/** Amounts that cannot be read as US dollars: foreign, or malformed. A past or saved amount is excluded. */
export function unclearAmounts(mentions: MoneyMention[]) {
  return mentions.filter(
    (m) => m.role !== 'other' && (m.currency === 'FOREIGN' || m.cents === null),
  )
}

/** Whether the text names a currency other than US dollars anywhere, with or without an amount. */
export function mentionsOtherCurrency(text: string) {
  return CURRENCY_MARKERS.test(text)
}

/** Mentions that read as a USD price, as opposed to a budget, saving or past price. */
export function priceMentions(mentions: MoneyMention[]) {
  return groundableAmounts(mentions).filter((m) => m.role === 'price')
}

const COUNT_WORDS: Record<string, number> = {
  two: 2,
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
}
const PER_UNIT =
  /\b(?:each|apiece|a\s+piece|per\s+(?:item|piece|unit|one|ticket|person)|\/\s?ea\b|ea\.)/i

/**
 * Whether the user stated a quantity above one for this item and priced it per unit:
 * the count must sit next to the item ("3 shirts", "two tickets") and the price must be
 * marked as per item ("at $40 each"). Otherwise the stated price is the total.
 */
export function quantityStated(text: string, quantity: number, itemName = '') {
  if (quantity === 1) return true
  if (!PER_UNIT.test(text)) return false
  const stem = (itemName.toLowerCase().match(/[a-z]+/g) ?? [])
    .filter((w) => w.length > 2)
    .at(-1)
    ?.replace(/(?:es|s)$/, '')
  if (!stem) return false
  const count = [
    String(quantity),
    ...Object.entries(COUNT_WORDS)
      .filter(([, v]) => v === quantity)
      .map(([w]) => w),
  ].join('|')
  return new RegExp(
    String.raw`(?<![\d.,$])\b(?:${count})\s*(?:x\s*)?(?:[a-z-]+\s+){0,2}?${stem}|${stem}\w*\s*(?:x|×)\s*(?:${count})\b`,
    'i',
  ).test(text)
}
