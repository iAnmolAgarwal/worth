// Live AI eval: runs the probes against the real model and writes a JSON and markdown
// report outside the repository. Not part of CI.
//
//   npm run eval:live -- --out <dir> --env <path/to/.env> [--runs 3] [--judge]
//                        [--record] [--split train|test] [--probes id,id] [--label name]
//
// --record writes the first run's model responses to eval/fixtures/recorded.json for the
// fixture-mode regression test. The API key is read from the env file and never printed.
import Anthropic from '@anthropic-ai/sdk'
import { config } from 'dotenv'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { MODEL, recordingClient, runProbe, summarize } from './harness.ts'
import type { ProbeResult, Recorded, Summary } from './harness.ts'
import { flips, judge, judgedContradiction, judgeItems, JUDGE_MODEL } from './judge.ts'
import type { Claims } from './judge.ts'
import { EVAL_TODAY, PROBES } from './probes.ts'

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    env: { type: 'string' },
    runs: { type: 'string', default: '3' },
    judge: { type: 'boolean', default: false },
    record: { type: 'boolean', default: false },
    split: { type: 'string' },
    probes: { type: 'string' },
    label: { type: 'string', default: 'live' },
    concurrency: { type: 'string', default: '3' },
  },
})
if (!values.out) throw new Error('Pass --out <directory> for the report (outside the repo).')
if (values.env) config({ path: values.env, quiet: true })
if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set.')
if ((process.env.ANTHROPIC_MODEL || MODEL) !== MODEL)
  throw new Error(`The eval targets ${MODEL}; ANTHROPIC_MODEL is set to something else.`)

const client = new Anthropic({ maxRetries: 0 })
const selected = PROBES.filter(
  (p) =>
    (!values.split || p.split === values.split) &&
    (!values.probes || values.probes.split(',').includes(p.id)),
)
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = join(values.out, `${values.label}-${stamp}`)
mkdirSync(outDir, { recursive: true })

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await fn(items[index]!)
      }
    }),
  )
  return results
}

// claude-sonnet-5-5 list prices per token (USD): input, output, cache read, cache write (5 min).
const PRICE = { input: 2e-6, output: 10e-6, read: 0.2e-6, write: 2.5e-6 }
const cost = (s: Summary) =>
  s.plumbing.inputTokens * PRICE.input +
  s.plumbing.outputTokens * PRICE.output +
  s.plumbing.cacheReadTokens * PRICE.read +
  s.plumbing.cacheWriteTokens * PRICE.write

interface RunReport {
  run: number
  results: ProbeResult[]
  all: Summary
  train: Summary
  test: Summary
  judge?: {
    first: Claims[]
    second: Claims[]
    flips: { id: string; claim: string }[]
    contradictions: string[]
    advice: string[]
  }
}

const runs: RunReport[] = []
for (let run = 1; run <= Number(values.runs); run++) {
  const results = await pool(selected, Number(values.concurrency), (probe) =>
    runProbe(probe, recordingClient(client)),
  )
  const report: RunReport = {
    run,
    results,
    all: summarize(results),
    train: summarize(results.filter((r) => r.split === 'train')),
    test: summarize(results.filter((r) => r.split === 'test')),
  }
  if (values.judge) {
    const items = judgeItems(results)
    const [first, second] = [await judge(client, items), await judge(client, items)]
    const byId = new Map(items.map((i) => [i.id, i]))
    report.judge = {
      first,
      second,
      flips: flips(first, second),
      contradictions: first.filter((c) => judgedContradiction(byId.get(c.id)!, c)).map((c) => c.id),
      advice: first
        .filter(
          (c) =>
            c.recommends_skipping_or_delaying_a_bill ||
            c.recommends_credit_or_instalments ||
            c.recommends_using_the_cushion,
        )
        .map((c) => c.id),
    }
  }
  runs.push(report)
  writeFileSync(join(outDir, `run-${run}.json`), JSON.stringify(report, null, 2))
  console.log(
    `run ${run}: unsafe ${report.all.unsafe}, contradictions ${report.all.contradictions}` +
      `${report.judge ? ` (judge ${report.judge.contradictions.length}, flips ${report.judge.flips.length})` : ''}` +
      `, explained ${report.all.explained}/${report.all.onTopic}, requests ${report.all.plumbing.requests}` +
      `, timeouts ${report.all.plumbing.timeouts}, api errors ${report.all.plumbing.apiErrors}`,
  )
}

if (values.record && runs[0]) {
  const fixture = {
    model: MODEL,
    today: EVAL_TODAY,
    recordedAt: new Date().toISOString(),
    probes: Object.fromEntries(
      runs[0].results.map((r) => [
        r.id,
        {
          messages: r.turns.map((t) => t.message),
          turns: r.turns.map((t) => t.responses) as Recorded[][],
        },
      ]),
    ),
  }
  const path = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'recorded.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(fixture, null, 1) + '\n')
  console.log(`recorded fixtures for ${runs[0].results.length} probes`)
}

