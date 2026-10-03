import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronDown,
  CircleHelp,
  Leaf,
  Plus,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import type {
  AppState,
  Assessment,
  ChatMessage,
  ChatReply,
  Product,
  PurchaseContext,
} from '../shared/types'
import { addDays } from '../shared/finance'
import { api, ApiError } from './api'
import { CLAUDE_SHARED_DATA } from './copy'
import { cx, fromMoney, money, shortDate } from './format'
import { Button, Field, Tag } from './ui'
import { ForecastChart } from './ForecastChart'

type Entry = ChatMessage & { reply?: ChatReply; id: number }
export function Assistant({
  state,
  initialPrompt,
  onPlan,
  onProduct,
  onSessionChange,
  onUpdate,
  visible,
}: {
  state: AppState
  initialPrompt?: { text: string; id: number }
  onPlan: () => void
  onProduct: (p: Product) => void
  onSessionChange?: () => void
  onUpdate?: (state: AppState) => void
  visible: boolean
}) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [custom, setCustom] = useState(false)
  const [consentBusy, setConsentBusy] = useState(false)
  const [consentError, setConsentError] = useState('')
  const [item, setItem] = useState('My next good thing')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(state.today)
  const [context, setContext] = useState<PurchaseContext>()
  const lastPrompt = useRef<number>(0)
  const inFlight = useRef(false)
  const bottom = useRef<HTMLDivElement>(null)
  const latestAnswer = useRef<HTMLDivElement>(null)
  const entriesRef = useRef(entries)
  const contextRef = useRef(context)
  useEffect(() => {
    entriesRef.current = entries
  }, [entries])
  useEffect(() => {
    contextRef.current = context
  }, [context])
  async function changeConsent(aiConsent: boolean) {
    setConsentBusy(true)
    setConsentError('')
    try {
      onUpdate?.(await api<AppState>('/consent', { aiConsent }))
    } catch (e) {
      setConsentError((e as Error).message)
    } finally {
      setConsentBusy(false)
    }
  }
  const send = useCallback(
    async (text: string, explicitContext?: typeof context) => {
      if (inFlight.current || !text.trim()) return
      inFlight.current = true
      setBusy(true)
      setError('')
      setMessage('')
      const history = entriesRef.current
        .slice(-12)
        .map(({ role, content }) => ({ role, content: content.slice(0, 4000) }))
      setEntries((prev) => [...prev, { role: 'user', content: text, id: Date.now() }])
      try {
        const reply = await api<ChatReply>('/chat', {
          message: text,
          sessionKey: state.sessionKey,
          history,
          context: explicitContext ?? contextRef.current,
        })
        setEntries((prev) => [
          ...prev,
          { role: 'assistant', content: reply.message, reply, id: Date.now() },
        ])
        if (reply.assessment)
          setContext({
            amountCents: reply.assessment.amountCents,
            itemName: reply.assessment.itemName,
            purchaseDate: reply.assessment.purchaseDate,
          })
      } catch (e) {
        if (e instanceof ApiError && e.code === 'SESSION_CHANGED') {
          setEntries([])
          setContext(undefined)
          setMessage('')
          setError('Your session changed. Start a new question with the current plan.')
          onSessionChange?.()
        } else {
          setError((e as Error).message)
          setMessage(text)
        }
      } finally {
        inFlight.current = false
        setBusy(false)
      }
    },
    [state.sessionKey, onSessionChange],
  )
  useEffect(() => {
    if (initialPrompt && lastPrompt.current !== initialPrompt.id && !inFlight.current) {
      lastPrompt.current = initialPrompt.id
      void send(initialPrompt.text)
    }
  }, [initialPrompt, busy, send])
  useEffect(() => {
    if (entries.length && visible)
      (busy ? bottom.current : (latestAnswer.current ?? bottom.current))?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
        block: busy ? 'end' : 'start',
      })
  }, [entries.length, busy, visible])
  async function scenario(
    assessment: Assessment,
    purchaseDate: string,
    amountCents = assessment.amountCents,
  ) {
    await send(`Check ${assessment.itemName} at ${money(amountCents, true)} on ${purchaseDate}.`, {
      amountCents,
      itemName: assessment.itemName,
      purchaseDate,
    })
  }
  const suggestions = entries.at(-1)?.reply?.suggestions ?? [
    'Can I afford a $1,199 camera?',
    'What subscriptions are coming up?',
    'How much can I afford to spend today?',
  ]
  return (
    <div className="assistant-page page-enter">
      <div className="assistant-heading">
        <div>
          <h1>Ask Worth.</h1>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            setEntries([])
            setContext(undefined)
            setError('')
          }}
          disabled={busy || entries.length === 0}
        >
          <Plus size={15} /> New conversation
        </Button>
      </div>
      <div className="assistant-layout">
        <section className="conversation" aria-label="Conversation with Worth">
          {entries.length === 0 && (
            <div className="chat-welcome">
              <span className="worth-orb">
                <Sparkles size={30} strokeWidth={1.4} />
              </span>
              <h2>
                “Can I afford it?”
                <br />
                <span className="serif-accent">Let’s look beyond the balance.</span>
              </h2>
              <p>A purchase check that leaves room for your bills and your life.</p>
              <div className="starter-cards">
                <button onClick={() => send('Can I afford a $1,199 camera?')}>
                  <strong>Can I afford a $1,199 camera?</strong>
                  <ArrowUpRight size={19} />
                </button>
                <button onClick={() => send('What subscriptions are coming up?')}>
                  <strong>What’s coming up?</strong>
                  <ArrowUpRight size={19} />
                </button>
              </div>
            </div>
          )}
          <div className="messages" aria-live="polite" aria-relevant="additions">
            {entries.map((entry) => (
              <div
                key={entry.id}
                ref={
                  entry.role === 'assistant' && entry.id === entries.at(-1)?.id
                    ? latestAnswer
                    : undefined
                }
                className={cx('message', entry.role === 'user' ? 'user-message' : 'worth-message')}
              >
                {entry.role === 'assistant' && (
                  <span className="message-avatar">
                    <Sparkles size={15} />
                  </span>
                )}
                <div className="message-body">
                  {entry.role === 'assistant' && (
                    <div className="message-label">
                      Worth{' '}
                      <span>
                        {entry.reply?.mode === 'anthropic' ? 'AI + your plan' : 'Local calculation'}
                      </span>
                    </div>
                  )}
                  <div className="message-text">
                    {(entry.reply?.assessment && entry.reply.verdict
                      ? [entry.reply.verdict]
                      : entry.content.split('\n\n')
                    ).map((paragraph, i) => (
                      <p key={i}>{paragraph}</p>
                    ))}
                    {entry.reply?.assessment && entry.reply.explanation && (
                      <p className="claude-explanation">{entry.reply.explanation}</p>
                    )}
                  </div>
                  {entry.reply?.assessment && (
                    <AssessmentCard
                      assessment={entry.reply.assessment}
                      chartsVisible={visible}
                      recheckDate={state.today}
                      stale={
                        entry.reply.assessment.profileVersion !== state.profile.version ||
                        entry.reply.assessment.today !== state.today
                      }
                      onPlan={onPlan}
                      onScenario={(date, amount) =>
                        scenario(entry.reply!.assessment!, date, amount)
                      }
                      disabled={busy}
                    />
                  )}{' '}
                  {!!entry.reply?.toolCalls.length && (
                    <div className="tool-evidence">
                      <ShieldCheck size={12} />
                      <span>
                        Checked{' '}
                        {Array.from(new Set(entry.reply.toolCalls))
                          .map(
                            (t) =>
                              (
                                ({
                                  interpret_purchase: 'purchase forecast',
                                  list_commitments: 'upcoming bills',
                                  spending_summary: 'spending patterns',
                                }) as Record<string, string>
                              )[t] ?? 'your plan',
                          )
                          .join(' · ')}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          {busy && (
            <div className="thinking" role="status">
              <span className="message-avatar">
                <Sparkles size={15} />
              </span>
              <span>Looking at the whole picture</span>
              <span className="thinking-dots">
                <i />
                <i />
                <i />
              </span>
            </div>
          )}
          {error && (
            <p className="error-text" role="alert">
              {error} Your question is ready to retry below.
            </p>
          )}
          {entries.length > 0 && !busy && (
            <div className="suggestion-row">
              {suggestions.map((s) => (
                <button key={s} onClick={() => send(s)}>
                  {s}
                  <ArrowUpRight size={12} />
                </button>
              ))}
            </div>
          )}
          <div ref={bottom} />
          <div className="composer-wrap">
            <form
              className="chat-composer"
              onSubmit={(e) => {
                e.preventDefault()
                void send(message)
              }}
            >
              <textarea
                rows={1}
                aria-label="Message Worth"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send(message)
                  }
                }}
                maxLength={2000}
                placeholder="What do you have your eye on?"
              />
              <button type="submit" aria-label="Send message" disabled={busy || !message.trim()}>
                <ArrowUpRight size={22} />
              </button>
            </form>
            <div className="composer-caption">
              <span>
                <ShieldCheck size={12} /> Based on your plan.
              </span>
              <button onClick={() => setCustom(!custom)}>
                {custom ? 'Hide' : 'Check'} an exact price <ChevronDown size={13} />
              </button>
            </div>
            {custom && (
              <form
                className="exact-price-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  const cents = fromMoney(amount)
                  if (!Number.isSafeInteger(cents) || cents <= 0) {
                    setError('Enter a total price greater than zero.')
                    return
                  }
                  void send(`Can I afford ${item} for ${money(cents, true)} on ${date}?`, {
                    amountCents: cents,
                    itemName: item,
                    purchaseDate: date,
                  })
                  setCustom(false)
                }}
              >
                <Field label="Item">
                  <input
                    required
                    maxLength={100}
                    value={item}
                    onChange={(e) => setItem(e.target.value)}
                  />
                </Field>
                <Field label="Total USD price" hint="Include tax and shipping">
                  <input
                    required
                    type="number"
                    step="0.01"
                    min="0.01"
                    max="1000000"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="900.00"
                  />
                </Field>
                <Field label="Purchase date">
                  <input
                    type="date"
                    required
                    min={state.today}
                    max={addDays(state.today, 30)}
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </Field>
                <Button disabled={busy}>
                  Check my plan <ArrowRight size={15} />
                </Button>
              </form>
            )}
          </div>
        </section>
        <aside className="context-rail">
          <div className="panel context-card">
            <div className="context-title">
              <span className="context-avatar">{state.profile.name.slice(0, 1)}</span>
              <div>
                <strong>
                  {state.profile.name === 'Your plan'
                    ? 'Your plan'
                    : `${state.profile.name}’s plan`}
                </strong>
                <small>
                  {state.profile.source === 'demo'
                    ? 'Synthetic demo persona'
                    : 'Imported history + your inputs'}
                </small>
              </div>
            </div>
            <dl>
              <div>
                <dt>Available funds</dt>
                <dd>{money(state.profile.balanceCents)}</dd>
              </div>
              <div>
                <dt>Protected cushion</dt>
                <dd>{money(state.profile.cushionCents)}</dd>
              </div>
              <div>
                <dt>Everyday spending</dt>
                <dd>{money(state.profile.dailySpendCents)}/day</dd>
              </div>
              <div>
                <dt>History coverage</dt>
                <dd>{state.profile.coverageDays} days</dd>
              </div>
            </dl>
            <Button variant="secondary" onClick={onPlan}>
              Edit financial picture <ArrowUpRight size={14} />
            </Button>
            {state.profile.source === 'demo' && state.profile.userEdited === false ? (
              <p className="context-footnote">
                Synthetic persona. When Claude is connected, it receives {CLAUDE_SHARED_DATA}.
              </p>
            ) : (
              <label className="check-row context-consent">
                <input
                  type="checkbox"
                  checked={state.profile.aiConsent}
                  disabled={consentBusy}
                  onChange={(event) => void changeConsent(event.target.checked)}
                />
                <span>
                  <strong>Share with Claude</strong>
                  <small>
                    Sends {CLAUDE_SHARED_DATA} to Anthropic. Off: answers use local calculations.
                  </small>
                </span>
              </label>
            )}
            {consentError && (
              <p className="error-text" role="alert">
                {consentError}
              </p>
            )}
          </div>
          <button className="mini-product" onClick={() => onProduct(state.products[1]!)}>
            <img src={state.products[1]?.image} alt="Everyday camera" />
            <div>
              <strong>Everyday camera</strong>
              <span>
                Check the fit <ArrowUpRight size={12} />
              </span>
            </div>
          </button>
        </aside>
      </div>
    </div>
  )
}

