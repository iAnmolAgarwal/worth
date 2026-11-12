import { useEffect, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent, ReactNode } from 'react'
import {
  CalendarCheck,
  CalendarClock,
  CircleAlert,
  FileText,
  FileUp,
  Plus,
  ReceiptText,
} from 'lucide-react'
import { addDays, planCollisions, todayInTimezone } from '../shared/finance'
import { CSV_IMPORT_LIMITS, CSV_SIZE_MESSAGE, utf8Bytes } from '../shared/limits'
import {
  dayPhrase,
  draftFlows,
  estimated,
  draftPlans,
  planDates,
  planFlows,
  planName,
  shiftSampleExport,
  type DraftPlan,
} from '../shared/onboarding'
import type {
  Cadence,
  DateOrder,
  FinancialProfile,
  ImportPreview,
  ScheduledFlow,
} from '../shared/types'
import { api } from './api'
import { ConnectedSource } from './ConnectPayPal'
import type { ConnectedSummary } from './ConnectPayPal'
import type { AppState } from './contract'
import { isActive } from './contract'
import { cadenceLabel, flowIcon } from './engine'
import { cx, dayLabel, displayName, money, shortDate } from './format'
import { Alert, Button, DateStepper, Disc, Field, Ring } from './ui'

/** A chosen PayPal activity export. The text stays in memory only; raw CSV files aren't saved. */
export interface ChosenFile {
  csv: string
  name: string
  /** The bundled, fictional sample export. */
  sample?: boolean
  /** Read from PayPal through Connect PayPal rather than chosen as a file. */
  connected?: ConnectedSummary
}

export const SAMPLE_FILE_NAME = 'Sample PayPal export (fictional)'
/** The made-up rent the sample review offers, as a bill paid from a bank. */
const SAMPLE_RENT_ID = 'you-sample-rent'
/** The sample's money available and cushion: the review prefills them, both editable. */
const SAMPLE_FUNDS = { balance: '1800.00', cushion: '300.00' }
export const PRIVACY_LINE =
  'With a CSV, you choose the file: there’s no PayPal login and no account link. Raw CSV files aren’t saved: Worth reads the file in this session.'
/** The review's privacy line for activity read through Connect PayPal instead of a file. */
export const CONNECTED_PRIVACY_LINE =
  'Worth read this through PayPal’s MCP server with one read-only tool, and keeps the connection only to refresh your activity; disconnect in Settings.'
/** Connected activity shorter than this doesn't pre-fill everyday spending. */
export const SHORT_COVERAGE_DAYS = 14
const ESTIMATE_NOTE =
  'Pay in 4 dates are Worth’s estimate from your PayPal activity, about every 2 weeks. PayPal sets the actual schedule.'

/** Loads the bundled sample export, moved so it ends yesterday. */
export async function loadSampleExport(today: string): Promise<ChosenFile> {
  const { default: csv } = await import('./sample/paypal-activity-sample.csv?raw')
  return { csv: shiftSampleExport(csv, today), name: SAMPLE_FILE_NAME, sample: true }
}

/** The plan's real calendar day: the demo clock pins only the sample, never an import. */
export const realToday = (state: AppState) =>
  state.demoClock ? todayInTimezone(state.profile.timezone) : state.today

/** The three plain steps of PayPal's own Activity → Statements → Download. */
export function HowTo() {
  return (
    <ol className="howto">
      <li>
        <span>
          Log in at <b>paypal.com</b> and open <b>Activity</b>.
        </span>
      </li>
      <li>
        <span>
          Choose <b>Statements</b> <span aria-hidden="true">›</span> <b>Download</b>. It’s next to
          the search box.
        </span>
      </li>
      <li>
        <span>
          Pick <b>CSV</b> and the <b>last 90 days</b>, then save the file.
        </span>
      </li>
    </ol>
  )
}

/** Reads a chosen or dropped CSV in the browser, within the import's 1 MB limit. */
export function useCsvFile(onFile: (file: ChosenFile) => void) {
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  async function read(file: File | undefined) {
    if (!file) return
    setError('')
    if (file.size > CSV_IMPORT_LIMITS.maxBytes)
      return setError('Choose a CSV smaller than 1 MB. A recent 90-day export is a good start.')
    setReading(true)
    try {
      const csv = await file.text()
      if (utf8Bytes(csv) > CSV_IMPORT_LIMITS.maxBytes) return setError(CSV_SIZE_MESSAGE)
      onFile({ csv, name: file.name })
    } catch {
      setError('This file could not be read. Try choosing it again.')
    } finally {
      setReading(false)
    }
  }
  return { read, error, setError, reading }
}

/** Drag-and-drop on any element: a dropped file is read like a chosen one. */
export function useDrop(read: (file: File | undefined) => void, disabled?: boolean) {
  const [over, setOver] = useState(false)
  return {
    over,
    handlers: {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        event.preventDefault()
        setOver(true)
      },
      onDragLeave: () => setOver(false),
      onDrop: (event: DragEvent<HTMLElement>) => {
        event.preventDefault()
        setOver(false)
        if (!disabled) read(event.dataTransfer.files?.[0])
      },
    },
  }
}

