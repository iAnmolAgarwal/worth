import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  ArrowUp,
  CircleAlert,
  ExternalLink,
  ListChecks,
  Sparkles,
  TriangleAlert,
} from 'lucide-react'
import { addDays } from '../shared/finance'
import type {
  ChatMessage,
  Interpretation,
  OptionResult,
  Product,
  PurchaseContext,
} from '../shared/types'
import { api, ApiError } from './api'
import type { AgentCheckout, AppState, ChatReply, Comparison } from './contract'
import { claudeUses } from './copy'
import { breachLine, optionStatus, type DecisionRequest, type Explanation } from './Decision'
import { claudeOn, envLabel, fits, missingFix, useComparison } from './engine'
import { capitalize, cx, fromMoney, money } from './format'
import { Alert, Button, Field, Pill, ReadAsChip, Toggle } from './ui'

type Entry = ChatMessage & { reply?: ChatReply; id: number }

export const ASK_STARTERS = [
  'Can I afford a $1,199 camera?',
  'How much can I spend today?',
  'What bills are coming up?',
]

export function itemLabel(read: Interpretation) {
  return capitalize(
    read.items
      .map((item) => (item.quantity > 1 ? `${item.quantity} × ${item.name}` : item.name))
      .join(' + '),
  )
}
export const readAsText = (read: Interpretation) =>
  `${itemLabel(read)} · ${money(read.amountCents)} · ${read.dateLabel}`

/** A catalog item the question is about: same price and a shared word in the name. */
export function matchProduct(products: Product[], name: string, amountCents: number) {
  const words = new Set(name.toLowerCase().match(/[a-z]{4,}/g) ?? [])
  const priced = products.filter((product) => product.priceCents === amountCents)
  return (
    priced.find((product) =>
      (product.name.toLowerCase().match(/[a-z]{4,}/g) ?? []).some((word) => words.has(word)),
    ) ?? (priced.length === 1 ? priced[0] : undefined)
  )
}

/** Claude on for this profile: the server's rule, read from state. */
export const claudeAllowed = claudeOn

const TOOL_TRACE: Record<string, string> = {
  interpret_purchase: 'Claude read your question and checked it against your plan',
  list_commitments: 'Claude looked up your upcoming bills',
  spending_summary: 'Claude summed up your recent spending',
  get_plan_summary: 'Claude read your plan totals',
  prepare_checkout: 'Claude prepared a PayPal checkout',
}
function traceText(reply: ChatReply, state: AppState) {
  if (reply.mode !== 'anthropic')
    return claudeAllowed(state)
      ? 'Worth’s own calculation · Claude unavailable for this answer'
      : 'Worth’s own calculation · Claude off'
  const tools = [...new Set(reply.toolCalls)].map(
    (tool) => TOOL_TRACE[tool] ?? 'Claude used your plan',
  )
  return [...new Set(tools)].join(' · ') || 'Claude answered from your plan'
}

/** The answer's own text; the facts Claude picked are shown separately. */
function paragraphs(reply: ChatReply) {
  const chosen =
    reply.points && [reply.lead, ...reply.points.map((p) => p.text)].filter(Boolean).join(' ')
  return reply.message.split('\n\n').filter((paragraph) => paragraph !== chosen)
}

const status = (option: OptionResult) => {
  const { tone, text } = optionStatus(option)
  return [tone, text] as const
}

