import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  ArrowLeft,
  CalendarCheck,
  CalendarDays,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  ListChecks,
  Sparkles,
  TriangleAlert,
} from 'lucide-react'
import type { OptionResult, Product } from '../shared/types'
import { BalanceChart } from './BalanceChart'
import type { AppState, Comparison, PayIn4 } from './contract'
import { billOn, firstBelow, fits, lower, optionTitle, paydayOn, useComparison } from './engine'
import { cx, dayLabel, fromMoney, fullDate, money, shortDate, signed } from './format'
import { PayPalMessage } from './paypal'
import type { PayPalSdkInstance } from './paypalSdk'
import { Alert, Button, Dialog, Disc, Field, Pill, ReadAsChip, Ring, type Tone } from './ui'

export type OptionKey = 'buyToday' | 'wait' | 'spendLess'
export type DecisionRequest = { productId?: string; amountCents?: number; itemName?: string }
/** What Claude contributed to the answer this view came from, if it came from Ask. */
export interface Explanation {
  lead?: string
  points: string[]
  toolCalls: string[]
  mode: 'anthropic' | 'demo'
  readAs?: string
}

export function optionStatus(option: OptionResult): { tone: Tone; text: string } {
  return option.outcome === 'fits'
    ? { tone: 'ok', text: 'Fits' }
    : option.outcome === 'tight'
      ? { tone: 'bad', text: 'Dips below cushion' }
      : { tone: 'info', text: 'More info needed' }
}

/** The option keys the comparison can show, in order, with the wait card disabled without a date. */
function optionOf(c: Comparison, key: OptionKey): OptionResult | undefined {
  if (key === 'wait') return c.wait.date ? c.wait : undefined
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
        ? shortDate(breach.date)
        : dayLabel(breach.date)
  const first = `Below cushion from ${day}${bill ? ` (${lower(bill)})` : ''}`
  if (short) return first
  if (breach.date === option.lowestDate)
    return `${first}.${paydayOn(option.points, option.lowestDate) ? ' Lowest that day, before payday.' : ''}`
  return `${first}. Lowest ${dayLabel(option.lowestDate)}${paydayOn(option.points, option.lowestDate) ? ', before payday' : ''}.`
}

export function AnswerSentence({ c }: { c: Comparison }) {
  const cushion = money(c.cushionCents)
  const breach = firstBelow(c.buyToday.points, c.cushionCents)
  const bill = billOn(breach)
  const today = breach && (
    <>
      {' '}
      Buying today puts you below it{' '}
      {breach.date === c.today ? (
        <b>right away</b>
      ) : (
        <>
          from <b>{dayLabel(breach.date)}</b>
        </>
      )}
      {bill ? `, when ${lower(bill)} is due` : ''}.
    </>
  )
  if (c.recommendation === null)
    return <>Your plan needs a few details before Worth can compare these options.</>
  if (c.recommendation === 'buyToday')
    return (
      <>
        <b>Buy today</b> and you stay {money(c.buyToday.headroomCents)} above your {cushion}{' '}
        cushion.
      </>
    )
  if (c.recommendation === 'wait' && c.wait.date)
    return (
      <>
        <b>Wait until {dayLabel(c.wait.date)}</b> and you stay {money(c.wait.headroomCents)} above
        your {cushion} cushion.{today}
      </>
    )
  if (c.spendLess.maxPriceCents <= 0)
    return (
      <>
        No date in the next 30 days keeps your {cushion} cushion, and your plan already reaches it
        without this purchase.
      </>
    )
  return (
    <>
      No date in the next 30 days keeps your {cushion} cushion.{' '}
      <b>Spend up to {money(c.spendLess.maxPriceCents)} today</b> and you keep it.
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
  if (!option)
    return (
      <div className="opt" role="radio" aria-checked="false" aria-disabled="true" tabIndex={-1}>
        <span className="head">
          <span className="ot">{title}</span>
          <Pill tone="info">No date fits</Pill>
        </span>
        <span className="why">No date in the next 30 days keeps your cushion.</span>
      </div>
    )
  const status = optionStatus(option)
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
        <span className="k">{k === 'spendLess' ? 'Up to, today' : 'Lowest balance'}</span>
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
}: {
  c: Comparison
  k: OptionKey
  payIn4?: Extract<PayIn4, { available: true }>
}) {
  const option = optionOf(c, k) ?? c.buyToday
  const cause = option.lowPointCause
  const payday = paydayOn(option.points, option.lowestDate)
  const above = option.lowestBalanceCents >= c.cushionCents
  const title = chartTitle(c, k)
  return (
    <section className="tile" aria-labelledby="chart-title">
      <div className="sec-head" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <h2 className="h-section" id="chart-title">
            {title}
          </h2>
          <div className="meta">
            Your balance, {shortDate(c.window.start)} to {shortDate(c.window.end)}
          </div>
        </div>
        <div className="legend" aria-hidden="true">
          <span>
            <i className="sw" />
            Balance
          </span>
          <span>
            <i className="sw dash" />
            Cushion {money(c.cushionCents, c.cushionCents % 100 !== 0)}
          </span>
          <span>
            <i className="sw zone" />
            Below cushion
          </span>
          {payIn4 && (
            <span>
              <i className="sw p4" />
              Pay in 4 from today · illustrative
            </span>
          )}
        </div>
      </div>
      <BalanceChart
        points={option.points}
        cushionCents={c.cushionCents}
        purchase={{ date: option.purchaseDate, amountCents: option.amountCents }}
        payIn4={payIn4}
        label={`Projected balance ${title.toLowerCase().replace(/^if/, 'if')}. Lowest point ${signed(option.lowestBalanceCents)} on ${fullDate(option.lowestDate)}, which ${above ? 'stays above' : 'is below'} your ${money(c.cushionCents)} cushion.`}
      />
      <p className="meta" style={{ marginTop: 12, color: 'var(--c-text-strong)' }}>
        Lowest <b className="num">{signed(option.lowestBalanceCents)}</b> on{' '}
        {dayLabel(option.lowestDate)}
        {cause && cause.date === option.lowestDate && payday
          ? `: ${lower(cause.name)} leaves before your paycheck lands that day.`
          : cause
            ? `, after ${lower(cause.name)} on ${dayLabel(cause.date)}.`
            : '.'}
      </p>
    </section>
  )
}

