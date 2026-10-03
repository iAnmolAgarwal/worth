import { useState } from 'react'
import type { AppState, ForeignPayment } from '../shared/types'
import { api } from './api'
import { currencyAmount, shortDate } from './format'
import { Button } from './ui'

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
        await api<AppState>(`/import/unresolved/${encodeURIComponent(payment.id)}`, resolution),
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
    <section
      className="notice notice-warning foreign-payments"
      aria-labelledby="foreign-payments-heading"
    >
      <h2 id="foreign-payments-heading">Foreign-currency payments to resolve</h2>
      <p>
        Your import has no USD conversion for{' '}
        {open.length === 1 ? 'this payment' : 'these payments'}. Until each one has its USD cost or
        is marked as a one-off, Worth won’t show a positive result.
      </p>
      <ul>
        {open.map((payment) => (
          <li key={payment.id}>
            <span>
              <strong>{payment.name}</strong>
              <small>
                {shortDate(payment.date, { year: 'numeric' })} ·{' '}
                {currencyAmount(Math.abs(payment.originalCents), payment.currency)}
              </small>
            </span>
            <input
              className="input"
              inputMode="decimal"
              placeholder="USD cost"
              aria-label={`USD cost of ${payment.name}`}
              value={amounts[payment.id] ?? ''}
              onChange={(event) =>
                setAmounts((current) => ({ ...current, [payment.id]: event.target.value }))
              }
              disabled={busy !== null}
            />
            <Button
              type="button"
              variant="secondary"
              loading={busy === payment.id}
              disabled={busy !== null}
              onClick={() => saveAmount(payment)}
            >
              Save USD cost
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void resolve(payment, { oneOff: true })}
            >
              One-off, leave out
            </Button>
          </li>
        ))}
      </ul>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
