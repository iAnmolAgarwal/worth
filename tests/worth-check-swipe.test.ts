// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorthCheck } from '../shared/worthCheck.ts'
import {
  COMMIT_AT,
  NUDGE_CYCLES,
  NUDGE_MS,
  swipeCommits,
  swipeProgress,
  TAB_WIDTH,
} from '../shared/worthSwipe.ts'

const WORTH = 'https://worth.example'
const NOW = 1_791_000_000
const ROW = 400
function href(exp = NOW + 900) {
  const body = Buffer.from(JSON.stringify({ v: 1, qid: 'q_abcdefghijklmnopqrstuv', exp })).toString(
    'base64url',
  )
  return `${WORTH}/check#q=${body}.${'s'.repeat(43)}`
}

/** The store's markup: PayPal's button and the no-JavaScript link inside the element. */
function mount(attributes: Record<string, string> = {}, paypalHidden = false) {
  const element = document.createElement('worth-check') as WorthCheck
  element.setAttribute('mode', 'swipe')
  element.setAttribute('href', href())
  element.setAttribute('merchant', 'Larkspur Supply')
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value)
  element.innerHTML = `<paypal-button type="pay"${paypalHidden ? ' hidden' : ''}></paypal-button><a slot="fallback" href="${href()}">Analyse with Worth</a>`
  document.body.append(element)
  const box = element.shadowRoot!.querySelector<HTMLElement>('.swipe')!
  // jsdom has no layout: the row is ROW px wide.
  if (box) box.getBoundingClientRect = () => ({ width: ROW }) as DOMRect
  return element
}
const parts = (element: WorthCheck) => {
  const root = element.shadowRoot!
  return {
    box: root.querySelector<HTMLElement>('.swipe')!,
    tab: root.querySelector<HTMLAnchorElement>('a.tab')!,
    hint: root.querySelector<HTMLElement>('.hint')!,
    panel: root.querySelector<HTMLElement>('.panel')!,
    css: root.querySelector('style')!.textContent!,
  }
}
function pointer(target: Element, type: string, x: number, y = 20) {
  const Event = window.PointerEvent ?? window.MouseEvent
  target.dispatchEvent(
    new Event(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }),
  )
}
/** Drags the tab `distance` px left from the row's right edge, over `steps` moves. */
function drag(tab: Element, distance: number, steps = 4) {
  const start = ROW - TAB_WIDTH / 2
  pointer(tab, 'pointerdown', start)
  for (let i = 1; i <= steps; i++) pointer(tab, 'pointermove', start - (distance * i) / steps)
  pointer(tab, 'pointerup', start - distance)
}
const reduced = (matches: boolean) =>
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: matches && query.includes('reduce'), media: query })),
  )
