import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { CircleAlert, Download, Info, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { addDays, assessPurchase, getUpcomingFlows, todayInTimezone } from '../shared/finance'
import type {
  Cadence,
  FinancialProfile,
  FlowKind,
  InstalmentPlanProposal,
  ScheduledFlow,
} from '../shared/types'
import { api } from './api'
import { BalanceChart } from './BalanceChart'
import type { AppState } from './contract'
import { isActive } from './contract'
import { DEMO_CLOCK_EDIT, pinnedSample } from './copy'
import { upcomingWithPlans } from './Hero'
import './plan.css'
import { allPlans, cadenceLabel, flowIcon, kindLabel, runningPlans } from './engine'
import { cx, dayLabel, money, signed, displayName } from './format'
import { Alert, Button, DateStepper, Disc, Field, Pill, Ring, Toggle } from './ui'

type FlowDraft = Omit<ScheduledFlow, 'amountCents'> & { amount: string }
const timestamp = () => new Date().toISOString()
/** "1300" → "1,300.00"; anything that isn't an amount is left as typed, for the error to explain. */
const formatAmount = (value: string) => {
  const plain = value.trim().replace(/,/g, '')
  return /^\d+(?:\.\d{0,2})?$/.test(plain)
    ? Number(plain).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : value
}
const dollars = (cents: number) => (cents / 100).toFixed(2)
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.'

function readMoney(value: string, label: string): number {
  const normalized = value.trim().replace(/,/g, '')
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized))
    throw new FieldError(`Enter an amount of $0 or more for ${label.toLowerCase()}.`, label)
  const cents = Math.round(Number(normalized) * 100)
  if (!Number.isSafeInteger(cents) || cents > 100_000_000)
    throw new FieldError(`${label} must be between $0 and $1,000,000.`, label)
  return cents
}
class FieldError extends Error {
  field?: string
  constructor(text: string, field?: string) {
    super(text)
    this.field = field
  }
}

export const STEPS = [
  { label: 'Funds', title: 'How much money do you have right now?' },
  { label: 'Income', title: 'What money is coming in?' },
  { label: 'Bills & subscriptions', title: 'What do you pay regularly?' },
  { label: 'Review', title: 'Check your plan' },
] as const

const CADENCES: [Cadence, string][] = [
  ['weekly', 'Weekly'],
  ['biweekly', 'Every other week'],
  ['monthly', 'Monthly'],
  ['yearly', 'Yearly'],
  ['once', 'One time'],
]

