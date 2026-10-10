import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  ArrowLeft,
  Bookmark,
  CalendarCheck,
  CalendarDays,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  ListChecks,
  Sparkles,
  TriangleAlert,
} from 'lucide-react'
import { PAY_IN_4_DATES_NOTE, PAY_IN_4_SPACING } from '../shared/collision'
import { confirmedSchedule, PAY_IN_4_MAX_CENTS, PAY_IN_4_MIN_CENTS } from '../shared/finance'
import type { Alternative, ForecastPoint, OptionResult, Product } from '../shared/types'
import { AlternativesPanel } from './Alternatives'
import { BalanceChart } from './BalanceChart'
import type { AppState, Comparison, PayIn4, SavePlan, SaveTarget } from './contract'
import { ASSESSMENT_ONLY } from './copy'
import { countedHold, ReservationNote } from './Reservation'
import {
  billOn,
  firstBelow,
  fits,
  lower,
  missingFix,
  optionTitle,
  paydayOn,
  purchasePlans,
  useComparison,
} from './engine'
import { boughtOn, cx, dayLabel, fromMoney, fullDate, money, shortDate, signed } from './format'
import { PayPalMessage } from './paypal'
import type { PayPalSdkInstance } from './paypalSdk'
import { Alert, Button, Dialog, Disc, Field, Pill, ReadAsChip, Ring, type Tone } from './ui'

export type OptionKey = 'buyToday' | 'wait' | 'spendLess'
export type DecisionRequest = {
  productId?: string
  amountCents?: number
  itemName?: string
  /** An item from a pasted link (C5): its store page and who set the confirmed price. */
  sourceUrl?: string
  priceSource?: 'channel3' | 'user'
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
  if (option.outcome === 'tight') return { tone: 'bad', text: 'Below cushion' }
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

/** "Below cushion from Mon, Oct 12 (rent). Lowest Thu, Oct 15, before payday." */
export function breachLine(option: OptionResult, cushion: number, short = false) {
  const breach = firstBelow(option.points, cushion)
  if (!breach) return undefined
  const bill = billOn(breach)
  const day =
    breach.date === option.points[0]?.date
      ? 'today'
      : short
        ? dayLabel(breach.date)
        : dayLabel(breach.date)
  const first = `Below cushion from ${day}${bill ? ` (${lower(bill)})` : ''}`
  if (short) return first
  if (breach.date === option.lowestDate)
    return `${first}.${paydayOn(option.points, option.lowestDate) ? ' Lowest that day, before payday.' : ''}`
  return `${first}. Lowest ${dayLabel(option.lowestDate)}${paydayOn(option.points, option.lowestDate) ? ', before payday' : ''}.`
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
  return <>No date in the next 30 days keeps your {cushion} cushion at the full price.</>
}

function OptionCard({
  c,
  k,
  checked,
  onSelect,
  tabIndex,
  onKeyDown,
  buttonRef,
}: {
  c: Comparison
  k: OptionKey
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
            : 'No date in the next 30 days keeps your cushion.'}
        </span>
      </div>
    )
  }
  const status =
    k === 'spendLess' && c.spendLess.maxPriceCents <= 0
      ? ({ tone: 'info', text: 'Nothing fits' } as const)
      : optionStatus(option)
  const below = option.lowestBalanceCents < c.cushionCents
  const fragile = fits(option) && option.stressLowestCents < c.cushionCents
  const why =
    k === 'spendLess'
      ? c.spendLess.maxPriceCents <= 0
        ? 'Nothing fits today without going below your cushion.'
        : option.headroomCents === 0
          ? `Leaves exactly your cushion on ${dayLabel(option.lowestDate)}`
          : `${money(option.headroomCents)} above cushion on ${dayLabel(option.lowestDate)}`
      : below
        ? breachLine(option, c.cushionCents)
        : `${dayLabel(option.lowestDate)}, ${money(option.headroomCents)} above cushion`
  return (
    <button
      type="button"
      className="opt"
      role="radio"
      aria-checked={checked}
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
          {k === 'spendLess' ? 'Most you can spend today' : 'Lowest balance'}
        </span>
        <span className={cx('v num', k !== 'spendLess' && below && 'bad')}>
          {k === 'spendLess' ? money(c.spendLess.maxPriceCents) : signed(option.lowestBalanceCents)}
        </span>
      </span>
      <span className="why">{why}</span>
      {fragile && (
        <span className="tight">
          <TriangleAlert className="ico" aria-hidden="true" />
          Tight: dips below if spending runs 20% higher
        </span>
      )}
    </button>
  )
}

