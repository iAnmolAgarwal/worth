// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Anthropic from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Ask } from '../src/Ask'
import { Decision } from '../src/Decision'
import { Home } from '../src/Home'
import { api } from '../src/api'
import { createChatProvider, fallbackReply } from '../server/chat'
import { compareOptions } from '../shared/finance'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type { AppState, ChatReply } from '../shared/types'

// The AI-visible phase in the UI: the Pay in 4 strip and row in Ask, the trace disclosure, the
// sentence under the verdict, the collision on Home and the compare row under Decision's options.

vi.mock('../src/paypalSdk', () => ({ loadPayPalSdk: vi.fn() }))
vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>()
  return { ...actual, api: vi.fn() }
})
vi.mock('recharts', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>
  const Nothing = () => null
  return {
    ResponsiveContainer: Pass,
    ComposedChart: ({ children }: { children?: ReactNode }) => <svg>{children}</svg>,
    Area: Nothing,
    Line: Nothing,
    ReferenceArea: Nothing,
    ReferenceDot: Nothing,
    ReferenceLine: Nothing,
    XAxis: Nothing,
    YAxis: Nothing,
  }
})

const TODAY = '2026-10-03'
const apiMock = vi.mocked(api)
function makeState(): AppState {
  const seed = createDemoState(TODAY)
  return {
    ...seed,
    profile: { ...seed.profile, aiConsent: true },
    reviews: [],
    today: TODAY,
    products: PRODUCTS,
    saved: [],
    config: { ai: 'anthropic', paypal: 'demo', model: 'test-provider' },
  }
}
const data = (state: AppState) => ({
  profile: state.profile,
  purchases: state.purchases,
  transactions: state.transactions,
  today: TODAY,
})
function compare(state: AppState, input: unknown) {
  const request = input as { productId?: string; amountCents?: number; itemName?: string }
  const product = PRODUCTS.find((p) => p.id === request.productId)
  return compareOptions(state.profile, state.purchases, {
    amountCents: product?.priceCents ?? request.amountCents!,
    itemName: product?.name ?? request.itemName,
    today: TODAY,
    payIn4Eligible: true,
  })
}
/** A real reply from the chat pipeline, with Claude's calls replayed from fixed responses. */
async function claudeReply(
  state: AppState,
  message: string,
  calls: Record<string, unknown>[][],
): Promise<ChatReply> {
  const create = vi.fn(async () => ({ content: calls.shift() ?? [], stop_reason: 'end_turn' }))
  const client = { messages: { create } } as unknown as Pick<Anthropic, 'messages'>
  const provider = createChatProvider('unused', 'claude-sonnet-5-5', client, { log: () => {} })
  return provider.reply(
    {
      message,
      history: [],
      context: { amountCents: 119900, itemName: 'Everyday camera', purchaseDate: TODAY },
    },
    data(state),
  )
}
const interpret = (input: Record<string, unknown>) => [
  {
    type: 'tool_use',
    id: 't1',
    name: 'interpret_purchase',
    input: {
      items: [],
      combine: 'single',
      refers_to_previous_item: true,
      date_phrase: null,
      date: null,
      option: 'check',
      lead_in: 'none',
      follow_ups: [],
      ...input,
    },
  },
]
const note = (text: string) => [{ type: 'text', text: JSON.stringify({ note: text }) }]
async function ask(
  state: AppState,
  answer: ChatReply,
  props: Partial<Parameters<typeof Ask>[0]> = {},
) {
  const user = userEvent.setup()
  apiMock.mockImplementation(((path: string, input: unknown) =>
    Promise.resolve(path === '/compare' ? compare(state, input) : answer)) as typeof api)
  render(
    <Ask
      visible
      state={state}
      onOpenDecision={vi.fn()}
      onOpenCheckout={vi.fn()}
      onNavigate={vi.fn()}
      {...props}
    />,
  )
  await user.type(screen.getByRole('textbox', { name: 'Message Worth' }), 'question')
  await user.click(screen.getByRole('button', { name: 'Send' }))
  return user
}

