import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { addDays, WAIT_SEARCH_DAYS } from '../shared/finance.ts'
import { PRODUCTS } from '../shared/seed.ts'
import type { FinancialProfile, Purchase, SavedItem } from '../shared/types.ts'
import type { SessionData } from './store.ts'

/** Saved items one session may keep at once. */
export const MAX_SAVED = 20
/** Removed items kept as tombstones: the record that the user removed them. */
const MAX_REMOVED = 20
export const ASSESSMENT_ONLY = 'Assessment only — not sold in the demo store'

export class SavedError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T12:00:00Z`)
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
  }, 'Use a valid calendar date')
const option = z.enum(['buyToday', 'wait', 'spendLess'])
// Labels must be plain text before they are shown or sent anywhere: no control characters,
// zero-width marks or bidirectional overrides that could disguise a name.
// oxlint-disable-next-line no-control-regex
const NOT_PLAIN = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/
const plain = (value: string) => !NOT_PLAIN.test(value)
const catalogSave = z
  .object({
    kind: z.literal('catalog'),
    productId: z.string().min(1).max(100),
    option: option.optional(),
    waitDate: isoDate.optional(),
  })
  .strict()
/**
 * A custom item comes from an Ask Worth assessment (name and amount) or, later, a retailer listing
 * (retailer and link). It is never sold or checked out here.
 */
const customSave = z
  .object({
    kind: z.literal('custom'),
    name: z.string().trim().min(1).max(120).refine(plain, 'Use a plain-text name'),
    amountCents: z.number().int().min(1).max(100_000_000),
    option: option.optional(),
    waitDate: isoDate.optional(),
    retailer: z.string().trim().min(1).max(80).refine(plain, 'Use a plain-text name').optional(),
    url: z
      .string()
      .max(500)
      .url()
      .refine((value) => value.startsWith('https://'), 'Use an https link')
      .optional(),
  })
  .strict()
export const saveSchema = z
  .discriminatedUnion('kind', [catalogSave, customSave])
  .refine(
    (input) => !input.waitDate || (input.option ?? 'wait') === 'wait',
    'A plan date belongs to the wait option.',
  )
export type SaveInput = z.infer<typeof saveSchema>
/** The browser's old per-device wait dates (`worth:planned`), sent once to move them here. */
export const plannedSchema = z
  .object({
    planned: z.record(z.string().max(100), z.unknown()),
  })
  .strict()
  .refine((input) => Object.keys(input.planned).length <= 50, 'Too many planned items.')

/** The session's saved items, created from an older session's catalog wishlist on first use. */
export function savedOf(data: SessionData, now: Date): SavedItem[] {
  if (!data.saved)
    data.saved = (data.wishlist ?? [])
      .filter((productId) => PRODUCTS.some((p) => p.id === productId))
      .map((productId) => catalogItem(productId, now))
  return data.saved
}

function catalogItem(productId: string, now: Date): SavedItem {
  const product = PRODUCTS.find((p) => p.id === productId)!
  return {
    id: randomUUID(),
    kind: 'catalog',
    productId,
    name: product.name,
    amountCents: product.priceCents,
    createdAt: now.toISOString(),
    status: 'active',
  }
}

/**
 * Saved items as the browser sees them, newest first: a wait plan whose day has come is `ready`,
 * and a catalog item bought after it was saved is `bought`. Removed items are left out.
 */
export function publicSaved(
  items: SavedItem[] | undefined,
  today: string,
  purchases: Purchase[],
): SavedItem[] {
  return (
    (items ?? [])
      .filter((item) => item.status !== 'removed')
      .map((item): SavedItem => {
        const bought =
          item.kind === 'catalog' &&
          purchases.some(
            (p) =>
              p.productId === item.productId &&
              p.status === 'completed' &&
              !p.archived &&
              (p.completedAt ?? p.createdAt) >= item.createdAt,
          )
        if (bought) return { ...item, status: 'bought' }
        if (item.waitDate && item.waitDate <= today) return { ...item, status: 'ready' }
        return { ...item, status: 'active' }
      })
      .map((item, index) => ({ item, index }))
      // Newest first; items saved in the same instant keep their saving order, latest first.
      .sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt) || b.index - a.index)
      .map(({ item }) => item)
  )
}

/** Catalog product IDs in Saved, for the older wishlist field. */
export function wishlistOf(items: SavedItem[]) {
  return items.filter((item) => item.kind === 'catalog').map((item) => item.productId!)
}

function checkDate(waitDate: string | undefined, today: string) {
  if (waitDate && (waitDate < today || waitDate > addDays(today, WAIT_SEARCH_DAYS)))
    throw new SavedError(
      400,
      'Choose a plan date from today through 30 days ahead.',
      'INVALID_DATE',
    )
}

function prune(items: SavedItem[]) {
  const removed = items.filter((item) => item.status === 'removed')
  if (removed.length <= MAX_REMOVED) return items
  const drop = new Set(removed.slice(0, removed.length - MAX_REMOVED).map((item) => item.id))
  return items.filter((item) => !drop.has(item.id))
}

/**
 * Saves an item, or updates the same item's option and plan date. A catalog item's name and price
 * always come from the server catalog; a custom item keeps the assessed name and amount.
 */
export function addSaved(data: SessionData, input: SaveInput, today: string, now: Date) {
  const items = savedOf(data, now)
  checkDate(input.waitDate, today)
  const plan = {
    ...(input.waitDate ? { option: 'wait' as const, waitDate: input.waitDate } : {}),
    ...(input.option && !input.waitDate ? { option: input.option } : {}),
  }
  let item: SavedItem
  if (input.kind === 'catalog') {
    if (!PRODUCTS.some((p) => p.id === input.productId))
      throw new SavedError(404, 'Product not found.', 'NOT_FOUND')
    item = { ...catalogItem(input.productId, now), ...plan }
  } else
    item = {
      id: randomUUID(),
      kind: 'custom',
      name: input.name,
      amountCents: input.amountCents,
      createdAt: now.toISOString(),
      status: 'active',
      ...(input.retailer ? { retailer: input.retailer } : {}),
      ...(input.url ? { url: input.url } : {}),
      ...plan,
    }
  const same = items.find(
    (existing) =>
      existing.status !== 'removed' &&
      existing.kind === item.kind &&
      (item.kind === 'catalog'
        ? existing.productId === item.productId
        : existing.name.toLowerCase() === item.name.toLowerCase() &&
          existing.amountCents === item.amountCents &&
          existing.url === item.url),
  )
  if (same) {
    // Saving again replaces the plan: a later "Save for later" clears an earlier date.
    const { option: _o, waitDate: _w, ...rest } = same
    Object.assign(same, { ...rest, ...plan, status: 'active', createdAt: item.createdAt })
    if (!plan.option) delete same.option
    if (!plan.waitDate) delete same.waitDate
    return same
  }
  if (items.filter((existing) => existing.status !== 'removed').length >= MAX_SAVED)
    throw new SavedError(
      409,
      `Saved holds up to ${MAX_SAVED} items. Remove one to save another.`,
      'SAVED_LIMIT',
    )
  data.saved = prune([...items, item])
  return item
}

export function removeSaved(data: SessionData, id: string, now: Date) {
  const item = savedOf(data, now).find((saved) => saved.id === id && saved.status !== 'removed')
  if (!item) throw new SavedError(404, 'Saved item not found.', 'NOT_FOUND')
  item.status = 'removed'
  delete item.waitDate
  data.saved = prune(data.saved!)
}

/** The older catalog toggle: saves a catalog item, or removes it when it is already saved. */
export function toggleCatalog(data: SessionData, productId: string, today: string, now: Date) {
  const existing = savedOf(data, now).find(
    (item) => item.status !== 'removed' && item.productId === productId,
  )
  if (existing) removeSaved(data, existing.id, now)
  else addSaved(data, { kind: 'catalog', productId }, today, now)
}

/**
 * Moves the browser's old wait dates to the server once. A date moves only onto an item that is
 * still saved: a removed item, or one this session never saved, is not brought back. Malformed
 * entries, past dates and dates beyond the comparison window are skipped; a date the server
 * already has wins.
 */
export function migratePlanned(
  data: SessionData,
  planned: Record<string, unknown>,
  today: string,
  now: Date,
) {
  let moved = 0
  const items = savedOf(data, now)
  for (const [productId, value] of Object.entries(planned)) {
    const date = isoDate.safeParse(value)
    if (!date.success || date.data < today || date.data > addDays(today, WAIT_SEARCH_DAYS)) continue
    const existing = items.find((item) => item.status !== 'removed' && item.productId === productId)
    if (!existing || existing.waitDate) continue
    Object.assign(existing, { option: 'wait', waitDate: date.data })
    moved++
  }
  return moved
}

export const fundsSchema = z
  .object({
    balanceCents: z.number().int().min(0).max(100_000_000),
    /** One-time payments due since the last snapshot that the balance above already reflects. */
    paidFlowIds: z.array(z.string().min(1).max(100)).max(100).default([]),
    /** Completed Worth purchases the balance above already reflects. */
    reflectedPurchaseIds: z.array(z.string().min(1).max(100)).max(1000).default([]),
  })
  .strict()
export type FundsInput = z.infer<typeof fundsSchema>

/**
 * Confirms today's available funds without reopening the whole plan: a new snapshot dated today,
 * the one-time payments since the last snapshot marked paid, and the purchases it includes. On the
 * synthetic persona, accepting the projected balance keeps it the untouched sample.
 */
export function confirmFunds(
  profile: FinancialProfile,
  input: FundsInput,
  options: { today: string; now: Date; completed: string[]; projectionCents?: number },
): FinancialProfile {
  if (!profile.confirmed)
    throw new SavedError(
      409,
      'Review and confirm your whole plan first, then confirm today’s funds.',
      'PLAN_NOT_CONFIRMED',
    )
  const due = new Set(
    profile.flows
      .filter((flow) => flow.active && flow.cadence === 'once' && flow.nextDate < options.today)
      .map((flow) => flow.id),
  )
  if (input.paidFlowIds.some((id) => !due.has(id)))
    throw new SavedError(
      400,
      'Only one-time payments due before today can be marked as paid.',
      'INVALID_PAID',
    )
  if (input.reflectedPurchaseIds.some((id) => !options.completed.includes(id)))
    throw new SavedError(
      400,
      'Only completed purchases can be included in your funds.',
      'INVALID_SNAPSHOT',
    )
  const paid = new Set(input.paidFlowIds)
  const synthetic =
    profile.source === 'demo' &&
    profile.userEdited === false &&
    input.balanceCents === options.projectionCents
  return {
    ...profile,
    balanceCents: input.balanceCents,
    snapshotDate: options.today,
    confirmedAt: options.now.toISOString(),
    confirmed: true,
    version: profile.version + 1,
    reflectedPurchaseIds: [
      ...new Set([...profile.reflectedPurchaseIds, ...input.reflectedPurchaseIds]),
    ],
    flows: profile.flows.map((flow) =>
      paid.has(flow.id) ? { ...flow, paidOn: flow.nextDate } : flow,
    ),
    userEdited: synthetic ? false : true,
  }
}
