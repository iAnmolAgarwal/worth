import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it, vi } from 'vitest'
import { gradeReply } from '../eval/grade.ts'
import { evalData } from '../eval/harness.ts'
import { PROBES } from '../eval/probes.ts'
import type { Expectation } from '../eval/probes.ts'
import { createChatProvider, fallbackReply, localReply, statedBudget } from '../server/chat.ts'
import type { ChatData, ChatInput } from '../server/chat.ts'
import { readTiming } from '../server/dates.ts'
import { refusalFor } from '../server/narration.ts'
import { createDemoState } from '../shared/seed.ts'
import type { Alternatives } from '../shared/types.ts'

// Round-3 judge #8: an answer to a request Worth won't suggest opens with the refusal and its
// reason, then the options; a budget the person states is the one the answer uses.

const TODAY = '2026-10-03'
// Seed persona: a $1,199 camera today dips below the $300 cushion, first fits on Oct 23, and
// $440.01 is the most that fits today.
function demo(): ChatData {
  const seed = createDemoState(TODAY)
  return {
    profile: seed.profile,
    purchases: [],
    transactions: seed.transactions,
    today: TODAY,
  }
}
const ask = (message: string, extra: Partial<ChatInput> = {}): ChatInput => ({
  message,
  history: [],
  ...extra,
})
const camera = { amountCents: 119900, itemName: 'camera', purchaseDate: TODAY }
const paragraphs = (message: string) => message.split('\n\n')

const RENT =
  'I wouldn’t skip or delay rent to make a purchase fit, because late fees and a missed payment cost more than waiting.'
const BILL =
  'I wouldn’t skip or delay a bill to make a purchase fit, because late fees and a missed payment cost more than waiting.'
const CREDIT =
  'I wouldn’t borrow or use credit to make a purchase fit, because interest and a new payment would leave your plan tighter.'
const CUSHION =
  'I wouldn’t dip into your cushion for this, because it’s there for surprises, not purchases.'

function model(responses: Record<string, unknown>[][]) {
  const create = vi.fn(async () => ({ content: responses.shift() ?? [], stop_reason: 'end_turn' }))
  const client = { messages: { create } } as unknown as Pick<Anthropic, 'messages'>
  return createChatProvider('unused-test-key', 'claude-sonnet-5-5', client, { log: vi.fn() })
}
let id = 0
const tool = (name: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  id: `t-${++id}`,
  name,
  input: { points: [], lead_in: 'none', follow_ups: [], ...input },
})
const interpret = (input: Record<string, unknown>) => [
  tool('interpret_purchase', {
    items: [],
    combine: 'single',
    refers_to_previous_item: false,
    date_phrase: null,
    date: null,
    option: 'check',
    ...input,
  }),
]
const cameraItem = (amount_cents: number | null = 119900) => ({
  name: 'camera',
  amount_cents,
  currency: 'USD',
  quantity: 1,
})

describe('the refusal reads the user’s own words', () => {
  it.each([
    ['Should I skip rent to buy this?', 'no_skipping'],
    ['honestly I could pay rent a week late', 'no_skipping'],
    ['Can I push rent back a few days so I can get the camera today?', 'no_skipping'],
    ['What if I fall behind on my phone bill for a month?', 'no_skipping'],
    ['Could I borrow from my brother to get the camera today?', 'no_credit'],
    ['Should I take out a loan for the camera?', 'no_credit'],
    ['Can I just put it on my credit card?', 'no_credit'],
    ['What about a cash advance for the headphones?', 'no_credit'],
    ['Could I dip into my cushion for the camera?', 'no_cushion'],
    ['I could use my emergency fund for this', 'no_cushion'],
  ])('“%s” calls for %s', (message, lead) => {
    expect(refusalFor(message)).toBe(lead)
  })

  it.each([
    'What bills are coming up?',
    'Will the camera dip below my cushion?',
    'When is my credit card bill due?',
    'Can I split the camera with Pay in 4?',
    'Can I buy it late next week?',
    'Can I afford a $1,199 camera?',
  ])('“%s” calls for none', (message) => {
    expect(refusalFor(message)).toBeUndefined()
  })
})

