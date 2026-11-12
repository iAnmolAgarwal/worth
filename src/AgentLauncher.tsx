import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { X } from 'lucide-react'
import { getUpcomingFlows } from '../shared/finance'
import type { AppState, Comparison } from './contract'
import { fits } from './engine'
import { capitalize, cx, dayLabel, daysFrom, displayName } from './format'
import { Guide, useLook, type GuideExpression } from './Guide'
import { startTour } from './Tour'
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
/** The questions bubble's delays: a beat before it shows, a moment before it goes. */
const HOVER_IN = 150
const HOVER_OUT = 250

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

/** A screen's line by the launcher, and the question its click asks, if any. */
export interface Nudge {
  id: string
  text: string
  ask?: string
}
/**
 * The line for the screen on show, at most once per screen per session. The chart's offers a
 * walk-through; Home names the largest payment due; Plan and Saved point at what they hold.
 */
export function screenNudge(
  screen: string,
  state: AppState,
  chartShown = false,
): Nudge | undefined {
  // The walk-through is offered only once the chart is on screen (not while /check waits for an
  // item or the comparison loads), so its question always goes with the chart's view.
  if (screen === 'decision' || screen === 'check')
    return chartShown
      ? {
          id: 'chart',
          text: 'Want me to walk you through this chart?',
          ask: 'Walk me through this chart',
        }
      : undefined
  if (screen === 'home') return { id: 'home', text: nudgeLine(state) }
  if (screen === 'plan')
    return {
      id: 'plan',
      text: 'Want to see what’s due before payday? Ask me.',
      ask: 'What bills are coming up?',
    }
  if (screen === 'saved')
    return { id: 'saved', text: 'Saved something? Ask me whether it fits yet.' }
  return undefined
}

/** Where the nudge may sit, in order: above the launcher, narrower above it, or to its left. */
const SPOTS = [
  { place: 'above', width: 260 },
  { place: 'above', width: 200 },
  // Fits the 136 px margin beside a 1,120 px page at 1440.
  { place: 'above', width: 128 },
  { place: 'left', width: 260 },
] as const
const CONTROLS =
  'a[href], button, input, select, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"])'
/** True when `box` is on screen and covers no control outside the launcher's own dock. */
export function clearSpot(box: DOMRect, dock: Element) {
  if (box.left < 0 || box.top < 0 || box.right > window.innerWidth) return false
  return ![...document.querySelectorAll(CONTROLS)].some((element) => {
    if (dock.contains(element)) return false
    const r = element.getBoundingClientRect()
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.right > box.left - 4 &&
      r.left < box.right + 4 &&
      r.bottom > box.top - 4 &&
      r.top < box.bottom + 4
    )
  })
}

