import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import {
  ArrowDownLeft,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  FileUp,
  Plus,
  Repeat2,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import type {
  AppState,
  Cadence,
  FinancialProfile,
  FlowKind,
  ImportPreview,
  ScheduledFlow,
} from '../shared/types'
import { getUpcomingFlows, todayInTimezone } from '../shared/finance'
import { api } from './api'
import { CLAUDE_SHARED_DATA } from './copy'
import { money, shortDate } from './format'
import { Button, Field, Footnote, Modal } from './ui'
import './plan-dialog.css'

type DialogProps = { state: AppState; onClose: () => void; onUpdate: (state: AppState) => void }
type FlowDraft = Omit<ScheduledFlow, 'amountCents'> & { amount: string }
const dollars = (cents: number) => (cents / 100).toFixed(2)
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.'
const activeStatuses = new Set(['created', 'pending', 'unknown'])
const confirmationTimestamp = () => new Date().toISOString()

function readMoney(value: string, label: string): number {
  const normalized = value.trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized))
    throw new Error(`Enter ${label.toLowerCase()} as a USD amount with up to two decimal places.`)
  const cents = Math.round(Number(normalized) * 100)
  if (!Number.isSafeInteger(cents) || cents > 100_000_000)
    throw new Error(`${label} must be between $0 and $1,000,000.`)
  return cents
}

const planSteps = [
  {
    label: 'Funds',
    title: 'Start with what’s available.',
    description: 'The money you can use, and the breathing room you want to keep.',
  },
  {
    label: 'Income',
    title: 'Know what’s coming in.',
    description: 'Add income you can reasonably count on.',
  },
  {
    label: 'Bills & subscriptions',
    title: 'Make room for the essentials.',
    description: 'Include renewals, debt payments, and commitments outside PayPal.',
  },
  {
    label: 'Review',
    title: 'One last look.',
    description: 'A few checked assumptions make for a much better answer.',
  },
] as const
const cadenceLabels: Record<Cadence, string> = {
  once: 'One time',
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  yearly: 'Yearly',
}