function chartTitle(c: Comparison, k: OptionKey) {
  if (k === 'buyToday') return 'If you buy today'
  if (k === 'wait' && c.wait.date) return `If you wait until ${dayLabel(c.wait.date)}`
  return `If you spend ${money(c.spendLess.maxPriceCents)} today`
}

function ChartTile({
  c,
  k,
  payIn4,
  scaleWith,
}: {
  c: Comparison
  k: OptionKey
  payIn4?: Extract<PayIn4, { available: true }>
  /** The Pay in 4 scenario, open or not, so opening the comparison never rescales the chart. */
  scaleWith?: Extract<PayIn4, { available: true }>
}) {
  const option = optionOf(c, k) ?? c.buyToday
  const cause = option.lowPointCause
  const payday = paydayOn(option.points, option.lowestDate)
  const above = option.lowestBalanceCents >= c.cushionCents
  const title = chartTitle(c, k)
  return (
    <section className="tile" aria-labelledby="chart-title">
      <h2 className="h-section" id="chart-title">
        {title}
      </h2>
      <div className="meta">
        Your lowest balance each day, {shortDate(c.window.start)} to {shortDate(c.window.end)}
      </div>
      <BalanceChart
        points={option.points}
        cushionCents={c.cushionCents}
        purchase={{ date: option.purchaseDate, amountCents: option.amountCents }}
        payIn4={payIn4}
        scaleWith={scaleWith?.points}
        highlight={{
          billDate:
            cause && cause.kind !== 'spending' && cause.kind !== 'purchase'
              ? cause.date
              : undefined,
          paydayDate: option.points.find(
            (point) =>
              point.date >= option.lowestDate &&
              point.events.some((event) => event.kind === 'income'),
          )?.date,
        }}
        label={`Projected balance ${title.replace(/^If/, 'if')}. Lowest point ${signed(option.lowestBalanceCents)} on ${fullDate(option.lowestDate)}, which ${option.lowestBalanceCents === c.cushionCents ? 'is exactly' : above ? 'stays above' : 'is below'} your ${money(c.cushionCents)} cushion.`}
      />
      {/* With Pay in 4 open, the chart's own two-row comparison already states both lows. */}
      {!payIn4 && (
        <p className="meta" style={{ marginTop: 12, color: 'var(--c-text-strong)' }}>
          Lowest <b className="num">{signed(option.lowestBalanceCents)}</b> on{' '}
          {dayLabel(option.lowestDate)} (
          {option.lowestBalanceCents === c.cushionCents
            ? 'exactly your cushion'
            : `${money(Math.abs(option.lowestBalanceCents - c.cushionCents))} ${above ? 'above' : 'below'} your cushion`}
          )
          {cause && cause.date === option.lowestDate && payday
            ? `: ${lower(cause.name)} leaves before your paycheck lands that day.`
            : cause
              ? `, after ${lower(cause.name)} on ${dayLabel(cause.date)}.`
              : '.'}
        </p>
      )}
    </section>
  )
}

/**
 * The engine's Pay in 4 label, with its short date ("on Oct 22") written in full ("on Thu, Oct
 * 22") for display. The engine's own label is unchanged.
 */
function fullLabelDate(label: string, points: ForecastPoint[], cushion: number) {
  const dip = points.find(
    (point) => point.minimumCents < cushion && point.baselineMinimumCents >= cushion,
  )
  const base = points.find((point) => point.baselineMinimumCents < cushion)
  for (const point of [dip, base])
    if (point && label.endsWith(shortDate(point.date)))
      return `${label.slice(0, -shortDate(point.date).length)}${dayLabel(point.date)}`
  return label
}

function nearText(
  near: Extract<PayIn4, { available: true }>['instalments'][number]['nearestBill'],
) {
  if (!near) return <>No bill within about 3 days</>
  // PayPal's own dates can run a day or two later than this schedule, so every gap is "about".
  const days = Math.abs(near.daysFromInstalment)
  const name = <b>{lower(near.name)}</b>
  if (near.daysFromInstalment === 0) return <>About the same day as your {name}</>
  return near.daysFromInstalment < 0 ? (
    <>
      About {days} {days === 1 ? 'day' : 'days'} after {name}
    </>
  ) : (
    <>
      About {days} {days === 1 ? 'day' : 'days'} before {name}
    </>
  )
}

