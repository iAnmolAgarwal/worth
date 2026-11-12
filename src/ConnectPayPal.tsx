import { useEffect, useRef, useState } from 'react'
import { CircleAlert, FileUp, LoaderCircle, LogIn } from 'lucide-react'
import { api, ApiError } from './api'
import type { AppState } from './contract'
import { shortDate } from './format'
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
 * The card's primary action. The first click shows what PayPal's screen will say, honestly, before
 * leaving Worth; "Continue to PayPal" starts the login on the server.
 */
export function ConnectPayPalButton({ disabled }: { disabled?: boolean }) {
  const [asking, setAsking] = useState(false)
  const [leaving, setLeaving] = useState(false)
  if (!asking)
    return (
      <Button
        icon={LogIn}
        className="connect-btn"
        disabled={disabled}
        onClick={() => setAsking(true)}
      >
        Connect PayPal
      </Button>
    )
  return (
    <div className="connect-ask" role="group" aria-label="Connect PayPal">
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
