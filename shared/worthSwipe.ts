/**
 * The swipe mode of `<worth-check>` (`mode="swipe"`, shared/worthCheck.ts): the store's own PayPal
 * button, slotted and untouched, with Worth's outline W tab docked flush on its right edge.
 *
 * - At rest nothing covers PayPal's button: the reveal layer is `visibility: hidden`, and the tab
 *   sits beside the button, which keeps all of its own width but the tab's.
 * - Dragging the tab left unwraps a white "W | Analyse with Worth →" bar over the button, only
 *   while dragging. Releasing past half the row (or a fast flick) goes to Worth; earlier, it
 *   springs back.
 * - The tab is a real link, so a tap, Enter (and Space here) open Worth too. A small left arrow in
 *   the tab and in a "Swipe left for Worth" hint under it nudges left on a gentle loop; reduced
 *   motion keeps both still and turns the drag off, leaving the tab a plain link.
 * - Without PayPal's button (still loading, ineligible or failed) the tab becomes the default
 *   full-width outline link, so Worth stays one tap away.
 */

/** The tab's width; its height is PayPal's 45px. */
export const TAB_WIDTH = 52
/** Released at or past this share of the row, the swipe goes to Worth. */
export const COMMIT_AT = 0.5
/** A flick this fast (px per ms, leftwards) past FLICK_FROM also goes. */
export const FLICK_SPEED = 0.9
export const FLICK_FROM = 0.15
/** Horizontal travel before a press becomes a drag; a vertical move first lets the page scroll. */
export const SLOP_PX = 6
/** The arrows' loop: one nudge per cycle, for this many cycles once the row is first in view. */
export const NUDGE_MS = 1800
export const NUDGE_CYCLES = 10

/** How far along the row a drag of `offset` px is, from 0 (at rest) to 1 (the tab at the left). */
export function swipeProgress(offset: number, rowWidth: number) {
  const room = rowWidth - TAB_WIDTH
  return room > 0 ? Math.min(1, Math.max(0, offset / room)) : 0
}

/** Whether a release at `progress`, moving left at `speed` px/ms, goes to Worth. */
export function swipeCommits(progress: number, speed: number) {
  return progress >= COMMIT_AT || (speed > FLICK_SPEED && progress > FLICK_FROM)
}

export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** The Worth mark's front layer (devpost-assets/worth-mark.svg), simplified for ~20px. */
const W_PATH =
  'M2 10Q2 2 10 2H76Q84 2 84 10L78 221Q78 224 79 221L189 10Q193 2 201 2H247Q255 2 255 10L260 221Q260 224 261 221L360 10Q364 2 372 2H438Q446 2 442 10L282 319Q278 328 269 328H211Q202 328 201 319L191 138Q191 135 189 138L88 319Q84 328 75 328H17Q8 328 8 319Z'