function PayIn4Panel({
  c,
  open,
  onToggle,
  instance,
}: {
  c: Comparison
  open: boolean
  onToggle: () => void
  instance?: PayPalSdkInstance
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
          </span>
        </div>
      </div>
    )
  // Before Phase 3's server check, the range alone decides, so it is labelled the same way.
  const rangeOnly = p4.eligibility !== 'paypal'
  const breach = p4.outcome !== 'fits'
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
            {money(p4.instalments.at(-1)!.amountCents)}, {PAY_IN_4_SPACING} from today ·
            illustrative
          </span>
        </span>
        <ChevronDown className="ico chev" aria-hidden="true" />
      </button>
      <div className="panel" id={panelId} hidden={!open}>
        <Alert tone={breach ? 'bad' : 'ok'} icon={breach ? TriangleAlert : CircleCheck} live>
          <b>{fullLabelDate(p4.label, p4.points, c.cushionCents)}.</b>
          <br />
          Lowest <span className="num">{signed(p4.lowestBalanceCents)}</span> on{' '}
          {dayLabel(p4.lowestDate)}
          {paydayOn(p4.points, p4.lowestDate) ? ', before payday' : ''}.
        </Alert>
        <div className="sched" role="list" aria-label="Illustrative Pay in 4 schedule">
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
                  <div className="when">
                    {item.date === c.today ? (
                      'Today'
                    ) : (
                      <>
                        About <span className="nowrap">{dayLabel(item.date)}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="near">{nearText(item.nearestBill)}</div>
              <div className="after num">
                Lowest after: {signed(item.balanceCents)} on{' '}
                <span className="nowrap">{dayLabel(item.lowestDate)}</span>
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
        {/* PayPal's message is Worth's demo store's own offer, so it shows only for its items. */}
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
}) {
  const [override, setOverride] = useState<DecisionRequest>()
  const active = override ?? request
  const { comparison: c, error, loading } = useComparison(active, state.profile.version)
  const [picked, setPicked] = useState<OptionKey>()
  const [p4Open, setP4Open] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirmBuy, setConfirmBuy] = useState(false)
  const [recheck, setRecheck] = useState(false)
  const radios = useRef<(HTMLButtonElement | null)[]>([])
  const product = active.productId
    ? state.products.find((item) => item.id === active.productId)
    : undefined
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
  // When the item fits, spending less isn't an option worth showing.
  const keys: OptionKey[] = fits(c.buyToday)
    ? ['buyToday', 'wait']
    : ['buyToday', 'wait', 'spendLess']
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
  const selectedOption = optionOf(c, selected) ?? c.buyToday
  const readAs = explanation?.readAs ?? `${c.itemName} · ${money(c.amountCents)} · today`
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
    label:
      c.recommendation === 'wait' && c.wait.date
        ? `Save for ${dayLabel(c.wait.date)}`
        : 'Save for later',
    run: () =>
      onSave(
        { kind: 'custom', name: c.itemName, amountCents: c.amountCents },
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
        <Button block variant="secondary" icon={Bookmark} onClick={custom.run}>
          {custom.label}
        </Button>
        {notes && (
          <p className="caption" style={{ textAlign: 'center' }}>
            {ASSESSMENT_ONLY}. Nothing is bought.
          </p>
        )}
      </>
    )
  const anyway = product && !pending && c.recommendation !== 'buyToday' && c.recommendation !== null
  const breach = firstBelow(c.buyToday.points, c.cushionCents)
  const actions = (notes: boolean) => (
    <>
      {primary && (
        <Button block onClick={primary.run}>
          {primary.label}
        </Button>
      )}
      {notes && primary && (
        <p className="caption" style={{ textAlign: 'center' }}>
          {primary.note}
        </p>
      )}
      {anyway && (
        <Button variant="text" onClick={() => setConfirmBuy(true)}>
          {/* Next to other stores' items, the action names the demo store's own product. */}
          {selected === 'spendLess'
            ? `Buy the ${product!.name.toLowerCase()} anyway`
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
                  <div className="meta">
                    Sold by {product!.merchant} · demo{'\u00a0'}store
                  </div>
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
  return (
    <Frame actions={product ? actions(false) : customActions(false) || undefined}>
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
            <p className="meta strong hide-m" style={{ margin: 0 }}>
              {c.itemName}, {money(c.amountCents)}
              {c.source ? ` · ${c.source.merchantName}` : ''}
            </p>
            <h1 className="title">{verdictTitle(c)}</h1>
            {!editing && (
              <div>
                <ReadAsChip value={readAs} onAction={() => setEditing(true)} />
              </div>
            )}
            {editing && (
              <EditPurchase
                name={c.itemName}
                amountCents={c.amountCents}
                onCancel={() => setEditing(false)}
                onSubmit={(next) => {
                  setEditing(false)
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
            )}
            <p className="lead">
              <AnswerDetail c={c} />
            </p>
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
          </div>
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
                onKeyDown={(event) => move(event, key)}
                buttonRef={(element) => {
                  radios.current[index] = element
                }}
              />
            ))}
          </div>
          {/* The Pay in 4 comparison sits right under the options, so its collisions are seen (#7). */}
          <PayIn4Panel
            c={c}
            open={p4Open}
            onToggle={() => setP4Open(!p4Open)}
            instance={instance}
          />
          {/* Under Spend less: real items from other stores that fit today, for discovery only. */}
          {selected === 'spendLess' &&
            keys.includes('spendLess') &&
            c.spendLess.maxPriceCents > 0 && (
              <AlternativesPanel
                state={state}
                request={
                  product
                    ? { productId: product.id }
                    : { itemName: c.itemName, amountCents: c.amountCents }
                }
                onSave={onSaveAlternative}
              />
            )}
          <ChartTile c={c} k={selected} payIn4={p4Open ? p4 : undefined} scaleWith={p4} />
        </div>
        <aside className="rail decision-rail" aria-label="Item and reasons">
          <div className="tile">
            <div className="product">
              {product && <img src={product.image} alt={product.name} />}
              <div>
                <div className="pt">{product?.name ?? c.itemName}</div>
                <div className="meta">
                  {product
                    ? `Sold by ${product.merchant} · demo\u00a0store`
                    : c.source
                      ? `At ${c.source.merchantName} · ${c.source.priceSource === 'channel3' ? 'price read by Channel3, confirmed by you' : 'price you entered'}`
                      : 'Checkout is for demo store items'}
                </div>
                <div className="num strong" style={{ fontWeight: 700, marginTop: 4 }}>
                  {money(c.amountCents)}
                </div>
              </div>
            </div>
            {c.source && (
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
            )}
            {product && <div className="rail-actions">{actions(true)}</div>}
            {custom && <div className="rail-actions">{customActions(true)}</div>}
          </div>
          <WhyThisAnswer explanation={explanation} />
          <Fold id="inputs" title="What went into this">
            <dl className="kvlist">
              <div>
                <dt>Money available</dt>
                <dd className="num">
                  {money(state.profile.balanceCents)} ·{' '}
                  {state.profile.snapshotDate === state.today
                    ? 'today'
                    : dayLabel(state.profile.snapshotDate)}
                </dd>
              </div>
              <div>
                <dt>Cushion</dt>
                <dd className="num">{money(c.cushionCents)}</dd>
              </div>
              <div>
                <dt>Everyday spending</dt>
                <dd className="num">{money(state.profile.dailySpendCents)} a day</dd>
              </div>
              <div>
                <dt>Window</dt>
                <dd>
                  {shortDate(c.window.start)} – {shortDate(c.window.end)}
                </dd>
              </div>
              <div>
                <dt>If everyday spending runs 20% higher</dt>
                <dd className="num">
                  Lowest {signed(selectedOption.stressLowestCents)}
                  <br />
                  {selectedOption.stressLowestCents < c.cushionCents ? (
                    <Pill tone="warn">Below cushion</Pill>
                  ) : (
                    <Pill tone="ok">Stays above</Pill>
                  )}
                </dd>
              </div>
            </dl>
          </Fold>
        </aside>
      </div>
      {confirmBuy && product && (
        <Dialog
          title="Buy today anyway?"
          onClose={() => setConfirmBuy(false)}
          footer={
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
                Your lowest balance would be {signed(c.buyToday.lowestBalanceCents)} on{' '}
                {dayLabel(c.buyToday.lowestDate)}.
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

/** A rail section that opens on request, so the answer above stays the one thing to read. */
function Fold({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="fold" data-open={open} aria-labelledby={`${id}-head`}>
      <h2 className="h-section">
        <button
          type="button"
          id={`${id}-head`}
          className="fold-head"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => setOpen(!open)}
        >
          {title}
          <ChevronDown className="ico chev" aria-hidden="true" />
        </button>
      </h2>
      <div id={`${id}-body`} hidden={!open} className="fold-body">
        {children}
      </div>
    </section>
  )
}

function WhyThisAnswer({ explanation }: { explanation?: Explanation }) {
  const claude = explanation?.mode === 'anthropic' && explanation.points.length > 0
  return (
    <Fold id="why" title="Why this answer">
      {claude ? (
        <>
          {explanation!.lead && <p className="strong">{explanation!.lead}</p>}
          <ul style={{ margin: '8px 0 12px', paddingLeft: 20, color: 'var(--c-text-strong)' }}>
            {explanation!.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="strong" style={{ marginBottom: 12 }}>
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
    </Fold>
  )
}

export function EditPurchase({
  name,
  amountCents,
  onSubmit,
  onCancel,
}: {
  name: string
  amountCents: number
  onSubmit: (next: { itemName: string; amountCents: number }) => void
  onCancel: () => void
}) {
  const [item, setItem] = useState(name)
  const [amount, setAmount] = useState((amountCents / 100).toFixed(2))
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
        <Button type="submit">Check again</Button>
        <Button variant="text" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
