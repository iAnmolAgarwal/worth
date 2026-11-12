// @vitest-environment jsdom
import Anthropic from '@anthropic-ai/sdk'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'
import { api } from '../src/api'
import { ApiError } from '../src/api'
import { createApp } from '../server/app.ts'
import { createChatProvider } from '../server/chat.ts'
import { Store } from '../server/store.ts'

// Final-day plan §0: the Worth app never names or links to the demo store. Only a visitor who
// arrives through a verified store hand-off sees that store's name (tests/check-ui.test.tsx).
// The screens here run on the real server's state with the store hand-off switched on.

vi.mock('../src/paypalSdk', () => ({ loadPayPalSdk: vi.fn() }))
vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>()
  return { ...actual, api: vi.fn() }
})

const STORE = /Larkspur|store\.example|demo store/i
const stores: Store[] = []
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
  for (const store of stores.splice(0)) store.close()
})

/** The real server behind the app's `api` helper, with Claude asked to buy the headphones. */
function serve() {
  const store = new Store(':memory:')
  stores.push(store)
  const responses = [
    [
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'open_purchase_check',
        input: { item_id: 'headphones' },
      },
    ],
    [{ type: 'text', text: JSON.stringify({ intent: 'affordability', follow_ups: [] }) }],
  ]
  const create = vi.fn(async () => ({ content: responses.shift() ?? [], stop_reason: 'tool_use' }))
  const client = { messages: { create } } as unknown as Pick<Anthropic, 'messages'>
  const app = createApp({
    store,
    chat: createChatProvider('unused', 'claude-sonnet-5-5', client, { log: vi.fn() }),
    config: {
      production: false,
      origin: 'http://localhost:5173',
      handoffSecret: Buffer.alloc(32, 3).toString('base64url'),
      merchantOrigin: 'https://store.example',
    },
  })
  const agent = request.agent(app)
  vi.mocked(api).mockImplementation((async (path: string, data?: unknown, method?: string) => {
    const verb = (method ?? (data === undefined ? 'GET' : 'POST')).toLowerCase() as 'get'
    const res = await agent[verb](`/api${path}`)
      .set('X-Worth-Client', 'web')
      .send(data as object)
    if (res.status >= 400) throw new ApiError(res.body.error ?? 'failed', res.status, res.body.code)
    return res.body
  }) as never)
  return agent
}

const visible = () => document.body.textContent ?? ''
const links = () => [...document.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '')

describe('the demo store is hidden from Worth', () => {
  it('names and links no store on Home, a catalog comparison, Saved, Ask Worth or Connect an agent', async () => {
    const user = userEvent.setup()
    // A wide screen, as the judges see it.
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
    Element.prototype.scrollIntoView = vi.fn()
    const agent = serve()
    await agent.get('/api/state')
    const consent = await agent
      .post('/api/consent')
      .set('X-Worth-Client', 'web')
      .send({ aiConsent: true })
    expect(consent.status).toBe(200)
    const saved = await agent
      .post('/api/saved')
      .set('X-Worth-Client', 'web')
      .send({ kind: 'catalog', productId: 'camera' })
    expect(saved.status).toBe(200)

    render(<App />)
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    await screen.findByRole('heading', { level: 1 })
    expect(visible()).not.toMatch(STORE)

    window.location.hash = 'decision?product=headphones'
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await screen.findByRole('radiogroup', { name: 'Your options' })
    expect(visible()).toContain('Studio headphones')
    expect(visible()).not.toMatch(STORE)
    expect(links().join(' ')).not.toMatch(STORE)

    window.location.hash = 'saved'
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect((await screen.findAllByText('Everyday camera')).length).toBeGreaterThan(0)
    expect(visible()).not.toMatch(STORE)
    expect(links().join(' ')).not.toMatch(STORE)

    window.location.hash = 'settings'
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await screen.findByText('The agent can')
    expect(visible()).not.toMatch(STORE)

    await user.click(within(nav).getByRole('button', { name: 'Ask Worth' }))
    await user.type(
      screen.getByRole('textbox', { name: 'Message Worth' }),
      'Go ahead and buy the studio headphones{Enter}',
    )
    const card = await screen.findByRole('region', { name: 'Decide on the Studio headphones' })
    expect(within(card).getByRole('link', { name: 'Open Worth’s comparison' })).toBeTruthy()
    // The answer, its chips and its trace, opened.
    for (const summary of document.querySelectorAll('details')) summary.open = true
    expect(visible()).not.toMatch(STORE)
    expect(links().join(' ')).not.toMatch(STORE)

    // The link opens Worth's own comparison for the item.
    await user.click(within(card).getByRole('link', { name: 'Open Worth’s comparison' }))
    await waitFor(() => expect(window.location.hash).toMatch(/^#decision\?.*product=headphones/))
    expect(visible()).not.toMatch(STORE)
  })
})