function nearText(
  near: Extract<PayIn4, { available: true }>['instalments'][number]['nearestBill'],
) {
  if (!near) return <>No bill within 3 days</>
  const days = Math.abs(near.daysFromInstalment)
  const name = <b>{lower(near.name)}</b>
  if (near.daysFromInstalment === 0) return <>Same day as your {name}</>
  return near.daysFromInstalment < 0 ? (
    <>
      {days} {days === 1 ? 'day' : 'days'} after {name}
    </>
  ) : (
    <>
      {days} {days === 1 ? 'day' : 'days'} before {name}
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
              Compare with PayPal Pay in 4
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
            Compare with PayPal Pay in 4
          </span>
          <span className="meta">
            4 payments {amounts.size > 1 ? 'from' : 'of'}{' '}
            {money(p4.instalments.at(-1)!.amountCents)}, starting today · illustrative
          </span>
        </span>
        <ChevronDown className="ico chev" aria-hidden="true" />
      </button>
      <div className="panel" id={panelId} hidden={!open}>
        <Alert tone={breach ? 'bad' : 'ok'} icon={breach ? TriangleAlert : CircleCheck} live>
          <b>{p4.label}.</b>
          <br />
          Lowest <span className="num">{signed(p4.lowestBalanceCents)}</span> on{' '}
          {shortDate(p4.lowestDate)}
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
                    {item.date === c.today ? 'Today' : dayLabel(item.date)}
                  </div>
                </div>
              </div>
              <div className="near">{nearText(item.nearestBill)}</div>
              <div className="after num">
                Lowest after: {signed(item.balanceCents)} on {shortDate(item.lowestDate)}
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
                  .map((item) => `${money(item.amountCents)} on ${shortDate(item.date)}`)
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
        {open && <PayPalMessage instance={instance} amountCents={c.amountCents} />}
        <p className="caption">
          {p4.notice} Pay in 4 is shown for comparison only; Worth never recommends it.
          {rangeOnly ? ' Availability is decided by PayPal at checkout.' : ''}
        </p>
      </div>
    </div>
  )
}

