import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it, vi } from 'vitest'
import { checkoutGuardTrail, CHECKOUT_GUARDS } from '../server/agentCheckout.ts'
import { createChatProvider, fallbackReply, localReply } from '../server/chat.ts'
import type { ChatActions, ChatData, ChatInput } from '../server/chat.ts'
import { readTiming } from '../server/dates.ts'
import { namesOtherItem } from '../server/interpret.ts'
import {
  checkSentence,
  planPlaceholders,
  purchasePlaceholders,
  templateSentence,
} from '../server/narration.ts'
import { nearPhrase, planLabel } from '../shared/collision.ts'
import { assessPurchase, payIn4Scenario, planCollisions } from '../shared/finance.ts'
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
const camera0 = camera
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
    // PayPal's US range is $10.00 to $2,000.00, both ends included.
    for (const message of ['Can I afford a $10.00 book?', 'Can I afford a $2,000.00 sofa?'])
      expect(fallbackReply(ask(message), demo()).payIn4).toMatchObject({
        eligibility: 'range-only',
      })
  })

  it('says Pay in 4 is unavailable just outside PayPal’s $10–$2,000 range when asked', () => {
    for (const [message, amount] of [
      ['Can I get a $9.99 book with Pay in 4?', '$9.99'],
      ['Can I get a $2,000.01 sofa with Pay in 4?', '$2,000.01'],
    ] as const) {
      const reply = fallbackReply(ask(message), demo())
      expect(reply.payIn4).toMatchObject({ asked: true, eligibility: 'unavailable', payments: [] })
      expect(reply.message).toContain(`PayPal Pay in 4 is not available for ${amount}.`)
    }
  })

  it('says Pay in 4 is unavailable out of range when asked', () => {
    const reply = fallbackReply(ask('Can I get a $2,500 TV with Pay in 4?'), demo())
    expect(reply.payIn4).toMatchObject({ asked: true, eligibility: 'unavailable', payments: [] })
    expect(reply.message).toContain('PayPal Pay in 4 is not available for $2,500.')
  })

  it('starts the schedule on a later purchase date, with its own collisions (judge F1)', () => {
    const reply = fallbackReply(
      ask('What if I buy it on Oct 23 with Pay in 4 instead?', {
        context: { amountCents: 119900, itemName: 'Everyday camera', purchaseDate: TODAY },
      }),
      demo(),
    )
    expect(reply.assessment?.purchaseDate).toBe('2026-10-23')
    expect(reply.payIn4!.payments.map((p) => p.date)).toEqual([
      '2026-10-23',
      '2026-11-06',
      '2026-11-20',
      '2026-12-04',
    ])
    // No collision or dip from before the purchase: rent on Oct 16 is never named.
    for (const payment of reply.payIn4!.payments) {
      expect(payment.nearestBill!.date >= '2026-10-20').toBe(true)
      expect(payment.belowCushion).toBe(false)
    }
    expect(reply.payIn4!.label).toBe('Instalment scenario stays above your cushion')
    expect(reply.message).toContain('about every 2 weeks starting on Fri, Oct 23')
    expect(reply.message).not.toMatch(/apartment rent|Oct 21/)
  })

  it('names only bills and income from the purchase date on in a later day’s sentence', () => {
    const data = demo()
    const a = assessPurchase(data.profile, [], {
      amountCents: 119900,
      itemName: 'camera',
      purchaseDate: '2026-10-23',
      today: TODAY,
    })
    const values = purchasePlaceholders(a, data)
    expect(values.cause_day!.date! >= '2026-10-23').toBe(true)
    expect(values.income_day!.date! >= '2026-10-23').toBe(true)
  })

  it('gives the engine a start date while the window stays from today', () => {
    const seed = createDemoState(TODAY)
    const later = payIn4Scenario(seed.profile, [], {
      amountCents: 119900,
      today: TODAY,
      start: '2026-10-23',
    })
    const now = payIn4Scenario(seed.profile, [], { amountCents: 119900, today: TODAY })
    if (!later.available || !now.available) throw new Error('Expected both scenarios')
    expect(later.instalments[0]!.date).toBe('2026-10-23')
    expect(later.instalments[3]!.date).toBe('2026-12-04')
    expect(later.points[0]!.date).toBe(TODAY)
    expect(now.instalments[0]!.date).toBe(TODAY)
    expect(now.instalments[1]!.belowCushion).toBe(true)
  })

  it('names the item, not “work”, in “How would Pay in 4 work for …” (judge F8)', () => {
    const reply = fallbackReply(ask('How would Pay in 4 work for a $10.03 phone case?'), demo())
    expect(reply.assessment?.itemName).toMatch(/phone case/i)
    expect(reply.payIn4?.payments.map((p) => p.amountCents)).toEqual([253, 250, 250, 250])
  })

  it('drops fact reasons outside the fixed set', async () => {
    const { provider } = model([
      interpret({
        points: ['low_point', 'cause'],
        point_reasons: 'trust_me_its_fine, <img src=x>, ANSWERS_QUESTION',
      }),
      note(null),
    ])
    const reply = await provider.reply(ask('Can I afford it?', { context: camera }), demo())
    expect(reply.trace!.facts).toEqual([{ id: 'low_point' }, { id: 'cause' }])
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
    ['a free number', 'Rent of $1,450 lands before payday.', 'not_plain'],
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
    ['a figure next to Pay in 4', 'Pay in 4 splits it into 4 parts.', 'not_plain'],
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
      ).ok,
    ).toBe(false)
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

