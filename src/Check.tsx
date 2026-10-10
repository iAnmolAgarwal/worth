import { useEffect, useState, type MouseEvent } from 'react'
import { Bookmark, CircleAlert, Clock, Info } from 'lucide-react'
import { payIn4InRange } from '../shared/finance'
import type { AppState, HandoffOpened, HandoffQuote, SavedItem } from '../shared/types'
import { api, ApiError } from './api'
import { Decision, EditPurchase, type DecisionRequest } from './Decision'
import { dayLabel, money } from './format'
import type { PayPalSdkInstance } from './paypalSdk'
import { Alert, Button } from './ui'

/**
 * /check: where a store's "Analyse with Worth" lands (specs/handoff-contract.md §3.3). The signed
 * quote arrives in the fragment, so it never reaches a server log or a Referer; it is read once,
 * removed from the address bar, and sent to Worth's own server to verify.
 */

/** The `#q=` token, removed from the URL as it is read. Undefined without one. */
export function takeHandoffToken(
  location: Pick<Location, 'pathname' | 'search' | 'hash'> = window.location,
  history: Pick<History, 'replaceState'> = window.history,
): string | undefined {
  if (!location.hash.startsWith('#q=')) return undefined
  const raw = location.hash.slice(3)
  history.replaceState(null, '', location.pathname + location.search)
  try {
    return decodeURIComponent(raw) || undefined
  } catch {
    return raw || undefined
  }
}
let captured: { token?: string } | undefined
/** The token, read once per page load however often the app renders. */
export function handoffToken() {
  captured ??= { token: takeHandoffToken() }
  return captured.token
}

/** Leaves Worth for the store, or reloads for a new link; a seam so tests can watch it. */
export const leave = {
  to: (url: string) => window.location.assign(url),
  reload: () => window.location.reload(),
}
/**
 * A new `#q=` while the page is already open (a pasted or second store link) is a same-document
 * navigation, so the token read on load is stale. Reloading reads and clears the new one.
 */
export function reloadForNewToken(location: Pick<Location, 'pathname' | 'hash'> = window.location) {
  if (location.pathname !== '/check' || !location.hash.startsWith('#q=')) return false
  leave.reload()
  return true
}
/** One request per token, shared by React's development double mount. */
const opening = new Map<string, Promise<HandoffOpened>>()
/** The last quote shown, so returning to /check from another screen needs no request. */
let shown: HandoffQuote | undefined
const QID_KEY = 'worth.check.qid'
function rememberQid(qid: string) {
  try {
    sessionStorage.setItem(QID_KEY, qid)
  } catch {
    // Private windows can refuse storage; the quote is then shown until the page reloads.
  }
}
function rememberedQid() {
  try {
    return sessionStorage.getItem(QID_KEY) ?? undefined
  } catch {
    return undefined
  }
}
/** For tests: forget the token and quote this page load has seen. */
export function resetHandoff() {
  captured = undefined
  shown = undefined
  opening.clear()
}

type View =
  | { kind: 'loading' }
  | { kind: 'ok'; quote: HandoffQuote }
  /** Bad format, key, signature, shape or origin, or no link at all: no way back is offered. */
  | { kind: 'unverified'; message: string }
  | { kind: 'expired'; message: string; merchant: string; returnUrl: string }
  | { kind: 'currency'; message: string; merchant: string; returnUrl: string; item: string }
  | { kind: 'failed'; message: string }

const UNVERIFIED =
  'We couldn’t verify this link from the store. You can still check the item yourself.'

