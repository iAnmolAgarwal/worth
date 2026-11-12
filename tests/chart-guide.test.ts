import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../server/app.ts'
import {
  asksAboutChart,
  chartFacts,
  chartReply,
  claudeChoice,
  localChartChoice,
  namedDay,
  showOnChartTool,
  validDirective,
  type ChartView,
} from '../server/chartGuide.ts'
import { Store } from '../server/store.ts'
import { ALEX_CAMERA_ID, ALEX_DEMO_DAY, createCameraScenario } from '../shared/seed.ts'

// Ask Worth on the balance chart: the facts come from the engine in the chart's own words, Claude
// only picks facts and a view (show_on_chart), and the server checks every field.

const alex = createCameraScenario(ALEX_DEMO_DAY)
const data = { profile: alex.profile, purchases: [], today: ALEX_DEMO_DAY }
const view: ChartView = { screen: 'decision', productId: ALEX_CAMERA_ID, options: ['wait'] }
const facts = chartFacts(view, data, true)!
const text = (id: string) => facts.facts.find((fact) => fact.id === id)?.text

describe('the chart’s facts', () => {
  it('state what the chart states for Alex’s camera', () => {
    expect(text('line_wait')).toBe(
      'Wait until Tue, Dec 15: Stays above your $300.00 cushion. Lowest $458.78 on Thu, Dec 31.',
    )
    expect(text('line_buyToday')).toBe(
      'Buy today: Below your $300.00 cushion from Thu, Nov 19 and below zero from Fri, Nov 20. Lowest −$726.74 on Mon, Nov 30. It is below the cushion Nov 19 – Nov 30 and Dec 10 – Dec 14.',
    )
    expect(text('line_payIn4')).toBe(
      'Pay in 4: Below your $300.00 cushion from Sun, Nov 29. Lowest $222.76 on Mon, Nov 30. Back above on Tue, Dec 1.',
    )
    expect(text('fit_date')).toMatch(/^Tue, Dec 15 is the first day/)
    expect(text('legend')).toContain('dotted line is your $300.00 cushion')
    // Pay in 4 is described, never recommended.
    expect(facts.facts.map((fact) => fact.text).join(' ')).not.toMatch(/recommend|makes it fit/i)
  })

  it('refuse an item they cannot price', () => {
    expect(
      chartFacts({ screen: 'decision', productId: 'no-such-item' }, data, true),
    ).toBeUndefined()
    expect(chartFacts({ screen: 'decision', itemName: 'Lamp' }, data, true)).toBeUndefined()
  })
})

describe('reading a chart question', () => {
  it('knows a chart question and the day it names', () => {
    expect(asksAboutChart('Explain this graph')).toBe(true)
    expect(asksAboutChart('What’s the red area?')).toBe(true)
    expect(asksAboutChart('Why Dec 15?')).toBe(true)
    expect(asksAboutChart('Can I afford a $40 lamp?')).toBe(false)
    expect(namedDay('What happens on the 30th?', facts.window)).toBe('2026-11-30')
    expect(namedDay('and Dec 15', facts.window)).toBe('2026-12-15')
  })

  it('answers in at most three sentences and moves the chart to what it explains', () => {
    const cases: [string, object][] = [
      ['Show me what happens if I buy today', { options: ['buyToday'], focusDay: '2026-11-30' }],
      ['Zoom to payday', { range: 'payday', focusDay: '2026-11-30' }],
      ['Why Dec 15?', { options: ['wait', 'buyToday'], focusDay: '2026-12-15' }],
      ['Show me the lowest day', { focusDay: '2026-12-31' }],
      ['What if I don’t buy it?', { options: [] }],
    ]
    for (const [question, directive] of cases) {
      const reply = chartReply(facts, localChartChoice(question, facts, view), view, 'demo')
      const { item, ...shown } = reply.chart!
      expect(shown, question).toEqual(directive)
      expect(item).toEqual({ name: 'Halden X5', amountCents: 189900, productId: ALEX_CAMERA_ID })
      expect(
        reply.message.split(/[.!?](?:\s|$)/).filter((s) => s.trim()).length,
      ).toBeLessThanOrEqual(3)
    }
    const red = chartReply(
      facts,
      localChartChoice('What’s the red area?', facts, view),
      view,
      'demo',
    )
    expect(red.message).toMatch(/^The dotted line is your \$300\.00 cushion and red shading/)
  })
})

