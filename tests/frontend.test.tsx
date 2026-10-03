// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'
import { Assistant, AssessmentCard } from '../src/Assistant'
import { PurchaseDialog } from '../src/PurchaseDialog'
import { api, ApiError } from '../src/api'
import { loadPayPalSdk, type PayPalSessionCallbacks } from '../src/paypalSdk'
import { assessPurchase } from '../shared/finance'
import { createDemoState, PRODUCTS } from '../shared/seed'
import type { AppState, ChatMessage, ChatReply, ImportPreview, Purchase } from '../shared/types'

vi.mock('../src/paypalSdk', () => ({ loadPayPalSdk: vi.fn() }))

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>()
  return { ...actual, api: vi.fn() }
})

// Chart layout is a browser rendering concern; retain the real forecast and assessment components.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AreaChart: ({ children }: { children: ReactNode }) => <svg>{children}</svg>,
  Area: () => null,
  CartesianGrid: () => null,
  ReferenceLine: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}))

const TODAY = '2026-10-03'
const apiMock = vi.mocked(api)
type ChatRequest = {
  message: string
  history: ChatMessage[]
  context?: { amountCents: number; itemName: string; purchaseDate?: string }
}
type User = ReturnType<typeof userEvent.setup>

function makeState(source: 'demo' | 'import' = 'demo'): AppState {
  const seed = createDemoState(TODAY)
  return {
    ...seed,
    profile: {
      ...seed.profile,
      source,
      name: source === 'import' ? 'Morgan' : seed.profile.name,
      version: source === 'import' ? 4 : 1,
      aiConsent: false,
    },
    transactions:
      source === 'import'
        ? seed.transactions
            .slice(0, 4)
            .map((transaction) => ({ ...transaction, source: 'import' as const }))
        : seed.transactions,
    today: TODAY,
    products: PRODUCTS,
    config: { ai: 'anthropic', paypal: 'demo', model: 'test-provider' },
  }
}

