import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import './tour.css'

/**
 * The first-visit tour (final-day plan §4): six blue callouts, each pointing at the real feature on
 * Home, over a dimmed page with the feature left bright. It runs once, on Home, after the plan has
 * rendered; "Take the tour" in the guide's panel replays it. Clicks on the bright feature still go
 * through, and Skip, Escape or a click on the dimmed page end it.
 */

export interface TourStep {
  /** The `data-tour` value of the element the callout points at. */
  anchor: string
  title: string
  text: string
  /** The sides to try first; the rest follow when there is no room. */
  prefer: Side[]
  /** Fit the cut-out to what the element shows, not its full width (the big amount). */
  tight?: boolean
}

export const TOUR_STEPS: TourStep[] = [
  {
    anchor: 'safe',
    tight: true,
    title: 'Safe to spend today',
    text: 'What you can spend today and still pay every bill and keep your cushion.',
    prefer: ['right', 'bottom'],
  },
  {
    anchor: 'bar',
    title: 'Where the rest goes',
    text: 'Your balance: what’s free, what’s needed soon, and your cushion.',
    prefer: ['bottom', 'top'],
  },
  {
    anchor: 'check',
    title: 'Check a purchase',
    text: 'Thinking of buying something? See whether it fits before you pay.',
    prefer: ['bottom', 'left'],
  },
  {
    anchor: 'guide',
    title: 'Ask your guide',
    text: 'Ask Worth about any purchase or bill, from any screen.',
    prefer: ['left', 'top'],
  },
  {
    anchor: 'saved',
    title: 'Saved for later',
    text: 'Things you saved wait here. Worth checks them again when you come back.',
    prefer: ['left', 'bottom'],
  },
  {
    anchor: 'connect',
    title: 'Your PayPal activity',
    text: 'Bring in your own PayPal activity here. Worth only reads it, never pays.',
    prefer: ['bottom', 'top'],
  },
]

export const TOUR_KEY = 'worth.tour.seen'
/** The event "Take the tour" sends; the mounted Tour picks it up. */
const TOUR_EVENT = 'worth:tour'
/** Below this width the callout sits at the top or bottom edge, without an arrow. */
export const NARROW = 720

export function tourSeen() {
  try {
    return localStorage.getItem(TOUR_KEY) === '1'
  } catch {
    return false
  }
}
export function rememberTour() {
  try {
    localStorage.setItem(TOUR_KEY, '1')
  } catch {
    // Storage can be refused in private windows; the tour then shows again on the next visit.
  }
}

/**
 * Whether the tour starts by itself. `?tour=1` always starts it and `?tour=0` never does; without
 * either it runs on a first visit only, and never under browser automation (Playwright, or the
 * headless Chrome that records the demo video), so tests and recordings see the plain app.
 */
export function autoStart(search: string, seen: boolean, automated: boolean) {
  const override = new URLSearchParams(search).get('tour')
  if (override === '0') return false
  if (override === '1') return true
  return !seen && !automated
}

/** Starts the tour from anywhere, such as the guide panel's "Take the tour". */
export function startTour() {
  window.dispatchEvent(new Event(TOUR_EVENT))
}

/** The first element for `anchor` that is on the page with a size; a hidden copy doesn't count. */
export function findAnchor(anchor: string) {
  return [...document.querySelectorAll<HTMLElement>(`[data-tour="${anchor}"]`)].find((element) => {
    const box = element.getBoundingClientRect()
    return box.width > 0 && box.height > 0
  })
}

/** The steps whose feature is on the page now, in order; the others are skipped, and counted out. */
export function presentSteps(steps = TOUR_STEPS, find = findAnchor) {
  return steps.filter((step) => find(step.anchor))
}

export type Side = 'top' | 'bottom' | 'left' | 'right'
export interface Box {
  left: number
  top: number
  width: number
  height: number
}
export interface Placement {
  side: Side
  left: number
  top: number
  /** Where the arrow's tip sits along the callout's edge, from its start. */
  arrow: number
}

/** The bright margin around the feature. */
const PAD = 6
/** How far the arrow sticks out of the callout: its tip touches the bright edge. */
const ARROW = 10
/** The callout keeps this far from the window's edges. */
const EDGE = 12
const SIDES: Side[] = ['bottom', 'top', 'right', 'left']

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(value, Math.max(low, high)))
const overlaps = (a: Box, b: Box) =>
  a.left < b.left + b.width &&
  b.left < a.left + a.width &&
  a.top < b.top + b.height &&
  b.top < a.top + a.height

