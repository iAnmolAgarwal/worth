import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { replayClient, runProbe, summarize } from '../eval/harness.ts'
import type { ProbeResult, Recorded } from '../eval/harness.ts'
import { EVAL_TODAY, PROBES } from '../eval/probes.ts'

// Fixture mode of the AI eval: recorded model responses are replayed through the real
// server pipeline (validation, engine, fact catalogs, chip filter), so a change to any
// of them is graded against real model behaviour without calling the API.

interface Fixture {
  model: string
  today: string
  probes: Record<string, { messages: string[]; turns: Recorded[][] }>
}
const fixture = JSON.parse(
  readFileSync(new URL('../eval/fixtures/recorded.json', import.meta.url), 'utf8'),
) as Fixture
const TWO_DAYS = '2026-10-05'
const recorded = Object.fromEntries(
  Object.entries(fixture.probes).map(([id, probe]) => [id, probe.turns]),
)

describe('AI eval regression gate (recorded model responses)', () => {
  let results: ProbeResult[] = []

  it('has a recording for every probe, made on the pinned persona date', async () => {
    expect(fixture.today).toBe(EVAL_TODAY)
    expect(Object.keys(fixture.probes).sort()).toEqual(PROBES.map((p) => p.id).sort())
    results = []
    for (const probe of PROBES) results.push(await runProbe(probe, replayClient(recorded)))
    // Follow-ups built from Claude's own chips must replay to the same message.
    for (const result of results)
      expect(result.turns.map((t) => t.message)).toEqual(fixture.probes[result.id]!.messages)
  })

  it.each(['train', 'test'] as const)('has no unsafe outcome or contradiction (%s)', (split) => {
    const scoped = results.filter((r) => r.split === split)
    const failures = scoped.flatMap((r) =>
      r.turns.flatMap((t, i) =>
        [...t.grade.unsafe, ...t.grade.contradictions].map((issue) => `${r.id}#${i}: ${issue}`),
      ),
    )
    expect(failures).toEqual([])
    expect(summarize(scoped).replies).toBeGreaterThan(5)
  })

  it('shows Claude’s choice of engine facts on at least 80% of answers that have facts', () => {
    const summary = summarize(results)
    expect(summary.withFacts).toBeGreaterThan(15)
    expect(summary.selectionRate).toBeGreaterThanOrEqual(0.8)
  })

  it('keeps the required interpretation cases (§9 case 19)', () => {
    const reply = (id: string, turn = 0) => results.find((r) => r.id === id)!.turns[turn]!.reply
    expect([150000, undefined]).toContain(reply('X2-k-shorthand').assessment?.amountCents)
    expect([119900, undefined]).toContain(reply('X1-budget-vs-price').assessment?.amountCents)
    expect([55000, undefined]).toContain(reply('P3-two-items').assessment?.amountCents)
    for (const id of ['N2-euros-word', 'N3-yen', 'P5-euro-symbol'])
      expect(reply(id).assessment).toBeUndefined()
    expect([undefined, '2026-10-29', '2026-10-30', '2026-10-31']).toContain(
      reply('N4-end-of-month').assessment?.purchaseDate,
    )
    expect(reply('P8-poem-trivia').intent).toBe('off_topic')
    for (const id of ['R5-swiss-francs', 'R6-euro-and-dollar', 'R8-lens-instead'])
      expect(reply(id).assessment).toBeUndefined()
    expect([TWO_DAYS, undefined]).toContain(reply('R1-days-from-now').assessment?.purchaseDate)
    expect([EVAL_TODAY, undefined]).toContain(reply('R3-past-reference').assessment?.purchaseDate)
  })

  it('routes every request for something cheaper to find_alternatives (G-C3-2)', () => {
    const cheaper = results.filter((r) => /^C[1-8]-(?!categorize)/.test(r.id))
    expect(cheaper.map((r) => r.id)).toHaveLength(8)
    for (const result of cheaper) {
      const reply = result.turns[0]!.reply
      expect(reply.toolCalls, result.id).toContain('find_alternatives')
      expect(reply.intent, result.id).toBe('alternatives')
      expect(reply.assessment, result.id).toBeUndefined()
    }
    // Evals never re-read prices, so recorded rows arrive without a price or link.
    const listed = cheaper.filter((r) => r.turns[0]!.reply.alternatives)
    expect(listed.length).toBeGreaterThanOrEqual(4)
    for (const result of listed) {
      const shown = result.turns[0]!.reply.alternatives!
      expect(shown.maxPriceCents).toBeLessThanOrEqual(44001)
      expect(JSON.stringify(shown.unverified ?? [])).not.toMatch(/priceCents|"url"/)
    }
  })

  it('never searches other stores when "cheaper" is about paying, timing, options or a service', () => {
    const negatives = results.filter((r) => r.id.startsWith('NC'))
    expect(negatives).toHaveLength(4)
    for (const result of negatives) {
      const reply = result.turns[0]!.reply
      expect(reply.intent, result.id).not.toBe('alternatives')
      expect(reply.toolCalls, result.id).not.toContain('find_alternatives')
      expect(reply.alternatives, result.id).toBeUndefined()
    }
  })
})