const MARK = `<svg class="mark" viewBox="-4 -4 456 340" aria-hidden="true" focusable="false"><path d="${W_PATH}" fill="currentColor"/></svg>`
const CHEVRON = `<svg class="chevron nudge" viewBox="0 0 8 12" aria-hidden="true" focusable="false"><path d="M6.5 1 1.5 6l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
const ARROW = `<svg class="arrow" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 8h9M8.5 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`

/**
 * The outline tab: white, a 1px border in Worth's ink and a navy W (Worth's --c-text-strong, never
 * PayPal's blues). The same five `--worth-check-*` properties as the default link theme it; the
 * radius defaults to PayPal's 4px corners so the row reads as one shape.
 */
export const SWIPE_STYLE = `
:host {
  display: block;
  width: 100%;
}
.swipe {
  --tab: ${TAB_WIDTH}px;
  --r: var(--worth-check-radius, 4px);
  --line: var(--worth-check-border, #2c2e2f);
  --ink: var(--worth-check-ink, #001435);
  --bg: var(--worth-check-bg, #ffffff);
  position: relative;
  font: 400 16px/1 'Helvetica Neue', Helvetica, Arial, sans-serif;
}
.row {
  position: relative;
  display: flex;
  height: 45px;
  isolation: isolate;
}
/* PayPal's own element: only its container narrows (it fills its container by default). */
::slotted(*) {
  position: relative;
  z-index: 1;
  flex: 1 1 auto;
  min-width: 0;
  width: auto !important;
  height: 45px;
}
/* Behind PayPal's rounded right corners, so the join is one straight line. Never on top. */
.seam {
  position: absolute;
  z-index: 0;
  top: 0;
  bottom: 0;
  right: calc(var(--tab) - 1px);
  width: 6px;
  box-sizing: border-box;
  border-block: 1px solid var(--line);
  background: var(--bg);
}
.tab {
  position: relative;
  z-index: 3;
  flex: 0 0 var(--tab);
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: var(--tab);
  height: 45px;
  border: 1px solid var(--line);
  /* The hairline at the seam: docked beside PayPal's button, not part of it. */
  border-left-color: var(--line);
  border-radius: 0 var(--r) var(--r) 0;
  background: var(--bg);
  color: var(--ink);
  text-decoration: none;
  cursor: grab;
  touch-action: pan-y;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
  -webkit-tap-highlight-color: transparent;
  transform: translateX(calc(var(--d, 0) * -1px));
}
.tab:hover,
.dragging .tab,
.settling .tab,
.committing .tab {
  background: var(--worth-check-bg-hover, #f0f2f9);
}
.dragging .tab,
.committing .tab {
  cursor: grabbing;
}
.tab:focus {
  outline: none;
}
/* Inset, so focus never spills onto PayPal's button. */
.tab:focus-visible {
  outline: 2px solid #097ff5;
  outline-offset: -5px;
}
.tab[aria-busy='true'] {
  opacity: 0.8;
}
.mark {
  display: block;
  flex: none;
  width: 20px;
  height: 15px;
  transition: transform 140ms ease;
}
.armed .tab .mark {
  transform: scale(1.08);
}
.chevron {
  display: block;
  flex: none;
  width: 6px;
  height: 10px;
}
.text {
  display: none;
}

/* The reveal layer: drawn over PayPal's button only while a drag is under way. */
.panel {
  position: absolute;
  z-index: 2;
  inset: 0;
  box-sizing: border-box;
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--bg);
  color: var(--ink);
  pointer-events: none;
  visibility: hidden;
  clip-path: inset(0 0 0 calc(100% - var(--tab) - var(--d, 0) * 1px) round var(--r));
}
.dragging .panel,
.settling .panel,
.committing .panel {
  visibility: visible;
}
.label {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: safe center;
  gap: 8px;
  width: calc(var(--d, 0) * 1px);
  padding: 0 10px;
  overflow: hidden;
  white-space: nowrap;
}
.label.clip {
  justify-content: flex-start;
  -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 22px), transparent);
  mask-image: linear-gradient(90deg, #000 calc(100% - 22px), transparent);
}
.words {
  opacity: var(--o, 1);
}
.arrow {
  flex: none;
  width: 16px;
  height: 16px;
  opacity: 0;
  transform: translateX(-6px);
  transition: opacity 140ms ease, transform 140ms ease;
}
.armed .arrow {
  opacity: 1;
  transform: none;
}
.settling .tab,
.settling .panel,
.settling .label {
  transition:
    transform 320ms cubic-bezier(0.3, 1.35, 0.5, 1),
    clip-path 320ms cubic-bezier(0.3, 1.35, 0.5, 1),
    width 320ms cubic-bezier(0.3, 1.35, 0.5, 1);
}
.committing .tab,
.committing .panel,
.committing .label {
  transition:
    transform 170ms ease-out,
    clip-path 170ms ease-out,
    width 170ms ease-out;
}

/* The hint under the tab: small, muted, right-aligned; gone once the shopper has used the tab. */
.hint {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 5px;
  margin: 6px 0 0;
  padding-right: 2px;
  font-size: 12px;
  line-height: 16px;
  color: #545d68;
  user-select: none;
  -webkit-user-select: none;
}
.hint .chevron {
  width: 5px;
  height: 8px;
}
.used .hint {
  visibility: hidden;
}

/* The arrows' leftward nudge: a few px out and back, then a rest, in step in the tab and the hint. */
@keyframes worth-nudge {
  0%,
  60%,
  100% {
    transform: translateX(0);
  }
  30% {
    transform: translateX(-3px);
  }
}
.hinting .nudge {
  animation: worth-nudge ${NUDGE_MS}ms cubic-bezier(0.45, 0, 0.55, 1) ${NUDGE_CYCLES};
}
.quiet .nudge {
  animation: none;
}

/* Without PayPal's button: the default full-width outline link, alone. */
.solo .seam,
.solo .panel,
.solo .hint,
.solo .mark,
.solo .chevron {
  display: none;
}
.solo .tab {
  flex: 1 1 auto;
  width: 100%;
  padding: 0 16px;
  border-radius: var(--worth-check-radius, 23px);
  color: var(--worth-check-ink, #2c2e2f);
  cursor: pointer;
  touch-action: auto;
  white-space: nowrap;
  transform: none;
}
.solo .tab:focus-visible {
  outline: 3px solid #097ff5;
  outline-offset: 2px;
}
.solo .text {
  display: inline;
}
/* Without a usable link: PayPal's button alone, full width. */
.no-link .seam,
.no-link .panel,
.no-link .tab,
.no-link .hint {
  display: none;
}

.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .nudge {
    animation: none !important;
  }
  .tab {
    cursor: pointer;
  }
  .tab,
  .panel,
  .label,
  .arrow,
  .mark {
    transition: none !important;
  }
}
`

interface Drag {
  id: number
  x: number
  y: number
  moved: boolean
  lastX: number
  lastT: number
  speed: number
}

/**
 * The swipe mode's parts and gestures. The host element owns the link itself (its href, its click
 * and the refresh before leaving); `go` is how a committed swipe leaves, through that same path.
 */
export class SwipeControl {
  readonly box: HTMLDivElement
  /** The W tab: the host's link in this mode. */
  readonly tab: HTMLAnchorElement
  private label: HTMLElement
  private words: HTMLElement
  private slot: HTMLSlotElement
  private offset = 0
  private drag?: Drag
  private swallowClick = false
  private settleTimer?: ReturnType<typeof setTimeout>
  private watcher?: MutationObserver
  private viewer?: IntersectionObserver

  constructor(
    private host: HTMLElement,
    private go: () => void,
  ) {
    this.box = document.createElement('div')
    this.box.className = 'swipe'
    this.box.innerHTML = `<div class="row" part="row"><slot></slot><span class="seam" aria-hidden="true"></span><div class="panel" aria-hidden="true"><div class="label"><span class="words">Analyse with Worth</span>${ARROW}</div></div><a class="tab" part="link" draggable="false" aria-label="Analyse with Worth">${CHEVRON}${MARK}<span class="text">Analyse with Worth</span></a></div><p class="hint" aria-hidden="true">${CHEVRON}<span>Swipe left for Worth</span></p>`
    this.tab = this.box.querySelector('.tab')!
    this.label = this.box.querySelector('.label')!
    this.words = this.box.querySelector('.words')!
    this.slot = this.box.querySelector('slot')!
    const tab = this.tab
    tab.addEventListener('dragstart', (event) => event.preventDefault())
    tab.addEventListener('pointerdown', (event) => this.down(event))
    tab.addEventListener('pointermove', (event) => this.move(event))
    tab.addEventListener('pointerup', (event) => this.up(event))
    tab.addEventListener('pointercancel', () => this.cancel())
    tab.addEventListener('focus', () => this.box.classList.add('quiet'))
    tab.addEventListener('keydown', (event) => this.key(event))
    // Capture: runs before the host's own click handler, so a finished drag never also clicks.
    tab.addEventListener('click', (event) => this.click(event), { capture: true })
    this.slot.addEventListener('slotchange', () => this.sync())
  }

  connect() {
    this.watcher ??= new MutationObserver(() => this.sync())
    this.watcher.observe(this.host, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden'],
    })
    this.sync()
    // The arrows start nudging once the row is first fully in view, so the loop isn't spent unseen.
    if (this.box.classList.contains('hinting')) return
    if (typeof IntersectionObserver !== 'function') return void this.box.classList.add('hinting')
    this.viewer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        this.viewer?.disconnect()
        this.box.classList.add('hinting')
      },
      { threshold: 1 },
    )
    this.viewer.observe(this.box.querySelector('.row')!)
  }

  disconnect() {
    this.watcher?.disconnect()
    this.viewer?.disconnect()
  }

  /** Shows the tab only with a link; shows it alone when PayPal's button isn't on the page. */
  sync(hasLink = !this.box.classList.contains('no-link')) {
    this.box.classList.toggle('no-link', !hasLink)
    const button = this.slot.assignedElements()[0] as HTMLElement | undefined
    this.box.classList.toggle('solo', !button || button.hidden !== false)
  }

  /** How far along the row the tab is, 0 to 1. */
  get progress() {
    return swipeProgress(this.offset, this.width())
  }

  private width() {
    return this.box.getBoundingClientRect().width
  }

  /** Moves the tab `offset` px left of its rest and redraws the reveal to match. */
  set(offset: number) {
    this.offset = Math.max(0, Math.min(this.width() - TAB_WIDTH, offset))
    this.box.style.setProperty('--d', String(this.offset))
    const progress = this.progress
    this.label.classList.toggle('clip', this.label.scrollWidth > this.label.clientWidth + 1)
    // The words arrive with the drag.
    this.words.style.setProperty('--o', String(Math.min(1, 0.25 + progress * 3)))
    const armed = progress >= COMMIT_AT
    if (armed !== this.box.classList.contains('armed')) {
      this.box.classList.toggle('armed', armed)
      if (armed) navigator.vibrate?.(8)
    }
  }

  private draggable() {
    return !prefersReducedMotion() && !this.box.classList.contains('solo')
  }

  private down(event: PointerEvent) {
    this.box.classList.add('quiet')
    // A click left over from a cancelled drag never outlives the next press.
    this.swallowClick = false
    if (!this.draggable() || event.button !== 0 || this.box.classList.contains('committing')) return
    clearTimeout(this.settleTimer)
    this.box.classList.remove('settling')
    this.drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      lastX: event.clientX,
      lastT: event.timeStamp,
      speed: 0,
    }
  }

  private move(event: PointerEvent) {
    const drag = this.drag
    if (!drag || event.pointerId !== drag.id) return
    const dx = event.clientX - drag.x
    if (!drag.moved) {
      // Axis lock: a mostly vertical move is the page's scroll, never a swipe.
      if (Math.abs(event.clientY - drag.y) > Math.abs(dx) && Math.abs(event.clientY - drag.y) > 2)
        return void (this.drag = undefined)
      if (Math.abs(dx) < SLOP_PX) return
      drag.moved = true
      this.tab.setPointerCapture?.(drag.id)
      this.box.classList.add('dragging', 'used')
    }
    const elapsed = event.timeStamp - drag.lastT
    if (elapsed > 0) drag.speed = (drag.lastX - event.clientX) / elapsed
    drag.lastX = event.clientX
    drag.lastT = event.timeStamp
    this.set(-dx)
  }

  private up(event: PointerEvent) {
    const drag = this.drag
    if (!drag || event.pointerId !== drag.id) return
    this.drag = undefined
    // A press that never moved is a tap: the link's own click goes to Worth.
    if (!drag.moved) return
    this.swallowClick = true
    if (swipeCommits(this.progress, drag.speed)) this.commit()
    else this.springBack()
  }

  private cancel() {
    if (!this.drag && !this.box.classList.contains('dragging')) return
    // Escape mid-drag: the release that follows is not a tap.
    if (this.drag?.moved) this.swallowClick = true
    this.drag = undefined
    this.springBack()
  }

  private springBack() {
    this.box.classList.remove('dragging')
    this.box.classList.add('settling')
    requestAnimationFrame(() => this.set(0))
    clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => this.box.classList.remove('settling'), 340)
  }

  private commit() {
    this.box.classList.remove('dragging')
    this.box.classList.add('committing')
    requestAnimationFrame(() => this.set(this.width()))
    // Back from Worth through the browser's cache: the row is at rest again.
    window.addEventListener(
      'pageshow',
      () => {
        this.box.classList.remove('committing')
        this.set(0)
      },
      { once: true },
    )
    setTimeout(() => this.go(), 200)
  }

  private key(event: KeyboardEvent) {
    if (event.key === 'Escape') return this.cancel()
    this.swallowClick = false
    // Enter follows the link natively; Space does too here, as the tab reads as a control.
    if (event.key === ' ' && !event.repeat) {
      event.preventDefault()
      this.tab.click()
    }
  }

  private click(event: MouseEvent) {
    if (this.swallowClick) {
      this.swallowClick = false
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    this.box.classList.add('used', 'quiet')
  }
}
