import { z } from 'zod'
import { addDays, getUpcomingFlows, money } from '../shared/finance.ts'
import { PRODUCTS } from '../shared/seed.ts'
import { plainText } from '../shared/text.ts'
import type {
  ChatMessage,
  FinancialProfile,
  Interpretation,
  InterpretedItem,
  Product,
  Purchase,
  PurchaseContext,
  RememberedItem,
  Transaction,
  PayIn4Eligibility,
} from '../shared/types.ts'
import { dateLabel, groundedPhrase, inWindow, readTiming, validIsoDate } from './dates.ts'
import type { TimingRead } from './dates.ts'
import {
  extractMoneyMentions,
  groundableAmounts,
  hasForeignAmount,
  mentionsOtherCurrency,
  priceMentions,
  quantityStated,
  unclearAmounts,
} from './money.ts'
import type { MoneyMention } from './money.ts'

export interface ChatInput {
  message: string
  history: ChatMessage[]
  context?: PurchaseContext
  /** Items assessed earlier in this conversation, most recent last. */
  items?: RememberedItem[]
  /**
   * Set by focusInput when it moved the conversation to an item the message names: one assessed
   * earlier in this conversation, or a demo-store item at its catalog price.
   */
  focus?: 'remembered' | 'catalog'
}
export interface ChatData {
  profile: FinancialProfile
  purchases: Purchase[]
  transactions: Transaction[]
  today: string
  /**
   * Pay in 4 availability for the purchase being assessed, set only when the user asked about
   * Pay in 4 or paying later. It adds one comparison fact; Pay in 4 is never recommended.
   */
  payIn4?: PayIn4Eligibility
}

export type ClarifyReason =
  | 'price_missing'
  | 'currency'
  | 'date_unresolved'
  | 'date_vague'
  | 'date_past'
  | 'date_window'
  | 'payday_missing'
  | 'alternatives'
  | 'items_unclear'
  | 'amount_unclear'

export type InterpretResult =
  | { ok: true; interpretation: Interpretation }
  | {
      ok: false
      reason: ClarifyReason
      /** True when Claude misread the user's words and may correct its call. */
      retryable: boolean
      /** Specific guidance returned to Claude as the tool error. */
      detail: string
      /** What was understood so far, so the next message can complete it. */
      pending?: PurchaseContext
      /** Dates a stated phrase may mean, when the user must choose. */
      choices?: string[]
    }

/** Claude's `interpret_purchase` tool input. The schema is strict on the API side too. */
export const rawInterpretationSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            name: z.string().max(120),
            amount_cents: z.number().int().min(0).max(100_000_000).nullable(),
            currency: z.string().max(12),
            quantity: z.number().int().min(1).max(100),
          })
          .strict(),
      )
      .max(6),
    combine: z.enum(['single', 'together', 'alternatives']),
    refers_to_previous_item: z.boolean(),
    date_phrase: z.string().max(80).nullable(),
    date: z.string().max(20).nullable(),
    option: z.enum(['check', 'earliest_date', 'max_price']),
  })
  .strict()
export type RawInterpretation = z.infer<typeof rawInterpretationSchema>

/** Item names come from the browser: hidden control and direction characters never reach Claude. */
const itemNameSchema = z.string().max(150).transform(plainText)
const contextSchema = z.object({
  amountCents: z.number().int().min(0).max(100_000_000),
  itemName: itemNameSchema.optional(),
  purchaseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
})
export function validContext(input: ChatInput): PurchaseContext | undefined {
  const parsed = contextSchema.safeParse(input.context)
  return parsed.success ? parsed.data : undefined
}

