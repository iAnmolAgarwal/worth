import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  ArrowRight,
  ArrowUp,
  Bookmark,
  BookmarkCheck,
  ChevronDown,
  CircleAlert,
  ListChecks,
  Quote,
  Sparkles,
  X,
} from 'lucide-react'
import { addDays, WAIT_SEARCH_DAYS } from '../shared/finance'
import { linkIn } from '../shared/link'
import type {
  Assessment,
  ChatMessage,
  Interpretation,
  OptionResult,
  Product,
  PurchaseContext,
  SavedItem,
  SignedItem,
  PurchaseCheckLink,
} from '../shared/types'
import { api, ApiError } from './api'
import { alternativeTarget, decisionRequestFrom } from './contract'
import type { AppState, ChatReply, Comparison, SavePlan, SaveTarget } from './contract'
import { SimilarItems } from './Alternatives'
import { PayIn4Row, PayIn4Strip } from './AskTrace'
import { ASSESSMENT_ONLY, claudeUses } from './copy'
import { optionStatus, type DecisionRequest, type Explanation } from './Decision'
import { claudeOn, envLabel, fits, missingFix, useComparison } from './engine'
import { capitalize, cx, dayLabel, fromMoney, money, signed } from './format'
import type { AskOffer } from './AgentLauncher'
import { chartSnapshot, sameItem, sendChartCommand } from './chartControl'
import { Guide, type GuideExpression } from './Guide'
import { countedHold, ReservationNote } from './Reservation'
import { LinkCheck } from './PasteLink'
import { Alert, Button, Field, IconButton, Pill, ReadAsChip, Toggle, type Tone } from './ui'

type OnSave = (target: SaveTarget, plan?: SavePlan) => Promise<SavedItem | undefined>
/** "Read as Everyday camera · $1,199.00 (listed price) · today" for a listed price (fix #3). */
export function priceLabel(read: Interpretation) {
  return read.items.some((item) => item.priceSource === 'catalog')
    ? `${money(read.amountCents)} (listed price)`
    : money(read.amountCents)
}

/**
 * A pasted link's turn (C5): the link, then its confirm card. Neither is ever sent to Claude.
 * `url` is absent when the message held more than one link.
 */
type LinkTurn = {
  url?: string
  confirmed?: DecisionRequest & { amountCents: number; itemName: string }
  cancelled?: boolean
}
/** `trace` is fixed when the answer arrives, so a later switch change never relabels it. */
type Entry = ChatMessage & {
  reply?: ChatReply
  id: number
  trace?: string
  link?: LinkTurn
  /** The item the screen behind offered, sent with this question as quoted data. */
  about?: AskOffer
  /** A chart answer: `moved` the chart on screen, left it as it was, or found no such chart. */
  chartApplied?: ChartResult
}

/** What the chart on screen shows, for the server to check and answer about. */
export function chartView(shown = chartSnapshot()) {
  if (!shown) return undefined
  return {
    screen: 'decision' as const,
    ...(shown.item.productId
      ? { productId: shown.item.productId }
      : { amountCents: shown.item.amountCents, itemName: shown.item.name.slice(0, 150) }),
    options: shown.pressed,
    range: shown.range,
    ...(shown.focusDay ? { focusDay: shown.focusDay } : {}),
  }
}

type ChartResult = 'moved' | 'unchanged' | 'absent'
/** Applies a reply's chart change when the chart for that same item is on screen. */
export function applyChart(reply: ChatReply): ChartResult {
  const target = reply.chart
  if (!target || !sameItem({ ...target.item, itemName: target.item.name }, chartSnapshot()))
    return 'absent'
  const { options, range, focusDay } = target
  const command = {
    ...(options ? { options } : {}),
    ...(range ? { range } : {}),
    ...(focusDay ? { focusDay } : {}),
  }
  if (!Object.keys(command).length) return 'unchanged'
  if (!sendChartCommand(command)) return 'absent'
  showChart()
  return 'moved'
}

/**
 * Brings the chart card into view below the sticky top bar, so its change is seen beside the
 * open panel; it stays put when already in view, and jumps instead of gliding under reduced motion.
 */
function showChart() {
  const chart = document.querySelector('.wchart')
  const card = chart?.closest('section') ?? chart
  if (!card) return
  const top = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0
  const box = card.getBoundingClientRect()
  if (box.top >= top && box.bottom <= window.innerHeight) return
  window.scrollTo?.({
    top: window.scrollY + box.top - top - 12,
    behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ? 'instant'
      : 'smooth',
  })
}

const offerKey = (offer: AskOffer) => `${offer.itemName}|${offer.amountCents}`
export const offerLabel = (offer: AskOffer) =>
  [offer.itemName, money(offer.amountCents), offer.store, offer.verdict].filter(Boolean).join(' · ')
