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
  /** `finding` measures each spot unseen; `waiting` retries on scroll; `shown` is on screen. */
  const [bubble, setBubbleState] = useState<false | 'finding' | 'waiting' | 'shown'>(false)
  const [spot, setSpot] = useState(0)
  const dock = useRef<HTMLDivElement>(null)
  const nudgeBox = useRef<HTMLDivElement>(null)

  // The nudge appears once per session, a moment after the first screen settles.
  useEffect(() => {
    if (!nudge || hidden || open || nudgedThisSession()) return
    const show = setTimeout(() => {
      rememberNudge()
      setSpot(0)
      setBubbleState('finding')
    }, NUDGE_DELAY)
    return () => clearTimeout(show)
  }, [nudge, hidden, open])
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
      <div ref={dock} className={cx('agent-dock', lifted && 'lifted')} hidden={hidden || open}>
        {bubble && bubble !== 'waiting' && nudge && (
          <div
            ref={nudgeBox}
            className="agent-nudge"
            role={bubble === 'shown' ? 'status' : undefined}
            data-place={SPOTS[spot]!.place}
            data-narrow={SPOTS[spot]!.width < 200 || undefined}
            style={{
              width: SPOTS[spot]!.width,
              visibility: bubble === 'shown' ? undefined : 'hidden',
            }}
          >
            <button
              type="button"
              className="agent-nudge-text"
              onClick={() => {
                setBubbleState(false)
                onOpenChange(true)
              }}
            >
              <span className="agent-nudge-who">Worth</span>
              {nudge}
            </button>
            <IconButton label="Dismiss" icon={X} quiet onClick={() => setBubbleState(false)} />
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
            setBubbleState(false)
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
          <span className="agent-close">
            <kbd aria-hidden="true">Esc</kbd>
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