/** "Choose your PayPal CSV": a button over the native file control, for keyboards and readers. */
export function ChooseFile({
  read,
  disabled,
  children,
}: {
  read: (file: File | undefined) => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <label className={cx('btn btn-primary file-btn', disabled && 'is-disabled')}>
      <FileUp className="ico" aria-hidden="true" />
      {children}
      <input
        className="sr"
        type="file"
        accept=".csv,text/csv"
        aria-label="Choose your PayPal activity CSV"
        disabled={disabled}
        onChange={(event) => {
          read(event.target.files?.[0])
          event.target.value = ''
        }}
      />
    </label>
  )
}

export function FileError({ children }: { children: string }) {
  return (
    <p className="field-error" role="alert">
      <CircleAlert size={16} aria-hidden="true" style={{ flex: 'none', marginTop: 2 }} />
      {children}
    </p>
  )
}

/** The drop zone of the full import page: drop a file on wide screens, or choose it. */
function DropZone({
  onFile,
  disabled,
}: {
  onFile: (file: ChosenFile) => void
  disabled?: boolean
}) {
  const { read, error, reading } = useCsvFile(onFile)
  const { over, handlers } = useDrop((file) => void read(file), disabled)
  return (
    <div className={cx('drop', over && 'over')} {...handlers}>
      <span className="co-ic" aria-hidden="true">
        <FileUp className="ico" />
      </span>
      <p className="t hide-m">Drop your PayPal activity CSV here</p>
      <p className="t show-m">Choose the CSV you downloaded</p>
      <p className="meta hide-m">or</p>
      <ChooseFile read={(file) => void read(file)} disabled={disabled || reading}>
        Choose your PayPal CSV
      </ChooseFile>
      <p className="caption">English-language export in USD · up to 1 MB</p>
      {error && <FileError>{error}</FileError>}
    </div>
  )
}

/**
 * "Start with your PayPal activity": the first-run card on the sample Home (P3a). Compact at every
 * width, so the room-to-spend figure and the first starter stay above the fold; on a phone it is the
 * title and two short buttons. A CSV can also be dropped on it. PayPal's download steps, the
 * privacy line and, on a phone, "Enter your bills yourself" sit behind a disclosure.
 */
export function StartCard({
  state,
  onFile,
  onEnterYourself,
}: {
  state: AppState
  onFile: (file: ChosenFile) => void
  onEnterYourself: () => void
}) {
  const [loading, setLoading] = useState(false)
  const busy = state.purchases.some(isActive)
  const { read, error, setError, reading } = useCsvFile(onFile)
  const { over, handlers } = useDrop((file) => void read(file), busy)
  async function sample() {
    setError('')
    setLoading(true)
    try {
      onFile(await loadSampleExport(realToday(state)))
    } catch {
      setError('The sample export could not load. Try again.')
    } finally {
      setLoading(false)
    }
  }
  return (
    <section
      className={cx('tile start-card', over && 'over')}
      aria-labelledby="start-title"
      {...handlers}
    >
      <div className="start-head">
        <h2 className="h-section" id="start-title">
          Start with your PayPal activity
        </h2>
        <p className="meta hide-m">
          You’re viewing a sample month. Bring your PayPal activity to see your own.
        </p>
      </div>
      {busy && (
        <Alert tone="warn" icon={CircleAlert}>
          Finish or cancel your active checkout before importing PayPal activity.
        </Alert>
      )}
      <div className="start-actions">
        <ChooseFile read={(file) => void read(file)} disabled={busy || reading}>
          <span className="hide-m">Choose your PayPal CSV</span>
          <span className="show-m">Choose CSV</span>
        </ChooseFile>
        <Button
          variant="secondary"
          icon={FileText}
          loading={loading}
          disabled={busy || loading}
          onClick={() => void sample()}
        >
          <span className="hide-m">Try with a sample PayPal export</span>
          <span className="show-m">Try a sample</span>
        </Button>
      </div>
      {error && <FileError>{error}</FileError>}
      <div className="start-foot">
        <details className="quiet-details start-how">
          {/* On a phone the summary is an icon at the card's top right, keeping the card one row. */}
          <summary>
            <span className="how-label">How to get the file from PayPal</span>
          </summary>
          <div className="stack tight">
            <HowTo />
            <p className="caption">
              {PRIVACY_LINE} English-language export in USD, up to 1 MB. A few minutes.
            </p>
            <button type="button" className="link show-m" onClick={onEnterYourself}>
              Enter your bills yourself
            </button>
          </div>
        </details>
        <button type="button" className="link hide-m" onClick={onEnterYourself}>
          Enter your bills yourself
        </button>
      </div>
    </section>
  )
}

/**
 * Chips that pick one answer, as an ARIA radio group: one tab stop (the chosen chip, or the first),
 * and the arrow keys move and choose.
 */
