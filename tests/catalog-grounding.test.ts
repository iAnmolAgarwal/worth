import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it, vi } from 'vitest'
import { createChatProvider, fallbackReply } from '../server/chat.ts'
import type { ChatData, ChatInput } from '../server/chat.ts'
import {
  catalogItemFor,
  focusInput,
  localInterpretation,
  validateInterpretation,
} from '../server/interpret.ts'
import type { RawInterpretation } from '../server/interpret.ts'
import { refusalFor } from '../server/narration.ts'
import { createDemoState, PRODUCTS } from '../shared/seed.ts'

// Round-2 judge fix #3 (G5-2): a demo-store item named without a price is read at the store's
// price, a conversation remembers every item it assessed, and a refusal to skip a bill shows even
// when the purchase still needs a question.

const TODAY = '2026-10-03'
const seed = createDemoState(TODAY)
const data: ChatData = {
  profile: seed.profile,
  purchases: [],
  transactions: seed.transactions,
  today: TODAY,
}
const ask = (message: string, extra: Partial<ChatInput> = {}): ChatInput => ({
  message,
  history: [],
  ...extra,
})
type Item = RawInterpretation['items'][number]
const item = (name: string, amount_cents: number | null, quantity = 1): Item => ({
  name,
  amount_cents,
  currency: 'USD',
  quantity,
})
const raw = (items: Item[], extra: Partial<RawInterpretation> = {}): RawInterpretation => ({
  items,
  combine: items.length > 1 ? 'together' : 'single',
  refers_to_previous_item: false,
  date_phrase: null,
  date: null,
  option: 'check',
  ...extra,
})
const headphones = { amountCents: 34900, itemName: 'headphones', purchaseDate: TODAY }
const camera = { amountCents: 119900, itemName: 'camera' }

