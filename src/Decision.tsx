import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import {
  ArrowLeft,
  Bookmark,
  BookmarkCheck,
  CalendarCheck,
  CalendarDays,
  ArrowRight,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  ListChecks,
  Sparkles,
  TriangleAlert,
} from 'lucide-react'
import { PAY_IN_4_DATES_NOTE, PAY_IN_4_SPACING } from '../shared/collision'
import {
  confirmedSchedule,
  PAY_IN_4_MAX_CENTS,
  PAY_IN_4_MIN_CENTS,
  WAIT_SEARCH_DAYS,
} from '../shared/finance'
import type { Alternative, OptionResult, Product } from '../shared/types'
import { offerVerdict, type AskOffer } from './AgentLauncher'
import { AlternativesLoading, SimilarItems, useSimilarItems } from './Alternatives'
import { BalanceChart, type ChartOption } from './BalanceChart'
import type { AppState, Comparison, PayIn4, SavePlan, SaveTarget } from './contract'
import { sourceTarget } from './contract'
import { ASSESSMENT_ONLY } from './copy'
import { fullPayName, payIn4Lines, payIn4Thesis } from './payIn4Text'
import { countedHold, ReservationNote } from './Reservation'
import {
  billOn,
  firstBelow,
  fits,
  belowWords,
  lower,
  lowestSentence,
  lowerName,
  missingFix,
  optionTitle,
  purchasePlans,
  useComparison,
} from './engine'
import { boughtOn, cx, dayLabel, fromMoney, money, shortDate, signed } from './format'
import { PayPalMessage } from './paypal'
import type { PayPalSdkInstance } from './paypalSdk'
import { Alert, Button, Dialog, Disc, Field, Pill, Ring, type Tone } from './ui'

export type OptionKey = 'buyToday' | 'wait' | 'spendLess'
export type DecisionRequest = {
  productId?: string
  amountCents?: number
  itemName?: string
  /** An item from a pasted link (C5): its store page and who set the confirmed price. */
  sourceUrl?: string
  priceSource?: 'channel3' | 'user'
  /** A store's quote opened on /check, so the comparison uses the store's Pay in 4 answer. */
  qid?: string
  /** A saved item with a store link: the server reads the link and judges Pay in 4 by range. */
  savedId?: string
  /** The budget the person stated in Ask; Something cheaper stays within it. */
  budgetCents?: number
  /** A later day agreed in Ask Worth (`on=`): the comparison also judges buying then. */
  onDate?: string
}
/**
 * A store's item from a signed hand-off (/check). The store sells it, so the way back to the
 * store replaces Worth's actions, and the item card with its own edit replaces the Read-as chip.
 */
export interface DecisionHandoff {
  /** "Not right? Edit", beside the item's price. */
  edit: ReactNode
  /** The edit form, in place of the item's price while the shopper corrects it. */
  editor?: ReactNode
  /** Under the item's price after an edit: the store's price and the way back to it. */
  note?: ReactNode
  /** The store's own Pay in 4 answer for this amount, under the Pay in 4 heading. */
  payLater?: string
  /** The actions for this answer: the way back to the store, and Save for a wait plan's day. */
  actions: (notes: boolean, c: Comparison) => ReactNode
  /** Under the answer, once: the report-back choice. */
  footer?: ReactNode
  merchant: string
  imageUrl?: string
}
/** What Claude contributed to the answer this view came from, if it came from Ask. */
export interface Explanation {
  lead?: string
  points: string[]
  toolCalls: string[]
  mode: 'anthropic' | 'demo'
  readAs?: string
}

/** One state set everywhere: above the cushion, exactly at it, or below it. Words, never colour alone. */
export function optionStatus(option: OptionResult): { tone: Tone; text: string } {
  if (option.outcome === 'incomplete') return { tone: 'info', text: 'More info needed' }
  if (option.outcome === 'tight')
    return { tone: 'bad', text: belowWords(option.lowestBalanceCents) }
  return option.headroomCents === 0
    ? { tone: 'warn', text: 'At your limit' }
    : { tone: 'ok', text: 'Above cushion' }
}

/** The option keys the comparison can show, in order, with the wait card disabled without a date. */
function optionOf(c: Comparison, key: OptionKey): OptionResult | undefined {
  // Waiting only matters when buying today does not fit.
  if (key === 'wait') return c.wait.date && !fits(c.buyToday) ? c.wait : undefined
  return c[key]
}

/** "Below cushion from Mon, Oct 12 (rent)": the day the balance first goes below the cushion. */
export function breachLine(option: OptionResult, cushion: number) {
  const breach = firstBelow(option.points, cushion)
  if (!breach) return undefined
  const bill = billOn(breach)
  const day = breach.date === option.points[0]?.date ? 'today' : dayLabel(breach.date)
  return `Below cushion from ${day}${bill ? ` (${lower(bill)})` : ''}`
}

/**
 * A miss small enough to name: the shortfall is at most a tenth of the price, so "Just $8.99
 * under your cushion" says more than "below cushion" does.
 */
export const smallMiss = (option: OptionResult, amountCents: number) =>
  option.headroomCents < 0 && -option.headroomCents * 10 <= amountCents

/** The option cards' body: two lines at most, every number the engine's. */
export function optionWhy(c: Comparison, k: OptionKey, option: OptionResult) {
  if (k === 'spendLess')
    return c.spendLess.maxPriceCents <= 0
      ? 'Nothing fits today without going below your cushion.'
      : `fits today if you skip the ${lowerName(c.itemName)}`
  if (option.headroomCents === 0)
    return `Leaves exactly your cushion on ${dayLabel(option.lowestDate)}`
  // The verdict states the recommended option's margin, so its card names only the day.
  if (option.lowestBalanceCents >= c.cushionCents)
    return c.recommendation === k
      ? `on ${dayLabel(option.lowestDate)}`
      : `${dayLabel(option.lowestDate)}, ${money(option.headroomCents)} above cushion`
  return smallMiss(option, c.amountCents)
    ? `Just ${money(-option.headroomCents)} under your cushion on ${dayLabel(option.lowestDate)}`
    : breachLine(option, c.cushionCents)
}