/**
 * Where a callout of `size` goes beside `target`: the first side, preferred ones first, where it
 * fits in the window and covers none of `avoid` (the guide's launcher, the top bar), and if it can,
 * none of `soft` (the tour's other features). With no clear side it takes the first preferred one,
 * pushed inside the window.
 */
export function placeCallout(
  target: Box,
  size: { width: number; height: number },
  view: { width: number; height: number },
  prefer: Side[] = [],
  avoid: Box[] = [],
  soft: Box[] = [],
): Placement {
  const gap = PAD + ARROW
  const centerX = target.left + target.width / 2
  const centerY = target.top + target.height / 2
  const at = (side: Side): Placement => {
    const vertical = side === 'top' || side === 'bottom'
    const left = vertical
      ? clamp(centerX - size.width / 2, EDGE, view.width - size.width - EDGE)
      : side === 'right'
        ? target.left + target.width + gap
        : target.left - gap - size.width
    const top = vertical
      ? side === 'bottom'
        ? target.top + target.height + gap
        : target.top - gap - size.height
      : clamp(centerY - size.height / 2, EDGE, view.height - size.height - EDGE)
    const arrow = vertical
      ? clamp(centerX - left, 18, size.width - 18)
      : clamp(centerY - top, 18, size.height - 18)
    return { side, left, top, arrow }
  }
  const fits = (boxes: Box[]) => (place: Placement) =>
    place.left >= EDGE &&
    place.top >= EDGE &&
    place.left + size.width <= view.width - EDGE &&
    place.top + size.height <= view.height - EDGE &&
    !boxes.some((box) => overlaps({ left: place.left, top: place.top, ...size }, box))
  const order = [...prefer, ...SIDES.filter((side) => !prefer.includes(side))]
  const options = order.map(at)
  const found = options.find(fits([...avoid, ...soft])) ?? options.find(fits(avoid))
  if (found) return found
  const fallback = at(order[0]!)
  return {
    ...fallback,
    left: clamp(fallback.left, EDGE, view.width - size.width - EDGE),
    top: clamp(fallback.top, EDGE, view.height - size.height - EDGE),
  }
}

const boxOf = (element: Element): Box => {
  const { left, top, width, height } = element.getBoundingClientRect()
  return { left, top, width, height }
}
/**
 * The box of the figures `element` shows, for the big amount: the text's own width, not the
 * block's, without screen-reader-only text, and trimmed top and bottom to the digits (a line's box
 * holds room for accents and descenders that figures don't use). Falls back to the element's box.
 */
export function shownBox(element: Element): Box {
  const boxes = [...element.children]
    .filter((child) => {
      const box = child.getBoundingClientRect()
      return box.width > 1 && box.height > 1
    })
    .map((child) => {
      const range = document.createRange()
      range.selectNodeContents(child)
      return range.getBoundingClientRect?.() ?? child.getBoundingClientRect()
    })
  if (!boxes.length) return boxOf(element)
  const left = Math.min(...boxes.map((box) => box.left))
  const top = Math.min(...boxes.map((box) => box.top))
  const right = Math.max(...boxes.map((box) => box.right))
  const bottom = Math.max(...boxes.map((box) => box.bottom))
  const trim = (bottom - top) * 0.15
  return { left, top: top + trim, width: right - left, height: bottom - top - trim * 2 }
}
/** The cut-out follows the feature's own corners: round for the guide's launcher. */
function spotRadius(element: Element) {
  const corner = getComputedStyle(element).borderTopLeftRadius
  const { width, height } = element.getBoundingClientRect()
  const px = corner.endsWith('%')
    ? (parseFloat(corner) / 100) * Math.min(width, height)
    : parseFloat(corner)
  return Math.max(8, (Number.isFinite(px) ? px : 0) + PAD)
}
/** Home's entrance (the hero's figures and bar settling in) is still playing. */
function entering() {
  const main = document.getElementById('main')
  return (document.getAnimations?.() ?? []).some((animation) => {
    const target = (animation.effect as KeyframeEffect | null)?.target
    const timing = animation.effect?.getComputedTiming()
    return (
      animation.playState === 'running' &&
      timing?.iterations !== Infinity &&
      target instanceof Element &&
      Boolean(main?.contains(target))
    )
  })
}
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
/** Space the sticky top bar takes; a feature under it is scrolled into view. */
const TOP_CLEAR = 96

