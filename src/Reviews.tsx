import { useState } from 'react'
import { CircleAlert, Info } from 'lucide-react'
import { payIn4Schedule, REFUND_GUIDANCE } from '../shared/finance'
import type { PlanInstalment } from '../shared/types'
import { api } from './api'
import type { AppState } from './contract'
import { fromMoney, money } from './format'
import { Alert, Button, Dialog, Field } from './ui'

type Draft = { date: string; amount: string }
const toDraft = (items: PlanInstalment[]): Draft[] =>
  items.map((item) => ({ date: item.date, amount: (item.amountCents / 100).toFixed(2) }))

function readDrafts(drafts: Draft[]): PlanInstalment[] {
  return drafts.map((draft, index) => {
    const amountCents = fromMoney(draft.amount)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date))
      throw new Error(`Enter a date for payment ${index + 1}.`)
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0)
      throw new Error(`Enter an amount of more than $0 for payment ${index + 1}.`)
    return { date: draft.date, amountCents }
  })
}

function InstalmentFields({
  drafts,
  onChange,
  disabled,
}: {
  drafts: Draft[]
  onChange: (next: Draft[]) => void
  disabled?: boolean
}) {
  return (
    <div className="stack tight">
      {drafts.map((draft, index) => (
        <fieldset key={index} className="form-grid" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="sr">Payment {index + 1}</legend>
          <Field label={`Payment ${index + 1} date`}>
            <input
              className="input"
              type="date"
              value={draft.date}
              disabled={disabled}
              onChange={(event) =>
                onChange(
                  drafts.map((d, i) => (i === index ? { ...d, date: event.target.value } : d)),
                )
              }
            />
          </Field>
          <Field label={`Payment ${index + 1} amount`}>
            <span className="money-input">
              <span aria-hidden="true">$</span>
              <input
                className="input num"
                inputMode="decimal"
                value={draft.amount}
                disabled={disabled}
                onChange={(event) =>
                  onChange(
                    drafts.map((d, i) => (i === index ? { ...d, amount: event.target.value } : d)),
                  )
                }
              />
            </span>
          </Field>
        </fieldset>
      ))}
    </div>
  )
}

/** C-6a: PayPal never tells the merchant how the buyer paid, so the buyer confirms it here. */
export function ConfirmPlanDialog({
  state,
  purchaseId,
  onClose,
  onUpdate,
}: {
  state: AppState
  purchaseId: string
  onClose: () => void
  onUpdate: (state: AppState) => void
}) {
  const purchase = state.purchases.find((item) => item.id === purchaseId)
  const review = state.reviews.find(
    (item) => item.kind === 'confirmPlan' && item.purchaseId === purchaseId,
  )
  const start = (purchase?.completedAt ?? state.today).slice(0, 10)
  const [product, setProduct] = useState<'full' | 'payIn4'>('full')
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    toDraft(payIn4Schedule(purchase?.amountCents ?? 0, start)),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!purchase) return null
  async function save() {
    setError('')
    try {
      const body =
        product === 'full'
          ? { product: 'full' as const }
          : { product: 'payIn4' as const, instalments: readDrafts(drafts) }
      setBusy(true)
      onUpdate((await api<AppState>(`/purchases/${purchaseId}/plan`, body)) as AppState)
      onClose()
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      title="Confirm your plan"
      onClose={onClose}
      dismissible={!busy}
      wide
      footer={
        <>
          {error && (
            <p className="co-error" role="alert">
              <CircleAlert size={16} aria-hidden="true" style={{ flex: 'none', marginTop: 2 }} />
              {error}
            </p>
          )}
          <Button block loading={busy} onClick={() => void save()}>
            Confirm plan
          </Button>
          <Button variant="text" onClick={onClose} disabled={busy}>
            Not now
          </Button>
        </>
      }
    >
      <p className="strong">
        <b>{purchase.name}</b> · {money(purchase.amountCents)}
      </p>
      {review && <p className="meta">{review.message}</p>}
      <div className="seg" role="radiogroup" aria-label="How you paid">
        {(
          [
            ['full', 'Paid in full'],
            ['payIn4', 'Pay in 4'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={product === value}
            onClick={() => setProduct(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {product === 'payIn4' && (
        <>
          <Alert tone="info" icon={Info}>
            Pre-filled from Worth’s illustrative schedule. Change each date and amount to match what
            PayPal showed you; PayPal’s real dates can differ.
          </Alert>
          <InstalmentFields drafts={drafts} onChange={setDrafts} disabled={busy} />
        </>
      )}
    </Dialog>
  )
}

/** C-6b: a refund changes nothing until the buyer confirms what actually came back. */
export function RefundDialog({
  state,
  purchaseId,
  refundId,
  onClose,
  onUpdate,
}: {
  state: AppState
  purchaseId: string
  refundId: string
  onClose: () => void
  onUpdate: (state: AppState) => void
}) {
  const purchase = state.purchases.find((item) => item.id === purchaseId)
  const refund = purchase?.refunds?.find((item) => item.id === refundId)
  const plan = purchase?.paymentPlan
  const remaining =
    plan?.product === 'payIn4' && plan.status === 'confirmed'
      ? plan.instalments.filter((item) => item.date >= state.today)
      : undefined
  const [returned, setReturned] = useState(((refund?.amountCents ?? 0) / 100).toFixed(2))
  const [drafts, setDrafts] = useState<Draft[]>(() => toDraft(remaining ?? []))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!purchase || !refund) return null
  async function save() {
    setError('')
    const returnedCents = fromMoney(returned)
    if (!Number.isSafeInteger(returnedCents) || returnedCents < 0)
      return setError('Enter an amount of $0 or more.')
    try {
      const body = {
        returnedCents,
        ...(remaining ? { remainingInstalments: readDrafts(drafts) } : {}),
      }
      setBusy(true)
      onUpdate(
        (await api<AppState>(
          `/purchases/${purchaseId}/refunds/${encodeURIComponent(refundId)}/confirm`,
          body,
        )) as AppState,
      )
      onClose()
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      title="Review a refund"
      onClose={onClose}
      dismissible={!busy}
      wide
      footer={
        <>
          {error && (
            <p className="co-error" role="alert">
              <CircleAlert size={16} aria-hidden="true" style={{ flex: 'none', marginTop: 2 }} />
              {error}
            </p>
          )}
          <Button block loading={busy} onClick={() => void save()}>
            Confirm refund
          </Button>
          <Button variant="text" onClick={onClose} disabled={busy}>
            Not now
          </Button>
        </>
      }
    >
      <p className="strong">
        The store refunded {money(refund.amountCents)} for {purchase.name}. Confirm what came back
        to you.
      </p>
      <p className="meta">
        {REFUND_GUIDANCE} Until you confirm, your room to spend doesn’t change.
      </p>
      <Field
        label="Money that came back to your account"
        hint="Store credit and gift cards count as $0.00."
      >
        <span className="money-input">
          <span aria-hidden="true">$</span>
          <input
            className="input num"
            inputMode="decimal"
            value={returned}
            disabled={busy}
            onChange={(event) => setReturned(event.target.value)}
          />
        </span>
      </Field>
      {remaining && (
        <>
          <h3 className="h-section">Pay in 4 payments still due</h3>
          <InstalmentFields drafts={drafts} onChange={setDrafts} disabled={busy} />
        </>
      )}
    </Dialog>
  )
}
