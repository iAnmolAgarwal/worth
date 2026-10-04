import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it, vi } from 'vitest'
import { checkoutGuardTrail, CHECKOUT_GUARDS } from '../server/agentCheckout.ts'
import { createChatProvider, fallbackReply, localReply } from '../server/chat.ts'
import type { ChatActions, ChatData, ChatInput } from '../server/chat.ts'
import { readTiming } from '../server/dates.ts'
import { namesOtherItem } from '../server/interpret.ts'
import { checkSentence, purchasePlaceholders, templateSentence } from '../server/narration.ts'
import { nearPhrase, planLabel } from '../shared/collision.ts'
import { assessPurchase, planCollisions } from '../shared/finance.ts'
import { createDemoState } from '../shared/seed.ts'
import type { ChatReply } from '../shared/types.ts'

// The AI-visible phase (round-2 judge #2, #5, #7): Pay in 4 answered in chat from the engine, the
// trace of how Ask Worth read each question, and one checked Claude sentence under the verdict.

const TODAY = '2026-10-03'
// Maya: $1,300 funds, $300 cushion, rent $1,450 on Fri Oct 16, paycheck Oct 8, a laptop Pay in 4
// plan paying $160 on Oct 15, Oct 29 and Nov 12.
function demo(): ChatData {
  const seed = createDemoState(TODAY)
  return { profile: seed.profile, purchases: [], transactions: seed.transactions, today: TODAY }
}
const camera = { amountCents: 119900, itemName: 'camera', purchaseDate: TODAY }
// A right-to-left override, a bell, a zero-width space and a C1 next-line control.
const [RLO, BEL, ZWSP, NEL] = [0x202e, 0x07, 0x200b, 0x85].map((c) => String.fromCharCode(c))

type Block = Record<string, unknown>
function model(responses: Block[][]) {
  const create = vi.fn(async (_params: unknown, _options?: unknown) => ({
    content: responses.shift() ?? [],
    stop_reason: 'end_turn',
  }))
  const client = { messages: { create } } as unknown as Pick<Anthropic, 'messages'>
  return {
    provider: createChatProvider('unused-test-key', 'claude-sonnet-5-5', client, { log: vi.fn() }),
    create,
  }
}
let id = 0
const tool = (name: string, input: Record<string, unknown>) => [
  { type: 'tool_use', id: `t-${++id}`, name, input },
]
const interpret = (input: Record<string, unknown> = {}) =>
  tool('interpret_purchase', {
    items: [],
    combine: 'single',
    refers_to_previous_item: true,
    date_phrase: null,
    date: null,
    option: 'check',
    points: ['low_point'],
    lead_in: 'none',
    follow_ups: [],
    point_reasons: '',
    ...input,
  })
const note = (text: string | null) => [{ type: 'text', text: JSON.stringify({ note: text }) }]
const ask = (message: string, extra: Partial<ChatInput> = {}): ChatInput => ({
  message,
  history: [],
  ...extra,
})
const request = (create: ReturnType<typeof model>['create'], index: number) =>
  create.mock.calls[index]![0] as { messages: { role: string; content: unknown }[] }
/** Everything a person can read in a reply. */
const visible = (reply: ChatReply) =>
  [reply.message, reply.explanation ?? '', ...(reply.points ?? []).map((p) => p.text)].join('\n')