/** The plan setup as a full-page flow: Funds → Income → Bills & subscriptions → Review. */
export function PlanWizard({
  state,
  initialStep = 0,
  suggestedPlans = [],
  onClose,
  onSaved,
}: {
  state: AppState
  initialStep?: number
  /** Pay in 4 plans found in the last import, offered pre-filled. */
  suggestedPlans?: InstalmentPlanProposal[]
  onClose: () => void
  onSaved: (state: AppState) => void
}) {
  const [openedVersion] = useState(state.profile.version)
  const [step, setStep] = useState(Math.min(3, Math.max(0, initialStep)))
  const [name, setName] = useState(state.profile.name)
  const [balance, setBalance] = useState(formatAmount(dollars(state.profile.balanceCents)))
  const [cushion, setCushion] = useState(dollars(state.profile.cushionCents))
  const [dailySpend, setDailySpend] = useState(dollars(state.profile.dailySpendCents))
  const [timezone, setTimezone] = useState(state.profile.timezone)
  const [flows, setFlows] = useState<FlowDraft[]>(() =>
    state.profile.flows.map(({ amountCents, ...flow }) => ({
      ...flow,
      amount: dollars(amountCents),
    })),
  )
  const [editingId, setEditingId] = useState<string | null>(null)
  const [reflectedIds, setReflectedIds] = useState(state.profile.reflectedPurchaseIds)
  // The untouched sample profile uses Claude unless the user turned it off.
  const [aiConsent, setAiConsent] = useState(
    state.profile.aiConsent ||
      (state.profile.source === 'demo' &&
        state.profile.userEdited === false &&
        !state.profile.aiChoiceMade),
  )
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; field?: string }>()
  const [addingPlan, setAddingPlan] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const mutating = useRef(false)
  const completedPurchases = state.purchases.filter((p) => p.status === 'completed')
  const activeCheckout = state.purchases.some(isActive)
  // The demo clock replays the sample plan as it is; the server refuses edits while it runs.
  // Alex's pinned days are fixed, so his plan can be edited there.
  const clockOn = Boolean(state.demoClock) && !pinnedSample(state)
  const locked = busy || activeCheckout || clockOn
  const current = STEPS[step]!
  const snapshotDate = () => {
    if (timezone.trim() === state.profile.timezone) return state.today
    try {
      return todayInTimezone(timezone.trim())
    } catch {
      // A half-typed zone is reported on Continue; until then, today stays as it was.
      return state.today
    }
  }
  const stepFlows = flows.filter((flow) =>
    step === 1
      ? flow.kind === 'income' || (flow.id === editingId && flow.kind !== 'installment')
      : flow.kind !== 'income' && flow.kind !== 'installment',
  )

  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
    window.scrollTo?.({ top: 0 })
  }, [step])

  const changed = () => {
    setConfirmed(false)
    setError(undefined)
  }
  const updateFlow = (id: string, patch: Partial<FlowDraft>, requireReview = true) => {
    changed()
    setFlows((all) =>
      all.map((flow) =>
        flow.id === id
          ? { ...flow, ...patch, ...(requireReview ? { confirmed: false } : {}) }
          : flow,
      ),
    )
  }
  const goTo = (next: number) => {
    setError(undefined)
    setEditingId(null)
    setAddingPlan(false)
    setStep(next)
  }

  function validateFunds() {
    if (!name.trim()) throw new FieldError('Add a name under “Name and time zone”.')
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone.trim() })
    } catch {
      throw new FieldError('Choose a valid time zone under “Name and time zone”.')
    }
    readMoney(balance, 'Money available')
    readMoney(cushion, 'Cushion')
    readMoney(dailySpend, 'Everyday spending')
  }
  function readFlow(flow: FlowDraft, requireConfirmation = true): ScheduledFlow {
    if (!flow.name.trim()) throw new FieldError('Give this item a name, or remove it.')
    const { amount, ...scheduled } = flow
    const amountCents = readMoney(amount, flow.name)
    const date = new Date(`${flow.nextDate}T12:00:00Z`)
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(flow.nextDate) ||
      !Number.isFinite(date.valueOf()) ||
      date.toISOString().slice(0, 10) !== flow.nextDate
    )
      throw new FieldError(`Choose a valid next date for ${flow.name}.`)
    if (flow.active && flow.cadence === 'once' && flow.nextDate < snapshotDate())
      throw new FieldError(
        `${flow.name} is in the past. Update its date or turn it off if it already happened.`,
      )
    if (requireConfirmation && flow.active && !flow.confirmed)
      throw new FieldError(
        `Review and confirm ${flow.name}, or turn it off if it doesn’t belong in your plan.`,
      )
    return { ...scheduled, name: flow.name.trim(), amountCents }
  }
  function validateFlows(items: FlowDraft[]) {
    for (const flow of items)
      try {
        readFlow(flow)
      } catch (failure) {
        if (flow.kind !== 'installment') setEditingId(flow.id)
        throw failure
      }
  }
  function next() {
    setError(undefined)
    try {
      if (step === 0) validateFunds()
      else validateFlows(step === 2 ? flows : stepFlows)
      goTo(step + 1)
    } catch (failure) {
      setError({ text: message(failure), field: (failure as FieldError).field })
    }
  }
  function addFlow() {
    changed()
    const id = crypto.randomUUID()
    setFlows((all) => [
      ...all,
      {
        id,
        name: '',
        amount: '',
        nextDate: snapshotDate(),
        cadence: step === 1 ? 'biweekly' : 'monthly',
        kind: step === 1 ? 'income' : 'bill',
        category: step === 1 ? 'Income' : 'Other',
        active: true,
        confirmed: false,
        origin: 'you',
      },
    ])
    setEditingId(id)
  }
  function confirmFlow(flow: FlowDraft) {
    try {
      readFlow(flow, false)
      updateFlow(flow.id, { confirmed: true }, false)
      setEditingId(null)
    } catch (failure) {
      setEditingId(flow.id)
      setError({ text: message(failure) })
    }
  }
  function finishEditing(flow: FlowDraft) {
    try {
      readFlow(flow, false)
      setError(undefined)
      setEditingId(null)
    } catch (failure) {
      setError({ text: message(failure) })
    }
  }
  function draftProfile(): FinancialProfile {
    return {
      ...state.profile,
      version: openedVersion,
      name: name.trim(),
      balanceCents: readMoney(balance, 'Money available'),
      cushionCents: readMoney(cushion, 'Cushion'),
      dailySpendCents: readMoney(dailySpend, 'Everyday spending'),
      // Everyday spending stays credited to PayPal only while it is the import's own average.
      ...(state.profile.dailySpendOrigin &&
      readMoney(dailySpend, 'Everyday spending') !== state.profile.dailySpendCents
        ? { dailySpendOrigin: 'you' as const }
        : {}),
      timezone: timezone.trim(),
      flows: flows.map((flow) => readFlow(flow)),
      reflectedPurchaseIds: reflectedIds.filter((id) =>
        completedPurchases.some((p) => p.id === id),
      ),
      aiConsent,
      confirmed: true,
      confirmedAt: state.profile.confirmedAt,
      snapshotDate: snapshotDate(),
      missingFields: [],
    }
  }
  async function save() {
    if (mutating.current || step !== 3) return
    setError(undefined)
    if (!confirmed) return setError({ text: 'Confirm your plan below before saving.' })
    if (activeCheckout)
      return setError({ text: 'Finish or cancel your checkout before changing your plan.' })
    if (clockOn) return setError({ text: DEMO_CLOCK_EDIT })
    let saved = false
    try {
      validateFunds()
      const profile = { ...draftProfile(), confirmedAt: timestamp() }
      mutating.current = true
      setBusy(true)
      const updated = (await api<AppState>('/profile', { profile }, 'PATCH')) as AppState
      saved = true
      onSaved(updated)
    } catch (failure) {
      setError({ text: message(failure) })
    } finally {
      if (!saved) {
        mutating.current = false
        setBusy(false)
      }
    }
  }

  const fieldError = (label: string) => (error?.field === label ? error.text : undefined)
  const moneyField = (
    label: string,
    value: string,
    set: (v: string) => void,
    hint: string,
    xl = false,
  ) => (
    <Field label={label} hint={hint} error={fieldError(label)}>
      <span className={cx('money-input', xl && 'xl')}>
        <span aria-hidden="true">$</span>
        {xl ? (
          // The headline amount reads like money ("1,300.00"); digits and commas both work.
          <input
            className="input num"
            type="text"
            inputMode="decimal"
            value={value}
            aria-invalid={Boolean(fieldError(label))}
            disabled={locked}
            onChange={(event) => {
              changed()
              set(event.target.value)
            }}
            onBlur={() => set(formatAmount(value))}
          />
        ) : (
          // A text field with a decimal keypad: screen readers hear the amount as typed, not a
          // floating-point value such as 3.2899999.
          <input
            className="input num"
            type="text"
            inputMode="decimal"
            value={value}
            aria-invalid={Boolean(fieldError(label))}
            disabled={locked}
            onChange={(event) => {
              changed()
              set(event.target.value)
            }}
          />
        )}
      </span>
    </Field>
  )

  return (
    <div className="page plain">
      <div className="wrap narrow">
        <form onSubmit={(event) => event.preventDefault()} aria-busy={busy}>
          <div className="sec-head">
            <span className="meta">
              Step {step + 1} of 4 · {current.label}
            </span>
            <button type="button" className="link" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </div>
          <div
            className="wizard-progress"
            role="progressbar"
            aria-label="Plan setup progress"
            aria-valuemin={1}
            aria-valuemax={4}
            aria-valuenow={step + 1}
            aria-valuetext={`Step ${step + 1} of 4: ${current.label}`}
          >
            {STEPS.map((item, index) => (
              <i key={item.label} className={index <= step ? 'on' : undefined} />
            ))}
          </div>
          <h1
            className="title wizard-step-head"
            ref={heading}
            tabIndex={-1}
            style={{ margin: '24px 0 16px' }}
          >
            {current.title}
          </h1>
          {clockOn && !activeCheckout && (
            <div style={{ marginBottom: 16 }}>
              <Alert tone="info" icon={CircleAlert}>
                {DEMO_CLOCK_EDIT}
              </Alert>
            </div>
          )}
          {activeCheckout && (
            <div style={{ marginBottom: 16 }}>
              <Alert tone="warn" icon={CircleAlert} live>
                Finish or cancel your active checkout before changing your plan.
              </Alert>
            </div>
          )}

          {step === 0 && (
            <div className="stack">
              <div className="stack tight">
                {moneyField(
                  'Money available',
                  balance,
                  setBalance,
                  'Leave out credit limits and savings you won’t touch.',
                  true,
                )}
                <span>
                  <Pill tone="info">As of today, {dayLabel(snapshotDate())}</Pill>
                </span>
              </div>
              <div className="form-grid">
                {moneyField(
                  'Cushion',
                  cushion,
                  setCushion,
                  'The least you want to keep in your account.',
                )}
                {moneyField(
                  'Everyday spending',
                  dailySpend,
                  setDailySpend,
                  '$ a day, not counting bills.',
                )}
              </div>
              <details
                className="tile quiet-details plain-summary"
                style={{ padding: '0 var(--s-4)' }}
              >
                <summary
                  className="strong"
                  style={{ cursor: 'pointer', fontWeight: 600, minHeight: 28 }}
                >
                  Name and time zone · {name || 'Your plan'}
                </summary>
                <div className="form-grid" style={{ marginTop: 16 }}>
                  <Field label="Name">
                    <input
                      className="input"
                      value={name}
                      maxLength={60}
                      autoComplete="given-name"
                      disabled={locked}
                      onChange={(event) => {
                        changed()
                        setName(event.target.value)
                      }}
                    />
                  </Field>
                  <Field label="Time zone">
                    <input
                      className="input"
                      value={timezone}
                      maxLength={80}
                      spellCheck={false}
                      list="plan-timezones"
                      disabled={locked}
                      onChange={(event) => {
                        changed()
                        setTimezone(event.target.value)
                      }}
                    />
                    <datalist id="plan-timezones">
                      {[
                        'America/New_York',
                        'America/Chicago',
                        'America/Denver',
                        'America/Los_Angeles',
                        'Europe/London',
                        'Europe/Paris',
                        'Asia/Kolkata',
                        'Asia/Singapore',
                        'Australia/Sydney',
                        'UTC',
                      ].map((zone) => (
                        <option value={zone} key={zone} />
                      ))}
                    </datalist>
                  </Field>
                </div>
              </details>
              {state.profile.missingFields.length > 0 && (
                <Alert tone="warn" icon={CircleAlert}>
                  <b>Confirm these in this review</b>
                  <ul>
                    {state.profile.missingFields.map((field, index) => (
                      <li key={index}>{field}</li>
                    ))}
                  </ul>
                </Alert>
              )}
            </div>
          )}

          {(step === 1 || step === 2) && (
            <div className="stack">
              {stepFlows.some((flow) => flow.active && !flow.confirmed) && (
                <Alert tone="info" icon={ShieldCheck}>
                  Check the amount and next date, then confirm each suggestion.
                </Alert>
              )}
              {stepFlows.length === 0 && (
                <p className="meta">
                  {step === 1
                    ? 'Add a paycheck you can count on, or continue without expected income.'
                    : 'Rent, subscriptions, loan payments: anything your plan should allow for.'}
                </p>
              )}
              <div className="rows">
                {stepFlows.map((flow) => (
                  <FlowCard
                    key={flow.id}
                    flow={flow}
                    step={step}
                    editing={editingId === flow.id}
                    locked={locked}
                    today={snapshotDate()}
                    error={editingId === flow.id ? error?.text : undefined}
                    onToggle={() => {
                      setError(undefined)
                      setEditingId(editingId === flow.id ? null : flow.id)
                    }}
                    onChange={(patch, review) => updateFlow(flow.id, patch, review)}
                    onConfirm={() => confirmFlow(flow)}
                    onDone={() =>
                      flow.active && !flow.confirmed ? confirmFlow(flow) : finishEditing(flow)
                    }
                    onRemove={() => {
                      changed()
                      setFlows((all) => all.filter((item) => item.id !== flow.id))
                      setEditingId(null)
                    }}
                  />
                ))}
              </div>
              <Button
                variant="secondary"
                icon={Plus}
                onClick={addFlow}
                disabled={locked || flows.length >= 100}
              >
                {step === 1 ? 'Add income' : 'Add a bill or subscription'}
              </Button>
              {step === 2 && (
                <InstalmentPlans
                  suggestions={suggestedPlans}
                  flows={flows}
                  today={snapshotDate()}
                  locked={locked}
                  adding={addingPlan}
                  onAdding={setAddingPlan}
                  onAdd={(items) => {
                    changed()
                    setFlows((all) => [...all, ...items])
                    setAddingPlan(false)
                  }}
                  onRemove={(planId) => {
                    changed()
                    setFlows((all) =>
                      all.filter(
                        (flow) =>
                          (flow.planId ?? flow.id) !== planId || flow.kind !== 'installment',
                      ),
                    )
                  }}
                />
              )}
              <p className="caption">
                {step === 1
                  ? 'When a paycheck and a bill fall on the same day, Worth assumes the bill leaves first.'
                  : 'Turning an item off only changes this plan. It doesn’t cancel anything.'}
              </p>
            </div>
          )}

          {step === 3 && (
            <Review
              state={state}
              draft={() => draftProfile()}
              name={name}
              balance={balance}
              cushion={cushion}
              dailySpend={dailySpend}
              flows={flows}
              snapshot={snapshotDate()}
              onEdit={goTo}
              locked={locked}
            >
              {completedPurchases.length > 0 && (
                <section aria-labelledby="included-title">
                  <h2 className="h-section" id="included-title">
                    Already counted in your money?
                  </h2>
                  <p className="meta" style={{ margin: '4px 0 8px' }}>
                    Tick a purchase only if the money available above already reflects it. Others
                    stay set aside once.
                  </p>
                  {completedPurchases.map((purchase) => (
                    <label className="check" key={purchase.id}>
                      <input
                        type="checkbox"
                        checked={reflectedIds.includes(purchase.id)}
                        disabled={locked}
                        onChange={(event) => {
                          changed()
                          const on = event.target.checked
                          setReflectedIds((ids) =>
                            on
                              ? [...new Set([...ids, purchase.id])]
                              : ids.filter((id) => id !== purchase.id),
                          )
                        }}
                      />
                      <span>
                        {purchase.name} · {money(purchase.amountCents)}
                        <small>Already included in my money available.</small>
                      </span>
                    </label>
                  ))}
                </section>
              )}
              <section className="tile" aria-labelledby="claude-setting">
                <div className="switch-row">
                  <span className="strong" style={{ fontWeight: 700 }} id="claude-setting">
                    Use the assistant (powered by Claude)
                  </span>
                  <Toggle
                    checked={aiConsent}
                    label="Use the assistant (powered by Claude)"
                    disabled={locked}
                    describedBy="claude-setting-note"
                    onChange={(on) => {
                      changed()
                      setAiConsent(on)
                    }}
                  />
                </div>
                <p className="caption" id="claude-setting-note">
                  When the assistant is on, your plan totals and bill names go to Anthropic
                  (Claude), never your login. Answers still work with this off.{' '}
                  <a href="#settings">What’s shared</a>
                </p>
              </section>
              <label className="check">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={locked}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>
                  My money and bills are as of today.
                  <small>
                    Bills outside PayPal are included, and bills aren’t counted again in everyday
                    spending.
                  </small>
                </span>
              </label>
            </Review>
          )}

          {error && !error.field && !editingId && (
            <p className="co-error" role="alert" style={{ marginTop: 16 }}>
              <CircleAlert size={16} aria-hidden="true" style={{ flex: 'none', marginTop: 2 }} />
              {error.text}
            </p>
          )}
          {error?.field && (
            <p className="sr" role="alert">
              {error.text}
            </p>
          )}
          <div className="wizard-foot">
            <Button
              variant="secondary"
              onClick={() => goTo(step - 1)}
              disabled={step === 0 || busy}
            >
              Back
            </Button>
            {step < 3 ? (
              <Button onClick={next} disabled={locked}>
                Continue
              </Button>
            ) : (
              <Button onClick={() => void save()} loading={busy} disabled={!confirmed || locked}>
                Save plan
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}

function FlowCard({
  flow,
  step,
  editing,
  locked,
  today,
  error,
  onToggle,
  onChange,
  onConfirm,
  onDone,
  onRemove,
}: {
  flow: FlowDraft
  step: number
  editing: boolean
  locked: boolean
  today: string
  error?: string
  onToggle: () => void
  onChange: (patch: Partial<FlowDraft>, review?: boolean) => void
  onConfirm: () => void
  onDone: () => void
  onRemove: () => void
}) {
  const amount =
    flow.amount !== '' && Number.isFinite(Number(flow.amount))
      ? money(Math.round(Number(flow.amount) * 100))
      : '—'
  return (
    <div className={cx('flow-card', !flow.active && 'off')}>
      <div className="row">
        <Disc icon={flowIcon(flow)} kind={flow.kind === 'income' ? 'income' : undefined} />
        <div className="body">
          <div className="t" style={{ fontSize: 'var(--fs-body)' }}>
            {displayName(flow.name) || 'New item'}
          </div>
          <div className="s">
            <span className="soft">
              {flow.nextDate ? `Next ${dayLabel(flow.nextDate)}` : 'Choose a date'} ·{' '}
              {cadenceLabel(flow)}
              {!flow.active ? ' · Left out' : ''}
            </span>
          </div>
          {flow.active && !flow.confirmed && (
            <div className="pills">
              <Pill tone="warn">Needs review</Pill>
            </div>
          )}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div
            className={cx('amt num', flow.kind === 'income' && 'pos')}
            style={{ fontSize: 'var(--fs-body)' }}
          >
            {flow.kind === 'income' ? `+${amount}` : amount}
          </div>
          <button
            type="button"
            className="link edit-link"
            onClick={onToggle}
            disabled={locked}
            aria-expanded={editing}
            aria-label={`${editing ? 'Close' : 'Edit'} ${flow.name || 'new item'}`}
          >
            {editing ? 'Close' : 'Edit'}
          </button>
        </div>
      </div>
      {flow.active && !flow.confirmed && !editing && (
        <div className="actions" style={{ marginTop: 8 }}>
          <Button
            variant="secondary"
            onClick={onConfirm}
            disabled={locked}
            aria-label={`Confirm ${flow.name || 'item'}`}
          >
            Confirm
          </Button>
        </div>
      )}
      {editing && (
        <fieldset className="flow-editor" disabled={locked}>
          <legend className="sr">Edit {flow.name || 'item'}</legend>
          <div className="form-grid">
            <Field label="Name">
              <input
                className="input"
                maxLength={100}
                value={flow.name}
                placeholder={step === 1 ? 'Paycheck' : 'Rent'}
                onChange={(event) => onChange({ name: event.target.value })}
              />
            </Field>
            <Field label="Amount, USD">
              <span className="money-input">
                <span aria-hidden="true">$</span>
                <input
                  className="input num"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max="1000000"
                  step="0.01"
                  value={flow.amount}
                  onChange={(event) => onChange({ amount: event.target.value })}
                />
              </span>
            </Field>
            <DateStepper
              label={flow.kind === 'income' ? 'Next payday' : 'Next due date'}
              value={flow.nextDate || today}
              onChange={(nextDate) => onChange({ nextDate, userDate: true })}
            />
            {flow.kind !== 'income' && (
              <Field label="Type">
                <select
                  className="input"
                  value={flow.kind}
                  onChange={(event) => onChange({ kind: event.target.value as FlowKind })}
                >
                  <option value="bill">Bill</option>
                  <option value="subscription">Subscription</option>
                </select>
              </Field>
            )}
            {(flow.cadence === 'monthly' || flow.cadence === 'yearly') && (
              <Field label="Due on">
                <select
                  className="input"
                  value={flow.anchorDay === undefined ? '' : String(flow.anchorDay)}
                  onChange={(event) =>
                    onChange({
                      anchorDay:
                        event.target.value === ''
                          ? undefined
                          : event.target.value === 'last'
                            ? 'last'
                            : Number(event.target.value),
                    })
                  }
                >
                  <option value="">Same day as the next date</option>
                  {Array.from({ length: 31 }, (_, i) => (
                    <option key={i + 1} value={i + 1}>
                      Day {i + 1}
                    </option>
                  ))}
                  <option value="last">Last day of month</option>
                </select>
              </Field>
            )}
          </div>
          <div className="field">
            <span id={`freq-${flow.id}`}>How often</span>
            <div className="seg" role="radiogroup" aria-labelledby={`freq-${flow.id}`}>
              {CADENCES.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={flow.cadence === value}
                  onClick={() => onChange({ cadence: value })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {flow.nextDate === today && flow.kind !== 'income' && (
            <label className="check">
              <input
                type="checkbox"
                checked={flow.paidOn === today}
                onChange={(event) =>
                  onChange({ paidOn: event.target.checked ? today : undefined }, false)
                }
              />
              <span>
                Already paid today
                <small>Your money available already reflects it, so it isn’t counted twice.</small>
              </span>
            </label>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={flow.active}
              onChange={(event) => onChange({ active: event.target.checked })}
            />
            <span>Include in my plan</span>
          </label>
          {error && (
            <p className="field-error" role="alert">
              <CircleAlert size={16} aria-hidden="true" style={{ flex: 'none', marginTop: 2 }} />
              {error}
            </p>
          )}
          <div className="actions">
            <Button onClick={onDone}>
              {flow.active && !flow.confirmed ? 'Confirm item' : 'Done'}
            </Button>
            <Button
              variant="danger"
              icon={Trash2}
              onClick={onRemove}
              aria-label={`Remove ${flow.name || 'item'}`}
            >
              Remove
            </Button>
          </div>
        </fieldset>
      )}
    </div>
  )
}

/** C-7: Pay in 4 and other instalment plans already running, entered by hand. */
function InstalmentPlans({
  flows,
  today,
  locked,
  adding,
  suggestions = [],
  onAdding,
  onAdd,
  onRemove,
}: {
  flows: FlowDraft[]
  today: string
  locked: boolean
  adding: boolean
  suggestions?: InstalmentPlanProposal[]
  onAdding: (on: boolean) => void
  onAdd: (items: FlowDraft[]) => void
  onRemove: (planId: string) => void
}) {
  const plans = runningPlans(
    flows.map(({ amount, ...flow }) => ({
      ...flow,
      amountCents: Math.round(Number(amount) * 100),
    })),
    today,
  )
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [left, setLeft] = useState('3')
  const [first, setFirst] = useState(addDays(today, 14))
  /** The next payment Worth estimated for a plan from the import; a different date is the user's. */
  const [estimate, setEstimate] = useState<string>()
  const [every, setEvery] = useState<'14' | 'month'>('14')
  const [error, setError] = useState('')
  /** Set while the form holds a plan the import found, so the plan is recorded as from PayPal. */
  const [fromImport, setFromImport] = useState(false)
  const known = new Set(plans.map((plan) => plan.name.toLowerCase()))
  const offered = suggestions.filter((plan) => !known.has(plan.name.toLowerCase()))
  /** Fill the form from what the import saw; the user checks it before adding. */
  function prefill(plan: InstalmentPlanProposal) {
    const last = plan.payments.at(-1)?.date ?? plan.startDate
    let next = addDays(last, 14)
    while (next < today) next = addDays(next, 14)
    setName(`${plan.name} · Pay in 4`)
    setAmount((plan.paymentCents / 100).toFixed(2))
    setLeft(String(Math.max(1, 4 - plan.payments.length)))
    setFirst(next)
    setEstimate(next)
    setEvery('14')
    setError('')
    setFromImport(true)
    onAdding(true)
  }
  function add() {
    const cents = Math.round(Number(amount) * 100)
    const count = Number(left)
    if (!name.trim()) return setError('Name the plan, such as “Laptop · Pay in 4”.')
    if (!/^\d+(\.\d{1,2})?$/.test(amount.trim()) || cents <= 0)
      return setError('Enter the amount of each payment.')
    if (!Number.isInteger(count) || count < 1 || count > 24)
      return setError('Enter how many payments are left, from 1 to 24.')
    if (!first || first < today) return setError('Choose the next payment date, today or later.')
    const planId = `plan-${crypto.randomUUID()}`
    onAdd(
      Array.from({ length: count }, (_, index) => {
        const date =
          every === '14'
            ? addDays(first, 14 * index)
            : new Date(
                Date.UTC(
                  +first.slice(0, 4),
                  +first.slice(5, 7) - 1 + index,
                  +first.slice(8, 10),
                  12,
                ),
              )
                .toISOString()
                .slice(0, 10)
        return {
          id: `${planId}-${index + 1}`,
          planId,
          name: name.trim(),
          amount: (cents / 100).toFixed(2),
          nextDate: date,
          cadence: 'once' as const,
          kind: 'installment' as const,
          category: 'Instalment plans',
          active: true,
          confirmed: true,
          origin: fromImport ? ('paypal' as const) : ('you' as const),
          ...(fromImport && first === estimate ? {} : { userDate: true }),
        }
      }),
    )
    setName('')
    setAmount('')
    setError('')
    setFromImport(false)
  }
  return (
    <section aria-labelledby="plans-title" className="stack tight">
      <h2 className="h-section" id="plans-title" style={{ marginTop: 16 }}>
        Pay in 4 and other payment plans
      </h2>
      {plans.length === 0 && offered.length === 0 && (
        <p className="meta">No plans running. Add any you’re still paying.</p>
      )}
      <div className="rows">
        {plans.map((plan) => (
          <div className="row" key={plan.planId}>
            {plan.total ? (
              <Ring part={plan.total - plan.left} of={plan.total} />
            ) : (
              <Disc icon={flowIcon({ kind: 'installment' })} kind="plan" />
            )}
            <div className="body">
              <div className="t" style={{ fontSize: 'var(--fs-body)' }}>
                {plan.name}
              </div>
              <div className="s">
                <span className="soft">
                  {plan.total
                    ? `${plan.total - plan.left} of ${plan.total} paid`
                    : `${plan.left} payments left`}{' '}
                  · Next {dayLabel(plan.next)}
                </span>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="amt num" style={{ fontSize: 'var(--fs-body)' }}>
                {money(plan.amountCents)}
              </div>
              <Button
                variant="danger"
                disabled={locked}
                onClick={() => onRemove(plan.planId)}
                aria-label={`Remove ${plan.name}`}
              >
                Remove
              </Button>
            </div>
          </div>
        ))}
      </div>
      {!adding &&
        offered.map((plan) => (
          <div className="row" key={plan.id}>
            <Disc icon={flowIcon({ kind: 'installment' })} kind="plan" />
            <div className="body">
              <div className="t" style={{ fontSize: 'var(--fs-body)' }}>
                {plan.name}
              </div>
              <div className="s">
                <span className="soft">
                  Found in your import · payments of about {money(plan.paymentCents)}
                </span>
              </div>
              <div className="pills">
                <Pill tone="warn">Needs review</Pill>
              </div>
            </div>
            <Button variant="secondary" onClick={() => prefill(plan)} disabled={locked}>
              Review
            </Button>
          </div>
        ))}
      {adding ? (
        <div className="tile stack tight">
          <div className="form-grid">
            <Field label="Plan name">
              <input
                className="input"
                value={name}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
                placeholder="Laptop · Pay in 4"
              />
            </Field>
            <Field label="Amount per payment">
              <span className="money-input">
                <span aria-hidden="true">$</span>
                <input
                  className="input num"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </span>
            </Field>
            <Field label="Payments left">
              <input
                className="input num"
                type="number"
                min="1"
                max="24"
                value={left}
                onChange={(e) => setLeft(e.target.value)}
              />
            </Field>
            <DateStepper label="Next payment" min={today} value={first} onChange={setFirst} />
          </div>
          <div className="field">
            <span id="plan-every">Payments every</span>
            <div className="seg" role="radiogroup" aria-labelledby="plan-every">
              {(
                [
                  ['14', '2 weeks'],
                  ['month', 'Month'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={every === value}
                  onClick={() => setEvery(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {error && (
            <p className="field-error" role="alert">
              <CircleAlert size={16} aria-hidden="true" style={{ flex: 'none', marginTop: 2 }} />
              {error}
            </p>
          )}
          <div className="actions">
            <Button onClick={add} disabled={locked}>
              Add plan
            </Button>
            <Button
              variant="text"
              onClick={() => {
                setFromImport(false)
                onAdding(false)
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="secondary" icon={Plus} onClick={() => onAdding(true)} disabled={locked}>
          Add a payment plan
        </Button>
      )}
    </section>
  )
}

function Review({
  state,
  draft,
  name,
  balance,
  cushion,
  dailySpend,
  flows,
  snapshot,
  onEdit,
  locked,
  children,
}: {
  state: AppState
  draft: () => FinancialProfile
  name: string
  balance: string
  cushion: string
  dailySpend: string
  flows: FlowDraft[]
  snapshot: string
  onEdit: (step: number) => void
  locked: boolean
  children: ReactNode
}) {
  const asCents = (value: string) => Math.round(Number(value.replace(/,/g, '')) * 100)
  const profile = {
    ...state.profile,
    flows: flows.map(({ amount, ...f }) => ({ ...f, amountCents: asCents(amount) })),
  }
  const upcoming = getUpcomingFlows(profile, snapshot, 30)
  const income = upcoming
    .filter((item) => item.flow.kind === 'income')
    .reduce((t, i) => t + i.flow.amountCents, 0)
  const bills = upcoming
    .filter((item) => item.flow.kind !== 'income')
    .reduce((t, i) => t + i.flow.amountCents, 0)
  let preview: ReturnType<typeof assessPurchase> | undefined
  try {
    preview = assessPurchase(draft(), state.purchases, {
      amountCents: 0,
      today: snapshot,
      findEarliest: false,
    })
  } catch {
    preview = undefined
  }
  const row = (label: string, value: string, step: number) => (
    <div>
      <dt>{label}</dt>
      <dd className="num">
        {value}{' '}
        <button
          type="button"
          className="link edit-link"
          style={{ marginLeft: 8, marginTop: 0, fontSize: 'inherit' }}
          onClick={() => onEdit(step)}
          disabled={locked}
          aria-label={`Edit ${label.toLowerCase()}`}
        >
          Edit
        </button>
      </dd>
    </div>
  )
  return (
    <div className="stack">
      <section className="tile" aria-label={name === 'Your plan' ? 'Your plan' : `${name}’s plan`}>
        <dl className="kvlist">
          {row('Money available', money(asCents(balance)), 0)}
          {row('Cushion', money(asCents(cushion)), 0)}
          {row('Everyday spending', `${money(asCents(dailySpend))} a day`, 0)}
          {row('Income, next 30 days', signed(income, true), 1)}
          {row('Bills and plans, next 30 days', money(bills), 2)}
        </dl>
      </section>
      {preview && preview.points.length > 0 && (
        <section className="tile" aria-labelledby="preview-title">
          <h2 className="h-section" id="preview-title">
            Your balance, next {preview.points.length - 1} days
          </h2>
          <BalanceChart
            options={[
              {
                key: 'plan',
                name: 'Balance',
                points: preview.points.map((point) => ({
                  ...point,
                  minimumCents: point.baselineMinimumCents,
                })),
              },
            ]}
            selected="plan"
            cushionCents={preview.cushionCents}
            label="Projected balance before any purchase. Each day shows its low, with that day’s bills taken out before pay arrives."
          />
        </section>
      )}
      {children}
      <Alert tone="info" icon={Info}>
        Nothing changes until you save.
      </Alert>
    </div>
  )
}

/** The Plan tab after setup: commitments by kind, with Edit as the only action. */
type PlanTab = 'bill' | 'subscription' | 'plans' | 'income' | 'soon'
const PLAN_TABS: PlanTab[] = ['bill', 'subscription', 'plans', 'income', 'soon']

export function PlanPage({
  state,
  onEdit,
  onImport,
  initialTab,
  focus,
}: {
  state: AppState
  onEdit: (step: number) => void
  onImport: () => void
  /** Opens on this tab, such as "soon" from Home's "And N more in the next 30 days". */
  initialTab?: string | null
  /** Brings this bill or Pay in 4 plan into view, from a Home row or notice. */
  focus?: string | null
}) {
  const [tab, setTab] = useState<PlanTab>(
    PLAN_TABS.includes(initialTab as PlanTab) ? (initialTab as PlanTab) : 'bill',
  )
  useEffect(() => {
    if (!focus) return
    const row = document.getElementById(`plan-row-${focus}`)
    row?.scrollIntoView?.({ block: 'center' })
    row?.focus({ preventScroll: true })
  }, [focus])
  const soon = upcomingWithPlans(state)
  const plans = allPlans(state)
  const items = state.profile.flows
    .filter((flow) => flow.active && flow.kind === tab)
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate))
  const tabs = [
    ['bill', 'Bills'],
    ['subscription', 'Subscriptions'],
    ['plans', 'Pay in 4'],
    ['income', 'Income'],
    ['soon', 'Next 30 days'],
  ] as const
  return (
    <div className="page plain plan-page">
      <div className="wrap">
        {/* The head shares the grid below: the title over the list, the buttons over the rail. */}
        <div className="plan-head">
          <h1 className="title">Your plan</h1>
          <div className="actions">
            <Button variant="secondary" icon={Download} onClick={onImport} className="hide-m">
              Import PayPal activity
            </Button>
            <Button onClick={() => onEdit(0)}>Edit your plan</Button>
          </div>
        </div>
        <div className="grid">
          <div className="stack">
            <div className="seg" role="tablist" aria-label="Commitments">
              {tabs.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={tab === value}
                  aria-controls="commitments"
                  onClick={() => setTab(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="rows" id="commitments" role="tabpanel">
              {tab === 'soon'
                ? soon.map(({ flow, date }) => (
                    <div
                      className="row"
                      key={`${flow.id}-${date}`}
                      id={`plan-row-${flow.planId ?? flow.id}`}
                      tabIndex={-1}
                    >
                      <Disc
                        icon={flowIcon(flow)}
                        kind={
                          flow.kind === 'income'
                            ? 'income'
                            : flow.kind === 'installment'
                              ? 'plan'
                              : undefined
                        }
                      />
                      <div className="body">
                        <div className="t">{displayName(flow.name)}</div>
                        <div className="s">
                          {dayLabel(date)} <span className="soft">· {kindLabel(flow.kind)}</span>
                        </div>
                      </div>
                      <div className={cx('amt num', flow.kind === 'income' && 'pos')}>
                        {flow.kind === 'income'
                          ? signed(flow.amountCents, true)
                          : signed(-flow.amountCents)}
                      </div>
                    </div>
                  ))
                : tab === 'plans'
                  ? plans.map((plan) => (
                      <div
                        className="row"
                        key={plan.planId}
                        id={`plan-row-${plan.planId}`}
                        tabIndex={-1}
                      >
                        <Disc icon={flowIcon({ kind: 'installment' })} kind="plan" />
                        <div className="body">
                          <div className="t">{plan.name}</div>
                          <div className="s">
                            Next {dayLabel(plan.next)}{' '}
                            <span className="soft">
                              ·{' '}
                              {plan.total
                                ? `${plan.total - plan.left} of ${plan.total} paid`
                                : `${plan.left} payments left`}
                            </span>
                          </div>
                          {plan.total && (
                            <div
                              className="prog"
                              role="img"
                              aria-label={`${plan.total - plan.left} of ${plan.total} paid`}
                            >
                              <i
                                style={{
                                  width: `${((plan.total - plan.left) / plan.total) * 100}%`,
                                }}
                              />
                            </div>
                          )}
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div className="amt num">{signed(-plan.amountCents)}</div>
                          {!plan.planId.startsWith('purchase:') && (
                            <button
                              type="button"
                              className="link edit-link"
                              onClick={() => onEdit(2)}
                              aria-label={`Edit ${plan.name}`}
                            >
                              Edit
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  : items.map((flow) => (
                      <div className="row" key={flow.id} id={`plan-row-${flow.id}`} tabIndex={-1}>
                        <Disc
                          icon={flowIcon(flow)}
                          kind={flow.kind === 'income' ? 'income' : undefined}
                        />
                        <div className="body">
                          <div className="t">{displayName(flow.name)}</div>
                          <div className="s">
                            Next {dayLabel(flow.nextDate)}{' '}
                            <span className="soft">· {cadenceLabel(flow)}</span>
                          </div>
                          {!flow.confirmed && (
                            <div className="pills">
                              <Pill tone="warn">Needs review</Pill>
                            </div>
                          )}
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div className={cx('amt num', flow.kind === 'income' && 'pos')}>
                            {flow.kind === 'income'
                              ? signed(flow.amountCents, true)
                              : signed(-flow.amountCents)}
                          </div>
                          <button
                            type="button"
                            className="link edit-link"
                            onClick={() => onEdit(flow.kind === 'income' ? 1 : 2)}
                            aria-label={`Edit ${flow.name}`}
                          >
                            Edit
                          </button>
                        </div>
                      </div>
                    ))}
              {(tab === 'plans' ? plans.length : tab === 'soon' ? soon.length : items.length) ===
                0 && (
                <p className="meta">
                  {tab === 'soon'
                    ? 'Nothing scheduled in the next 30 days.'
                    : `No ${tab === 'plans' ? 'Pay in 4 plans' : `${kindLabel(tab).toLowerCase()}s`} in your plan.`}
                </p>
              )}
            </div>
          </div>
          <aside className="rail" aria-label="Plan summary">
            <section className="plan-summary">
              <div className="sec-head">
                <h2 className="h-section">Summary</h2>
              </div>
              <dl className="kvlist">
                <div>
                  <dt>Money available</dt>
                  <dd className="num">
                    {money(state.profile.balanceCents)}
                    <span className="caption">
                      {state.profile.confirmed
                        ? `Confirmed ${dayLabel(state.profile.snapshotDate)}`
                        : 'Not confirmed'}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Cushion</dt>
                  <dd className="num">{money(state.profile.cushionCents)}</dd>
                </div>
                <div>
                  <dt>Everyday spending</dt>
                  <dd className="num">{money(state.profile.dailySpendCents)} a day</dd>
                </div>
                <div>
                  <dt>History</dt>
                  <dd>
                    {state.profile.coverageDays} days ·{' '}
                    {state.profile.source === 'demo' ? 'sample' : 'imported'}
                  </dd>
                </div>
              </dl>
            </section>
          </aside>
        </div>
      </div>
    </div>
  )
}
