import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { createChatProvider } from '../server/chat.ts'
import {
  chipAllowed,
  commitmentFacts,
  leadInText,
  planFacts,
  purchaseFacts,
  spendingFacts30,
  verdictFor,
} from '../server/narration.ts'
import { assessPurchase } from '../shared/finance.ts'
import { createDemoState } from '../shared/seed.ts'

const TODAY = '2026-10-03'
const seed = createDemoState(TODAY)
const data = { profile: seed.profile, purchases: [], transactions: seed.transactions, today: TODAY }
const assess = (amountCents: number, purchaseDate = TODAY) =>
  assessPurchase(data.profile, [], { amountCents, itemName: 'camera', purchaseDate, today: TODAY })

describe('verdict template', () => {
  it('states the engine outcome, the earliest fitting date and the most that fits', () => {
    expect(verdictFor(assess(119900))).toBe(
      'Camera at $1,199 would dip below your cushion if you buy it today. The earliest date that fits is Fri, Oct 23. The most you could spend today and keep your cushion is $440.01.',
    )
    expect(verdictFor(assess(34900, '2026-10-16'))).toBe(
      'Camera at $349 fits your plan if you buy it on Fri, Oct 16.',
    )
  })
})

describe('fact catalogs', () => {
  it('writes every purchase fact from engine values, with its role in the sentence', () => {
    expect(purchaseFacts(assess(119900), data)).toEqual({
      low_point:
        'Your lowest balance would be -$458.99 on Thu, Oct 22, $758.99 below your $300 cushion.',
      cause: 'Apartment rent ($1,450) is due Fri, Oct 16, before that low point.',
      income: 'Your next income, Biweekly paycheck ($2,100), arrives Thu, Oct 8.',
      wait: 'Waiting until Fri, Oct 23 would keep your cushion for the full $1,199.',
      spend_less: 'Up to $440.01 would keep your cushion if you buy today.',
      stress:
        'With 20% higher everyday spending, your lowest balance would be -$578.99, below your $300 cushion.',
      bills_before:
        'Due before your low point: Car insurance $128 (Oct 5), Gym membership $35 (Oct 10), Phone plan $65 (Oct 12).',
    })
  })

  it('offers no waiting fact for a purchase that already fits', () => {
    const facts = purchaseFacts(assess(34900), data)
    expect(facts.wait).toBeUndefined()
    expect(facts.low_point).toContain('above your $300 cushion')
  })

  it('offers no facts while the plan is incomplete', () => {
    const incomplete = { ...data, profile: { ...data.profile, confirmed: false } }
    const a = assessPurchase(incomplete.profile, [], { amountCents: 119900, today: TODAY })
    expect(purchaseFacts(a, incomplete)).toEqual({})
  })

  it('writes plan, commitment and spending facts', () => {
    expect(planFacts(data).room_today).toBe('Up to $440.01 today would keep your $300 cushion.')
    expect(commitmentFacts(data, 'subscriptions')).toMatchObject({
      total: '3 subscriptions are due in the next 30 days, $62.48 in all.',
      largest: 'The largest is Gym membership at $35.',
      other_total: 'Bills that are not subscriptions add $2,008 over the same 30 days.',
    })
    expect(spendingFacts30(data).total).toMatch(
      /^You spent \$[\d,.]+ across \d+ completed purchases/,
    )
  })
})

describe('lead-ins and chips', () => {
  it('drops a lead-in that would not fit the result', () => {
    expect(leadInText('not_yes', 'tight')).toBe(
      'I can’t simply say yes. Here’s what your plan shows:',
    )
    expect(leadInText('not_yes', 'fits')).toBeUndefined()
    expect(leadInText('none', 'tight')).toBeUndefined()
  })

  it.each([
    ['When could I buy it?', true],
    ['What bills are coming up?', true],
    ['Could I skip rent this month?', false],
    ['What if I spend $900?', false],
    ['Can I put it on a credit card?', false],
    ['Should I use my cushion?', false],
    ['What about Friday?', false],
    ['What bills are coming up', false],
  ])('accepts only plain follow-up questions: %s', (chip, allowed) => {
    expect(chipAllowed(chip)).toBe(allowed)
  })
})

describe('no free-text financial claims', () => {
  it('ignores anything in points that is not a known fact id', async () => {
    const create = async () => ({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'interpret_purchase',
          input: {
            items: [{ name: 'camera', amount_cents: 119900, currency: 'USD', quantity: 1 }],
            combine: 'single',
            refers_to_previous_item: false,
            date_phrase: null,
            date: null,
            option: 'check',
            points: ['You can comfortably afford it.', 'wait'],
            lead_in: 'none',
            follow_ups: [],
          },
        },
      ],
    })
    const provider = createChatProvider(
      'unused',
      'claude-sonnet-5-5',
      { messages: { create } } as unknown as Pick<Anthropic, 'messages'>,
      { log: () => {} },
    )
    const reply = await provider.reply(
      { message: 'Can I afford a $1,199 camera?', history: [] },
      data,
    )
    expect(reply.points?.map((p) => p.id)).toEqual(['wait'])
    expect(JSON.stringify(reply)).not.toContain('comfortably afford')
  })
})
