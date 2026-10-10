import { DEMO_MERCHANT, PRODUCTS } from '../shared/seed.ts'
import type { Product } from '../shared/types.ts'

/**
 * Larkspur's own catalog: the same IDs, names, prices and images as Worth's demo store, so the
 * replayed demo numbers match on both origins. Prices on this origin come only from here.
 */
export const STORE_NAME = DEMO_MERCHANT
export const CATALOG: readonly Product[] = PRODUCTS.filter((p) => p.merchant === DEMO_MERCHANT)

export function findProduct(id: unknown): Product | undefined {
  return typeof id === 'string' ? CATALOG.find((p) => p.id === id) : undefined
}

export function formatPrice(cents: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
}