const GENERIC = new Set([
  'it',
  'this',
  'that',
  'one',
  'item',
  'thing',
  'purchase',
  'your purchase',
  'something',
  'same',
])
const ITEM_STOP = new Set([
  ...GENERIC,
  'a',
  'an',
  'the',
  'my',
  'new',
  'some',
  'anything',
  'stuff',
  'things',
  'today',
  'tomorrow',
  'now',
  'budget',
  'rent',
  'bill',
  'bills',
  'plan',
  'more',
  'less',
  'much',
  'and',
  'or',
  'on',
  'for',
  'at',
  'in',
  'by',
  'next',
  'this',
  'to',
  'with',
  'if',
  'but',
  'is',
  'was',
  'of',
  'each',
  'per',
  'total',
  'all',
  'in',
  'too',
  'then',
  'so',
  'please',
  'still',
  'right',
  'tonight',
  'cash',
])
function words(text: string) {
  return (text.toLowerCase().match(/[a-z][a-z'+-]*/g) ?? []).map((w) =>
    w.replace(/'s$/, '').replace(/(?<=[a-z]{3})(?:es|s)$/, ''),
  )
}
function isGeneric(name: string | undefined) {
  return !name || GENERIC.has(name.trim().toLowerCase())
}
/** Two names describe the same item when their significant words overlap. */
export function sameItem(a: string | undefined, b: string | undefined) {
  if (isGeneric(a) || isGeneric(b)) return true
  const left = words(a!).filter((w) => !ITEM_STOP.has(w))
  const right = new Set(words(b!).filter((w) => !ITEM_STOP.has(w)))
  return left.length === 0 || left.some((w) => right.has(w))
}
/** Keep an item name only when its words come from the user's message or confirmed context. */
export function groundedItemName(name: string, message: string, context?: PurchaseContext) {
  const cleaned = name
    .replace(/[^\p{L}\p{M}\s'&+.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim()
  const source = new Set(words(`${message} ${context?.itemName ?? ''}`))
  const significant = words(cleaned).filter((w) => !ITEM_STOP.has(w))
  if (!significant.length || significant.some((w) => !source.has(w))) return undefined
  return cleaned
}

/** Whether a message names the item being discussed, e.g. "this camera". */
export function mentionsItem(message: string, itemName: string | undefined) {
  if (isGeneric(itemName)) return false
  const text = new Set(words(message))
  return words(itemName!).some((w) => !ITEM_STOP.has(w) && text.has(w))
}

// ---- Whole-name matching ------------------------------------------------------------
// A catalog price, or a price remembered from earlier in the conversation, is used only when the
// message names that item as a whole phrase. "The camera?" names the camera; "a camera bag",
// "a Sony camera" and "a MacBook Air" name other things, so their price is asked for instead.

const stemWord = (w: string) => w.replace(/'s$/, '').replace(/(?<=[a-z]{3})(?:es|s)$/, '')
const PRICE_TOKEN = '<price>'
const BOUNDARY = '<.>'
/** A text's words in order (stemmed), with stated prices and punctuation kept as markers. */
function phraseTokens(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/[’]/g, "'")
      .replace(/(?:\$|\busd\s?)\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m)?\b/g, ` ${PRICE_TOKEN} `)
      .match(/<price>|[a-z0-9][a-z0-9']*|[.,!?;:()"]/g) ?? []
  ).map((token) =>
    token === PRICE_TOKEN
      ? token
      : /^[.,!?;:()"]$/.test(token)
        ? BOUNDARY
        : /^[a-z]/.test(token)
          ? stemWord(token)
          : token,
  )
}
const stemmed = (list: string[]) => new Set(list.map(stemWord))
/** Words that may come right before an item's name without changing which item it is. */
const LEAD_OK = stemmed([
  ...['a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your', 'our', 'their', 'his'],
  ...['her', 'its', 'one', 'same', 'new', 'and', 'or', 'of', 'for', 'on', 'at', 'in', 'to'],
  ...['with', 'about', 'than', 'vs', 'versus', 'from', 'into', 'between', 'like', 'not', 'no'],
  ...['afford', 'buy', 'buying', 'get', 'getting', 'purchase', 'purchasing', 'order', 'grab'],
  ...['want', 'need', 'eyeing', 'considering', 'consider', 'check', 'checking', 'save'],
  ...['saving', 'pay', 'paying', 'split', 'splitting', 'finance', 'financing', 'return', 'go'],
  ...['take', 'pick', 'choose', 'prefer', 'rather', 'try', 'is', 'was', 'are', 'if', 'but'],
  ...['so', 'then', 'also', 'just', 'really', 'still', 'actually', 'maybe', 'instead', 'what'],
  ...['how', 'which', 'back', 'i', 'me', 'we', 'you', 'it', 'either', 'both', 'do', 'does'],
  ...['did', 'can', 'could', 'would', 'should', 'will', 'over', 'larkspur', 'store'],
])
/** Words that may come right after an item's name without making it part of another noun. */
const FOLLOW_OK = stemmed([
  ...['and', 'or', 'but', 'if', 'so', 'then', 'now', 'today', 'tonight', 'tomorrow', 'instead'],
  ...['again', 'too', 'either', 'anyway', 'though', 'also', 'still', 'yet', 'right', 'really'],
  ...['first', 'already', 'just', 'actually', 'is', 'are', 'was', 'were', 'be', 'would', 'will'],
  ...['could', 'should', 'can', 'do', 'does', 'did', 'fit', 'fits', 'work', 'works', 'cost'],
  ...['costs', 'worth', 'for', 'with', 'without', 'on', 'at', 'in', 'by', 'before', 'after'],
  ...['until', 'till', 'from', 'via', 'using', 'through', 'over', 'under', 'this', 'that'],
  ...['next', 'i', "i'm", 'you', 'it', 'we', 'me', 'my', 'vs', 'versus', 'than', 'as', 'like'],
  ...['when', 'where', 'why', 'how', 'what', 'which', 'who', 'outright', 'upfront', 'there'],
  ...['here', 'a', 'an', 'the', 'plus', 'price', 'pay', 'split', 'rn', 'asap', 'soon', 'later'],
  ...['sometime', 'please', 'make', 'go', 'take', 'put', 'push', 'leave', 'end', 'look'],
  ...['seem', 'sound', 'feel', 'hurt', 'affect', 'change', 'compare', 'compared', 'any'],
  ...['together', 'each', 'both', 'all', 'combined', 'well', 'or', 'nor', 'instead'],
  PRICE_TOKEN,
])
const COUNT_LEAD = new Set(['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'])
const TIME_UNIT = stemmed(['day', 'week', 'month', 'year', 'hour'])
const MONTH_WORD = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*$/

/**
 * Each place a text names an item as a whole phrase: an anchor word widened over the item's own
 * name words, with nothing attached before or after that would make it a different item.
 * `counted` marks a phrase with a number in front ("two cameras").
 */
function phraseMentions(tokens: string[], anchors: Set<string>, nameWords: Set<string>) {
  const found: { counted: boolean }[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (!anchors.has(tokens[i]!)) continue
    let start = i
    let end = i
    while (start > 0 && nameWords.has(tokens[start - 1]!)) start--
    while (end < tokens.length - 1 && nameWords.has(tokens[end + 1]!)) end++
    const before = tokens[start - 1]
    const after = tokens[end + 1]
    const counted = before !== undefined && (/^\d+$/.test(before) || COUNT_LEAD.has(before))
    const leadOk = before === undefined || before === BOUNDARY || LEAD_OK.has(before) || counted
    const followOk =
      after === undefined ||
      after === BOUNDARY ||
      FOLLOW_OK.has(after) ||
      TIMING_WORD.test(after) ||
      MONTH_WORD.test(after) ||
      // "the camera 2 weeks from now", but not "AirPods 3".
      (/^\d+$/.test(after) && TIME_UNIT.has(tokens[end + 2] ?? ''))
    if (leadOk && followOk) found.push({ counted })
    i = end
  }
  return found
}
const STOP_STEMMED = stemmed([...ITEM_STOP])
/**
 * Whether a message names an item as a whole phrase ("is the camera still fine?"), not as part of
 * another item's name ("a camera bag"). A counted mention ("two cameras") counts only on request.
 */
export function namesItem(
  message: string,
  itemName: string | undefined,
  options: { counted?: boolean } = {},
) {
  if (isGeneric(itemName)) return false
  const name = phraseTokens(itemName!).filter((t) => t !== BOUNDARY && t !== PRICE_TOKEN)
  const anchors = new Set(name.filter((t) => !STOP_STEMMED.has(t) && !/^\d+$/.test(t)))
  if (!anchors.size) return false
  return phraseMentions(phraseTokens(message), anchors, new Set(name)).some(
    (m) => options.counted || !m.counted,
  )
}
const productWords = new Map(
  PRODUCTS.map((product) => {
    const anchors = new Set((product.aliases ?? []).flatMap(phraseTokens))
    const name = new Set([...phraseTokens(product.name), ...anchors])
    return [product.id, { anchors, name }] as const
  }),
)
/**
 * Demo-store items a text names as a whole phrase ("the camera", "a MacBook", "the MacBook
 * Pro"). A counted mention ("two cameras") is included only on request, where the quantity is
 * checked separately.
 */
export function catalogMentions(text: string, options: { counted?: boolean } = {}): Product[] {
  const tokens = phraseTokens(text)
  return PRODUCTS.filter((product) => {
    const { anchors, name } = productWords.get(product.id)!
    return phraseMentions(tokens, anchors, name).some((m) => options.counted || !m.counted)
  })
}
/**
 * The catalog item an interpreted item names, when the message names it too. Its price is the
 * store's own, so it counts as grounded even though the user wrote no amount (judge fix #3).
 * Both must name the item as a whole: "camera bag" or "Sony camera" is not the store's camera.
 */
export function catalogItemFor(name: string, message: string): Product | undefined {
  const inName = catalogMentions(name, { counted: true })
  const named = catalogMentions(message, { counted: true }).filter((product) =>
    inName.includes(product),
  )
  return named.length === 1 ? named[0] : undefined
}
/** Whether a context is a catalog item at its catalog price, so its chip names the store price. */
function catalogContext(context: PurchaseContext) {
  return PRODUCTS.some(
    (product) => product.name === context.itemName && product.priceCents === context.amountCents,
  )
}

const rememberedSchema = z
  .array(
    z.object({
      amountCents: z.number().int().min(1).max(100_000_000),
      itemName: itemNameSchema.optional(),
    }),
  )
  .max(12)
/**
 * Moves the conversation to the item a message returns to, without a new price: an item assessed
 * earlier in the conversation (most recent first), or else a demo-store item at its catalog price.
 * "Split the camera" after asking about headphones is about the camera again.
 */
export function focusInput(input: ChatInput): ChatInput {
  const message = input.message
  if (priceMentions(extractMoneyMentions(message)).length) return input
  const context = validContext(input)
  if (context && namesItem(message, context.itemName)) return input
  const parsed = rememberedSchema.safeParse(input.items ?? [])
  // A counted mention ("two cameras") keeps its quantity, so it never moves the conversation.
  const remembered = (parsed.success ? parsed.data : [])
    .filter((item) => namesItem(message, item.itemName))
    .reverse()
  const products = catalogMentions(message)
  // Two different remembered items named at once stay a question for the user.
  if (
    remembered.length &&
    remembered.every((item) => sameItem(item.itemName, remembered[0]!.itemName))
  )
    return {
      ...input,
      context: { amountCents: remembered[0]!.amountCents, itemName: remembered[0]!.itemName },
      focus: 'remembered',
    }
  if (!remembered.length && products.length === 1)
    return {
      ...input,
      context: { amountCents: products[0]!.priceCents, itemName: products[0]!.name },
      focus: 'catalog',
    }
  return input
}

const NOT_ITEMS = new Set([
  ...ITEM_STOP,
  'another',
  'different',
  'other',
  'cheaper',
  'than',
  // How to pay is never an item: "Is Pay in 4 cheaper than paying now?"
  'pay',
  'paying',
  'paypal',
  'later',
  'instalment',
  'installment',
  'split',
  'bnpl',
  'week',
  'day',
  'month',
  'year',
  'weekend',
  'fortnight',
  'paycheck',
  'payday',
  'salary',
  'cushion',
  'price',
  'payment',
  'payments',
  'deal',
  'discount',
  'sale',
  'bit',
  'lot',
  'while',
  'card',
  'credit',
  'loan',
  'question',
  'idea',
  'option',
  'chance',
  'way',
  'time',
  'moment',
  'money',
  'room',
  'answer',
  'version',
  'model',
  // Words that judge the purchase ("is that fine"), never an item.
  'fine',
  'okay',
  'ok',
  'good',
  'bad',
  'safe',
  'smart',
  'wise',
  'possible',
  'enough',
  'realistic',
  'reasonable',
  'alright',
  'doable',
])
/** Whether the message names an item other than the one being discussed. */
export function namesOtherItem(message: string, itemName: string | undefined) {
  // The item's word used inside another name ("a camera bag", "a Sony camera") is another item.
  if (mentionsItem(message, itemName) && !namesItem(message, itemName, { counted: true }))
    return true
  const named = new Set<string>()
  const local = localItemName(message)
  if (local) named.add(local)
  for (const m of message.matchAll(
    /\b(?:a|an|the|this|that|some|another|new|different|cheaper)\s+(?:(?:new|different|cheaper|other|used|nicer|smaller|bigger)\s+)?([a-z][\w'-]+)/gi,
  ))
    named.add(m[1]!)
  const context = new Set(words(itemName ?? ''))
  return [...named].some((name) => {
    const significant = words(name).filter((w) => !NOT_ITEMS.has(w))
    return significant.length > 0 && !significant.some((w) => context.has(w))
  })
}

/**
 * Whether the message states an amount that cannot be read as US dollars: a foreign or
 * malformed amount, or another currency named without an amount. An amount marked as
 * spent, saved or a past price is excluded.
 */
function currencyQuestion(message: string, mentions: MoneyMention[]) {
  if (unclearAmounts(mentions).length) return true
  let rest = message
  for (const m of mentions.filter((m) => m.role === 'other')) {
    const from = Math.max(0, m.index - 12)
    const to = Math.min(rest.length, m.index + m.raw.length + 20)
    rest = rest.slice(0, from) + ' '.repeat(to - from) + rest.slice(to)
  }
  return mentionsOtherCurrency(rest)
}

/** A US-dollar or unmarked amount that could not be read, such as "$1 199" or "$11,99". */
function malformedAmount(mentions: MoneyMention[]) {
  return mentions.some((m) => m.role !== 'other' && m.currency !== 'FOREIGN' && m.cents === null)
}

/** Stated prices that no item accounts for, counting repeated amounts separately. */
function unaccounted(prices: { cents: number }[], read: InterpretedItem[]) {
  const total = read.reduce((sum, item) => sum + item.amountCents * item.quantity, 0)
  // A stated total only covers a reading that has more than one unit.
  const combined = read.length > 1 || read.some((item) => item.quantity > 1)
  const left = read.map((item) => item.amountCents)
  return prices.filter((m) => {
    const i = left.indexOf(m.cents)
    if (i >= 0) {
      left.splice(i, 1)
      return false
    }
    return !(combined && m.cents === total)
  })
}

// Timing words end an item name: "a camera mid-October" names the camera.
const TIMING_WORD =
  /^(?:before|after|until|till|by|sometime|soon|later|tmrw|tmr|tmw|mid-?\w*|week|weekend|month|year|fortnight|christmas|xmas|payday|paycheck|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|tonight|yesterday)$/

/** A local guess at the item a message names; used only for labels and new-item detection. */
export function localItemName(message: string) {
  // "a pair of headphones" names the headphones.
  const text = message
    .replace(/[’]/g, "'")
    .replace(/\b(?:a\s+)?(?:pair|set|couple|bunch|box|pack|bundle)\s+of\s+/gi, '')
  const take = (fragment: string | undefined) => {
    if (!fragment) return undefined
    const kept: string[] = []
    for (const word of fragment.split(/\s+/)) {
      const bare = word.toLowerCase().replace(/[^a-z'+-]/g, '')
      if (!bare || ITEM_STOP.has(bare) || TIMING_WORD.test(bare) || /^\d/.test(word)) break
      kept.push(word.replace(/[^\p{L}\p{M}'+-]/gu, ''))
      if (kept.length === 3 || /[?.!,;]$/.test(word)) break
    }
    return kept.length ? kept.join(' ') : undefined
  }
  const counted = text.match(
    /\b(?:\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\s+([a-z][\w'+-]*)\s+(?:at|for|@)\s/i,
  )
  const afterPrices = [
    ...text.matchAll(
      /(?:\$|usd\s?)\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m)?\b\s+((?:[a-z][\w'+-]*\s*){1,3})/gi,
    ),
  ].map((m) => take(m[1]))
  const beforePrice = text.match(
    /\b(?:a|an|the|this|that|my|new|some)\s+((?:new\s+)?[a-z][\w'+-]*(?:\s+[a-z][\w'+-]*)?)\s+(?:for|that|which|at|costing|priced|worth|is|costs)\b/i,
  )
  const object = text.match(
    /\b(?:buy|get|afford|purchase|order|grab)\s+(?:a|an|the|some|this|that|my|those|these)?\s*(?:new\s+)?([a-z][\w'+-]*(?:\s+[a-z][\w'+-]*)?)/i,
  )
  return (
    take(counted?.[1]) ?? afterPrices.find(Boolean) ?? take(beforePrice?.[1]) ?? take(object?.[1])
  )
}

export function nextIncomeDate(data: ChatData) {
  return getUpcomingFlows(data.profile, data.today, 30).find(
    ({ flow }) => flow.kind === 'income' && flow.confirmed,
  )?.date
}

/** Claude's reading of the timing, as reported in the tool call. */
interface ClaudeTiming {
  /** True when Claude reported a timing phrase that appears word for word in the message. */
  grounded: boolean
  phrase: string | null
  date: string | null
}

/**
 * Decide the purchase date. Known phrases are read deterministically; Claude may resolve a
 * phrase this reader does not know. When the two disagree, or the timing is not one day,
 * the user is asked. Without any timing words the purchase is for today (or the date of the
 * purchase being discussed), shown explicitly.
 */
function readDate(
  data: ChatData,
  timing: TimingRead,
  claude: ClaudeTiming | undefined,
  contextDate: string | undefined,
):
  | { date: string; source: Interpretation['dateSource']; phrase?: string }
  | Exclude<InterpretResult, { ok: true }> {
  const end = addDays(data.today, 30)
  const window = `from today through ${dateLabel(end, data.today)}`
  const ask = (
    reason: ClarifyReason,
    detail: string,
    choices?: string[],
  ): Exclude<InterpretResult, { ok: true }> => ({
    ok: false,
    reason,
    retryable: false,
    detail,
    ...(choices?.length ? { choices } : {}),
  })
  const said = [...timing.phrases, ...(claude?.grounded && claude.phrase ? [claude.phrase] : [])]
  const phrase = [...new Set(said.map((p) => p.toLowerCase()))].join(', ')
  if (timing.blocking === 'past')
    return ask('date_past', `The user placed the purchase in the past. Ask for a date ${window}.`)
  if (timing.blocking === 'vague')
    return ask('date_vague', `"${phrase}" is too vague to pick one day. Ask for a date ${window}.`)
  if (timing.blocking === 'invalid')
    return ask(
      'date_unresolved',
      `"${phrase}" is not a valid calendar date. Ask for a date ${window}.`,
    )
  if (timing.blocking === 'payday_missing')
    return ask(
      'payday_missing',
      'The plan has no confirmed upcoming income date, so payday cannot be resolved.',
    )

  const proposed = claude?.date && validIsoDate(claude.date) ? claude.date : null
  let date: string | undefined
  if (!timing.phrases.length) {
    if (!claude?.grounded) {
      // No timing words. A date Claude reports without the user's words is ignored.
      if (contextDate && inWindow(contextDate, data.today))
        return { date: contextDate, source: 'context' }
      return { date: data.today, source: 'default' }
    }
    if (!proposed)
      return ask(
        'date_unresolved',
        `"${phrase}" was not resolved to one day. Ask for a date ${window}.`,
      )
    date = proposed
  } else if (timing.candidates?.length) {
    const candidates = timing.candidates.filter((d) => inWindow(d, data.today))
    if (proposed) {
      if (!timing.candidates.includes(proposed))
        // Claude and the reader disagree: the user decides, neither reading is forced.
        return ask(
          'date_unresolved',
          `"${phrase}" may mean ${[...timing.candidates.slice(0, 3), proposed].join(' or ')}. Ask which day.`,
          [...new Set([...candidates.slice(0, 2), proposed])],
        )
      date = proposed
    } else if (claude?.grounded || timing.unresolved)
      return ask(
        'date_unresolved',
        `"${phrase}" was not resolved to one day. Ask for a date ${window}.`,
        candidates.length <= 3 ? candidates : undefined,
      )
    else if (timing.candidates.length === 1) date = timing.candidates[0]
    else if (timing.preferred) date = timing.preferred
    else
      return ask(
        'date_unresolved',
        `"${phrase}" could mean ${timing.candidates.join(' or ')}. Ask which day.`,
        candidates,
      )
  } else if (timing.candidates === null && proposed && claude?.grounded) {
    // A phrase only Claude could resolve; the server range-checks it and echoes it back.
    date = proposed
  } else
    return ask(
      'date_unresolved',
      `"${phrase}" was not resolved to one day. Ask for a date ${window}.`,
    )
  if (!inWindow(date!, data.today))
    return ask(
      'date_window',
      `${date} is outside the supported window ${data.today} to ${end}. Ask for a date in that range.`,
    )
  return { date: date!, source: 'stated', ...(phrase ? { phrase } : {}) }
}

function interpretation(
  data: ChatData,
  items: InterpretedItem[],
  date: { date: string; source: Interpretation['dateSource']; phrase?: string },
  option: Interpretation['option'],
  source: Interpretation['source'],
  amountSource: NonNullable<Interpretation['amountSource']>,
): Interpretation {
  return {
    items,
    amountCents: items.reduce((sum, item) => sum + item.amountCents * item.quantity, 0),
    currency: 'USD',
    date: date.date,
    dateLabel: dateLabel(date.date, data.today),
    dateSource: date.source,
    ...(date.phrase ? { datePhrase: date.phrase } : {}),
    amountSource,
    option,
    source,
  }
}
/** Where a reading's amount came from, for the answer's trace. */
function amountSourceOf(
  input: ChatInput,
  followUp: boolean,
  items: InterpretedItem[],
): NonNullable<Interpretation['amountSource']> {
  if (followUp) return input.focus === 'catalog' ? 'catalog' : 'context'
  return items.some((item) => item.priceSource === 'catalog') ? 'catalog' : 'stated'
}

// Only an explicit US-dollar reading counts; an unknown or empty currency is asked about.
const USD_CODES = new Set(['USD', 'US$', '$', 'DOLLAR', 'DOLLARS', 'US DOLLARS'])
const describe = (cents: number) => `${money(cents)} (${cents} cents)`

/** Validate Claude's structured reading against the user's own words. */
export function validateInterpretation(
  raw: RawInterpretation,
  input: ChatInput,
  data: ChatData,
): InterpretResult {
  const message = input.message
  const mentions = extractMoneyMentions(message)
  const groundable = groundableAmounts(mentions)
  const prices = priceMentions(mentions)
  const context = validContext(input)
  let items = raw.items.filter((item) => item.name.trim() || item.amount_cents !== null)
  const stated = prices.map((m) => describe(m.cents)).join(', ')
  const pendingName = (name?: string) =>
    name ? groundedItemName(name, message, context) : undefined

  if (raw.combine === 'alternatives' && items.length > 1)
    return {
      ok: false,
      reason: 'alternatives',
      retryable: false,
      detail: 'The user is choosing between items. Ask which one to check.',
    }
  if (malformedAmount(mentions))
    return {
      ok: false,
      reason: 'amount_unclear',
      retryable: false,
      detail: 'An amount in the message could not be read. Ask for the total in USD.',
    }
  if (
    items.some((item) => !USD_CODES.has(item.currency.trim().toUpperCase())) ||
    currencyQuestion(message, mentions)
  )
    return {
      ok: false,
      reason: 'currency',
      retryable: false,
      detail: 'The price is not in US dollars. Ask for the total in USD; never convert it.',
    }

  // A follow-up about the same purchase reuses its confirmed amount; a new item starts fresh.
  const newPrice = prices.some((m) => m.cents !== context?.amountCents)
  const followUp =
    context &&
    (raw.refers_to_previous_item || items.every((item) => isGeneric(item.name))) &&
    items.length <= 1 &&
    !newPrice &&
    !namesOtherItem(message, context.itemName) &&
    (items.length === 0 || sameItem(items[0]!.name, context.itemName)) &&
    (items[0]?.amount_cents ?? context.amountCents) === context.amountCents

  let read: InterpretedItem[]
  if (followUp) {
    read = [
      {
        name:
          context.itemName && !isGeneric(context.itemName)
            ? context.itemName
            : (pendingName(items[0]?.name) ?? 'Your purchase'),
        amountCents: context.amountCents,
        quantity: 1,
        ...(catalogContext(context) ? { priceSource: 'catalog' as const } : {}),
      },
    ]
  } else {
    // A message that names one demo-store item, while Claude reported none, is about that item.
    const named = !items.length && !prices.length ? catalogMentions(message) : []
    if (named.length === 1)
      items = [{ name: named[0]!.aliases![0]!, amount_cents: null, currency: 'USD', quantity: 1 }]
    // A demo-store item named without a price is read at the store's price.
    const catalog = items.map((item) =>
      item.amount_cents === null || !groundable.some((m) => m.cents === item.amount_cents)
        ? catalogItemFor(item.name, message)
        : undefined,
    )
    const unpriced = (item: (typeof items)[number], index: number) =>
      item.amount_cents === null && !catalog[index]
    if (!items.length || items.every(unpriced))
      return prices.length
        ? {
            ok: false,
            reason: 'price_missing',
            retryable: true,
            detail: `The user stated ${stated}. Report the item with that amount_cents, or answer with intent clarify.`,
          }
        : {
            ok: false,
            reason: 'price_missing',
            retryable: false,
            detail: 'The user did not state a price in US dollars. Ask for the total price.',
          }
    read = []
    for (const [index, item] of items.entries()) {
      const product = catalog[index]
      if (product && (item.amount_cents === null || item.amount_cents === product.priceCents)) {
        read.push({
          name: product.name,
          amountCents: product.priceCents,
          // A catalog price is per item, so only the count next to the item has to be written.
          quantity: quantityStated(`${message} each`, item.quantity, item.name) ? item.quantity : 1,
          priceSource: 'catalog',
        })
        continue
      }
      if (item.amount_cents === null)
        return {
          ok: false,
          reason: 'price_missing',
          retryable: false,
          detail: `No price was stated for "${item.name}". Ask for it.`,
        }
      const match = groundable.filter((m) => m.cents === item.amount_cents)
      if (!match.length)
        return {
          ok: false,
          reason: prices.length ? 'items_unclear' : 'price_missing',
          retryable: prices.length > 0,
          detail: prices.length
            ? `amount_cents ${item.amount_cents} is not an amount the user wrote. USD prices in the message: ${stated}. Use the user's exact figure (k means thousand), or answer with intent clarify.`
            : 'The user did not state a USD price. Ask for the total price; never estimate or convert one.',
        }
      if (match.every((m) => m.role === 'budget'))
        return {
          ok: false,
          reason: 'items_unclear',
          retryable: true,
          detail: `${describe(item.amount_cents)} is the user's budget or available money, not a price.${prices.length ? ` Prices the user stated: ${stated}.` : ' Ask for the item price.'}`,
        }
      if (!quantityStated(message, item.quantity, item.name))
        return {
          ok: false,
          reason: 'items_unclear',
          retryable: true,
          detail: `Quantity ${item.quantity} needs a count written next to the item and a price marked as per item (for example "each"). Otherwise the stated price is the total: report quantity 1.`,
        }
      read.push({
        name: pendingName(item.name) ?? localItemName(message) ?? 'Your purchase',
        amountCents: item.amount_cents,
        quantity: item.quantity,
      })
    }
    const missed = unaccounted(prices, read)
    if (missed.length)
      return {
        ok: false,
        reason: 'items_unclear',
        retryable: true,
        detail: `The user also stated ${missed.map((m) => describe(m.cents)).join(', ')}. Include every item bought together, mark alternatives, or answer with intent clarify.`,
      }
  }

  const timing = readTiming(message, data.today, nextIncomeDate(data))
  const date = readDate(
    data,
    timing,
    // Claude's phrase only counts if it is about time and the user wrote it word for word.
    { grounded: groundedPhrase(raw.date_phrase, message), phrase: raw.date_phrase, date: raw.date },
    followUp ? context.purchaseDate : undefined,
  )
  if ('ok' in date) {
    const total = read.reduce((sum, item) => sum + item.amountCents * item.quantity, 0)
    return { ...date, pending: { amountCents: total, itemName: itemLabel(read) } }
  }
  return {
    ok: true,
    interpretation: interpretation(
      data,
      read,
      date,
      raw.option,
      'ai',
      amountSourceOf(input, Boolean(followUp), read),
    ),
  }
}

/** One label for one or more items, e.g. "headphones + chair". */
export function itemLabel(items: InterpretedItem[]) {
  const label = items
    .map((item) => (item.quantity > 1 ? `${item.quantity} × ${item.name}` : item.name))
    .join(' + ')
  return label.length > 60 ? `${label.slice(0, 59)}…` : label || 'Your purchase'
}

const COUNT_WORDS = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const PURCHASE_CUE =
  /\b(?:afford|buy|buying|purchase|get|order|grab|splurge|pay\s+for|spend\s+on|treat\s+myself|worth\s+it|cost|costs|price|priced)\b/i

/** Whether a message is about buying something, for local routing. */
export function looksLikePurchase(input: ChatInput) {
  const mentions = extractMoneyMentions(input.message)
  return (
    priceMentions(mentions).length > 0 ||
    hasForeignAmount(mentions) ||
    (PURCHASE_CUE.test(input.message) &&
      Boolean(localItemName(input.message) || validContext(input)))
  )
}

/**
 * Deterministic reading for local mode. It assesses only when the price, currency and
 * date are unambiguous; anything else becomes a clarifying question.
 */
export function localInterpretation(input: ChatInput, data: ChatData): InterpretResult {
  const message = input.message
  const mentions = extractMoneyMentions(message)
  const prices = priceMentions(mentions)
  const context = validContext(input)
  const named = localItemName(message)
  const followUp =
    context &&
    prices.every((m) => m.cents === context.amountCents) &&
    sameItem(named, context.itemName) &&
    !namesOtherItem(message, context.itemName)
  if (malformedAmount(mentions))
    return {
      ok: false,
      reason: 'amount_unclear',
      retryable: false,
      detail: 'An amount could not be read.',
    }
  if (currencyQuestion(message, mentions))
    return {
      ok: false,
      reason: 'currency',
      retryable: false,
      detail: 'An amount is not in US dollars.',
    }
  // Every stated price counts, including a repeated amount for a second item.
  if (prices.length > 1 && !(followUp && prices.length === 1))
    return {
      ok: false,
      reason: / or /i.test(message) ? 'alternatives' : 'items_unclear',
      retryable: false,
      detail: 'More than one amount was stated.',
    }
  let item: InterpretedItem
  const products = catalogMentions(message)
  if (followUp) {
    item = {
      name:
        context.itemName && !isGeneric(context.itemName)
          ? context.itemName
          : (named ?? 'Your purchase'),
      amountCents: context.amountCents,
      quantity: 1,
      ...(catalogContext(context) ? { priceSource: 'catalog' as const } : {}),
    }
  } else if (!prices.length && products.length === 1) {
    // A demo-store item named without a price is read at the store's price.
    item = {
      name: products[0]!.name,
      amountCents: products[0]!.priceCents,
      quantity: 1,
      priceSource: 'catalog',
    }
  } else if (prices.length === 1) {
    const each = message.match(
      /\b(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\s+[a-z][\w'-]*\s+(?:at|for|@)\s+\S+\s+(?:each|apiece|a\s+piece|per\s+(?:item|piece|unit))\b/i,
    )?.[1]
    const quantity = each ? Number(each) || COUNT_WORDS.indexOf(each.toLowerCase()) + 2 : 1
    item = { name: named ?? 'Your purchase', amountCents: prices[0]!.cents, quantity }
  } else
    return {
      ok: false,
      reason: 'price_missing',
      retryable: false,
      detail: 'No USD price was stated.',
    }
  const timing = readTiming(message, data.today, nextIncomeDate(data))
  const date = readDate(data, timing, undefined, followUp ? context.purchaseDate : undefined)
  if ('ok' in date)
    return {
      ...date,
      pending: { amountCents: item.amountCents * item.quantity, itemName: item.name },
    }
  const option: Interpretation['option'] = /\b(?:when|how soon|earliest)\b/i.test(message)
    ? 'earliest_date'
    : 'check'
  return {
    ok: true,
    interpretation: interpretation(
      data,
      [item],
      date,
      option,
      'local',
      amountSourceOf(input, Boolean(followUp), [item]),
    ),
  }
}

/** The deterministic clarifying question for a reason. */
export function clarificationText(
  result: Exclude<InterpretResult, { ok: true }>,
  data: ChatData,
): string {
  const end = dateLabel(addDays(data.today, 30), data.today)
  const item =
    result.pending?.itemName && !isGeneric(result.pending.itemName)
      ? `the ${result.pending.itemName}`
      : 'it'
  switch (result.reason) {
    case 'currency':
      return 'I can only plan in US dollars, and I won’t guess an exchange rate. What is the total in USD, including tax, shipping and any conversion fees?'
    case 'price_missing':
      return 'What is the total price in US dollars, including tax and shipping?'
    case 'alternatives':
      return 'Which one should I check? Tell me the item and its price, or say if you plan to buy them together.'
    case 'amount_unclear':
      return 'I couldn’t read one of the amounts. What is the total price in US dollars, written like $1,199.00?'
    case 'items_unclear':
      return 'I see more than one amount. Which total should I check, and are you buying these together?'
    case 'payday_missing':
      return 'I need a confirmed upcoming payday to use that. Add your income to your plan, or tell me the day you would buy it.'
    case 'date_past':
      return `That timing has already passed. Which day would you buy ${item}? I can check any day from today through ${end}.`
    case 'date_window':
      return `I can check purchase dates from today through ${end}. Which day in that range would you buy ${item}?`
    case 'date_vague':
    case 'date_unresolved':
      if (result.choices && result.choices.length > 1 && result.choices.length <= 3)
        return `Which day do you mean: ${result.choices.map((d) => dateLabel(d, data.today)).join(' or ')}?`
      return `Which day would you buy ${item}? Pick a day from today through ${end}, for example “tomorrow”, “next Friday” or “Oct 16”.`
  }
}