function failure(error: unknown): View {
  const details = error instanceof ApiError ? (error.details as Record<string, string>) : undefined
  const message = (error as Error).message
  if (error instanceof ApiError && error.code === 'HANDOFF_EXPIRED' && details?.returnUrl)
    return {
      kind: 'expired',
      message,
      merchant: details.merchant ?? 'the store',
      returnUrl: details.returnUrl,
    }
  if (error instanceof ApiError && error.code === 'HANDOFF_CURRENCY' && details?.returnUrl)
    return {
      kind: 'currency',
      message,
      merchant: details.merchant ?? 'the store',
      returnUrl: details.returnUrl,
      item: details.item ?? '',
    }
  // A body the server couldn't even read (too large, not JSON) is an unverifiable link too.
  if (
    error instanceof ApiError &&
    (error.code === 'HANDOFF_UNVERIFIED' || [400, 404, 413].includes(error.status))
  )
    return { kind: 'unverified', message: UNVERIFIED }
  // The rate limit and network failures keep their own message and can be tried again.
  return { kind: 'failed', message }
}

/** §3.2: the store's own Pay in 4 answer applies only to the price it was asked about. */
export function payLaterLine(quote: HandoffQuote, amountCents: number) {
  if (!payIn4InRange(amountCents)) return undefined
  const answer = amountCents === quote.amountCents ? quote.payLater : 'unknown'
  if (answer === 'offered') return `${quote.merchant} offers PayPal Pay in 4 for this amount.`
  if (answer === 'not-offered')
    return `${quote.merchant} doesn’t offer PayPal Pay in 4 for this amount.`
  return 'If this store offers PayPal Pay in 4, compare it below.'
}

/** A link back to the store, which the browser follows like any other. */
function StoreLink({
  href,
  merchant,
  onClick,
  busy,
}: {
  href: string
  merchant: string
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void
  busy?: boolean
}) {
  return (
    <a
      className="btn btn-primary btn-block"
      href={href}
      rel="noreferrer"
      onClick={onClick}
      aria-busy={busy || undefined}
    >
      Back to {merchant}
    </a>
  )
}