/** Questions about the item on screen: each names it or a timing, so the server keeps to it. */
export const offerStarters = (offer: AskOffer) => [
  `Can I afford the ${offer.itemName} today?`,
  'What if I wait a week?',
  'What bills are due before then?',
]

/** The guide's face for a conversation: thinking while Worth works, then the latest verdict. */
export function moodFor(entries: Entry[], busy: boolean): GuideExpression {
  if (busy) return 'thinking'
  const outcome = entries.at(-1)?.reply?.assessment?.outcome
  return outcome === 'tight' ? 'warning' : outcome === 'fits' ? 'happy' : 'neutral'
}

export const ASK_STARTERS = [
  'Can I afford the $1,899 Halden X5?',
  'How much can I spend today?',
  'What bills are coming up?',
]

/** Follow-ups that stay on the item under discussion: none that name a different price. */
export function matchingSuggestions(reply: ChatReply | undefined) {
  if (!reply) return []
  const amount = reply.interpretation?.amountCents ?? reply.assessment?.amountCents
  return reply.suggestions.filter((text) => {
    const prices = text.match(/\$[\d,]+(?:\.\d{2})?/g)
    return (
      !amount ||
      !prices ||
      prices.every((price) => Math.round(Number(price.replace(/[$,]/g, '')) * 100) === amount)
    )
  })
}