function reply(message: string, mode: ChatReply['mode'] = 'demo'): ChatReply {
  return { message, mode, intent: 'overview', suggestions: [], toolCalls: ['read_financial_plan'] }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function routeApi(
  route: (path: string, data?: unknown, method?: string) => unknown | Promise<unknown>,
) {
  apiMock.mockImplementation(
    (path, data, method) =>
      Promise.resolve().then(() => route(path, data, method)) as Promise<never>,
  )
}

async function sendMessage(user: User, text: string) {
  await user.type(screen.getByRole('textbox', { name: 'Message Worth' }), text)
  await user.click(screen.getByRole('button', { name: 'Send message' }))
}

async function openAssistant(user: User) {
  const navigation = await screen.findByRole('navigation', { name: 'Main navigation' })
  await user.click(within(navigation).getByRole('button', { name: /Ask Worth/ }))
  await screen.findByRole('heading', { name: 'Ask Worth.' })
}

async function proceedToCheckout(user: User) {
  const reviewButton = await screen.findByRole('button', { name: /Review buying today/ })
  await waitFor(() => expect((reviewButton as HTMLButtonElement).disabled).toBe(false))
  await user.click(reviewButton)
  await user.click(
    await screen.findByRole('checkbox', {
      name: /My available funds and commitments are still current/,
    }),
  )
  await user.click(screen.getByRole('button', { name: /Continue to sandbox/ }))
}

function uncertainPurchase(state: AppState): Purchase {
  const product = state.products[0]!
  return {
    id: 'uncertain-reservation',
    productId: product.id,
    name: product.name,
    amountCents: product.priceCents,
    currency: 'USD',
    mode: 'sandbox',
    status: 'unknown',
    createdAt: `${TODAY}T12:00:00Z`,
    profileVersion: state.profile.version,
    assessmentDate: TODAY,
  }
}

beforeEach(() => {
  apiMock.mockReset()
  vi.mocked(loadPayPalSdk).mockReset()
  window.history.replaceState(null, '', '/')
  vi.stubGlobal('scrollTo', vi.fn())
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('conversation isolation across financial sessions', () => {
  it('clears imported chat and context on reset, ignores a late old reply, and sends an empty history to the pristine demo', async () => {
    const user = userEvent.setup()
    const imported = makeState('import')
    const demo = makeState()
    const pendingOldReply = deferred<ChatReply>()
    const requests: ChatRequest[] = []
    const privateQuestion = 'My private expense is a medical bill. How does it affect my plan?'
    const privateAnswer = 'Private local explanation of your medical expense.'
    const lateAnswer = 'Late private explanation that belongs to the deleted session.'
    routeApi((path, data) => {
      if (path === '/state') return imported
      if (path === '/reset') return demo
      if (path === '/chat') {
        requests.push(data as ChatRequest)
        if (requests.length === 1)
          return {
            ...reply(privateAnswer),
            assessment: assessPurchase(imported.profile, [], {
              amountCents: 35000,
              itemName: 'Private medical expense',
              today: TODAY,
            }),
          }
        if (requests.length === 2) return pendingOldReply.promise
        return reply('A fresh synthetic demo answer.', 'anthropic')
      }
      throw new Error(`Unexpected API request: ${path}`)
    })

    render(<App />)
    await openAssistant(user)
    await sendMessage(user, privateQuestion)
    await screen.findByText(privateAnswer)
    await sendMessage(user, 'A second question about the same private expense.')
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]!.history.some((message) => message.content === privateQuestion)).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Edit your financial plan' }))
    await user.click(
      await screen.findByRole('button', { name: /Delete my data & start a fresh demo/ }),
    )
    await user.click(screen.getByRole('button', { name: 'Delete & start over' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByText(privateQuestion)).toBeNull()
    expect(screen.queryByText(privateAnswer)).toBeNull()
    expect(screen.queryByRole('region', { name: 'Purchase assessment' })).toBeNull()

    await act(async () => {
      pendingOldReply.resolve(reply(lateAnswer))
      await pendingOldReply.promise
    })
    expect(screen.queryByText(lateAnswer)).toBeNull()
    await sendMessage(user, 'How much can the demo persona spend?')
    await screen.findByText('A fresh synthetic demo answer.')
    expect(requests).toHaveLength(3)
    expect(requests[2]!.history).toEqual([])
    expect(requests[2]!.context).toBeUndefined()
    expect(JSON.stringify(requests[2])).not.toContain('private')
    expect(screen.getByText('AI + your plan')).toBeTruthy()
  })

  it('replaces the demo conversation on import before personal context review and a new chat', async () => {
    const user = userEvent.setup()
    const demo = makeState()
    const imported = makeState('import')
    imported.profile.confirmed = false
    imported.profile.missingFields = ['Confirm your imported financial picture.']
    const requests: ChatRequest[] = []
    const oldAnswer = 'This answer belongs only to the old sample persona.'
    const preview: ImportPreview = {
      transactions: imported.transactions.slice(0, 1),
      errors: [],
      duplicates: 0,
      excluded: 0,
      coverageDays: 90,
      totalRows: 1,
      suggestedDailySpendCents: 3500,
      recurring: [],
      warnings: [],
    }
    routeApi((path, data) => {
      if (path === '/state') return demo
      if (path === '/import/preview') return preview
      if (path === '/import/commit') return imported
      if (path === '/chat') {
        requests.push(data as ChatRequest)
        if (requests.length === 1)
          return {
            ...reply(oldAnswer, 'anthropic'),
            assessment: assessPurchase(demo.profile, [], {
              amountCents: 34900,
              itemName: 'Old sample purchase',
              today: TODAY,
            }),
          }
        return reply('Review your personal financial picture first.')
      }
      throw new Error(`Unexpected API request: ${path}`)
    })

    render(<App />)
    await openAssistant(user)
    await sendMessage(user, 'Check the sample persona before I import my history.')
    await screen.findByText(oldAnswer)
    await user.click(screen.getByRole('button', { name: /Import PayPal activity/ }))
    await user.click(await screen.findByText('Or paste the CSV contents'))
    await user.type(
      screen.getByRole('textbox', { name: 'PayPal CSV contents' }),
      'Date,Name,Currency,Amount\n2026-10-01,Coffee,USD,-6.50',
    )
    await user.click(screen.getByRole('button', { name: /Preview my history/ }))
    await user.click(await screen.findByRole('checkbox', { name: /I reviewed this preview/ }))
    await user.click(screen.getByRole('button', { name: /Import & review my plan/ }))
    await screen.findByRole('dialog', { name: 'Your financial picture' })
    expect(screen.queryByText(oldAnswer)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Close dialog' }))
    await sendMessage(user, 'What information should I confirm now?')
    await screen.findByText('Review your personal financial picture first.')
    expect(requests).toHaveLength(2)
    expect(requests[1]!.history).toEqual([])
    expect(requests[1]!.context).toBeUndefined()
    expect(screen.queryByText('Old sample purchase')).toBeNull()
  })
})

describe('queued assistant prompts', () => {
  it('runs a second initial prompt after the pending response and includes the newly finished exchange', async () => {
    const state = makeState()
    const first = deferred<ChatReply>()
    const second = deferred<ChatReply>()
    const requests: ChatRequest[] = []
    const props = { state, onPlan: vi.fn(), onProduct: vi.fn(), visible: true }
    routeApi((path, data) => {
      if (path !== '/chat') throw new Error(`Unexpected API request: ${path}`)
      requests.push(data as ChatRequest)
      return requests.length === 1 ? first.promise : second.promise
    })

    const view = render(
      <Assistant {...props} initialPrompt={{ text: 'First purchase question', id: 101 }} />,
    )
    await waitFor(() => expect(requests).toHaveLength(1))
    view.rerender(
      <Assistant
        {...props}
        initialPrompt={{ text: 'Second question while the first is pending', id: 102 }}
      />,
    )
    expect(requests).toHaveLength(1)
    expect(screen.queryByText('Second question while the first is pending')).toBeNull()

    const firstAssessment = assessPurchase(state.profile, [], {
      amountCents: 34900,
      itemName: 'Studio headphones',
      today: TODAY,
    })
    await act(async () => {
      first.resolve({
        ...reply('The first purchase has been checked.'),
        assessment: firstAssessment,
      })
      await first.promise
    })
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]!.message).toBe('Second question while the first is pending')
    expect(requests[1]!.history).toEqual([
      { role: 'user', content: 'First purchase question' },
      { role: 'assistant', content: 'The first purchase has been checked.' },
    ])
    expect(requests[1]!.context).toMatchObject({
      amountCents: 34900,
      itemName: 'Studio headphones',
      purchaseDate: TODAY,
    })
    await act(async () => {
      second.resolve(reply('The queued follow-up has been checked.'))
      await second.promise
    })
    await screen.findByText('The queued follow-up has been checked.')
    expect(requests).toHaveLength(2)
  })
})

describe('AI sharing consent in chat', () => {
  const shared =
    'your messages, recent chat history (including figures), the item, price and date you ask about, a forecast summary, 30-day spending totals by category, income and bill names with amounts and dates, and minimized merchant labels'
  it('discloses what the untouched synthetic persona sends without asking for consent', () => {
    render(<Assistant state={makeState()} onPlan={vi.fn()} onProduct={vi.fn()} visible />)
    expect(
      screen.getByText(`Synthetic persona. When Claude is connected, it receives ${shared}.`),
    ).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: /Share with Claude/ })).toBeNull()
  })
  it('toggles consent alone for personal data and reports the updated state', async () => {
    const user = userEvent.setup()
    const state = makeState('import')
    const updated = { ...state, profile: { ...state.profile, aiConsent: true } }
    const requests: [string, unknown][] = []
    routeApi((path, data) => {
      requests.push([path, data])
      return updated
    })
    const onUpdate = vi.fn()
    render(
      <Assistant state={state} onPlan={vi.fn()} onProduct={vi.fn()} onUpdate={onUpdate} visible />,
    )
    const toggle = screen.getByRole('checkbox', { name: /Share with Claude/ })
    expect((toggle as HTMLInputElement).checked).toBe(false)
    expect(toggle.closest('label')!.textContent).toContain(`Sends ${shared} to Anthropic.`)
    await user.click(toggle)
    await waitFor(() => expect(onUpdate).toHaveBeenCalledExactlyOnceWith(updated))
    expect(requests).toEqual([['/consent', { aiConsent: true }]])
  })
})

