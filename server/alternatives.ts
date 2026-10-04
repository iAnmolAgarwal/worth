import { assessPurchase } from '../shared/finance.ts'
import { PRODUCTS } from '../shared/seed.ts'
import type { FinancialProfile, Purchase } from '../shared/types.ts'

/**
 * What Worth searches other stores for. Catalog items use a fixed generic description, never the
 * demo store's name or a brand.
 */
export const CATALOG_QUERIES: Record<string, string> = {
  camera: 'interchangeable lens camera',
  headphones: 'over-ear headphones',
  chair: 'desk chair',
  backpack: 'travel backpack',
}
/** A bare category that is a catalog item searches with that item's description. */
const CATALOG_BY_NOUN: Record<string, string> = {
  camera: CATALOG_QUERIES.camera!,
  headphones: CATALOG_QUERIES.headphones!,
  chair: CATALOG_QUERIES.chair!,
  backpack: CATALOG_QUERIES.backpack!,
}

/**
 * The only words a search can be built from: plain kinds of product, each mapped to the phrase sent.
 * Anything else the person wrote (names, brands, models, health or relationship details) is never
 * sent; with no listed kind of product, nothing is searched for at all.
 */
const CATEGORIES: Record<string, string> = Object.fromEntries(
  (
    [
      ['camera cameras', 'camera'],
      ['lens lenses', 'camera lens'],
      ['headphones headphone earbuds earphones headset', 'headphones'],
      ['speaker speakers', 'speaker'],
      ['chair chairs', 'chair'],
      ['desk desks', 'desk'],
      ['sofa sofas couch couches', 'sofa'],
      ['table tables', 'table'],
      ['lamp lamps', 'lamp'],
      ['mattress mattresses', 'mattress'],
      ['bookshelf bookshelves bookcase', 'bookshelf'],
      ['backpack backpacks', 'backpack'],
      ['bag bags', 'bag'],
      ['suitcase suitcases luggage', 'suitcase'],
      ['laptop laptops notebook', 'laptop'],
      ['tablet tablets', 'tablet'],
      ['phone phones smartphone smartphones', 'smartphone'],
      ['monitor monitors', 'monitor'],
      ['keyboard keyboards', 'keyboard'],
      ['printer printers', 'printer'],
      ['tv tvs television televisions', 'television'],
      ['console consoles', 'game console'],
      ['watch watches smartwatch', 'watch'],
      ['jacket jackets coat coats', 'jacket'],
      ['shoes sneakers boots trainers', 'shoes'],
      ['sweater sweaters', 'sweater'],
      ['jeans', 'jeans'],
      ['bike bikes bicycle bicycles', 'bicycle'],
      ['tent tents', 'tent'],
      ['blender blenders', 'blender'],
      ['kettle kettles', 'kettle'],
      ['vacuum vacuums', 'vacuum cleaner'],
      ['stroller strollers', 'stroller'],
      ['ring rings', 'ring'],
      ['necklace necklaces', 'necklace'],
    ] as const
  ).flatMap(([words, query]) => words.split(' ').map((word) => [word, query])),
)
/** Generic words that may stay in front of a kind of product: "office chair", "running shoes". */
const MODIFIERS = new Set(
  (
    'office standing gaming ergonomic mirrorless digital instant wireless bluetooth over-ear ' +
    'noise-cancelling running hiking walking winter rain leather wool travel electric smart ' +
    'portable compact kids lounge dining coffee side floor desk carry-on camera laptop'
  ).split(' '),
)
/** "phone plan", "phone case": the word names something else, so it is not that product. */
const NOT_THE_PRODUCT = new Set(
  'plan plans bill bills service contract insurance case cover repair charger strap battery subscription'.split(
    ' ',
  ),
)

/**
 * The search phrase for free text, from the category allowlist only: the last listed kind of
 * product, with one listed modifier in front of it. Undefined when no kind of product is named.
 */