function OptionRows({ c }: { c: Comparison }) {
  const rows = [
    {
      key: 'buyToday',
      title: 'Buy today',
      sub: fits(c.buyToday)
        ? `${money(c.buyToday.headroomCents)} above cushion at lowest`
        : (breachLine(c.buyToday, c.cushionCents, true) ?? 'Below your cushion'),
      pill: status(c.buyToday),
    },
    fits(c.buyToday)
      ? {
          key: 'wait',
          title: 'Wait',
          sub: 'Not needed: it fits today',
          pill: ['info', 'Not needed'] as const,
        }
      : c.wait.date
        ? {
            key: 'wait',
            title: `Wait until ${new Date(`${c.wait.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
            sub: `${money(c.wait.headroomCents)} above cushion at lowest${c.wait.stressLowestCents < c.cushionCents ? ' · tight' : ''}`,
            pill: status(c.wait),
          }
        : {
            key: 'wait',
            title: 'Wait',
            sub: 'No date in the next 30 days fits',
            pill: ['info', 'No date'] as const,
          },
    {
      key: 'spendLess',
      title: 'Spend less',
      sub:
        c.spendLess.maxPriceCents > 0
          ? `Up to ${money(c.spendLess.maxPriceCents)} today`
          : 'Nothing fits today',
      pill:
        c.spendLess.maxPriceCents > 0 ? status(c.spendLess) : (['info', 'Nothing fits'] as const),
    },
  ]
  return (
    <div className="rows mini-opts" role="list" aria-label="Your options">
      {rows.map((row) => (
        <div className="row" role="listitem" key={row.key}>
          <div className="body">
            <div className="t">
              {row.title}
              {c.recommendation === row.key && row.pill[0] !== 'info' && (
                <span className="tag-rec">Recommended</span>
              )}
            </div>
            <div className="s">
              <span className="soft">{row.sub}</span>
            </div>
          </div>
          <Pill tone={row.pill[0]}>{row.pill[1]}</Pill>
        </div>
      ))}
    </div>
  )
}

function VerdictTile({
  reply,
  state,
  stale,
  busy,
  onRecheck,
  onOpen,
}: {
  reply: ChatReply
  state: AppState
  stale: boolean
  busy: boolean
  onRecheck: () => void
  onOpen: (request: DecisionRequest) => void
}) {
  const assessment = reply.assessment!
  const amountCents = reply.interpretation?.amountCents ?? assessment.amountCents
  const name = reply.interpretation ? itemLabel(reply.interpretation) : assessment.itemName
  const product = matchProduct(state.products, name, amountCents)
  const request: DecisionRequest = product
    ? { productId: product.id }
    : { amountCents, itemName: name.slice(0, 150) }
  const { comparison } = useComparison(
    assessment.outcome === 'incomplete' ? null : request,
    state.profile.version,
  )
  return (
    <section
      className="tile"
      style={{ width: '100%', padding: 'var(--s-5)' }}
      aria-label="Purchase assessment"
    >
      <p className="verdict">{reply.verdict ?? paragraphs(reply)[0]}</p>
      {stale && (
        <div style={{ marginTop: 12 }}>
          <Alert tone="warn" icon={CircleAlert}>
            This answer uses an earlier plan.{' '}
            <button type="button" className="link" onClick={onRecheck} disabled={busy}>
              Check again
            </button>
          </Alert>
        </div>
      )}
      {comparison ? (
        <OptionRows c={comparison} />
      ) : assessment.outcome !== 'incomplete' ? (
        <div className="stack tight" style={{ marginTop: 16 }} aria-hidden="true">
          <span className="sk" style={{ width: '70%' }} />
          <span className="sk" style={{ width: '50%' }} />
          <span className="sk" style={{ width: '60%' }} />
        </div>
      ) : null}
      {assessment.outcome !== 'incomplete' && (
        <button
          type="button"
          className="link"
          style={{ marginTop: 'var(--s-2)' }}
          onClick={() => onOpen(request)}
        >
          See the comparison <ArrowRight size={16} aria-hidden="true" />
        </button>
      )}
    </section>
  )
}

function AskEdit({
  read,
  today,
  disabled,
  onCancel,
  onSubmit,
}: {
  read: Interpretation
  today: string
  disabled: boolean
  onCancel: () => void
  onSubmit: (context: Required<PurchaseContext>) => void
}) {
  const [item, setItem] = useState(itemLabel(read))
  const [amount, setAmount] = useState((read.amountCents / 100).toFixed(2))
  const [date, setDate] = useState(read.date)
  const [error, setError] = useState('')
  return (
    <form
      className="readas-edit"
      aria-label="Correct how Worth read your question"
      onSubmit={(event) => {
        event.preventDefault()
        const cents = fromMoney(amount)
        if (!item.trim()) return setError('Name the item you want to check.')
        if (!Number.isSafeInteger(cents) || cents <= 0)
          return setError('Enter a total price greater than $0.')
        onSubmit({ amountCents: cents, itemName: item.trim(), purchaseDate: date })
      }}
    >
      <Field label="Item">
        <input
          className="input"
          required
          maxLength={100}
          value={item}
          onChange={(e) => setItem(e.target.value)}
        />
      </Field>
      <Field label="Total USD price" error={error}>
        <span className="money-input">
          <span aria-hidden="true">$</span>
          <input
            className="input num"
            inputMode="decimal"
            value={amount}
            aria-invalid={Boolean(error)}
            onChange={(e) => setAmount(e.target.value)}
          />
        </span>
      </Field>
      <Field label="Purchase date">
        <input
          className="input"
          type="date"
          required
          min={today}
          max={addDays(today, 30)}
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </Field>
      <div className="actions">
        <Button type="submit" disabled={disabled}>
          Check my plan
        </Button>
        <Button variant="text" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function AgentHandoff({
  checkout,
  onOpen,
}: {
  checkout: AgentCheckout
  onOpen: (purchaseId: string, approveUrl: string) => void
}) {
  const [confirmed, setConfirmed] = useState(!checkout.requiresProceedConfirm)
  const [declined, setDeclined] = useState(false)
  if (declined)
    return (
      <p className="meta">
        Not now. The checkout stays open until you cancel it from Home or Activity.
      </p>
    )
  if (!confirmed)
    return (
      <section className="tile" style={{ width: '100%' }} aria-label="Confirm before checkout">
        <Alert tone="bad" icon={TriangleAlert}>
          <b>Buying {checkout.itemName} today takes you below your cushion.</b>
          <br />
          You asked Claude to go ahead anyway. Confirm once more before PayPal opens.
        </Alert>
        <div className="actions" style={{ marginTop: 12 }}>
          <Button onClick={() => setConfirmed(true)}>Yes, continue</Button>
          <Button variant="text" onClick={() => setDeclined(true)}>
            Not now
          </Button>
        </div>
      </section>
    )
  return (
    <section className="tile" style={{ width: '100%' }} aria-label="Checkout prepared by Claude">
      <div className="h-section">
        Checkout ready: {checkout.itemName}, {money(checkout.amountCents)}
      </div>
      <p className="meta" style={{ marginTop: 4 }}>
        Claude prepared this in the PayPal sandbox. You approve in PayPal, then confirm here.
        Nothing is charged until you do.
      </p>
      <div className="actions" style={{ marginTop: 12 }}>
        <Button
          icon={ExternalLink}
          onClick={() => onOpen(checkout.purchaseId, checkout.approveUrl)}
        >
          Open checkout
        </Button>
      </div>
    </section>
  )
}

export function ClaudeSwitch({
  state,
  onUpdate,
  label = 'Use Claude for explanations',
  compact,
}: {
  state: AppState
  onUpdate?: (state: AppState) => void
  label?: string
  compact?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const note =
    state.config.ai !== 'anthropic'
      ? 'Claude isn’t connected here, so answers use Worth’s own calculation.'
      : claudeOn(state)
        ? 'On: Claude explains answers from your plan totals. Every number is Worth’s.'
        : 'Off: answers still work, using Worth’s own calculation.'
  const noteId = `claude-note-${compact ? 'm' : 'd'}`
  async function change(next: boolean) {
    setBusy(true)
    setError('')
    try {
      onUpdate?.((await api<AppState>('/consent', { aiConsent: next })) as AppState)
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const toggle = (
    <Toggle
      checked={claudeAllowed(state)}
      label={label}
      describedBy={noteId}
      busy={busy}
      disabled={state.config.ai !== 'anthropic'}
      onChange={(next) => void change(next)}
    />
  )
  if (compact)
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <span
          className="strong"
          style={{ fontWeight: 600, fontSize: 'var(--fs-meta)' }}
          aria-hidden="true"
        >
          Claude
        </span>
        {toggle}
        <span className="sr" id={noteId}>
          {note}
        </span>
      </span>
    )
  return (
    <>
      <div className="switch-row">
        <span className="strong" style={{ fontWeight: 700 }}>
          Claude explanations
        </span>
        {toggle}
      </div>
      <p className="caption" id={noteId} style={{ marginTop: 4 }}>
        {note}
      </p>
      {error && (
        <p className="co-error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

/** The environment, worded exactly as in the top bar. */
export function JudgeBadge({ state }: { state: AppState }) {
  return (
    <span className={cx('judge', !claudeOn(state) && 'local')}>
      <i aria-hidden="true" />
      {envLabel(state)}
    </span>
  )
}

export function Ask({
  state,
  initialPrompt,
  visible,
  onUpdate,
  onSessionChange,
  onOpenDecision,
  onOpenCheckout,
  onNavigate,
}: {
  state: AppState
  initialPrompt?: { text: string; id: number }
  visible: boolean
  onUpdate?: (state: AppState) => void
  onSessionChange?: () => void
  onOpenDecision: (request: DecisionRequest, explanation?: Explanation) => void
  onOpenCheckout: (purchaseId: string, approveUrl?: string) => void
  onNavigate: (hash: string) => void
}) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<number>()
  const [context, setContext] = useState<PurchaseContext>()
  const lastPrompt = useRef(0)
  const inFlight = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const latest = useRef<HTMLDivElement>(null)
  const entriesRef = useRef(entries)
  const contextRef = useRef(context)
  useEffect(() => {
    entriesRef.current = entries
  }, [entries])
  useEffect(() => {
    contextRef.current = context
  }, [context])

  const send = useCallback(
    async (text: string, explicit?: PurchaseContext) => {
      if (inFlight.current || !text.trim()) return
      inFlight.current = true
      setBusy(true)
      setError('')
      setMessage('')
      setEditing(undefined)
      const history = entriesRef.current
        .slice(-12)
        .map(({ role, content }) => ({ role, content: content.slice(0, 4000) }))
      setEntries((prev) => [...prev, { role: 'user', content: text, id: Date.now() }])
      try {
        const reply = (await api<ChatReply>('/chat', {
          message: text,
          sessionKey: state.sessionKey,
          history,
          context: explicit ?? contextRef.current,
        })) as ChatReply
        setEntries((prev) => [
          ...prev,
          { role: 'assistant', content: reply.message, reply, id: Date.now() + 1 },
        ])
        // The server decides whether a later message is about the same purchase.
        if (reply.interpretation)
          setContext({
            amountCents: reply.interpretation.amountCents,
            itemName: reply.assessment?.itemName ?? itemLabel(reply.interpretation),
            purchaseDate: reply.interpretation.date,
          })
        else if (reply.pending)
          setContext({
            amountCents: reply.pending.amountCents,
            itemName: reply.pending.itemName ?? 'Your purchase',
          })
        else if (reply.assessment)
          setContext({
            amountCents: reply.assessment.amountCents,
            itemName: reply.assessment.itemName,
            purchaseDate: reply.assessment.purchaseDate,
          })
        if (reply.checkout) onUpdate?.((await api<AppState>('/state')) as AppState)
      } catch (failure) {
        if (failure instanceof ApiError && failure.code === 'SESSION_CHANGED') {
          setEntries([])
          setContext(undefined)
          setMessage('')
          setError('Your session changed. Start a new question with your current plan.')
          onSessionChange?.()
        } else {
          setError((failure as Error).message)
          setMessage(text)
        }
      } finally {
        inFlight.current = false
        setBusy(false)
      }
    },
    [state.sessionKey, onSessionChange, onUpdate],
  )
  useEffect(() => {
    if (initialPrompt && lastPrompt.current !== initialPrompt.id && !inFlight.current) {
      lastPrompt.current = initialPrompt.id
      void send(initialPrompt.text)
    }
  }, [initialPrompt, busy, send])
  useEffect(() => {
    if (entries.length && visible)
      (busy ? bottom.current : (latest.current ?? bottom.current))?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
        block: busy ? 'end' : 'start',
      })
  }, [entries.length, busy, visible])

  const lastId = entries.at(-1)?.id
  return (
    <div className="page ask-page">
      <div className="wrap">
        <h1 className="sr">Ask Worth</h1>
        <div className="grid">
          <div>
            <div className="thread" aria-live="polite" aria-relevant="additions">
              {entries.length === 0 && (
                <div className="bot">
                  <div className="bot-head">
                    <span className="bot-av" aria-hidden="true">
                      <Sparkles className="ico" />
                    </span>
                    Worth
                  </div>
                  <p>
                    Ask about something you want to buy. Worth checks it against your money, your
                    bills and the cushion you keep.
                  </p>
                  <div className="chips">
                    {ASK_STARTERS.map((text) => (
                      <button
                        type="button"
                        key={text}
                        className="chip-suggest"
                        onClick={() => void send(text)}
                      >
                        {text}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {entries.map((entry) =>
                entry.role === 'user' ? (
                  <div className="bubble-user" key={entry.id}>
                    {entry.content}
                  </div>
                ) : (
                  <div
                    className="bot enter"
                    key={entry.id}
                    ref={entry.id === lastId ? latest : undefined}
                  >
                    <div className="bot-head">
                      <span className="bot-av" aria-hidden="true">
                        <Sparkles className="ico" />
                      </span>
                      Worth
                    </div>
                    <Answer
                      entry={entry}
                      state={state}
                      busy={busy}
                      last={entry.id === lastId}
                      editing={editing === entry.id}
                      onEdit={() => setEditing(entry.id)}
                      onCancelEdit={() => setEditing(undefined)}
                      onSend={(text, next) => void send(text, next)}
                      onAnswer={() => input.current?.focus()}
                      onOpenDecision={onOpenDecision}
                      onOpenCheckout={onOpenCheckout}
                      onNavigate={onNavigate}
                    />
                  </div>
                ),
              )}
              {busy && (
                <div className="bot" role="status">
                  <div className="bot-head">
                    <span className="bot-av" aria-hidden="true">
                      <Sparkles className="ico" />
                    </span>
                    Worth
                  </div>
                  <div className="tile" style={{ width: '100%' }} aria-hidden="true">
                    <div className="stack tight">
                      <span className="sk" style={{ width: '70%', height: 18 }} />
                      <span className="sk" style={{ width: '45%' }} />
                      <span className="sk" style={{ width: '55%' }} />
                    </div>
                  </div>
                  <p className="caption">Checking your plan…</p>
                </div>
              )}
              {error && (
                <div className="tile" role="alert">
                  <div className="co-head">
                    <span className="co-icon bad" aria-hidden="true">
                      <CircleAlert className="ico" />
                    </span>
                    <div>
                      <h2 className="h-section">Worth couldn’t answer that</h2>
                      <p className="meta">{error} Your question is still in the box.</p>
                    </div>
                  </div>
                  {message.trim() && (
                    <div className="actions" style={{ marginTop: 12 }}>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          const text = message
                          // Drop the unanswered question so the retry doesn't repeat it.
                          setEntries((prev) =>
                            prev.at(-1)?.role === 'user' ? prev.slice(0, -1) : prev,
                          )
                          setTimeout(() => void send(text), 0)
                        }}
                      >
                        Try again
                      </Button>
                    </div>
                  )}
                </div>
              )}
              <div ref={bottom} />
            </div>
            <div className="askdock">
              <form
                className="composer"
                onSubmit={(event) => {
                  event.preventDefault()
                  void send(message)
                }}
              >
                <label className="sr" htmlFor="ask-q">
                  Message Worth
                </label>
                <input
                  id="ask-q"
                  ref={input}
                  value={message}
                  maxLength={2000}
                  placeholder="Ask about a purchase"
                  onChange={(event) => setMessage(event.target.value)}
                />
                <button className="send" type="submit" aria-label="Send" disabled={busy}>
                  <ArrowUp className="ico" strokeWidth={2} aria-hidden="true" />
                </button>
              </form>
              <div className="dock-line">
                <span className="caption hide-m" style={{ color: 'var(--c-text-2)' }}>
                  {claudeOn(state)
                    ? 'Claude sees your plan totals, never your login. '
                    : 'Claude is off. Answers use Worth’s own calculation. '}
                  <a href="#settings" style={{ fontSize: 'inherit' }}>
                    What’s shared
                  </a>
                </span>
                <a className="show-m" href="#settings" style={{ fontSize: 'var(--fs-meta)' }}>
                  What Claude sees
                </a>
                <span className="show-m">
                  <ClaudeSwitch state={state} onUpdate={onUpdate} compact />
                </span>
              </div>
            </div>
          </div>
          <aside className="rail hide-m" aria-label="Claude and suggestions">
            <section aria-labelledby="claude-uses">
              <div className="sec-head">
                <h2 className="h-section" id="claude-uses">
                  What Claude can use
                </h2>
              </div>
              <dl className="kvlist">
                {claudeUses(claudeOn(state)).map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <div style={{ marginTop: 'var(--s-3)' }}>
                <ClaudeSwitch state={state} onUpdate={onUpdate} />
              </div>
              <a href="#settings" style={{ fontSize: 'var(--fs-meta)' }}>
                Everything Claude receives
              </a>
            </section>
            <section aria-labelledby="try-asking">
              <div className="sec-head">
                <h2 className="h-section" id="try-asking">
                  Try asking
                </h2>
                {entries.length > 0 && (
                  <button
                    type="button"
                    className="link"
                    disabled={busy}
                    onClick={() => {
                      setEntries([])
                      setContext(undefined)
                      setError('')
                    }}
                  >
                    Start over
                  </button>
                )}
              </div>
              <div className="chips">
                {ASK_STARTERS.map((text) => (
                  <button
                    type="button"
                    key={text}
                    className="chip-suggest"
                    disabled={busy}
                    onClick={() => void send(text)}
                  >
                    {text}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="link"
                style={{ marginTop: 8, fontSize: 'var(--fs-meta)' }}
                onClick={() => onNavigate('saved')}
              >
                Browse saved items
              </button>
            </section>
          </aside>
        </div>
      </div>
    </div>
  )
}

function Answer({
  entry,
  state,
  busy,
  last,
  editing,
  onEdit,
  onCancelEdit,
  onSend,
  onAnswer,
  onOpenDecision,
  onOpenCheckout,
  onNavigate,
}: {
  entry: Entry
  state: AppState
  busy: boolean
  last: boolean
  editing: boolean
  onEdit: () => void
  onCancelEdit: () => void
  onSend: (text: string, context?: PurchaseContext) => void
  onAnswer: () => void
  onOpenDecision: (request: DecisionRequest, explanation?: Explanation) => void
  onOpenCheckout: (purchaseId: string, approveUrl?: string) => void
  onNavigate: (hash: string) => void
}) {
  const reply = entry.reply!
  // An answer that can't go further says where to fix it instead of dead-ending.
  const unresolved = (state.foreignPayments ?? []).some((payment) => !payment.resolution)
  const blocked =
    reply.assessment?.outcome === 'incomplete' ||
    ((unresolved || !state.profile.confirmed) && !reply.assessment && reply.intent !== 'off_topic')
  const field =
    reply.assessment?.outcome === 'incomplete'
      ? reply.assessment.missingFields[0]
      : unresolved
        ? 'foreign-currency payment'
        : !state.profile.confirmed
          ? 'Review and confirm your financial picture.'
          : undefined
  const fix = blocked && field ? missingFix(field) : undefined
  const read = reply.interpretation
  const assessment = reply.assessment
  const stale =
    Boolean(assessment) &&
    (assessment!.profileVersion !== state.profile.version || assessment!.today !== state.today)
  const explanation: Explanation = {
    lead: reply.lead,
    points: reply.points?.map((point) => point.text) ?? [],
    toolCalls: reply.toolCalls,
    mode: reply.mode,
    readAs: read ? readAsText(read).replace(/ · [^·]+$/, ' · today') : undefined,
  }
  return (
    <>
      {read && !editing && (
        <ReadAsChip value={readAsText(read)} onAction={onEdit} disabled={busy} />
      )}
      {read && editing && (
        <AskEdit
          read={read}
          today={state.today}
          disabled={busy}
          onCancel={onCancelEdit}
          onSubmit={(next) =>
            onSend(
              `What if I buy ${next.itemName} for ${money(next.amountCents)} ${next.purchaseDate === state.today ? 'today' : `on ${new Date(`${next.purchaseDate}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`}?`,
              next,
            )
          }
        />
      )}
      {!read && reply.intent === 'clarify' && (
        <ReadAsChip
          ask
          label="Needs an answer"
          value={reply.pending?.itemName ?? 'Your purchase'}
          action="Answer"
          onAction={onAnswer}
        />
      )}
      {assessment ? (
        <VerdictTile
          reply={reply}
          state={state}
          stale={stale}
          busy={busy}
          onRecheck={() =>
            onSend(`Check ${assessment.itemName} at ${money(assessment.amountCents)} today.`, {
              amountCents: assessment.amountCents,
              itemName: assessment.itemName,
              purchaseDate: state.today,
            })
          }
          onOpen={(request) => onOpenDecision(request, explanation)}
        />
      ) : (
        paragraphs(reply).map((text, index) => <p key={index}>{text}</p>)
      )}
      {!!reply.points?.length && (
        <section className="picked" aria-label="Points picked by Claude">
          <span className="claude">
            <Sparkles className="ico" aria-hidden="true" />
            Picked by Claude for your question
          </span>
          {reply.lead && <p style={{ marginTop: 8 }}>{reply.lead}</p>}
          <ul>
            {reply.points.map((point) => (
              <li key={point.id}>{point.text}</li>
            ))}
          </ul>
        </section>
      )}
      {reply.checkout && <AgentHandoff checkout={reply.checkout} onOpen={onOpenCheckout} />}
      {fix && last && (
        <button type="button" className="link" onClick={() => onNavigate(fix.hash)}>
          {fix.label} <ArrowRight size={16} aria-hidden="true" />
        </button>
      )}
      <div className="trace">
        <ListChecks className="ico" aria-hidden="true" />
        {traceText(reply, state)}
      </div>
      {last && reply.suggestions.length > 0 && (
        <div className="chips">
          {reply.suggestions.map((text) => (
            <button
              type="button"
              key={text}
              className="chip-suggest"
              disabled={busy}
              onClick={() => onSend(text)}
            >
              {text}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