describe('Pay in 4 in chat (judge #2)', () => {
  it('answers "Is Pay in 4 cheaper than paying now?" with the schedule, not a price question', async () => {
    const { provider } = model([
      interpret({
        points: ['pay_in_4_schedule', 'pay_in_4_stacking'],
        point_reasons: 'answers_question, shows_risk',
      }),
      note(null),
    ])
    const reply = await provider.reply(
      ask('Is Pay in 4 cheaper than paying now?', { context: camera }),
      demo(),
    )
    expect(reply.intent).toBe('affordability')
    expect(reply.assessment?.amountCents).toBe(119900)
    expect(reply.payIn4).toMatchObject({ asked: true, totalCents: 119900 })
    expect(reply.payIn4!.payments.map((p) => [p.date, p.amountCents])).toEqual([
      ['2026-10-03', 29975],
      ['2026-10-17', 29975],
      ['2026-10-31', 29975],
      ['2026-11-14', 29975],
    ])
    // Payment 2 lands the day after rent; the strip names it.
    expect(reply.payIn4!.payments[1]!.nearestBill).toMatchObject({
      name: 'Apartment rent',
      daysFromInstalment: -1,
    })
    const schedule = reply.points!.find((p) => p.id === 'pay_in_4_schedule')!.text
    expect(schedule).toContain('4 payments of $299.75, about every 2 weeks starting today')
    expect(schedule).toContain('The total stays $1,199 and PayPal charges no interest')
    expect(schedule).toContain('payment 2 would land about 1 day after your apartment rent')
    expect(schedule).toContain('PayPal sets the exact dates')
    const stacking = reply.points!.find((p) => p.id === 'pay_in_4_stacking')!.text
    expect(stacking).toContain('You already have 1 instalment plan')
    expect(visible(reply)).not.toMatch(/recommend|you should|afford it with/i)
    expect(reply.trace!.facts).toEqual([
      { id: 'pay_in_4_schedule', reason: 'answers_question' },
      { id: 'pay_in_4_stacking', reason: 'shows_risk' },
    ])
    expect(reply.trace!.guards.map((g) => g.id)).toContain('pay_in_4_on_request')
  })

  it('answers the thesis question asked fresh, with PayPal’s eligibility deciding', async () => {
    const { provider } = model([
      interpret({
        items: [{ name: 'camera', amount_cents: 119900, currency: 'USD', quantity: 1 }],
        refers_to_previous_item: false,
        points: ['pay_in_4_schedule'],
      }),
      note(null),
    ])
    const actions: ChatActions = { payIn4Eligibility: vi.fn(async () => 'paypal' as const) }
    const reply = await provider.reply(
      ask(
        'If I put the $1,199 camera on PayPal Pay in 4, which bills would the payments land next to?',
      ),
      demo(),
      actions,
    )
    expect(reply.payIn4).toMatchObject({ asked: true, eligibility: 'paypal' })
    expect(reply.trace!.guards).toContainEqual(
      expect.objectContaining({ id: 'pay_in_4_eligible', passed: true }),
    )
  })

  it('shows the schedule in local mode too, for a follow-up that names no item', () => {
    const reply = fallbackReply(
      ask('Is Pay in 4 cheaper than paying now?', { context: camera }),
      demo(),
    )
    expect(reply.assessment?.amountCents).toBe(119900)
    expect(reply.payIn4?.asked).toBe(true)
    expect(reply.payIn4?.payments).toHaveLength(4)
    expect(reply.message).toContain('PayPal charges no interest')
    expect(reply.trace).toMatchObject({ reader: 'local', tools: [] })
  })

  it('asks PayPal for eligibility in local mode when it can', async () => {
    const payIn4Eligibility = vi.fn(async () => 'unavailable' as const)
    const reply = await localReply(
      ask('Which bills would my Pay in 4 payments land next to?', { context: camera }),
      demo(),
      undefined,
      { payIn4Eligibility },
    )
    expect(payIn4Eligibility).toHaveBeenCalledWith(119900)
    expect(reply.payIn4).toMatchObject({ asked: true, eligibility: 'unavailable', payments: [] })
  })

  it('adds one neutral Pay in 4 row to purchase answers PayPal’s range covers', () => {
    const reply = fallbackReply(ask('Can I afford a $1,199 camera?'), demo())
    expect(reply.payIn4).toMatchObject({ asked: false, eligibility: 'range-only' })
    expect(reply.payIn4!.payments[1]!.nearestBill?.name).toBe('Apartment rent')
    // Not asked: the answer's text says nothing about Pay in 4.
    expect(reply.message).not.toMatch(/Pay in 4/)
    for (const message of ['Can I afford a $9.99 book?', 'Can I afford a $2,000.01 sofa?'])
      expect(fallbackReply(ask(message), demo()).payIn4).toBeUndefined()
  })

  it('says Pay in 4 is unavailable out of range when asked', () => {
    const reply = fallbackReply(ask('Can I get a $2,500 TV with Pay in 4?'), demo())
    expect(reply.payIn4).toMatchObject({ asked: true, eligibility: 'unavailable', payments: [] })
    expect(reply.message).toContain('PayPal Pay in 4 is not available for $2,500.')
  })

  it('never reads “pay later” as timing', () => {
    expect(readTiming('Could I pay later with Pay in 4 for a $2,400 TV?', TODAY).phrases).toEqual(
      [],
    )
    expect(readTiming('Can I pay for it later next Friday?', TODAY).phrases).toEqual([
      'next friday',
    ])
    expect(readTiming('Can I buy it later?', TODAY).blocking).toBe('vague')
  })

  it('never reads how to pay as another item', () => {
    for (const message of [
      'Is Pay in 4 cheaper than paying now?',
      'What if I pay later?',
      'Could I split it with PayPal?',
    ])
      expect(namesOtherItem(message, 'camera'), message).toBe(false)
    expect(namesOtherItem('What about a cheaper lens?', 'camera')).toBe(true)
  })
})