/** Chip labels use typographic apostrophes; the question sent stays as written. */
const curly = (text: string) => text.replace(/'/g, '’')

/** Money in sentences uses a true minus sign: −$458.99. */
export const minus = (text: string) => text.replace(/-\$/g, '−$')

/** Each amount, its minus sign included, stays on one line: "Lowest −$726.74" never breaks. */
export function amountsOnOneLine(text: string): ReactNode {
  const parts = minus(text).split(/(−?\$[\d,]+(?:\.\d{2})?)/)
  return parts.length === 1
    ? text
    : parts.map((part, index) =>
        index % 2 ? (
          <span className="nowrap" key={index}>
            {part}
          </span>
        ) : (
          part
        ),
      )
}

export function itemLabel(read: Interpretation) {
  return capitalize(
    read.items
      .map((item) => (item.quantity > 1 ? `${item.quantity} × ${item.name}` : item.name))
      .join(' + '),
  )
}
export const readAsText = (read: Interpretation) =>
  `${itemLabel(read)} · ${money(read.amountCents)} · ${read.dateLabel}`

/**
 * A catalog item the question is about: same price and a shared word in the name. Unless `strict`,
 * the only item at that price also counts; saving uses `strict`, so a "$1,199 road bike" is never
 * saved as the camera.
 */
export function matchProduct(
  products: Product[],
  name: string,
  amountCents: number,
  strict = false,
) {
  const words = new Set(name.toLowerCase().match(/[a-z]{4,}/g) ?? [])
  const priced = products.filter((product) => product.priceCents === amountCents)
  return (
    priced.find((product) =>
      (product.name.toLowerCase().match(/[a-z]{4,}/g) ?? []).some((word) => words.has(word)),
    ) ?? (!strict && priced.length === 1 ? priced[0] : undefined)
  )
}

/** Claude on for this profile: the server's rule, read from state. */
export const claudeAllowed = claudeOn

function traceText(reply: ChatReply, state: AppState) {
  // One caption for every answer, so the source reads the same each time.
  if (reply.mode === 'anthropic') return 'Claude read your question · every number is Worth’s'
  return claudeAllowed(state)
    ? 'Worth’s own calculation · assistant unavailable for this answer'
    : 'Worth’s own calculation · assistant off'
}

/** The answer's own text; the refusal and the facts Claude picked are shown separately. */
function paragraphs(reply: ChatReply) {
  const chosen =
    reply.points && [reply.lead, ...reply.points.map((p) => p.text)].filter(Boolean).join(' ')
  return reply.message
    .split('\n\n')
    .filter(
      (paragraph) =>
        paragraph !== chosen && paragraph !== reply.explanation && paragraph !== reply.refusal,
    )
}

/**
 * The one sentence under the answer. Claude's own words are marked where they appear (judge F5);
 * the engine's template sentence carries no mark.
 */
function Explanation({ reply }: { reply: ChatReply }) {
  if (!reply.explanation) return null
  const claude = reply.trace?.sentence?.source === 'claude'
  return (
    <p className="explain">
      {claude && (
        <span className="claude-note">
          <Sparkles className="ico" aria-hidden="true" />
          Claude’s note · Worth’s numbers
        </span>
      )}
      {amountsOnOneLine(reply.explanation)}
    </p>
  )
}

/** The comparison an assessed answer opens: the store item, or the amount and name as read. */
function requestFor(reply: ChatReply, state: AppState): DecisionRequest {
  const assessment = reply.assessment!
  const amountCents = reply.interpretation?.amountCents ?? assessment.amountCents
  const name = reply.interpretation ? itemLabel(reply.interpretation) : assessment.itemName
  const product = matchProduct(state.products, name, amountCents)
  // The budget the person stated caps Something cheaper on the comparison too (judge B8 #7).
  const budget = reply.budgetCents !== undefined ? { budgetCents: reply.budgetCents } : {}
  return product
    ? { productId: product.id, ...budget }
    : { amountCents, itemName: name.slice(0, 150), ...budget }
}

/** The verdict's first sentence as the headline, and the rest. "$1,199.00" never splits. */
export function splitVerdict(verdict: string): [string, string] {
  const match = /^(.+?[.!?])\s+(?=[A-Z])/.exec(verdict)
  return match ? [match[1]!, verdict.slice(match[0].length)] : [verdict, '']
}

const status = (option: OptionResult) => {
  const { tone, text } = optionStatus(option)
  return [tone, text] as const
}

function OptionRows({ c, at, budget }: { c: Comparison; at?: Assessment; budget?: number }) {
  // A question about a later day is answered for that day; waiting and spending less still
  // count from today.
  const later = at && at.purchaseDate !== c.today ? at : undefined
  const buy: OptionResult = later ? { ...later, lowPointCause: null } : c.buyToday
  const day = later ? dayLabel(later.purchaseDate) : 'today'
  const room = later ? later.maxAffordableCents : c.spendLess.maxPriceCents
  // A budget the person stated caps spending less (judge round 3 #8); the comparison may already
  // be capped at it.
  const withinBudget = budget !== undefined && budget <= room
  const maxCents = withinBudget ? budget : room
  const overBudget = budget !== undefined && at !== undefined && budget < at.amountCents
  const recommendation = later ? (fits(buy) ? 'buyToday' : c.recommendation) : c.recommendation
  // Each row states its status once: as a pill when there is one, otherwise in words.
  const lowest = (option: OptionResult) =>
    `Lowest point ${minus(signed(option.lowestBalanceCents))} · ${dayLabel(option.lowestDate)}`
  const rows: { key: string; title: string; sub: string; pill?: readonly [Tone, string] }[] = [
    {
      key: 'buyToday',
      title: later ? `Buy ${day}` : 'Buy today',
      sub: lowest(buy),
      pill: status(buy),
    },
    fits(buy)
      ? { key: 'wait', title: 'Wait', sub: `Not needed: it fits ${day}` }
      : c.wait.date
        ? {
            key: 'wait',
            title: `Wait until ${dayLabel(c.wait.date)}`,
            sub: `${lowest(c.wait)}${c.wait.stressLowestCents < c.cushionCents ? ' · tight' : ''}`,
            pill: status(c.wait),
          }
        : { key: 'wait', title: 'Wait', sub: 'No date in the next 35 days fits' },
    maxCents > 0
      ? {
          key: 'spendLess',
          title: 'Something cheaper',
          sub: `Up to ${money(maxCents)} ${later ? `on ${day}` : 'today'}${withinBudget ? ' · your budget' : ''}`,
          // As on the Decision page's Something cheaper card: up to this amount fits.
          pill: withinBudget
            ? (['ok', 'Within your budget'] as const)
            : (['ok', later ? 'Fits that day' : 'Fits today'] as const),
        }
      : { key: 'spendLess', title: 'Something cheaper', sub: `Nothing fits ${day}` },
  ]
  // Spending less only matters when the item doesn't fit as it is, or is over the budget.
  const shown = fits(buy) && !overBudget ? rows.filter((row) => row.key !== 'spendLess') : rows
  return (
    <div className="rows mini-opts" role="list" aria-label="Your options">
      {shown.map((row) => (
        <div className="row" role="listitem" key={row.key}>
          <div className="body">
            <div className="t">
              {row.title}
              {recommendation === row.key && row.pill && (
                <span className="tag-rec">Recommended</span>
              )}
            </div>
            <div className="s">
              <span className="soft">{row.sub}</span>
            </div>
          </div>
          {row.pill && <Pill tone={row.pill[0]}>{row.pill[1]}</Pill>}
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
  onSave,
  onNavigate,
  onOpenCheckout,
}: {
  reply: ChatReply
  state: AppState
  stale: boolean
  busy: boolean
  onRecheck: () => void
  onOpen: (request: DecisionRequest) => void
  onSave?: OnSave
  onNavigate: (hash: string) => void
  onOpenCheckout: (purchaseId: string) => void
}) {
  const [saved, setSaved] = useState<SavedItem>()
  const [saving, setSaving] = useState(false)
  const assessment = reply.assessment!
  const amountCents = reply.interpretation?.amountCents ?? assessment.amountCents
  const name = reply.interpretation ? itemLabel(reply.interpretation) : assessment.itemName
  const product = matchProduct(state.products, name, amountCents)
  const request = requestFor(reply, state)
  const { comparison } = useComparison(
    assessment.outcome === 'incomplete' ? null : request,
    state.profile.version,
  )
  // "Save for later" for any assessed item (A3): store items by product, anything else as an
  // assessment only, with the date the comparison suggests when waiting is the plan.
  const waitDate =
    comparison?.recommendation === 'wait' ? (comparison.wait.date ?? undefined) : undefined
  const stored = matchProduct(state.products, name, amountCents, true)
  const target: SaveTarget = stored
    ? { kind: 'catalog', productId: stored.id }
    : { kind: 'custom', name: name.slice(0, 120), amountCents }
  const hold = countedHold(state, { productId: product?.id, itemName: name, amountCents })
  const [headline, rest] = splitVerdict(reply.verdict ?? paragraphs(reply)[0] ?? '')
  async function save() {
    if (!onSave) return
    setSaving(true)
    const item = await onSave(
      target,
      waitDate
        ? { waitDate }
        : comparison?.recommendation
          ? { option: comparison.recommendation }
          : {},
    )
    setSaving(false)
    if (item) setSaved(item)
  }
  return (
    <section
      className="tile"
      style={{ width: '100%', padding: 'var(--s-5)' }}
      aria-label="Purchase assessment"
    >
      <p className="verdict">{amountsOnOneLine(headline)}</p>
      {/* The rest of the verdict repeats the option rows; it shows only when they can't. */}
      {rest && !comparison && <p className="meta">{amountsOnOneLine(rest)}</p>}
      <Explanation reply={reply} />
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
        <OptionRows c={comparison} at={assessment} budget={reply.budgetCents} />
      ) : assessment.outcome !== 'incomplete' ? (
        <div className="stack tight" style={{ marginTop: 16 }} aria-hidden="true">
          <span className="sk" style={{ width: '70%' }} />
          <span className="sk" style={{ width: '50%' }} />
          <span className="sk" style={{ width: '60%' }} />
        </div>
      ) : null}
      {/* "See the comparison" below is the one link to the comparison. */}
      {reply.payIn4 && !reply.payIn4.asked && <PayIn4Row p4={reply.payIn4} />}
      {hold && (
        <div style={{ marginTop: 'var(--s-2)' }}>
          <ReservationNote purchase={hold} onReview={(p) => onOpenCheckout(p.id)} />
        </div>
      )}
      <div className="actions" style={{ marginTop: 'var(--s-2)', gap: 'var(--s-4)' }}>
        {assessment.outcome !== 'incomplete' && (
          <button type="button" className="link" onClick={() => onOpen(request)}>
            See the comparison <ArrowRight size={16} aria-hidden="true" />
          </button>
        )}
        {onSave &&
          (saved ? (
            <span className="meta" role="status" style={{ display: 'inline-flex', gap: 6 }}>
              <BookmarkCheck size={16} aria-hidden="true" style={{ marginTop: 2 }} />
              {saved.waitDate ? `Saved for ${dayLabel(saved.waitDate)}` : 'Saved'} ·{' '}
              <button
                type="button"
                className="link"
                style={{ minHeight: 0, fontSize: 'inherit' }}
                onClick={() => onNavigate('saved')}
              >
                View in Saved
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="link"
              disabled={saving || (assessment.outcome !== 'incomplete' && !comparison)}
              onClick={() => void save()}
            >
              <Bookmark size={16} aria-hidden="true" />
              {waitDate ? `Save for ${dayLabel(waitDate)}` : 'Save for later'}
            </button>
          ))}
      </div>
      {saved?.kind === 'custom' && <p className="caption">{ASSESSMENT_ONLY}.</p>}
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
          max={addDays(today, WAIT_SEARCH_DAYS)}
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

/**
 * Worth's own comparison for an item the person asked to buy (decision 0.2). Worth prepares no
 * order: they choose there, and Worth's PayPal sandbox checkout opens only behind its guards.
 */
function PurchaseCheck({ link, onOpen }: { link: PurchaseCheckLink; onOpen: () => void }) {
  return (
    <section
      className="tile"
      style={{ width: '100%' }}
      aria-label={`Decide on the ${link.itemName}`}
    >
      <div className="h-section">
        {link.itemName}, {money(link.amountCents)}
      </div>
      {link.waitDate && (
        <p className="meta" style={{ marginTop: 4 }}>
          Worth suggests waiting until {dayLabel(link.waitDate)}.
        </p>
      )}
      <p className="meta" style={{ marginTop: 4 }}>
        Compare buying it today, waiting or saving it. Nothing is bought until you choose.
      </p>
      <div className="actions" style={{ marginTop: 12 }}>
        <a
          className="btn btn-primary"
          href={link.href}
          onClick={(event) => {
            event.preventDefault()
            onOpen()
          }}
        >
          Open Worth’s comparison
        </a>
      </div>
    </section>
  )
}

export function ClaudeSwitch({
  state,
  onUpdate,
  label = 'Use the assistant (powered by Claude)',
  compact,
  bare,
}: {
  state: AppState
  onUpdate?: (state: AppState) => void
  label?: string
  compact?: boolean
  /** Only the switch, for a settings row that shows its own label and line. */
  bare?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const note =
    state.config.ai !== 'anthropic'
      ? 'The assistant isn’t connected here, so answers use Worth’s own calculation.'
      : claudeOn(state)
        ? 'On: Claude reads your question, picks which of Worth’s facts to show and adds one checked sentence. Every number is Worth’s.'
        : 'Off: answers still work, using Worth’s own calculation.'
  const noteId = useId()
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
  if (bare)
    return (
      <>
        {toggle}
        <span className="sr" id={noteId}>
          {note}
        </span>
        {error && (
          <span className="co-error" role="alert">
            {error}
          </span>
        )}
      </>
    )
  if (compact)
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <span
          className="strong"
          style={{ fontWeight: 600, fontSize: 'var(--fs-meta)' }}
          aria-hidden="true"
        >
          Assistant
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
          Assistant
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

/** A pasted link's answer: the confirm card, or what became of it. */
function LinkAnswer({
  turn,
  onConfirm,
  onCancel,
  onOpen,
}: {
  turn: LinkTurn
  onConfirm: (request: NonNullable<LinkTurn['confirmed']>) => void
  onCancel: () => void
  onOpen: (request: DecisionRequest) => void
}) {
  if (!turn.url)
    return <p>Paste one product link at a time, and Worth will read it with Channel3.</p>
  if (turn.cancelled) return <p className="meta">Cancelled. Nothing was checked.</p>
  if (turn.confirmed)
    return (
      <div className="stack tight">
        <p>
          You confirmed {turn.confirmed.itemName} at {money(turn.confirmed.amountCents)}.
        </p>
        <div>
          <Button variant="secondary" icon={ArrowRight} onClick={() => onOpen(turn.confirmed!)}>
            See your options
          </Button>
        </div>
      </div>
    )
  return <LinkCheck url={turn.url} onConfirm={onConfirm} onCancel={onCancel} />
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
  onSave,
  layout = 'page',
  offer,
  onMood,
}: {
  state: AppState
  initialPrompt?: { text: string; id: number }
  visible: boolean
  /** `panel`: inside the guide's floating panel, with no side rail and compact spacing. */
  layout?: 'page' | 'panel'
  /** The item on the screen behind the panel, offered as a chip to ask about. */
  offer?: AskOffer
  /** Called when the guide's face should change. */
  onMood?: (mood: GuideExpression) => void
  onUpdate?: (state: AppState) => void
  onSessionChange?: () => void
  onOpenDecision: (request: DecisionRequest, explanation?: Explanation) => void
  onOpenCheckout: (purchaseId: string) => void
  onNavigate: (hash: string) => void
  onSave?: OnSave
}) {
  const [entries, setEntries] = useState<Entry[]>([])
  /** Every item this conversation assessed, so a later question can return to it (fix #3). */
  const remembered = useRef<SignedItem[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<number>()
  const [context, setContext] = useState<PurchaseContext>()
  /** The offered item this conversation already asked about, or the person removed. */
  const [usedOffer, setUsedOffer] = useState<string>()
  const lastPrompt = useRef(0)
  const inFlight = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const latest = useRef<HTMLDivElement>(null)
  const entriesRef = useRef(entries)
  const contextRef = useRef(context)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])
  useEffect(() => {
    entriesRef.current = entries
  }, [entries])
  useEffect(() => {
    contextRef.current = context
  }, [context])

  const send = useCallback(
    async (text: string, explicit?: PurchaseContext) => {
      if (inFlight.current || !text.trim()) return
      // A pasted link goes to Channel3's lookup and a confirm card, never to Claude (C5).
      const pasted = linkIn(text)
      if (pasted.kind !== 'none') {
        const id = Date.now()
        setError('')
        setMessage('')
        setEditing(undefined)
        setEntries((prev) => [
          ...prev,
          { role: 'user', content: text, id, link: {} },
          {
            role: 'assistant',
            content: '',
            id: id + 1,
            link: pasted.kind === 'one' ? { url: pasted.url } : {},
          },
        ])
        return
      }
      inFlight.current = true
      setBusy(true)
      setError('')
      setMessage('')
      setEditing(undefined)
      const history = entriesRef.current
        .filter((entry) => !entry.link)
        .slice(-12)
        .map(({ role, content }) => ({ role, content: content.slice(0, 4000) }))
      // The item on screen goes with the question as quoted data, never as the question's words.
      const about = !explicit && offer && usedOffer !== offerKey(offer) ? offer : undefined
      if (about) setUsedOffer(offerKey(about))
      const purchase: PurchaseContext | undefined =
        explicit ??
        (about ? { amountCents: about.amountCents, itemName: about.itemName } : contextRef.current)
      setEntries((prev) => [...prev, { role: 'user', content: text, id: Date.now(), about }])
      try {
        const reply = (await api<ChatReply>('/chat', {
          message: text,
          sessionKey: state.sessionKey,
          history,
          context: purchase,
          ...(remembered.current.length ? { items: remembered.current } : {}),
          ...(chartView() ? { view: chartView() } : {}),
        })) as ChatReply
        const chartApplied = reply.chart ? applyChart(reply) : undefined
        // Later questions stay about the chart's item, as they would after a purchase answer.
        if (reply.chart && !reply.interpretation && !reply.assessment)
          setContext({ amountCents: reply.chart.item.amountCents, itemName: reply.chart.item.name })
        // The server signs each assessed item; only signed items count when sent back.
        if (reply.remember) {
          const item = reply.remember
          remembered.current = [
            ...remembered.current.filter(
              (known) => known.itemName !== item.itemName || known.amountCents !== item.amountCents,
            ),
            item,
          ].slice(-12)
        }
        setEntries((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: reply.message,
            reply,
            id: Date.now() + 1,
            trace: traceText(reply, stateRef.current),
            ...(chartApplied !== undefined ? { chartApplied } : {}),
          },
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
      } catch (failure) {
        if (failure instanceof ApiError && failure.code === 'SESSION_CHANGED') {
          setEntries([])
          setContext(undefined)
          remembered.current = []
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
    [state.sessionKey, onSessionChange, offer, usedOffer],
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

  const mood = moodFor(entries, busy)
  useEffect(() => {
    onMood?.(mood)
  }, [mood, onMood])

  const update = (id: number, link: LinkTurn) =>
    setEntries((prev) => prev.map((entry) => (entry.id === id ? { ...entry, link } : entry)))
  const startOver = () => {
    // A fresh conversation offers the item on screen again.
    setUsedOffer(undefined)
    setEntries([])
    setContext(undefined)
    remembered.current = []
    setError('')
  }
  const lastId = entries.at(-1)?.id
  const panel = layout === 'panel'
  const offered = offer && usedOffer !== offerKey(offer) ? offer : undefined
  const head = (
    <div className="bot-head">
      <span className="bot-av" aria-hidden="true">
        <Guide size={28} expression="neutral" />
      </span>
      Worth
    </div>
  )
  const conversation = (
    <>
      <div className="thread" aria-live="polite" aria-relevant="additions">
        {entries.length === 0 && (
          <div className="bot">
            {head}
            <p>
              {offered
                ? `Ask about the ${offered.itemName}, or anything else.`
                : 'What are you thinking of buying?'}
            </p>
            <div className="chips">
              {(offered ? offerStarters(offered) : ASK_STARTERS).map((text) => (
                <button
                  type="button"
                  key={text}
                  className="chip-suggest"
                  onClick={() => void send(text)}
                >
                  {curly(text)}
                </button>
              ))}
            </div>
          </div>
        )}
        {entries.map((entry) =>
          entry.role === 'user' ? (
            <div className="bubble-user" key={entry.id}>
              {entry.about && (
                <span className="bubble-about">
                  <Quote className="ico" aria-hidden="true" />
                  <span className="sr">About </span>
                  {offerLabel(entry.about)}
                </span>
              )}
              {entry.content}
            </div>
          ) : (
            <div
              className="bot enter"
              key={entry.id}
              ref={entry.id === lastId ? latest : undefined}
            >
              {head}
              {entry.link ? (
                <LinkAnswer
                  turn={entry.link}
                  onConfirm={(request) => {
                    update(entry.id, { ...entry.link, confirmed: request })
                    // Follow-up questions are about the confirmed item, as data only.
                    setContext({
                      amountCents: request.amountCents,
                      itemName: request.itemName,
                    })
                    onOpenDecision(request)
                  }}
                  onCancel={() => {
                    update(entry.id, { ...entry.link, cancelled: true })
                    input.current?.focus()
                  }}
                  onOpen={onOpenDecision}
                />
              ) : (
                <Answer
                  entry={entry}
                  state={state}
                  busy={busy}
                  last={entry.id === lastId}
                  panel={panel}
                  editing={editing === entry.id}
                  onEdit={() => setEditing(entry.id)}
                  onCancelEdit={() => setEditing(undefined)}
                  onSend={(text, next) => void send(text, next)}
                  onAnswer={() => input.current?.focus()}
                  onOpenDecision={onOpenDecision}
                  onOpenCheckout={onOpenCheckout}
                  onNavigate={onNavigate}
                  onSave={onSave}
                />
              )}
            </div>
          ),
        )}
        {busy && (
          <div className="bot" role="status">
            {head}
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
                    setEntries((prev) => (prev.at(-1)?.role === 'user' ? prev.slice(0, -1) : prev))
                    setTimeout(() => void send(text), 0)
                  }}
                >
                  Try again
                </Button>
              </div>
            )}
          </div>
        )}
        {panel && entries.length > 0 && !busy && (
          <div className="panel-more">
            <div className="chips">
              {(matchingSuggestions(entries.at(-1)?.reply).length
                ? matchingSuggestions(entries.at(-1)?.reply)
                : ASK_STARTERS
              ).map((text) => (
                <button
                  type="button"
                  key={text}
                  className="chip-suggest"
                  onClick={() => void send(text)}
                >
                  {curly(text)}
                </button>
              ))}
            </div>
            <button type="button" className="link" onClick={startOver}>
              Start over
            </button>
          </div>
        )}
        <div ref={bottom} />
      </div>
      <div className="askdock">
        {offered && (
          <div className="offer-chip">
            <span>
              <span className="caption">Ask about</span> {offerLabel(offered)}
            </span>
            <IconButton
              label={`Don’t ask about ${offered.itemName}`}
              icon={X}
              quiet
              onClick={() => setUsedOffer(offerKey(offered))}
            />
          </div>
        )}
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
            placeholder="Ask, or paste a product link"
            onChange={(event) => setMessage(event.target.value)}
          />
          <button className="send" type="submit" aria-label="Send" disabled={busy}>
            <ArrowUp className="ico" strokeWidth={2} aria-hidden="true" />
          </button>
        </form>
        <WhatItSees state={state} onUpdate={onUpdate} />
      </div>
    </>
  )
  if (panel) return <div className="ask-panel">{conversation}</div>
  return (
    <div className="page ask-page">
      <div className="wrap">
        <h1 className="sr">Ask Worth</h1>
        <div className="grid">
          <div>{conversation}</div>
          <aside className="rail hide-m" aria-label="Suggestions">
            {/* The empty thread already offers the starters; the rail adds follow-ups later. */}
            {entries.length > 0 && (
              <section aria-labelledby="try-asking">
                <div className="sec-head">
                  <h2 className="h-section" id="try-asking">
                    Try asking
                  </h2>
                  <button type="button" className="link" disabled={busy} onClick={startOver}>
                    Start over
                  </button>
                </div>
                <div className="chips">
                  {(matchingSuggestions(entries.at(-1)?.reply).length
                    ? matchingSuggestions(entries.at(-1)?.reply)
                    : ASK_STARTERS
                  ).map((text) => (
                    <button
                      type="button"
                      key={text}
                      className="chip-suggest"
                      disabled={busy}
                      onClick={() => void send(text)}
                    >
                      {curly(text)}
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
            )}
          </aside>
        </div>
      </div>
    </div>
  )
}

/**
 * What the assistant sees, behind one disclosure under the composer: the table of what Claude
 * receives and the switch. It no longer takes a rail on desktop or a permanent dock row on phones.
 */
function WhatItSees({
  state,
  onUpdate,
}: {
  state: AppState
  onUpdate?: (state: AppState) => void
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className="dock-line sees" data-open={open}>
      <button
        type="button"
        className="link sees-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {claudeOn(state) ? 'What the assistant sees' : 'Assistant off · what it would see'}
        <ChevronDown className="ico chev" aria-hidden="true" />
      </button>
      <div className="sees-body" id={id} hidden={!open}>
        <dl className="kvlist">
          {claudeUses(claudeOn(state)).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <ClaudeSwitch state={state} onUpdate={onUpdate} />
        <a href="#settings" style={{ fontSize: 'var(--fs-meta)' }}>
          Everything sent to Anthropic (Claude)
        </a>
      </div>
    </div>
  )
}

function Answer({
  entry,
  state,
  busy,
  last,
  panel,
  editing,
  onEdit,
  onCancelEdit,
  onSend,
  onAnswer,
  onOpenDecision,
  onOpenCheckout,
  onNavigate,
  onSave,
}: {
  entry: Entry
  state: AppState
  busy: boolean
  last: boolean
  panel?: boolean
  editing: boolean
  onEdit: () => void
  onCancelEdit: () => void
  onSend: (text: string, context?: PurchaseContext) => void
  onAnswer: () => void
  onOpenDecision: (request: DecisionRequest, explanation?: Explanation) => void
  onOpenCheckout: (purchaseId: string) => void
  onNavigate: (hash: string) => void
  onSave?: OnSave
}) {
  const reply = entry.reply!
  const [allFacts, setAllFacts] = useState(false)
  // Under a verdict with its option rows, Claude's picked facts repeat them, so they fold away.
  const [factsOpen, setFactsOpen] = useState(!reply.assessment)
  const factsId = useId()
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
  // One name for the item everywhere: the catalog's, when the question matches a product.
  const readName = read
    ? (matchProduct(state.products, itemLabel(read), read.amountCents)?.name ?? itemLabel(read))
    : ''
  const assessment = reply.assessment
  const stale =
    Boolean(assessment) &&
    (assessment!.profileVersion !== state.profile.version || assessment!.today !== state.today)
  // The strip already shows the schedule Claude picked, so the list doesn't repeat it.
  const picked = (reply.points ?? []).filter(
    (point) => !(point.id === 'pay_in_4_schedule' && reply.payIn4?.payments.length),
  )
  const explanation: Explanation = {
    lead: [reply.refusal, reply.lead].filter(Boolean).join(' ') || undefined,
    points: reply.points?.map((point) => point.text) ?? [],
    toolCalls: reply.toolCalls,
    mode: reply.mode,
    readAs: read ? `${readName} · ${priceLabel(read)} · today` : undefined,
  }
  return (
    <>
      {reply.refusal && (
        <p className="refusal">
          <span className="sr">Worth won’t suggest this: </span>
          {reply.refusal}
        </p>
      )}
      {read && !editing && (
        <ReadAsChip
          value={`${readName} · ${priceLabel(read!)} · ${read!.dateLabel}`}
          onAction={onEdit}
          disabled={busy}
        />
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
          onSave={onSave}
          onNavigate={onNavigate}
          onOpenCheckout={onOpenCheckout}
        />
      ) : (
        <>
          {paragraphs(reply).map((text, index) => (
            <p key={index}>{amountsOnOneLine(text)}</p>
          ))}
          <Explanation reply={reply} />
          {reply.chart &&
            (entry.chartApplied === 'moved' ? (
              <p className="caption">The chart now shows this.</p>
            ) : entry.chartApplied === 'unchanged' ? null : (
              <button
                type="button"
                className="link"
                onClick={() =>
                  onOpenDecision(
                    reply.chart!.item.productId
                      ? { productId: reply.chart!.item.productId }
                      : {
                          amountCents: reply.chart!.item.amountCents,
                          itemName: reply.chart!.item.name,
                        },
                  )
                }
              >
                Open Worth’s comparison <ArrowRight size={16} aria-hidden="true" />
              </button>
            ))}
        </>
      )}
      {assessment && reply.payIn4?.asked && (
        // The verdict's "See the comparison" is the one link to the comparison (audit B11).
        <PayIn4Strip p4={reply.payIn4} today={assessment.today} />
      )}
      {!!picked.length && (
        <section className="picked" aria-label="Picked for your question">
          {reply.assessment ? (
            <button
              type="button"
              className="claude picked-toggle"
              aria-expanded={factsOpen}
              aria-controls={factsId}
              onClick={() => setFactsOpen(!factsOpen)}
            >
              <Sparkles className="ico" aria-hidden="true" />
              Picked for your question ({picked.length})
              <ChevronDown className="ico chev" aria-hidden="true" />
            </button>
          ) : (
            <span className="claude">
              <Sparkles className="ico" aria-hidden="true" />
              Picked for your question
            </span>
          )}
          <div id={factsId} hidden={!factsOpen}>
            {reply.lead && <p style={{ marginTop: 8 }}>{reply.lead}</p>}
            <ul>
              {(allFacts ? picked : picked.slice(0, 2)).map((point) => (
                <li key={point.id}>{amountsOnOneLine(point.text)}</li>
              ))}
            </ul>
            {picked.length > 2 && (
              <button
                type="button"
                className="link"
                aria-expanded={allFacts}
                onClick={() => setAllFacts(!allFacts)}
                style={{ fontSize: 'var(--fs-meta)' }}
              >
                {allFacts ? 'Less' : `More (${picked.length - 2})`}
              </button>
            )}
          </div>
        </section>
      )}
      {reply.alternatives && (
        <SimilarItems
          state={state}
          result={reply.alternatives}
          onSave={onSave && ((item) => void onSave(alternativeTarget(item)))}
        />
      )}
      {reply.checkLink && (
        <PurchaseCheck
          link={reply.checkLink}
          onOpen={() =>
            onOpenDecision(
              decisionRequestFrom(new URLSearchParams(reply.checkLink!.href.split('?')[1])) ?? {
                amountCents: reply.checkLink!.amountCents,
                itemName: reply.checkLink!.itemName,
              },
            )
          }
        />
      )}
      {fix && last && (
        <button type="button" className="link" onClick={() => onNavigate(fix.hash)}>
          {fix.label} <ArrowRight size={16} aria-hidden="true" />
        </button>
      )}
      {reply.trace ? (
        // The caption that sat under "How Ask Worth read this", without the expander.
        <div className="trace-box">
          <span className="caption trace-by">{entry.trace ?? traceText(reply, state)}</span>
        </div>
      ) : (
        <div className="trace">
          <ListChecks className="ico" aria-hidden="true" />
          {entry.trace ?? traceText(reply, state)}
        </div>
      )}
      {last && !panel && matchingSuggestions(reply).length > 0 && (
        // Desktop shows these in the rail; the thread keeps them only on mobile.
        <div className="chips show-m">
          {matchingSuggestions(reply).map((text) => (
            <button
              type="button"
              key={text}
              className="chip-suggest"
              disabled={busy}
              onClick={() => onSend(text)}
            >
              {curly(text)}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
