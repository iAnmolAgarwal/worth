// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screenNudge } from '../src/AgentLauncher'
import { api } from '../src/api'
import { applyChart, Ask, chartView } from '../src/Ask'
import { chartSnapshot, sendChartCommand } from '../src/chartControl'
import { ChartTile } from '../src/Decision'
import { compareOptions } from '../shared/finance'
import {
  ALEX_CAMERA_ID,
  ALEX_DEMO_DAY,
  createCameraScenario,
  createDemoState,
  PRODUCTS,
} from '../shared/seed'
import type { AppState, ChatReply, Comparison } from '../shared/types'

// The guide drives the balance chart: commands go through the chart's own setters, the chart
// publishes what it shows, and Ask applies a reply's change only to the same item's chart.

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>()
  return { ...actual, api: vi.fn() }
})
const apiMock = vi.mocked(api)

const halden = PRODUCTS.find((p) => p.id === ALEX_CAMERA_ID)!
const alex: Comparison = compareOptions(createCameraScenario(ALEX_DEMO_DAY).profile, [], {
  amountCents: halden.priceCents,
  itemName: halden.name,
  today: ALEX_DEMO_DAY,
  payIn4Eligible: true,
})
if (!alex.payIn4.available) throw new Error('Expected Pay in 4')
const p4 = alex.payIn4
const tile = () => <ChartTile c={alex} k="wait" scaleWith={p4} productId={ALEX_CAMERA_ID} />
const pill = (name: string | RegExp) =>
  within(screen.getByRole('group', { name: 'Options on the chart' })).getByRole('button', { name })
const range = (name: string) =>
  within(screen.getByRole('group', { name: 'Days shown' })).getByRole('button', { name })
const focus = () => screen.getByRole('complementary', { name: 'Day in focus' })