describe('the collision, surfaced (judge #7)', () => {
  it('finds the laptop payment that lands the day before rent', () => {
    const seed = createDemoState(TODAY)
    const found = planCollisions(seed.profile, [], TODAY)
    // Oct 15 next to rent, and Oct 29 on the same day as the utilities.
    expect(found.map((c) => [c.payment.date, c.bill.name])).toEqual([
      ['2026-10-15', 'Apartment rent'],
      ['2026-10-29', 'Electric and gas'],
    ])
    expect(found[0]!.payment).toMatchObject({ name: 'Laptop · Pay in 4', date: '2026-10-15' })
    expect(found[0]!.bill).toMatchObject({ name: 'Apartment rent', daysFromInstalment: 1 })
    expect(
      `Your ${planLabel(found[0]!.payment.name)} Pay in 4 payment lands ${nearPhrase(1, 'Apartment rent')}`,
    ).toBe('Your laptop Pay in 4 payment lands about 1 day before your apartment rent')
  })

  it('never states a collision to the day', () => {
    expect(nearPhrase(0, 'Rent')).toBe('about the same day as your rent')
    expect(nearPhrase(-2, 'Phone plan')).toBe('about 2 days after your phone plan')
  })
})

describe('how Ask Worth read this (judge #5)', () => {
  it('shows the store price as the source for a catalog item', async () => {
    const { provider } = model([
      interpret({
        items: [{ name: 'camera', amount_cents: null, currency: 'USD', quantity: 1 }],
        refers_to_previous_item: false,
      }),
      note(null),
    ])
    const reply = await provider.reply(ask('Can I afford the camera?'), demo())
    expect(reply.trace!.read).toEqual({
      item: 'Everyday camera',
      amountCents: 119900,
      source: 'catalog',
      store: 'Larkspur',
    })
    expect(reply.trace!.tools).toEqual([{ name: 'interpret_purchase', outcome: 'ran' }])
    expect(reply.trace!.reader).toBe('claude')
  })

  it('shows an item from earlier in the chat, and the date phrase it resolved', async () => {
    const { provider } = model([
      interpret({ date_phrase: 'next Friday', date: '2026-10-09' }),
      note(null),
    ])
    const reply = await provider.reply(ask('What about next Friday?', { context: camera }), demo())
    expect(reply.trace!.read).toMatchObject({ amountCents: 119900, source: 'earlier' })
    expect(reply.trace!.date).toEqual({
      phrase: 'next friday',
      date: '2026-10-09',
      label: 'Fri, Oct 9',
      source: 'stated',
    })
  })

  it('records a call the server sent back for correction', async () => {
    const laptop = (cents: number) => ({
      items: [{ name: 'laptop', amount_cents: cents, currency: 'USD', quantity: 1 }],
      refers_to_previous_item: false,
    })
    const { provider } = model([interpret(laptop(150)), interpret(laptop(150000)), note(null)])
    const reply = await provider.reply(ask('Can I afford a $1.5k laptop?'), demo())
    expect(reply.assessment?.amountCents).toBe(150000)
    expect(reply.trace!.tools).toEqual([
      { name: 'interpret_purchase', outcome: 'corrected' },
      { name: 'interpret_purchase', outcome: 'ran' },
    ])
    expect(reply.trace!.read?.source).toBe('your_words')
  })

  it('shows the check that made Worth ask instead of answering', async () => {
    const { provider } = model([
      interpret({
        items: [{ name: 'bag', amount_cents: 50000, currency: 'EUR', quantity: 1 }],
        refers_to_previous_item: false,
      }),
    ])
    const reply = await provider.reply(ask('Can I afford a €500 bag?'), demo())
    expect(reply.intent).toBe('clarify')
    expect(reply.trace!.tools).toEqual([{ name: 'interpret_purchase', outcome: 'asked' }])
    expect(reply.trace!.guards).toContainEqual(
      expect.objectContaining({ id: 'currency', passed: false }),
    )
    expect(reply.explanation).toBeUndefined()
  })

  it('lists every prepare_checkout guard that passed', async () => {
    const { provider } = model([
      tool('prepare_checkout', {
        item_id: 'headphones',
        option: 'buyToday',
        proceed_despite_shortfall: false,
      }),
      note(null),
    ])
    const prepareCheckout = vi.fn(async () => ({
      ok: true as const,
      checkout: {
        purchaseId: 'p1',
        orderId: 'o1',
        approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=o1',
        itemName: 'Studio headphones',
        amountCents: 34900,
        option: 'buyToday' as const,
        requiresProceedConfirm: false,
      },
    }))
    const reply = await provider.reply(ask('Buy the studio headphones now'), demo(), {
      prepareCheckout,
    })
    expect(reply.trace!.tools).toContainEqual({ name: 'prepare_checkout', outcome: 'ran' })
    const guards = reply.trace!.guards.filter((g) => CHECKOUT_GUARDS.some((c) => c.id === g.id))
    expect(guards.map((g) => g.id)).toEqual(CHECKOUT_GUARDS.map((g) => g.id))
    expect(guards.every((g) => g.passed)).toBe(true)
  })

  it('stops the guard list at the guard that refused', () => {
    const trail = checkoutGuardTrail({ ok: false, code: 'FUNDS_NOT_TODAY' })
    expect(trail.map((g) => [g.id, g.passed])).toEqual([
      ['asked', true],
      ['catalog_item', true],
      ['item_named', true],
      ['one_checkout', true],
      ['funds_today', false],
    ])
  })

  it('keeps hidden control and direction characters in an item name away from Claude', async () => {
    const { provider, create } = model([interpret(), note(null)])
    await provider.reply(
      ask('Can I afford it?', {
        context: { amountCents: 119900, itemName: `cam${RLO}era${BEL}${ZWSP} bag${NEL}` },
      }),
      demo(),
    )
    const first = request(create, 0).messages.at(-1)!.content as { text: string }[]
    expect(first[0]!.text).toContain('"cam era bag"')
    for (const hidden of [RLO, BEL, ZWSP, NEL]) expect(first[0]!.text.includes(hidden)).toBe(false)
  })
})