function Skeleton() {
  return (
    <div className="stack" aria-busy="true">
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
  onEditPlan,
}: {
  state: AppState
  request: DecisionRequest
  explanation?: Explanation
  instance?: PayPalSdkInstance
  backLabel: string
  onBack: () => void
  onBuy: (product: Product, acknowledgeShortfall: boolean) => void
  onSave: (product: Product, waitDate?: string) => void
  onEditPlan: () => void
}) {
  const [override, setOverride] = useState<DecisionRequest>()
  const active = override ?? request
  const { comparison: c, error, loading } = useComparison(active, state.profile.version)
  const [picked, setPicked] = useState<OptionKey>()
  const [p4Open, setP4Open] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirmBuy, setConfirmBuy] = useState(false)
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
  const keys: OptionKey[] = ['buyToday', 'wait', 'spendLess']
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
  const primary =
    product &&
    (c.recommendation === 'buyToday'
      ? { label: 'Buy now', run: () => onBuy(product, false) }
      : c.recommendation === 'wait' && c.wait.date
        ? {
            label: `Plan to buy on ${dayLabel(c.wait.date)}`,
            run: () => onSave(product, c.wait.date ?? undefined),
          }
        : { label: 'Save for later', run: () => onSave(product) })
  const anyway = product && c.recommendation !== 'buyToday' && c.recommendation !== null
  const breach = firstBelow(c.buyToday.points, c.cushionCents)
  const actions = (
    <>
      {primary && (
        <Button block onClick={primary.run}>
          {primary.label}
        </Button>
      )}
      {anyway && (
        <Button variant="text" onClick={() => setConfirmBuy(true)}>
          Buy today anyway
        </Button>
      )}
    </>
  )
  return (
    <Frame actions={product ? actions : undefined}>
      <div className="stack tight" style={{ marginBottom: 'var(--s-6)' }}>
        <button
          type="button"
          className="link hide-m"
          onClick={onBack}
          style={{ fontSize: 'var(--fs-meta)', alignSelf: 'flex-start' }}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          {backLabel}
        </button>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px 16px' }}>
          <h1 className="title">
            {c.itemName}, {money(c.amountCents)}
          </h1>
          {!editing && <ReadAsChip value={readAs} onAction={() => setEditing(true)} />}
        </div>
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
                  : next,
              )
            }}
          />
        )}
        <p className="lead">
          <AnswerSentence c={c} />
        </p>
        {c.recommendation === null && (
          <Alert tone="warn" icon={CircleAlert}>
            <b>Confirm these first:</b>
            <ul>
              {c.missingFields.map((field) => (
                <li key={field}>{field}</li>
              ))}
            </ul>
            <Button variant="secondary" onClick={onEditPlan} style={{ marginTop: 12 }}>
              Review your plan
            </Button>
          </Alert>
        )}
      </div>
      <div className="grid">
        <div className="stack">
          <div role="radiogroup" aria-label="Your options" className="options">
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
          <ChartTile c={c} k={selected} payIn4={p4Open ? p4 : undefined} />
          <PayIn4Panel
            c={c}
            open={p4Open}
            onToggle={() => setP4Open(!p4Open)}
            instance={instance}
          />
        </div>
        <aside className="rail" aria-label="Item and reasons">
          <div className="tile">
            <div className="product">
              {product && <img src={product.image} alt={product.name} />}
              <div>
                <div className="pt">{product?.name ?? c.itemName}</div>
                <div className="meta">
                  {product
                    ? `${product.merchant} · demo store`
                    : 'Checkout is for demo store items'}
                </div>
                <div className="num strong" style={{ fontWeight: 700, marginTop: 4 }}>
                  {money(c.amountCents)}
                </div>
              </div>
            </div>
            {product && (
              <div className="rail-actions">
                {actions}
                <p className="caption" style={{ textAlign: 'center' }}>
                  You’ll approve in PayPal, then confirm here. Nothing is charged until you do.
                </p>
              </div>
            )}
          </div>
          <WhyThisAnswer explanation={explanation} />
          <section aria-labelledby="inputs-title">
            <div className="sec-head">
              <h2 className="h-section" id="inputs-title">
                What went into this
              </h2>
            </div>
            <dl className="kvlist">
              <div>
                <dt>Money available</dt>
                <dd className="num">
                  {money(state.profile.balanceCents)} ·{' '}
                  {state.profile.snapshotDate === state.today
                    ? 'today'
                    : shortDate(state.profile.snapshotDate)}
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
          </section>
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

const TOOL_LABELS: Record<string, string> = {
  interpret_purchase: 'interpret_purchase',
  compare_options: 'compare_options',
  prepare_checkout: 'prepare_checkout',
}
function WhyThisAnswer({ explanation }: { explanation?: Explanation }) {
  const claude = explanation?.mode === 'anthropic' && explanation.points.length > 0
  const tools = [...new Set(explanation?.toolCalls ?? [])]
  return (
    <section aria-labelledby="why-title">
      <div className="sec-head">
        <h2 className="h-section" id="why-title">
          Why this answer
        </h2>
      </div>
      {claude ? (
        <>
          {explanation!.lead && <p className="strong">{explanation!.lead}</p>}
          <ul style={{ margin: '8px 0 12px', paddingLeft: 20, color: 'var(--c-text-strong)' }}>
            {explanation!.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          <div className="claude">
            <Sparkles className="ico" aria-hidden="true" />
            Explained by Claude · numbers from your plan
          </div>
        </>
      ) : (
        <p className="strong" style={{ marginBottom: 12 }}>
          Worth projected your balance each day for the next 60 days, once for each option, using
          your money, bills, income and everyday spending.
        </p>
      )}
      <div className="trace" style={{ marginTop: 6 }}>
        <ListChecks className="ico" aria-hidden="true" />
        {tools.length
          ? `Tool: ${tools.map((tool) => TOOL_LABELS[tool] ?? tool).join(', ')} · next 60 days`
          : 'Worth’s own calculation · next 60 days'}
      </div>
    </section>
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
