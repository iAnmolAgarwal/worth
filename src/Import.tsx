import { useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { Banknote, CircleAlert, FileUp, Info, Store } from 'lucide-react'
import type { DateOrder, ImportPreview, InstalmentPlanProposal } from '../shared/types'
import { CSV_IMPORT_LIMITS, CSV_SIZE_MESSAGE, utf8Bytes } from '../shared/limits'
import { api } from './api'
import type { AppState } from './contract'
import { isActive } from './contract'
import { currencyAmount, money, shortDate, signed } from './format'
import { Alert, Button, Dialog, Disc, Field } from './ui'

type DialogProps = { state: AppState; onClose: () => void; onUpdate: (state: AppState) => void }
const TYPE_LABEL: Record<ImportPreview['transactions'][number]['kind'], string> = {
  expense: 'Payment',
  income: 'Income',
  transfer: 'Transfer',
  refund: 'Refund',
  adjustment: 'Balance correction',
  installment: 'Instalment',
  unknown: 'Needs review',
}
const count = (n: number, noun: string) =>
  `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.'

export function ImportDialog({
  state,
  onClose,
  onUpdate,
  onReview,
}: DialogProps & { onReview: (plans: InstalmentPlanProposal[]) => void }) {
  const [csv, setCsv] = useState('')
  const [filename, setFilename] = useState('')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [previewedCsv, setPreviewedCsv] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  // Asked only when every date in the file could be read either way.
  const [dateOrder, setDateOrder] = useState<DateOrder>()
  const [busy, setBusy] = useState<'read' | 'preview' | 'commit' | null>(null)
  const [error, setError] = useState('')
  const activeCheckout = state.purchases.some(isActive)
  const changeCsv = (value: string) => {
    setCsv(value)
    setPreview(null)
    setPreviewedCsv('')
    setAcknowledged(false)
    setDateOrder(undefined)
    setError('')
  }

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setError('')
    setPreview(null)
    setAcknowledged(false)
    if (file.size > CSV_IMPORT_LIMITS.maxBytes) {
      setError('Choose a CSV smaller than 1 MB. A recent 90-day export is a good starting point.')
      event.target.value = ''
      return
    }
    setBusy('read')
    try {
      const text = await file.text()
      changeCsv(text)
      setFilename(file.name)
    } catch {
      setError('This file could not be read. Try choosing it again or paste its contents below.')
    } finally {
      setBusy(null)
    }
  }

  const getPreview = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void runPreview(dateOrder)
  }

  const chooseDateOrder = (order: DateOrder) => {
    setDateOrder(order)
    void runPreview(order)
  }

  const runPreview = async (order: DateOrder | undefined) => {
    setError('')
    setAcknowledged(false)
    if (!csv.trim()) {
      setError('Choose a CSV or paste your PayPal activity export first.')
      return
    }
    if (utf8Bytes(csv) > CSV_IMPORT_LIMITS.maxBytes) {
      setError(CSV_SIZE_MESSAGE)
      return
    }
    setBusy('preview')
    try {
      const result = await api<ImportPreview>('/import/preview', {
        csv,
        ...(order ? { dateOrder: order } : {}),
      })
      setPreview(result)
      setPreviewedCsv(csv)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(null)
    }
  }

  const commit = async () => {
    if (
      !preview ||
      preview.errors.length ||
      preview.needsDateOrder ||
      csv !== previewedCsv ||
      !acknowledged
    )
      return
    setError('')
    setBusy('commit')
    try {
      const updated = (await api<AppState>('/import/commit', {
        csv,
        ...(dateOrder ? { dateOrder } : {}),
      })) as AppState
      onUpdate(updated)
      onClose()
      onReview(preview.instalmentPlans)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(null)
    }
  }

  // Each issue once: foreign-currency and Pay Later rows already have their own sections above.
  const reviewItems = [
    ...new Set(
      (preview?.warnings ?? []).filter(
        (warning) =>
          !(preview?.unresolved.length && /currenc|USD conversion/i.test(warning)) &&
          !(preview?.instalmentPlans.length && /pay later|pay in 4|instal/i.test(warning)) &&
          !(preview?.adjustments.length && /correction/i.test(warning)) &&
          !(preview?.storeMatches?.length && /’s report of /.test(warning)),
      ),
    ),
  ]
  const attention = preview
    ? [
        ...preview.unresolved.map(
          (payment) =>
            `${payment.name} · ${shortDate(payment.date)} · ${currencyAmount(Math.abs(payment.originalCents), payment.currency)} has no USD cost yet. Resolve it in Activity; until then Worth won’t show room to spend.`,
        ),
        ...preview.instalmentPlans.map(
          (plan) =>
            `Possible Pay in 4: ${plan.name}${plan.purchaseCents !== null ? ` · ${money(plan.purchaseCents)} purchase` : ''} · payments of about ${money(plan.paymentCents)}. You’ll add what’s still due next.`,
        ),
        ...preview.adjustments.map(
          (transaction) =>
            `${transaction.name} · ${shortDate(transaction.date)} · ${signed(transaction.amountCents, true)} is a PayPal balance correction, not counted.`,
        ),
        ...reviewItems,
      ]
    : []
  return (
    <Dialog
      title="Import PayPal activity"
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
          <Button
            block
            onClick={() => void commit()}
            loading={busy === 'commit'}
            disabled={
              !preview ||
              preview.errors.length > 0 ||
              preview.needsDateOrder ||
              !acknowledged ||
              csv !== previewedCsv ||
              Boolean(busy) ||
              activeCheckout ||
              (!preview.transactions.length && !preview.duplicates && !preview.unresolved.length)
            }
          >
            Import and review my plan
          </Button>
          <Button variant="text" onClick={onClose} disabled={Boolean(busy)}>
            Cancel
          </Button>
        </>
      }
    >
      <p className="meta">
        Bring your PayPal activity export. Worth turns the patterns into a plan you confirm.
      </p>
      <form onSubmit={getPreview} aria-busy={Boolean(busy)}>
        {activeCheckout && (
          <Alert tone="warn" icon={CircleAlert}>
            Finish or cancel your active checkout before importing new history.
          </Alert>
        )}
        {preview ? (
          <div className="row plain picked-file">
            <Disc icon={FileUp} kind="plan" />
            <div className="body">
              <div className="t" style={{ fontSize: 'var(--fs-body)' }}>
                {filename || 'Pasted CSV'}
              </div>
              <div className="s soft">Previewed below. Nothing is imported until you confirm.</div>
            </div>
            <Button variant="text" onClick={() => changeCsv('')} disabled={Boolean(busy)}>
              Change
            </Button>
          </div>
        ) : (
          <section className="stack tight">
            <Alert tone="info" icon={Info}>
              <b>A PayPal activity export, in USD.</b> Use an English-language CSV with Date,
              Currency, and Net, Amount or Gross. Up to 1 MB; about 90 days of history works well.
            </Alert>
            <div className="field">
              <span id="csv-label">Your PayPal activity CSV</span>
              <div className="file-pick">
                <label className={`btn btn-secondary${busy ? ' is-disabled' : ''}`}>
                  <FileUp className="ico" aria-hidden="true" />
                  Choose a CSV file
                  <input
                    className="sr"
                    type="file"
                    accept=".csv,text/csv"
                    aria-labelledby="csv-label"
                    onChange={(event) => void chooseFile(event)}
                    disabled={Boolean(busy)}
                  />
                </label>
                <span className="meta">
                  {filename || 'Download an activity report from your PayPal account.'}
                </span>
              </div>
            </div>
            <details className="quiet-details">
              <summary>Or paste the CSV contents</summary>
              <Field label="PayPal CSV contents">
                <textarea
                  className="input"
                  rows={6}
                  value={csv}
                  maxLength={CSV_IMPORT_LIMITS.maxBytes}
                  onChange={(event) => {
                    setFilename('')
                    changeCsv(event.target.value)
                  }}
                  spellCheck={false}
                  placeholder={'Date,Name,Currency,Amount\n2026-01-01,Coffee shop,USD,-6.50'}
                  disabled={Boolean(busy)}
                />
              </Field>
            </details>
            <p className="caption">
              {state.profile.source === 'demo'
                ? 'Your own history replaces the sample transactions. Next, you’ll confirm your money, income and bills.'
                : 'New transactions are merged with your history. Matching transaction IDs keep repeated imports from counting twice.'}
            </p>
            <Button
              type="submit"
              variant="secondary"
              icon={FileUp}
              loading={busy === 'preview'}
              disabled={!csv.trim() || Boolean(busy) || activeCheckout}
            >
              Preview my history
            </Button>
          </section>
        )}
      </form>

      {preview && (
        <section
          className="stack tight"
          aria-labelledby="import-preview-heading"
          aria-live="polite"
        >
          <h3 className="h-section" id="import-preview-heading">
            Here’s what Worth found
          </h3>
          {(preview.needsDateOrder || dateOrder) && (
            <fieldset className="import-date-order" disabled={Boolean(busy)}>
              <legend>How does this file write dates?</legend>
              <p className="meta">
                Every date here could be read two ways. Choose the order your PayPal account uses.
              </p>
              {(
                [
                  ['MM/DD', 'Month first, as in the US', '03/04/2026 is March 4'],
                  ['DD/MM', 'Day first, as in the UK', '03/04/2026 is 3 April'],
                ] as const
              ).map(([order, label, example]) => (
                <label className="check" key={order}>
                  <input
                    type="radio"
                    name="import-date-order"
                    value={order}
                    checked={dateOrder === order}
                    onChange={() => chooseDateOrder(order)}
                  />
                  <span>
                    <strong>{label}</strong>
                    <small>{example}</small>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          <p className="strong">
            {count(preview.totalRows, 'row')} · {count(preview.coverageDays, 'day')} ·{' '}
            {preview.transactions.length} new
            {preview.duplicates ? ` · ${count(preview.duplicates, 'duplicate')} skipped` : ''}
          </p>
          <p className="meta">
            Suggested everyday spending: {money(preview.suggestedDailySpendCents)} a day.{' '}
            {preview.recurring.length > 0 &&
              `${count(preview.recurring.length, 'repeating item')} to confirm next.`}
          </p>
          {preview.storeMatches?.length ? (
            <Alert tone="info" icon={Store}>
              <strong>Counted once</strong>
              <ul>
                {preview.storeMatches.map((match) => (
                  <li key={match.row}>
                    Matched “{match.name}” {money(-match.amountCents)} on {shortDate(match.date)} to{' '}
                    {match.store}’s report of {match.item}. It’s already in your Activity, so it
                    isn’t imported again.
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {attention.length > 0 && (
            <details className="quiet-details attention">
              <summary>Needs attention ({attention.length})</summary>
              <ul>
                {attention.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </details>
          )}
          {preview.errors.length > 0 && (
            <div className="alert bad" role="alert">
              <div className="alert-body">
                <strong>
                  Correct {preview.errors.length}{' '}
                  {preview.errors.length === 1 ? 'row issue' : 'row issues'} before importing.
                </strong>
                <ul>
                  {preview.errors.slice(0, 20).map((issue, index) => (
                    <li key={`${issue.row}-${index}`}>
                      Row {issue.row}: {issue.message}
                    </li>
                  ))}
                </ul>
                {preview.errors.length > 20 && (
                  <p>
                    And {preview.errors.length - 20} more issues. Correct these rows and preview the
                    file again.
                  </p>
                )}
              </div>
            </div>
          )}
          {preview.transactions.length > 0 && (
            <section aria-labelledby="preview-rows">
              <h4 className="meta strong" id="preview-rows" style={{ margin: '4px 0' }}>
                Newest in this file
              </h4>
              <div className="rows">
                {preview.transactions.slice(0, 5).map((transaction) => (
                  <div className="row plain small" key={transaction.id}>
                    <Disc
                      icon={transaction.amountCents > 0 ? Banknote : Store}
                      kind={transaction.amountCents > 0 ? 'income' : undefined}
                    />
                    <div className="body">
                      <div className="t">{transaction.name || TYPE_LABEL[transaction.kind]}</div>
                      <div className="s soft">
                        {shortDate(transaction.date)} · {TYPE_LABEL[transaction.kind]}
                        {transaction.status !== 'completed' ? ' · pending' : ''}
                      </div>
                    </div>
                    <div className={`amt num${transaction.amountCents > 0 ? ' pos' : ''}`}>
                      {signed(transaction.amountCents, transaction.amountCents > 0)}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
          {preview.errors.length === 0 && !preview.needsDateOrder && (
            <label className="check">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                disabled={Boolean(busy)}
              />
              <span>
                I reviewed this preview. I’ll confirm my available funds and upcoming commitments
                next.
              </span>
            </label>
          )}
        </section>
      )}
      <p className="caption">
        Raw CSV files aren’t saved. Imported history stays in this session and isn’t sent to
        Anthropic (Claude) without your permission. Past activity doesn’t set your money available.
      </p>
    </Dialog>
  )
}
