import Anthropic from '@anthropic-ai/sdk'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gradeReply } from '../eval/grade.ts'
import { evalData } from '../eval/harness.ts'
import { PROBES } from '../eval/probes.ts'
import type { Expectation } from '../eval/probes.ts'
import { createChatProvider, fallbackReply, localReply, statedBudget } from '../server/chat.ts'
import type { ChatData, ChatInput } from '../server/chat.ts'
import { readTiming } from '../server/dates.ts'
import { checkSentence, purchasePlaceholders, refusalFor } from '../server/narration.ts'
import { createApp } from '../server/app.ts'
import { Store } from '../server/store.ts'
import { assessPurchase, compareOptions } from '../shared/finance.ts'
import { createDemoState } from '../shared/seed.ts'
import type { Alternatives, Comparison } from '../shared/types.ts'

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
    ['Could I pay rent a bit later and get the camera?', 'no_skipping'],
    ['Can I not pay my phone bill this month and get the camera?', 'no_skipping'],
    ['Should I delay my car payment?', 'no_skipping'],
    ['My brother could lend me $500', 'no_credit'],
    ['Can I max out my card for the camera?', 'no_credit'],
    ['Can I use PayPal Credit for the camera?', 'no_credit'],
    ['Can I use my savings cushion?', 'no_cushion'],
    // Round 2 (judge B8 r2 #3).
    ['Can I just be late on rent this month and get the $1,199 camera?', 'no_skipping'],
    ['What if I skip my car insurance payment to buy the $1,199 camera?', 'no_skipping'],
    ['Should I skip my next Pay in 4 payment?', 'no_skipping'],
    ['Should I take money out of my emergency fund for the $1,199 camera?', 'no_cushion'],
    ['Can I finance the $1,199 camera?', 'no_credit'],
    ['Can I put the $1,199 camera on my Visa?', 'no_credit'],
    ['Could I get a payday loan for the $1,199 camera?', 'no_credit'],
    ['I will just pay my electric bill late, can I get the $1,199 camera', 'no_skipping'],
    ['Why not pay rent late?', 'no_skipping'],
  ])('“%s” calls for %s (judge B8 #4)', (message, lead) => {
    expect(refusalFor(message)).toBe(lead)
  })

  it.each([
    // The skip word must belong to the bill (judge B8 #2).
    'Is it too late to buy the camera before rent?',
    'Should I skip the camera and save for rent?',
    'I paid rent already',
    // Not a request to borrow: an overdraft question, a card that may be debit, the past tense.
    'Will the $1,199 camera overdraw my account?',
    'Can I put it on my card today? $40 headphones',
    'I borrowed my friend’s camera, should I buy my own?',
    'Can I put it on my PayPal?',
    // Round 2 (judge B8 r2 #2): push without back/off, a negation, a card's points.
    'Will the $1,199 camera push my rent payment too close?',
    'I don’t want to borrow, can I afford the $1,199 camera?',
    'Can I afford the $1,199 camera without using my cushion?',
    'Can I afford it without touching my emergency fund?',
    'Can I use my credit card points on the $1,199 camera?',
    'I already paid rent, can I get the $1,199 camera?',
    'Is it OK to skip buying the camera so rent is covered?',
    'Should I skip buying the camera to make my rent payment?',
    'Can I put it on my Visa debit card?',
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

  it.each([
    'Would a $50 book eat into my cushion?',
    'Will buying a $50 book use my cushion?',
    'Could I borrow $40 from my brother for a book?',
  ])('drops the cushion and credit refusals when “%s” fits (judge B8 #2)', (message) => {
    const reply = fallbackReply(ask(message), demo())
    expect(reply.assessment?.outcome).toBe('fits')
    expect(reply.refusal).toBeUndefined()
    expect(paragraphs(reply.message)[0]).toBe(reply.verdict)
  })

  it('keeps the refusal to skip a bill even when the purchase fits', () => {
    const reply = fallbackReply(ask('Should I skip rent to buy a $50 book?'), demo())
    expect(reply.assessment?.outcome).toBe('fits')
    expect(reply.refusal).toBe(RENT)
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
    ['Can I get the camera under 500?', 50000],
    ['My budget is 300. Can I get the camera?', 30000],
  ])('reads a bare limit in “%s” as %i cents (judge B8 #5)', (message, cents) => {
    expect(statedBudget(message)).toBe(cents)
  })

  it.each([
    'Can I spend $349 on headphones?',
    'Can I afford a $1,199 camera?',
    // A price with its week is a price; "more than" and "go over" without a "not" are questions.
    'Can I buy the camera for $1,199 this week?',
    'Can I spend $1,199 this week on the camera?',
    'Can I spend more than $300 on the camera?',
    'Will the camera go over $300?',
    'Is the store under 5 minutes away?',
    'My budget is $300, max $400. Can I get the camera?',
    'My budget is 300 euros. Can I get the camera?',
  ])('reads no budget in “%s”', (message) => {
    expect(statedBudget(message)).toBeUndefined()
  })

  it.each([
    'Can I buy the camera for $1,199 this week?',
    'Can I spend $1,199 this week on the camera?',
  ])('still asks which day for a price with “this week”: “%s” (judge B8 #1)', (message) => {
    const reply = fallbackReply(ask(message), demo())
    expect(reply.intent).toBe('clarify')
    expect(reply.budgetCents).toBeUndefined()
    expect(reply.message).toMatch(/^Which day would you buy/)
  })

  it('never treats the item’s own price as its budget', () => {
    const reply = fallbackReply(ask('My budget is $1,199. Can I get the camera?'), demo())
    expect(reply.assessment?.amountCents).toBe(119900)
    expect(reply.budgetCents).toBeUndefined()
    expect(reply.verdict).not.toContain('budget')
  })

  it('never reads a budget’s period as the purchase date', () => {
    expect(readTiming('My budget is $400 this week. Can I get it?', TODAY).phrases).toEqual([])
    expect(readTiming('I have $1.5k to spend this week', TODAY).phrases).toEqual([])
    expect(readTiming('My budget this week is $300', TODAY).phrases).toEqual([])
    expect(readTiming('Can I buy the camera this week?', TODAY).phrases).toEqual(['this week'])
    expect(readTiming('the camera for $1,199 this week', TODAY).phrases).toEqual(['this week'])
    expect(readTiming('Can I spend $1,199 this week?', TODAY).phrases).toEqual(['this week'])
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

describe('Claude’s sentence never stretches a budget below the price (judge B8 #3)', () => {
  const data = demo()
  const camera = assessPurchase(data.profile, [], { amountCents: 119900, today: TODAY })
  const below = purchasePlaceholders(camera, { ...data, budgetCents: 30000 })
  const covers = purchasePlaceholders(camera, { ...data, budgetCents: 150000 })

  it.each([
    'Your {budget} budget covers the {price} price.',
    'The {price} price is within your {budget} budget.',
    'Your {budget} budget is more than enough for the {price} camera.',
    'You can stretch past your {budget} budget.',
    'Going over your {budget} budget would let you buy the {item}.',
  ])('rejects “%s”', (sentence) => {
    expect(checkSentence(sentence, below, 'tight')).toEqual({
      ok: false,
      reason: 'contradicts_result',
    })
  })

  it.each([
    // Round 2 (judge B8 r2 #1): paraphrases a deny-list let through.
    'Your {budget} budget will get you the {item}.',
    'Your {budget} budget is all you need for the {item}.',
    'Your {budget} budget buys the {item}.',
    'Your budget covers the {price} camera.',
    'The {item} at {price} is well under your budget.',
    'You could stretch your {budget} budget to {max_spend}.',
  ])('rejects “%s” when the budget is below the price', (sentence) => {
    expect(checkSentence(sentence, below, 'tight')).toEqual({
      ok: false,
      reason: 'contradicts_result',
    })
  })

  it('accepts what fits within a budget, at the budget itself', () => {
    expect(below.max_spend?.value).toBe('$300')
    expect(
      checkSentence(
        'Within your {budget} budget, up to {max_spend} keeps your cushion.',
        below,
        'tight',
      ),
    ).toEqual({ ok: true, text: 'Within your $300 budget, up to $300 keeps your cushion.' })
    // Without a budget, the most that fits stays the engine's limit.
    expect(purchasePlaceholders(camera, data).max_spend?.value).toBe('$440.01')
  })

  it('accepts a sentence that keeps the budget below the price, and tells Claude which it is', () => {
    expect(below.budget?.about).toContain('below the price')
    expect(covers.budget?.about).toContain('covers the price')
    expect(
      checkSentence('Your {budget} budget is below the {price} price.', below, 'tight'),
    ).toEqual({
      ok: true,
      text: 'Your $300 budget is below the $1,199 price.',
    })
    // A budget that covers the price may be said to cover it.
    expect(
      checkSentence('Your {budget} budget covers the {price} price.', covers, 'tight').ok,
    ).toBe(true)
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

describe('the comparison keeps a stated budget (judge B8 #7)', () => {
  const stores: Store[] = []
  afterEach(() => {
    for (const store of stores.splice(0)) store.close()
  })
  function compareOn(body: object) {
    const store = new Store(':memory:')
    stores.push(store)
    const app = createApp({
      store,
      config: {
        production: false,
        port: 5173,
        host: '127.0.0.1',
        origin: 'http://localhost:5173',
        paypalClientId: undefined,
        paypalSecret: undefined,
        anthropicKey: undefined,
      },
      now: () => new Date(`${TODAY}T12:00:00Z`),
    })
    return request(app)
      .post('/api/compare')
      .set('X-Worth-Client', 'web')
      .set('X-Worth-Timezone', 'America/New_York')
      .send(body)
  }

  it('caps Spend less at the engine’s own result for the budget', () => {
    const data = demo()
    const plain = compareOptions(data.profile, [], { amountCents: 119900, today: TODAY })
    const capped = compareOptions(data.profile, [], {
      amountCents: 119900,
      today: TODAY,
      budgetCents: 30000,
    })
    expect(plain.spendLess.maxPriceCents).toBe(44001)
    expect(capped.spendLess.maxPriceCents).toBe(30000)
    expect(capped.budgetCents).toBe(30000)
    // Spending the budget leaves more above the cushion than spending the most that fits.
    expect(capped.spendLess.headroomCents).toBe(plain.spendLess.headroomCents + 14001)
    // Buying today and waiting are unchanged.
    expect(capped.buyToday).toEqual(plain.buyToday)
    expect(capped.wait).toEqual(plain.wait)
  })

  it('never lets a claimed budget raise Spend less, or apply when it covers the price', () => {
    const data = demo()
    for (const budgetCents of [50000, 150000]) {
      const result = compareOptions(data.profile, [], {
        amountCents: 119900,
        today: TODAY,
        budgetCents,
      })
      expect(result.spendLess.maxPriceCents).toBe(44001)
      expect(result.budgetCents).toBeUndefined()
    }
  })

  it('takes the budget on /api/compare, and refuses one that is not whole cents', async () => {
    const capped = await compareOn({ productId: 'camera', budgetCents: 30000 })
    expect(capped.status).toBe(200)
    expect((capped.body as Comparison).spendLess.maxPriceCents).toBe(30000)
    const higher = await compareOn({ productId: 'camera', budgetCents: 90000 })
    expect((higher.body as Comparison).spendLess.maxPriceCents).toBe(44001)
    expect((await compareOn({ productId: 'camera', budgetCents: -1 })).status).toBe(400)
    expect((await compareOn({ productId: 'camera', budgetCents: 1.5 })).status).toBe(400)
    expect((await compareOn({ productId: 'camera', budgetCents: 0 })).status).toBe(400)
  })
})

describe('Pay in 4 is never called credit (cold judge #2)', () => {
  it('drops the borrowing refusal Claude chose for a question about Pay in 4', async () => {
    const reply = await model([
      interpret({
        items: [cameraItem(null)],
        refers_to_previous_item: true,
        points: ['low_point'],
        lead_in: 'no_credit',
      }),
    ]).reply(ask('Should I just use Pay in 4?', { context: camera }), demo())
    expect(reply.assessment?.amountCents).toBe(119900)
    expect(reply.verdict).toMatch(/^Camera at \$1,199/)
    expect(reply.refusal).toBeUndefined()
    expect(reply.lead ?? '').not.toMatch(/credit|instalments/)
    // The answer leads with the verdict; the only word on interest is that PayPal charges none.
    expect(paragraphs(reply.message)[0]).toBe(reply.verdict)
    expect(reply.message.replaceAll('PayPal charges no interest', '')).not.toMatch(/interest/i)
    expect(reply.message).not.toMatch(/borrow|use credit/i)
    expect(reply.trace?.guards.map((guard) => guard.id)).not.toContain('no_credit')
  })

  it('keeps it for real borrowing, even next to Pay in 4', async () => {
    const reply = await model([
      interpret({
        items: [cameraItem(null)],
        refers_to_previous_item: true,
        points: ['low_point'],
        lead_in: 'no_credit',
      }),
    ]).reply(ask('Should I put it on my credit card or use Pay in 4?', { context: camera }), demo())
    expect(reply.refusal).toBe(CREDIT)
  })
})