describe('one Claude sentence with engine placeholders only (C-13)', () => {
  const purchase = (sentence: string | null) =>
    model([interpret({ points: ['low_point', 'cause'] }), note(sentence)])

  it('fills Claude’s placeholders with the engine’s values', async () => {
    const { provider } = purchase(
      'Most of the pressure comes from {cause_bill} on {cause_day}, even after {income_name} arrives.',
    )
    const reply = await provider.reply(ask('Can I afford it?', { context: camera }), demo())
    expect(reply.explanation).toBe(
      'Most of the pressure comes from Apartment rent on Fri, Oct 16, even after Biweekly paycheck arrives.',
    )
    expect(reply.trace!.sentence).toEqual({
      source: 'claude',
      raw: 'Most of the pressure comes from {cause_bill} on {cause_day}, even after {income_name} arrives.',
    })
    // The verdict stays the template, first; the sentence follows it.
    expect(reply.message.split('\n\n')[1]).toBe(reply.explanation)
  })

  it.each([
    ['a free number', 'Rent of $1,450 lands before payday.', 'free_number'],
    ['a free date', 'Rent lands on Friday, before {income_name}.', 'free_date'],
    ['an unknown placeholder', 'Your {savings} cover it.', 'unknown_placeholder'],
    ['a claim the engine did not make', 'The {item} fits easily.', 'contradicts_result'],
    ['advice to pay a bill late', 'Paying {cause_bill} late would help.', 'advice'],
    ['a Pay in 4 suggestion', 'Consider PayPal Pay in 4 for the {item}.', 'advice'],
    ['a credit suggestion', 'A credit card could cover {item}.', 'advice'],
    ['two sentences', 'It is {cause_bill}. That comes first.', 'not_one_sentence'],
    [
      'a payday in words in the wrong order',
      '{cause_bill} on {cause_day} lands before your next paycheck.',
      'contradicts_result',
    ],
    [
      'days in the wrong order',
      '{cause_bill} on {cause_day} lands before {income_name} can cover it.',
      'contradicts_result',
    ],
    ['a figure next to Pay in 4', 'Pay in 4 splits it into 4 parts.', 'free_number'],
    ['no sentence', null, 'no_sentence'],
  ])('shows the template instead of %s', async (_, sentence, reason) => {
    const { provider } = purchase(sentence)
    const reply = await provider.reply(ask('Can I afford it?', { context: camera }), demo())
    expect(reply.trace!.sentence).toMatchObject({ source: 'template', rejected: reason })
    expect(reply.explanation).toBe(
      'Apartment rent ($1,450) on Fri, Oct 16 is the largest bill due before your balance reaches its low point on Thu, Oct 22.',
    )
  })

  it('reads “Pay in 4” as a name, and allows clauses joined in one sentence', () => {
    const data = { ...demo(), payIn4: 'paypal' as const }
    const a = assessPurchase(data.profile, [], {
      amountCents: 119900,
      itemName: 'camera',
      today: TODAY,
    })
    const values = purchasePlaceholders(a, data)
    const checked = checkSentence(
      'Pay in 4 keeps the same {price} total with no interest; {p4_collision}.',
      values,
      'tight',
    )
    expect(checked).toEqual({
      ok: true,
      text: 'Pay in 4 keeps the same $1,199 total with no interest; payment 2 would land about 1 day after your apartment rent.',
    })
  })

  it('keeps the full-price low point out of a sentence about Pay in 4', () => {
    const data = { ...demo(), payIn4: 'paypal' as const }
    const a = assessPurchase(data.profile, [], {
      amountCents: 119900,
      itemName: 'camera',
      today: TODAY,
    })
    const values = purchasePlaceholders(a, data)
    expect(
      checkSentence(
        'Splitting it, {p4_collision}, so you still fall to {low_point}.',
        values,
        'tight',
      ),
    ).toEqual({ ok: false, reason: 'contradicts_result' })
    expect(
      checkSentence(
        'Pay in 4 keeps the {price} total, so the low point is still {p4_low_point}.',
        values,
        'tight',
      ),
    ).toEqual({ ok: false, reason: 'contradicts_result' })
    const own = checkSentence(
      'With Pay in 4 your lowest point would be {p4_low_point} around {p4_low_day}; {p4_collision}.',
      values,
      'tight',
    )
    expect(own.ok).toBe(true)
  })

  it('reads “today” as the engine’s day only when the answer is about today, and “one” as a word', () => {
    const data = demo()
    const at = (date: string) =>
      purchasePlaceholders(
        assessPurchase(data.profile, [], {
          amountCents: 34900,
          itemName: 'headphones',
          purchaseDate: date,
          today: TODAY,
        }),
        data,
      )
    const sentence = 'Buying the {item} today, the next one due is {cause_bill} on {cause_day}.'
    expect(checkSentence(sentence, at(TODAY), 'fits').ok).toBe(true)
    expect(checkSentence(sentence, at('2026-10-16'), 'fits')).toEqual({
      ok: false,
      reason: 'free_date',
    })
  })

  it('accepts what would fit for a tight result', () => {
    const data = demo()
    const a = assessPurchase(data.profile, [], {
      amountCents: 119900,
      itemName: 'camera',
      today: TODAY,
    })
    const values = purchasePlaceholders(a, data)
    expect(
      checkSentence('Waiting until {wait_day} lets {income_name} land first.', values, 'tight'),
    ).toEqual({
      ok: true,
      text: 'Waiting until Fri, Oct 23 lets Biweekly paycheck land first.',
    })
    expect(templateSentence('purchase', values, 'incomplete')).toBeUndefined()
  })

  it('has no sentence for an off-topic answer and none in local mode', () => {
    expect(fallbackReply(ask('Write me a poem'), demo()).explanation).toBeUndefined()
    expect(fallbackReply(ask('Can I afford a $1,199 camera?'), demo()).explanation).toBeUndefined()
  })
})
