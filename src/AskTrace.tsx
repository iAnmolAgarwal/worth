import { useId, useState } from 'react'
import {
  ArrowRight,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleX,
  ListChecks,
} from 'lucide-react'
import {
  collisionLine,
  mainCollision,
  nearPhrase,
  PAY_IN_4_DATES_NOTE,
  PAY_IN_4_SPACING,
} from '../shared/collision'
import type { AnswerTrace, FactReason, PayIn4Chat } from '../shared/types'
import { capitalize, cx, dayLabel, money } from './format'
import { Alert, Ring } from './ui'

/** "4 payments of $299.75" or "4 payments from $2.50". */
function payments(p4: PayIn4Chat) {
  const amounts = new Set(p4.payments.map((p) => p.amountCents))
  return `4 payments ${amounts.size > 1 ? 'from' : 'of'} ${money(p4.payments.at(-1)!.amountCents)}`
}

/**
 * The illustrative Pay in 4 schedule inside an answer that asked about it, in the comparison's
 * ring style. Every date after the first is "about": PayPal sets the exact ones.
 */
export function PayIn4Strip({
  p4,
  today,
  onCompare,
}: {
  p4: PayIn4Chat
  today: string
  onCompare?: () => void
}) {
  if (!p4.payments.length)
    return (
      <p className="meta">
        {p4.label}. Worth shows Pay in 4 only for comparison and never recommends it.
      </p>
    )
  return (
    <section className="tile p4-strip" aria-label="PayPal Pay in 4, illustrative schedule">
      <div className="h-section">PayPal Pay in 4 · illustrative</div>
      <p className="meta" style={{ marginTop: 4 }}>
        {payments(p4)}, {PAY_IN_4_SPACING}. Same {money(p4.totalCents)} total; PayPal charges no
        interest.
      </p>
      <div className="sched" role="list" aria-label="Illustrative Pay in 4 payments">
        {p4.payments.map((item) => (
          <div
            role="listitem"
            key={item.number}
            className={cx('inst', item.belowCushion && 'flag')}
            aria-label={`Payment ${item.number} of 4${item.belowCushion ? ', below your cushion' : ''}`}
          >
            <div className="top">
              <Ring part={item.number} />
              <div>
                <div className="amt num">{money(item.amountCents)}</div>
                <div className="when">
                  {item.date === today ? 'Today' : `About ${dayLabel(item.date)}`}
                </div>
              </div>
            </div>
            <div className="near">
              {item.nearestBill
                ? capitalize(
                    nearPhrase(
                      item.nearestBill.daysFromInstalment,
                      item.nearestBill.name,
                      item.nearestBill.kind,
                    ),
                  )
                : 'No bill within about 3 days'}
            </div>
          </div>
        ))}
      </div>
      <p className="meta strong" style={{ marginTop: 'var(--s-3)' }}>
        {p4.label}.
      </p>
      {p4.stacking && (
        <div style={{ marginTop: 'var(--s-3)' }}>
          <Alert tone="warn" icon={CircleAlert}>
            {p4.stacking.message}
          </Alert>
        </div>
      )}
      <p className="caption" style={{ marginTop: 'var(--s-3)' }}>
        {PAY_IN_4_DATES_NOTE} PayPal sets the exact dates at checkout. Shown for comparison only;
        Worth never recommends it.
        {p4.eligibility === 'range-only' ? ' PayPal decides availability at checkout.' : ''}
      </p>
      {onCompare && (
        <button type="button" className="link" onClick={onCompare} style={{ marginTop: 4 }}>
          Compare all options <ArrowRight size={16} aria-hidden="true" />
        </button>
      )}
    </section>
  )
}

/** The one neutral Pay in 4 row in a purchase answer that didn't ask about it (judge #7). */
export function PayIn4Row({ p4, onCompare }: { p4: PayIn4Chat; onCompare?: () => void }) {
  const main = mainCollision(p4.payments)
  return (
    <p className="meta p4-row">
      PayPal Pay in 4: {main ? `${collisionLine(main)}` : `${payments(p4)}, ${PAY_IN_4_SPACING}`}
      {onCompare && (
        <>
          {' · '}
          <button type="button" className="link inline" onClick={onCompare}>
            Compare
          </button>
        </>
      )}
    </p>
  )
}

