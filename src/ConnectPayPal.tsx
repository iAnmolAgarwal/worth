import { useEffect, useRef, useState } from 'react'
import { CircleAlert, FileUp, LoaderCircle, LogIn } from 'lucide-react'
import { api, ApiError } from './api'
import type { AppState } from './contract'
import { cx, shortDate } from './format'
import type { ChosenFile } from './Onboarding'
import { Alert, Button } from './ui'

/**
 * Connect PayPal (final-day plan §2): log in at PayPal and Worth reads the activity through PayPal's
 * MCP server, then the same review step as a CSV export. The server holds PayPal's access for one
 * read and never sends it here; this file only navigates to the login and asks for the activity.
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
}: {
  disabled?: boolean
  /** Come back to the store's item on /check after the import. */
  returnTo?: 'check'
  /** Show the line before PayPal as a popover under the button. */
  pop?: boolean
}) {
  const [asking, setAsking] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const popover = useRef<HTMLDivElement>(null)
  // A strip near the fold would hide the popover's lower half; bring all of it into view.
  useEffect(() => {
    if (pop && asking) popover.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [pop, asking])
  const button = (
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
      <p className="caption">
        PayPal’s screen will name <b>“Default Application”</b> (PayPal’s MCP connector) and ask to
        access your transaction data. Worth reads your activity once, then forgets the access. It
        can’t pay, invoice or move money. Sandbox accounts only.
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
        <button type="button" className="link" onClick={() => setAsking(false)} disabled={leaving}>
          Not now
        </button>
      </div>
    </div>
  )
  if (pop)
    return (
      <span className="connect-pop-wrap">
        {button}
        {asking && ask}
      </span>
    )
  return asking ? ask : button
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
          . Worth has already forgotten PayPal’s access.
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
