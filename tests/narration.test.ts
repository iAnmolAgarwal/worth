import { describe, expect, it } from 'vitest'
import { checkProse, contradiction, riskyAdvice } from '../server/narration.ts'

const values = {
  item: 'camera',
  price: '$1,199',
  low_point: '$651.52',
  low_date: 'Thu, Oct 15',
  cushion: '$1,000',
  fits_on: 'Fri, Oct 16',
  max_price: '$850.52',
  next_bill: 'Apartment rent',
  next_bill_date: 'Thu, Oct 8',
}

describe('placeholder narration', () => {
  it('fills engine placeholders and keeps Claude’s wording', () => {
    expect(
      checkProse(
        'Rent on {{next_bill_date}} lands before your paycheck, so waiting until {{fits_on}} keeps your cushion intact.',
        values,
        'tight',
      ),
    ).toEqual({
      ok: true,
      text: 'Rent on Thu, Oct 8 lands before your paycheck, so waiting until Fri, Oct 16 keeps your cushion intact.',
    })
  })

  it('keeps the natural explanations the old word filter discarded', () => {
    for (const text of [
      'Buying it today would pull your balance under your chosen cushion before your next paycheck arrives, so waiting or looking at a lower-priced camera would protect that cushion.',
      "Rent is a confirmed obligation, so I wouldn't plan around skipping it; a better route is waiting until after your next paycheck lands.",
      'Your biggest upcoming cost is rent, so it is worth checking that the recorded bills and subscriptions are still accurate.',
      'The price is in euros, and your plan works only in US dollars.',
    ])
      expect(checkProse(text, values, 'tight').ok).toBe(true)
  })

  it.each([
    ['Buying it would drop you to $651 on Oct 15.', 'raw figure'],
    ['You would have nine hundred dollars left.', 'spelled-out figure'],
    ['That leaves about fifty bucks.', 'spelled-out figure'],
    ['Wait two weeks and check again.', 'spelled-out figure'],
    ['Your spending will fall by twenty percent.', 'spelled-out figure'],
    ['Rent clears on Friday.', 'raw calendar date'],
    ['The next bill arrives in November.', 'raw calendar date'],
    ['Your low point is {{low_points}}.', 'unavailable placeholder low_points'],
    ['Your low point is {low_point}.', 'malformed placeholder'],
  ])('rejects figures outside placeholders: %s', (text, reason) => {
    expect(checkProse(text, values, 'tight')).toEqual({ ok: false, reason })
  })

  it('rejects a placeholder the engine did not provide for this answer', () => {
    const { fits_on: _fits, ...noFit } = values
    expect(checkProse('Waiting until {{fits_on}} helps.', noFit, 'tight').ok).toBe(false)
  })
})

describe('risky advice guard', () => {
  it.each([
    "Don't skip rent to make room for this.",
    'I would never delay a bill to buy something.',
    'Rather than skipping rent, wait until payday.',
    'Skipping rent is risky and could bring late fees.',
    "I wouldn't use credit or a loan to make this fit.",
    'Keep your cushion intact instead of dipping into it.',
    'Delay buying until after rent clears.',
  ])('allows negated or warning advice: %s', (text) => {
    expect(riskyAdvice(text)).toBe(false)
  })

  it.each([
    'You could skip rent to buy it.',
    'Skip rent this month and buy the camera.',
    'Rent can wait until after your paycheck.',
    'Pay your internet bill late this month.',
    'Consider lowering your cushion a little.',
    'You could dip into your emergency fund.',
    'Using a credit card would make it fit.',
    'Buy now, pay later could spread the cost.',
    'A loan could close the gap.',
    'Instead of buying now, you could delay rent.',
  ])('rejects advice to skip bills, spend the cushion or borrow: %s', (text) => {
    expect(riskyAdvice(text)).toBe(true)
  })
})

describe('contradiction with the engine outcome', () => {
  it('rejects a positive verdict the engine did not produce', () => {
    expect(contradiction('You can probably cover it.', 'tight')).toBeDefined()
    expect(contradiction('It fits, with room to spare.', 'tight')).toBeDefined()
    expect(contradiction('You can afford it.', undefined)).toBeDefined()
    expect(contradiction('This looks fine.', 'incomplete')).toBeDefined()
  })

  it('allows conditional statements about waiting or a lower price', () => {
    expect(contradiction('It fits on {{fits_on}}.', 'tight')).toBeUndefined()
    expect(
      contradiction('Waiting until {{fits_on}} keeps your cushion intact.', 'tight'),
    ).toBeUndefined()
    expect(contradiction('A lower price would stay above your cushion.', 'tight')).toBeUndefined()
  })

  it('rejects a negative verdict for a fitting purchase, except the stress case', () => {
    expect(contradiction('This would dip below your cushion.', 'fits')).toBeDefined()
    expect(contradiction("You can't afford this.", 'fits')).toBeDefined()
    expect(
      contradiction(
        'If spending runs higher, the balance could dip below your cushion.',
        'fits',
        true,
      ),
    ).toBeUndefined()
    expect(contradiction('Your low point stays above your cushion.', 'fits')).toBeUndefined()
  })

  it('always rejects approval and guarantees', () => {
    expect(checkProse('Go ahead and buy it.', values, 'fits').ok).toBe(false)
    expect(checkProse('This is guaranteed to work out.', values, 'fits').ok).toBe(false)
  })
})
