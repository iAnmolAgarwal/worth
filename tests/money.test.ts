import { describe, expect, it } from 'vitest'
import {
  extractMoneyMentions,
  groundableAmounts,
  hasForeignAmount,
  priceMentions,
  quantityStated,
} from '../server/money.ts'

const read = (text: string) =>
  extractMoneyMentions(text).map(({ cents, currency, role }) => ({ cents, currency, role }))

describe('money mentions in the user’s words', () => {
  it.each([
    ['Can I afford a $1.5k laptop?', 150000],
    ['Can I buy a $2k TV today?', 200000],
    ['Is a $1,199.00 camera ok?', 119900],
    ['Can I buy a camera for 900 USD?', 90000],
    ['Can I buy a camera for USD 900?', 90000],
    ['It is 45 dollars', 4500],
    ['Can I spend 2k on a TV?', 200000],
    ['The camera costs 900. Can I buy it?', 90000],
    ['a $0.5m flat', 50000000],
    ['a 300$ jacket', 30000],
  ])('reads %s as %i cents', (text, cents) => {
    expect(priceMentions(extractMoneyMentions(text)).map((m) => m.cents)).toEqual([cents])
  })

  it('separates a budget from the price being asked about', () => {
    expect(read('My budget is $300 but can I buy a $1,199 camera?')).toEqual([
      { cents: 30000, currency: 'USD', role: 'budget' },
      { cents: 119900, currency: 'USD', role: 'price' },
    ])
    expect(read('I only have $500 to spare. Is a $649 phone ok?')[0]!.role).toBe('budget')
    expect(read('It was $1,399, now $1,199')[0]!.role).toBe('other')
  })

  it.each([
    'Can I afford a bag that costs 500 euros?',
    'Is a watch worth 80000 yen ok to buy?',
    'Can I afford a €500 bag?',
    'Can I buy a CA$500 jacket?',
    'price is ₹45,000',
    'It costs £80',
    'about 300 Canadian dollars',
  ])('never treats a foreign amount as dollars: %s', (text) => {
    const mentions = extractMoneyMentions(text)
    expect(hasForeignAmount(mentions)).toBe(true)
    expect(groundableAmounts(mentions)).toEqual([])
  })

  it.each([
    'Can I buy 2 cameras?',
    'Can I buy it in 3 days?',
    'rent a car for 3 days',
    'Can I buy an iPhone15 case?',
    'What about 10/16?',
  ])('does not read quantities, dates or model numbers as prices: %s', (text) => {
    expect(priceMentions(extractMoneyMentions(text))).toEqual([])
  })

  it('refuses malformed figures instead of guessing', () => {
    expect(extractMoneyMentions('a $1.999 lamp')[0]!.cents).toBeNull()
    expect(extractMoneyMentions('a $11,99 lamp')[0]!.cents).toBeNull()
    expect(extractMoneyMentions('a $2,000,000.00 yacht')[0]!.cents).toBeNull()
  })

  it('checks that a quantity above one was actually stated', () => {
    expect(quantityStated('3 shirts at $40 each', 3)).toBe(true)
    expect(quantityStated('two tickets for $45', 2)).toBe(true)
    expect(quantityStated('a $40 shirt', 3)).toBe(false)
    expect(quantityStated('a $3k laptop', 3)).toBe(false)
  })
})