// Judge F3: sentences the first check accepted. Each must now fall back to the template; the table
// only grows. Camera: $1,199 today, tight, asked about Pay in 4. Book: $20 today, fits.
describe('the sentence check rejects what the judge found (F3)', () => {
  const data = demo()
  const assess = (amountCents: number, itemName: string) =>
    assessPurchase(data.profile, [], { amountCents, itemName, today: TODAY })
  const camera = purchasePlaceholders(assess(119900, 'camera'), { ...data, payIn4: 'paypal' })
  const cameraPlain = purchasePlaceholders(assess(119900, 'camera'), data)
  const book = purchasePlaceholders(assess(2000, 'book'), data)
  const plan = planPlaceholders(data)
  const cases: [string, string, typeof camera, 'tight' | 'fits'][] = [
    // Pay in 4 recommendations
    ['recommends', 'Pay in 4 is the smarter way to buy {item}.', camera, 'tight'],
    ['recommends, unasked', 'Pay in 4 is the smarter way to buy {item}.', cameraPlain, 'tight'],
    [
      'recommends',
      'Pay in 4 is your best bet for {item}, with {p4_payment} each time.',
      camera,
      'tight',
    ],
    [
      'credits Pay in 4',
      'Splitting {item} with Pay in 4 keeps your balance at {p4_low_point}.',
      camera,
      'tight',
    ],
    [
      'credits Pay in 4',
      'Paying with Pay in 4 instead lifts your low point to {p4_low_point}.',
      camera,
      'tight',
    ],
    ['credits Pay in 4', 'Pay in 4 helps spread {price}, and {p4_collision}.', camera, 'tight'],
    [
      'credits Pay in 4',
      'With Pay in 4, {item} works out because your low is {p4_low_point}.',
      camera,
      'tight',
    ],
    // False Pay in 4 facts
    ['interest', 'Pay in 4 charges interest on {p4_payment}.', camera, 'tight'],
    [
      'cheaper',
      'Pay in 4 is cheaper than paying {price} now, and {p4_collision}.',
      camera,
      'tight',
    ],
    ['identical', 'With Pay in 4 your low point is identical, {p4_low_point}.', camera, 'tight'],
    ['matches', 'Your Pay in 4 low point matches {p4_low_point} too.', camera, 'tight'],
    // Contradicts a tight result
    ['tight: fine', '{item} works out fine on {buy_day} with {low_point} left.', camera, 'tight'],
    ['tight: good shape', 'You are in good shape to buy {item} on {buy_day}.', camera, 'tight'],
    ['tight: no issue', 'There is no issue buying {item} today.', camera, 'tight'],
    ['tight: covered', 'Your {cushion} cushion is covered even after {item}.', camera, 'tight'],
    ['tight: gap over', 'You remain {gap} over your cushion even at {low_point}.', camera, 'tight'],
    // Contradicts a fitting result
    ['fits: does not fit', '{item} does not fit because of {cause_bill}.', book, 'fits'],
    [
      'fits: under',
      'Your balance falls under your {cushion} cushion at {low_point}.',
      book,
      'fits',
    ],
    ['fits: overdrawn', 'You would be overdrawn by {low_day}.', book, 'fits'],
    ['fits: won’t hold', 'Your balance won’t hold your {cushion} cushion.', book, 'fits'],
    // Free dates
    [
      'ordinal date',
      '{cause_bill} lands on the sixteenth, before your low point.',
      camera,
      'tight',
    ],
    ['a few days', '{cause_bill} is due in a few days.', camera, 'tight'],
    ['a couple of days', '{cause_bill} is due in a couple of days.', camera, 'tight'],
    ['shortly', '{cause_bill} is due shortly.', camera, 'tight'],
    ['a holiday', 'Around Halloween your balance reaches {low_point}.', camera, 'tight'],
    ['pay in 4 days', 'You could pay in 4 days once {income_name} lands.', camera, 'tight'],
    // Free numbers and currency
    ['pct', '{cause_bill} takes a big pct of your balance.', camera, 'tight'],
    ['USD', 'Your balance of {low_point} is in USD.', camera, 'tight'],
    ['roman numeral', '{cause_bill} is due on day XVI.', camera, 'tight'],
    ['several', 'Several bills land before {low_day}.', camera, 'tight'],
    ['zero-width split', 'Thr\u200Bee bills land before {low_day}.', camera, 'tight'],
    ['homoglyph', 'Thr\u0435e bills land before {low_day}.', camera, 'tight'],
    // Advice
    ['wiser', 'It would be wiser to hold off on {item}.', camera, 'tight'],
    ['suggest', 'I suggest waiting on the {item}.', camera, 'tight'],
    ['dip into', 'Dip into your {cushion} cushion for {item}.', camera, 'tight'],
    ['use your cushion', 'Use your {cushion} cushion to cover {item}.', camera, 'tight'],
    ['pay later, unasked', 'Pay later lets you keep {cushion} in place.', cameraPlain, 'tight'],
    ['pay rent late', 'Paying {cause_bill} a little late keeps {cushion} intact.', camera, 'tight'],
    // Values in the wrong place
    [
      'cushion is the low point',
      'Your cushion is {low_point} after buying {item}.',
      camera,
      'tight',
    ],
    ['income on the low day', '{income_name} arrives on {low_day}.', camera, 'tight'],
    ['price as the limit', 'The most you can spend is {price}.', camera, 'tight'],
    [
      'room relabelled as the stressed balance',
      'The {item} still leaves {gap} of room, and higher everyday spending would only trim it to {stress_low}.',
      book,
      'fits',
    ],
    // Not one sentence
    [
      'two semicolons',
      '{cause_bill} is due {cause_day}; your low is {low_point}; nothing else matters here.',
      camera,
      'tight',
    ],
    ['a line break', '{cause_bill} is due {cause_day}\nyour low is {low_point}.', camera, 'tight'],
  ]
  it.each(cases)('rejects %s: %s', (_, sentence, values, outcome) => {
    expect(checkSentence(sentence, values, outcome).ok).toBe(false)
  })
  // Already rejected before F3; kept so the table only grows.
  it.each([
    ['{cause_bill} is due in two weeks.'],
    ['You keep three hundred above {cushion}.'],
    ['{cause_bill} lands next Friday.'],
  ])('still rejects %s', (sentence) => {
    expect(checkSentence(sentence, camera, 'tight').ok).toBe(false)
  })

  // Sentences Claude wrote in the live eval that are sound; they must keep passing.
  it.each([
    [
      'Pay in 4 doesn’t make the {item} cheaper: the total stays {price}, and {p4_collision}.',
      camera,
      'tight',
    ],
    [
      'The {item} fits because {cause_bill} is covered by {income_name} on {income_day}, leaving {low_point} on {low_day}.',
      book,
      'fits',
    ],
    [
      '{cause_bill} pulls your balance down before {cause_payday}, so the {item} fits only once {payday_after_low} has restored the {cushion} buffer.',
      camera,
      'tight',
    ],
    [
      '{cause_bill} on {cause_day} comes before the next payday, {cause_payday}, so the balance cannot absorb the {item} until that pay lands.',
      camera,
      'tight',
    ],
    [
      'The next paycheck after {cause_bill}, {cause_payday}, comes too late to offset a {price} {item}.',
      camera,
      'tight',
    ],
    [
      'Nothing turned up under that limit because {cause_bill}, due {cause_day}, pulls the balance to its lowest point, so only {room_today} is free today.',
      plan,
      'tight',
    ],
    [
      'The {cause_bill} payment of {cause_amount} drives the low point on {low_day}, yet {price} for the {item} still leaves {gap} of room above your {cushion}.',
      book,
      'fits',
    ],
    [
      'Splitting the {item} keeps the same {price} total, and the payments still land around {cause_bill}, so the low point of {p4_low_point} on {p4_low_day} stays below the {cushion} cushion.',
      camera,
      'tight',
    ],
    [
      'Even after {cause_bill} is paid, the balance stays above the {cushion}, but if everyday spending runs higher, the low point could drop to {stress_low}, below that cushion.',
      book,
      'fits',
    ],
    [
      '{cause_bill} on {cause_day} lands before {cause_payday}, so the {item} leaves less than your {cushion} cushion.',
      camera,
      'tight',
    ],
    [
      '{income_name} on {income_day} helps cover {cause_bill} on {cause_day}, so the balance keeps your {cushion} cushion.',
      book,
      'fits',
    ],
    [
      '{cause_bill} on {cause_day} pulls the balance to {low_point} before the next payday on {payday_after_low}.',
      camera,
      'tight',
    ],
    [
      'Pay in 4 is not cheaper, since the {price} total stays the same with no interest; it only spreads payments of {p4_payment}, and {p4_collision}.',
      camera,
      'tight',
    ],
    ['Pay in 4 keeps the same {price} total with no interest; {p4_collision}.', camera, 'tight'],
    [
      'With Pay in 4 your lowest point would be {p4_low_point} around {p4_low_day}; {p4_collision}.',
      camera,
      'tight',
    ],
    [
      'Buying the {item} for {price} {buy_day} pushes your balance to {low_point} on {low_day}, mostly because {cause_bill} of {cause_amount} is due on {cause_day}, leaving you {gap} under your {cushion} cushion.',
      camera,
      'tight',
    ],
    [
      'Even after {cause_bill} of {cause_amount} on {cause_day}, your balance bottoms out at {low_point} on {low_day}, {gap} above your {cushion} cushion.',
      book,
      'fits',
    ],
    ['Waiting until {wait_day} lets {income_name} land first.', camera, 'tight'],
    [
      'Pay in 4 keeps the same {price} total, so it isn’t cheaper; {cause_bill} of {cause_amount} on {cause_day} is what pulls the balance down.',
      camera,
      'tight',
    ],
    [
      'Because the {item} costs so little, your balance stays above {cushion}, and the low point of {low_point} on {low_day} comes from {cause_bill} on {cause_day}, not from this purchase.',
      book,
      'fits',
    ],
  ] as const)('accepts %s', (sentence, values, outcome) => {
    expect(checkSentence(sentence, values, outcome).ok).toBe(true)
  })

  it('rejects a Pay in 4 recommendation end to end, under a plain question', async () => {
    const { provider } = model([
      interpret({ points: ['low_point'] }),
      note('Pay in 4 is the smarter way to buy {item}.'),
    ])
    const reply = await provider.reply(ask('Can I afford it?', { context: camera0 }), demo())
    expect(reply.trace!.sentence).toMatchObject({ source: 'template', rejected: 'advice' })
    expect(reply.explanation).not.toMatch(/Pay in 4|smarter/)
  })
})
