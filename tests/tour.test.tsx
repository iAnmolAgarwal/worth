// @vitest-environment jsdom
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentLauncher } from '../src/AgentLauncher'
import {
  autoStart,
  placeCallout,
  presentSteps,
  rememberTour,
  shownBox,
  Tour,
  TOUR_KEY,
  TOUR_STEPS,
  tourSeen,
} from '../src/Tour'

// The first-visit tour: when it starts, which steps it shows, where the callout goes, and that it
// ends cleanly by keyboard or mouse, remembering it was seen.

const box = (left: number, top: number, width: number, height: number) =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect

/** Puts a laid-out element for each anchor on the page, as Home would. */
function anchors(names: string[]) {
  const main = document.createElement('main')
  main.id = 'main'
  names.forEach((name, index) => {
    const element = document.createElement('button')
    element.dataset.tour = name
    element.textContent = name
    element.getBoundingClientRect = () => box(100, 120 + index * 80, 200, 40)
    main.append(element)
  })
  document.body.append(main)
  return main
}

function setSearch(search: string) {
  window.history.replaceState(null, '', `/${search}`)
}

beforeEach(() => {
  localStorage.clear()
  setSearch('')
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('when the tour starts by itself', () => {
  it('runs on a first visit only, and never under automation', () => {
    expect(autoStart('', false, false)).toBe(true)
    expect(autoStart('', true, false)).toBe(false)
    expect(autoStart('', false, true)).toBe(false)
  })
  it('?tour=1 forces it and ?tour=0 suppresses it, whatever else holds', () => {
    expect(autoStart('?tour=1', true, true)).toBe(true)
    expect(autoStart('?tour=0', false, false)).toBe(false)
    expect(autoStart('?x=2&tour=0', false, false)).toBe(false)
    // Any other value is no override.
    expect(autoStart('?tour=yes', true, false)).toBe(false)
  })
})

describe('the seen flag', () => {
  it('is stored and read back', () => {
    expect(tourSeen()).toBe(false)
    rememberTour()
    expect(localStorage.getItem(TOUR_KEY)).toBe('1')
    expect(tourSeen()).toBe(true)
  })
  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(tourSeen()).toBe(false)
    expect(() => rememberTour()).not.toThrow()
  })
})

describe('the steps', () => {
  it('are six, in order, short enough to read at a glance', () => {
    expect(TOUR_STEPS.map((step) => step.anchor)).toEqual([
      'safe',
      'bar',
      'check',
      'guide',
      'saved',
      'connect',
    ])
    for (const step of TOUR_STEPS) {
      expect(step.title.split(/\s+/).length).toBeLessThanOrEqual(4)
      expect(step.text.split(/\s+/).length).toBeLessThanOrEqual(14)
    }
  })
  it('skip a feature that is not on the page, or has no size', () => {
    anchors(['safe', 'check', 'saved'])
    const hidden = document.createElement('div')
    hidden.dataset.tour = 'guide'
    hidden.getBoundingClientRect = () => box(0, 0, 0, 0)
    document.body.append(hidden)
    expect(presentSteps().map((step) => step.anchor)).toEqual(['safe', 'check', 'saved'])
  })
  it('use the laid-out copy of an anchor when a hidden one comes first', () => {
    const hidden = document.createElement('a')
    hidden.dataset.tour = 'saved'
    hidden.getBoundingClientRect = () => box(0, 0, 0, 0)
    document.body.append(hidden)
    anchors(['saved'])
    expect(presentSteps().map((step) => step.anchor)).toEqual(['saved'])
  })
})

describe('the cut-out for the big amount', () => {
  it('fits the figures, leaving out screen-reader text and trimming the line box', () => {
    const amount = document.createElement('p')
    amount.getBoundingClientRect = () => box(100, 100, 600, 140)
    const shown = document.createElement('span')
    shown.getBoundingClientRect = () => box(100, 100, 300, 140)
    const sr = document.createElement('span')
    sr.getBoundingClientRect = () => box(100, 100, 1, 1)
    amount.append(shown, sr)
    // jsdom has no layout for ranges, so the child's own box stands in for its text.
    expect(shownBox(amount)).toEqual({ left: 100, top: 121, width: 300, height: 98 })
    expect(shownBox(document.createElement('p'))).toEqual({ left: 0, top: 0, width: 0, height: 0 })
  })
})