export function AssessmentCard({
  assessment: a,
  onPlan,
  onScenario,
  disabled = false,
  stale = false,
  compact = false,
  chartsVisible = true,
  recheckDate,
}: {
  assessment: Assessment
  onPlan: () => void
  onScenario?: (date: string, amount?: number) => void
  disabled?: boolean
  stale?: boolean
  compact?: boolean
  chartsVisible?: boolean
  recheckDate?: string
}) {
  const [details, setDetails] = useState(false)
  const [stress, setStress] = useState(false)
  const positive = a.outcome === 'fits'
  const missing = a.outcome === 'incomplete'
  return (
    <section
      className={cx(
        'assessment-card',
        positive ? 'assessment-fits' : 'assessment-tight',
        compact && 'assessment-compact',
      )}
      aria-label="Purchase assessment"
    >
      <div className="assessment-top">
        <span className="result-icon">
          {positive ? <Check size={22} /> : missing ? <CircleHelp size={22} /> : <Leaf size={22} />}
        </span>
        <div>
          <span className="eyebrow">
            {stale
              ? 'EARLIER RESULT · PLAN HAS CHANGED'
              : `BUYING ${a.purchaseDate === a.today ? 'TODAY' : shortDate(a.purchaseDate).toUpperCase()}`}
          </span>
          <h3>
            {missing
              ? 'Your plan needs a few details.'
              : positive
                ? 'This fits your plan.'
                : a.earliestDate && a.earliestDate > a.purchaseDate
                  ? 'A better fit later.'
                  : 'This would cross your cushion.'}
          </h3>
          <p>
            {missing
              ? 'Confirm the missing details before relying on this estimate.'
              : positive
                ? 'Your cushion stays intact in the base scenario.'
                : 'This purchase would dip below your cushion.'}
          </p>
        </div>
        <Tag tone={positive ? 'green' : 'amber'}>{money(a.amountCents, true)}</Tag>
      </div>
      {stale && (
        <div className="notice notice-warning">
          This result uses an earlier plan.{' '}
          <button
            className="inline-link"
            disabled={disabled}
            onClick={() => onScenario?.(recheckDate ?? a.today)}
          >
            Check again
          </button>
        </div>
      )}
      {missing ? (
        <div className="missing-details">
          <ul>
            {a.missingFields.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <Button onClick={onPlan}>
            Complete my picture <ArrowRight size={15} />
          </Button>
        </div>
      ) : (
        <>
          <div className="assessment-numbers">
            <div>
              <span>Projected low point</span>
              <strong>{money(a.lowestBalanceCents, true)}</strong>
              <small>{shortDate(a.lowestDate)}</small>
            </div>
            <div>
              <span>Your protected cushion</span>
              <strong>{money(a.cushionCents)}</strong>
            </div>
            <div>
              <span>{a.headroomCents >= 0 ? 'Breathing room' : 'Below your cushion'}</span>
              <strong className={a.headroomCents < 0 ? 'amount-warning' : ''}>
                {money(Math.abs(a.headroomCents), true)}
              </strong>
            </div>
          </div>
          <div className="assessment-chart-heading">
            <span className="eyebrow">
              DAILY LOW BALANCE · THROUGH {shortDate(a.horizonEnd).toUpperCase()}
            </span>
            <button
              className={cx('stress-toggle', stress && 'selected')}
              aria-pressed={stress}
              onClick={() => setStress(!stress)}
            >
              +20% spending
            </button>
          </div>
          {chartsVisible && <ForecastChart assessment={a} compact={compact} showStress={stress} />}
          <div className="chart-legends">
            <span>
              <i className="legend-dashed" /> Without purchase
            </span>
            <span>
              <i /> With purchase
            </span>
            {stress && (
              <span>
                <i className="legend-stress" /> Spending +20%
              </span>
            )}
          </div>
          <p className="stress-note">
            <ShieldCheck size={14} />
            {a.stressLowestCents >= a.cushionCents
              ? `Even with everyday spending 20% higher, the low point stays at ${money(a.stressLowestCents, true)}.`
              : `With everyday spending 20% higher, the low point falls to ${money(a.stressLowestCents, true)}—below your cushion.`}
          </p>
          {onScenario && !positive && (
            <div className="scenario-options">
              {a.earliestDate && a.earliestDate > a.purchaseDate ? (
                <button disabled={disabled} onClick={() => onScenario(a.earliestDate!)}>
                  <CalendarDays size={18} />
                  <div>
                    <strong>Try {shortDate(a.earliestDate)}</strong>
                    <span>First date that fits this plan</span>
                  </div>
                  <ArrowUpRight size={18} />
                </button>
              ) : (
                <div className="no-date">
                  No fitting date found within the next 30 days under this plan.
                </div>
              )}
              {a.maxAffordableCents > 0 && (
                <button
                  disabled={disabled}
                  onClick={() => onScenario(a.purchaseDate, a.maxAffordableCents)}
                >
                  <Leaf size={18} />
                  <div>
                    <strong>Try a {money(a.maxAffordableCents, true)} budget</strong>
                    <span>
                      Maximum base-case total{' '}
                      {a.purchaseDate === a.today ? 'today' : `on ${shortDate(a.purchaseDate)}`}
                    </span>
                  </div>
                  <ArrowUpRight size={18} />
                </button>
              )}
            </div>
          )}
        </>
      )}
      <button
        className="evidence-toggle"
        onClick={() => setDetails(!details)}
        aria-expanded={details}
      >
        <span>
          <CircleHelp size={14} /> What went into this?
        </span>
        <ChevronDown size={15} className={details ? 'rotate' : ''} />
      </button>
      {details && (
        <div className="assessment-evidence">
          <p>{a.explanation}</p>
          {a.drivers.length > 0 && (
            <>
              <h4>Scheduled commitments in view</h4>
              {a.drivers.map((d, i) => (
                <div className="evidence-row" key={`${d.name}-${d.date}-${i}`}>
                  <span>
                    {d.name}
                    <small>{shortDate(d.date)}</small>
                  </span>
                  <strong>
                    {d.kind === 'income' ? '+' : '−'}
                    {money(d.amountCents, true)}
                  </strong>
                </div>
              ))}
            </>
          )}
          <h4>Assumptions</h4>
          <ul>
            {a.assumptions.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <button className="text-link" onClick={onPlan}>
            Edit your inputs <ArrowUpRight size={14} />
          </button>
        </div>
      )}
    </section>
  )
}
