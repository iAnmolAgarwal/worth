import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { X } from 'lucide-react'
import { getUpcomingFlows } from '../shared/finance'
import type { AppState, Comparison } from './contract'
import { fits } from './engine'
import { capitalize, cx, dayLabel, daysFrom, displayName } from './format'
import { Guide, useLook, type GuideExpression } from './Guide'
import { IconButton } from './ui'

/**
 * The item on the screen the panel opened over (Decision or /check): name, price, store and
 * Worth's verdict there. Only the name and price go to the server, as the conversation's
 * purchase context; the server quotes them and works out the verdict again itself.
 */
export type AskOffer = {
  itemName: string
  amountCents: number
  store?: string
  verdict?: string
}

/** The comparison's verdict in a few words, for the offer chip. */
export function offerVerdict(c: Comparison) {
  if (fits(c.buyToday)) return 'Fits today'
  return c.wait.date ? `Not today · fits ${dayLabel(c.wait.date)}` : 'Not today'
}

const NUDGE_KEY = 'worth.guide.nudged'
const NUDGE_DELAY = 1500
const NUDGE_FOR = 10_000

/**
 * The once-a-session line by the launcher, from the plan itself: the largest payment due in the
 * next 30 days. Nothing is invented; with no such payment it asks a plain question instead.
 */
export function nudgeLine(state: AppState) {
  const fallback = 'Thinking about buying something? Ask me first.'
  if (!state.profile.confirmed) return fallback
  const due = getUpcomingFlows(state.profile, state.today, 30)
    .filter(({ flow }) => flow.kind !== 'income')
    .sort((a, b) => b.flow.amountCents - a.flow.amountCents || a.date.localeCompare(b.date))[0]
  if (!due) return fallback
  const days = daysFrom(state.today, due.date)
  const when = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`
  return `${capitalize(displayName(due.flow.name))} is due ${when}. Ask me before you buy.`
}

function nudgedThisSession() {
  try {
    return sessionStorage.getItem(NUDGE_KEY) === '1'
  } catch {
    return false
  }
}
function rememberNudge() {
  try {
    sessionStorage.setItem(NUDGE_KEY, '1')
  } catch {
    // Storage can be refused in private windows; the nudge then shows once per page load.
  }
}

/**
 * The guide's round button, fixed bottom-right on every screen, and the Ask Worth panel it opens.
 * The panel is non-modal: the page behind stays usable. Its content stays mounted while closed, so
 * a conversation survives navigation. Escape or the close button returns focus to the launcher.
 */
export function AgentLauncher({
  open,
  onOpenChange,
  mood,
  nudge,
  hidden,
  lifted,
  launcher,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mood: GuideExpression
  /** The once-a-session line; none while a dialog or wizard has the screen. */
  nudge?: string
  /** Wizards and dialogs own the screen: the launcher steps aside. */
  hidden?: boolean
  /** On screens with a phone action bar, the launcher sits above it. */
  lifted?: boolean
  launcher: RefObject<HTMLButtonElement | null>
  children: ReactNode
}) {
  const panelId = useId()
  const titleId = useId()
  const panel = useRef<HTMLElement>(null)
  const look = useLook(launcher, !open && !hidden)
  const [blinking, setBlinking] = useState(false)
  const [bubble, setBubble] = useState(false)

  // The nudge appears once per session, a moment after the first screen settles.
  useEffect(() => {
    if (!nudge || hidden || open || nudgedThisSession()) return
    const show = setTimeout(() => {
      rememberNudge()
      setBubble(true)
    }, NUDGE_DELAY)
    return () => clearTimeout(show)
  }, [nudge, hidden, open])
  useEffect(() => {
    if (!bubble) return
    const hide = setTimeout(() => setBubble(false), NUDGE_FOR)
    return () => clearTimeout(hide)
  }, [bubble])
  // A blink now and then (CSS keeps it still under reduced motion).
  useEffect(() => {
    if (open || hidden) return
    let timer: ReturnType<typeof setTimeout>
    const next = () => {
      timer = setTimeout(
        () => {
          setBlinking(true)
          timer = setTimeout(() => {
            setBlinking(false)
            next()
          }, 180)
        },
        4000 + Math.random() * 3000,
      )
    }
    next()
    return () => clearTimeout(timer)
  }, [open, hidden])
  // Opening moves focus into the composer; the page behind keeps its own focus order.
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() =>
      panel.current?.querySelector<HTMLElement>('#ask-q')?.focus(),
    )
    return () => cancelAnimationFrame(frame)
  }, [open])
  useEffect(() => {
    if (hidden && open) onOpenChange(false)
  }, [hidden, open, onOpenChange])

  const close = () => {
    onOpenChange(false)
    requestAnimationFrame(() => launcher.current?.focus())
  }
  return (
    <>
      <div className={cx('agent-dock', lifted && 'lifted')} hidden={hidden || open}>
        {bubble && nudge && (
          <div className="agent-nudge" role="status">
            <button
              type="button"
              className="agent-nudge-text"
              onClick={() => {
                setBubble(false)
                onOpenChange(true)
              }}
            >
              <span className="agent-nudge-who">Worth</span>
              {nudge}
            </button>
            <IconButton label="Dismiss" icon={X} quiet onClick={() => setBubble(false)} />
          </div>
        )}
        <button
          ref={launcher}
          type="button"
          className="agent-fab"
          data-tour="guide"
          aria-label="Ask Worth"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => {
            setBubble(false)
            onOpenChange(true)
          }}
        >
          <Guide
            size={46}
            expression={mood}
            look={mood === 'neutral' ? look : undefined}
            blink={blinking}
          />
        </button>
      </div>
      <section
        ref={panel}
        id={panelId}
        className="agent-panel"
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        hidden={!open || hidden}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return
          event.stopPropagation()
          close()
        }}
      >
        <div className="agent-head">
          <Guide size={40} expression={mood} title={`Worth, ${MOOD_LABEL[mood]}`} />
          <div className="agent-title">
            <h2 id={titleId}>Ask Worth</h2>
            <p className="caption">Every number is Worth’s</p>
          </div>
          <IconButton label="Close Ask Worth" icon={X} quiet onClick={close} />
        </div>
        {children}
      </section>
    </>
  )
}

const MOOD_LABEL: Record<GuideExpression, string> = {
  neutral: 'ready',
  thinking: 'checking your plan',
  warning: 'not today',
  happy: 'it fits',
}
