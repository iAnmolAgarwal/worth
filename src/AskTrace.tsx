import { CircleAlert } from 'lucide-react'
import {
  collisionLine,
  mainCollision,
  nearPhrase,
  PAY_IN_4_DATES_NOTE,
  PAY_IN_4_SPACING,
} from '../shared/collision'
import type { PayIn4Chat } from '../shared/types'
import { capitalize, cx, dayLabel, money } from './format'
import { Alert, Ring } from './ui'

/** "4 payments of $299.75" or "4 payments from $2.50". */
function payments(p4: PayIn4Chat) {
  const amounts = new Set(p4.payments.map((p) => p.amountCents))
  return `4 payments ${amounts.size > 1 ? 'from' : 'of'} ${money(p4.payments.at(-1)!.amountCents)}`
}

/**
 * The illustrative Pay in 4 schedule inside an answer that asked about it, in the comparison's
 * ring style. Every date after the first is "about": PayPal sets the exact ones.
 */
export function PayIn4Strip({ p4, today }: { p4: PayIn4Chat; today: string }) {
  if (!p4.payments.length)
    return (
      <p className="meta">
        {p4.label}. Worth shows Pay in 4 only for comparison and never recommends it.
      </p>
    )
  return (
    <section className="tile p4-strip" aria-label="PayPal Pay in 4, illustrative schedule">
      <div className="h-section">PayPal Pay in 4 · illustrative</div>
      <p className="meta" style={{ marginTop: 4 }}>
        {payments(p4)}, {PAY_IN_4_SPACING}. Same {money(p4.totalCents)} total; PayPal charges no
        interest.
      </p>
      <div className="sched" role="list" aria-label="Illustrative Pay in 4 payments">
        {p4.payments.map((item) => (
          <div
            role="listitem"
            key={item.number}
            className={cx('inst', item.belowCushion && 'flag')}
            aria-label={`Payment ${item.number} of 4${item.belowCushion ? ', below your cushion' : ''}`}
          >
            <div className="top">
              <Ring part={item.number} />
              <div>
                <div className="amt num">{money(item.amountCents)}</div>
                <div className="when">
                  {item.date === today
                    ? 'Today'
                    : item.number === 1
                      ? dayLabel(item.date)
                      : `About ${dayLabel(item.date)}`}
                </div>
              </div>
            </div>
            <div className="near">
              {item.nearestBill
                ? capitalize(
                    nearPhrase(
                      item.nearestBill.daysFromInstalment,
                      item.nearestBill.name,
                      item.nearestBill.kind,
                    ),
                  )
                : 'No bill within about 3 days'}
            </div>
          </div>
        ))}
      </div>
      <p className="meta strong" style={{ marginTop: 'var(--s-3)' }}>
        {p4.label}.
      </p>
      {p4.stacking && (
        <div style={{ marginTop: 'var(--s-3)' }}>
          <Alert tone="warn" icon={CircleAlert}>
            {p4.stacking.message}
          </Alert>
        </div>
      )}
      <p className="caption" style={{ marginTop: 'var(--s-3)' }}>
        {PAY_IN_4_DATES_NOTE} PayPal sets the exact dates at checkout. Shown for comparison only;
        Worth never recommends it.
        {p4.eligibility === 'range-only' ? ' PayPal decides availability at checkout.' : ''}
      </p>
    </section>
  )
}

/** The one neutral Pay in 4 row in a purchase answer that didn't ask about it (judge #7). */
export function PayIn4Row({ p4, onCompare }: { p4: PayIn4Chat; onCompare?: () => void }) {
  const main = mainCollision(p4.payments)
  return (
    <p className="meta p4-row">
      PayPal Pay in 4: {main ? `${collisionLine(main)}` : `${payments(p4)}, ${PAY_IN_4_SPACING}`}
      {onCompare && (
        <>
          {' · '}
          <button type="button" className="link inline" onClick={onCompare}>
            Compare
          </button>
        </>
      )}
    </p>
  )
}
