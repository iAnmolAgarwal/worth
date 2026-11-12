import { describe, expect, it } from 'vitest'
import { localInterpretation, validateInterpretation } from '../server/interpret.ts'
import type { ChatData, InterpretResult, RawInterpretation } from '../server/interpret.ts'
import { createDemoState } from '../shared/seed.ts'
import type { PurchaseContext } from '../shared/types.ts'

const TODAY = '2026-10-03' // a Saturday; the persona's next paycheck is Oct 15
const seed = createDemoState(TODAY)
const data: ChatData = {
  profile: seed.profile,
  purchases: [],
  transactions: seed.transactions,
  today: TODAY,
}
const camera: PurchaseContext = { amountCents: 119900, itemName: 'camera', purchaseDate: TODAY }

type Item = RawInterpretation['items'][number]
const item = (name: string, amount_cents: number | null, currency = 'USD', quantity = 1): Item => ({
  name,
  amount_cents,
  currency,
  quantity,
})
function raw(
  items: Item[],
  date_phrase: string | null = null,
  date: string | null = null,
  extra: Partial<RawInterpretation> = {},
): RawInterpretation {
  return {
    items,
    combine: items.length > 1 ? 'together' : 'single',
    refers_to_previous_item: false,
    date_phrase,
    date,
    option: 'check',
    ...extra,
  }
}
const check = (message: string, reading: RawInterpretation, context?: PurchaseContext) =>
  validateInterpretation(reading, { message, history: [], ...(context ? { context } : {}) }, data)
const local = (message: string, context?: PurchaseContext) =>
  localInterpretation({ message, history: [], ...(context ? { context } : {}) }, data)
const accepted = (result: InterpretResult) => {
  if (!result.ok) throw new Error(`asked: ${result.reason}`)
  return result.interpretation
}
const asked = (result: InterpretResult) => (result.ok ? 'assessed' : result.reason)

describe('purchase dates (judge regressions)', () => {
  const cam = (phrase: string | null, date: string | null) =>
    raw([item('camera', 119900)], phrase, date)

  it('reads "N days from now" as that day, not as now', () => {
    const message = 'Can I buy a $1,199 camera two days from now?'
    expect(accepted(check(message, cam('two days from now', '2026-10-05'))).date).toBe('2026-10-05')
    expect(accepted(local(message)).date).toBe('2026-10-05')
    // Claude's different reading is put to the user rather than overruled.
    expect(asked(check(message, cam('two days from now', TODAY)))).toBe('date_unresolved')
  })

  it('asks when Claude reports a timing phrase but no date', () => {
    for (const [message, phrase] of [
      ['Can I buy a $1,199 camera two days from now?', 'two days from now'],
      ['Can I buy a $1,199 camera mid-October?', 'mid-October'],
      ['Can I buy a $1,199 camera in a fortnight?', 'in a fortnight'],
      ['Can I buy a $1,199 camera at the end of the week?', 'at the end of the week'],
      ['Can I buy a $1,199 camera for Christmas?', 'for Christmas'],
      ['Can I buy a $1,199 camera tmrw?', 'tmrw'],
    ])
      expect(asked(check(message!, cam(phrase!, null)))).toBe('date_unresolved')
  })

  it('accepts Claude’s reading of a phrase it alone can resolve, inside the window', () => {
    expect(
      accepted(
        check(
          'Can I buy a $1,199 camera a week from Friday?',
          cam('a week from Friday', '2026-10-16'),
        ),
      ).date,
    ).toBe('2026-10-16')
    expect(asked(local('Can I buy a $1,199 camera a week from Friday?'))).toBe('date_unresolved')
    expect(
      asked(
        check('Can I buy a $1,199 camera on Black Friday?', cam('on Black Friday', '2026-11-27')),
      ),
    ).toBe('date_window')
  })

  it('does not turn a past event into a purchase date', () => {
    const message = 'The price dropped last Friday. Can I buy the $1,199 camera?'
    expect(accepted(check(message, cam(null, null)))).toMatchObject({
      date: TODAY,
      dateSource: 'default',
    })
    expect(accepted(local(message)).date).toBe(TODAY)
  })

  it('ignores a reported phrase that is not about time or not in the message', () => {
    const message = 'Can I buy a $1,199 camera?'
    for (const phrase of [' ', 'camera', 'next Friday'])
      expect(accepted(check(message, cam(phrase, '2026-10-20')))).toMatchObject({
        date: TODAY,
        dateSource: 'default',
      })
  })

  it('keeps timing words out of the item name', () => {
    const result = local('Can I buy a $1,199 camera mid-October?')
    expect(asked(result)).toBe('date_unresolved')
    expect(result.ok ? undefined : result.pending?.itemName).toBe('camera')
  })

  it('asks when two days are named', () => {
    const message = 'Can I buy a $1,199 camera on the 15th or 16th?'
    expect(asked(check(message, cam('on the 15th or 16th', '2026-10-16')))).toBe('date_unresolved')
    expect(asked(local(message))).toBe('date_unresolved')
  })

  it('follows a timing-only follow-up about the same item', () => {
    const reading = raw([], 'two days from now', '2026-10-05', { refers_to_previous_item: true })
    expect(accepted(check('What about two days from now?', reading, camera))).toMatchObject({
      amountCents: 119900,
      date: '2026-10-05',
    })
  })
})

