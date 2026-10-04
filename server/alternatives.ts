import { assessPurchase } from '../shared/finance.ts'
import { PRODUCTS } from '../shared/seed.ts'
import type { FinancialProfile, Product, Purchase } from '../shared/types.ts'

/**
 * What Worth searches other stores for. Catalog items use a fixed generic description, never the
 * demo store's name or a brand; anything else is reduced to a few plain words.
 */
export const CATALOG_QUERIES: Record<string, string> = {
  camera: 'interchangeable lens camera',
  headphones: 'over-ear headphones',
  chair: 'desk chair',
  backpack: 'travel backpack',
}

/** Widely known brand names, left out of searches built from the user's own words. */
const BRANDS = new Set(
  (
    'apple iphone ipad macbook airpods sony canon nikon fujifilm fuji panasonic lumix olympus leica ' +
    'gopro dji samsung galaxy google pixel microsoft surface xbox playstation nintendo switch bose ' +
    'sennheiser beats jbl sonos dyson lg dell hp lenovo asus acer razer logitech ikea herman miller ' +
    'steelcase nike adidas puma reebok patagonia north face lululemon peloton kitchenaid vitamix ' +
    'instant pot amazon kindle echo fitbit garmin oneplus xiaomi huawei tesla rolex gucci prada'
  ).split(' '),
)
const FILLER = new Set(
  (
    'a an the my me i it its this that these those what which new some any another other cheaper ' +
    'cheapest cheap similar same kind sort type of for to buy get one thing things item items stuff ' +
    'something anything under below less than more but keeps keep cushion today store instead'
  ).split(' '),
)

/**
 * A short, generic search phrase from free text: lowercase letters only, no brands, model numbers,
 * prices or filler, at most four words. Undefined when nothing generic is left.
 */
export function genericQuery(text: string | undefined): string | undefined {
  if (!text) return undefined
  const words = text
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .split(/[^a-z0-9-]+/)
    .filter((word) => word.length > 1 && !/\d/.test(word) && !BRANDS.has(word) && !FILLER.has(word))
    .map((word) => word.replace(/^-+|-+$/g, ''))
    .filter(Boolean)
  const phrase = [...new Set(words)].slice(0, 4).join(' ')
  return phrase.length >= 3 ? phrase : undefined
}

const words = (text: string) => new Set(text.toLowerCase().match(/[a-z]{3,}/g) ?? [])
/**
 * The catalog item a name refers to when every generic word in it belongs to that item's name:
 * "camera" and "a new camera" are the Everyday camera; "camera bag" is not.
 */
export function catalogItem(name: string | undefined): Product | undefined {
  const said = [...words(genericQuery(name)?.replace(/s\b/g, '') ?? '')]
  if (!said.length) return undefined
  return PRODUCTS.find((product) => {
    const own = words(product.name.replace(/s\b/gi, ''))
    return said.every((word) => own.has(word))
  })
}

const NAMED =
  /\b(?:cheaper|cheapest|less expensive|lower[- ]priced|more affordable|similar|another|budget)\s+([a-z][a-z -]{2,40}?)(?=\s+(?:than|under|below|for|that|which|to|i|with|from|in|at|on|but)\b|[?.!,]|$)/i
/**
 * The kind of item a request for something cheaper names, read locally: a catalog item ("a
 * cheaper camera") or the words after "cheaper" or "similar". Undefined when none is named.
 */
export function mentionedItem(message: string): string | undefined {
  const said = words(message.replace(/s\b/gi, ''))
  const product = PRODUCTS.find((p) =>
    [...words(p.name.replace(/s\b/gi, ''))].some(
      (word) => !NAME_ADJECTIVES.has(word) && said.has(word),
    ),
  )
  if (product) return product.name
  const named = message.match(NAMED)?.[1]
  return genericQuery(named) ? named : undefined
}
const NAME_ADJECTIVES = new Set(['everyday', 'studio', 'desk', 'travel'])

/** The search phrase for an item: the catalog's generic description, or the generic words. */
export function queryFor(item: { productId?: string; itemName?: string }): string | undefined {
  const product = item.productId
    ? PRODUCTS.find((p) => p.id === item.productId)
    : catalogItem(item.itemName)
  if (product) return CATALOG_QUERIES[product.id]
  return genericQuery(item.itemName)
}

/**
 * The person asked for something cheaper or similar for less: "something cheaper", "what can I buy
 * under $300", "the cheapest thing that keeps my cushion", "similar but less", "a cheaper camera".
 */
export const ALTERNATIVES_CUE =
  /\b(?:cheaper|cheapest|less expensive|lower[- ]priced|more affordable|budget (?:version|option|alternative)s?|alternatives?|similar\b[^.?!]{0,30}\b(?:less|cheaper|under|lower)|what (?:else )?(?:can|could) i (?:buy|get|afford) (?:for |with )?(?:under|below|for less than|up to)|(?:anything|something|items?|things?) (?:under|below|for less than)\s*\$)/i

/**
 * The most that can be spent today while keeping the cushion: the Spend less amount. Zero while
 * the plan is missing information, so nothing is searched for on an incomplete plan.
 */
export function roomToday(profile: FinancialProfile, purchases: Purchase[], today: string) {
  const base = assessPurchase(profile, purchases, { amountCents: 0, today, findEarliest: false })
  return base.outcome === 'incomplete' ? 0 : base.maxAffordableCents
}