describe('placing the callout', () => {
  const view = { width: 1440, height: 900 }
  const size = { width: 296, height: 140 }
  it('takes the preferred side when it fits, with the arrow at the target', () => {
    const target = { left: 200, top: 200, width: 400, height: 150 }
    const place = placeCallout(target, size, view, ['right'])
    expect(place.side).toBe('right')
    // Pad 6 + arrow 10: the arrow's tip touches the bright edge.
    expect(place.left).toBe(616)
    expect(place.top + place.arrow).toBe(275)
  })
  it('flips when there is no room', () => {
    const target = { left: 1300, top: 400, width: 100, height: 40 }
    expect(placeCallout(target, size, view, ['right']).side).toBe('bottom')
    const low = { left: 600, top: 820, width: 100, height: 40 }
    expect(placeCallout(low, size, view, ['bottom']).side).toBe('top')
  })
  it('never covers the launcher, and keeps off other features when it can', () => {
    const target = { left: 1200, top: 680, width: 200, height: 40 }
    const launcher = { left: 1360, top: 820, width: 56, height: 56 }
    expect(placeCallout(target, size, view, ['bottom'], [launcher]).side).not.toBe('bottom')
    const other = { left: 1190, top: 450, width: 210, height: 200 }
    expect(placeCallout(target, size, view, ['top', 'left'], [launcher], [other]).side).toBe('left')
  })
  it('stays inside the window when nothing fits', () => {
    const huge = { left: 0, top: 0, width: 1440, height: 900 }
    const place = placeCallout(huge, size, view, ['bottom'])
    expect(place.left).toBeGreaterThanOrEqual(12)
    expect(place.top + size.height).toBeLessThanOrEqual(888)
  })
})

