import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { CircleAlert, FileUp, LoaderCircle, LogIn } from 'lucide-react'
import { api, ApiError } from './api'
import type { AppState } from './contract'
import { cx, shortDate } from './format'
import type { ChosenFile } from './Onboarding'
import { Alert, Button } from './ui'

/**
 * Connect PayPal (final-day plan §2): log in at PayPal and Worth reads the activity through PayPal's
 * MCP server, then the same review step as a CSV export. The server keeps PayPal's access so it
 * can re-read the activity later, and never sends it here; this file only navigates to the login,
 * asks for the activity and asks the server to re-read it.
 */

/** What the server read, as /api/paypal/activity reports it. */
export interface ConnectedSummary {
  transactions: number
  first?: string
  last?: string
  searchedDays: number
  skipped: number
  truncated: boolean
}

export const CONNECTED_FILE_NAME = 'Your PayPal sandbox activity'
/** Fewer days than this can't show a monthly bill twice. */
const SHORT_HISTORY_DAYS = 45
/** Set for the rest of the visit once PayPal's MCP server didn't answer in time: the health gate. */
const HIDDEN_KEY = 'worth.paypalConnect.hidden'
/** Set when the login began on /check, so the verdict follows the import. One fixed value only. */
const RETURN_KEY = 'worth.paypalConnect.return'

function hiddenForVisit() {
  try {
    return sessionStorage.getItem(HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}
function hideForVisit() {
  try {
    sessionStorage.setItem(HIDDEN_KEY, '1')
  } catch {
    // Without storage the button simply stays; the CSV path is shown either way.
  }
}

/**
 * After an import that began on /check: true once, and the caller goes back to /check, which
 * reopens the store's item from this tab's remembered quote. Never a URL from anywhere else.
 */
export function returnToCheck() {
  try {
    const value = sessionStorage.getItem(RETURN_KEY)
    sessionStorage.removeItem(RETURN_KEY)
    return value === 'check'
  } catch {
    return false
  }
}

/** What a background PayPal read changed, as /api/paypal/sync reports it. */
export interface SyncChanges {
  transactions: number
  plans: number
  paid: number
}
/** A connected plan is re-read in the background once its last read is older than this. */
export const SYNC_AFTER_MS = 15 * 60_000

/** "Updated from PayPal: 1 new Pay in 4 plan", or undefined when nothing changed. */
export function syncSentence(changes: SyncChanges) {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const parts = [
    changes.plans && count(changes.plans, 'new Pay in 4 plan', 'new Pay in 4 plans'),
    changes.paid && count(changes.paid, 'Pay in 4 payment made', 'Pay in 4 payments made'),
    changes.transactions && count(changes.transactions, 'new transaction', 'new transactions'),
  ].filter(Boolean)
  return parts.length ? `Updated from PayPal: ${parts.join(', ')}.` : undefined
}

/**
 * One background read at a time for this page, shared by the app (on load) and the hero's refresh
 * button. The server also refuses a second read for the same session.
 */
let syncing = false
const listeners = new Set<() => void>()
let handlers: { onState: (state: AppState) => void; onToast: (text: string) => void } | undefined
function setSyncing(value: boolean) {
  syncing = value
  for (const listener of listeners) listener()
}
/** The app's way to apply a sync's result: its new state and the toast. */
export function setSyncHandlers(next: typeof handlers) {
  handlers = next
}
export function useSyncing() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => syncing,
  )
}
/** Whether a connected plan's last read is old enough for a background re-read. */
export function syncDue(state: AppState, now = Date.now()) {
  const at = state.profile.importedAt ? Date.parse(state.profile.importedAt) : Number.NaN
  return (
    Boolean(state.config.paypalLinked) &&
    state.profile.source === 'import' &&
    state.profile.importedFrom === 'paypal' &&
    (!Number.isFinite(at) || now - at > SYNC_AFTER_MS)
  )
}
/**
 * Re-reads the connected PayPal activity without a login and applies it. A link PayPal no longer
 * honours returns the row to Connect PayPal (the plan is untouched); other failures are silent and
 * the next visit tries again.
 */
export async function syncFromPayPal() {
  if (syncing) return
  setSyncing(true)
  try {
    const result = await api<{ state: AppState; changes: SyncChanges }>('/paypal/sync', {})
    handlers?.onState(result.state)
    const sentence = syncSentence(result.changes)
    if (sentence) handlers?.onToast(sentence)
  } catch (failure) {
    if (failure instanceof ApiError && failure.code === 'NOT_CONNECTED')
      await api<AppState>('/state').then(
        (state) => handlers?.onState(state),
        () => undefined,
      )
  } finally {
    setSyncing(false)
  }
}