describe('the show_on_chart tool', () => {
  it('offers only this item’s options and the window’s days', () => {
    const tool = showOnChartTool(facts)
    const props = tool.input_schema.properties
    expect(props.options.items.enum).toEqual(['buyToday', 'wait', 'payIn4'])
    expect(props.range.enum).toEqual(['keep', 'payday', '30', '60'])
    expect(props.focus_day.enum[0]).toBe('none')
    expect(props.focus_day.enum).toContain('2026-12-15')
  })

  it('drops anything outside the item, the ranges and the window', () => {
    expect(
      validDirective(
        { options: ['spendLess', 'buy', 'wait'], range: 'year', focus_day: '2027-05-01' },
        facts,
      ),
    ).toEqual({ options: ['wait'] })
    expect(validDirective({ options: ['checkout'] }, facts)).toBeUndefined()
    expect(validDirective({ options: [] }, facts)).toEqual({ options: [] })
    expect(validDirective('navigate to #saved', facts)).toBeUndefined()
    expect(
      claudeChoice(
        {
          facts: ['made_up', 'line_buyToday'],
          change_options: false,
          options: ['wait'],
          range: 'keep',
          focus_day: '2026-11-30',
        },
        facts,
      ),
    ).toEqual({ ids: ['line_buyToday'], directive: { focusDay: '2026-11-30' } })
    expect(
      claudeChoice(
        {
          facts: ['made_up'],
          change_options: false,
          options: [],
          range: 'keep',
          focus_day: 'none',
        },
        facts,
      ),
    ).toBeUndefined()
  })
})

describe('POST /api/chat with a chart view', () => {
  const stores: Store[] = []
  afterEach(() => {
    for (const store of stores.splice(0)) store.close()
  })
  const config = {
    production: false,
    origin: 'http://localhost:5173',
    paypalClientId: undefined,
    paypalSecret: undefined,
    anthropicKey: undefined,
  }
  function setup(chat: object) {
    const store = new Store(':memory:')
    stores.push(store)
    const app = createApp({
      store,
      config,
      now: () => new Date(`${ALEX_DEMO_DAY}T12:00:00Z`),
      chat: chat as never,
    })
    return request.agent(app)
  }
  const post = (agent: ReturnType<typeof setup>, body: object) =>
    agent.post('/api/chat').set('X-Worth-Client', 'web').send(body)

  it('lets Claude choose facts and the view, and checks both', async () => {
    const reply = vi.fn()
    const chooseChart = vi.fn(async () => ({
      facts: ['line_buyToday', 'invented'],
      change_options: true,
      options: ['buyToday', 'checkout'],
      range: 'payday',
      focus_day: '2099-01-01',
    }))
    const agent = setup({ reply, chooseChart })
    const response = await post(agent, {
      message: 'Show me what happens if I buy today on the chart',
      history: [],
      view: { screen: 'decision', productId: ALEX_CAMERA_ID, options: ['wait'], range: '60' },
    })
    expect(response.status).toBe(200)
    expect(reply).not.toHaveBeenCalled()
    // The sample plan on this server is whatever its session holds; the answer is its own facts.
    expect(response.body.message).toMatch(/^Buy today: /)
    expect(response.body.mode).toBe('anthropic')
    expect(response.body.toolCalls).toEqual(['show_on_chart'])
    const { item, ...shown } = response.body.chart
    expect(shown).toEqual({ options: ['buyToday'], range: 'payday' })
    expect(item.productId).toBe(ALEX_CAMERA_ID)
  })

  it('answers from Worth’s own rules when Claude fails, and leaves other questions alone', async () => {
    const reply = vi.fn(async () => ({
      message: 'plain',
      mode: 'anthropic' as const,
      intent: 'overview' as const,
      suggestions: [],
      toolCalls: [],
    }))
    const chooseChart = vi.fn(async () => {
      throw new Error('down')
    })
    const agent = setup({ reply, chooseChart })
    const chart = await post(agent, {
      message: 'Explain this graph',
      history: [],
      view: { screen: 'decision', productId: ALEX_CAMERA_ID },
    })
    expect(chart.body.mode).toBe('demo')
    expect(chart.body.message).toMatch(/^The dotted line is your/)
    const other = await post(agent, {
      message: 'Can I afford a $40 lamp?',
      history: [],
      view: { screen: 'decision', productId: ALEX_CAMERA_ID },
    })
    expect(other.body.message).toBe('plain')
    expect(other.body.chart).toBeUndefined()
  })

  it('refuses a view that is not one Worth knows', async () => {
    const agent = setup({ reply: vi.fn(), chooseChart: vi.fn() })
    for (const view of [
      { screen: 'settings' },
      { screen: 'decision', productId: ALEX_CAMERA_ID, options: ['buy now'] },
      { screen: 'decision', productId: ALEX_CAMERA_ID, focusDay: 'tomorrow' },
      { screen: 'decision', productId: ALEX_CAMERA_ID, extra: 1 },
    ])
      expect((await post(agent, { message: 'Explain this graph', history: [], view })).status).toBe(
        400,
      )
  })
})