function nudgedThisSession(id: string) {
  try {
    return sessionStorage.getItem(`${NUDGE_KEY}.${id}`) === '1'
  } catch {
    return false
  }
}
function rememberNudge(id: string) {
  try {
    sessionStorage.setItem(`${NUDGE_KEY}.${id}`, '1')
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
  onNudge,
  hidden,
  touring,
  lifted,
  launcher,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mood: GuideExpression
  /** The screen's line, once per screen per session; none while a dialog or wizard has the screen. */
  nudge?: Nudge
  /** The nudge was clicked: opens the panel, asking its question when it has one. */
  onNudge?: (ask?: string) => void
  /** Wizards and dialogs own the screen: the launcher steps aside. */
  hidden?: boolean
  /** The first-visit tour is about to start or running: the nudge waits for it to end. */
  touring?: boolean
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
  /** `finding` measures each spot unseen; `waiting` retries on scroll; `shown` is on screen. */
  const [bubble, setBubbleState] = useState<false | 'finding' | 'waiting' | 'shown'>(false)
  const [spot, setSpot] = useState(0)
  const dock = useRef<HTMLDivElement>(null)
  /**
   * The screen's nudge again, on hover or keyboard focus, every time. It is the same bubble: an
   * automatic nudge already showing simply stays (nothing stacks or flickers), and a hover never
   * counts as the once-per-screen nudge having been shown or dismissed.
   */
  const [asking, setAsking] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const canAsk = Boolean(nudge) && !open && !hidden && !touring
  const later = (show: boolean, ms: number) => {
    clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setAsking(show), ms)
  }
  const hovered = asking && canAsk
  const shown = bubble === 'shown' || hovered
  // A hover with no automatic nudge on screen uses the first spot: above the launcher.
  const at = bubble ? spot : 0
  useEffect(() => () => clearTimeout(hoverTimer.current), [])
  const hoverable = () => window.matchMedia?.('(hover: hover)').matches !== false
  const nudgeBox = useRef<HTMLDivElement>(null)

  // Each screen's nudge appears once per session, a moment after the screen settles; moving to
  // another screen takes the last one away, so two never stack.
  const nudgeId = nudge?.id
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    setBubbleState(false)
    if (!nudgeId || hidden || touring || open || nudgedThisSession(nudgeId)) return
    const show = setTimeout(() => {
      rememberNudge(nudgeId)
      setSpot(0)
      setBubbleState('finding')
    }, NUDGE_DELAY)
    return () => clearTimeout(show)
  }, [nudgeId, hidden, touring, open])
  // A tour starting (a replay from the panel) takes the nudge away with it.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    if (touring) setBubbleState(false)
  }, [touring])
  // The nudge never covers a control: it takes the first clear spot, or waits for a scroll.
  // Each spot is measured on the page before paint, so the state follows the DOM.
  useLayoutEffect(() => {
    if (bubble !== 'finding' || !nudgeBox.current || !dock.current) return
    const clear = clearSpot(nudgeBox.current.getBoundingClientRect(), dock.current)
    const next = clear ? 'shown' : spot < SPOTS.length - 1 ? undefined : 'waiting'
    // oxlint-disable-next-line react/set-state-in-effect
    if (next) setBubbleState(next)
    // oxlint-disable-next-line react/set-state-in-effect
    else setSpot(spot + 1)
  }, [bubble, spot])
  useEffect(() => {
    if (bubble !== 'waiting') return
    let timer: ReturnType<typeof setTimeout>
    const retry = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        setSpot(0)
        setBubbleState('finding')
      }, 150)
    }
    window.addEventListener('scroll', retry, { passive: true })
    window.addEventListener('resize', retry)
    // Nowhere clear for the whole time it would have shown: it gives up for this session.
    const giveUp = setTimeout(() => setBubbleState(false), NUDGE_FOR)
    return () => {
      clearTimeout(timer)
      clearTimeout(giveUp)
      window.removeEventListener('scroll', retry)
      window.removeEventListener('resize', retry)
    }
  }, [bubble])
  useEffect(() => {
    if (bubble !== 'shown') return
    const hide = setTimeout(() => setBubbleState(false), NUDGE_FOR)
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
      <div
        ref={dock}
        className={cx('agent-dock', lifted && 'lifted')}
        hidden={hidden || open}
        // Hover or keyboard focus shows the nudge after a beat; leaving both hides it again.
        onPointerEnter={(event) => {
          if (event.pointerType !== 'touch' && canAsk) later(true, HOVER_IN)
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== 'touch') later(false, HOVER_OUT)
        }}
        onFocus={(event) => {
          if (canAsk && hoverable() && event.target.matches(':focus-visible')) later(true, HOVER_IN)
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) later(false, HOVER_OUT)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !asking) return
          event.stopPropagation()
          clearTimeout(hoverTimer.current)
          setAsking(false)
          launcher.current?.focus()
        }}
      >
        <button
          ref={launcher}
          type="button"
          className="agent-fab"
          data-tour="guide"
          aria-label="Ask Worth"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => {
            setBubbleState(false)
            clearTimeout(hoverTimer.current)
            setAsking(false)
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
        {/* After the launcher in the tab order, so Tab reaches it from there. */}
        {nudge && ((bubble && bubble !== 'waiting') || hovered) && (
          <div
            ref={nudgeBox}
            className="agent-nudge"
            role={shown ? 'status' : undefined}
            data-place={SPOTS[at]!.place}
            data-narrow={SPOTS[at]!.width < 200 || undefined}
            style={{
              width: SPOTS[at]!.width,
              visibility: shown ? undefined : 'hidden',
            }}
          >
            <button
              type="button"
              className="agent-nudge-text"
              onClick={() => {
                setBubbleState(false)
                clearTimeout(hoverTimer.current)
                setAsking(false)
                if (onNudge) onNudge(nudge.ask)
                else onOpenChange(true)
              }}
            >
              <span className="agent-nudge-who">Worth</span>
              {nudge.text}
            </button>
            <IconButton
              label="Dismiss"
              icon={X}
              quiet
              onClick={() => {
                setBubbleState(false)
                clearTimeout(hoverTimer.current)
                setAsking(false)
              }}
            />
          </div>
        )}
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
            <p className="caption">
              Numbers calculated by Worth, not guessed by AI ·{' '}
              <button
                type="button"
                className="link inline"
                onClick={() => {
                  onOpenChange(false)
                  startTour()
                }}
              >
                Take the tour
              </button>
            </p>
          </div>
          <span className="agent-close">
            <IconButton label="Close Ask Worth" icon={X} quiet onClick={close} />
          </span>
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