describe('uncertain checkout recovery', () => {
  it('recovers a server reservation after an uncertain create response and returns it through onUpdate', async () => {
    const user = userEvent.setup()
    const state = makeState()
    state.config.paypal = 'sandbox'
    const recovered: AppState = { ...state, purchases: [uncertainPurchase(state)] }
    const onUpdate = vi.fn()
    routeApi((path, data) => {
      if (path === '/assess')
        return assessPurchase(state.profile, [], {
          ...(data as { amountCents: number; itemName: string; purchaseDate: string }),
          today: TODAY,
        })
      if (path === '/checkout/create')
        throw new ApiError(
          'PayPal did not return a confirmed order result.',
          502,
          'PAYPAL_UNCERTAIN',
        )
      if (path === '/state') return recovered
      throw new Error(`Unexpected API request: ${path}`)
    })

    render(
      <PurchaseDialog
        state={state}
        product={state.products[0]!}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        onPlan={vi.fn()}
      />,
    )
    await proceedToCheckout(user)
    await screen.findByRole('heading', { name: 'Let’s check where things stand.' })
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith(recovered)
    expect(screen.getByText(/This amount stays allocated while we check PayPal/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Check payment status/ })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain(
      'PayPal did not return a confirmed order result.',
    )
    expect(apiMock.mock.calls.filter(([path]) => path === '/state')).toHaveLength(1)
    expect(apiMock.mock.calls.filter(([path]) => path === '/checkout/create')).toHaveLength(1)
  })

  it('keeps the recovered checkout visible in the app after closing and reopens its existing reservation', async () => {
    const user = userEvent.setup()
    const state = makeState()
    state.config.paypal = 'sandbox'
    const recovered: AppState = { ...state, purchases: [uncertainPurchase(state)] }
    let createAttempted = false
    routeApi((path, data) => {
      if (path === '/state') return createAttempted ? recovered : state
      if (path === '/assess')
        return assessPurchase(state.profile, [], {
          ...(data as { amountCents: number; itemName: string; purchaseDate: string }),
          today: TODAY,
        })
      if (path === '/checkout/create') {
        createAttempted = true
        throw new ApiError(
          'The sandbox response is uncertain. Your allocation is saved.',
          502,
          'PAYPAL_UNCERTAIN',
        )
      }
      throw new Error(`Unexpected API request: ${path}`)
    })

    render(<App />)
    await user.click(
      await screen.findByRole('button', { name: 'Check if studio headphones fit your plan' }),
    )
    await proceedToCheckout(user)
    await screen.findByRole('heading', { name: 'Let’s check where things stand.' })
    await user.click(screen.getByRole('button', { name: 'Close dialog' }))
    await screen.findByText('There’s a checkout to finish.')
    expect(
      screen.getByText(/Studio headphones · \$349.00 remains allocated until it’s resolved/),
    ).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Review checkout' }))
    await screen.findByRole('heading', { name: 'Let’s check where things stand.' })
    expect(screen.getByText(/PAYPAL SANDBOX · UNKNOWN/)).toBeTruthy()
    expect(apiMock.mock.calls.filter(([path]) => path === '/checkout/create')).toHaveLength(1)
    expect(apiMock.mock.calls.filter(([path]) => path === '/state')).toHaveLength(2)
  })
})

