import { useMemo, useState } from 'react'
import {
  ArrowDownLeft,
  Banknote,
  CalendarCheck,
  Clock,
  Download,
  ReceiptText,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Store,
  Upload,
  type LucideIcon,
} from 'lucide-react'
import { addDays, dateInTimezone } from '../shared/finance'
import type { Transaction } from '../shared/types'
import { api } from './api'
import type { AppState, Purchase } from './contract'
import { isActive } from './contract'
import { ForeignPayments } from './ForeignPayments'
import { monthLabel, money, shortDate, signed, displayName } from './format'
import { Button, Dialog, Disc, EmptyState, Field, Pill } from './ui'

type Filter = 'all' | 'expense' | 'income' | 'refund' | 'transfer'
const FILTERS: [Filter, string][] = [
  ['all', 'All activity'],
  ['expense', 'Spending'],
  ['income', 'Income'],
  ['refund', 'Refunds'],
  ['transfer', 'Transfers'],
]
const KIND_TEXT: Record<Transaction['kind'], string> = {
  expense: 'Payment',
  income: 'Income',
  transfer: 'Transfer',
  refund: 'Refund',
  adjustment: 'Balance correction, not counted',
  installment: 'Pay in 4 or Pay Later',
  unknown: 'Needs review',
}
const iconFor = (t: Transaction): LucideIcon =>
  t.kind === 'income'
    ? Banknote
    : t.kind === 'refund'
      ? RefreshCw
      : t.kind === 'transfer'
        ? ArrowDownLeft
        : t.kind === 'installment'
          ? CalendarCheck
          : Store
const PAGE = 25
/** An order an outside agent asked for through Worth's MCP server (prepare_order). */
function ExternalAgent() {
  return (
    <div className="pills">
      <Pill tone="info">Requested by an external agent</Pill>
    </div>
  )
}

interface CategoryResult {
  mode: 'anthropic' | 'demo'
  suggestions: { transactionId: string; category: string }[]
  message: string
}