/** The verdict as a headline: what to do, before anything else. */
export function verdictTitle(c: Comparison) {
  if (c.recommendation === null) return 'Your plan needs a detail first'
  if (c.recommendation === 'buyToday') return 'Buy today'
  if (c.recommendation === 'wait' && c.wait.date) return `Wait until ${dayLabel(c.wait.date)}`
  return c.spendLess.maxPriceCents > 0
    ? `Spend up to ${money(c.spendLess.maxPriceCents)} today`
    : 'Nothing fits right now'
}

/** The sentence under the headline: the margin it leaves and what buying today would do. */
export function AnswerDetail({ c }: { c: Comparison }) {
  const cushion = money(c.cushionCents)
  const breach = firstBelow(c.buyToday.points, c.cushionCents)
  const bill = billOn(breach)
  const today = breach && (
    <>
      {' '}
      Buying today puts you below it{' '}
      {breach.date === c.today ? 'right away' : `from ${dayLabel(breach.date)}`}
      {bill ? `, when ${lower(bill)} is due` : ''}.
    </>
  )
  if (c.recommendation === null)
    return <>Worth can compare these options once the details below are in.</>
  if (c.recommendation === 'buyToday')
    return (
      <>
        You stay {money(c.buyToday.headroomCents)} above your {cushion} cushion.
      </>
    )
  if (c.recommendation === 'wait' && c.wait.date)
    return (
      <>
        You stay {money(c.wait.headroomCents)} above your {cushion} cushion.{today}
      </>
    )
  if (c.spendLess.maxPriceCents <= 0)
    return <>Your plan already reaches your {cushion} cushion without this purchase.</>
  return (
    <>
      No date in the next {WAIT_SEARCH_DAYS} days keeps your {cushion} cushion at the full price.
    </>
  )
}

function OptionCard({
  c,
  k,
  checked,
  onSelect,
  tabIndex,
  onKeyDown,
  buttonRef,
  similar,
  controls,
}: {
  c: Comparison
  k: OptionKey
  /** Similar items under the limit exist, so the Something cheaper card offers them. */
  similar?: boolean
  /** The id of the similar items list while it is shown. */
  controls?: string
  checked: boolean
  onSelect: () => void
  tabIndex: number
  onKeyDown: (event: KeyboardEvent) => void
  buttonRef: (element: HTMLButtonElement | null) => void
}) {
  const option = optionOf(c, k)
  const title = optionTitle(k, c)
  if (!option) {
    const notNeeded = fits(c.buyToday)
    return (
      <div className="opt" role="radio" aria-checked="false" aria-disabled="true" tabIndex={-1}>
        <span className="head">
          <span className="ot">Wait</span>
          <Pill tone="info">{notNeeded ? 'Not needed' : 'No date fits'}</Pill>
        </span>
        <span className="why">
          {notNeeded
            ? 'It fits today, so there’s nothing to wait for.'
            : `No date in the next ${WAIT_SEARCH_DAYS} days keeps your cushion.`}
        </span>
      </div>
    )
  }
  const cheaper = k === 'spendLess'
  const status = !cheaper
    ? optionStatus(option)
    : c.spendLess.maxPriceCents <= 0
      ? ({ tone: 'info', text: 'Nothing fits' } as const)
      : ({
          tone: 'ok',
          text: c.budgetCents !== undefined ? 'Within your budget' : 'Fits today',
        } as const)
  const below = option.lowestBalanceCents < c.cushionCents
  return (
    <button
      type="button"
      className="opt"
      role="radio"
      aria-checked={checked}
      aria-controls={controls}
      tabIndex={tabIndex}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      ref={buttonRef}
    >
      <span className="head">
        <span className="ot">{title}</span>
        <Pill tone={status.tone}>{status.text}</Pill>
      </span>
      <span className="kv">
        <span className="k">
          {cheaper ? (c.budgetCents !== undefined ? 'Your budget today' : 'Up to') : 'Lowest point'}
        </span>
        <span className={cx('v num', !cheaper && below && 'bad')}>
          {cheaper ? money(c.spendLess.maxPriceCents) : signed(option.lowestBalanceCents)}
        </span>
      </span>
      <span className="why">{optionWhy(c, k, option)}</span>
      {/* Choosing this card shows the list, so the "link" is the card's own action. */}
      {cheaper && similar && (
        <span className="opt-link">
          See similar items <ArrowRight className="ico" aria-hidden="true" />
        </span>
      )}
    </button>
  )
}

type P4 = Extract<PayIn4, { available: true }>

/**
 * The plan with nothing bought, as the engine projects it beside every option: each day's
 * baseline low, and the day's events without the purchase.
 */
export const noPurchase = (c: Comparison) =>
  c.buyToday.points.map((point) => ({
    ...point,
    minimumCents: point.baselineMinimumCents,
    events: point.events.filter((event) => event.kind !== 'purchase'),
  }))