export function PlanDialog({
  state,
  onClose,
  onUpdate,
  onReset,
}: DialogProps & { onReset?: () => void }) {
  const [openedVersion] = useState(state.profile.version)
  const [step, setStep] = useState(0)
  const [name, setName] = useState(state.profile.name)
  const [balance, setBalance] = useState(dollars(state.profile.balanceCents))
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
  const [aiConsent, setAiConsent] = useState(state.profile.aiConsent)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null)
  const [error, setError] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const errorRef = useRef<HTMLParagraphElement>(null)
  const mutating = useRef(false)
  const completedPurchases = state.purchases.filter((purchase) => purchase.status === 'completed')
  const activeCheckout = state.purchases.some((purchase) => activeStatuses.has(purchase.status))
  const locked = Boolean(busy) || activeCheckout
  const currentStep = planSteps[step]!
  const stepFlows = flows.filter(
    (flow) =>
      (step === 1 ? flow.kind === 'income' : flow.kind !== 'income') || flow.id === editingId,
  )

  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
    if (content.current) content.current.scrollTop = 0
  }, [step])
  useEffect(() => {
    if (error) errorRef.current?.focus({ preventScroll: true })
  }, [error])

  const changed = () => {
    setConfirmed(false)
    setError('')
  }
  const snapshotDate = () =>
    timezone.trim() === state.profile.timezone ? state.today : todayInTimezone(timezone.trim())
  const updateFlow = (id: string, patch: Partial<FlowDraft>, requireReview = true) => {
    changed()
    setFlows((current) =>
      current.map((flow) =>
        flow.id === id
          ? { ...flow, ...patch, ...(requireReview ? { confirmed: false } : {}) }
          : flow,
      ),
    )
  }
  const goTo = (next: number) => {
    setError('')
    setEditingId(null)
    setStep(next)
  }

  function validateFunds() {
    if (!name.trim()) throw new Error('Add a name under “Name & time zone”.')
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone.trim() })
    } catch {
      throw new Error('Choose a valid time zone under “Name & time zone”.')
    }
    readMoney(balance, 'Available funds')
    readMoney(cushion, 'Cash cushion')
    readMoney(dailySpend, 'Everyday spending')
  }

  function readFlow(flow: FlowDraft, requireConfirmation = true): ScheduledFlow {
    if (!flow.name.trim()) throw new Error('Give this scheduled item a name, or remove it.')
    const { amount, ...scheduled } = flow
    const amountCents = readMoney(amount, flow.name)
    const date = new Date(`${flow.nextDate}T12:00:00Z`)
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(flow.nextDate) ||
      !Number.isFinite(date.valueOf()) ||
      date.toISOString().slice(0, 10) !== flow.nextDate
    )
      throw new Error(`Choose a valid next date for ${flow.name}.`)
    if (flow.active && flow.cadence === 'once' && flow.nextDate < snapshotDate())
      throw new Error(
        `${flow.name} is in the past. Update its date or turn it off if it already happened.`,
      )
    if (requireConfirmation && flow.active && !flow.confirmed)
      throw new Error(
        `Review and confirm ${flow.name}, or turn it off if it does not belong in your plan.`,
      )
    return { ...scheduled, name: flow.name.trim(), amountCents }
  }

  function validateFlows(items: FlowDraft[]) {
    for (const flow of items) {
      try {
        readFlow(flow)
      } catch (failure) {
        setEditingId(flow.id)
        throw failure
      }
    }
  }

  function next() {
    setError('')
    try {
      if (step === 0) validateFunds()
      else validateFlows(step === 2 ? flows : stepFlows)
      goTo(step + 1)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }

  function addFlow() {
    changed()
    const id = crypto.randomUUID()
    setFlows((current) => [
      ...current,
      {
        id,
        name: '',
        amount: '',
        nextDate: snapshotDate(),
        cadence: 'monthly',
        kind: step === 1 ? 'income' : 'bill',
        category: step === 1 ? 'Income' : 'Other',
        active: true,
        confirmed: false,
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
      setError(errorMessage(failure))
    }
  }

  function finishEditing(flow: FlowDraft) {
    try {
      readFlow(flow, false)
      setError('')
      setEditingId(null)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }

  async function save() {
    if (mutating.current || step !== 3) return
    setError('')
    if (!confirmed) {
      setError('Confirm the financial picture below before saving.')
      return
    }
    if (activeCheckout) {
      setError('Finish or cancel your current checkout before changing the plan.')
      return
    }
    let saved = false
    try {
      validateFunds()
      const scheduled = flows.map((flow) => readFlow(flow))
      const profile: FinancialProfile = {
        ...state.profile,
        version: openedVersion,
        name: name.trim(),
        balanceCents: readMoney(balance, 'Available funds'),
        cushionCents: readMoney(cushion, 'Cash cushion'),
        dailySpendCents: readMoney(dailySpend, 'Everyday spending'),
        timezone: timezone.trim(),
        flows: scheduled,
        reflectedPurchaseIds: reflectedIds.filter((id) =>
          completedPurchases.some((purchase) => purchase.id === id),
        ),
        aiConsent,
        confirmed: true,
        confirmedAt: confirmationTimestamp(),
        snapshotDate: snapshotDate(),
        missingFields: [],
      }
      mutating.current = true
      setBusy('save')
      const updated = await api<AppState>('/profile', { profile }, 'PATCH')
      saved = true
      onUpdate(updated)
      onClose()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      if (!saved) {
        mutating.current = false
        setBusy(null)
      }
    }
  }

  async function reset() {
    if (mutating.current || activeCheckout) return
    setError('')
    mutating.current = true
    setBusy('reset')
    let resetDone = false
    try {
      const updated = await api<AppState>('/reset', {})
      resetDone = true
      onReset?.()
      onUpdate(updated)
      onClose()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      if (!resetDone) {
        mutating.current = false
        setBusy(null)
      }
    }
  }

  const reviewFlows =
    step === 3
      ? getUpcomingFlows(
          {
            ...state.profile,
            flows: flows.map(({ amount, ...flow }) => ({
              ...flow,
              amountCents: Math.round(Number(amount) * 100),
            })),
          },
          snapshotDate(),
          30,
        )
      : []
  const incomeTotal = reviewFlows
    .filter((item) => item.flow.kind === 'income')
    .reduce((total, item) => total + item.flow.amountCents, 0)
  const billsTotal = reviewFlows
    .filter((item) => item.flow.kind !== 'income')
    .reduce((total, item) => total + item.flow.amountCents, 0)

  return (
    <Modal
      open
      onClose={busy ? () => undefined : onClose}
      title="Your financial picture"
      className="plan-dialog"
    >
      <form
        className="plan-wizard"
        onSubmit={(event) => event.preventDefault()}
        aria-busy={Boolean(busy)}
      >
        <div className="plan-progress">
          <div className="plan-progress-meta">
            <span>
              Step {step + 1} of {planSteps.length}
            </span>
            <span>
              {state.profile.source === 'demo'
                ? 'Exploring a sample plan'
                : `${state.profile.coverageDays} days imported`}
            </span>
          </div>
          <div
            className="plan-progress-track"
            role="progressbar"
            aria-label="Financial picture progress"
            aria-valuemin={1}
            aria-valuemax={4}
            aria-valuenow={step + 1}
            aria-valuetext={`Step ${step + 1} of 4: ${currentStep.label}`}
          >
            <span style={{ width: `${(step + 1) * 25}%` }} />
          </div>
          <ol className="plan-step-labels">
            {planSteps.map((item, index) => (
              <li
                key={item.label}
                className={index === step ? 'current' : index < step ? 'complete' : ''}
                aria-current={index === step ? 'step' : undefined}
              >
                <span>{index < step ? <Check size={11} aria-hidden="true" /> : index + 1}</span>
                {item.label}
              </li>
            ))}
          </ol>
        </div>

        <div className="plan-wizard-body" ref={content}>
          {activeCheckout && (
            <div className="notice notice-warning" role="status">
              Finish or cancel your active checkout before changing this plan or deleting your data.
            </div>
          )}
          <div className="plan-step-heading">
            <h3 ref={heading} tabIndex={-1}>
              {currentStep.title}
            </h3>
            <p>{currentStep.description}</p>
          </div>

          {step === 0 && (
            <div className="plan-funds-step">
              <div className="plan-money-grid">
                <Field
                  label="Available funds · USD"
                  hint="Exclude credit limits and protected savings."
                >
                  <div className="plan-money-input">
                    <span aria-hidden="true">$</span>
                    <input
                      className="input"
                      type="number"
                      inputMode="decimal"
                      min="0"
                      max="1000000"
                      step="0.01"
                      value={balance}
                      onChange={(event) => {
                        changed()
                        setBalance(event.target.value)
                      }}
                      disabled={locked}
                    />
                  </div>
                </Field>
                <Field label="Cash cushion · USD" hint="The minimum balance you want to keep.">
                  <div className="plan-money-input">
                    <span aria-hidden="true">$</span>
                    <input
                      className="input"
                      type="number"
                      inputMode="decimal"
                      min="0"
                      max="1000000"
                      step="0.01"
                      value={cushion}
                      onChange={(event) => {
                        changed()
                        setCushion(event.target.value)
                      }}
                      disabled={locked}
                    />
                  </div>
                </Field>
              </div>
              <div className="plan-daily-input">
                <Field
                  label="Everyday spending · USD / day"
                  hint="Food, travel, and other daily costs. Keep the bills in step 3 separate."
                >
                  <div className="plan-daily-value">
                    <span aria-hidden="true">$</span>
                    <input
                      className="input"
                      type="number"
                      inputMode="decimal"
                      min="0"
                      max="1000000"
                      step="0.01"
                      value={dailySpend}
                      onChange={(event) => {
                        changed()
                        setDailySpend(event.target.value)
                      }}
                      disabled={locked}
                    />
                    <span aria-hidden="true">/ day</span>
                  </div>
                </Field>
              </div>
              <details className="plan-details">
                <summary>
                  <span>Name & time zone</span>
                  <span>
                    {name || 'Your plan'}
                    <ChevronDown size={14} />
                  </span>
                </summary>
                <div className="form-grid">
                  <Field label="Name">
                    <input
                      className="input"
                      value={name}
                      maxLength={60}
                      onChange={(event) => {
                        changed()
                        setName(event.target.value)
                      }}
                      disabled={locked}
                      autoComplete="given-name"
                    />
                  </Field>
                  <Field label="Time zone">
                    <input
                      className="input"
                      value={timezone}
                      maxLength={80}
                      list="worth-plan-timezones"
                      onChange={(event) => {
                        changed()
                        setTimezone(event.target.value)
                      }}
                      disabled={locked}
                      spellCheck={false}
                    />
                    <datalist id="worth-plan-timezones">
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
                <details className="plan-missing-details">
                  <summary>Details to confirm in this review</summary>
                  <ul>
                    {state.profile.missingFields.map((field, index) => (
                      <li key={index}>{field}</li>
                    ))}
                  </ul>
                </details>
              )}
              <p className="plan-step-note">
                {state.profile.source === 'demo'
                  ? 'These are Alex’s sample figures. You can explore the plan or import your own activity.'
                  : 'History suggests patterns. Confirm these numbers include your life outside PayPal.'}
              </p>
            </div>
          )}

          {(step === 1 || step === 2) && (
            <div className="plan-flows-step">
              {stepFlows.some((flow) => flow.active && !flow.confirmed) && (
                <p className="plan-review-hint">
                  <ShieldCheck size={15} />
                  Check the amount and next date, then confirm each suggestion.
                </p>
              )}
              {stepFlows.length === 0 && (
                <div className="plan-empty-flow">
                  <span>{step === 1 ? <ArrowDownLeft size={24} /> : <Repeat2 size={24} />}</span>
                  <strong>
                    {step === 1
                      ? 'Your next paycheck goes here.'
                      : 'The predictable things go here.'}
                  </strong>
                  <p>
                    {step === 1
                      ? 'Add a dependable income source, or continue without expected income.'
                      : 'Rent, subscriptions, repayments—anything your plan should allow for.'}
                  </p>
                </div>
              )}
              <div className="plan-flow-list">
                {stepFlows.map((flow) => {
                  const editing = editingId === flow.id
                  return (
                    <div
                      key={flow.id}
                      className={`plan-flow-card ${editing ? 'editing' : ''} ${!flow.active ? 'inactive' : ''}`}
                    >
                      <div className="plan-flow-summary">
                        <button
                          type="button"
                          className="plan-flow-open"
                          aria-label={`Edit ${flow.name || 'new scheduled item'}`}
                          aria-expanded={editing}
                          onClick={() => {
                            setError('')
                            setEditingId(editing ? null : flow.id)
                          }}
                          disabled={locked}
                        >
                          <span
                            className={`plan-flow-symbol ${flow.kind === 'income' ? 'income' : ''}`}
                          >
                            {flow.kind === 'income' ? (
                              <ArrowDownLeft size={17} />
                            ) : (
                              <Repeat2 size={17} />
                            )}
                          </span>
                          <span className="plan-flow-name">
                            <strong>{flow.name || 'New scheduled item'}</strong>
                            <small>
                              {flow.nextDate ? shortDate(flow.nextDate) : 'Choose a date'} ·{' '}
                              {cadenceLabels[flow.cadence]}
                              {!flow.active
                                ? ' · Excluded'
                                : !flow.confirmed
                                  ? ' · Needs review'
                                  : ''}
                            </small>
                          </span>
                          <span className="plan-flow-amount">
                            {flow.amount !== '' && Number.isFinite(Number(flow.amount))
                              ? money(Math.round(Number(flow.amount) * 100), true)
                              : '—'}
                          </span>
                          <ChevronRight size={15} className={editing ? 'expanded' : ''} />
                        </button>
                        {flow.active && !flow.confirmed && !editing && (
                          <button
                            type="button"
                            className="plan-confirm-flow"
                            aria-label={`Confirm ${flow.name || 'scheduled item'}`}
                            onClick={() => confirmFlow(flow)}
                            disabled={locked}
                          >
                            <Check size={14} /> Confirm
                          </button>
                        )}
                      </div>
                      {editing && (
                        <fieldset className="plan-flow-editor" disabled={locked}>
                          <legend className="plan-sr-only">
                            Edit {flow.name || 'scheduled item'}
                          </legend>
                          <div className="form-grid">
                            <Field label="Item name">
                              <input
                                className="input"
                                maxLength={100}
                                value={flow.name}
                                onChange={(event) =>
                                  updateFlow(flow.id, { name: event.target.value })
                                }
                                placeholder={
                                  step === 1
                                    ? 'e.g. Monthly paycheck'
                                    : 'e.g. Rent or music streaming'
                                }
                              />
                            </Field>
                            <Field label="Amount · USD">
                              <input
                                className="input"
                                type="number"
                                inputMode="decimal"
                                min="0"
                                max="1000000"
                                step="0.01"
                                value={flow.amount}
                                onChange={(event) =>
                                  updateFlow(flow.id, { amount: event.target.value })
                                }
                              />
                            </Field>
                            <Field label="Next date">
                              <input
                                className="input"
                                type="date"
                                value={flow.nextDate}
                                onChange={(event) =>
                                  updateFlow(flow.id, { nextDate: event.target.value })
                                }
                              />
                            </Field>
                            <Field label="Repeats">
                              <select
                                className="input"
                                value={flow.cadence}
                                onChange={(event) =>
                                  updateFlow(flow.id, { cadence: event.target.value as Cadence })
                                }
                              >
                                {Object.entries(cadenceLabels).map(([value, label]) => (
                                  <option value={value} key={value}>
                                    {label}
                                  </option>
                                ))}
                              </select>
                            </Field>
                            <Field label="Type">
                              <select
                                className="input"
                                value={flow.kind}
                                onChange={(event) =>
                                  updateFlow(flow.id, {
                                    kind: event.target.value as FlowKind,
                                    category:
                                      event.target.value === 'income'
                                        ? 'Income'
                                        : flow.kind === 'income'
                                          ? 'Other'
                                          : flow.category,
                                  })
                                }
                              >
                                <option value="income">Expected income</option>
                                <option value="bill">Bill or commitment</option>
                                <option value="subscription">Subscription</option>
                                <option value="installment">Instalment plan payment</option>
                              </select>
                            </Field>
                          </div>
                          <div className="plan-flow-checks">
                            <label className="check-row">
                              <input
                                type="checkbox"
                                checked={flow.active}
                                onChange={(event) =>
                                  updateFlow(flow.id, { active: event.target.checked })
                                }
                              />
                              <span>Include in my plan</span>
                            </label>
                            <label className="check-row">
                              <input
                                type="checkbox"
                                checked={flow.confirmed}
                                disabled={!flow.active}
                                onChange={(event) =>
                                  updateFlow(flow.id, { confirmed: event.target.checked }, false)
                                }
                              />
                              <span>I’ve checked this item</span>
                            </label>
                          </div>
                          <div className="plan-flow-editor-actions">
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() => {
                                changed()
                                setFlows((current) => current.filter((item) => item.id !== flow.id))
                                setEditingId(null)
                              }}
                              aria-label={`Remove ${flow.name || 'scheduled item'}`}
                            >
                              <Trash2 size={14} /> Remove
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={() =>
                                flow.active && !flow.confirmed
                                  ? confirmFlow(flow)
                                  : finishEditing(flow)
                              }
                            >
                              {flow.active && !flow.confirmed ? 'Confirm item' : 'Done'}
                              <Check size={14} />
                            </Button>
                          </div>
                        </fieldset>
                      )}
                    </div>
                  )
                })}
              </div>
              <button
                type="button"
                className="plan-add-flow"
                onClick={addFlow}
                disabled={locked || flows.length >= 100}
              >
                <Plus size={17} />
                {step === 1 ? 'Add income' : 'Add a bill or subscription'}
              </button>
              <p className="plan-step-note">
                {step === 1
                  ? 'When timing is unknown, the plan allows for spending before income arrives that day.'
                  : 'Turning an item off here only changes this forecast. It does not cancel a subscription.'}
              </p>
            </div>
          )}

          {step === 3 && (
            <div className="plan-review-step">
              <div className="plan-review-summary">
                <div className="plan-review-heading">
                  <span>{name === 'Your plan' ? 'Your plan' : `${name}’s plan`}</span>
                  <button type="button" onClick={() => goTo(0)} disabled={locked}>
                    Edit funds
                    <ChevronRight size={13} />
                  </button>
                </div>
                <dl>
                  <div>
                    <dt>Available funds</dt>
                    <dd>{money(Math.round(Number(balance) * 100), true)}</dd>
                  </div>
                  <div>
                    <dt>Protected cushion</dt>
                    <dd>{money(Math.round(Number(cushion) * 100), true)}</dd>
                  </div>
                  <div>
                    <dt>Everyday spending</dt>
                    <dd>
                      {money(Math.round(Number(dailySpend) * 100), true)}
                      <small> / day</small>
                    </dd>
                  </div>
                </dl>
                <div className="plan-review-next">
                  <span>Next 30 days</span>
                  <button type="button" onClick={() => goTo(1)} disabled={locked}>
                    <span>Expected income</span>
                    <strong>+{money(incomeTotal, true)}</strong>
                    <ChevronRight size={13} />
                  </button>
                  <button type="button" onClick={() => goTo(2)} disabled={locked}>
                    <span>Bills & subscriptions</span>
                    <strong>{money(billsTotal, true)}</strong>
                    <ChevronRight size={13} />
                  </button>
                </div>
              </div>
              {completedPurchases.length > 0 && (
                <section
                  className="plan-purchase-review"
                  aria-labelledby="purchase-inclusion-heading"
                >
                  <h4 id="purchase-inclusion-heading">Already reflected in your funds?</h4>
                  <p>
                    Check only purchases whose cost is included in the balance above. Unchecked
                    items stay reserved once.
                  </p>
                  {completedPurchases.map((purchase) => (
                    <label className="check-row" key={purchase.id}>
                      <input
                        type="checkbox"
                        checked={reflectedIds.includes(purchase.id)}
                        disabled={locked}
                        onChange={(event) => {
                          changed()
                          const checked = event.target.checked
                          setReflectedIds((current) =>
                            checked
                              ? [...new Set([...current, purchase.id])]
                              : current.filter((id) => id !== purchase.id),
                          )
                        }}
                      />
                      <span>
                        <strong>
                          {purchase.name} · {money(purchase.amountCents, true)}
                        </strong>
                        <small>Already included in my available funds.</small>
                      </span>
                    </label>
                  ))}
                </section>
              )}
              <label className="check-row plan-ai-consent">
                <input
                  type="checkbox"
                  checked={aiConsent}
                  disabled={locked}
                  onChange={(event) => {
                    changed()
                    setAiConsent(event.target.checked)
                  }}
                />
                <span>
                  <strong>Use my financial context with Claude</strong>
                  <small>
                    Sends {CLAUDE_SHARED_DATA} to Anthropic. Calculations work with this off.
                  </small>
                </span>
              </label>
              <label className="check-row confirmation-row">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={locked}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>
                  <strong>I’ve reviewed this financial picture.</strong>
                  <small>
                    My funds are current, outside-PayPal commitments are included, and scheduled
                    bills aren’t counted again in everyday spending.
                  </small>
                </span>
              </label>
            </div>
          )}
        </div>

        <div className="plan-wizard-footer">
          {error && (
            <p ref={errorRef} tabIndex={-1} className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="plan-navigation">
            <Button
              type="button"
              variant="ghost"
              onClick={() => goTo(step - 1)}
              disabled={step === 0 || Boolean(busy)}
            >
              <ArrowLeft size={16} /> Back
            </Button>
            <span>
              {step === 3 ? 'Nothing changes until you save.' : 'Your changes stay here as you go.'}
            </span>
            {step < 3 ? (
              <Button type="button" onClick={next} disabled={locked}>
                Continue
                <ArrowRight size={16} />
              </Button>
            ) : (
              <Button
                type="button"
                onClick={() => void save()}
                loading={busy === 'save'}
                disabled={!confirmed || locked}
              >
                <Check size={16} /> Save my plan
              </Button>
            )}
          </div>
          <div className="plan-reset">
            {!confirmReset ? (
              <button
                type="button"
                onClick={() => {
                  setError('')
                  setConfirmReset(true)
                }}
                disabled={locked}
              >
                <Trash2 size={12} />
                Delete my data & start a fresh demo
              </button>
            ) : (
              <div className="notice notice-warning">
                <strong>Delete this Worth session?</strong>
                <p>
                  Your imported history, plan, and Worth purchase records will be replaced by a
                  fresh sample plan.
                </p>
                <div className="form-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={Boolean(busy)}
                    onClick={() => setConfirmReset(false)}
                  >
                    Keep my data
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    loading={busy === 'reset'}
                    disabled={locked}
                    onClick={() => void reset()}
                  >
                    Delete & start over
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </form>
    </Modal>
  )
}

export function ImportDialog({
  state,
  onClose,
  onUpdate,
  onReview,
}: DialogProps & { onReview: () => void }) {
  const [csv, setCsv] = useState('')
  const [filename, setFilename] = useState('')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [previewedCsv, setPreviewedCsv] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState<'read' | 'preview' | 'commit' | null>(null)
  const [error, setError] = useState('')
  const activeCheckout = state.purchases.some((purchase) => activeStatuses.has(purchase.status))
  const changeCsv = (value: string) => {
    setCsv(value)
    setPreview(null)
    setPreviewedCsv('')
    setAcknowledged(false)
    setError('')
  }

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setError('')
    setPreview(null)
    setAcknowledged(false)
    if (file.size > 1_000_000) {
      setError('Choose a CSV smaller than 1 MB. A recent 90-day export is a good starting point.')
      event.target.value = ''
      return
    }
    setBusy('read')
    try {
      const text = await file.text()
      changeCsv(text)
      setFilename(file.name)
    } catch {
      setError('This file could not be read. Try choosing it again or paste its contents below.')
    } finally {
      setBusy(null)
    }
  }

  const getPreview = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setAcknowledged(false)
    if (!csv.trim()) {
      setError('Choose a CSV or paste your PayPal activity export first.')
      return
    }
    if (new TextEncoder().encode(csv).byteLength > 1_000_000) {
      setError('Use a CSV smaller than 1 MB.')
      return
    }
    setBusy('preview')
    try {
      const result = await api<ImportPreview>('/import/preview', { csv })
      setPreview(result)
      setPreviewedCsv(csv)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(null)
    }
  }

  const commit = async () => {
    if (!preview || preview.errors.length || csv !== previewedCsv || !acknowledged) return
    setError('')
    setBusy('commit')
    try {
      const updated = await api<AppState>('/import/commit', { csv })
      onUpdate(updated)
      onClose()
      onReview()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal
      open
      onClose={busy ? () => undefined : onClose}
      title="Make room for your real life"
      description="Bring your PayPal activity. We’ll help you turn the patterns into a plan."
      className="import-dialog"
    >
      <form onSubmit={getPreview} aria-busy={Boolean(busy)}>
        {activeCheckout && (
          <div className="notice notice-warning">
            Finish or cancel your active checkout before importing new history.
          </div>
        )}
        <section className="form-section">
          <div className="notice">
            <FileUp size={21} />
            <div>
              <strong>A PayPal activity export, in USD</strong>
              <p>
                Use an English-language CSV with Date, Currency, and Net, Amount, or Gross. Up to 1
                MB; about 90 days of history works well.
              </p>
            </div>
          </div>
          <Field
            label="Choose your CSV"
            hint={
              filename
                ? `Selected: ${filename}`
                : 'Download an activity report from your PayPal account.'
            }
          >
            <input
              className="input"
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => void chooseFile(event)}
              disabled={Boolean(busy)}
            />
          </Field>
          <details>
            <summary>Or paste the CSV contents</summary>
            <Field label="PayPal CSV contents">
              <textarea
                className="input"
                rows={6}
                value={csv}
                maxLength={1_000_000}
                onChange={(event) => {
                  setFilename('')
                  changeCsv(event.target.value)
                }}
                spellCheck={false}
                placeholder={'Date,Name,Currency,Amount\n2026-01-01,Coffee shop,USD,-6.50'}
                disabled={Boolean(busy)}
              />
            </Field>
          </details>
          <Footnote>
            {state.profile.source === 'demo'
              ? 'Your own history replaces the sample transactions. Next, you’ll confirm your current funds, income, and upcoming bills.'
              : 'New transactions are merged with your history. Matching transaction IDs prevent repeated imports from duplicating your spending.'}
          </Footnote>
          <Button
            type="submit"
            variant="secondary"
            loading={busy === 'preview'}
            disabled={!csv.trim() || Boolean(busy) || activeCheckout}
          >
            <FileUp size={16} /> Preview my history
          </Button>
        </section>
      </form>

      {preview && (
        <section
          className="form-section"
          aria-labelledby="import-preview-heading"
          aria-live="polite"
        >
          <h3 id="import-preview-heading">Here’s what we found</h3>
          <div className="form-grid import-stats">
            <div className="notice">
              <strong>{preview.totalRows}</strong>
              <span> rows in your file</span>
            </div>
            <div className="notice">
              <strong>{preview.coverageDays}</strong>
              <span> days of history</span>
            </div>
            <div className="notice">
              <strong>{preview.transactions.length}</strong>
              <span> new or updated transactions</span>
            </div>
            <div className="notice">
              <strong>{preview.duplicates}</strong>
              <span> duplicate rows skipped</span>
            </div>
          </div>
          <p className="muted">
            {preview.excluded} rows are excluded from everyday spending estimates. Suggested
            everyday spending:{' '}
            <strong>{money(preview.suggestedDailySpendCents, true)} / day</strong>.{' '}
            {preview.recurring.length} possible recurring{' '}
            {preview.recurring.length === 1 ? 'item needs' : 'items need'} your review.
          </p>
          {preview.errors.length > 0 && (
            <div className="notice notice-warning" role="alert">
              <strong>
                Correct {preview.errors.length}{' '}
                {preview.errors.length === 1 ? 'row issue' : 'row issues'} before importing.
              </strong>
              <ul>
                {preview.errors.slice(0, 20).map((issue, index) => (
                  <li key={`${issue.row}-${index}`}>
                    Row {issue.row}: {issue.message}
                  </li>
                ))}
              </ul>
              {preview.errors.length > 20 && (
                <p>
                  And {preview.errors.length - 20} more issues. Correct these rows and preview the
                  file again.
                </p>
              )}
            </div>
          )}
          {preview.warnings.length > 0 && (
            <div className="notice notice-warning">
              <strong>A few things to review</strong>
              <ul>
                {preview.warnings.slice(0, 12).map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
              {preview.warnings.length > 12 && (
                <p>
                  {preview.warnings.length - 12} more row warnings. Review your export before
                  continuing.
                </p>
              )}
            </div>
          )}
          {preview.transactions.length > 0 && (
            <div className="preview-list">
              <table>
                <caption>
                  Preview of your {Math.min(preview.transactions.length, 8)} most recent new or
                  updated transactions
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Transaction</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.transactions.slice(0, 8).map((transaction) => (
                    <tr key={transaction.id}>
                      <td>{shortDate(transaction.date)}</td>
                      <td>
                        {transaction.name}
                        {transaction.status !== 'completed' && (
                          <small> · {transaction.status}</small>
                        )}
                      </td>
                      <td>{money(transaction.amountCents, true)}</td>
                      <td>{transaction.kind === 'unknown' ? 'Needs review' : transaction.kind}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {preview.errors.length === 0 && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                disabled={Boolean(busy)}
              />
              <span>
                I reviewed this preview. I’ll confirm my available funds and upcoming commitments
                next.
              </span>
            </label>
          )}
        </section>
      )}
      <Footnote>
        <span>
          <ShieldCheck size={14} /> Raw CSV files are not saved. Imported history is retained for
          this session and is not sent to Claude without your permission. Past transactions do not
          establish your current available funds.
        </span>
      </Footnote>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <Button type="button" variant="ghost" onClick={onClose} disabled={Boolean(busy)}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => void commit()}
          loading={busy === 'commit'}
          disabled={
            !preview ||
            preview.errors.length > 0 ||
            !acknowledged ||
            csv !== previewedCsv ||
            Boolean(busy) ||
            activeCheckout ||
            (!preview.transactions.length && !preview.duplicates)
          }
        >
          Import & review my plan <ArrowRight size={16} />
        </Button>
      </div>
    </Modal>
  )
}