export function Check({
  state,
  token,
  instance,
  onUpdate,
  onToast,
  onOpenDecision,
  onNavigate,
}: {
  state: AppState
  token?: string
  instance?: PayPalSdkInstance
  onUpdate: (next: AppState) => void
  onToast: (message: string) => void
  /** Opens the normal decision for an item the shopper typed in. */
  onOpenDecision: (request: DecisionRequest) => void
  onNavigate: (hash: string) => void
}) {
  const [view, setView] = useState<View>(() =>
    shown && (!token || opening.has(token)) ? { kind: 'ok', quote: shown } : { kind: 'loading' },
  )
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (view.kind === 'ok') return
    let cancelled = false
    const qid = token ? undefined : rememberedQid()
    // Tokens over 4 KB are refused unread, so one is never sent.
    if ((!token && !qid) || (token && token.length > 4096)) {
      // oxlint-disable-next-line react/set-state-in-effect
      setView({ kind: 'unverified', message: UNVERIFIED })
      return
    }
    const request: Promise<{ quote: HandoffQuote; state?: AppState; replay?: boolean }> = token
      ? (opening.get(token) ??
        opening
          .set(token, api<HandoffOpened>('/handoff/open', { token }))
          .get(token)!
          .catch((error) => {
            // A failed request can be tried again; a verified one is never sent twice.
            opening.delete(token)
            throw error
          }))
      : api<{ quote: HandoffQuote }>(`/handoff/quotes/${encodeURIComponent(qid!)}`)
    request
      .then((result) => {
        if (cancelled) return
        shown = result.quote
        rememberQid(result.quote.qid)
        if (result.state) onUpdate(result.state)
        if (result.replay) onToast('Showing the video scenario: Maya on Sat, Oct 3, 2026.')
        setView({ kind: 'ok', quote: result.quote })
      })
      .catch((error) => !cancelled && setView(failure(error)))
    return () => {
      cancelled = true
    }
    // Runs once per attempt; the token never changes on a page.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  if (view.kind === 'ok')
    return (
      <Quote
        quote={view.quote}
        state={state}
        instance={instance}
        onUpdate={onUpdate}
        onToast={onToast}
        onNavigate={onNavigate}
      />
    )
  return (
    <div className="page plain">
      <div className="wrap narrow">
        {view.kind === 'loading' ? (
          <div className="stack" aria-busy="true">
            <span className="sk" style={{ width: '60%', height: 28 }} />
            <span className="sk" style={{ width: '80%' }} />
            <p className="caption" role="status">
              Checking the link from the store…
            </p>
          </div>
        ) : (
          <div className="stack">
            <h1 className="title">
              {view.kind === 'expired'
                ? 'This link has expired'
                : view.kind === 'currency'
                  ? 'US dollar prices only'
                  : view.kind === 'failed'
                    ? 'Worth couldn’t open this link'
                    : 'Check an item yourself'}
            </h1>
            <Alert
              tone={view.kind === 'currency' ? 'info' : 'warn'}
              icon={view.kind === 'expired' ? Clock : view.kind === 'currency' ? Info : CircleAlert}
              live
            >
              {view.message}
            </Alert>
            {view.kind === 'failed' && (
              <div>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setView({ kind: 'loading' })
                    setAttempt((value) => value + 1)
                  }}
                >
                  Try again
                </Button>
              </div>
            )}
            {(view.kind === 'unverified' || view.kind === 'currency') && (
              <section className="tile" aria-labelledby="check-yourself">
                <h2 className="h-section" id="check-yourself">
                  What are you thinking of buying?
                </h2>
                <EditPurchase
                  name={view.kind === 'currency' ? view.item : ''}
                  submitLabel="Check it"
                  onSubmit={(next) => onOpenDecision(next)}
                />
              </section>
            )}
            {(view.kind === 'expired' || view.kind === 'currency') && (
              <div>
                <StoreLink href={view.returnUrl} merchant={view.merchant} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Quote({
  quote,
  state,
  instance,
  onUpdate,
  onToast,
  onNavigate,
}: {
  quote: HandoffQuote
  state: AppState
  instance?: PayPalSdkInstance
  onUpdate: (next: AppState) => void
  onToast: (message: string) => void
  onNavigate: (hash: string) => void
}) {
  /** The shopper's correction: a user-claimed price, judged instead of the store's. */
  const [claimed, setClaimed] = useState<{ itemName: string; amountCents: number }>()
  const [editing, setEditing] = useState(false)
  const [consent, setConsent] = useState(quote.consent)
  const [leaving, setLeaving] = useState(false)
  const [saving, setSaving] = useState(false)
  /** The day this quote was saved for, once saved. */
  const [savedFor, setSavedFor] = useState<string>()
  const itemName = claimed?.itemName ?? quote.item
  const amountCents = claimed?.amountCents ?? quote.amountCents
  // Only the session holding the quote can use it; another one compares like a typed-in item.
  const request: DecisionRequest = {
    amountCents,
    itemName,
    ...(quote.canConsent ? { qid: quote.qid } : {}),
  }
  const p4 = payLaterLine(quote, amountCents)
  /** Worth's answer names no price, so the store only ever gets it for its own price. */
  const priceChanged = amountCents !== quote.amountCents

  async function back(event: MouseEvent<HTMLAnchorElement>) {
    // A new-tab click keeps the plain link; the verdict rides on a normal click.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return
    event.preventDefault()
    if (leaving) return
    setLeaving(true)
    let url = quote.returnUrl
    try {
      const result = await api<{ url: string }>('/handoff/return', {
        qid: quote.qid,
        ...(priceChanged ? { amountCents } : {}),
      })
      if (new URL(result.url).origin === new URL(quote.returnUrl).origin) url = result.url
    } catch {
      // The plain link still goes back; the store then shows no Worth line.
    }
    leave.to(url)
  }
  /**
   * Save for the wait plan's day (contract §4). Only the quote and the day are sent; the server
   * takes the link, the store's name and its price from the quote. A changed price or name is
   * sent as the shopper's own, and saved as such.
   */
  async function save(waitDate: string) {
    if (saving) return
    setSaving(true)
    try {
      const result = await api<{ item: SavedItem; state: AppState }>('/handoff/save', {
        qid: quote.qid,
        waitDate,
        ...(priceChanged ? { amountCents } : {}),
        ...(itemName !== quote.item ? { itemName } : {}),
      })
      onUpdate(result.state)
      setSavedFor(waitDate)
      onToast(`Saved for ${dayLabel(waitDate)}. Find it in Saved.`)
    } catch (error) {
      onToast((error as Error).message)
    } finally {
      setSaving(false)
    }
  }
  async function choose(next: boolean) {
    setConsent(next)
    try {
      await api('/handoff/consent', { qid: quote.qid, consent: next })
    } catch (error) {
      setConsent(!next)
      onToast((error as Error).message)
    }
  }

  const intro = (
    <div className="stack tight">
      {editing ? (
        <EditPurchase
          name={itemName}
          amountCents={amountCents}
          onCancel={() => setEditing(false)}
          onSubmit={(next) => {
            setEditing(false)
            setClaimed(
              next.amountCents === quote.amountCents && next.itemName === quote.item
                ? undefined
                : next,
            )
          }}
        />
      ) : (
        <div>
          <span
            className="readas"
            role="group"
            aria-label={`${claimed ? 'You entered' : `From ${quote.merchant}`} · ${itemName} · ${money(amountCents)}`}
          >
            <span className="lbl">{claimed ? 'You entered' : `From ${quote.merchant}`}</span>
            <span className="val">
              {itemName} · <span className="num">{money(amountCents)}</span>
            </span>
            <button className="edit" type="button" onClick={() => setEditing(true)}>
              Not right? Edit
            </button>
          </span>
        </div>
      )}
      {claimed && (
        <p className="caption" style={{ margin: 0 }}>
          {quote.merchant}’s price was {money(quote.amountCents)}. Worth is checking the price you
          entered.
          {priceChanged &&
            ` ${quote.merchant} won’t show Worth’s answer, because you changed the price.`}{' '}
          <button type="button" className="link inline" onClick={() => setClaimed(undefined)}>
            Use the store’s price
          </button>
        </p>
      )}
      {p4 && (
        <p className="meta" style={{ margin: 0 }}>
          {p4}
        </p>
      )}
    </div>
  )
  const footer = quote.canConsent && (
    <label className="check">
      <input
        type="checkbox"
        checked={consent}
        onChange={(event) => void choose(event.target.checked)}
      />
      <span>
        Let {quote.merchant} tell Worth if I buy this, so it shows once in my Activity
        <small>Off unless you tick it. The store learns nothing about your plan.</small>
      </span>
    </label>
  )
  return (
    <Decision
      key={JSON.stringify(request)}
      state={state}
      request={request}
      instance={instance}
      backLabel="Back to Home"
      onBack={() => onNavigate('home')}
      onBuy={() => undefined}
      onSave={() => undefined}
      onViewActivity={() => onNavigate('activity')}
      handoff={{
        intro,
        footer,
        merchant: quote.merchant,
        imageUrl: quote.imageUrl,
        actions: (notes, c) => (
          <>
            <StoreLink
              href={quote.returnUrl}
              merchant={quote.merchant}
              onClick={(event) => void back(event)}
              busy={leaving}
            />
            {quote.canConsent && c.recommendation === 'wait' && c.wait.date && (
              <Button
                block
                variant="secondary"
                icon={Bookmark}
                loading={saving}
                disabled={savedFor === c.wait.date}
                onClick={() => void save(c.wait.date!)}
              >
                {savedFor === c.wait.date ? 'Saved' : `Save for ${dayLabel(c.wait.date)}`}
              </Button>
            )}
            {notes && (
              <p className="caption" style={{ textAlign: 'center' }}>
                You pay on {quote.merchant}’s own checkout. Worth never sees or changes your order.
              </p>
            )}
          </>
        ),
      }}
    />
  )
}
