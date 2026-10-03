import { useState } from 'react'
import {
  Bookmark,
  BookmarkCheck,
  CircleAlert,
  Database,
  Info,
  Sparkles,
  Trash2,
} from 'lucide-react'
import type { Product } from '../shared/types'
import { api } from './api'
import { ClaudeSwitch, JudgeBadge } from './Ask'
import { CLAUDE_SHARED_DATA, claudeUses } from './copy'
import { boughtProductIds, claudeOn } from './engine'
import type { AppState } from './contract'
import { isActive } from './contract'
import { shortDate, money } from './format'
import { Alert, Button, Dialog, Pill } from './ui'

const PLANNED_KEY = 'worth:planned'
/** Wait dates the viewer chose ("Plan to buy on…"): a per-browser convenience, never shared. */
export function readPlanned(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(PLANNED_KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}
export function writePlanned(productId: string, date: string | undefined) {
  try {
    const planned = readPlanned()
    if (date) planned[productId] = date
    else delete planned[productId]
    localStorage.setItem(PLANNED_KEY, JSON.stringify(planned))
  } catch {
    /* Storage can be unavailable; the plan still saves the item. */
  }
}

function Card({
  product,
  saved,
  planned,
  bought,
  onOpen,
  onToggle,
}: {
  product: Product
  saved: boolean
  bought: boolean
  planned?: string
  onOpen: () => void
  onToggle: () => void
}) {
  return (
    <article className="saved-card">
      <img className="hide-m" src={product.image} alt={product.name} />
      <div className="row plain show-m" style={{ padding: 0 }}>
        <img className="thumb" src={product.image} alt="" />
        <div className="body">
          <div className="t" style={{ fontSize: 'var(--fs-body)' }}>
            {product.name}
          </div>
          <div className="s soft">{product.merchant}</div>
        </div>
        <div className="amt num" style={{ fontSize: 'var(--fs-body)' }}>
          {money(product.priceCents)}
        </div>
      </div>
      <div className="hide-m">
        <div className="t">{product.name}</div>
        <div className="meta">{product.merchant}</div>
        <div className="num strong" style={{ fontWeight: 700, marginTop: 4 }}>
          {money(product.priceCents)}
        </div>
      </div>
      {bought ? (
        <Pill tone="ok">Bought</Pill>
      ) : (
        planned && <Pill tone="sug">Planned for {shortDate(planned)}</Pill>
      )}
      <div className="foot">
        {bought ? (
          <button type="button" className="link" onClick={onOpen}>
            View
          </button>
        ) : (
          <button
            type="button"
            className="link"
            onClick={onOpen}
            aria-label={`Check ${product.name}`}
          >
            Check
          </button>
        )}
        <button
          type="button"
          className="icon-btn quiet"
          aria-pressed={saved}
          aria-label={saved ? `Remove ${product.name} from Saved` : `Save ${product.name}`}
          onClick={onToggle}
        >
          {saved ? (
            <BookmarkCheck className="ico" aria-hidden="true" />
          ) : (
            <Bookmark className="ico" aria-hidden="true" />
          )}
        </button>
      </div>
    </article>
  )
}

export function Saved({
  state,
  onOpen,
  onUpdate,
  onToast,
}: {
  state: AppState
  onOpen: (product: Product) => void
  onUpdate: (state: AppState) => void
  onToast: (text: string) => void
}) {
  const planned = readPlanned()
  const bought = boughtProductIds(state)
  const saved = state.products.filter((p) => state.wishlist.includes(p.id))
  const more = state.products.filter((p) => !state.wishlist.includes(p.id))
  async function toggle(product: Product) {
    try {
      onUpdate((await api<AppState>('/wishlist', { productId: product.id })) as AppState)
      if (state.wishlist.includes(product.id)) writePlanned(product.id, undefined)
    } catch (failure) {
      onToast((failure as Error).message)
    }
  }
  const card = (product: Product) => (
    <Card
      key={product.id}
      product={product}
      saved={state.wishlist.includes(product.id)}
      bought={bought.has(product.id)}
      planned={
        planned[product.id] && planned[product.id]! >= state.today ? planned[product.id] : undefined
      }
      onOpen={() => onOpen(product)}
      onToggle={() => void toggle(product)}
    />
  )
  return (
    <div className="page plain">
      <div className="wrap">
        <h1 className="title" style={{ marginBottom: 'var(--s-6)' }}>
          Saved
        </h1>
        {saved.length ? (
          <div className="saved-grid">{saved.map(card)}</div>
        ) : (
          <p className="meta">Nothing saved yet. Save an item to check it again later.</p>
        )}
        {more.length > 0 && (
          <>
            <h2 className="list-head">
              More from {state.products[0]?.merchant ?? 'the demo store'}
            </h2>
            <div className="saved-grid">{more.map(card)}</div>
          </>
        )}
        <p className="caption" style={{ marginTop: 'var(--s-6)' }}>
          A demo store for the PayPal sandbox. Nothing is sold or shipped.
        </p>
      </div>
    </div>
  )
}

export function Settings({
  state,
  onUpdate,
  onReset,
  onEditPlan,
  onImport,
}: {
  state: AppState
  onUpdate: (state: AppState) => void
  onReset: (state: AppState) => void
  onEditPlan: (step: number) => void
  onImport: () => void
}) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = state.purchases.some(isActive)
  async function reset() {
    setBusy(true)
    setError('')
    try {
      onReset((await api<AppState>('/reset', {})) as AppState)
      setConfirm(false)
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const browserZone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      return undefined
    }
  })()
  return (
    <div className="page plain">
      <div className="wrap narrow">
        <h1 className="title" style={{ marginBottom: 'var(--s-6)' }}>
          Settings and privacy
        </h1>
        <div className="stack">
          <section className="tile" aria-labelledby="set-claude">
            <div className="sec-head">
              <h2 className="h-section" id="set-claude">
                <Sparkles
                  size={18}
                  aria-hidden="true"
                  style={{ verticalAlign: -3, marginRight: 8 }}
                />
                Ask Worth assistant
              </h2>
            </div>
            <ClaudeSwitch state={state} onUpdate={onUpdate} />
            <h3 className="meta strong" style={{ margin: '16px 0 4px', fontWeight: 700 }}>
              What goes to Anthropic (Claude)
            </h3>
            <dl className="kvlist">
              {claudeUses(claudeOn(state)).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <details className="quiet-details">
              <summary>Everything sent to Anthropic (Claude)</summary>
              <p className="caption">
                When the assistant is on, these go to Anthropic (Claude): {CLAUDE_SHARED_DATA}.
              </p>
            </details>
          </section>
          <section className="tile" aria-labelledby="set-data">
            <div className="sec-head">
              <h2 className="h-section" id="set-data">
                <Database
                  size={18}
                  aria-hidden="true"
                  style={{ verticalAlign: -3, marginRight: 8 }}
                />
                Data
              </h2>
            </div>
            <dl className="kvlist">
              <div>
                <dt>Your data</dt>
                <dd>
                  {state.profile.source === 'demo'
                    ? 'Sample data'
                    : `Imported · ${state.profile.coverageDays} days`}
                </dd>
              </div>
              <div>
                <dt>Time zone</dt>
                <dd>
                  {state.profile.timezone}{' '}
                  <button
                    type="button"
                    className="link"
                    style={{ minHeight: 0, marginLeft: 8 }}
                    onClick={() => onEditPlan(0)}
                  >
                    Change
                  </button>
                  {browserZone && browserZone !== state.profile.timezone && (
                    <span className="caption">This browser: {browserZone}</span>
                  )}
                </dd>
              </div>
            </dl>
            <div className="actions" style={{ marginTop: 12 }}>
              <Button variant="secondary" onClick={onImport}>
                Import PayPal activity
              </Button>
              <Button
                variant="danger"
                icon={Trash2}
                disabled={active}
                onClick={() => setConfirm(true)}
              >
                Delete my data now
              </Button>
            </div>
            {active && (
              <p className="caption" style={{ marginTop: 8 }}>
                Finish or cancel your checkout before deleting your data.
              </p>
            )}
          </section>
          <section className="tile" aria-labelledby="set-about">
            <div className="sec-head">
              <h2 className="h-section" id="set-about">
                <Info size={18} aria-hidden="true" style={{ verticalAlign: -3, marginRight: 8 }} />
                About this demo
              </h2>
            </div>
            <p style={{ marginBottom: 12 }}>
              <JudgeBadge state={state} />
            </p>
            <p className="meta">
              Worth is an independent hackathon app, not a PayPal product. Checkout runs in the
              PayPal sandbox, so no real money moves.{' '}
              <a
                href="https://github.com/iAnmolAgarwal/worth#readme"
                target="_blank"
                rel="noreferrer"
              >
                Read the README
              </a>
            </p>
          </section>
        </div>
      </div>
      {confirm && (
        <Dialog
          title="Delete your data?"
          onClose={() => setConfirm(false)}
          dismissible={!busy}
          footer={
            <>
              {error && (
                <p className="co-error" role="alert">
                  {error}
                </p>
              )}
              <Button block loading={busy} onClick={() => void reset()}>
                Delete and start over
              </Button>
              <Button variant="text" onClick={() => setConfirm(false)} disabled={busy}>
                Keep my data
              </Button>
            </>
          }
        >
          <Alert tone="bad" icon={CircleAlert}>
            Your imported history, your plan and your Worth purchase records are deleted. Worth
            starts again with the sample profile.
          </Alert>
        </Dialog>
      )}
    </div>
  )
}
