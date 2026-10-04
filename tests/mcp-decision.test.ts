import { describe, expect, it } from 'vitest'
import { addDays, assessPurchase, money } from '../shared/finance.ts'
import { createDemoState } from '../shared/seed.ts'
import type { FinancialProfile } from '../shared/types.ts'
import { checkDecision, decide } from '../server/mcpDecision.ts'
import type { Decision } from '../server/mcpDecision.ts'
import { verdictFor } from '../server/narration.ts'

// The check_affordability decision contract: a mapping of Worth's assessment, with its invariants
// checked in code (after the "Buy or Wait?" coherence gate).

const TODAY = '2026-10-03'
const persona = createDemoState(TODAY, 'America/New_York').profile
const AMOUNTS = [1, 2500, 12900, 34900, 44001, 44900, 119900, 249900, 1_000_000]
const DAYS = [0, 1, 5, 13, 14, 20, 30]

function profiles(): [string, FinancialProfile][] {
  return [
    ['sample persona', persona],
    ['richer', { ...persona, balanceCents: 400000 }],
    ['near the cushion', { ...persona, balanceCents: 40000 }],
    ['no income', { ...persona, flows: persona.flows.filter((f) => f.kind !== 'income') }],
  ]
}

describe('the decision contract over Worth’s engine', () => {
  it('holds every invariant for every plan, amount and date in the window', () => {
    const seen = new Set<string>()
    for (const [, profile] of profiles())
      for (const amountCents of AMOUNTS)
        for (const day of DAYS) {
          const purchaseDate = addDays(TODAY, day)
          const a = assessPurchase(profile, [], {
            amountCents,
            itemName: 'Item',
            today: TODAY,
            purchaseDate,
          })
          const outcome = decide(a)
          if (!outcome.ok) {
            // Only the documented refusal: an earlier day than the one asked about fits.
            expect(outcome.code).toBe('EARLIER_DAY_FITS')
            expect(outcome.earliest! < purchaseDate).toBe(true)
            continue
          }
          const d = outcome.decision
          seen.add(`${d.status}/${d.action}`)
          expect(checkDecision(d, addDays(TODAY, 30), verdictFor(a))).toEqual([])
          expect(d.safeCents).toBeGreaterThanOrEqual(0)
          expect(d.safeCents).toBeLessThanOrEqual(amountCents)
          expect(d.safeCents).toBe(Math.min(a.maxAffordableCents, amountCents))
          if (d.status === 'affordable_now') {
            expect(d.earliest).toBe(purchaseDate)
            expect(d.plan).toEqual([{ date: purchaseDate, amountCents }])
          }
          if (d.status === 'affordable_later') expect(d.earliest).toBe(a.earliestDate)
          if (d.status === 'not_affordable') {
            expect(d.earliest).toBeNull()
            expect(d.plan).toEqual([])
          }
        }
    // The sweep reaches every status and action the contract can produce.
    expect([...seen].sort()).toEqual([
      'affordable_later/wait',
      'affordable_now/full_payment',
      'not_affordable/not_recommended',
      'not_affordable/spend_less',
    ])
  })

  it('fails closed on an incomplete plan instead of guessing', () => {
    const a = assessPurchase({ ...persona, confirmed: false }, [], {
      amountCents: 1000,
      today: TODAY,
    })
    expect(a.outcome).toBe('incomplete')
    expect(decide(a)).toEqual({ ok: false, code: 'PLAN_INCOMPLETE' })
  })
})

describe('the coherence gate', () => {
  const good: Decision = {
    requestDate: TODAY,
    requestedCents: 10000,
    status: 'affordable_now',
    action: 'full_payment',
    safeCents: 10000,
    earliest: TODAY,
    plan: [{ date: TODAY, amountCents: 10000 }],
    lowestCents: 90000,
    lowestDate: TODAY,
    cushionCents: 30000,
  }
  const end = addDays(TODAY, 30)
  const text = `Item at ${money(10000)} fits your plan.`
  const problems = (change: Partial<Decision>, explanation = text) =>
    checkDecision({ ...good, ...change }, end, explanation)

  it('passes a coherent decision', () => {
    expect(problems({})).toEqual([])
  })

  it('catches each broken invariant', () => {
    expect(problems({ safeCents: 10001 })).toContainEqual(expect.stringMatching(/^amount:/))
    expect(problems({ safeCents: -1 })).toContainEqual(expect.stringMatching(/^amount:/))
    expect(problems({ action: 'wait' })).toContainEqual(expect.stringMatching(/^status\/action:/))
    expect(problems({ earliest: addDays(TODAY, 2) })).toContainEqual(
      expect.stringMatching(/^status\/earliest:/),
    )
    expect(problems({ lowestCents: 100 })).toContainEqual(expect.stringMatching(/^status\/lowest:/))
    expect(problems({ plan: [{ date: TODAY, amountCents: 5000 }] })).toContainEqual(
      expect.stringMatching(/^plan:/),
    )
    expect(
      problems({
        plan: [
          { date: addDays(TODAY, 2), amountCents: 5000 },
          { date: TODAY, amountCents: 5000 },
        ],
      }),
    ).toContainEqual('plan: payments are not in date order')
    expect(problems({ status: 'affordable_maybe' as never })).toContainEqual(
      expect.stringMatching(/^enum:/),
    )
    expect(problems({}, 'Item fits your plan.')).toContainEqual(
      expect.stringMatching(/^explanation:/),
    )
    const later: Partial<Decision> = {
      status: 'affordable_later',
      action: 'wait',
      safeCents: 4000,
      lowestCents: 100,
      earliest: addDays(TODAY, 5),
      plan: [{ date: addDays(TODAY, 5), amountCents: 10000 }],
    }
    expect(problems(later)).toEqual([])
    expect(
      problems({ ...later, earliest: TODAY, plan: [{ date: TODAY, amountCents: 10000 }] }),
    ).toContainEqual(expect.stringMatching(/^status\/earliest:/))
    expect(problems({ ...later, earliest: addDays(TODAY, 31) })).toContainEqual(
      expect.stringMatching(/^earliest:/),
    )
    const none: Partial<Decision> = {
      status: 'not_affordable',
      action: 'spend_less',
      safeCents: 4000,
      lowestCents: 100,
      earliest: null,
      plan: [],
    }
    expect(problems(none)).toEqual([])
    expect(problems({ ...none, safeCents: 0 })).toContainEqual(
      'status/action: spend_less exactly when some amount is safe',
    )
    expect(problems({ ...none, action: 'not_recommended' })).toContainEqual(
      'status/action: spend_less exactly when some amount is safe',
    )
    expect(problems({ ...none, plan: [{ date: TODAY, amountCents: 10000 }] })).toContainEqual(
      'status/plan: not_affordable has no payment plan',
    )
  })
})