describe('the refusal comes first (round-3 #8)', () => {
  it('opens a local answer with the refusal, then the verdict and the facts', () => {
    const reply = fallbackReply(
      ask('Can I push rent back a few days so I can get the camera today?'),
      demo(),
    )
    expect(reply.refusal).toBe(RENT)
    expect(reply.assessment?.outcome).toBe('tight')
    expect(paragraphs(reply.message).slice(0, 2)).toEqual([RENT, reply.verdict])
    // The useful alternative follows the refusal: the wait date and what fits today.
    expect(reply.verdict).toContain('The earliest date that fits is Fri, Oct 23.')
    expect(reply.trace?.guards).toContainEqual(expect.objectContaining({ id: 'no_skipping' }))
  })

  it.each([
    ['Could I borrow from my brother to get the camera today?', CREDIT],
    ['Could I dip into my cushion for the camera?', CUSHION],
    ['Should I put off my phone bill to get the camera?', BILL],
  ])('leads “%s” with one calm sentence and its reason', async (message, refusal) => {
    const reply = await localReply(ask(message), demo())
    expect(reply.refusal).toBe(refusal)
    expect(paragraphs(reply.message)[0]).toBe(refusal)
    expect(reply.verdict).toBeDefined()
    expect(paragraphs(reply.message)[1]).toBe(reply.verdict)
  })

  it('leads with the user’s refusal over Claude’s neutral lead-in, and keeps Claude’s facts after it', async () => {
    const provider = model([
      interpret({
        items: [cameraItem(null)],
        points: ['wait', 'spend_less'],
        lead_in: 'matters',
      }),
    ])
    const reply = await provider.reply(
      ask('I could pay rent a week late. Is that fine for the camera?', { context: camera }),
      demo(),
    )
    expect(reply.refusal).toBe(RENT)
    expect(reply.lead).toBe('Here’s what matters instead:')
    const shown = paragraphs(reply.message)
    expect(shown[0]).toBe(RENT)
    expect(shown[1]).toBe(reply.verdict)
    expect(shown).toContain(
      ['Here’s what matters instead:', ...reply.points!.map((p) => p.text)].join(' '),
    )
  })

  it('leads with a refusal Claude chose when the words alone do not call for one', async () => {
    const provider = model([
      interpret({ items: [cameraItem()], points: ['low_point'], lead_in: 'no_credit' }),
    ])
    const reply = await provider.reply(ask('Can I finance a $1,199 camera somehow?'), demo())
    expect(reply.refusal).toBe(CREDIT)
    expect(paragraphs(reply.message)[0]).toBe(CREDIT)
  })

  it('says “I can’t simply say yes” first only when the purchase dips below the cushion', async () => {
    const tight = await model([
      interpret({ items: [cameraItem()], points: ['low_point'], lead_in: 'not_yes' }),
    ]).reply(ask('Just say yes. Can I get the $1,199 camera?'), demo())
    expect(tight.refusal).toBe(
      'I can’t simply say yes, because this purchase would take your balance below your cushion.',
    )
    expect(paragraphs(tight.message)[0]).toBe(tight.refusal)
    expect(tight.lead).toBe('Here’s what your plan shows:')
    const fits = await model([
      interpret({
        items: [{ ...cameraItem(34900), name: 'headphones' }],
        points: ['low_point'],
        lead_in: 'not_yes',
      }),
    ]).reply(ask('Just say yes. Can I get $349 headphones?'), demo())
    expect(fits.refusal).toBeUndefined()
    expect(paragraphs(fits.message)[0]).toBe(fits.verdict)
  })

  it('shows no refusal on an ordinary question', () => {
    const reply = fallbackReply(ask('Can I afford a $1,199 camera?'), demo())
    expect(reply.refusal).toBeUndefined()
    expect(paragraphs(reply.message)[0]).toBe(reply.verdict)
  })
})