function ChipGroup<T>({
  options,
  value,
  onChange,
  labelledBy,
  disabled,
  className = 'seg',
}: {
  options: [T, string][]
  value: T | undefined
  onChange: (value: T) => void
  labelledBy: string
  disabled?: boolean
  className?: string
}) {
  const current = options.findIndex(([option]) => option === value)
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
    if (!step) return
    event.preventDefault()
    const next = (Math.max(current, 0) + step + options.length) % options.length
    onChange(options[next]![0])
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    buttons[next]?.focus()
  }
  return (
    <div className={className} role="radiogroup" aria-labelledby={labelledBy} onKeyDown={move}>
      {options.map(([option, text], index) => (
        <button
          key={text}
          type="button"
          role="radio"
          disabled={disabled}
          aria-checked={option === value}
          tabIndex={index === Math.max(current, 0) ? 0 : -1}
          onClick={() => onChange(option)}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

const ordinal = (day: number) => {
  const tens = day % 100
  const suffix =
    tens >= 11 && tens <= 13 ? 'th' : (({ 1: 'st', 2: 'nd', 3: 'rd' } as const)[day % 10] ?? 'th')
  return `${day}${suffix}`
}
/** "Monthly on the 13th · next about Tue, Oct 13"; only Worth's estimated dates say "about". */
function schedule(flow: ScheduledFlow) {
  const about = estimated(flow) ? 'about ' : ''
  const day = flow.anchorDay ?? Number(flow.nextDate.slice(8, 10))
  const repeat =
    flow.cadence === 'monthly'
      ? `Monthly on the ${day === 'last' ? 'last day' : ordinal(day)}`
      : cadenceLabel(flow)
  return `${repeat} · next ${about}${dayLabel(flow.nextDate)}`
}
const CADENCES: [Cadence, string][] = [
  ['weekly', 'Weekly'],
  ['biweekly', 'Every other week'],
  ['monthly', 'Monthly'],
]
function readCents(value: string): number | undefined {
  const plain = value.trim().replace(/[$,\s]/g, '')
  if (!/^\d+(?:\.\d{1,2})?$/.test(plain)) return undefined
  const cents = Math.round(Number(plain) * 100)
  return cents <= 100_000_000 ? cents : undefined
}
const asInput = (cents: number) => (cents / 100).toFixed(2)

function OriginTag({ origin }: { origin?: ScheduledFlow['origin'] }) {
  return (
    <span className={cx('origin-tag', origin === 'paypal' && 'paypal')}>
      {origin === 'paypal' ? 'From PayPal' : 'You added'}
    </span>
  )
}

function SectionHead({ id, title, count }: { id: string; title: string; count?: string }) {
  return (
    <div className="found-h">
      <h2 className="h-section" id={id}>
        {title}
      </h2>
      {count && (
        <span className="pill sug">
          <FileUp size={14} aria-hidden="true" /> {count}
        </span>
      )}
    </div>
  )
}

/** One reviewed row: tick to include, the amount and its origin, and a small inline edit. */
function FoundRow({
  flow,
  today,
  disabled,
  onChange,
}: {
  flow: ScheduledFlow
  today: string
  disabled: boolean
  onChange: (flow: ScheduledFlow) => void
}) {
  const [editing, setEditing] = useState(false)
  const [amount, setAmount] = useState(asInput(flow.amountCents))
  const [date, setDate] = useState(flow.nextDate)
  const [error, setError] = useState('')
  const name = displayName(flow.name)
  const income = flow.kind === 'income'
  function done() {
    const cents = readCents(amount)
    if (cents === undefined) return setError(`Enter an amount for ${name}, such as 65.00.`)
    setError('')
    // An edited item is still from PayPal; a date the user set is theirs, not an estimate.
    onChange({
      ...flow,
      amountCents: cents,
      nextDate: date,
      ...(flow.userDate || date !== flow.nextDate ? { userDate: true } : {}),
    })
    setEditing(false)
  }
  return (
    <div className={cx('found-row', !flow.active && 'off')}>
      <input
        type="checkbox"
        className="found-check"
        checked={flow.active}
        disabled={disabled}
        aria-label={`Include ${name}`}
        onChange={(event) => onChange({ ...flow, active: event.target.checked })}
      />
      <Disc icon={flowIcon(flow)} kind={income ? 'income' : undefined} />
      <div className="body">
        <div className="t">{name}</div>
        <div className="s">
          <span className="soft">{schedule(flow)}</span>
        </div>
        {flow.id === SAMPLE_RENT_ID && (
          <p className="caption">
            Made up for the sample, as rent paid from a bank · change or untick it
          </p>
        )}
      </div>
      <div className="end">
        <div className={cx('amt num', income && 'pos')}>
          {income ? `+${money(flow.amountCents)}` : money(flow.amountCents)}
        </div>
        <span className="tagline">
          <OriginTag origin={flow.origin} />
          <button
            type="button"
            className="link edit-link"
            disabled={disabled}
            aria-expanded={editing}
            aria-label={`${editing ? 'Close' : 'Edit'} ${name}`}
            onClick={() => (editing ? done() : setEditing(true))}
          >
            {editing ? 'Done' : 'Edit'}
          </button>
        </span>
      </div>
      {editing && (
        <fieldset className="found-edit">
          <legend className="sr">Edit {name}</legend>
          <div className="form-grid">
            <Field label="Amount, USD" error={error || undefined}>
              <span className="money-input">
                <span aria-hidden="true">$</span>
                <input
                  className="input num"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </span>
            </Field>
            <DateStepper
              label={income ? 'Next payday' : 'Next due date'}
              min={today}
              value={date}
              onChange={setDate}
            />
          </div>
        </fieldset>
      )}
    </div>
  )
}

/** "Add a bill PayPal doesn't see": rent from a bank, say. Recorded as "You added". */
function AddBill({
  today,
  disabled,
  onAdd,
}: {
  today: string
  disabled: boolean
  onAdd: (flow: ScheduledFlow) => void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(today)
  const [cadence, setCadence] = useState<Cadence>('monthly')
  const [error, setError] = useState('')
  function add() {
    const cents = readCents(amount)
    if (!name.trim()) return setError('Name the bill, such as “Rent”.')
    if (!cents) return setError('Enter the bill’s amount, such as 1650.00.')
    onAdd({
      id: `you-${crypto.randomUUID()}`,
      name: name.trim().slice(0, 100),
      amountCents: cents,
      nextDate: date,
      cadence,
      kind: 'bill',
      category: 'Other',
      ...(/\b(rent|mortgage)\b/i.test(name) ? { icon: 'home' } : {}),
      confirmed: true,
      active: true,
      origin: 'you',
    })
    setName('')
    setAmount('')
    setDate(today)
    setError('')
    setOpen(false)
  }
  if (!open)
    return (
      <Button variant="secondary" icon={Plus} disabled={disabled} onClick={() => setOpen(true)}>
        Add a bill PayPal doesn’t see
      </Button>
    )
  return (
    <fieldset className="tile stack tight add-bill" disabled={disabled}>
      <legend className="h-section">Add a bill PayPal doesn’t see</legend>
      <p className="meta">Rent paid from your bank, a loan, anything outside PayPal.</p>
      <div className="form-grid">
        <Field label="Bill name">
          <input
            className="input"
            value={name}
            maxLength={100}
            placeholder="Rent"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Bill amount">
          <span className="money-input">
            <span aria-hidden="true">$</span>
            <input
              className="input num"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </span>
        </Field>
        <DateStepper label="Next due date" min={today} value={date} onChange={setDate} />
      </div>
      <div className="field">
        <span id="bill-often">How often</span>
        <ChipGroup
          options={CADENCES}
          value={cadence}
          onChange={setCadence}
          labelledBy="bill-often"
        />
      </div>
      {error && (
        <p className="field-error" role="alert">
          <CircleAlert size={16} aria-hidden="true" style={{ flex: 'none', marginTop: 2 }} />
          {error}
        </p>
      )}
      <div className="actions">
        <Button onClick={add}>Add bill</Button>
        <Button variant="text" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </fieldset>
  )
}

/** The calm timeline note for a draft plan's first payment next to a bill, from planCollisions. */
type Notes = Map<string, string>
function collisionNotes(profile: FinancialProfile, plans: DraftPlan[], today: string): Notes {
  const notes: Notes = new Map()
  for (const { payment, bill } of planCollisions(profile, [], today)) {
    // Bills only: a small subscription a few days away isn't worth a note.
    if (bill.kind !== 'bill' || notes.has(payment.planId)) continue
    const plan = plans.find((item) => payment.planId === `paypal-plan:${item.id}`.slice(0, 90))
    if (!plan) continue
    const number = plan.seen + planDates(plan, today).indexOf(payment.date) + 1
    notes.set(
      payment.planId,
      `Payment ${number} of ${Math.max(4, plan.seen + (plan.left ?? 0))}: ${money(payment.amountCents)} on ${dayLabel(payment.date)}, ${dayPhrase(bill.daysFromInstalment, displayName(bill.name))}.`,
    )
  }
  return notes
}

export function TimelineNote({ children }: { children: string }) {
  return (
    <p className="tl-note">
      <CalendarClock className="ico" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

/** One Pay in 4 plan in progress, or one to check when the file lacks its purchase. */
function PlanRow({
  plan,
  today,
  note,
  error,
  disabled,
  onChange,
}: {
  plan: DraftPlan
  /** Why Continue stopped here: shown under the question, never under the sticky bar. */
  error?: string
  today: string
  note?: string
  disabled: boolean
  onChange: (plan: DraftPlan) => void
}) {
  const dates = planDates(plan, today)
  if (plan.merchant === null) {
    const answers: [number, string][] = [
      [1, '1 left'],
      [2, '2 left'],
      [0, 'All paid'],
    ]
    const label = `plan-${plan.id}`
    return (
      <div className="found-row plan check-plan" id={`check-plan-${plan.id}`}>
        <Disc icon={CalendarCheck} kind="plan" />
        <div className="body">
          <div className="t" id={label}>
            One more to check: payments of {money(plan.paymentCents)}
          </div>
          <div className="s">
            <span className="soft">
              {plan.seen} Pay in 4 {plan.seen === 1 ? 'payment' : 'payments'} seen, the last on{' '}
              {shortDate(plan.lastDate)}, but not the purchase. How many are left?
            </span>
          </div>
          <ChipGroup
            className="seg chips-seg"
            options={answers}
            value={plan.left}
            onChange={(left) => onChange({ ...plan, left })}
            labelledBy={label}
            disabled={disabled}
          />
          {error && (
            <p className="co-error" role="alert">
              <CircleAlert size={16} aria-hidden="true" style={{ flex: 'none', marginTop: 2 }} />
              {error}
            </p>
          )}
          {plan.left ? (
            <p className="caption">
              Next about {dayLabel(dates[0]!)}
              {dates.length > 1 ? `, then ${dayLabel(dates[1]!)}` : ''}.
            </p>
          ) : null}
          {note && <TimelineNote>{note}</TimelineNote>}
        </div>
      </div>
    )
  }
  const total = Math.max(4, plan.seen + (plan.left ?? 0))
  const name = displayName(plan.merchant)
  const label = plan.title ? `${name} · ${plan.title}` : name
  return (
    <div className={cx('found-row plan', !plan.included && 'off')}>
      <input
        type="checkbox"
        className="found-check"
        checked={plan.included}
        disabled={disabled}
        aria-label={`Include ${name} Pay in 4 plan`}
        onChange={(event) => onChange({ ...plan, included: event.target.checked })}
      />
      <Ring part={plan.seen} of={total} />
      <div className="body">
        <div className="t">{label}</div>
        <div className="s">
          <span className="soft">
            {plan.seen} of {total} paid · {money(plan.paymentCents)} each ·{' '}
            {plan.left === 1 ? 'last one' : 'next'} about {dayLabel(dates[0]!)}
          </span>
        </div>
        {note && plan.included && <TimelineNote>{note}</TimelineNote>}
      </div>
      <div className="end">
        <div className="amt num">{money(plan.purchaseCents!)}</div>
        <span className="origin-tag paypal">From PayPal</span>
      </div>
    </div>
  )
}

/**
 * "Check what Worth found" (P3a, B's step 2 in one screen): what the PayPal export holds, ticked and
 * tagged by origin, the Pay in 4 plans in progress with their timeline note, then the two numbers
 * only the user knows. Continue imports the file and saves the confirmed plan.
 */
export function ImportReview({
  state,
  file,
  onFile,
  onEnterYourself,
  onCancel,
  onImported,
  onDone,
}: {
  state: AppState
  file?: ChosenFile
  onFile: (file: ChosenFile) => void
  onEnterYourself: () => void
  onCancel: () => void
  /** The import went in but the plan didn't save yet: the state to show meanwhile. */
  onImported: (state: AppState) => void
  onDone: (state: AppState) => void
}) {
  const today = realToday(state)
  const heading = useRef<HTMLHeadingElement>(null)
  const [preview, setPreview] = useState<ImportPreview>()
  const [dateOrder, setDateOrder] = useState<DateOrder>()
  const [loadError, setLoadError] = useState('')
  const [flows, setFlows] = useState<ScheduledFlow[]>([])
  const [plans, setPlans] = useState<DraftPlan[]>([])
  const [daily, setDaily] = useState('')
  const [editDaily, setEditDaily] = useState(false)
  const [balance, setBalance] = useState('')
  const [cushion, setCushion] = useState('')
  const [error, setError] = useState<{ text: string; field?: string }>()
  const [busy, setBusy] = useState(false)
  /** After the import commits, a retry only saves the plan. */
  const imported = useRef<AppState | undefined>(undefined)
  const activeCheckout = state.purchases.some(isActive)
  const imports = state.profile.source === 'import'
  // Plans already in an imported profile stay as they are; the file can't add them twice.
  const keptPlans = imports ? state.profile.flows.filter((f) => f.kind === 'installment') : []

  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    if (!file) return
    let cancelled = false
    imported.current = undefined
    api<ImportPreview>('/import/preview', { csv: file.csv, ...(dateOrder ? { dateOrder } : {}) })
      .then((result) => {
        if (cancelled) return
        const existing = imports ? state.profile.flows : []
        const known = new Set(keptPlans.map((flow) => flow.name.toLowerCase()))
        setPreview(result)
        setLoadError('')
        const drafted = draftPlans(result.instalmentPlans).filter(
          (plan) => !known.has(planName(plan).toLowerCase()),
        )
        const flows = draftFlows(result, existing)
        setPlans(drafted)
        // A few days of connected activity (often sandbox test purchases) is no basis for a daily
        // figure: the field starts empty and the user enters one; PayPal's figure is a reference.
        const short = Boolean(file.connected) && result.coverageDays < SHORT_COVERAGE_DAYS
        setDaily(short ? '' : asInput(result.suggestedDailySpendCents))
        setEditDaily(short)
        if (file.sample) {
          // The sample lands on a believable month without guessing: its funds, and a made-up rent
          // the day before the largest plan's next payment, which is what PayPal can't see.
          setBalance(SAMPLE_FUNDS.balance)
          setCushion(SAMPLE_FUNDS.cushion)
          const largest = drafted
            .filter((plan) => plan.merchant && plan.left)
            .sort((a, b) => b.paymentCents - a.paymentCents)[0]
          const next = largest && planDates(largest, today)[0]
          if (next && addDays(next, -1) >= today)
            flows.push({
              id: SAMPLE_RENT_ID,
              name: 'Maple Court rent',
              amountCents: 165000,
              nextDate: addDays(next, -1),
              cadence: 'monthly',
              kind: 'bill',
              category: 'Other',
              icon: 'home',
              confirmed: true,
              active: true,
              origin: 'you',
              userDate: true,
            })
        }
        setFlows(flows)
      })
      .catch((failure: Error) => !cancelled && setLoadError(failure.message))
    return () => {
      cancelled = true
    }
    // The preview depends on the file and the date order only.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [file, dateOrder])

  if (!file)
    return (
      <div className="page plain">
        <div className="wrap narrow stack">
          <h1 className="title" ref={heading} tabIndex={-1}>
            Bring your PayPal activity
          </h1>
          <div className="split">
            <DropZone onFile={onFile} disabled={activeCheckout} />
            <div className="stack tight">
              <h2 className="h-section">Get the file from PayPal</h2>
              <HowTo />
            </div>
          </div>
          <p className="caption">{PRIVACY_LINE}</p>
          <div className="alt-paths">
            <Button
              variant="secondary"
              icon={FileText}
              disabled={activeCheckout}
              onClick={() => void loadSampleExport(today).then(onFile)}
            >
              Try with a sample PayPal export
            </Button>
            <button type="button" className="link" onClick={onEnterYourself}>
              Enter your bills yourself
            </button>
          </div>
        </div>
      </div>
    )

  const finalFlows = [...flows, ...keptPlans, ...plans.flatMap((plan) => planFlows(plan, today))]
  const draft: FinancialProfile = {
    ...state.profile,
    balanceCents: readCents(balance) ?? 0,
    cushionCents: readCents(cushion) ?? 0,
    dailySpendCents: readCents(daily) ?? 0,
    flows: finalFlows,
    snapshotDate: today,
    confirmed: true,
    missingFields: [],
  }
  const notes = collisionNotes(draft, plans, today)
  const dailyFromPayPal = !preview || readCents(daily) === preview.suggestedDailySpendCents
  const shortConnected = Boolean(
    file?.connected && preview && preview.coverageDays < SHORT_COVERAGE_DAYS,
  )
  const paydays = flows.filter((flow) => flow.kind === 'income')
  const bills = flows.filter((flow) => flow.kind !== 'income')
  const fromPayPal = (items: { origin?: string }[]) =>
    items.filter((item) => item.origin === 'paypal').length
  const dated = plans.filter((plan) => plan.merchant !== null)
  const toCheck = plans.filter((plan) => plan.merchant === null)
  const blocked = Boolean(preview && (preview.errors.length || preview.needsDateOrder))
  /** Pay in 4 questions still open: Continue names them instead of failing out of view. */
  const unanswered = toCheck.filter((plan) => plan.left === undefined).length
  const update = (next: ScheduledFlow) => {
    setError(undefined)
    setFlows((all) => all.map((flow) => (flow.id === next.id ? next : flow)))
  }
  const updatePlan = (next: DraftPlan) => {
    setError(undefined)
    setPlans((all) => all.map((plan) => (plan.id === next.id ? next : plan)))
  }

  async function confirm() {
    if (busy || !file || !preview) return
    setError(undefined)
    // The open question comes first, as the button says.
    const open = toCheck.find((plan) => plan.left === undefined)
    if (open) {
      setError({
        text: `Choose how many payments of ${money(open.paymentCents)} are left, or All paid.`,
        field: `plan-${open.id}`,
      })
      // The question may be far above the sticky Continue bar: bring it to the middle of the view.
      const row = document.getElementById(`check-plan-${open.id}`)
      row?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
      row?.querySelector<HTMLElement>('[role="radio"], button')?.focus({ preventScroll: true })
      return
    }
    const balanceCents = readCents(balance)
    const cushionCents = readCents(cushion)
    const dailyCents = readCents(daily)
    if (balanceCents === undefined)
      return setError({
        text: 'Enter your money available today, such as 1800.00.',
        field: 'balance',
      })
    if (cushionCents === undefined)
      return setError({
        text: 'Enter a cushion: the least you want to keep, such as 300.00. It can be 0.',
        field: 'cushion',
      })
    if (dailyCents === undefined)
      return setError({ text: 'Enter your everyday spending a day, such as 35.00.' })
    setBusy(true)
    try {
      imported.current ??= (await api<AppState>('/import/commit', {
        csv: file.csv,
        ...(dateOrder ? { dateOrder } : {}),
      })) as AppState
      const base = imported.current
      const profile: FinancialProfile = {
        ...base.profile,
        balanceCents,
        cushionCents,
        dailySpendCents: dailyCents,
        dailySpendOrigin: dailyCents === preview.suggestedDailySpendCents ? 'paypal' : 'you',
        flows: finalFlows,
        snapshotDate: base.today,
        confirmed: true,
        confirmedAt: new Date().toISOString(),
        // The server keeps any foreign-currency payment still to resolve.
        missingFields: [],
      }
      const saved = (await api<AppState>('/profile', { profile }, 'PATCH')) as AppState
      onDone(saved)
    } catch (failure) {
      if (imported.current) onImported(imported.current)
      setError({ text: (failure as Error).message })
      setBusy(false)
    }
  }

  const dates = preview?.transactions.map((item) => item.date).sort() ?? []
  const range = dates.length ? `${shortDate(dates[0]!)} – ${shortDate(dates.at(-1)!)}` : undefined
  return (
    <div className="page plain import-review">
      <div className="wrap narrow">
        <form onSubmit={(event) => event.preventDefault()} aria-busy={busy || !preview}>
          <div className="sec-head">
            <span className="meta">Step 2 of 2</span>
            <button type="button" className="link" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </div>
          <ol className="steps3" aria-label="Setup steps">
            <li className="on">Bring your PayPal activity</li>
            <li className="on" aria-current="step">
              Check what Worth found
            </li>
          </ol>
          <h1 className="title wizard-step-head" ref={heading} tabIndex={-1}>
            Check what Worth found
          </h1>
          {file.connected ? (
            <ConnectedSource summary={file.connected} />
          ) : (
            <p className="src">
              <FileText className="ico" aria-hidden="true" />
              <b>{file.name}</b>
              {range && <span>· {range}</span>}
              {preview && <span>· {preview.totalRows.toLocaleString('en-US')} rows</span>}
            </p>
          )}
          <p className="meta">
            Untick anything that has ended, and add what you pay outside PayPal.
          </p>

          {activeCheckout && (
            <Alert tone="warn" icon={CircleAlert} live>
              Finish or cancel your active checkout before importing PayPal activity.
            </Alert>
          )}
          {loadError && (
            <Alert tone="bad" icon={CircleAlert} live>
              {loadError}{' '}
              <button type="button" className="link inline" onClick={onCancel}>
                Choose another file
              </button>
            </Alert>
          )}
          {!preview && !loadError && (
            <p className="meta" role="status">
              Reading your PayPal activity…
            </p>
          )}
          {preview && (preview.needsDateOrder || dateOrder) && (
            <fieldset className="import-date-order" disabled={busy}>
              <legend>How does this file write dates?</legend>
              <p className="meta">
                Every date here could be read two ways. Choose the order your PayPal account uses.
              </p>
              {(
                [
                  ['MM/DD', 'Month first, as in the US', '03/04/2026 is March 4'],
                  ['DD/MM', 'Day first, as in the UK', '03/04/2026 is 3 April'],
                ] as const
              ).map(([order, label, example]) => (
                <label className="check" key={order}>
                  <input
                    type="radio"
                    name="review-date-order"
                    checked={dateOrder === order}
                    onChange={() => setDateOrder(order)}
                  />
                  <span>
                    <strong>{label}</strong>
                    <small>{example}</small>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {preview && preview.errors.length > 0 && (
            <div className="alert bad" role="alert">
              <div className="alert-body">
                <strong>This file has {preview.errors.length} rows Worth can’t read.</strong>
                <ul>
                  {preview.errors.slice(0, 5).map((issue, index) => (
                    <li key={`${issue.row}-${index}`}>
                      Row {issue.row}: {issue.message}
                    </li>
                  ))}
                </ul>
                <button type="button" className="link inline" onClick={onCancel}>
                  Choose another file
                </button>
              </div>
            </div>
          )}

          {preview && !blocked && (
            <>
              {preview.unresolved.length > 0 && (
                <Alert tone="info" icon={CircleAlert}>
                  {preview.unresolved.length} foreign-currency{' '}
                  {preview.unresolved.length === 1 ? 'payment needs' : 'payments need'} a USD cost.
                  You’ll resolve {preview.unresolved.length === 1 ? 'it' : 'them'} in Activity after
                  this; until then Worth won’t show room to spend.
                </Alert>
              )}
              <section aria-labelledby="found-paydays">
                <SectionHead
                  id="found-paydays"
                  title="Paydays"
                  count={fromPayPal(paydays) ? `${fromPayPal(paydays)} from PayPal` : undefined}
                />
                {paydays.length ? (
                  <div className="rows">
                    {paydays.map((flow) => (
                      <FoundRow
                        key={flow.id}
                        flow={flow}
                        today={today}
                        disabled={busy}
                        onChange={update}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="meta">
                    No repeating pay in this file. If your pay lands in a bank, you can add it in
                    your plan later.
                  </p>
                )}
              </section>
              <section aria-labelledby="found-bills">
                <SectionHead
                  id="found-bills"
                  title="Bills and subscriptions"
                  count={fromPayPal(bills) ? `${fromPayPal(bills)} from PayPal` : undefined}
                />
                <div className="rows">
                  {bills.map((flow) => (
                    <FoundRow
                      key={flow.id}
                      flow={flow}
                      today={today}
                      disabled={busy}
                      onChange={update}
                    />
                  ))}
                </div>
                <div style={{ marginTop: 'var(--s-3)' }}>
                  <AddBill
                    today={today}
                    disabled={busy}
                    onAdd={(flow) => {
                      setError(undefined)
                      setFlows((all) => [...all, flow])
                    }}
                  />
                </div>
              </section>
              {plans.length > 0 && (
                <section aria-labelledby="found-plans">
                  <SectionHead
                    id="found-plans"
                    title={`PayPal Pay in 4 plans in progress (${dated.length})`}
                    count="From PayPal"
                  />
                  <div className="rows">
                    {[...dated, ...toCheck].map((plan) => (
                      <PlanRow
                        key={plan.id}
                        plan={plan}
                        today={today}
                        note={notes.get(`paypal-plan:${plan.id}`.slice(0, 90))}
                        error={error?.field === `plan-${plan.id}` ? error.text : undefined}
                        disabled={busy}
                        onChange={(next) => {
                          if (error?.field === `plan-${plan.id}`) setError(undefined)
                          updatePlan(next)
                        }}
                      />
                    ))}
                  </div>
                  <p className="caption">{ESTIMATE_NOTE}</p>
                </section>
              )}
              <section aria-labelledby="found-daily">
                <SectionHead
                  id="found-daily"
                  title="Everyday spending"
                  count={dailyFromPayPal ? 'From PayPal' : undefined}
                />
                <div className="found-row">
                  <Disc icon={ReceiptText} />
                  <div className="body">
                    {editDaily ? (
                      <Field label="Everyday spending, $ a day">
                        <span className="money-input">
                          <span aria-hidden="true">$</span>
                          <input
                            className="input num"
                            inputMode="decimal"
                            value={daily}
                            onChange={(event) => setDaily(event.target.value)}
                          />
                        </span>
                      </Field>
                    ) : (
                      <div className="t">
                        {dailyFromPayPal ? 'About ' : ''}
                        {money(readCents(daily) ?? 0)} a day
                      </div>
                    )}
                    <div className="s">
                      <span className="soft">
                        {shortConnected && !dailyFromPayPal
                          ? `PayPal shows about ${money(preview.suggestedDailySpendCents)} a day over ${preview.coverageDays} ${preview.coverageDays === 1 ? 'day' : 'days'}; too short to rely on. Enter what you usually spend.`
                          : dailyFromPayPal
                            ? `Your average over ${preview.coverageDays} days, leaving out the bills and plans above`
                            : `Set by you. PayPal’s average was ${money(preview.suggestedDailySpendCents)} a day.`}
                      </span>
                    </div>
                  </div>
                  <div className="end">
                    <button
                      type="button"
                      className="link edit-link"
                      aria-expanded={editDaily}
                      aria-label={
                        editDaily ? 'Done editing everyday spending' : 'Edit everyday spending'
                      }
                      onClick={() => setEditDaily(!editDaily)}
                    >
                      {editDaily ? 'Done' : 'Edit'}
                    </button>
                  </div>
                </div>
              </section>
              <section aria-labelledby="found-yours">
                <SectionHead id="found-yours" title="What only you know" />
                <p className="meta">Past activity doesn’t set your money available, so enter it.</p>
                <div className="form-grid" style={{ marginTop: 'var(--s-3)' }}>
                  <Field
                    label="Money available today"
                    hint="Leave out credit limits and savings you won’t touch."
                    error={error?.field === 'balance' ? error.text : undefined}
                  >
                    <span className="money-input">
                      <span aria-hidden="true">$</span>
                      <input
                        className="input num"
                        inputMode="decimal"
                        value={balance}
                        aria-invalid={error?.field === 'balance'}
                        onChange={(event) => {
                          setError(undefined)
                          setBalance(event.target.value)
                        }}
                      />
                    </span>
                  </Field>
                  <Field
                    label="Cushion"
                    hint="The least you want to keep in your account."
                    error={error?.field === 'cushion' ? error.text : undefined}
                  >
                    <span className="money-input">
                      <span aria-hidden="true">$</span>
                      <input
                        className="input num"
                        inputMode="decimal"
                        value={cushion}
                        aria-invalid={error?.field === 'cushion'}
                        onChange={(event) => {
                          setError(undefined)
                          setCushion(event.target.value)
                        }}
                      />
                    </span>
                  </Field>
                </div>
              </section>
              <p className="caption" style={{ marginTop: 'var(--s-4)' }}>
                {file.connected ? CONNECTED_PRIVACY_LINE : PRIVACY_LINE} Nothing is saved until you
                continue.
              </p>
            </>
          )}
          {error && !error.field && (
            <p className="co-error" role="alert" style={{ marginTop: 16 }}>
              <CircleAlert size={16} aria-hidden="true" style={{ flex: 'none', marginTop: 2 }} />
              {error.text}
            </p>
          )}
          {error?.field && !error.field.startsWith('plan-') && (
            <p className="sr" role="alert">
              {error.text}
            </p>
          )}
          <div className="wizard-foot">
            <Button variant="secondary" onClick={onCancel} disabled={busy}>
              Back
            </Button>
            <Button
              onClick={() => void confirm()}
              loading={busy}
              disabled={!preview || blocked || activeCheckout}
            >
              {unanswered
                ? `Answer ${unanswered === 1 ? 'the question' : `${unanswered} questions`} above`
                : 'Continue'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