export function Tour({
  home,
  blocked,
  onHome,
}: {
  /** Home is showing: the tour starts and stays only there. */
  home: boolean
  /** The guide's panel, a dialog or a wizard has the screen: the tour waits, or ends. */
  blocked: boolean
  /** Goes to Home, for a replay asked for elsewhere. */
  onHome: () => void
}) {
  const [wanted, setWanted] = useState(() =>
    autoStart(window.location.search, tourSeen(), Boolean(navigator.webdriver)),
  )
  const [run, setRun] = useState<{ steps: TourStep[]; index: number }>()
  const [target, setTarget] = useState<Box>()
  const [radius, setRadius] = useState(8)
  const [place, setPlace] = useState<Placement | 'pinned-top' | 'pinned-bottom'>()
  const callout = useRef<HTMLDivElement>(null)
  /** Where focus was when the tour began; it goes back there at the end. */
  const opener = useRef<Element | null>(null)
  const goHome = useRef(onHome)
  goHome.current = onHome
  const titleId = useId()
  const textId = useId()
  const step = run?.steps[run.index]

  // "Take the tour": back to Home, then the same start as a first visit.
  useEffect(() => {
    const replay = () => {
      setWanted(true)
      goHome.current()
    }
    window.addEventListener(TOUR_EVENT, replay)
    return () => window.removeEventListener(TOUR_EVENT, replay)
  }, [])

  // Starts once Home has rendered the plan (no skeleton left) and nothing else has the screen.
  useEffect(() => {
    if (!wanted || run || !home || blocked) return
    let tries = 0
    let timer: ReturnType<typeof setTimeout>
    let seenReady = false
    const poll = () => {
      const busy = document.querySelector('#main [aria-busy="true"]') || entering()
      const steps = busy ? [] : presentSteps()
      // Ready twice in a row, so the callout never lands on a layout still settling.
      if (steps.length && seenReady) {
        opener.current = document.activeElement
        setWanted(false)
        setRun({ steps, index: 0 })
        return
      }
      seenReady = steps.length > 0
      if (++tries < 50) timer = setTimeout(poll, 250)
      // Nothing to point at (a plan that never loaded): no tour this time, and not marked as seen.
      else setWanted(false)
    }
    timer = setTimeout(poll, 250)
    return () => clearTimeout(timer)
  }, [wanted, run, home, blocked])

  const finish = useCallback(() => {
    rememberTour()
    setRun(undefined)
    setTarget(undefined)
    setPlace(undefined)
    const back = opener.current
    opener.current = null
    requestAnimationFrame(() => {
      const visible = (element: Element | null): element is HTMLElement =>
        element instanceof HTMLElement && element.isConnected && element.getClientRects().length > 0
      if (visible(back) && back !== document.body) back.focus()
      else findAnchor('guide')?.focus()
    })
  }, [])
  const move = useCallback(
    (by: 1 | -1) => {
      if (!run) return
      const index = run.index + by
      if (index < 0) return
      if (index >= run.steps.length) finish()
      else setRun({ ...run, index })
    },
    [run, finish],
  )

  // Leaving Home, or opening the panel or a dialog, ends the tour.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    if (run && (!home || blocked)) finish()
  }, [run, home, blocked, finish])

  // The page under a running tour: the guide's nudge waits (tour.css), and the step's feature is
  // scrolled into view and followed through scrolling and resizing.
  useEffect(() => {
    if (!run) return
    document.documentElement.dataset.touring = ''
    return () => {
      delete document.documentElement.dataset.touring
    }
  }, [run])
  useLayoutEffect(() => {
    if (!step) return
    const element = findAnchor(step.anchor)
    const measure = step.tight ? shownBox : boxOf
    // Gone since the tour began: skipped silently.
    if (!element) {
      // oxlint-disable-next-line react/set-state-in-effect
      move(1)
      return
    }
    const box = element.getBoundingClientRect()
    const fitsHeight = box.height <= window.innerHeight - TOP_CLEAR - 24
    if (box.top < TOP_CLEAR || box.bottom > window.innerHeight - 16)
      element.scrollIntoView?.({
        block: fitsHeight ? 'center' : 'start',
        behavior: reducedMotion() ? 'auto' : 'smooth',
      })
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setTarget(measure(element)))
    }
    setTarget(measure(element))
    setRadius(spotRadius(element))
    window.addEventListener('scroll', update, { capture: true, passive: true })
    window.addEventListener('resize', update)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    observer?.observe(element)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', update, { capture: true })
      window.removeEventListener('resize', update)
      observer?.disconnect()
    }
    // A new step, not a new `run` object, moves the spotlight.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [step])
  // The callout is measured on the page, then placed beside the feature before paint.
  useLayoutEffect(() => {
    if (!step || !target || !callout.current) return
    const view = { width: window.innerWidth, height: window.innerHeight }
    if (view.width < NARROW) {
      // oxlint-disable-next-line react/set-state-in-effect
      setPlace(target.top + target.height / 2 > view.height / 2 ? 'pinned-top' : 'pinned-bottom')
      return
    }
    const launcher = step.anchor === 'guide' ? undefined : findAnchor('guide')
    const topbar = document.querySelector('.topbar')
    const avoid = [launcher, topbar].filter((element) => element != null).map(boxOf)
    const others = run!.steps
      .filter((other) => other !== step)
      .map((other) => findAnchor(other.anchor))
      .filter((element) => element !== undefined)
      .map(boxOf)
    const size = { width: callout.current.offsetWidth, height: callout.current.offsetHeight }
    setPlace(placeCallout(target, size, view, step.prefer, avoid, others))
  }, [step, target])
  // Focus moves into the callout once it is first placed; it is never trapped there.
  const shown = Boolean(run && place)
  const focused = useRef(false)
  useEffect(() => {
    if (!shown) {
      focused.current = false
      return
    }
    if (focused.current) return
    focused.current = true
    callout.current?.focus()
  }, [shown])
  // Escape skips, Enter or → goes on, ← goes back. Enter and Space on the callout's own buttons
  // press those buttons.
  useEffect(() => {
    if (!run) return
    const onKey = (event: KeyboardEvent) => {
      const onButton =
        event.target instanceof HTMLButtonElement && callout.current?.contains(event.target)
      if (event.key === 'Escape') finish()
      else if (event.key === 'ArrowRight' || (event.key === 'Enter' && !onButton)) move(1)
      else if (event.key === 'ArrowLeft') move(-1)
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [run, move, finish])

  if (!run || !step) return null
  const last = run.index === run.steps.length - 1
  const counter = `${run.index + 1} of ${run.steps.length}`
  const hole = target && {
    left: target.left - PAD,
    top: target.top - PAD,
    width: target.width + PAD * 2,
    height: target.height + PAD * 2,
  }
  const pinned = place === 'pinned-top' || place === 'pinned-bottom'
  const placed = place && !pinned ? place : undefined
  // Four panes around the bright feature catch clicks on the dimmed page; the feature takes its own.
  const panes = hole
    ? [
        { left: 0, top: 0, right: 0, height: Math.max(0, hole.top) },
        { left: 0, top: hole.top + hole.height, right: 0, bottom: 0 },
        { left: 0, top: hole.top, width: Math.max(0, hole.left), height: hole.height },
        { left: hole.left + hole.width, top: hole.top, right: 0, height: hole.height },
      ]
    : [{ inset: 0 }]
  return (
    <div className="tour">
      {panes.map((style, index) => (
        <div key={index} className="tour-pane" style={style} aria-hidden="true" onClick={finish} />
      ))}
      {hole && (
        <div className="tour-spot" style={{ ...hole, borderRadius: radius }} aria-hidden="true" />
      )}
      <div
        ref={callout}
        className="tour-callout"
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={textId}
        tabIndex={-1}
        data-step={step.anchor}
        data-side={placed?.side}
        data-pinned={pinned ? place.slice(7) : undefined}
        style={{
          left: placed?.left,
          top: placed?.top,
          visibility: place ? undefined : 'hidden',
        }}
      >
        <div aria-live="polite">
          <span className="sr">Step {counter}. </span>
          <h2 className="tour-title" id={titleId}>
            {step.title}
          </h2>
          <p className="tour-text" id={textId}>
            {step.text}
          </p>
        </div>
        <div className="tour-foot">
          <span className="tour-count" aria-hidden="true">
            {counter}
          </span>
          <button type="button" className="tour-skip" onClick={finish}>
            Skip
          </button>
          <button type="button" className="tour-next" onClick={() => move(1)}>
            {last ? 'Done' : 'Next'}
          </button>
        </div>
        {placed && (
          <span
            className="tour-arrow"
            aria-hidden="true"
            style={
              placed.side === 'top' || placed.side === 'bottom'
                ? { left: placed.arrow }
                : { top: placed.arrow }
            }
          />
        )}
      </div>
    </div>
  )
}