export function Activity({
  state,
  onUpdate,
  onAsk,
  onOpenCheckout,
  onConfirmPlan,
  onReviewRefund,
  onImport,
}: {
  state: AppState
  onUpdate: (state: AppState) => void
  onAsk: () => void
  onOpenCheckout: (purchase: Purchase) => void
  onConfirmPlan: (purchaseId: string) => void
  onReviewRefund: (purchaseId: string, refundId: string) => void
  onImport?: () => void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [shown, setShown] = useState(PAGE)
  const [detail, setDetail] = useState<Transaction>()
  const [proposals, setProposals] = useState<CategoryResult>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const q = query.trim().toLowerCase()
  const matches = (text: string) => !q || text.toLowerCase().includes(q)
  const rows = useMemo(
    () =>
      state.transactions.filter(
        (t) => (filter === 'all' || t.kind === filter) && matches(`${t.name} ${t.category}`),
      ),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [state.transactions, filter, q],
  )
  const active = state.purchases.filter(isActive).filter((p) => matches(p.name))
  const refunds = state.reviews.filter(
    (review): review is Extract<AppState['reviews'][number], { kind: 'refund' }> =>
      review.kind === 'refund' && matches(review.name),
  )
  const unconfirmed = new Set(
    state.reviews.filter((review) => review.kind === 'confirmPlan').map((r) => r.purchaseId),
  )
  const pending = rows.filter((t) => t.status === 'pending')
  const completed = rows.filter((t) => t.status !== 'pending')
  const weekStart = addDays(state.today, -6)
  const groups: { label: string; items: Transaction[] }[] = []
  for (const t of completed.slice(0, shown)) {
    const label = t.date >= weekStart ? 'This week' : monthLabel(t.date)
    const group = groups.at(-1)
    if (group?.label === label) group.items.push(t)
    else groups.push({ label, items: [t] })
  }

  function download() {
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`
    const csv = [
      'Date,Name,Category,Type,Status,Amount USD',
      ...rows.map((t) =>
        [
          t.date,
          escape(t.name),
          escape(t.category),
          t.kind,
          t.status,
          (t.amountCents / 100).toFixed(2),
        ].join(','),
      ),
    ].join('\n')
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    link.download = `worth-activity-${state.today}.csv`
    link.click()
    URL.revokeObjectURL(link.href)
  }
  async function suggest() {
    setBusy(true)
    setError('')
    try {
      setProposals(await api<CategoryResult>('/transactions/categories', {}))
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function setCategory(id: string, category: string) {
    setBusy(true)
    setError('')
    try {
      onUpdate(
        (await api<AppState>(
          `/transactions/${encodeURIComponent(id)}`,
          { category },
          'PATCH',
        )) as AppState,
      )
      setDetail(undefined)
      setProposals((prev) =>
        prev
          ? { ...prev, suggestions: prev.suggestions.filter((s) => s.transactionId !== id) }
          : prev,
      )
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const row = (t: Transaction) => {
    const purchaseId = t.source === 'purchase' ? t.id.replace(/^purchase-/, '') : undefined
    const needsPlan = purchaseId && unconfirmed.has(purchaseId)
    const bought = purchaseId ? state.purchases.find((p) => p.id === purchaseId) : undefined
    return (
      <button
        type="button"
        className="row"
        key={t.id}
        onClick={() => (needsPlan ? onConfirmPlan(purchaseId!) : setDetail(t))}
      >
        <Disc icon={iconFor(t)} kind={t.kind === 'income' ? 'income' : undefined} />
        <div className="body">
          <div className="t">{displayName(t.name)}</div>
          <div className="s">
            {shortDate(t.date)} ·{' '}
            {t.source === 'purchase'
              ? `${bought?.paymentPlan?.product === 'payIn4' ? 'Pay in 4' : 'Payment'} to ${
                  state.products.find((p) => p.id === bought?.productId)?.merchant ?? 'the store'
                } · PayPal`
              : KIND_TEXT[t.kind]}
            {t.status === 'excluded' ? ' · not counted' : ''}
          </div>
          {bought?.preparedBy === 'external' && <ExternalAgent />}
          {needsPlan && (
            <div className="pills">
              <Pill tone="warn">Confirm your plan</Pill>
            </div>
          )}
        </div>
        <div className={`amt num${t.amountCents > 0 ? ' pos' : ''}`}>
          {signed(t.amountCents, t.amountCents > 0)}
        </div>
      </button>
    )
  }
  const nothing = !pending.length && !completed.length && !active.length && !refunds.length

  return (
    <div className="page plain activity">
      <div className="wrap">
        <h1 className="sr">Activity</h1>
        <div className="search-row">
          <div className="composer">
            <Search className="ico search" aria-hidden="true" />
            <label className="sr" htmlFor="activity-q">
              Search activity
            </label>
            <input
              id="activity-q"
              type="search"
              placeholder="Search by name or category"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setShown(PAGE)
              }}
            />
          </div>
          <button
            type="button"
            className="round-btn"
            aria-label="Filter activity"
            aria-pressed={filtersOpen}
            aria-controls="activity-filters"
            onClick={() => setFiltersOpen(!filtersOpen)}
          >
            <SlidersHorizontal className="ico" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="round-btn"
            aria-label="Download activity as CSV"
            onClick={download}
          >
            <Download className="ico" aria-hidden="true" />
          </button>
          {onImport && (
            <button
              type="button"
              className="round-btn"
              aria-label="Import PayPal activity"
              onClick={onImport}
            >
              <Upload className="ico" aria-hidden="true" />
            </button>
          )}
        </div>
        <div style={{ marginTop: 'var(--s-6)' }}>
          <p
            className="strong"
            style={{ marginBottom: 'var(--s-3)', fontSize: 'var(--fs-section)' }}
          >
            Filter by
          </p>
          <div className="chips" id="activity-filters">
            {filtersOpen ? (
              FILTERS.map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  className={value === filter ? 'chip-filter' : 'chip-suggest'}
                  aria-pressed={value === filter}
                  onClick={() => {
                    setFilter(value)
                    setShown(PAGE)
                    setFiltersOpen(false)
                  }}
                >
                  {label}
                </button>
              ))
            ) : (
              <button type="button" className="chip-filter" onClick={() => setFiltersOpen(true)}>
                Type: {FILTERS.find(([value]) => value === filter)![1]}
              </button>
            )}
            <button
              type="button"
              className="chip-suggest"
              onClick={() => void suggest()}
              disabled={busy}
            >
              Suggest categories
            </button>
          </div>
        </div>
        <div style={{ marginTop: 'var(--s-6)' }}>
          <ForeignPayments state={state} onUpdate={onUpdate} />
        </div>
        {error && !detail && (
          <p className="co-error" role="alert" style={{ marginTop: 16 }}>
            {error}
          </p>
        )}
        {nothing && q && (
          <EmptyState
            icon={Search}
            title={`No matches for “${query.trim()}”`}
            action={
              <Button variant="quiet" onClick={() => setQuery('')}>
                Clear search
              </Button>
            }
          >
            Try a merchant name or a category.
          </EmptyState>
        )}
        {nothing && !q && (
          <div style={{ marginTop: 'var(--s-8)' }}>
            <EmptyState
              icon={ReceiptText}
              title="No purchases yet"
              action={
                <Button variant="quiet" onClick={onAsk}>
                  Ask about a purchase
                </Button>
              }
            >
              Purchases you make through Worth show up here once.
            </EmptyState>
          </div>
        )}
        {(active.length > 0 || refunds.length > 0 || pending.length > 0) && (
          <section aria-labelledby="pending-title">
            <h2 className="list-head" id="pending-title">
              Pending
            </h2>
            <div className="rows">
              {active.map((purchase) => (
                <button
                  type="button"
                  className="row"
                  key={purchase.id}
                  onClick={() => onOpenCheckout(purchase)}
                >
                  <Disc icon={Store} badge={Clock} />
                  <div className="body">
                    <div className="t">{purchase.name}</div>
                    <div className="s">
                      {shortDate(dateInTimezone(purchase.createdAt, state.profile.timezone))} ·{' '}
                      {purchase.status === 'created'
                        ? 'Waiting for PayPal'
                        : 'PayPal is confirming'}
                    </div>
                    {purchase.preparedBy === 'external' && <ExternalAgent />}
                  </div>
                  <div className="amt num">{signed(-purchase.amountCents)}</div>
                </button>
              ))}
              {refunds.map((review) => (
                <button
                  type="button"
                  className="row"
                  key={review.refundId}
                  onClick={() => onReviewRefund(review.purchaseId, review.refundId)}
                >
                  <Disc icon={RefreshCw} kind="plan" />
                  <div className="body">
                    <div className="t">{review.name}</div>
                    <div className="s">
                      <span className="soft">
                        The store refunded {money(review.refundedCents)}. Confirm what came back to
                        you.
                      </span>
                    </div>
                    <div className="pills">
                      <Pill tone="warn">Refund to review</Pill>
                    </div>
                  </div>
                  <div className="amt num pos">{signed(review.refundedCents, true)}</div>
                </button>
              ))}
              {pending.map(row)}
            </div>
          </section>
        )}
        {groups.length > 0 && (
          <section aria-labelledby="completed-title">
            <h2 className="list-head" id="completed-title">
              Completed
            </h2>
            {groups.map((group) => (
              <div key={group.label} style={{ marginBottom: 'var(--s-4)' }}>
                <h3 className="group-label">{group.label}</h3>
                <div className="rows">{group.items.map(row)}</div>
              </div>
            ))}
            {completed.length > shown && (
              <Button variant="secondary" onClick={() => setShown(shown + PAGE)}>
                Show more
              </Button>
            )}
          </section>
        )}
        <p className="caption" style={{ marginTop: 'var(--s-6)' }}>
          Past activity helps estimate your everyday spending. Your money available is the amount
          you confirmed, so these payments are not subtracted again.
        </p>
      </div>
      {detail && (
        <TransactionDialog
          transaction={detail}
          busy={busy}
          error={error}
          onClose={() => {
            setDetail(undefined)
            setError('')
          }}
          onSave={(category) => void setCategory(detail.id, category)}
        />
      )}
      {proposals && (
        <Dialog title="Suggested categories" onClose={() => setProposals(undefined)} wide>
          <p className="meta">{proposals.message}</p>
          {proposals.suggestions.length ? (
            <div className="rows">
              {proposals.suggestions.slice(0, 10).map((s) => {
                const t = state.transactions.find((item) => item.id === s.transactionId)
                return (
                  <div className="row plain" key={s.transactionId}>
                    <div className="body">
                      <div className="t" style={{ fontSize: 'var(--fs-body)' }}>
                        {t?.name}
                      </div>
                      <div className="s">
                        <span className="soft">
                          {t?.category} → {s.category}
                        </span>
                      </div>
                    </div>
                    <Button
                      variant="secondary"
                      disabled={busy || t?.category === s.category}
                      onClick={() => void setCategory(s.transactionId, s.category)}
                    >
                      {t?.category === s.category ? 'Applied' : 'Apply'}
                    </Button>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="meta">No category changes to review.</p>
          )}
        </Dialog>
      )}
    </div>
  )
}

const CATEGORIES = [
  'Groceries',
  'Food & drink',
  'Transport',
  'Home',
  'Entertainment',
  'Software',
  'Health',
  'Shopping',
  'Travel',
  'Education',
  'Gifts',
  'Other',
]
function TransactionDialog({
  transaction: t,
  busy,
  error,
  onClose,
  onSave,
}: {
  transaction: Transaction
  busy: boolean
  error: string
  onClose: () => void
  onSave: (category: string) => void
}) {
  const [category, setCategory] = useState(t.category)
  return (
    <Dialog
      title={t.name}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          {error && (
            <p className="co-error" role="alert">
              {error}
            </p>
          )}
          <Button
            block
            loading={busy}
            onClick={() => onSave(category.trim())}
            disabled={!category.trim()}
          >
            Save category
          </Button>
          <Button variant="text" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </>
      }
    >
      <dl className="kvlist">
        <div>
          <dt>Amount</dt>
          <dd className="num">{signed(t.amountCents, t.amountCents > 0)}</dd>
        </div>
        <div>
          <dt>Date</dt>
          <dd>{shortDate(t.date, { weekday: 'short', year: 'numeric' })}</dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>{KIND_TEXT[t.kind]}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            {t.status === 'excluded'
              ? 'Not counted'
              : t.status === 'pending'
                ? 'Pending'
                : 'Completed'}
          </dd>
        </div>
      </dl>
      <Field
        label="Category"
        hint="Changing a category doesn’t change your everyday spending estimate."
      >
        <input
          className="input"
          value={category}
          maxLength={80}
          list="category-options"
          onChange={(event) => setCategory(event.target.value)}
        />
        <datalist id="category-options">
          {CATEGORIES.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </Field>
    </Dialog>
  )
}