describe('amounts and currencies (judge regressions)', () => {
  it.each([
    ['Can I buy a bag that costs 500 Swiss francs?', item('bag', 50000, 'UNKNOWN')],
    ['Can I buy a bag for 500 kr?', item('bag', 50000, '')],
    ['Can I buy a bag for 500 Mexican pesos?', item('bag', 50000, 'USD')],
    ['Can I buy a €500 bag and a $300 lens today?', item('lens', 30000)],
    ['Can I buy a bag for $500 (that is NZ$)?', item('bag', 50000)],
  ])('asks for the US-dollar total: %s', (message, reading) => {
    expect(asked(check(message, raw([reading])))).toBe('currency')
    expect(asked(local(message))).toBe('currency')
  })

  it.each([
    'Can I buy a bag for 500 HK dollars?',
    'Can I buy a bag for 500 Zimbabwe dollars?',
    'Can I buy a bag for $500 Canadian?',
    'Can I buy a bag for 500 bucks Canadian?',
    'Can I buy a bag for 500 dollars (Hong Kong)?',
  ])('asks which dollar when a country sits next to it: %s', (message) => {
    expect(asked(local(message))).toBe('currency')
    expect(asked(check(message, raw([item('bag', 50000)])))).toBe('currency')
  })

  it('still reads plain and US dollars as US dollars', () => {
    for (const message of [
      'Can I buy a bag for 500 dollars?',
      'Can I buy a bag for 500 US dollars?',
    ])
      expect(accepted(local(message)).amountCents).toBe(50000)
    expect(accepted(local('Can I buy a $500 Sony camera?')).amountCents).toBe(50000)
  })

  it('still assesses a dollar price next to money that was only spent abroad', () => {
    const message = 'I spent €500 in Paris. Can I buy a $300 lens?'
    expect(accepted(check(message, raw([item('lens', 30000)]))).amountCents).toBe(30000)
  })

  it('asks about a space-separated or negative amount instead of reading part of it', () => {
    for (const message of ['Can I buy a $1 199 camera?', 'Can I buy a -$50 thing?']) {
      expect(asked(check(message, raw([item('camera', 100)])))).toBe('amount_unclear')
      expect(asked(local(message))).toBe('amount_unclear')
    }
  })

  it('accounts for a repeated amount on a second item', () => {
    const message = 'Can I buy a $1,199 camera and a $1,199 lens?'
    expect(asked(check(message, raw([item('camera', 119900)])))).toBe('items_unclear')
    expect(
      accepted(check(message, raw([item('camera', 119900), item('lens', 119900)]))).amountCents,
    ).toBe(239800)
    expect(asked(local(message))).toBe('items_unclear')
  })

  it('treats a price range as limits, not as two items', () => {
    const message = 'Can I get a camera between $800 and $900?'
    expect(asked(check(message, raw([item('camera', 80000), item('camera', 90000)])))).toBe(
      'items_unclear',
    )
  })

  it('needs an explicit per-item price before multiplying', () => {
    expect(
      asked(
        check(
          'Can I buy a pair of headphones for $349?',
          raw([item('headphones', 34900, 'USD', 2)]),
        ),
      ),
    ).toBe('items_unclear')
    expect(
      asked(check('Can I buy two chairs for $398?', raw([item('chairs', 39800, 'USD', 2)]))),
    ).toBe('items_unclear')
    expect(accepted(local('Can I buy two chairs for $398?')).amountCents).toBe(39800)
    expect(
      accepted(check('Can I buy 3 shirts at $40 each?', raw([item('shirts', 4000, 'USD', 3)])))
        .amountCents,
    ).toBe(12000)
  })
})

describe('follow-ups about another item', () => {
  it('asks for the price of a newly named item instead of reusing the last one', () => {
    const reading = raw([], null, null, { refers_to_previous_item: true })
    expect(asked(check('What about a lens instead?', reading, camera))).toBe('price_missing')
    expect(asked(local('What about a lens instead?', camera))).toBe('price_missing')
    expect(accepted(check('Should I skip rent to buy this?', reading, camera)).amountCents).toBe(
      119900,
    )
  })
})

describe('item names with digits (Halden X5)', () => {
  it('keeps the "5" and uses the catalog name for the catalog item at its price', () => {
    const read = accepted(
      check('Can I afford the $1,899 Halden X5?', raw([item('Halden X5', 189900)])),
    )
    expect(read.items.map((i) => i.name)).toEqual(['Halden X5'])
  })

  it('keeps digits inside a word and drops a bare number from a name it grounds', () => {
    const read = accepted(
      check('Can I afford a $900 Lumen X5 2024 lens?', raw([item('Lumen X5 2024 lens', 90000)])),
    )
    expect(read.items.map((i) => i.name)).toEqual(['Lumen X5 lens'])
  })

  it('reads the local fallback with the 5 too', () => {
    const read = accepted(local('Can I afford the $1,899 Halden X5?'))
    expect(read.items[0]!.name).toBe('Halden X5')
  })
})