describe('the tour on Home', () => {
  const dialog = () =>
    screen.findByRole('dialog', { name: 'Safe to spend today' }, { timeout: 3000 })

  it('waits while Home is still loading, then starts with only the steps it can show', async () => {
    setSearch('?tour=1')
    const main = anchors(['safe', 'check'])
    const busy = document.createElement('section')
    busy.setAttribute('aria-busy', 'true')
    main.append(busy)
    render(<Tour home blocked={false} onHome={() => {}} />)
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(screen.queryByRole('dialog')).toBeNull()
    busy.remove()
    expect((await dialog()).textContent).toContain('1 of 2')
  })

  it('does not start on a return visit, or while the panel is open', async () => {
    anchors(['safe'])
    localStorage.setItem(TOUR_KEY, '1')
    const { unmount } = render(<Tour home blocked={false} onHome={() => {}} />)
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(screen.queryByRole('dialog')).toBeNull()
    unmount()
    setSearch('?tour=1')
    render(<Tour home blocked onHome={() => {}} />)
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('walks forward and back by keyboard, and sets the flag at the end', async () => {
    setSearch('?tour=1')
    anchors(['safe', 'bar', 'guide'])
    const opener = document.createElement('button')
    opener.getClientRects = () => [box(0, 0, 80, 30)] as unknown as DOMRectList
    document.body.append(opener)
    opener.focus()
    render(<Tour home blocked={false} onHome={() => {}} />)
    const callout = await dialog()
    await waitFor(() => expect(document.activeElement).toBe(callout))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(screen.getByRole('dialog', { name: 'Where the rest goes' })).toBeTruthy()
    expect(screen.getByRole('dialog').textContent).toContain('2 of 3')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(screen.getByRole('dialog', { name: 'Safe to spend today' })).toBeTruthy()
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
    expect(tourSeen()).toBe(false)
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(tourSeen()).toBe(true)
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('ends on Escape, on Skip, or on a click on the dimmed page', async () => {
    setSearch('?tour=1')
    anchors(['safe', 'bar'])
    const { unmount } = render(<Tour home blocked={false} onHome={() => {}} />)
    const callout = await dialog()
    await waitFor(() => expect(document.activeElement).toBe(callout))
    fireEvent.keyDown(callout, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(tourSeen()).toBe(true)
    unmount()

    render(<Tour home blocked={false} onHome={() => {}} />)
    await dialog()
    await userEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    cleanup()

    render(<Tour home blocked={false} onHome={() => {}} />)
    await dialog()
    fireEvent.click(document.querySelector('.tour-pane')!)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a step whose feature has gone is skipped as the tour reaches it', async () => {
    setSearch('?tour=1')
    anchors(['safe', 'bar', 'saved'])
    render(<Tour home blocked={false} onHome={() => {}} />)
    await dialog()
    act(() => document.querySelector('[data-tour="bar"]')!.remove())
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    // It may still be mounting: the tour gives it a moment before moving on.
    expect(
      await screen.findByRole('dialog', { name: 'Saved for later' }, { timeout: 3000 }),
    ).toBeTruthy()
  })

  it('leaving Home or opening the panel ends it', async () => {
    setSearch('?tour=1')
    anchors(['safe', 'bar'])
    const { rerender } = render(<Tour home blocked={false} onHome={() => {}} />)
    await dialog()
    rerender(<Tour home blocked onHome={() => {}} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(tourSeen()).toBe(true)
  })

  it('leaves keys meant for the page alone, and keeps Tab inside the callout', async () => {
    setSearch('?tour=1')
    anchors(['safe', 'bar'])
    render(<Tour home blocked={false} onHome={() => {}} />)
    const callout = await dialog()
    await waitFor(() => expect(document.activeElement).toBe(callout))
    // Enter on a control of the page (the bright feature, say) reaches that control.
    const feature = document.querySelector<HTMLElement>('[data-tour="safe"]')!
    const pressed = vi.fn()
    feature.addEventListener('keydown', (event) => pressed(event.key, event.defaultPrevented))
    for (const key of ['Enter', 'ArrowRight', 'ArrowLeft', 'Escape'])
      fireEvent.keyDown(feature, { key })
    expect(pressed.mock.calls).toEqual([
      ['Enter', false],
      ['ArrowRight', false],
      ['ArrowLeft', false],
      ['Escape', false],
    ])
    expect(screen.getByRole('dialog', { name: 'Safe to spend today' })).toBeTruthy()
    // Tab from the callout goes to its first control and cycles; Shift+Tab goes the other way.
    fireEvent.keyDown(callout, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Skip' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Skip' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }))
    // Tab from the page comes back into the callout.
    feature.focus()
    fireEvent.keyDown(feature, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Skip' }))
  })

  it('shows Back from step 2', async () => {
    setSearch('?tour=1')
    anchors(['safe', 'bar'])
    render(<Tour home blocked={false} onHome={() => {}} />)
    await dialog()
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('dialog', { name: 'Safe to spend today' })).toBeTruthy()
  })

  it('waits for the amount while the hero is still mounting, then starts on it', async () => {
    setSearch('?tour=1')
    const main = anchors(['bar', 'guide'])
    render(<Tour home blocked={false} onHome={() => {}} />)
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(screen.queryByRole('dialog')).toBeNull()
    const amount = document.createElement('p')
    amount.dataset.tour = 'safe'
    amount.getBoundingClientRect = () => box(100, 40, 200, 60)
    main.prepend(amount)
    expect((await dialog()).textContent).toContain('1 of 3')
  })

  it('ending because the screen changed leaves focus alone', async () => {
    setSearch('?tour=1')
    anchors(['safe', 'guide'])
    const { rerender } = render(<Tour home blocked={false} onHome={() => {}} />)
    const callout = await dialog()
    await waitFor(() => expect(document.activeElement).toBe(callout))
    const field = document.createElement('input')
    document.body.append(field)
    field.focus()
    rerender(<Tour home={false} blocked={false} onHome={() => {}} />)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(document.activeElement).toBe(field)
  })

  it('"Take the tour" in the guide panel closes it and replays the tour from Home', async () => {
    anchors(['safe', 'guide'])
    localStorage.setItem(TOUR_KEY, '1')
    const onHome = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <>
        <AgentLauncher open onOpenChange={onOpenChange} mood="neutral" launcher={createRef()}>
          <p>Conversation</p>
        </AgentLauncher>
        <Tour home blocked={false} onHome={onHome} />
      </>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Take the tour' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onHome).toHaveBeenCalled()
    expect((await dialog()).textContent).toContain('1 of 2')
  })
})

describe('the guide’s nudge and the tour', () => {
  it('does not arm while a tour is pending or running, and arms once it is over', () => {
    vi.useFakeTimers()
    try {
      sessionStorage.clear()
      const props = {
        open: false,
        onOpenChange: () => {},
        mood: 'neutral' as const,
        launcher: createRef<HTMLButtonElement>(),
        nudge: 'Rent is due in 18 days. Ask me before you buy.',
      }
      const { rerender } = render(
        <AgentLauncher {...props} touring>
          <p>Conversation</p>
        </AgentLauncher>,
      )
      act(() => vi.advanceTimersByTime(15_000))
      expect(document.querySelector('.agent-nudge')).toBeNull()
      expect(sessionStorage.getItem('worth.guide.nudged')).toBeNull()
      rerender(
        <AgentLauncher {...props} touring={false}>
          <p>Conversation</p>
        </AgentLauncher>,
      )
      act(() => vi.advanceTimersByTime(1600))
      expect(document.querySelector('.agent-nudge')?.textContent).toContain('Rent is due')
      expect(sessionStorage.getItem('worth.guide.nudged')).toBe('1')
    } finally {
      vi.useRealTimers()
    }
  })
})