/** Whether to offer Connect PayPal: on at the server and not gated off earlier in this visit. */
export function connectAvailable(state: AppState) {
  return state.config.paypalConnect === 'on' && !hiddenForVisit()
}

/** The day span of a read, first to last activity, counting both days. */
export function historyDays(summary: ConnectedSummary) {
  if (!summary.first || !summary.last) return 0
  return Math.round((Date.parse(summary.last) - Date.parse(summary.first)) / 86_400_000) + 1
}

/**
 * The primary way in. The first click shows what PayPal's screen will say, honestly, before leaving
 * Worth; "Continue to PayPal" starts the login on the server. In the slim start strip (`pop`) that
 * line opens under the button, so the strip stays one row.
 */
export function ConnectPayPalButton({
  disabled,
  returnTo,
  pop,
  trigger,
}: {
  disabled?: boolean
  /** Come back to the store's item on /check after the import. */
  returnTo?: 'check'
  /** Show the line before PayPal as a popover under the button. */
  pop?: boolean
  /** A control of the caller's own (such as Home's hero row) in place of the standard button. */
  trigger?: (props: {
    onClick: () => void
    'aria-expanded'?: boolean
    disabled?: boolean
  }) => ReactNode
}) {
  const [asking, setAsking] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const popover = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLSpanElement>(null)
  /** Set when the note is dismissed, so focus goes back to what opened it. */
  const refocus = useRef(false)
  const close = () => {
    refocus.current = true
    setAsking(false)
  }
  // A row near the fold would hide the note's lower half; bring all of it into view.
  useEffect(() => {
    if (pop && asking) popover.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [pop, asking])
  // Escape dismisses the note, as Not now does.
  useEffect(() => {
    if (!asking || leaving) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [asking, leaving])
  useEffect(() => {
    if (asking || !refocus.current) return
    refocus.current = false
    root.current?.querySelector<HTMLElement>('button')?.focus()
  }, [asking])
  const button = trigger ? (
    trigger({
      onClick: () => setAsking(pop ? !asking : true),
      'aria-expanded': pop ? asking : undefined,
      disabled,
    })
  ) : (
    <Button
      icon={LogIn}
      className="connect-btn"
      disabled={disabled}
      aria-expanded={pop ? asking : undefined}
      onClick={() => setAsking(pop ? !asking : true)}
    >
      Connect PayPal
    </Button>
  )
  const ask = (
    <div
      ref={popover}
      className={cx('connect-ask', pop && 'connect-pop')}
      role="group"
      aria-label="Connect PayPal"
    >
      <p>
        You’ll sign in on PayPal’s own page, not here. PayPal shows the connection as “Default
        Application”: that’s PayPal’s connector name.
      </p>
      <p className="caption">
        PayPal’s permission list is broader than what Worth uses. Worth only reads your activity; it
        can’t pay or move money.
      </p>
      <p className="caption">
        This demo works with PayPal test (sandbox) accounts. Disconnect any time in Settings.
      </p>
      <div className="connect-ask-actions">
        <Button
          icon={LogIn}
          loading={leaving}
          disabled={disabled || leaving}
          onClick={() => {
            setLeaving(true)
            try {
              if (returnTo) sessionStorage.setItem(RETURN_KEY, returnTo)
              else sessionStorage.removeItem(RETURN_KEY)
            } catch {
              // Without storage the import ends on Home, as it does from Home.
            }
            window.location.assign('/api/paypal/connect')
          }}
        >
          Continue to PayPal
        </Button>
        <button type="button" className="link" onClick={close} disabled={leaving}>
          Not now
        </button>
      </div>
    </div>
  )
  if (pop)
    return (
      <span className="connect-pop-wrap" ref={root}>
        {button}
        {asking && ask}
      </span>
    )
  return (
    <span className="connect-wrap" ref={root}>
      {asking ? ask : button}
    </span>
  )
}

/**
 * On /check while the sample plan is showing: one line and Connect PayPal, so the store's item is
 * judged against the shopper's own PayPal activity instead.
 */
export function ConnectOnCheck() {
  return (
    <span className="check-connect">
      <span>This answer uses the sample plan. Connect PayPal to check it against your own.</span>
      <ConnectPayPalButton returnTo="check" />
    </span>
  )
}

const RESULT_MESSAGES: Record<string, string> = {
  denied: 'You didn’t allow access in PayPal, so Worth read nothing.',
  expired: 'That PayPal login expired or began in another tab. Connect again to continue.',
  failed: 'PayPal couldn’t complete the login. Try again, or use a CSV export.',
  off: 'Connect PayPal is off on this server. Use a CSV export instead.',
}

/**
 * Where PayPal's login returns (#import?connect=…): reads the activity once, then hands it to the
 * review step as a file. A failure says what happened in plain words and offers the CSV path.
 */
export function ConnectProgress({
  result,
  onFile,
  onUseCsv,
}: {
  /** paypal after a login; denied, expired, failed or off otherwise. */
  result: string
  onFile: (file: ChosenFile) => void
  onUseCsv: () => void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  // One read per return from PayPal, even when React runs the effect twice in development.
  const request = useRef<Promise<{ csv: string; summary: ConnectedSummary }> | undefined>(undefined)
  const [error, setError] = useState(
    result === 'paypal' ? '' : (RESULT_MESSAGES[result] ?? RESULT_MESSAGES.failed!),
  )
  const [empty, setEmpty] = useState<ConnectedSummary>()
  const [gated, setGated] = useState(false)
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
    // The address keeps no trace of the login, so a reload doesn't ask PayPal again.
    history.replaceState(null, '', `${window.location.pathname}#import`)
  }, [])
  useEffect(() => {
    if (result !== 'paypal') return
    let cancelled = false
    request.current ??= api('/paypal/activity', {})
    request.current
      .then(({ csv, summary }) => {
        if (cancelled) return
        if (!summary.transactions) return setEmpty(summary)
        onFile({ csv, name: CONNECTED_FILE_NAME, connected: summary })
      })
      .catch((failure: Error) => {
        if (cancelled) return
        if (failure instanceof ApiError && failure.code === 'MCP_TIMEOUT') {
          hideForVisit()
          setGated(true)
        }
        setError(failure.message)
      })
    return () => {
      cancelled = true
    }
    // The read depends on the login result only.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [result])

  const reading = !error && !empty
  return (
    <div className="page plain">
      <div className="wrap narrow stack">
        <h1 className="title" ref={heading} tabIndex={-1}>
          {reading ? 'Reading your PayPal activity' : 'Connect PayPal'}
        </h1>
        {reading && (
          <div className="connect-progress" role="status">
            <LoaderCircle className="ico spin" aria-hidden="true" />
            <div>
              <p>
                Connected. Worth is asking PayPal’s MCP server for your last six months of activity,
                using only its read-only <code>list_transactions</code> tool.
              </p>
              <p className="meta">This takes about 30 seconds.</p>
            </div>
          </div>
        )}
        {empty && (
          <Alert tone="info" icon={CircleAlert}>
            PayPal returned no activity for the last {empty.searchedDays} days, so there’s nothing
            to review. Use a CSV export, or add your bills yourself.
          </Alert>
        )}
        {error && (
          <Alert tone="bad" icon={CircleAlert} live>
            {error}
            {gated && ' Connect PayPal is hidden for the rest of this visit.'}
          </Alert>
        )}
        {!reading && (
          <div className="alt-paths">
            <Button icon={FileUp} onClick={onUseCsv}>
              Use a CSV export instead
            </Button>
            {!gated && result !== 'off' && (
              <button
                type="button"
                className="link"
                onClick={() => window.location.assign('/api/paypal/connect')}
              >
                Connect PayPal again
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The review step's source line for activity read from PayPal: what was read, from where, and
 * whether it's long enough to find repeating bills. Nothing here is invented.
 */
export function ConnectedSource({ summary }: { summary: ConnectedSummary }) {
  const days = historyDays(summary)
  return (
    <div className="connected-src stack tight">
      <p className="src">
        <LogIn className="ico" aria-hidden="true" />
        <span>
          Read from your PayPal sandbox account through PayPal’s MCP server:{' '}
          <b>
            {summary.transactions.toLocaleString('en-US')}{' '}
            {summary.transactions === 1 ? 'transaction' : 'transactions'}
          </b>
          {summary.first && summary.last && (
            <>
              , {shortDate(summary.first)} to {shortDate(summary.last)}
            </>
          )}
          . Worth keeps the connection to refresh it; disconnect in Settings.
        </span>
      </p>
      {days < SHORT_HISTORY_DAYS && (
        <p className="meta">
          That’s {days === 1 ? '1 day' : `${days} days`} of activity: too short to find repeating
          bills, and too short for a fair everyday-spending figure, so check it below. Add your
          bills yourself; Worth doesn’t guess any.
        </p>
      )}
      {summary.truncated && (
        <p className="meta">Only the most recent 10,000 transactions were read.</p>
      )}
    </div>
  )
}