beforeEach(() => {
  apiMock.mockReset()
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('chart commands', () => {
  it('press pills, pick the range and pin a day, and announce it', () => {
    expect(sendChartCommand({ options: ['buyToday'] })).toBe(false)
    render(tile())
    expect(chartSnapshot()).toMatchObject({
      available: ['buyToday', 'wait', 'payIn4'],
      pressed: ['wait'],
      range: '60',
      focusDay: null,
      item: { name: 'Halden X5', amountCents: 189900, productId: ALEX_CAMERA_ID },
    })
    act(() => {
      expect(
        sendChartCommand({
          options: ['buyToday', 'payIn4'],
          range: 'payday',
          focusDay: '2026-11-20',
        }),
      ).toBe(true)
    })
    expect(pill('Buy today').getAttribute('aria-pressed')).toBe('true')
    expect(pill('Pay in 4').getAttribute('aria-pressed')).toBe('true')
    expect(pill(/^Wait until/).getAttribute('aria-pressed')).toBe('false')
    expect(range('To payday').getAttribute('aria-pressed')).toBe('true')
    expect(within(focus()).getByText('Fri, Nov 20')).toBeTruthy()
    expect(document.querySelector('.wchart-live')!.textContent).toBe(
      'Chart updated: Buy today and Pay in 4, Fri, Nov 20 in focus.',
    )
    expect(chartSnapshot()).toMatchObject({
      pressed: ['buyToday', 'payIn4'],
      range: 'payday',
      focusDay: '2026-11-20',
    })
  })

  it('widen the range for a day outside it, and ignore what the chart does not offer', () => {
    render(tile())
    act(() => {
      sendChartCommand({ range: 'payday' })
    })
    act(() => {
      sendChartCommand({ focusDay: '2026-12-31', options: ['spendLess'] })
    })
    expect(within(focus()).getByText('Thu, Dec 31')).toBeTruthy()
    expect(chartSnapshot()!.range).toBe('60')
    expect(chartSnapshot()!.pressed).toEqual(['wait'])
    act(() => {
      sendChartCommand({ focusDay: '2030-01-01' })
    })
    expect(chartSnapshot()!.focusDay).toBe('2026-12-31')
  })

  it('show "No purchase" for an empty list', () => {
    render(tile())
    act(() => {
      sendChartCommand({ options: [] })
    })
    expect(chartSnapshot()!.pressed).toEqual([])
    expect(document.querySelector('.wchart-live')!.textContent).toBe('Chart updated: No purchase.')
  })

  it('go only to the chart for the same item', () => {
    render(tile())
    const item = { name: 'Halden X5', amountCents: 189900, productId: ALEX_CAMERA_ID }
    const reply = (target: typeof item) =>
      ({
        message: '',
        mode: 'demo',
        intent: 'overview',
        suggestions: [],
        toolCalls: [],
        chart: { ...target, ...{} },
      }) as unknown as ChatReply
    let applied = ''
    act(() => {
      applied = applyChart({ ...reply(item), chart: { item, options: ['buyToday'] } })
    })
    expect(applied).toBe('moved')
    // An answer that changes nothing on the chart says nothing about the chart.
    expect(applyChart({ ...reply(item), chart: { item } })).toBe('unchanged')
    expect(pill('Buy today').getAttribute('aria-pressed')).toBe('true')
    act(() => {
      applied = applyChart({
        ...reply(item),
        chart: { item: { ...item, productId: 'camera' }, options: ['wait'] },
      })
    })
    expect(applied).toBe('absent')
    expect(pill(/^Wait until/).getAttribute('aria-pressed')).toBe('false')
    expect(chartView()).toEqual({
      screen: 'decision',
      productId: ALEX_CAMERA_ID,
      options: ['buyToday'],
      range: '60',
    })
  })
})

describe('a chart change off screen', () => {
  it('brings the chart card into view below the top bar, without gliding under reduced motion', () => {
    const scrollTo = vi.fn()
    vi.stubGlobal('scrollTo', scrollTo)
    vi.stubGlobal(
      'matchMedia',
      vi
        .fn()
        .mockImplementation((query: string) => ({
          matches: query.includes('reduce'),
          media: query,
        })),
    )
    render(
      <>
        <header className="topbar" />
        {tile()}
      </>,
    )
    const header = document.querySelector('.topbar')!
    header.getBoundingClientRect = () => ({ bottom: 88 }) as DOMRect
    const card = document.querySelector('.wchart')!.closest('section')!
    card.getBoundingClientRect = () => ({ top: 900, bottom: 1500 }) as DOMRect
    const item = { name: 'Halden X5', amountCents: 189900, productId: ALEX_CAMERA_ID }
    const reply = {
      message: '',
      mode: 'demo',
      intent: 'overview',
      suggestions: [],
      toolCalls: [],
    } as unknown as ChatReply
    act(() => {
      expect(applyChart({ ...reply, chart: { item, options: ['buyToday'] } })).toBe('moved')
    })
    expect(scrollTo).toHaveBeenCalledWith({ top: 900 - 88 - 12, behavior: 'instant' })
    // Already in view: it stays put.
    scrollTo.mockClear()
    card.getBoundingClientRect = () => ({ top: 120, bottom: 700 }) as DOMRect
    act(() => {
      applyChart({ ...reply, chart: { item, focusDay: '2026-11-30' } })
    })
    expect(scrollTo).not.toHaveBeenCalled()
  })
})

describe('Ask on the chart', () => {
  const state = (): AppState => {
    const seed = createDemoState(ALEX_DEMO_DAY)
    return {
      ...seed,
      reviews: [],
      today: ALEX_DEMO_DAY,
      products: PRODUCTS,
      saved: [],
      retention: { keep30: false, expiresAt: `${ALEX_DEMO_DAY}T16:00:00.000Z` },
      config: { ai: 'anthropic', paypal: 'demo', model: 'test-provider' },
    }
  }
  const askProps = {
    visible: true,
    onOpenDecision: vi.fn(),
    onOpenCheckout: vi.fn(),
    onNavigate: vi.fn(),
  }
  const chartAnswer: ChatReply = {
    message: 'Buy today: Below your $300.00 cushion from Thu, Nov 19.',
    mode: 'demo',
    intent: 'overview',
    suggestions: [],
    toolCalls: ['show_on_chart'],
    chart: {
      options: ['buyToday'],
      focusDay: '2026-11-30',
      item: { name: 'Halden X5', amountCents: 189900, productId: ALEX_CAMERA_ID },
    },
  }

  it('sends what the chart shows and applies the answer’s change to it', async () => {
    const user = userEvent.setup()
    const requests: { view?: unknown }[] = []
    apiMock.mockImplementation(((_path: string, data: { view?: unknown }) => {
      requests.push(data)
      return Promise.resolve(chartAnswer)
    }) as never)
    render(
      <>
        {tile()}
        <Ask {...askProps} state={state()} layout="panel" />
      </>,
    )
    await user.type(screen.getByRole('textbox', { name: 'Message Worth' }), 'If I buy today?')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('The chart now shows this.')
    expect(requests[0]!.view).toEqual({
      screen: 'decision',
      productId: ALEX_CAMERA_ID,
      options: ['wait'],
      range: '60',
    })
    expect(pill('Buy today').getAttribute('aria-pressed')).toBe('true')
    expect(within(focus()).getByText('Mon, Nov 30')).toBeTruthy()
  })

  it('offers the comparison instead when that chart is not on screen', async () => {
    const user = userEvent.setup()
    apiMock.mockImplementation((() => Promise.resolve(chartAnswer)) as never)
    const onOpenDecision = vi.fn()
    render(<Ask {...askProps} state={state()} layout="panel" onOpenDecision={onOpenDecision} />)
    await user.type(screen.getByRole('textbox', { name: 'Message Worth' }), 'Explain the chart')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await user.click(await screen.findByRole('button', { name: /Open Worth’s comparison/ }))
    expect(onOpenDecision).toHaveBeenCalledWith({ productId: ALEX_CAMERA_ID })
    expect(screen.queryByText('The chart now shows this.')).toBeNull()
  })
})

describe('the nudge for each screen', () => {
  it('offers a walk-through on the chart and a line for Home, Plan and Saved', () => {
    const s = { ...createDemoState(ALEX_DEMO_DAY), today: ALEX_DEMO_DAY } as unknown as AppState
    // Before the chart is on screen (an empty /check, a comparison loading) there is none.
    expect(screenNudge('decision', s)).toBeUndefined()
    expect(screenNudge('check', s)).toBeUndefined()
    expect(screenNudge('decision', s, true)).toEqual({
      id: 'chart',
      text: 'Want me to walk you through this chart?',
      ask: 'Walk me through this chart',
    })
    expect(screenNudge('check', s, true)!.id).toBe('chart')
    expect(screenNudge('home', s)!.text).toMatch(/Ask me before you buy\.$|Ask me first\.$/)
    expect(screenNudge('plan', s)!.ask).toBe('What bills are coming up?')
    expect(screenNudge('saved', s)!.ask).toBeUndefined()
    expect(screenNudge('activity', s)).toBeUndefined()
  })
})

describe('amounts in an answer', () => {
  it('keep each amount and its minus sign on one line', async () => {
    const { amountsOnOneLine } = await import('../src/Ask')
    render(
      <p data-testid="p">
        {amountsOnOneLine('Lowest -$726.74 on Mon, Nov 30, then $1,650.00 lands.')}
      </p>,
    )
    const spans = [...screen.getByTestId('p').querySelectorAll('.nowrap')].map((s) => s.textContent)
    expect(spans).toEqual(['−$726.74', '$1,650.00'])
    expect(screen.getByTestId('p').textContent).toBe(
      'Lowest −$726.74 on Mon, Nov 30, then $1,650.00 lands.',
    )
  })
})