let go: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  WorthCheck.now = () => NOW
  go = vi.spyOn(WorthCheck, 'go').mockImplementation(() => undefined)
  reduced(false)
})
afterEach(() => {
  document.body.innerHTML = ''
  go.mockRestore()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('<worth-check mode="swipe">', () => {
  it('slots PayPal’s button and docks a W tab named “Analyse with Worth” beside it', () => {
    const element = mount()
    const { box, tab, hint, panel } = parts(element)
    const slot = box.querySelector('slot:not([name])') as HTMLSlotElement
    expect(slot.assignedElements().map((node) => node.tagName)).toEqual(['PAYPAL-BUTTON'])
    // The no-JavaScript link sits in a slot the element never draws.
    expect(box.querySelector('slot[name="fallback"]')).toBeNull()
    expect(tab.getAttribute('href')).toBe(href())
    expect(tab.getAttribute('target')).toBeNull()
    expect(tab.getAttribute('aria-label')).toBe('Analyse with Worth')
    const description = element.shadowRoot!.getElementById(tab.getAttribute('aria-describedby')!)!
    expect(description.textContent).toBe(
      'Opens Worth to check when this fits your plan. You come back to Larkspur Supply to pay.',
    )
    expect(tab.querySelector('svg.mark')).not.toBeNull()
    expect(tab.querySelector('svg.chevron.nudge')).not.toBeNull()
    // The reveal layer and the hint are decoration; the tab is the one control.
    expect(panel.getAttribute('aria-hidden')).toBe('true')
    expect(hint.getAttribute('aria-hidden')).toBe('true')
    expect(hint.textContent).toBe('Swipe left for Worth')
    expect(hint.querySelector('svg.chevron.nudge')).not.toBeNull()
    expect(element.shadowRoot!.querySelectorAll('a, button, [tabindex]')).toHaveLength(1)
    expect(box.classList.contains('solo')).toBe(false)
    expect(element.hidden).toBe(false)
  })

  it('switches between the outline link and the swipe row with the mode attribute', () => {
    const element = mount()
    expect(parts(element).tab).not.toBeNull()
    element.removeAttribute('mode')
    const link = element.shadowRoot!.querySelector('a')!
    expect(link.className).toBe('')
    expect(link.textContent).toBe('Analyse with Worth')
    expect(element.shadowRoot!.querySelector('slot, svg')).toBeNull()
    element.setAttribute('mode', 'swipe')
    expect(parts(element).tab.getAttribute('href')).toBe(href())
  })

  it('stands alone as the outline link while PayPal’s button is hidden', async () => {
    const element = mount({}, true)
    const { box } = parts(element)
    expect(box.classList.contains('solo')).toBe(true)
    element.querySelector('paypal-button')!.removeAttribute('hidden')
    await vi.waitFor(() => expect(box.classList.contains('solo')).toBe(false))
    // A solo tab can't be dragged.
    element.querySelector('paypal-button')!.setAttribute('hidden', '')
    await vi.waitFor(() => expect(box.classList.contains('solo')).toBe(true))
    drag(parts(element).tab, 300)
    expect(box.classList.contains('dragging')).toBe(false)
    expect(go).not.toHaveBeenCalled()
  })

  it('hides only the tab without a usable link, never PayPal’s button', () => {
    const element = mount({ href: 'javascript:alert(1)' })
    const { box, tab } = parts(element)
    expect(element.hidden).toBe(false)
    expect(box.classList.contains('no-link')).toBe(true)
    expect(tab.getAttribute('href')).toBeNull()
    element.setAttribute('href', href())
    expect(box.classList.contains('no-link')).toBe(false)
  })

  it('uses only the five --worth-check-* properties and none of PayPal’s colours', () => {
    const { css } = parts(mount())
    expect([...new Set(css.match(/--worth-check-[a-z-]+/g))].sort()).toEqual([
      '--worth-check-bg',
      '--worth-check-bg-hover',
      '--worth-check-border',
      '--worth-check-ink',
      '--worth-check-radius',
    ])
    const markup = mount().shadowRoot!.innerHTML.toLowerCase()
    for (const hex of ['#003087', '#012169', '#009cde', '#0070e0', '#ffc439'])
      expect(markup, hex).not.toContain(hex)
    // Outline tab: white, a thin dark border, Worth's navy ink, PayPal's 45px height.
    expect(css).toContain('--bg: var(--worth-check-bg, #ffffff);')
    expect(css).toContain('--line: var(--worth-check-border, #2c2e2f);')
    expect(css).toContain('--ink: var(--worth-check-ink, #001435);')
    expect(css).toMatch(/\.tab \{[^}]*height: 45px;/)
    expect(css).toMatch(/\.tab:focus-visible \{\s*outline: 2px solid #097ff5;/)
    // Vertical drags on the tab stay the page's scroll.
    expect(css).toMatch(/\.tab \{[^}]*touch-action: pan-y;/)
    // Nothing over PayPal's button at rest: the reveal is hidden until a drag starts.
    expect(css).toMatch(/\.panel \{[^}]*visibility: hidden;/)
  })
})

describe('the arrows’ nudge', () => {
  it('loops gently left and back, in step in the tab and the hint, and stops after use', () => {
    const element = mount()
    const { box, tab, css } = parts(element)
    expect(css).toMatch(/@keyframes worth-nudge \{[^@]*30% \{\s*transform: translateX\(-3px\);/)
    expect(css).toContain(
      `.hinting .nudge {\n  animation: worth-nudge ${NUDGE_MS}ms cubic-bezier(0.45, 0, 0.55, 1) ${NUDGE_CYCLES};`,
    )
    expect(NUDGE_MS).toBeGreaterThanOrEqual(1400)
    expect(NUDGE_MS).toBeLessThanOrEqual(2000)
    // jsdom has no IntersectionObserver: the loop starts at once.
    expect(box.classList.contains('hinting')).toBe(true)
    pointer(tab, 'pointerdown', 380)
    expect(box.classList.contains('quiet')).toBe(true)
    expect(css).toMatch(/\.quiet \.nudge \{\s*animation: none;/)
  })

  it('starts once the row is in view, where IntersectionObserver exists', () => {
    let seen: ((entries: { isIntersecting: boolean }[]) => void) | undefined
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: typeof seen) {
          seen = callback
        }
        observe() {}
        disconnect() {}
      },
    )
    const { box } = parts(mount())
    expect(box.classList.contains('hinting')).toBe(false)
    seen!([{ isIntersecting: true }])
    expect(box.classList.contains('hinting')).toBe(true)
  })

  it('keeps both arrows still and the tab a plain link under reduced motion', () => {
    reduced(true)
    const element = mount()
    const { box, tab, css } = parts(element)
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.nudge \{\s*animation: none !important;/,
    )
    drag(tab, 300)
    expect(box.classList.contains('dragging')).toBe(false)
    expect(box.style.getPropertyValue('--d')).toBe('')
    expect(go).not.toHaveBeenCalled()
  })

  it('hides the hint once the tab is tapped or swiped', () => {
    const tapped = mount()
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    parts(tapped).tab.dispatchEvent(click)
    // A fresh link goes as a plain link.
    expect(click.defaultPrevented).toBe(false)
    expect(parts(tapped).box.classList.contains('used')).toBe(true)
    const swiped = mount()
    drag(parts(swiped).tab, 40)
    expect(parts(swiped).box.classList.contains('used')).toBe(true)
    expect(parts(swiped).css).toMatch(/\.used \.hint \{\s*visibility: hidden;/)
  })
})

describe('the swipe', () => {
  it('measures progress along the room the tab can travel', () => {
    expect(swipeProgress(0, ROW)).toBe(0)
    expect(swipeProgress((ROW - TAB_WIDTH) / 2, ROW)).toBe(0.5)
    expect(swipeProgress(ROW, ROW)).toBe(1)
    expect(swipeProgress(-10, ROW)).toBe(0)
    expect(swipeProgress(10, TAB_WIDTH)).toBe(0)
  })

  it('commits at half the row, or on a fast flick past 15%', () => {
    expect(COMMIT_AT).toBe(0.5)
    expect(swipeCommits(0.5, 0)).toBe(true)
    expect(swipeCommits(0.49, 0)).toBe(false)
    expect(swipeCommits(0.2, 1.2)).toBe(true)
    expect(swipeCommits(0.1, 3)).toBe(false)
    expect(swipeCommits(0.3, 0.5)).toBe(false)
  })

  it('goes to Worth in the same tab when released past half, and swallows the click', async () => {
    vi.useFakeTimers()
    const open = vi.fn()
    vi.stubGlobal('open', open)
    const element = mount()
    const { box, tab } = parts(element)
    // Slow and steady: no flick, just distance.
    const start = ROW - TAB_WIDTH / 2
    pointer(tab, 'pointerdown', start)
    for (let x = start; x >= start - 0.6 * (ROW - TAB_WIDTH); x -= 20) {
      vi.advanceTimersByTime(100)
      pointer(tab, 'pointermove', x)
    }
    expect(box.classList.contains('dragging')).toBe(true)
    expect(box.classList.contains('armed')).toBe(true)
    pointer(tab, 'pointerup', start - 0.6 * (ROW - TAB_WIDTH))
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    tab.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(box.classList.contains('committing')).toBe(true)
    await vi.advanceTimersByTimeAsync(250)
    expect(go).toHaveBeenCalledWith(href())
    expect(open).not.toHaveBeenCalled()
  })

  it('springs back below half and goes nowhere', async () => {
    vi.useFakeTimers()
    const element = mount()
    const { box, tab } = parts(element)
    const start = ROW - TAB_WIDTH / 2
    pointer(tab, 'pointerdown', start)
    for (let i = 1; i <= 5; i++) {
      vi.advanceTimersByTime(100)
      pointer(tab, 'pointermove', start - i * 20)
    }
    pointer(tab, 'pointerup', start - 100)
    expect(box.classList.contains('settling')).toBe(true)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    tab.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(box.style.getPropertyValue('--d')).toBe('0')
    expect(box.classList.contains('settling')).toBe(false)
    expect(go).not.toHaveBeenCalled()
  })

  it('leaves a mostly vertical move to the page’s scroll', () => {
    const { box, tab } = parts(mount())
    pointer(tab, 'pointerdown', 380, 20)
    pointer(tab, 'pointermove', 377, 40)
    pointer(tab, 'pointermove', 300, 60)
    pointer(tab, 'pointerup', 300, 60)
    expect(box.classList.contains('dragging')).toBe(false)
    expect(go).not.toHaveBeenCalled()
  })

  it('springs back on Escape mid-drag', () => {
    const { box, tab } = parts(mount())
    pointer(tab, 'pointerdown', 380)
    pointer(tab, 'pointermove', 250)
    expect(box.classList.contains('dragging')).toBe(true)
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(box.classList.contains('dragging')).toBe(false)
    expect(box.classList.contains('settling')).toBe(true)
    // Letting go afterwards is not a tap: nothing opens.
    pointer(tab, 'pointerup', 250)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    tab.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    // And the next real tap goes through.
    pointer(tab, 'pointerdown', 380)
    pointer(tab, 'pointerup', 380)
    const tap = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    tab.dispatchEvent(tap)
    expect(tap.defaultPrevented).toBe(false)
  })
})

describe('keyboard', () => {
  it('opens Worth from the tab with Space, renewing a stale link first', async () => {
    const fresh = href(NOW + 900)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ href: fresh })),
    )
    const element = mount({ href: href(NOW + 30), 'refresh-url': '/q' })
    const { tab } = parts(element)
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    tab.dispatchEvent(space)
    expect(space.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(go).toHaveBeenCalledWith(fresh))
  })

  it('lets Enter follow the tab as the link it is', () => {
    const { tab } = parts(mount())
    const clicks = vi.fn()
    tab.addEventListener('click', clicks)
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    tab.dispatchEvent(enter)
    // The browser turns Enter on a link into its click; nothing here intercepts it.
    expect(enter.defaultPrevented).toBe(false)
    expect(tab.tagName).toBe('A')
    expect(tab.hasAttribute('href')).toBe(true)
    expect(tab.tabIndex).toBe(0)
  })
})