describe('session refresh boundaries', () => {
  it('clears the old conversation when an expired session changes on foreground refresh', async () => {
    const user = userEvent.setup()
    const imported = { ...makeState('import'), sessionKey: '11111111111111111111' }
    const fresh = { ...makeState(), sessionKey: '22222222222222222222' }
    let current = imported
    const requests: ChatRequest[] = []
    routeApi((path, data) => {
      if (path === '/state') return current
      if (path === '/chat') {
        requests.push(data as ChatRequest)
        return reply(requests.length === 1 ? 'Earlier personal context.' : 'Fresh context.')
      }
      throw new Error(`Unexpected API request: ${path}`)
    })
    render(<App />)
    await openAssistant(user)
    await sendMessage(user, 'My private question.')
    await screen.findByText('Earlier personal context.')
    current = fresh
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(screen.queryByText('Earlier personal context.')).toBeNull())
    await sendMessage(user, 'A fresh question.')
    await screen.findByText('Fresh context.')
    expect(requests[1]!.history).toEqual([])
    expect(requests[1]).toMatchObject({ sessionKey: fresh.sessionKey })
  })

  it('discards private history when the server rejects a chat crossing session expiry', async () => {
    const user = userEvent.setup()
    const onSessionChange = vi.fn()
    let count = 0
    routeApi(() => {
      if (++count === 1) return reply('Private earlier answer.')
      throw new ApiError('Session changed', 409, 'SESSION_CHANGED')
    })
    render(
      <Assistant
        state={{ ...makeState('import'), sessionKey: '11111111111111111111' }}
        onPlan={vi.fn()}
        onProduct={vi.fn()}
        onSessionChange={onSessionChange}
        visible
      />,
    )
    await sendMessage(user, 'My earlier private question.')
    await screen.findByText('Private earlier answer.')
    await sendMessage(user, 'My private follow-up.')
    await screen.findByText(/Your session changed/)
    expect(screen.queryByText('Private earlier answer.')).toBeNull()
    expect(screen.queryByText('My earlier private question.')).toBeNull()
    expect(
      (screen.getByRole('textbox', { name: 'Message Worth' }) as HTMLTextAreaElement).value,
    ).toBe('')
    expect(onSessionChange).toHaveBeenCalledOnce()
  })
})