export function categoryOf(text: string | undefined): string | undefined {
  if (!text) return undefined
  const tokens = text
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .split(/[^a-z-]+/)
    .filter(Boolean)
  for (let i = tokens.length - 1; i >= 0; i--) {
    const query = CATEGORIES[tokens[i]!]
    if (!query || NOT_THE_PRODUCT.has(tokens[i + 1] ?? '')) continue
    const before = tokens[i - 1]
    const modifier = before && MODIFIERS.has(before) && !query.includes(before) ? before : ''
    if (!modifier && CATALOG_BY_NOUN[query]) return CATALOG_BY_NOUN[query]
    return modifier ? `${modifier} ${query}` : query
  }
  return undefined
}

/** The search phrase for an item: the catalog's description, or a listed category, or nothing. */
export function queryFor(item: { productId?: string; itemName?: string }): string | undefined {
  if (item.productId) return CATALOG_QUERIES[item.productId]
  const name = item.itemName?.trim()
  const product = PRODUCTS.find((p) => p.name.toLowerCase() === name?.toLowerCase())
  return product ? CATALOG_QUERIES[product.id] : categoryOf(name)
}

/** Words that ask for something cheaper or similar for less. */
export const ALTERNATIVES_CUE =
  /\b(?:cheaper|cheapest|less expensive|lower[- ]priced|more affordable|budget (?:version|option|alternative)s?|alternatives?|similar\b[^.?!]{0,30}\b(?:less|cheaper|under|lower)|what (?:else )?(?:can|could) i (?:buy|get|afford) (?:for |with )?(?:under|below|for less than|up to)|(?:anything|something|items?|things?) (?:under|below|for less than)\s*\$|(?:find|show me|search for|look for|any)\b[^.?!]{0,40}\b(?:under|below|for less than)\s*\$)/i
/**
 * Questions that use "cheaper" about paying, timing or the plan, never about another product: "Is
 * Pay in 4 cheaper than paying now?", "Is it cheaper to wait?", "Which option is cheapest?", "a
 * cheaper phone plan".
 */
const NOT_ALTERNATIVES =
  /\bpay\s*(?:in\s*(?:4|four)|later|over time)\b|\binstal+ments?\b|\bbnpl\b|\bfinanc\w*|\bwait(?:ing|ed)?\b|\blater\b|\bnext (?:week|month|year)\b|\bpay ?(?:check|day)s?\b|\boptions?\b|\bplans?\b|\bbills?\b|\bsubscriptions?\b|\b(?:cheaper|cheapest|less expensive)\s+(?:than|to|if|when|by)\b|\b(?:paying|buy(?:ing)?) (?:it )?now\b/i
/** A question that uses "cheaper" about paying, timing, the options or a service. */
export const notProductSearch = (message: string) => NOT_ALTERNATIVES.test(message)
/** A thing to find: a product, or a general object such as "something" or "what can I buy". */
const GENERIC_OBJECT =
  /\b(?:something|anything|things?|items?|stuff|ones?|alternatives?|similar|what (?:else )?(?:can|could) i (?:buy|get|afford))\b/i

/**
 * The person asked for a cheaper or similar product: "something cheaper", "what can I buy under
 * $300", "the cheapest thing that keeps my cushion", "similar but less", "a cheaper camera". Never
 * questions about Pay in 4, waiting, the options or a plan, or a cheaper service like flights.
 */
export function wantsAlternatives(message: string) {
  return (
    ALTERNATIVES_CUE.test(message) &&
    !NOT_ALTERNATIVES.test(message) &&
    (categoryOf(message) !== undefined || GENERIC_OBJECT.test(message))
  )
}

/**
 * The most that can be spent today while keeping the cushion: the Spend less amount. Zero while
 * the plan is missing information, so nothing is searched for on an incomplete plan.
 */
export function roomToday(profile: FinancialProfile, purchases: Purchase[], today: string) {
  const base = assessPurchase(profile, purchases, { amountCents: 0, today, findEarliest: false })
  return base.outcome === 'incomplete' ? 0 : base.maxAffordableCents
}

/** Categories offered as one-tap searches when a cheaper request names no kind of item. */
export const SUGGESTED_CATEGORIES = ['Headphones', 'Desk chairs', 'Backpacks', 'Cameras']