const pct = (n: number) => `${Math.round(n * 100)}%`
const row = (label: string, s: Summary, judged?: RunReport['judge']) =>
  `| ${label} | ${s.replies} | ${s.unsafe} | ${s.contradictions}${judged ? ` / ${judged.contradictions.length}` : ''} | ${s.explained}/${s.onTopic} (${pct(s.explanationRate)}) | ${s.misses} | ${s.plumbing.requests} | ${s.plumbing.timeouts} | ${s.plumbing.apiErrors} | ${s.plumbing.cutoffs} | ${s.plumbing.refusals} | ${s.plumbing.retries} | ${s.plumbing.failedOver} | ${s.plumbing.meanMs}/${s.plumbing.maxMs} | $${cost(s).toFixed(3)} |`
const lines = [
  `# Worth AI eval (${values.label})`,
  '',
  `Model under test: \`${MODEL}\`. Judge: ${values.judge ? `\`${JUDGE_MODEL}\`, two passes per run` : 'not run'}. Persona date: ${EVAL_TODAY}. Probes: ${selected.length} (${selected.filter((p) => p.split === 'train').length} train, ${selected.filter((p) => p.split === 'test').length} held-out test). Generated ${new Date().toISOString()}.`,
  '',
  'Contradictions are programmatic / judge. Explanation rate counts on-topic answers answered by Claude. Latency is mean/max ms per answer.',
  '',
  '| Run · split | Replies | Unsafe | Contradictions | Explained | Misses | Requests | Timeouts | API errors | Cut-offs | Refusals | Retries | Fell back | Latency | Cost |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...runs.flatMap((r) => [
    row(`${r.run} · all`, r.all, r.judge),
    row(`${r.run} · train`, r.train),
    row(`${r.run} · test`, r.test),
  ]),
  '',
]
if (values.judge)
  lines.push(
    '## Judge stability',
    '',
    ...runs.map(
      (r) =>
        `- Run ${r.run}: ${r.judge!.first.length} explanations judged twice; ${r.judge!.flips.length} claim flips${r.judge!.flips.length ? `: ${r.judge!.flips.map((f) => `${f.id} ${f.claim}`).join(', ')}` : ''}. Judged contradictions: ${r.judge!.contradictions.join(', ') || 'none'}. Judged risky advice: ${r.judge!.advice.join(', ') || 'none'}.`,
    ),
    '',
  )
lines.push('## Findings', '')
for (const r of runs)
  for (const result of r.results)
    for (const [i, t] of result.turns.entries()) {
      const issues = [
        ...t.grade.unsafe.map((u) => `UNSAFE ${u}`),
        ...t.grade.contradictions.map((c) => `CONTRADICTION ${c}`),
        ...t.grade.misses.map((m) => `miss: ${m}`),
        ...t.plumbing.rejectedExplanations.map((x) => `explanation rejected: ${x}`),
        ...(t.plumbing.failedOver ? ['fell back to local'] : []),
      ]
      if (issues.length)
        lines.push(`- Run ${r.run} ${result.id}#${i} (${result.split}): ${issues.join('; ')}`)
    }
lines.push('', '## Answers (run 1)', '')
for (const result of runs[0]?.results ?? [])
  for (const [i, t] of result.turns.entries()) {
    const read = t.reply.interpretation
    lines.push(
      `### ${result.id}#${i} (${result.split}, ${result.covers})`,
      '',
      `> ${t.message}`,
      '',
      `- Intent: ${t.reply.intent}; mode ${t.reply.mode}; tools: ${t.reply.toolCalls.join(', ') || 'none'}`,
      ...(read
        ? [
            `- Read as: ${read.items.map((x) => `${x.quantity > 1 ? `${x.quantity} × ` : ''}${x.name} ${x.amountCents}`).join(' + ')} · ${read.date} (${read.dateSource}, ${read.source})`,
          ]
        : []),
      ...(t.reply.verdict ? [`- Verdict: ${t.reply.verdict}`] : []),
      `- Explanation: ${t.reply.explanation ?? '(none)'}`,
      ...(t.reply.verdict ? [] : [`- Message: ${t.reply.message.replace(/\n+/g, ' ')}`]),
      `- Suggestions: ${t.reply.suggestions.join(' | ')}`,
      '',
    )
  }
writeFileSync(join(outDir, 'summary.md'), lines.join('\n'))
writeFileSync(
  join(outDir, 'summary.json'),
  JSON.stringify(
    runs.map((r) => ({
      run: r.run,
      all: r.all,
      train: r.train,
      test: r.test,
      judge: r.judge && {
        flips: r.judge.flips,
        contradictions: r.judge.contradictions,
        advice: r.judge.advice,
      },
      cost: cost(r.all),
    })),
    null,
    2,
  ),
)
console.log(`report: ${outDir}`)