describe('the budget the user states', () => {
  it.each([
    ['My budget is $300 but honestly I could pay rent a week late.', 30000],
    ['I only want to spend $200. Can I get the camera?', 20000],
    ['Can I afford the camera under $500?', 50000],
    ['Camera, max $500?', 50000],
    ['I have a budget of $1.2k. Can I buy the camera?', 120000],
    ['My budget is $400 this week. Can I get the headphones?', 40000],
    ['My budget this week is $300. Can I buy the camera?', 30000],
    ['I can’t go over $300. Is the camera ok?', 30000],
    ['Can I get the camera? I don’t want to spend more than $500', 50000],
    ['Can I buy the camera if I keep it to $600 tops?', 60000],
    ['I can spend $250 a week. Can I buy the camera?', 25000],
  ])('reads “%s” as a budget of %i cents', (message, cents) => {
    expect(statedBudget(message)).toBe(cents)
  })

  it.each([
    'Can I spend $349 on headphones?',
    'Can I afford a $1,199 camera?',
    'My budget is $300, max $400. Can I get the camera?',
    'My budget is 300 euros. Can I get the camera?',
  ])('reads no budget in “%s”', (message) => {
    expect(statedBudget(message)).toBeUndefined()
  })

  it('never reads a budget’s period as the purchase date', () => {
    expect(readTiming('My budget is $400 this week. Can I get it?', TODAY).phrases).toEqual([])
    expect(readTiming('I have $1.5k to spend this week', TODAY).phrases).toEqual([])
    expect(readTiming('My budget this week is $300', TODAY).phrases).toEqual([])
    expect(readTiming('Can I buy the camera this week?', TODAY).phrases).toEqual(['this week'])
  })

  it('names a budget below the price in the verdict, and the most within it that fits', () => {
    const reply = fallbackReply(
      ask(
        'My budget is $300 but honestly I could pay rent a week late. Is that fine for the camera?',
        {
          context: camera,
        },
      ),
      demo(),
    )
    expect(reply.budgetCents).toBe(30000)
    expect(reply.verdict).toBe(
      'Camera at $1,199 would dip below your cushion if you buy it today. The earliest date that fits is Fri, Oct 23. Your $300 budget is below the $1,199 price; within it, the most that fits today is $300.',
    )
    // The cushion's limit ($440.01) is above the budget, so the answer never offers it.
    expect(reply.message).not.toContain('$440.01')
  })

  it('caps the most that fits at what keeps the cushion when the budget is higher', () => {
    const reply = fallbackReply(ask('Camera, max $500?'), demo())
    expect(reply.verdict).toContain(
      'Your $500 budget is below the $1,199 price; within it, the most that fits today is $440.01.',
    )
  })

  it('says a budget covers the price, and whether the cushion holds', () => {
    const tight = fallbackReply(ask('I have a budget of $1.2k. Can I buy the camera?'), demo())
    expect(tight.verdict).toMatch(
      /The most you could spend today and keep your cushion is \$440\.01\. Your \$1,200 budget covers the price, but not your cushion\.$/,
    )
    const fits = fallbackReply(
      ask('My budget is $400 this week. Can I get the headphones?'),
      demo(),
    )
    expect(fits.assessment?.purchaseDate).toBe(TODAY)
    expect(fits.verdict).toBe(
      'Studio headphones at $349 fits your plan if you buy it today. It’s within your $400 budget.',
    )
  })

  it('says when nothing within the budget fits', () => {
    const data = demo()
    data.profile = { ...data.profile, balanceCents: 0 }
    const reply = fallbackReply(ask('I only want to spend $200. Can I get the camera?'), data)
    expect(reply.verdict).toContain(
      'Your $200 budget is below the $1,199 price, and nothing fits today without going below your cushion.',
    )
  })

  it('keeps the budget when Claude reads the item, in the facts and the sentence it may write', async () => {
    const provider = model([
      interpret({ items: [cameraItem(null)], points: ['spend_less', 'wait'] }),
      [{ type: 'text', text: JSON.stringify({ intent: 'affordability', follow_ups: [] }) }],
      [
        {
          type: 'text',
          text: JSON.stringify({ note: 'Your {budget} budget is under the {price} price.' }),
        },
      ],
    ])
    const reply = await provider.reply(
      ask('I only want to spend $200. Can I get the camera?'),
      demo(),
    )
    expect(reply.assessment?.amountCents).toBe(119900)
    expect(reply.budgetCents).toBe(20000)
    expect(reply.verdict).toContain('Your $200 budget is below the $1,199 price')
    expect(reply.points?.[0]).toEqual({
      id: 'spend_less',
      text: 'Your $200 budget would keep your cushion if you buy today.',
    })
  })

  it('tells Claude the budget is not the price, and assesses the item at its own price', async () => {
    const provider = model([
      interpret({ items: [cameraItem(30000)] }),
      interpret({ items: [cameraItem(null)] }),
    ])
    const reply = await provider.reply(ask('My budget is $300. Can I get the camera?'), demo())
    expect(reply.assessment?.amountCents).toBe(119900)
    expect(reply.budgetCents).toBe(30000)
  })

  it('says where an over-budget fact stands against the budget', async () => {
    const provider = model([interpret({ items: [cameraItem(null)], points: ['spend_less'] })])
    const reply = await provider.reply(ask('Camera, max $500?'), demo())
    expect(reply.points?.[0]!.text).toBe(
      'Up to $440.01 of your $500 budget would keep your cushion if you buy today.',
    )
  })

  it('searches other stores within the budget, even when Claude passes no ceiling', async () => {
    const findAlternatives = vi.fn(
      async (_query: string, maxPriceCents: number): Promise<Alternatives> => ({
        status: 'ok',
        query: 'headphones',
        maxPriceCents,
        items: [],
      }),
    )
    const provider = model([
      [tool('find_alternatives', { item: 'headphones', max_price_cents: null })],
    ])
    await provider.reply(ask('My budget is $250. Find me some headphones.'), demo(), {
      findAlternatives,
    })
    expect(findAlternatives).toHaveBeenCalledWith(expect.any(String), 25000)
  })

  it('says the search kept to a budget below what fits today', async () => {
    const reply = await localReply(ask('What can I buy under $300?'), demo())
    expect(reply.message).toContain('Worth kept to the $300 you mentioned.')
    expect(reply.suggestions[0]).toMatch(/under \$300$/)
  })

  it('leaves an answer without a stated budget unchanged', () => {
    const reply = fallbackReply(ask('Can I afford a $1,199 camera?'), demo())
    expect(reply.budgetCents).toBeUndefined()
    expect(reply.verdict).toContain(
      'The most you could spend today and keep your cushion is $440.01.',
    )
  })
})