describe('PayPal SDK confirmation boundary', () => {
  it.each(['approve', 'cancel'] as const)(
    'keeps SDK %s separate from capture and reuses the created order',
    async (outcome) => {
      const user = userEvent.setup()
      const state = makeState()
      state.config = { ...state.config, paypal: 'sandbox', paypalClientId: 'public-test-client' }
      const product = state.products[0]!
      const purchase: Purchase = {
        ...uncertainPurchase(state),
        id: 'sdk-checkout',
        status: 'created',
        orderId: 'SANDBOX_ORDER',
      }
      let callbacks: PayPalSessionCallbacks | undefined
      const start = vi.fn(async (_options: unknown, order: Promise<{ orderId: string }>) => {
        const resolved = await order
        if (outcome === 'approve')
          await callbacks!.onApprove({ ...resolved, payerId: 'test-buyer' })
        else await callbacks!.onCancel?.(resolved)
      })
      const createSession = vi.fn((options: PayPalSessionCallbacks) => {
        callbacks = options
        return { start, hasReturned: () => false, resume: async () => undefined }
      })
      vi.mocked(loadPayPalSdk).mockResolvedValue({
        findEligibleMethods: async () => ({ isEligible: () => true }),
        createPayPalOneTimePaymentSession: createSession,
      })
      routeApi((path) => {
        if (path === '/assess')
          return assessPurchase(state.profile, [], {
            amountCents: product.priceCents,
            today: TODAY,
          })
        if (path === '/checkout/create')
          return {
            purchase,
            mode: 'sandbox',
            approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=SANDBOX_ORDER',
          }
        if (path === '/state') return { ...state, purchases: [purchase] }
        if (path === '/checkout/sdk-checkout/capture') {
          const paid = { ...purchase, status: 'completed', captureId: 'SANDBOX_CAPTURE' }
          return { purchase: paid, state: { ...state, purchases: [paid] } }
        }
        throw new Error(`Unexpected API request: ${path}`)
      })
      render(
        <PurchaseDialog
          state={state}
          product={product}
          onClose={vi.fn()}
          onUpdate={vi.fn()}
          onPlan={vi.fn()}
        />,
      )
      await proceedToCheckout(user)
      await screen.findByText(
        outcome === 'approve' ? /Approved in PayPal/ : /PayPal approval was cancelled/,
      )
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ commit: false }))
      expect(start).toHaveBeenCalledOnce()
      expect(apiMock.mock.calls.filter(([path]) => path.endsWith('/capture'))).toHaveLength(0)
      expect(apiMock.mock.calls.filter(([path]) => path === '/checkout/create')).toHaveLength(1)
      if (outcome === 'approve') {
        await user.click(screen.getByRole('button', { name: /Confirm sandbox payment/ }))
        await screen.findByText('All accounted for.')
        expect(apiMock.mock.calls.filter(([path]) => path.endsWith('/capture'))).toHaveLength(1)
      } else expect(screen.getByRole('button', { name: /Return to PayPal approval/ })).toBeTruthy()
    },
  )
})

describe('stale assessment review', () => {
  it('rechecks a previous-day result using the current date', async () => {
    const user = userEvent.setup()
    const state = makeState()
    const assessment = assessPurchase(state.profile, [], { amountCents: 34900, today: TODAY })
    const onScenario = vi.fn()
    render(
      <AssessmentCard
        assessment={assessment}
        stale
        recheckDate="2026-10-04"
        onPlan={vi.fn()}
        onScenario={onScenario}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    expect(onScenario).toHaveBeenCalledWith('2026-10-04')
  })
})
