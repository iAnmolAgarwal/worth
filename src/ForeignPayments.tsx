import { useState } from 'react'
import type { ForeignPayment } from '../shared/types'
import type { AppState } from './contract'
import { CircleAlert } from 'lucide-react'
import { api } from './api'
import { currencyAmount, shortDate } from './format'
import { Alert, Button } from './ui'

type Resolution = { amountCents: number } | { oneOff: true }

/**
 * Imported payments in another currency that had no USD conversion. Worth withholds every positive
 * result until each one has its USD cost or is marked as a one-off.
 */
export function ForeignPayments({
  state,
  onUpdate,
}: {
  state: AppState
  onUpdate: (state: AppState) => void
}) {
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const open = (state.foreignPayments ?? []).filter((payment) => !payment.resolution)
  if (!open.length) return null

  async function resolve(payment: ForeignPayment, resolution: Resolution) {
    setBusy(payment.id)
    setError('')
    try {
      onUpdate(
        (await api<AppState>(
          `/import/unresolved/${encodeURIComponent(payment.id)}`,
          resolution,
        )) as AppState,
      )
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(null)
    }
  }

  function saveAmount(payment: ForeignPayment) {
    const value = (amounts[payment.id] ?? '').trim().replace(/^\$/, '').replace(/,/g, '')
    const cents = /^\d+(\.\d{1,2})?$/.test(value) ? Math.round(Number(value) * 100) : 0
    if (!cents) {
      setError(`Enter what ${payment.name} cost in US dollars, such as 13.37.`)
      return
    }
    void resolve(payment, { amountCents: cents })
  }

  return (
    <section className="tile" aria-labelledby="foreign-payments-heading">
      <Alert tone="warn" icon={CircleAlert}>
        <h2
          id="foreign-payments-heading"
          className="h-section"
          style={{ fontSize: 'var(--fs-body)' }}
        >
          Foreign-currency payments to resolve
        </h2>
        Your import has no USD conversion for{' '}
        {open.length === 1 ? 'this payment' : 'these payments'}. Until each one has its USD cost or
        is marked as a one-off, Worth won’t show a positive result.
      </Alert>
      <ul className="rows" style={{ listStyle: 'none', padding: 0, margin: '16px 0 0' }}>
        {open.map((payment) => (
          <li
            key={payment.id}
            className="row plain"
            style={{ flexWrap: 'wrap', alignItems: 'center' }}
          >
            <span className="body">
              <span className="t" style={{ display: 'block', fontSize: 'var(--fs-body)' }}>
                {payment.name}
              </span>
              <span className="s soft">
                {shortDate(payment.date, { year: 'numeric' })} ·{' '}
                {currencyAmount(Math.abs(payment.originalCents), payment.currency)}
              </span>
            </span>
            <span className="money-input" style={{ width: 140 }}>
              <span aria-hidden="true">$</span>
              <input
                className="input num"
                inputMode="decimal"
                placeholder="USD cost"
                aria-label={`USD cost of ${payment.name}`}
                value={amounts[payment.id] ?? ''}
                onChange={(event) =>
                  setAmounts((current) => ({ ...current, [payment.id]: event.target.value }))
                }
                disabled={busy !== null}
              />
            </span>
            <Button
              variant="secondary"
              loading={busy === payment.id}
              disabled={busy !== null}
              onClick={() => saveAmount(payment)}
            >
              Save USD cost
            </Button>
            <Button
              variant="text"
              disabled={busy !== null}
              onClick={() => void resolve(payment, { oneOff: true })}
            >
              One-off, leave out
            </Button>
          </li>
        ))}
      </ul>
      {error && (
        <p className="co-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
