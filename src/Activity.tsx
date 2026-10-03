import { useMemo, useState } from 'react'
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Search,
  Sparkles,
  Upload,
  X,
} from 'lucide-react'
import type { AppState, Transaction } from '../shared/types'
import { addDays } from '../shared/finance'
import { api } from './api'
import { money, shortDate } from './format'
import { Button, EmptyState, Field, Footnote, IconButton, Modal, Tag } from './ui'
import { ForeignPayments } from './ForeignPayments'

interface CategoryResult {
  mode: 'anthropic' | 'demo'
  suggestions: { transactionId: string; category: string }[]
  message: string
}
export function Activity({
  state,
  onUpdate,
  onImport,
  onPlan,
}: {
  state: AppState
  onUpdate: (s: AppState) => void
  onImport: () => void
  onPlan: () => void
}) {
  const [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all'),
    [page, setPage] = useState(0)
  const [edit, setEdit] = useState<Transaction | null>(null),
    [category, setCategory] = useState('')
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [proposals, setProposals] = useState<CategoryResult>()
  const rows = useMemo(
    () =>
      state.transactions.filter(
        (t) =>
          (filter === 'all' || t.kind === filter) &&
          `${t.name} ${t.category}`.toLowerCase().includes(search.toLowerCase()),
      ),
    [state.transactions, search, filter],
  )
  const recent = state.transactions.filter(
    (t) =>
      t.date >= addDays(state.today, -29) &&
      t.date <= state.today &&
      t.status === 'completed' &&
      t.currency === 'USD',
  )
  const spend = recent
    .filter((t) => t.kind === 'expense')
    .reduce((s, t) => s + Math.abs(t.amountCents), 0)
  const incomes = recent.filter((t) => t.kind === 'income').reduce((s, t) => s + t.amountCents, 0)
  const totalPages = Math.max(1, Math.ceil(rows.length / 12)),
    shownPage = Math.min(page, totalPages - 1)
  async function suggest() {
    setBusy(true)
    setError('')
    try {
      setProposals(await api<CategoryResult>('/transactions/categories', {}))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function update(id: string, value: string) {
    setBusy(true)
    setError('')
    try {
      onUpdate(
        await api<AppState>(
          `/transactions/${encodeURIComponent(id)}`,
          { category: value },
          'PATCH',
        ),
      )
      setEdit(null)
      setProposals((prev) =>
        prev
          ? {
              ...prev,
              suggestions: prev.suggestions.filter((s) => s.transactionId !== id),
            }
          : prev,
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="page-enter">
      <div className="page-heading">
        <div>
          <h1>Your activity.</h1>
        </div>
        <Button variant="secondary" onClick={onImport}>
          <Upload size={16} /> Import activity
        </Button>
      </div>
      <div className="activity-stats">
        <div>
          <span>Recorded expenses · 30 days</span>
          <strong>{money(spend, true)}</strong>
          <small>Completed spending, before refunds</small>
        </div>
        <div>
          <span>Recorded income · 30 days</span>
          <strong>{money(incomes, true)}</strong>
          <small>Transfers are kept separate</small>
        </div>
        <div>
          <span>History in your picture</span>
          <strong>
            {state.profile.coverageDays}
            <em> days</em>
          </strong>
          <small>
            {state.profile.source === 'demo'
              ? 'Synthetic sample history'
              : 'From your imported records'}
          </small>
        </div>
      </div>
      <ForeignPayments state={state} onUpdate={onUpdate} />
      <section className="panel activity-panel">
        <div className="activity-toolbar">
          <div className="search-field">
            <Search size={17} />
            <input
              placeholder="Find a merchant or category"
              aria-label="Search transactions"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(0)
              }}
            />
          </div>
          <select
            aria-label="Filter activity"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value)
              setPage(0)
            }}
          >
            <option value="all">All activity</option>
            <option value="expense">Spending</option>
            <option value="income">Income</option>
            <option value="transfer">Transfers</option>
            <option value="refund">Refunds</option>
          </select>
          <Button variant="secondary" loading={busy} onClick={suggest}>
            <Sparkles size={15} /> Review categories
          </Button>
        </div>
        {proposals && (
          <div className="category-proposals">
            <div className="category-proposals-heading">
              <div>
                <Tag tone={proposals.mode === 'anthropic' ? 'purple' : 'neutral'}>
                  {proposals.mode === 'anthropic' ? 'AI suggestions' : 'Local categories'}
                </Tag>
                <p>{proposals.message}</p>
              </div>
              <IconButton
                label="Close category suggestions"
                onClick={() => setProposals(undefined)}
              >
                <X size={16} />
              </IconButton>
            </div>
            {proposals.suggestions.length ? (
              <div className="proposal-list">
                {proposals.suggestions.slice(0, 10).map((s) => {
                  const t = state.transactions.find((t) => t.id === s.transactionId)
                  return (
                    <div className="proposal-row" key={s.transactionId}>
                      <span>
                        <strong>{t?.name}</strong>
                        <small>
                          {t && shortDate(t.date)} · {t && money(Math.abs(t.amountCents), true)} ·{' '}
                          {t?.category}
                        </small>
                      </span>
                      <span>{s.category}</span>
                      <Button
                        variant="ghost"
                        disabled={busy || t?.category === s.category}
                        onClick={() => update(s.transactionId, s.category)}
                      >
                        {t?.category === s.category ? 'Already set' : 'Apply'}
                        <Check size={14} />
                      </Button>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="muted">No category suggestions to review.</p>
            )}
            {state.profile.source === 'import' && !state.profile.aiConsent && (
              <Button variant="ghost" onClick={onPlan}>
                Manage AI sharing <ArrowUpRight size={14} />
              </Button>
            )}
          </div>
        )}
        {rows.length ? (
          <>
            <div className="transaction-table-wrap">
              <table className="transaction-table">
                <thead>
                  <tr>
                    <th>Transaction</th>
                    <th>Category</th>
                    <th>Date</th>
                    <th>Status</th>
                    <th className="text-right">Amount</th>
                    <th>
                      <span className="sr-only">Edit</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(shownPage * 12, shownPage * 12 + 12).map((t) => (
                    <tr key={t.id}>
                      <td>
                        <span className="transaction-name">
                          <span
                            className="merchant-mark"
                            style={{ background: t.color ?? '#e8ecdf' }}
                          >
                            {t.name.slice(0, 1)}
                          </span>
                          <span>
                            <strong>{t.name}</strong>
                            <small>
                              {t.kind === 'transfer'
                                ? 'Account transfer'
                                : t.kind === 'adjustment'
                                  ? 'PayPal balance correction'
                                  : t.kind === 'installment'
                                    ? 'Pay in 4 or Pay Later'
                                    : t.source === 'purchase'
                                      ? 'App purchase'
                                      : t.kind === 'refund'
                                        ? 'Refund'
                                        : t.source === 'demo'
                                          ? 'Demo history'
                                          : 'PayPal import'}
                            </small>
                          </span>
                        </span>
                      </td>
                      <td>
                        <span className="category-pill">{t.category}</span>
                      </td>
                      <td>{shortDate(t.date, { year: 'numeric' })}</td>
                      <td>
                        <span className={`transaction-status status-${t.status}`}>{t.status}</span>
                      </td>
                      <td className={`transaction-amount ${t.amountCents > 0 ? 'positive' : ''}`}>
                        {t.amountCents < 0 ? '−' : '+'}
                        {money(Math.abs(t.amountCents), true)}
                      </td>
                      <td>
                        <IconButton
                          label={`Edit category for ${t.name} on ${t.date}`}
                          onClick={() => {
                            setEdit(t)
                            setCategory(t.category)
                            setError('')
                          }}
                        >
                          <Pencil size={14} />
                        </IconButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-pagination">
              <span>
                {shownPage * 12 + 1}–{Math.min((shownPage + 1) * 12, rows.length)} of {rows.length}{' '}
                transactions
              </span>
              <div>
                <IconButton
                  label="Previous page"
                  disabled={shownPage === 0}
                  onClick={() => setPage(shownPage - 1)}
                >
                  <ChevronLeft size={17} />
                </IconButton>
                <span>
                  {shownPage + 1} / {totalPages}
                </span>
                <IconButton
                  label="Next page"
                  disabled={shownPage >= totalPages - 1}
                  onClick={() => setPage(shownPage + 1)}
                >
                  <ChevronRight size={17} />
                </IconButton>
              </div>
            </div>
          </>
        ) : (
          <EmptyState title="A clean slate.">
            No transactions match this view. Try another search or import your activity.
          </EmptyState>
        )}
      </section>
      {error && !edit && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <Footnote>
        History helps you estimate patterns. Your current funds are a separate confirmed snapshot;
        these past transactions are not subtracted again.
      </Footnote>
      {edit && (
        <Modal
          open
          onClose={() => setEdit(null)}
          title="Give it the right place."
          description={`${edit.name} · ${shortDate(edit.date)} · ${money(Math.abs(edit.amountCents), true)}`}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void update(edit.id, category)
            }}
          >
            <Field
              label="Spending category"
              hint="Your daily spending estimate stays as you confirmed it. Review your plan if that estimate needs changing."
            >
              <input
                required
                maxLength={80}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                list="category-options"
              />
              <datalist id="category-options">
                {[
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
                ].map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            <div className="form-actions">
              <Button variant="ghost" onClick={() => setEdit(null)} type="button">
                Cancel
              </Button>
              <Button loading={busy}>Save category</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
