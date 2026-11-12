// @vitest-environment jsdom
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentLauncher, type Nudge } from '../src/AgentLauncher'

// Hovering or focusing the guide's launcher shows the screen's own nudge line, every time.

const HOME: Nudge = { id: 'home', text: 'Rent is due in 18 days. Ask me before you buy.' }
const CHART: Nudge = {
  id: 'chart',
  text: 'Want me to walk you through this chart?',
  ask: 'Walk me through this chart',
}

beforeEach(() => {
  vi.useFakeTimers()
  sessionStorage.clear()
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('hover: hover'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function launcher(props: Partial<Parameters<typeof AgentLauncher>[0]> = {}) {
  const onNudge = vi.fn()
  const onOpenChange = vi.fn()
  const view = render(
    <AgentLauncher
      open={false}
      onOpenChange={onOpenChange}
      mood="neutral"
      launcher={createRef<HTMLButtonElement>()}
      nudge={HOME}
      onNudge={onNudge}
      {...props}
    >
      <p>Conversation</p>
    </AgentLauncher>,
  )
  const fab = () => document.querySelector<HTMLElement>('[data-tour="guide"]')!
  const dock = () => document.querySelector<HTMLElement>('.agent-dock')!
  const bubbles = () =>
    [...document.querySelectorAll<HTMLElement>('.agent-nudge')].filter(
      (b) => b.style.visibility !== 'hidden',
    )
  const enter = () => fireEvent.pointerEnter(dock(), { pointerType: 'mouse' })
  const leave = () => fireEvent.pointerLeave(dock(), { pointerType: 'mouse' })
  return { ...view, onNudge, onOpenChange, fab, dock, bubbles, enter, leave }
}
/** Lets the automatic once-per-screen nudge come and go. */
const pastTheNudge = () => {
  sessionStorage.setItem('worth.guide.nudged.home', '1')
  sessionStorage.setItem('worth.guide.nudged.chart', '1')
}

describe('the launcher on hover', () => {
  it('shows the screen’s nudge line after a beat, every time, and hides it on leave', () => {
    pastTheNudge()
    const { bubbles, enter, leave, fab } = launcher()
    for (let time = 0; time < 2; time++) {
      enter()
      expect(bubbles()).toHaveLength(0)
      act(() => vi.advanceTimersByTime(150))
      expect(bubbles()).toHaveLength(1)
      expect(bubbles()[0]!.textContent).toContain(HOME.text)
      expect(bubbles()[0]!.querySelectorAll('.chip-suggest')).toHaveLength(0)
      leave()
      act(() => vi.advanceTimersByTime(100))
      expect(bubbles()).toHaveLength(1)
      act(() => vi.advanceTimersByTime(150))
      expect(bubbles()).toHaveLength(0)
    }
    // The launcher keeps its name, and hover never marks the nudge as seen.
    expect(fab().getAttribute('aria-label')).toBe('Ask Worth')
    sessionStorage.removeItem('worth.guide.nudged.home')
    enter()
    act(() => vi.advanceTimersByTime(150))
    expect(sessionStorage.getItem('worth.guide.nudged.home')).toBeNull()
  })

  it('does what the nudge does when clicked, once', () => {
    pastTheNudge()
    const { bubbles, enter, onNudge } = launcher({ nudge: CHART })
    enter()
    act(() => vi.advanceTimersByTime(150))
    fireEvent.click(screen.getByRole('button', { name: /walk you through this chart/ }))
    expect(onNudge).toHaveBeenCalledExactlyOnceWith('Walk me through this chart')
    expect(bubbles()).toHaveLength(0)
  })

  it('is reachable by Tab from a focused launcher, and closes on Escape', () => {
    pastTheNudge()
    const { bubbles, fab } = launcher()
    const matches = Element.prototype.matches
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, s: string) {
      return s === ':focus-visible' ? true : matches.call(this, s)
    })
    act(() => fab().focus())
    act(() => vi.advanceTimersByTime(150))
    const text = bubbles()[0]!.querySelector<HTMLElement>('.agent-nudge-text')!
    // It follows the launcher in the document, so Tab moves into it.
    expect(fab().compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    act(() => text.focus())
    expect(bubbles()).toHaveLength(1)
    fireEvent.keyDown(text, { key: 'Escape' })
    expect(bubbles()).toHaveLength(0)
    expect(document.activeElement).toBe(fab())
  })

  it('stays away during the tour, while the panel is open, with no nudge, and for touch', () => {
    pastTheNudge()
    for (const props of [{ touring: true }, { open: true }, { nudge: undefined }]) {
      const { enter, bubbles, unmount } = launcher(props)
      enter()
      act(() => vi.advanceTimersByTime(500))
      expect(bubbles()).toHaveLength(0)
      unmount()
    }
    const { dock, bubbles } = launcher()
    fireEvent.pointerEnter(dock(), { pointerType: 'touch' })
    act(() => vi.advanceTimersByTime(500))
    expect(bubbles()).toHaveLength(0)
  })

  it('never stacks on the automatic nudge: it simply stays', () => {
    const { bubbles, enter, leave } = launcher()
    act(() => vi.advanceTimersByTime(1600))
    expect(bubbles()).toHaveLength(1)
    enter()
    act(() => vi.advanceTimersByTime(150))
    expect(document.querySelectorAll('.agent-nudge')).toHaveLength(1)
    leave()
    act(() => vi.advanceTimersByTime(250))
    // The automatic nudge keeps its own time; leaving does not take it away.
    expect(bubbles()).toHaveLength(1)
  })
})
