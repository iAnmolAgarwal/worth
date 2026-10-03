import { describe, expect, it } from 'vitest'
import { dateLabel, readTiming } from '../server/dates.ts'

const TODAY = '2026-10-03' // a Saturday
const PAYDAY = '2026-10-15'
const read = (text: string, income: string | undefined = PAYDAY) => readTiming(text, TODAY, income)

describe('timing in the user’s words', () => {
  it('finds no timing when none is stated', () => {
    for (const text of [
      'Can I afford a $1,199 camera?',
      'When can I afford a $1,199 camera?',
      'Should I skip rent to buy this?',
      'By the way, can I buy it?',
    ])
      expect(read(text)).toMatchObject({ phrases: [], candidates: null, blocking: null })
  })

  it.each([
    ['today', ['2026-10-03']],
    ['tonight', ['2026-10-03']],
    ['tomorrow', ['2026-10-04']],
    ['the day after tomorrow', ['2026-10-05']],
    ['in 3 days', ['2026-10-06']],
    ['in two weeks', ['2026-10-17']],
    ['on 2026-10-16', ['2026-10-16']],
    ['on Oct 16', ['2026-10-16']],
    ['on October 16th', ['2026-10-16']],
    ['on 16 October', ['2026-10-16']],
    ['on 10/16', ['2026-10-16']],
    ['on the 16th', ['2026-10-16']],
    ['on Friday', ['2026-10-09']],
    ['next Friday', ['2026-10-09', '2026-10-16']],
    ['on payday', ['2026-10-15']],
    ['after my next paycheck', ['2026-10-16']],
  ])('resolves %s', (text, dates) => {
    const timing = read(`Can I buy it ${text}?`)
    expect(timing.candidates).toEqual(dates)
    expect(timing.blocking).toBeNull()
  })

  it('keeps fuzzy phrases as a set with their conventional reading', () => {
    expect(read('at the end of the month')).toMatchObject({
      candidates: ['2026-10-31', '2026-10-30', '2026-10-29'],
      preferred: '2026-10-31',
    })
    expect(read('next week')).toMatchObject({ preferred: '2026-10-10' })
    expect(read('after the weekend')).toMatchObject({ preferred: '2026-10-05' })
    expect(read('before Friday').candidates).toEqual([
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
    ])
    expect(read('next Friday').preferred).toBeUndefined()
  })

  it.each([
    ['sometime next month', 'vague'],
    ['later', 'vague'],
    ['yesterday', 'past'],
    ['last week', 'past'],
    ['on 2026-02-31', 'invalid'],
  ])('asks rather than guessing for %s', (text, blocking) => {
    expect(read(`Can I buy it ${text}?`).blocking).toBe(blocking)
  })

  it('needs a confirmed payday before reading payday phrases', () => {
    expect(readTiming('on payday', TODAY).blocking).toBe('payday_missing')
  })

  it('flags conflicting or unrecognised timing for Claude or the user to resolve', () => {
    expect(read('on 2026-10-10 or tomorrow')).toMatchObject({ candidates: [], unresolved: true })
    expect(read('before rent is due')).toMatchObject({ candidates: null, unresolved: true })
  })

  it('echoes dates in plain language', () => {
    expect(dateLabel('2026-10-03', TODAY)).toBe('today')
    expect(dateLabel('2026-10-04', TODAY)).toBe('tomorrow')
    expect(dateLabel('2026-10-16', TODAY)).toBe('Fri, Oct 16')
  })
})
