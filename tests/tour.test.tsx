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
    expect(document.documentElement.dataset.touring).toBe('')
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
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(screen.getByRole('dialog', { name: 'Where the rest goes' })).toBeTruthy()
    expect(screen.getByRole('dialog').textContent).toContain('2 of 3')
    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(screen.getByRole('dialog', { name: 'Safe to spend today' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Enter' })
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
    expect(tourSeen()).toBe(false)
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(tourSeen()).toBe(true)
    expect(document.documentElement.dataset.touring).toBeUndefined()
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('ends on Escape, on Skip, or on a click on the dimmed page', async () => {
    setSearch('?tour=1')
    anchors(['safe', 'bar'])
    const { unmount } = render(<Tour home blocked={false} onHome={() => {}} />)
    await dialog()
    fireEvent.keyDown(document, { key: 'Escape' })
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
    expect(screen.getByRole('dialog', { name: 'Saved for later' })).toBeTruthy()
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