export function ChartTile({
  c,
  k,
  payIn4,
  scaleWith,
  productId,
}: {
  c: Comparison
  k: OptionKey
  /** The catalog item, so the guide's chart commands reach only this item's chart. */
  productId?: string
  payIn4?: P4
  /** The Pay in 4 scenario, open or not, so the chart can offer it as a line. */
  scaleWith?: P4
}) {
  const option = optionOf(c, k) ?? c.buyToday
  const fullName = fullPayName(c, option)
  const thesis = payIn4 ? payIn4Thesis(c, option, payIn4) : ''
  // The chart's pills are the ways to buy this item: the page's option starts pressed, and Pay
  // in 4 joins it while its comparison is open.
  const p4 = scaleWith ?? payIn4
  const purchase = (o: OptionResult) => ({ date: o.purchaseDate, fits: fits(o) })
  const options: ChartOption[] = [
    ...(['buyToday', 'wait', 'spendLess'] as const)
      .filter((key) => (key === 'spendLess' ? k === key : optionOf(c, key)))
      .map((key) => ({
        key,
        name: key === 'spendLess' ? fullName : optionTitle(key, c),
        short: key === 'wait' && c.wait.date ? `Wait · ${shortDate(c.wait.date)}` : undefined,
        points: optionOf(c, key)!.points,
        tone: key === 'buyToday' ? ('amber' as const) : ('teal' as const),
        purchase: purchase(optionOf(c, key)!),
      })),
    ...(p4
      ? [
          {
            key: 'payIn4',
            name: 'Pay in 4',
            points: p4.points,
            tone: 'violet' as const,
            on: Boolean(payIn4),
            instalments: p4.instalments,
            purchase: { date: p4.purchaseDate },
            note: `Compared with PayPal Pay in 4. ${payIn4Thesis(c, option, p4)}`,
          },
        ]
      : []),
  ]
  return (
    // The card has no visible title: each summary row names the option it is for, so nothing
    // above the pills can disagree with what is pressed.
    <section className="tile" aria-label="Your balance day by day">
      {thesis && <p className="chart-thesis">{thesis}</p>}
      <BalanceChart
        options={options}
        selected={options.some((o) => o.key === k) ? k : 'buyToday'}
        cushionCents={c.cushionCents}
        named
        baseline={{ name: 'No purchase', points: noPurchase(c) }}
        item={{ name: c.itemName, amountCents: c.amountCents, ...(productId ? { productId } : {}) }}
        label={`Projected balance, ${shortDate(c.window.start)} to ${shortDate(c.window.end)}. Each day shows its low, with that day’s bills taken out before pay arrives.`}
      />
    </section>
  )
}

/** The relation to the nearest bill, always two lines: the gap, then the bill. */
function nearText(
  near: Extract<PayIn4, { available: true }>['instalments'][number]['nearestBill'],
) {
  if (!near)
    return (
      <>
        <span className="rel">No bill within</span> <span className="bill">about 3 days</span>
      </>
    )
  // PayPal's own dates can run a day or two later than this schedule, so every gap is "about".
  const days = Math.abs(near.daysFromInstalment)
  const name = <b>{lower(near.name)}</b>
  if (near.daysFromInstalment === 0)
    return (
      <>
        <span className="rel">About the same day</span> <span className="bill">as {name}</span>
      </>
    )
  return (
    <>
      <span className="rel">
        About {days} {days === 1 ? 'day' : 'days'}{' '}
        {near.daysFromInstalment < 0 ? 'after' : 'before'}
      </span>{' '}
      <span className="bill">{name}</span>
    </>
  )
}