const FACT_LABELS: Record<string, string> = {
  low_point: 'Your low point',
  cause: 'What drives it',
  income: 'Your next income',
  wait: 'When it would fit',
  spend_less: 'The most that fits',
  stress: 'If spending runs higher',
  bills_before: 'Bills before the low point',
  pay_in_4: 'Pay in 4 availability',
  pay_in_4_schedule: 'Pay in 4 schedule',
  pay_in_4_stacking: 'Plans already running',
  room_today: 'Room to spend today',
  total: 'Total',
  next: 'Next one due',
  largest: 'Largest one',
  other_total: 'The other kind',
  top_category: 'Largest category',
  daily_average: 'Daily average',
}
const REASON_LABELS: Record<FactReason, string> = {
  answers_question: 'answers what you asked',
  explains_result: 'explains the result',
  shows_timing: 'shows timing',
  shows_risk: 'shows a risk',
  adds_context: 'adds context',
}
const TOOL_OUTCOMES: Record<AnswerTrace['tools'][number]['outcome'], string> = {
  ran: 'ran',
  corrected: 'sent back to Claude to correct',
  refused: 'refused by Worth’s server',
  asked: 'Worth asked you instead',
}
const REJECTED: Record<string, string> = {
  no_sentence: 'Claude didn’t write one',
  length: 'it was too long or too short',
  not_one_sentence: 'it was more than one sentence',
  unknown_placeholder: 'it used a value Worth didn’t offer',
  free_number: 'it wrote a number itself',
  free_date: 'it wrote a date itself',
  advice: 'it gave advice Worth doesn’t give',
  contradicts_result: 'it disagreed with the engine’s result',
}

function readSource(read: NonNullable<AnswerTrace['read']>) {
  if (read.source === 'catalog') return `${read.store ?? 'Store'} price`
  if (read.source === 'earlier') return 'earlier in this chat'
  return 'your words'
}
function dateRead(date: NonNullable<AnswerTrace['date']>) {
  if (date.source === 'stated' && date.phrase) return `“${date.phrase}” → ${date.label}`
  if (date.source === 'context') return `Kept from earlier in this chat → ${date.label}`
  if (date.source === 'stated') return date.label
  return `No timing words → ${date.label}`
}

/**
 * "How Ask Worth read this": what was read and from where, which tool ran, the facts Claude picked
 * and why, every server check, and where the sentence under the verdict came from (judge #5).
 */
export function TraceDetails({ trace, answeredBy }: { trace: AnswerTrace; answeredBy: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className="trace-box" data-open={open}>
      <button
        type="button"
        className="trace trace-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <ListChecks className="ico" aria-hidden="true" />
        How Ask Worth read this
        <ChevronDown className="ico chev" aria-hidden="true" />
      </button>
      <span className="caption trace-by">{answeredBy}</span>
      <dl className="kvlist stacked" id={id} hidden={!open}>
        {trace.read && (
          <div>
            <dt>Read as</dt>
            <dd>
              {trace.read.item} · {money(trace.read.amountCents)}{' '}
              <span className="soft">({readSource(trace.read)})</span>
            </dd>
          </div>
        )}
        {trace.date && (
          <div>
            <dt>When</dt>
            <dd>{dateRead(trace.date)}</dd>
          </div>
        )}
        <div>
          <dt>Tool</dt>
          <dd>
            {trace.tools.length ? (
              <ul>
                {trace.tools.map((tool, index) => (
                  <li key={index}>
                    <code>{tool.name}</code> · {TOOL_OUTCOMES[tool.outcome]}
                  </li>
                ))}
              </ul>
            ) : trace.reader === 'claude' ? (
              'None: Claude answered without a tool'
            ) : (
              'None: Worth’s own rules read this, without Claude'
            )}
          </dd>
        </div>
        {trace.facts.length > 0 && (
          <div>
            <dt>Facts Claude picked</dt>
            <dd>
              <ul>
                {trace.facts.map((fact) => (
                  <li key={fact.id}>
                    {FACT_LABELS[fact.id] ?? fact.id}
                    {fact.reason ? ` · ${REASON_LABELS[fact.reason]}` : ''}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {trace.guards.length > 0 && (
          <div>
            <dt>Server checks</dt>
            <dd>
              <ul className="checks">
                {trace.guards.map((guard) => (
                  <li key={guard.id} className={guard.passed ? 'ok' : 'stop'}>
                    {guard.passed ? (
                      <CircleCheck className="ico" aria-label="Passed" />
                    ) : (
                      <CircleX className="ico" aria-label="Stopped here" />
                    )}
                    {guard.label}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {trace.sentence && (
          <div>
            <dt>Sentence under the answer</dt>
            <dd>
              {trace.sentence.source === 'claude' ? (
                <>
                  Claude wrote <span className="raw">“{trace.sentence.raw}”</span>; Worth checked it
                  and filled in its own values.
                </>
              ) : (
                <>
                  Worth’s template
                  {trace.sentence.rejected
                    ? `, because Claude’s sentence wasn’t used: ${REJECTED[trace.sentence.rejected] ?? 'it failed a check'}`
                    : ''}
                  .
                </>
              )}
            </dd>
          </div>
        )}
      </dl>
    </div>
  )
}