describe('catalog price grounding', () => {
  it('reads a named store item at its catalog price', () => {
    const result = validateInterpretation(
      raw([item('camera', null)]),
      ask('Can I afford the camera?'),
      data,
    )
    expect(result.ok && result.interpretation.items).toEqual([
      { name: 'Everyday camera', amountCents: 119900, quantity: 1, priceSource: 'catalog' },
    ])
    // Claude may copy the store price itself; it is accepted as the catalog's, not the user's.
    const copied = validateInterpretation(
      raw([item('MacBook', 249900)]),
      ask('Is the MacBook a good idea right now?'),
      data,
    )
    expect(copied.ok && copied.interpretation.items[0]).toMatchObject({
      name: 'MacBook Pro 14-inch',
      amountCents: 249900,
      priceSource: 'catalog',
    })
  })

  it('keeps the user’s own price and never invents one for an unknown item', () => {
    const stated = validateInterpretation(
      raw([item('camera', 90000)]),
      ask('Can I afford a $900 camera?'),
      data,
    )
    expect(stated.ok && stated.interpretation.items[0]).toEqual({
      name: 'camera',
      amountCents: 90000,
      quantity: 1,
    })
    const unknown = validateInterpretation(
      raw([item('phone', null)]),
      ask('Can I get a phone?'),
      data,
    )
    expect(unknown.ok ? 'assessed' : unknown.reason).toBe('price_missing')
    // An amount Claude made up for a store item is still refused.
    const madeUp = validateInterpretation(
      raw([item('camera', 100000)]),
      ask('Can I afford the camera?'),
      data,
    )
    expect(madeUp.ok).toBe(false)
  })

  it('prices two named store items bought together', () => {
    const both = validateInterpretation(
      raw([item('camera', null), item('headphones', null)]),
      ask('Can I get the camera and the headphones together?'),
      data,
    )
    expect(both.ok && both.interpretation.amountCents).toBe(154800)
  })

  it('only matches an item the message names', () => {
    expect(catalogItemFor('camera', 'Can I afford a lens?')).toBeUndefined()
    expect(catalogItemFor('AirPods', 'What about AirPods?')?.id).toBe('airpods-4')
  })

  // Pre-merge judge finding 1: only a whole-name mention reads the store price.
  it.each([
    ['Can I afford a camera bag?', 'camera bag'],
    ['Can I afford a Sony camera?', 'Sony camera'],
    ['Is a gaming chair a good idea?', 'gaming chair'],
    ['Can I afford a MacBook Air?', 'MacBook Air'],
    ['What about AirPods Pro?', 'AirPods Pro'],
    ['Can I get a chair mat?', 'chair mat'],
  ])('never reads "%s" at a store price', (message, name) => {
    expect(catalogItemFor(name, message)).toBeUndefined()
    const claude = validateInterpretation(raw([item(name, null)]), ask(message), data)
    expect(claude.ok ? claude.interpretation.items : claude.reason).toBe('price_missing')
    // Claude naming the store item anyway is not enough: the user's words must name it too.
    const product = name.includes('Mac') ? 'MacBook' : name.split(' ').at(-1)!
    expect(validateInterpretation(raw([item(product, null)]), ask(message), data).ok).toBe(false)
    const local = localInterpretation(focusInput(ask(message)), data)
    expect(local.ok ? local.interpretation.items : local.reason).toBe('price_missing')
    expect(focusInput(ask(message)).context).toBeUndefined()
  })

  it('still reads the whole store name, with its own name words and timing around it', () => {
    for (const [message, id] of [
      ['Can I afford the MacBook Pro?', 'macbook-pro-14'],
      ['Is the MacBook Pro 14-inch worth it?', 'macbook-pro-14'],
      ['Can I buy the everyday camera on Friday?', 'camera'],
      ['AirPods 4 today?', 'airpods-4'],
      ['Go back to the camera. Does it fit?', 'camera'],
      ['What about the camera 2 weeks from now?', 'camera'],
    ] as const)
      expect(focusInput(ask(message)).context?.itemName).toBe(
        PRODUCTS.find((p) => p.id === id)!.name,
      )
  })

  it('keeps a count next to the item instead of reading one at the store price', () => {
    const message = 'Can I afford two cameras?'
    expect(focusInput(ask(message)).context).toBeUndefined()
    const local = localInterpretation(ask(message), data)
    expect(local.ok ? local.interpretation.items : local.reason).toBe('price_missing')
    // Claude's reading keeps the quantity, at the store's price per item.
    const both = validateInterpretation(raw([item('cameras', null, 2)]), ask(message), data)
    expect(both.ok && both.interpretation.amountCents).toBe(2 * 119900)
  })

  it('treats "a camera bag" after the camera as a new item, not the camera again', () => {
    const message = 'What about a camera bag?'
    const context = { ...camera, itemName: 'Everyday camera', purchaseDate: TODAY }
    expect(focusInput(ask(message, { context, items: [camera] })).context).toEqual(context)
    const result = validateInterpretation(
      raw([item('camera bag', null)], { refers_to_previous_item: true }),
      ask(message, { context }),
      data,
    )
    expect(result.ok ? result.interpretation.items : result.reason).toBe('price_missing')
    const local = localInterpretation(ask(message, { context }), data)
    expect(local.ok ? local.interpretation.items : local.reason).toBe('price_missing')
  })

  it('works the same in local mode', () => {
    const result = localInterpretation(ask('Can I afford the MacBook?'), data)
    expect(result.ok && result.interpretation).toMatchObject({
      amountCents: 249900,
      items: [{ name: 'MacBook Pro 14-inch', priceSource: 'catalog' }],
    })
    const two = localInterpretation(ask('Should I get the camera or the chair?'), data)
    expect(two.ok).toBe(false)
  })
})