function PayIn4Panel({
  c,
  open,
  onToggle,
  instance,
  note,
}: {
  c: Comparison
  open: boolean
  onToggle: () => void
  instance?: PayPalSdkInstance
  /** The store's own Pay in 4 answer, as a second line under the heading. */
  note?: string
}) {
  const panelId = useId()
  const p4 = c.payIn4
  // Another store's item: Worth can't know whether that store offers Pay in 4 (C5).
  const heading = c.source ? 'If this store offers PayPal Pay in 4' : 'Compare with PayPal Pay in 4'
  // PayPal's server-side check (payIn4.eligibility) decides. The browser SDK has no buyer
  // context, so it is used only to render PayPal Messages and the button.
  const available = p4.available && p4.eligibility !== 'unavailable'
  if (!p4.available || !available)
    return (
      <div className="disclosure">
        <div className="dhead" aria-disabled="true">
          <span style={{ opacity: 0.6 }}>
            <Disc icon={CalendarDays} kind="plan" />
          </span>
          <span>
            <span className="h-section" style={{ display: 'block', color: 'var(--c-text-2)' }}>
              {heading}
            </span>
            <span className="meta">
              {p4.available ? 'Not available for this amount' : p4.reason}
            </span>
            {note && <span className="meta p4-store">{note}</span>}
          </span>
        </div>
      </div>
    )
  // Before Phase 3's server check, the range alone decides, so it is labelled the same way.
  const rangeOnly = p4.eligibility !== 'paypal'
  const breach = p4.outcome !== 'fits'
  const lines = payIn4Lines(p4, c.cushionCents)
  const amounts = new Set(p4.instalments.map((item) => item.amountCents))
  const existing = new Map<
    string,
    { name: string; items: { date: string; amountCents: number }[] }
  >()
  for (const payment of p4.stacking?.calendar ?? [])
    if (!payment.proposed)
      existing.set(payment.planId, {
        name: payment.name,
        items: [...(existing.get(payment.planId)?.items ?? []), payment],
      })
  return (
    <div className="disclosure" data-open={open}>
      <button
        type="button"
        className="dhead"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <Disc icon={CalendarDays} kind="plan" />
        <span>
          <span className="h-section" style={{ display: 'block' }}>
            {heading}
          </span>
          <span className="meta">
            4 payments {amounts.size > 1 ? 'from' : 'of'}{' '}
            {money(p4.instalments.at(-1)!.amountCents)}, {PAY_IN_4_SPACING} from today
          </span>
          {note && <span className="meta p4-store">{note}</span>}
        </span>
        <ChevronDown className="ico chev" aria-hidden="true" />
      </button>
      <div className="panel" id={panelId} hidden={!open}>
        <Alert tone={breach ? 'bad' : 'ok'} icon={breach ? TriangleAlert : CircleCheck} live>
          <b>{lines.lead}.</b>
          <br />
          {lines.low}
        </Alert>
        <div className="sched rows" role="list" aria-label="Illustrative Pay in 4 schedule">
          {p4.instalments.map((item) => (
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
                  {/* Always two lines, "Today" too, so every card's blocks line up. */}
                  <div className="when">
                    {item.date === c.today ? (
                      'Today'
                    ) : (
                      <>
                        <span className="about">About</span>{' '}
                        <span className="nowrap">{dayLabel(item.date)}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="near">{nearText(item.nearestBill)}</div>
              <div className="after">
                <span className="lbl">Lowest after</span>
                <span className="val num">
                  <span className="nowrap">{signed(item.balanceCents)}</span> ·{' '}
                  <span className="nowrap">{dayLabel(item.lowestDate)}</span>
                </span>
              </div>
            </div>
          ))}
        </div>
        {[...existing.values()].map((plan) => (
          <div className="existing" key={plan.name}>
            <Disc icon={CalendarCheck} kind="plan" />
            <div style={{ flex: 1 }}>
              <div className="t">Already running: {plan.name}</div>
              <div className="meta">
                {plan.items
                  .map((item) => `${money(item.amountCents)} on ${dayLabel(item.date)}`)
                  .join(', ')}
                . Included above.
              </div>
            </div>
          </div>
        ))}
        {p4.stacking && (
          <Alert tone="warn" icon={CircleAlert}>
            {p4.stacking.message}
          </Alert>
        )}
        {/* Mounted only when opened, so PayPal is asked for terms only on request. */}
        {/* PayPal's message is for Worth's own sandbox checkout, so it shows only for its items. */}
        {open && !c.source && <PayPalMessage instance={instance} amountCents={c.amountCents} />}
        <p className="caption">
          {PAY_IN_4_DATES_NOTE} PayPal sets the exact terms at checkout. Pay in 4 is shown for
          comparison only; Worth never recommends it.
          {c.source
            ? ` Shown for amounts PayPal Pay in 4 covers, ${money(PAY_IN_4_MIN_CENTS)} to ${money(PAY_IN_4_MAX_CENTS)}; ${c.source.merchantName} and PayPal decide at checkout.`
            : rangeOnly
              ? ' Availability is decided by PayPal at checkout.'
              : ''}
        </p>
      </div>
    </div>
  )
}

function Skeleton() {
  return (
    <div className="grid" aria-busy="true">
      <div className="stack">
        <span className="sk" style={{ width: '60%', height: 28 }} />
        <span className="sk" style={{ width: '80%' }} />
        <div className="options">
          {[0, 1, 2].map((i) => (
            <span key={i} className="sk block" style={{ height: 168 }} />
          ))}
        </div>
        <span className="sk block" />
        <p className="caption" role="status">
          Checking your plan…
        </p>
      </div>
      <div className="rail decision-rail" aria-hidden="true">
        <span className="sk block" style={{ height: 220 }} />
        <span className="sk" style={{ width: '60%' }} />
        <span className="sk" style={{ width: '45%' }} />
      </div>
    </div>
  )
}

export function Decision({
  state,
  request,
  explanation,
  instance,
  backLabel,
  onBack,
  onBuy,
  onSave,
  onSaveAlternative,
  onViewActivity,
  handoff,
  onOffer,
}: {
  state: AppState
  request: DecisionRequest
  explanation?: Explanation
  instance?: PayPalSdkInstance
  backLabel: string
  onBack: () => void
  onBuy: (product: Product, acknowledgeShortfall: boolean) => void
  onSave: (target: SaveTarget, plan: SavePlan) => void
  /** Saves a similar item from another store for later; the row's button shows only when set. */
  onSaveAlternative?: (item: Alternative) => void
  /** Kept for callers; missing inputs now link to their exact fix. */
  onEditPlan?: () => void
  onViewActivity: () => void
  handoff?: DecisionHandoff
  /** Offers this item, its price, store and verdict to the Ask Worth panel while on screen. */
  onOffer?: (offer: AskOffer | undefined) => void
}) {
  const [override, setOverride] = useState<DecisionRequest>()
  const active = override ?? request
  const { comparison: c, error, loading } = useComparison(active, state.profile.version)
  const [picked, setPicked] = useState<OptionKey>()
  const [p4Open, setP4Open] = useState(false)
  const [editing, setEditing] = useState(false)
  /** Set as the edit form closes, so "Not right? Edit" takes focus back. */
  const refocus = useRef(false)
  const [confirmBuy, setConfirmBuy] = useState(false)
  const [recheck, setRecheck] = useState(false)
  const radios = useRef<(HTMLButtonElement | null)[]>([])
  const product = active.productId
    ? state.products.find((item) => item.id === active.productId)
    : undefined
  const narrow = useNarrow()
  const listId = useId()
  // Something cheaper's similar items, asked for under the card's own limit so both state one
  // number. Fetched with the comparison, so the card offers them only when there are some.
  const cheaperLimit = c && !fits(c.buyToday) ? c.spendLess.maxPriceCents : 0
  const similar = useSimilarItems(
    state,
    c && cheaperLimit > 0
      ? product
        ? { productId: product.id, maxPriceCents: cheaperLimit }
        : { itemName: c.itemName, amountCents: c.amountCents, maxPriceCents: cheaperLimit }
      : null,
  )
  // A store is named only when the person came from it (a verified hand-off) or pasted its link.
  const store = handoff?.merchant ?? c?.source?.merchantName
  useEffect(() => {
    if (!onOffer || !c) return
    onOffer({
      itemName: product?.name ?? c.itemName,
      amountCents: c.amountCents,
      store,
      verdict: offerVerdict(c),
    })
    return () => onOffer(undefined)
  }, [onOffer, c, product?.name, store])
  if (error)
    return (
      <Frame>
        <Alert tone="bad" icon={CircleAlert}>
          <b>Worth couldn’t compare this purchase.</b> {error}
        </Alert>
      </Frame>
    )
  if (loading || !c)
    return (
      <Frame>
        <Skeleton />
      </Frame>
    )
  // When the item fits, neither waiting nor spending less applies, so only buying today shows.
  const keys: OptionKey[] = fits(c.buyToday) ? ['buyToday'] : ['buyToday', 'wait', 'spendLess']
  const selected: OptionKey = picked ?? c.recommendation ?? 'buyToday'
  const enabled = keys.filter((key) => optionOf(c, key))
  const move = (event: KeyboardEvent, key: OptionKey) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0
    if (!step) return
    event.preventDefault()
    const next = enabled[(enabled.indexOf(key) + step + enabled.length) % enabled.length]!
    setPicked(next)
    radios.current[keys.indexOf(next)]?.focus()
  }
  const p4 = c.payIn4.available ? c.payIn4 : undefined
  const bought = product
    ? state.purchases.find(
        (p) => p.productId === product.id && p.status === 'completed' && !p.archived,
      )
    : undefined
  const pending = product
    ? state.purchases.find(
        (p) => p.productId === product.id && ['created', 'pending', 'unknown'].includes(p.status),
      )
    : undefined
  // Saved already, with the plan this answer suggests: the button says so instead of saving again.
  const savedNow = (state.saved ?? []).some(
    (item) =>
      item.status !== 'removed' &&
      item.status !== 'bought' &&
      (product
        ? item.productId === product.id
        : item.kind === 'custom' &&
          item.name === c.itemName &&
          item.amountCents === c.amountCents) &&
      (c.recommendation === 'wait' && c.wait.date ? item.waitDate === c.wait.date : true),
  )
  const saved = {
    label: 'Saved',
    note: 'It’s in Saved. Nothing is bought.',
    run: () => undefined,
    done: true,
  }
  const primary =
    product &&
    (pending
      ? {
          label: 'Finish checkout',
          note: 'Your order is waiting. Nothing is charged until you confirm.',
          run: () => onBuy(product, false),
        }
      : c.recommendation === 'buyToday'
        ? {
            label: 'Buy now',
            note: 'You’ll approve in PayPal, then confirm here. Nothing is charged until you do.',
            run: () => onBuy(product, false),
          }
        : savedNow
          ? saved
          : c.recommendation === 'wait' && c.wait.date
            ? {
                label: `Save for ${dayLabel(c.wait.date)}`,
                note: 'Keeps it in Saved with this date. Nothing is bought.',
                run: () =>
                  onSave({ kind: 'catalog', productId: product.id }, { waitDate: c.wait.date! }),
              }
            : {
                label: 'Save for later',
                note: 'Keeps it in Saved. Nothing is bought.',
                run: () =>
                  onSave(
                    { kind: 'catalog', productId: product.id },
                    c.recommendation ? { option: c.recommendation } : {},
                  ),
              })
  // An open checkout for another item is already in these numbers; say so (fix #9).
  const hold = countedHold(state, {
    productId: product?.id,
    itemName: c.itemName,
    amountCents: c.amountCents,
  })
  // An item the store doesn't sell can still be saved, as an assessment only (A3).
  const custom = !product && {
    done: savedNow,
    label: savedNow
      ? 'Saved'
      : c.recommendation === 'wait' && c.wait.date
        ? `Save for ${dayLabel(c.wait.date)}`
        : 'Save for later',
    run: () =>
      onSave(
        {
          kind: 'custom',
          name: c.itemName,
          amountCents: c.amountCents,
          // A pasted link keeps its store page, so Saved can link back on the ready day (C6).
          ...sourceTarget(c.source),
        },
        c.recommendation === 'wait' && c.wait.date
          ? { waitDate: c.wait.date }
          : c.recommendation
            ? { option: c.recommendation }
            : {},
      ),
  }
  const customActions = (notes: boolean) =>
    custom && (
      <>
        <Button
          block
          variant="secondary"
          icon={custom.done ? BookmarkCheck : Bookmark}
          onClick={custom.done ? undefined : custom.run}
          aria-disabled={custom.done || undefined}
        >
          {custom.label}
        </Button>
        {notes && (
          <p className="caption" style={{ textAlign: 'center' }}>
            {ASSESSMENT_ONLY}.
          </p>
        )}
      </>
    )
  const anyway = product && !pending && c.recommendation !== 'buyToday' && c.recommendation !== null
  const breach = firstBelow(c.buyToday.points, c.cushionCents)
  const actions = (notes: boolean) => (
    <>
      {primary &&
        ('done' in primary ? (
          <Button block variant="secondary" icon={BookmarkCheck} aria-disabled>
            {primary.label}
          </Button>
        ) : (
          <Button block onClick={primary.run}>
            {primary.label}
          </Button>
        ))}
      {notes && primary && (
        <p className="caption" style={{ textAlign: 'center' }}>
          {primary.note}
        </p>
      )}
      {anyway && (
        <Button variant="text" onClick={() => setConfirmBuy(true)}>
          {/* Next to other stores' items, the action names Worth's own listed product. */}
          {selected === 'spendLess'
            ? `Buy the ${lowerName(product!.name)} anyway`
            : 'Buy today anyway'}
        </Button>
      )}
    </>
  )
  const boughtSchedule = bought ? confirmedSchedule(bought) : undefined
  const boughtPlan = bought
    ? purchasePlans(state).find((plan) => plan.planId === `purchase:${bought.id}`)
    : undefined
  if (bought && !recheck)
    return (
      <Frame>
        <div className="grid">
          <div className="stack tight">
            <button
              type="button"
              className="link hide-m"
              onClick={onBack}
              style={{ fontSize: 'var(--fs-meta)' }}
            >
              <ArrowLeft size={16} aria-hidden="true" />
              {backLabel}
            </button>
            <h1 className="title" style={{ margin: '0 0 8px' }}>
              {product!.name}, {money(bought.amountCents)}
            </h1>
            <section className="tile co" aria-label="Bought">
              <div className="co-head">
                <span className="co-icon ok" aria-hidden="true">
                  <CircleCheck className="ico" />
                </span>
                <div>
                  <h2>You bought this</h2>
                  <p>
                    {product!.merchant} · {dayLabel(boughtOn(bought, state.profile.timezone))} ·{' '}
                    {bought.mode === 'sandbox' ? 'PayPal sandbox' : 'simulated'}
                  </p>
                </div>
              </div>
              {boughtSchedule ? (
                <div className="sched" role="list" aria-label="Your Pay in 4 payments">
                  {boughtSchedule.map((item, index) => {
                    const paid =
                      item.date < state.today ||
                      (index === 0 && item.date === bought.assessmentDate)
                    return (
                      <div className="inst" role="listitem" key={item.date}>
                        <div className="top">
                          <Ring part={index + 1} of={boughtSchedule.length} />
                          <div>
                            <div className="amt num">{money(item.amountCents)}</div>
                            <div className="when">{dayLabel(item.date)}</div>
                          </div>
                        </div>
                        <div className="after">{paid ? 'Paid' : 'Due'}</div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                state.reviews.some(
                  (review) => review.kind === 'confirmPlan' && review.purchaseId === bought.id,
                ) && (
                  <p className="meta">
                    Paid in full or with Pay in 4? Confirm it from Home so Worth counts it right.
                  </p>
                )
              )}
              <div className="actions">
                <Button onClick={onViewActivity}>View in Activity</Button>
                <Button variant="text" onClick={() => setRecheck(true)}>
                  Check it again
                </Button>
              </div>
            </section>
          </div>
          <aside className="rail decision-rail" aria-label="Your purchase">
            <div className="tile">
              <div className="product">
                <img src={product!.image} alt={product!.name} />
                <div>
                  <div className="pt">{product!.name}</div>
                  <div className="num strong" style={{ fontWeight: 700, marginTop: 4 }}>
                    {money(bought.amountCents)}
                  </div>
                </div>
              </div>
              {boughtPlan?.total && (
                <div className="row plain" style={{ marginTop: 16 }}>
                  <Ring part={boughtPlan.total - boughtPlan.left} of={boughtPlan.total} />
                  <div className="body">
                    <div className="t" style={{ fontSize: 'var(--fs-body)' }}>
                      {boughtPlan.total - boughtPlan.left} of {boughtPlan.total} paid
                    </div>
                    <div className="s soft">
                      Next {money(boughtPlan.amountCents)} · {dayLabel(boughtPlan.next)}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </aside>
        </div>
      </Frame>
    )
  const listShown =
    selected === 'spendLess' && cheaperLimit > 0 && Boolean(similar.result || similar.loading)
  const list = (
    <div id={listId}>
      {similar.result ? (
        <SimilarItems state={state} result={similar.result} onSave={onSaveAlternative} />
      ) : (
        <AlternativesLoading />
      )}
    </div>
  )
  const edit = (
    <button
      type="button"
      className="link edit-item"
      // A new answer shows the skeleton first, so focus returns when the button mounts again.
      ref={(element) => {
        if (!element || !refocus.current) return
        refocus.current = false
        element.focus()
      }}
      onClick={() => setEditing(true)}
    >
      Not right? Edit
    </button>
  )
  const closeEditor = () => {
    refocus.current = true
    setEditing(false)
  }
  const item: ItemView = handoff
    ? {
        name: c.itemName,
        amountCents: c.amountCents,
        image: handoff.imageUrl,
        seller: `Sold by ${handoff.merchant}`,
        store: handoff.merchant,
        edit: handoff.edit,
        editor: handoff.editor,
        note: handoff.note,
      }
    : {
        name: product?.name ?? c.itemName,
        amountCents: c.amountCents,
        image: product?.image,
        // Items reached inside Worth carry no seller line; only a pasted link names its store.
        seller:
          !product && c.source
            ? `At ${c.source.merchantName} · ${c.source.priceSource === 'channel3' ? 'price read by Channel3, confirmed by you' : 'price you entered'}`
            : undefined,
        store: product ? undefined : c.source?.merchantName,
        when: 'today',
        edit,
        editor: editing ? (
          <EditPurchase
            name={c.itemName}
            amountCents={c.amountCents}
            focusFirst
            onCancel={closeEditor}
            onSubmit={(next) => {
              closeEditor()
              setPicked(undefined)
              setOverride(
                product && next.amountCents === product.priceCents
                  ? { productId: product.id }
                  : active.sourceUrl
                    ? {
                        ...next,
                        sourceUrl: active.sourceUrl,
                        // Any change here is the shopper's own price.
                        priceSource:
                          active.priceSource === 'channel3' &&
                          next.amountCents === active.amountCents
                            ? 'channel3'
                            : 'user',
                      }
                    : next,
              )
            }}
          />
        ) : undefined,
        link: c.source && (
          <a
            className="caption"
            href={c.source.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'inline-flex', gap: 4, alignItems: 'center', marginTop: 8 }}
          >
            Open the store page <ExternalLink size={14} aria-hidden="true" />
            <span className="sr"> (opens in a new tab)</span>
          </a>
        ),
      }
  const railActions = handoff
    ? handoff.actions(true, c)
    : product
      ? actions(true)
      : customActions(true) || undefined
  return (
    <Frame
      actions={
        handoff
          ? handoff.actions(false, c)
          : product
            ? actions(false)
            : customActions(false) || undefined
      }
    >
      <div className="grid">
        <div className="stack">
          <div className="stack tight decision-head">
            <button
              type="button"
              className="link hide-m"
              onClick={onBack}
              style={{ fontSize: 'var(--fs-meta)', alignSelf: 'flex-start' }}
            >
              <ArrowLeft size={16} aria-hidden="true" />
              {backLabel}
            </button>
            {/* Narrow screens drop the rail's item card far below, so the item leads here. */}
            {narrow && <ItemCard item={item} compact />}
            {/* The answer is the headline: one calm block, the verdict and the engine's sentence. */}
            <section className="verdict-block" aria-labelledby="verdict-head">
              <h1 className="title" id="verdict-head">
                {verdictTitle(c)}
              </h1>
              <p className="lead">
                <AnswerDetail c={c} />
              </p>
            </section>
            {/* Why the answer is what it is, read straight after it, always open. */}
            <WhyThisAnswer explanation={explanation} />
            {hold && (
              <ReservationNote
                purchase={hold}
                onReview={(open) => {
                  const held = state.products.find((item) => item.id === open.productId)
                  if (held) onBuy(held, false)
                }}
              />
            )}
            {c.recommendation === null && (
              <Alert tone="warn" icon={CircleAlert}>
                <b>Fix these first:</b>
                <ul>
                  {c.missingFields.map((field) => {
                    const fix = missingFix(field)
                    return (
                      <li key={field}>
                        {field} {fix && <a href={`#${fix.hash}`}>{fix.label}</a>}
                      </li>
                    )
                  })}
                </ul>
              </Alert>
            )}
            {handoff?.footer}
          </div>
          {/* Says where the list went, since choosing the card keeps focus on it. */}
          <p className="sr" role="status">
            {listShown && similar.result
              ? `Similar items up to ${money(similar.result.maxPriceCents)} are shown ${narrow ? 'below the options' : 'beside the options'}.`
              : ''}
          </p>
          <div
            role="radiogroup"
            aria-label="Your options"
            className="options"
            style={{ ['--opt-cols' as string]: keys.length }}
          >
            {keys.map((key, index) => (
              <OptionCard
                key={key}
                c={c}
                k={key}
                checked={selected === key}
                tabIndex={selected === key ? 0 : -1}
                onSelect={() => setPicked(key)}
                similar={Boolean(similar.result)}
                controls={key === 'spendLess' && listShown ? listId : undefined}
                onKeyDown={(event) => move(event, key)}
                buttonRef={(element) => {
                  radios.current[index] = element
                }}
              />
            ))}
          </div>
          {/* Narrow screens: the list sits right under the cards that asked for it. */}
          {listShown && narrow && list}
          {/* The Pay in 4 comparison sits right under the options, so its collisions are seen (#7). */}
          <PayIn4Panel
            c={c}
            open={p4Open}
            onToggle={() => setP4Open(!p4Open)}
            instance={instance}
            note={handoff?.payLater}
          />
          <ChartTile
            c={c}
            k={selected}
            payIn4={p4Open ? p4 : undefined}
            scaleWith={p4}
            productId={product?.id}
          />
        </div>
        <aside className="rail decision-rail" aria-label="Item and reasons">
          {/* Something cheaper swaps the item for the similar items; the actions stay. */}
          {listShown && !narrow ? (
            <>
              {/* The item, its edit and any note stay above the similar items. */}
              <ItemCard item={item} compact />
              {list}
              <div className="rail-actions bare">{railActions}</div>
            </>
          ) : narrow ? (
            // The item leads the page here, so only the actions stay (tablets have no bar).
            railActions && <div className="rail-actions solo">{railActions}</div>
          ) : (
            <div className="tile">
              <ItemCard item={item} />
              {railActions && <div className="rail-actions">{railActions}</div>}
            </div>
          )}
        </aside>
      </div>
      {confirmBuy && product && (
        <Dialog
          title="Buy today anyway?"
          onClose={() => setConfirmBuy(false)}
          footer={
            // Below the cushion, keeping the plan is the safe choice, so it is the filled button.
            c.buyToday.outcome !== 'fits' ? (
              <>
                <Button block onClick={() => setConfirmBuy(false)}>
                  Keep my plan
                </Button>
                <Button
                  block
                  variant="secondary"
                  onClick={() => {
                    setConfirmBuy(false)
                    onBuy(product, true)
                  }}
                >
                  Continue to checkout
                </Button>
              </>
            ) : (
              <>
                <Button
                  block
                  onClick={() => {
                    setConfirmBuy(false)
                    onBuy(product, true)
                  }}
                >
                  Continue to checkout
                </Button>
                <Button variant="text" onClick={() => setConfirmBuy(false)}>
                  Keep my plan
                </Button>
              </>
            )
          }
        >
          <Alert tone="bad" icon={TriangleAlert}>
            {breach ? (
              <>
                <b>
                  Buying today puts you below your {money(c.cushionCents)} cushion{' '}
                  {breach.date === c.today ? 'right away' : `from ${dayLabel(breach.date)}`}
                  {billOn(breach) ? `, when ${lower(billOn(breach)!)} is due` : ''}.
                </b>
                <br />
                {lowestSentence(c.buyToday.lowestBalanceCents, c.buyToday.lowestDate)}.
              </>
            ) : (
              <b>Buying today takes you below your cushion.</b>
            )}
          </Alert>
          <p className="meta">
            You can still continue. You’ll approve in PayPal, then confirm here, and nothing is
            charged until you do.
          </p>
        </Dialog>
      )}
    </Frame>
  )
}

/** The item being judged, with its edit: what the old Read-as chip and /check's chip said. */
interface ItemView {
  name: string
  amountCents: number
  image?: string
  /** Under the name in the rail's card: the store, only after a hand-off or a pasted link. */
  seller?: string
  /** After the price in the compact row. */
  store?: string
  /** When it would be bought, as Worth read it. */
  when?: string
  edit: ReactNode
  /** The edit form, in place of the edit while it is open. */
  editor?: ReactNode
  note?: ReactNode
  link?: ReactNode
}
/**
 * The item and its edit, on the right: the rail's card on wide screens, or a compact row (above
 * the answer on narrow screens, above similar items in the rail).
 */
function ItemCard({ item, compact }: { item: ItemView; compact?: boolean }) {
  const extra = (item.editor || item.note) && (
    <div className="product-edit">
      {item.editor}
      {item.note}
    </div>
  )
  if (compact)
    return (
      <div className="tile item-row">
        <div className="item-top">
          {item.image && <img src={item.image} alt="" />}
          <div>
            <div className="pt">{item.name}</div>
            <div className="meta">
              <span className="num strong">{money(item.amountCents)}</span>
              {item.store && ` · ${item.store}`}
              {item.when && ` · ${item.when}`}
            </div>
            {!item.editor && item.edit}
          </div>
        </div>
        {extra}
        {item.link}
      </div>
    )
  return (
    <>
      <div className="product">
        {item.image && <img src={item.image} alt={item.name} />}
        <div>
          <div className="pt">{item.name}</div>
          {item.seller && <div className="meta">{item.seller}</div>}
          <div className="price-row">
            <span>
              <span className="num strong">{money(item.amountCents)}</span>
              {item.when && <span className="meta"> · {item.when}</span>}
            </span>
            {!item.editor && item.edit}
          </div>
        </div>
      </div>
      {extra}
      {item.link}
    </>
  )
}

/** Below 1024 px the rail drops under the main column, so a rail-only list moves up instead. */
const NARROW = '(max-width: 1023px)'
function useNarrow() {
  return useSyncExternalStore(
    (changed) => {
      if (typeof matchMedia !== 'function') return () => {}
      const query = matchMedia(NARROW)
      query.addEventListener('change', changed)
      return () => query.removeEventListener('change', changed)
    },
    () => typeof matchMedia === 'function' && matchMedia(NARROW).matches,
    () => false,
  )
}

function Frame({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <>
      <div className="page">
        <div className={cx('wrap', !actions && 'no-bar')}>{children}</div>
      </div>
      {actions && (
        <div className="actionbar show-m" role="region" aria-label="Decide">
          {actions}
        </div>
      )}
    </>
  )
}

/** Short enough that a fourth or later point still reads as a list, not a wall of text. */
const SHORT_POINT = 90

/**
 * Why the answer is what it is, under the verdict: the assistant's checked lead and points when it
 * wrote them, otherwise Worth's own rule-based sentence, with a line saying which. At most three
 * points, unless every point is short; a point is never cut mid-sentence.
 */
function WhyThisAnswer({ explanation }: { explanation?: Explanation }) {
  const claude = explanation?.mode === 'anthropic' && explanation.points.length > 0
  const points = explanation?.points ?? []
  const shown =
    points.length <= 3 || points.every((point) => point.length <= SHORT_POINT)
      ? points
      : points.slice(0, 3)
  return (
    <section className="why-block" aria-label="Why this answer">
      {claude ? (
        <>
          {explanation!.lead && <p>{explanation!.lead}</p>}
          <ul>
            {shown.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </>
      ) : (
        <p>
          Worth projected your balance each day for the next 60 days, once for each option, using
          your money, bills, income and everyday spending.
        </p>
      )}
      <div className="trace">
        {claude ? (
          <Sparkles className="ico" aria-hidden="true" />
        ) : (
          <ListChecks className="ico" aria-hidden="true" />
        )}
        {claude
          ? 'Worth’s assistant picked these facts for your question · every number is Worth’s'
          : 'Worth’s own calculation · next 60 days'}
      </div>
    </section>
  )
}

export function EditPurchase({
  name,
  amountCents,
  submitLabel = 'Check again',
  focusFirst,
  onSubmit,
  onCancel,
}: {
  name: string
  /** Empty when the shopper types the price themselves. */
  amountCents?: number
  submitLabel?: string
  /** Opened from a button that has now gone, so focus moves into the form. */
  focusFirst?: boolean
  onSubmit: (next: { itemName: string; amountCents: number }) => void
  onCancel?: () => void
}) {
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (focusFirst) first.current?.focus()
    // Once, as the form opens.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [item, setItem] = useState(name)
  const [amount, setAmount] = useState(amountCents ? (amountCents / 100).toFixed(2) : '')
  const [error, setError] = useState('')
  return (
    <form
      className="readas-edit"
      onSubmit={(event) => {
        event.preventDefault()
        const cents = fromMoney(amount)
        if (!item.trim()) return setError('Name the item you want to check.')
        if (!Number.isSafeInteger(cents) || cents <= 0)
          return setError('Enter a total price greater than $0.')
        onSubmit({ itemName: item.trim(), amountCents: cents })
      }}
    >
      <Field label="Item">
        <input
          ref={first}
          className="input"
          value={item}
          maxLength={100}
          onChange={(e) => setItem(e.target.value)}
        />
      </Field>
      <Field label="Total price, USD" error={error}>
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
      <div className="actions">
        <Button type="submit">{submitLabel}</Button>
        {onCancel && (
          <Button variant="text" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}
