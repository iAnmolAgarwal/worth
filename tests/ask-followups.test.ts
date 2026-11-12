import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../server/app.ts'
import { incomeWhatIfReply } from '../server/chat.ts'
import { Store } from '../server/store.ts'
import { ALEX_CAMERA_ID, ALEX_DEMO_DAY } from '../shared/seed.ts'
import type { ChatReply } from '../shared/types.ts'

// Cold judge #5: a follow-up on a comparison page stays about the page's item, and an income
// what-if gets an honest pointer instead of a question about a price.

describe('an income what-if', () => {
  it('points to Plan instead of reading the money as a price', () => {
    for (const message of [
      'If I sell my old lens for $400 on Friday, could I get the camera sooner?',
      'If I get a $500 bonus, can I afford it earlier?',
      'With extra money from a side gig could it fit sooner?',
    ]) {
      const reply = incomeWhatIfReply(message)
      expect(reply?.message, message).toBe(
        'Worth can’t try out extra income in chat yet. Add the money in Plan, under Income, with the day you expect it, and every answer, including this one, updates.',
      )
      expect(reply!.message).not.toMatch(/\$\d/)
    }
    for (const message of [
      'Can I afford a $400 lens?',
      'If I get paid on Friday can I buy it?',
      'Should I just use Pay in 4?',
      'What happens on payday?',
    ])
      expect(incomeWhatIfReply(message), message).toBeUndefined()
  })
})

describe('POST /api/chat on a comparison page', () => {
  const stores: Store[] = []
  afterEach(() => {
    for (const store of stores.splice(0)) store.close()
  })
  function setup() {
    const store = new Store(':memory:')
    stores.push(store)
    const seen: { context?: unknown; message: string }[] = []
    const reply = vi.fn(async (input: { context?: unknown; message: string }) => {
      seen.push(input)
      return {
        message: 'answer',
        mode: 'anthropic',
        intent: 'overview',
        suggestions: [],
        toolCalls: [],
      } satisfies ChatReply
    })
    const app = createApp({
      store,
      config: {
        production: false,
        origin: 'http://localhost:5173',
        paypalClientId: undefined,
        paypalSecret: undefined,
        anthropicKey: undefined,
      },
      now: () => new Date(`${ALEX_DEMO_DAY}T12:00:00Z`),
      chat: { reply } as never,
    })
    const agent = request.agent(app)
    const post = (body: object) =>
      agent
        .post('/api/chat')
        .set('X-Worth-Client', 'web')
        .send({ history: [], ...body })
    return { post, seen, reply }
  }
  const view = { screen: 'decision', productId: ALEX_CAMERA_ID, options: ['wait'] }

  it('gives a follow-up that names no item the page’s item as its context', async () => {
    const { post, seen } = setup()
    expect((await post({ message: 'Buy it for me', view })).status).toBe(200)
    expect(seen[0]!.context).toEqual({ amountCents: 189900, itemName: 'Halden X5' })
    // A context the conversation already has wins; without a view nothing is added.
    await post({ message: 'And then?', view, context: { amountCents: 6000, itemName: 'jacket' } })
    expect(seen[1]!.context).toEqual({ amountCents: 6000, itemName: 'jacket' })
    await post({ message: 'Buy it for me' })
    expect(seen[2]!.context).toBeUndefined()
  })

  it('answers an income what-if without calling the model', async () => {
    const { post, reply } = setup()
    const response = await post({
      message: 'If I sell my old lens for $400 on Friday, could I get the camera sooner?',
      view,
    })
    expect(response.body.message).toMatch(/^Worth can’t try out extra income in chat yet/)
    expect(reply).not.toHaveBeenCalled()
  })
})
