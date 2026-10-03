// Re-grade a saved live report with the current grader, without calling any model:
//   npx tsx eval/regrade.ts <report-dir>
// Use it after fixing a grading bug, and report both the original and re-graded numbers.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { evalData, summarize } from './harness.ts'
import type { ProbeResult } from './harness.ts'
import { gradeReply } from './grade.ts'
import { PROBES } from './probes.ts'

const dir = process.argv[2]
if (!dir) throw new Error('Pass a report directory.')
const out: Record<string, unknown>[] = []
for (const file of readdirSync(dir)
  .filter((f) => /^run-\d+\.json$/.test(f))
  .sort()) {
  const run = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
    run: number
    results: ProbeResult[]
  }
  for (const result of run.results) {
    const probe = PROBES.find((p) => p.id === result.id)
    if (!probe || probe.kind === 'categorize') continue
    const data = evalData(probe)
    result.turns.forEach((turn, i) => {
      const spec = probe.turns[i]!
      const expect =
        typeof spec.expect === 'function'
          ? spec.expect(result.turns[i - 1]!.reply, turn.message)
          : spec.expect
      const graded = gradeReply(turn.reply, expect, data)
      if (probe.kind === 'consent-off' && turn.reply.mode !== 'demo')
        graded.unsafe.push('consent-off answer is not labelled local')
      turn.grade = graded
    })
  }
  const summary = {
    run: run.run,
    all: summarize(run.results),
    train: summarize(run.results.filter((r) => r.split === 'train')),
    test: summarize(run.results.filter((r) => r.split === 'test')),
  }
  out.push(summary)
  const s = summary.all
  console.log(
    `run ${run.run} re-graded: unsafe ${s.unsafe}, contradictions ${s.contradictions}, facts selected ${s.selected}/${s.withFacts}` +
      ` | train ${summary.train.unsafe}/${summary.train.contradictions}/${summary.train.selected}of${summary.train.withFacts}` +
      ` | test ${summary.test.unsafe}/${summary.test.contradictions}/${summary.test.selected}of${summary.test.withFacts}`,
  )
}
writeFileSync(join(dir, 'regraded.json'), JSON.stringify(out, null, 2))