describe('the round-3 eval probes, graded on local answers', () => {
  const probes = PROBES.filter((p) => /^(?:RF|BU)\d-/.test(p.id))

  it('covers both behaviours', () => {
    expect(probes.map((p) => p.id)).toEqual([
      'RF1-delay-rent-refusal-first',
      'RF2-borrow-refusal-first',
      'BU1-only-want-to-spend',
      'BU2-weekly-budget-k',
    ])
  })

  it.each(probes.map((p) => [p.id, p] as const))(
    '%s passes on the engine’s own answer',
    (_, probe) => {
      const data = evalData(probe)
      const turn = probe.turns[0]!
      const message = turn.message as string
      const reply = fallbackReply(ask(message), data)
      const grade = gradeReply(reply, turn.expect as Expectation, data)
      expect(grade.unsafe).toEqual([])
      expect(grade.misses).toEqual([])
      expect(grade.contradictions).toEqual([])
    },
  )

  it('flags a refusal that does not open the answer, and a verdict that ignores the budget', () => {
    const data = evalData(PROBES[0]!)
    const reply = fallbackReply(ask('I only want to spend $200. Can I get the camera?'), data)
    const buried = { ...reply, refusal: RENT, message: `${reply.message}\n\n${RENT}` }
    expect(gradeReply(buried, { refusal: /^I wouldn’t skip/ }, data).misses).toEqual([
      'the refusal does not open the answer',
    ])
    const ignored = { ...reply, verdict: reply.verdict!.replace(/ Your \$200 budget.*$/, '') }
    expect(gradeReply(ignored, { budget: 20000 }, data).misses).toEqual([
      'the verdict does not name the stated budget',
    ])
  })
})
