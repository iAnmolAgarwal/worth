import { z } from 'zod'
import { addDays, getUpcomingFlows, money } from '../shared/finance.ts'
import type {
  ChatMessage,
  FinancialProfile,
  Interpretation,
  InterpretedItem,
  Purchase,
  PurchaseContext,
  Transaction,
} from '../shared/types.ts'
import { dateLabel, inWindow, readTiming, validIsoDate } from './dates.ts'
import type { TimingRead } from './dates.ts'
import {
  extractMoneyMentions,
  groundableAmounts,
  hasForeignAmount,
  priceMentions,
  quantityStated,
} from './money.ts'

export interface ChatInput {
  message: string
  history: ChatMessage[]
  context?: PurchaseContext
}
export interface ChatData {
  profile: FinancialProfile
  purchases: Purchase[]
  transactions: Transaction[]
  today: string
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

const contextSchema = z.object({
  amountCents: z.number().int().min(0).max(100_000_000),
  itemName: z.string().max(150).optional(),
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

/** A local guess at the item a message names; used only for labels and new-item detection. */
export function localItemName(message: string) {
  const text = message.replace(/[’]/g, "'")
  const take = (fragment: string | undefined) => {
    if (!fragment) return undefined
    const kept: string[] = []
    for (const word of fragment.split(/\s+/)) {
      const bare = word.toLowerCase().replace(/[^a-z'+-]/g, '')
      if (!bare || ITEM_STOP.has(bare) || /^\d/.test(word)) break
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

function readDate(
  data: ChatData,
  timing: TimingRead,
  proposed: string | null,
  contextDate: string | undefined,
): { date: string; source: Interpretation['dateSource'] } | Exclude<InterpretResult, { ok: true }> {
  const end = addDays(data.today, 30)
  const window = `from today through ${dateLabel(end, data.today)}`
  if (timing.blocking === 'past')
    return {
      ok: false,
      reason: 'date_past',
      retryable: false,
      detail: `The user named a past date. Ask for a purchase date ${window}.`,
    }
  if (timing.blocking === 'vague')
    return {
      ok: false,
      reason: 'date_vague',
      retryable: false,
      detail: `The timing "${timing.phrases.join(', ')}" is too vague to pick one day. Ask for a date ${window}.`,
    }
  if (timing.blocking === 'invalid')
    return {
      ok: false,
      reason: 'date_unresolved',
      retryable: false,
      detail: `"${timing.phrases.join(', ')}" is not a valid calendar date. Ask for a date ${window}.`,
    }
  if (timing.blocking === 'payday_missing')
    return {
      ok: false,
      reason: 'payday_missing',
      retryable: false,
      detail: 'The plan has no confirmed upcoming income date, so payday cannot be resolved.',
    }
  let date: string | undefined
  if (!timing.phrases.length) {
    if (contextDate && inWindow(contextDate, data.today))
      return { date: contextDate, source: 'context' }
    return { date: data.today, source: 'default' }
  }
  if (timing.candidates?.length) {
    if (proposed && timing.candidates.includes(proposed)) date = proposed
    else if (proposed && validIsoDate(proposed))
      return {
        ok: false,
        reason: 'date_unresolved',
        retryable: true,
        detail: `The user's timing "${timing.phrases.join(', ')}" means ${timing.candidates.join(' or ')}, not ${proposed}. Use one of those dates, or answer with intent clarify.`,
        choices: timing.candidates,
      }
    else if (timing.candidates.length === 1) date = timing.candidates[0]
    else if (timing.preferred) date = timing.preferred
    else
      return {
        ok: false,
        reason: 'date_unresolved',
        retryable: false,
        detail: `"${timing.phrases.join(', ')}" could mean ${timing.candidates.join(' or ')}. Ask which date.`,
        choices: timing.candidates.filter((d) => inWindow(d, data.today)),
      }
  } else if (timing.candidates === null && proposed && validIsoDate(proposed)) {
    // A phrase only Claude could resolve; the server range-checks and echoes it.
    date = proposed
  } else
    return {
      ok: false,
      reason: 'date_unresolved',
      retryable: false,
      detail: `The timing "${timing.phrases.join(', ')}" was not resolved to one date. Ask for a date ${window}.`,
    }
  if (!inWindow(date!, data.today))
    return {
      ok: false,
      reason: 'date_window',
      retryable: false,
      detail: `${date} is outside the supported window ${data.today} to ${end}. Ask for a date in that range.`,
    }
  return { date: date!, source: 'stated' }
}

function interpretation(
  data: ChatData,
  items: InterpretedItem[],
  date: { date: string; source: Interpretation['dateSource'] },
  option: Interpretation['option'],
  source: Interpretation['source'],
): Interpretation {
  return {
    items,
    amountCents: items.reduce((sum, item) => sum + item.amountCents * item.quantity, 0),
    currency: 'USD',
    date: date.date,
    dateLabel: dateLabel(date.date, data.today),
    dateSource: date.source,
    option,
    source,
  }
}

const USD_CODES = new Set(['USD', 'US$', '$', 'DOLLAR', 'DOLLARS', 'US DOLLARS', 'UNKNOWN', ''])
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
  const items = raw.items.filter((item) => item.name.trim() || item.amount_cents !== null)
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
  if (
    items.some((item) => !USD_CODES.has(item.currency.trim().toUpperCase())) ||
    (hasForeignAmount(mentions) && !prices.length)
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
      },
    ]
  } else {
    if (!items.length || items.every((item) => item.amount_cents === null))
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
    for (const item of items) {
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
      if (!quantityStated(message, item.quantity))
        return {
          ok: false,
          reason: 'items_unclear',
          retryable: true,
          detail: `The user did not state a quantity of ${item.quantity}. Use quantity 1 unless they wrote a count.`,
        }
      read.push({
        name: pendingName(item.name) ?? localItemName(message) ?? 'Your purchase',
        amountCents: item.amount_cents,
        quantity: item.quantity,
      })
    }
    const used = new Set(read.map((item) => item.amountCents))
    const total = read.reduce((sum, item) => sum + item.amountCents * item.quantity, 0)
    const missed = prices.filter((m) => !used.has(m.cents) && m.cents !== total)
    if (missed.length)
      return {
        ok: false,
        reason: 'items_unclear',
        retryable: true,
        detail: `The user also stated ${missed.map((m) => describe(m.cents)).join(', ')}. Include every item bought together, mark alternatives, or answer with intent clarify.`,
      }
  }

  const timing = readTiming(message, data.today, nextIncomeDate(data))
  // Claude's phrase only counts if the user actually wrote it.
  const claimedPhrase =
    raw.date_phrase && message.toLowerCase().includes(raw.date_phrase.trim().toLowerCase())
  const effective =
    !timing.phrases.length && claimedPhrase && raw.date && raw.date !== data.today
      ? { ...timing, phrases: [raw.date_phrase!], unresolved: true }
      : timing
  const date = readDate(data, effective, raw.date, followUp ? context.purchaseDate : undefined)
  if ('ok' in date) {
    const total = read.reduce((sum, item) => sum + item.amountCents * item.quantity, 0)
    return { ...date, pending: { amountCents: total, itemName: itemLabel(read) } }
  }
  return { ok: true, interpretation: interpretation(data, read, date, raw.option, 'ai') }
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
  const amounts = [...new Set(prices.map((m) => m.cents))]
  const followUp =
    context &&
    amounts.every((cents) => cents === context.amountCents) &&
    sameItem(named, context.itemName)
  if (hasForeignAmount(mentions) && !amounts.length)
    return {
      ok: false,
      reason: 'currency',
      retryable: false,
      detail: 'The price is not in US dollars.',
    }
  if (amounts.length > 1)
    return {
      ok: false,
      reason: / or /i.test(message) ? 'alternatives' : 'items_unclear',
      retryable: false,
      detail: 'More than one amount was stated.',
    }
  let item: InterpretedItem
  if (followUp) {
    item = {
      name:
        context.itemName && !isGeneric(context.itemName)
          ? context.itemName
          : (named ?? 'Your purchase'),
      amountCents: context.amountCents,
      quantity: 1,
    }
  } else if (amounts.length === 1) {
    const each = message.match(
      /\b(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\s+[a-z][\w'-]*\s+(?:at|for|@)\s+\S+\s+(?:each|apiece|a\s+piece|per\s+(?:item|piece|unit))\b/i,
    )?.[1]
    const quantity = each ? Number(each) || COUNT_WORDS.indexOf(each.toLowerCase()) + 2 : 1
    item = { name: named ?? 'Your purchase', amountCents: amounts[0]!, quantity }
  } else
    return {
      ok: false,
      reason: 'price_missing',
      retryable: false,
      detail: 'No USD price was stated.',
    }
  const timing = readTiming(message, data.today, nextIncomeDate(data))
  const date = readDate(data, timing, null, followUp ? context.purchaseDate : undefined)
  if ('ok' in date)
    return {
      ...date,
      pending: { amountCents: item.amountCents * item.quantity, itemName: item.name },
    }
  const option: Interpretation['option'] = /\b(?:when|how soon|earliest)\b/i.test(message)
    ? 'earliest_date'
    : 'check'
  return { ok: true, interpretation: interpretation(data, [item], date, option, 'local') }
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
      return 'What is the total price in US dollars, including tax and shipping? For example: “Can I buy a $900 camera today?”'
    case 'alternatives':
      return 'Which one should I check? Tell me the item and its price, or say if you plan to buy them together.'
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