describe('multi-item memory', () => {
  it('returns to an item assessed earlier in the conversation', () => {
    const focused = focusInput(
      ask('What if I split the camera with Pay in 4 instead?', {
        context: headphones,
        items: [camera, { amountCents: 34900, itemName: 'headphones' }],
      }),
    )
    expect(focused.context).toEqual(camera)
    // A remembered custom item comes back at the amount the user gave.
    expect(
      focusInput(
        ask('And the bike?', {
          context: headphones,
          items: [{ amountCents: 64900, itemName: 'road bike' }],
        }),
      ).context,
    ).toEqual({ amountCents: 64900, itemName: 'road bike' })
  })

  it('names a store item without any memory, and leaves a new price alone', () => {
    expect(focusInput(ask('What about the AirPods?', { context: headphones })).context).toEqual({
      amountCents: 12900,
      itemName: 'AirPods 4',
    })
    const priced = ask('What about a $300 camera?', { context: headphones, items: [camera] })
    expect(focusInput(priced)).toBe(priced)
    const same = ask('Is now a good time for the headphones?', { context: headphones })
    expect(focusInput(same)).toBe(same)
  })

  it('answers "split the camera" after the headphones (judge §3 #3, prompt 1)', () => {
    const reply = fallbackReply(
      ask('What if I split the camera with Pay in 4 instead?', {
        context: headphones,
        items: [camera, { amountCents: 34900, itemName: 'headphones' }],
      }),
      data,
    )
    expect(reply.assessment?.amountCents).toBe(119900)
    expect(reply.intent).toBe('affordability')
  })
})

describe('the refusal to skip a bill', () => {
  it('reads the user’s own words', () => {
    expect(refusalFor('honestly I could pay rent a week late')).toBe('no_skipping')
    expect(refusalFor('Should I skip rent to buy this?')).toBe('no_skipping')
    expect(refusalFor('What bills are coming up?')).toBeUndefined()
    expect(refusalFor('Can I buy it late next week?')).toBeUndefined()
  })

  it('fires with the catalog item (judge §3 #3, prompt 2)', () => {
    const reply = fallbackReply(
      ask(
        'My budget is $300 but honestly I could pay rent a week late. Is that fine for the camera?',
        { context: { ...camera, purchaseDate: TODAY } },
      ),
      data,
    )
    expect(reply.assessment?.amountCents).toBe(119900)
    expect(reply.lead).toBe('I wouldn’t skip or delay a bill to make a purchase fit.')
    expect(reply.message).toContain('I wouldn’t skip or delay a bill')
  })

  it('fires even when the purchase needs a clarifying question', () => {
    const reply = fallbackReply(ask('I could pay rent late. Can I get a new phone?'), data)
    expect(reply.intent).toBe('clarify')
    expect(reply.lead).toBe('I wouldn’t skip or delay a bill to make a purchase fit.')
    expect(reply.message.split('\n\n')[0]).toBe(reply.lead)
  })

  it('replaces a neutral lead-in Claude chose, and keeps Claude’s own refusal on a question', async () => {
    const tool = (input: Record<string, unknown>) => ({
      type: 'tool_use',
      id: `t-${Math.random()}`,
      name: 'interpret_purchase',
      input: {
        combine: 'single',
        refers_to_previous_item: true,
        date_phrase: null,
        date: null,
        option: 'check',
        follow_ups: [],
        ...input,
      },
    })
    const responses = [
      [tool({ items: [item('camera', null)], points: ['low_point'], lead_in: 'matters' })],
      [tool({ items: [item('phone', null)], points: [], lead_in: 'no_skipping' })],
      [{ type: 'text', text: JSON.stringify({ intent: 'clarify', follow_ups: [] }) }],
    ]
    const create = vi.fn(async () => ({
      content: responses.shift() ?? [],
      stop_reason: 'tool_use',
    }))
    const client = { messages: { create } } as unknown as Pick<Anthropic, 'messages'>
    const provider = createChatProvider('unused', 'claude-sonnet-5-5', client, { log: vi.fn() })
    const camerasReply = await provider.reply(
      ask('I could pay rent a week late. Is that fine for the camera?', { context: camera }),
      data,
    )
    // The camera under discussion keeps the price the user gave earlier.
    expect(camerasReply.assessment?.amountCents).toBe(119900)
    expect(camerasReply.lead).toBe(
      'I wouldn’t skip or delay a bill to make a purchase fit. Here’s what matters instead:',
    )
    const phone = await provider.reply(ask('Should I put off my phone bill for a new phone?'), data)
    expect(phone.intent).toBe('clarify')
    expect(phone.lead).toBe('I wouldn’t skip or delay a bill to make a purchase fit.')
  })
})