beforeEach(() => {
  apiMock.mockReset()
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Ask Worth shows its work', () => {
  it('answers a Pay in 4 question with the illustrative schedule, never a recommendation', async () => {
    const state = makeState()
    const answer = await claudeReply(state, 'Is Pay in 4 cheaper than paying now?', [
      interpret({ points: ['pay_in_4_schedule'] }),
      note('Most of the pressure is {cause_bill} on {cause_day}, before {income_name}.'),
    ])
    await ask(state, answer)
    const strip = await screen.findByRole('region', {
      name: 'PayPal Pay in 4, illustrative schedule',
    })
    const payments = within(strip).getAllByRole('listitem')
    expect(payments).toHaveLength(4)
    expect(payments[0]!.textContent).toContain('Today')
    expect(payments[1]!.textContent).toContain('About Sat, Oct 17')
    expect(payments[1]!.textContent).toContain('About 1 day after your apartment rent')
    expect(strip.textContent).toContain('about every 2 weeks')
    expect(strip.textContent).toContain('PayPal charges no interest')
    expect(strip.textContent).toContain(
      'Schedule is illustrative; PayPal’s may differ by a few days.',
    )
    expect(strip.textContent).toContain('You already have 1 instalment plan')
    expect(strip.textContent).not.toMatch(/Recommended|recommend it\b(?!\.)/)
    // The neutral row is for answers that didn't ask; this one shows the schedule instead.
    expect(screen.queryByText(/^PayPal Pay in 4:/)).toBeNull()
  })

  it('puts Claude’s checked sentence under the verdict and opens the trace on request', async () => {
    const state = makeState()
    const answer = await claudeReply(state, 'Can I afford it?', [
      interpret({
        points: ['low_point', 'cause'],
        point_reasons: [
          { point: 'low_point', reason: 'answers_question' },
          { point: 'cause', reason: 'explains_result' },
        ],
      }),
      note('Most of the pressure is {cause_bill} on {cause_day}, before {income_name}.'),
    ])
    const user = await ask(state, answer)
    const sentence = await screen.findByText(
      'Most of the pressure is Apartment rent on Fri, Oct 16, before Biweekly paycheck.',
    )
    expect(sentence.previousElementSibling?.className).toBe('verdict')
    const toggle = screen.getByRole('button', { name: 'How Ask Worth read this' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const trace = document.getElementById(toggle.getAttribute('aria-controls')!)!
    expect(trace.hidden).toBe(false)
    expect(trace.textContent).toContain('Everyday camera · $1,199.00 (earlier in this chat)')
    expect(trace.textContent).toContain('Kept from earlier in this chat → today')
    expect(trace.textContent).toContain('interpret_purchase · ran')
    expect(trace.textContent).toContain('Your low point · answers what you asked')
    expect(trace.textContent).toContain('What drives it · explains the result')
    expect(trace.textContent).toContain('The amount is the one Worth read earlier in this chat')
    expect(trace.textContent).toContain('The verdict sentence is Worth’s template')
    expect(trace.textContent).toContain(
      'Claude wrote “Most of the pressure is {cause_bill} on {cause_day}, before {income_name}.”',
    )
    expect(within(trace).getAllByLabelText('Passed').length).toBeGreaterThan(2)
  })

  it('adds one neutral Pay in 4 row to a purchase answer that didn’t ask', async () => {
    const state = makeState()
    const onOpenDecision = vi.fn()
    const answer = fallbackReply(
      { message: 'Can I afford a $1,199 camera?', history: [] },
      data(state),
    )
    const user = await ask(state, answer, { onOpenDecision })
    const row = await screen.findByText(/^PayPal Pay in 4:/)
    expect(row.textContent).toBe(
      'PayPal Pay in 4: payment 2 would land about 1 day after your apartment rent · Compare',
    )
    await user.click(within(row).getByRole('button', { name: 'Compare' }))
    expect(onOpenDecision).toHaveBeenCalledWith({ productId: 'camera' }, expect.anything())
    expect(row.textContent).not.toMatch(/recommend/i)
    // Local mode: the trace says no tool ran and Claude was not used.
    await user.click(screen.getByRole('button', { name: 'How Ask Worth read this' }))
    expect(screen.getByText('None: Worth’s own rules read this, without Claude')).toBeTruthy()
  })

  it('says what the assistant does, without claiming it explains every answer', async () => {
    const state = makeState()
    await ask(
      state,
      fallbackReply({ message: 'What bills are coming up?', history: [] }, data(state)),
    )
    expect(
      screen.getAllByText(
        'On: Claude reads your question, picks which of Worth’s facts to show and adds one checked sentence. Every number is Worth’s.',
      ).length,
    ).toBeGreaterThan(0)
    expect(screen.queryByText(/explains answers/)).toBeNull()
  })
})

describe('the collision, surfaced', () => {
  it('names the laptop payment that lands the day before rent on Home', () => {
    const state = makeState()
    apiMock.mockImplementation(((_path: string, input: unknown) =>
      Promise.resolve(compare(state, input))) as typeof api)
    render(
      <Home
        state={state}
        onAsk={vi.fn()}
        onNavigate={vi.fn()}
        onOpenProduct={vi.fn()}
        onEditPlan={vi.fn()}
        onOpenCheckout={vi.fn()}
        onConfirmPlan={vi.fn()}
        onReviewRefund={vi.fn()}
      />,
    )
    const insight = screen.getByRole('region', { name: 'Pay in 4 payment next to a bill' })
    expect(insight.textContent).toContain(
      'Your laptop Pay in 4 payment lands about 1 day before your apartment rent',
    )
    expect(insight.textContent).toContain('$160.00 on Thu, Oct 15')
    expect(insight.textContent).not.toMatch(/recommend|should/i)
  })

  it('puts the Pay in 4 comparison directly under the option cards', async () => {
    const state = makeState()
    apiMock.mockImplementation(((_path: string, input: unknown) =>
      Promise.resolve(compare(state, input))) as typeof api)
    render(
      <Decision
        backLabel="Back"
        onBack={vi.fn()}
        onBuy={vi.fn()}
        onSave={vi.fn()}
        onEditPlan={vi.fn()}
        onViewActivity={vi.fn()}
        state={state}
        request={{ productId: 'camera' }}
      />,
    )
    const options = await screen.findByRole('radiogroup', { name: 'Your options' })
    await waitFor(() =>
      expect(options.nextElementSibling?.textContent).toContain('Compare with PayPal Pay in 4'),
    )
    expect(options.nextElementSibling?.textContent).toContain('about every 2 weeks')
  })
})
