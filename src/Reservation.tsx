import { ReceiptText } from 'lucide-react'
import { withoutOwnHold } from '../shared/finance'
import type { AppState, Purchase } from './contract'
import { isActive } from './contract'
import { lower } from './engine'
import { money } from './format'

/**
 * The open checkout that a number on screen already counts, if any: every active checkout for
 * room to spend, and any other item's checkout for an item's own answer (its own hold is left out).
 */
export function countedHold(
  state: AppState,
  item?: { productId?: string; itemName?: string; amountCents: number },
): Purchase | undefined {
  const active = state.purchases.find(isActive)
  if (!active) return undefined
  return !item || withoutOwnHold([active], item).length ? active : undefined
}

/** "Includes the $349 studio headphones checkout you haven't finished · Review" (judge fix #9). */
export function ReservationNote({
  purchase,
  onReview,
  onBrand,
}: {
  purchase: Purchase
  onReview: (purchase: Purchase) => void
  /** On the blue balance tile, the note and its link are white. */
  onBrand?: boolean
}) {
  const amount = money(purchase.amountCents, purchase.amountCents % 100 !== 0)
  return (
    <p
      className={onBrand ? 'caption hold' : 'caption'}
      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
    >
      <ReceiptText size={14} aria-hidden="true" style={{ flex: 'none' }} />
      <span>
        Includes the {amount} {lower(purchase.name)} checkout you haven’t finished ·{' '}
        <button
          type="button"
          className="link"
          style={{ minHeight: 0, fontSize: 'inherit' }}
          onClick={() => onReview(purchase)}
          aria-label={`Review the ${purchase.name} checkout`}
        >
          Review
        </button>
      </span>
    </p>
  )
}
