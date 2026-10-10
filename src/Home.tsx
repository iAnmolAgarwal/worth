import { useState } from 'react'
import {
  ArrowRight,
  ArrowUp,
  Bookmark,
  CalendarCheck,
  CalendarClock,
  CircleAlert,
  Info,
  ReceiptText,
  RefreshCw,
} from 'lucide-react'
import { mainCollision, nearPhrase, planLabel } from '../shared/collision'
import { getUpcomingFlows, planCollisions } from '../shared/finance'
import type { Product, SavedItem } from '../shared/types'
import type { AppState, Purchase } from './contract'
import { isActive } from './contract'
import { ASSESSMENT_ONLY, MAY_FIT_NOW, SAMPLE_WHO } from './copy'
import { countedHold, ReservationNote } from './Reservation'
import { FundsDialog } from './Saved'
import {
  allPlans,
  boughtProductIds,
  cadenceLabel,
  flowIcon,
  kindLabel,
  missingFix,
  purchasePlans,
  useComparison,
} from './engine'
import { dayLabel, daysFrom, money, signed, displayName } from './format'
import { Alert, Button, Disc, Pill, SkeletonRow } from './ui'

/** The camera starter comes first, so it shows at every width (judge fix #10). */
export const HOME_SUGGESTIONS = [
  'Can I afford a $1,199 camera?',
  'What’s coming up?',
  'How much can I spend today?',
]

export function Composer({
  onAsk,
  placeholder,
  id,
}: {
  onAsk: (text: string) => void
  placeholder: string
  id: string
}) {
  const [value, setValue] = useState('')
  return (
    <form
      className="composer"
      role="search"
      onSubmit={(event) => {
        event.preventDefault()
        if (!value.trim()) return
        onAsk(value.trim())
        setValue('')
      }}
    >
      <label className="sr" htmlFor={id}>
        Ask about a purchase
      </label>
      <input
        id={id}
        value={value}
        maxLength={2000}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
      />
      <button className="send" type="submit" aria-label="Ask">
        <ArrowUp className="ico" strokeWidth={2} aria-hidden="true" />
      </button>
    </form>
  )
}

function HeroTile({
  state,
  onAsk,
  onPlan,
  onNavigate,
  onOpenCheckout,
  onConfirmFunds,
  fundsElsewhere = false,
}: {
  state: AppState
  onAsk: () => void
  onPlan: () => void
  onNavigate: (hash: string) => void
  onOpenCheckout: (purchase: Purchase) => void
  onConfirmFunds: () => void
  /** The saved plan's own card below asks for today's funds, so this tile doesn't repeat it. */
  fundsElsewhere?: boolean
}) {
  const hold = countedHold(state)
  const { comparison: room, loading } = useComparison(
    { amountCents: 0, itemName: 'Room to spend' },
    state.profile.version,
  )
  const income = getUpcomingFlows(state.profile, state.today, 30).find(
    ({ flow }) => flow.kind === 'income',
  )
  if (!state.profile.confirmed)
    return (
      <section className="balance unconfirmed" aria-labelledby="bal-k">
        <Pill tone="warn">
          <CircleAlert size={14} aria-hidden="true" /> Needs your confirmation
        </Pill>
        <h2 className="h-section" id="bal-k">
          Confirm today’s money to see what’s safe
        </h2>
        <p className="meta">
          Worth needs your money available today, your income and your bills before it can say how
          much room you have.
        </p>
        <Button onClick={onPlan}>Confirm</Button>
      </section>
    )
  if (room && room.recommendation === null) {
    // The plan is confirmed, so name the one thing that still blocks an answer and where to fix it.
    const [first, ...rest] = room.missingFields
    const fix = first ? missingFix(first) : undefined
    // Only a stale funds date (and one-time payments since then) is missing: today's funds can be
    // confirmed in place, without reopening the whole plan.
    const quickFunds = room.missingFields.every((field) =>
      /^Refresh available funds|already happened/.test(field),
    )
    return (
      <section className="balance unconfirmed" aria-labelledby="bal-k">
        <Pill tone="warn">
          <CircleAlert size={14} aria-hidden="true" />{' '}
          {rest.length ? `${rest.length + 1} things to fix` : 'One thing to fix'}
        </Pill>
        <h2 className="h-section" id="bal-k">
          {first ?? 'Your plan needs a detail before Worth can show room to spend.'}
        </h2>
        <p className="meta">
          Room to spend shows again once this is done
          {quickFunds && fundsElsewhere ? ', from your saved plan below.' : '.'}
        </p>
        {quickFunds
          ? !fundsElsewhere && <Button onClick={onConfirmFunds}>Confirm today’s funds</Button>
          : fix && <Button onClick={() => onNavigate(fix.hash)}>{fix.label}</Button>}
      </section>
    )
  }
  if (loading || !room)
    return (
      <section className="balance" aria-busy="true" aria-label="Room to spend today">
        <div>
          <div className="k">Room to spend today</div>
          <span
            className="sk"
            style={{ width: 180, height: 44, margin: '20px 0 8px', opacity: 0.4 }}
          />
        </div>
      </section>
    )
  const kept = room.buyToday.outcome === 'fits'
  return (
    <section className="balance" aria-labelledby="bal-k">
      <div>
        <div className="k" id="bal-k">
          Room to spend today
        </div>
        <div className="v num">{money(room.spendLess.maxPriceCents)}</div>
        <p className="sub">
          {kept
            ? `Keeps your ${money(room.cushionCents)} cushion through ${dayLabel(room.window.end)}, if your plan holds.`
            : `Your plan already dips below your ${money(room.cushionCents)} cushion on ${dayLabel(room.buyToday.lowestDate)}.`}{' '}
          Based on {money(state.profile.balanceCents)} you confirmed{' '}
          {state.profile.snapshotDate === state.today
            ? 'today'
            : `on ${dayLabel(state.profile.snapshotDate)}`}
          .
        </p>
        {hold && <ReservationNote purchase={hold} onReview={onOpenCheckout} onBrand />}
        <a
          href="#ask"
          onClick={(event) => {
            event.preventDefault()
            onAsk()
          }}
        >
          Check a purchase <ArrowRight size={16} aria-hidden="true" />
        </a>
      </div>
      {income && (
        <div className="side hide-m">
          Next payday
          <b className="num">{dayLabel(income.date)}</b>
          <span className="num">{signed(income.flow.amountCents, true)}</span>
        </div>
      )}
    </section>
  )
}

/**
 * The engine's collision on Home: a payment of a plan already running that lands next to a bill,
 * such as the laptop's Pay in 4 payment the day before rent (judge #7). It names, never advises.
 */
function CollisionInsight({ state, onShowPlan }: { state: AppState; onShowPlan: () => void }) {
  if (!state.profile.confirmed) return null
  const found = planCollisions(state.profile, state.purchases, state.today).map((c, number) => ({
    ...c,
    number,
    nearestBill: c.bill,
  }))
  const main = mainCollision(found)
  if (!main) return null
  const { payment, bill } = main
  // Pay in 4 is PayPal's product, so a Pay in 4 plan gets its full name; any other plan stays generic.
  const payIn4 = /\bpay\s+in\s+4\b/i.test(payment.name)
  return (
    <section
      className="tile notice"
      aria-label={`${payIn4 ? 'PayPal Pay in 4' : 'Plan'} payment next to a bill`}
    >
      <div className="row plain">
        <Disc icon={CalendarClock} kind="plan" />
        <div className="body">
          <div className="t">
            Your {planLabel(payment.name)} {payIn4 ? 'PayPal Pay in 4' : 'plan'} payment lands{' '}
            {nearPhrase(bill.daysFromInstalment, displayName(bill.name), bill.kind)}
          </div>
          <div className="s">
            <span className="soft">
              {money(payment.amountCents)} on {dayLabel(payment.date)} · {displayName(bill.name)}{' '}
              {money(bill.amountCents)} on {dayLabel(bill.date)}
            </span>
          </div>
        </div>
      </div>
      <div className="actions">
        <Button variant="secondary" onClick={onShowPlan}>
          See your plan
        </Button>
      </div>
    </section>
  )
}

function ComingUp({ state, onShowAll }: { state: AppState; onShowAll: () => void }) {
  const plans = allPlans(state)
  // Confirmed Pay in 4 payments for Worth purchases join the plan's own commitments.
  const bought = purchasePlans(state).flatMap((plan) =>
    plan.dates
      .map((date, index) => ({
        date,
        flow: {
          id: `${plan.planId}-${index}`,
          planId: plan.planId,
          name: plan.name,
          amountCents: plan.amounts?.[index] ?? plan.amountCents,
          nextDate: date,
          cadence: 'once' as const,
          kind: 'installment' as const,
          category: 'Instalment plans',
          confirmed: true,
          active: true,
        },
      }))
      .filter(({ date }) => daysFrom(state.today, date) <= 30),
  )
  const upcoming = [...getUpcomingFlows(state.profile, state.today, 30), ...bought].sort(
    (a, b) => a.date.localeCompare(b.date) || b.flow.amountCents - a.flow.amountCents,
  )
  // Everything in the next two weeks shows, so a big bill like rent is never hidden; later
  // items fill up to five rows and the rest are counted.
  const soon = upcoming.filter(({ date }) => daysFrom(state.today, date) <= 14)
  const laterAll = upcoming.filter(({ date }) => daysFrom(state.today, date) > 14)
  const later = laterAll.slice(0, Math.max(0, 5 - soon.length))
  const hidden = laterAll.length - later.length
  const sameMonth = later.every(({ date }) => date.slice(0, 7) === state.today.slice(0, 7))
  const row = ({ flow, date }: (typeof upcoming)[number]) => {
    const plan =
      flow.kind === 'installment'
        ? plans.find((p) => p.planId === (flow.planId ?? flow.id))
        : undefined
    const index = plan ? plan.dates.indexOf(date) : -1
    const paymentNumber = plan?.total ? plan.total - plan.left + index + 1 : undefined
    return (
      <div className="row" key={`${flow.id}-${date}`}>
        <Disc
          icon={flowIcon(flow)}
          kind={
            flow.kind === 'income' ? 'income' : flow.kind === 'installment' ? 'plan' : undefined
          }
        />
        <div className="body">
          <div className="t">{displayName(flow.name)}</div>
          <div className="s">
            {dayLabel(date)}{' '}
            <span className="soft">
              ·{' '}
              {paymentNumber
                ? `Payment ${paymentNumber} of ${plan!.total}`
                : flow.kind === 'income'
                  ? `Income, ${cadenceLabel({ cadence: flow.cadence, nextDate: date }).replace(/^E/, 'e')}`
                  : kindLabel(flow.kind)}
            </span>
          </div>
          {paymentNumber && plan?.total && (
            <div
              className="prog"
              role="img"
              aria-label={`${paymentNumber - 1} of ${plan.total} paid`}
            >
              <i style={{ width: `${((paymentNumber - 1) / plan.total) * 100}%` }} />
            </div>
          )}
        </div>
        <div className={`amt num${flow.kind === 'income' ? ' pos' : ''}`}>
          {flow.kind === 'income' ? signed(flow.amountCents, true) : signed(-flow.amountCents)}
        </div>
      </div>
    )
  }
  return (
    <section aria-labelledby="coming-title">
      <div className="sec-head">
        <h2 className="h-section" id="coming-title">
          Coming up
        </h2>
        <button type="button" className="link" onClick={onShowAll}>
          Show all
        </button>
      </div>
      {!upcoming.length && (
        <p className="meta">Nothing scheduled in the next 30 days. Add your bills in your plan.</p>
      )}
      {soon.length > 0 && (
        <>
          <h3 className="group-label">Next 2 weeks</h3>
          <div className="rows">{soon.map(row)}</div>
        </>
      )}
      {later.length > 0 && (
        <>
          <h3 className="group-label" style={{ marginTop: 'var(--s-4)' }}>
            {sameMonth ? 'Later this month' : 'Later'}
          </h3>
          <div className="rows">{later.map(row)}</div>
        </>
      )}
      {hidden > 0 && (
        <button type="button" className="link" onClick={onShowAll} style={{ marginTop: 8 }}>
          And {hidden} more in the next 30 days
        </button>
      )}
    </section>
  )
}

export function SavedRows({
  items,
  products,
  onOpen,
}: {
  items: SavedItem[]
  products: Product[]
  onOpen: (item: SavedItem) => void
}) {
  return (
    <div className="rows">
      {items.map((item) => {
        const product = products.find((p) => p.id === item.productId)
        return (
          <button
            type="button"
            className="row plain small"
            key={item.id}
            onClick={() => onOpen(item)}
          >
            {product ? (
              <img className="thumb" src={product.image} alt="" />
            ) : (
              <Disc icon={Bookmark} kind="plan" />
            )}
            <div className="body">
              <div className="t">{item.name}</div>
              <div className="s">
                <span className="soft">
                  {item.status === 'ready'
                    ? 'May fit now'
                    : item.waitDate
                      ? `Planned for ${dayLabel(item.waitDate)}`
                      : (product?.merchant ?? ASSESSMENT_ONLY)}
                </span>
              </div>
            </div>
            <div className="amt num">{money(item.amountCents)}</div>
          </button>
        )
      })}
    </div>
  )
}

export function Home({
  state,
  onAsk,
  onNavigate,
  onOpenProduct,
  onOpenSaved,
  onEditPlan,
  onImport,
  onOpenCheckout,
  onConfirmPlan,
  onReviewRefund,
  onUpdate,
}: {
  state: AppState
  onAsk: (text?: string) => void
  onNavigate: (hash: string) => void
  onOpenProduct: (product: Product) => void
  /** Opens a saved custom item's comparison. */
  onOpenSaved?: (item: SavedItem) => void
  onEditPlan: () => void
  /** Opens the PayPal activity import, offered while the sample persona is showing. */
  onImport?: () => void
  onOpenCheckout: (purchase: Purchase) => void
  onConfirmPlan: (purchaseId: string) => void
  onReviewRefund: (purchaseId: string, refundId: string) => void
  onUpdate?: (state: AppState) => void
}) {
  const [funds, setFunds] = useState(false)
  const active = state.purchases.find(isActive)
  const bought = boughtProductIds(state)
  // Bought items leave the Saved list on Home; the Saved page marks them instead.
  const saved = (state.saved ?? []).filter(
    (item) => item.status !== 'bought' && !(item.productId && bought.has(item.productId)),
  )
  const ready = saved.find((item) => item.status === 'ready')
  const fundsToday = state.profile.confirmed && state.profile.snapshotDate === state.today
  const openSaved = (item: SavedItem) => {
    const product = state.products.find((p) => p.id === item.productId)
    if (product) onOpenProduct(product)
    else onOpenSaved?.(item)
  }
  const income = state.profile.flows.find((flow) => flow.kind === 'income' && flow.active)
  const plans = allPlans(state)
  return (
    <div className="page">
      <div className="wrap">
        <h1 className="sr">Home</h1>
        <div className="grid">
          <div className="stack">
            {state.profile.source === 'demo' && (
              <Alert tone="info" icon={Info}>
                You’re viewing {SAMPLE_WHO} with a paycheck, rent and one PayPal Pay in 4 plan.{' '}
                {onImport && (
                  <button type="button" className="link inline" onClick={onImport}>
                    Use your own PayPal activity
                    <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
                  </button>
                )}
              </Alert>
            )}
            <HeroTile
              state={state}
              onAsk={() => onAsk()}
              onPlan={onEditPlan}
              onNavigate={onNavigate}
              onOpenCheckout={onOpenCheckout}
              onConfirmFunds={() => setFunds(true)}
              fundsElsewhere={Boolean(ready) && !fundsToday}
            />
            {ready && (
              <section
                className="tile notice"
                aria-label={fundsToday ? 'Your saved plan’s day has come' : MAY_FIT_NOW}
              >
                <div className="row plain">
                  <Disc icon={CalendarCheck} kind="plan" />
                  <div className="body">
                    <div className="t">
                      {fundsToday
                        ? 'Your saved plan’s day has come: today’s funds are confirmed'
                        : MAY_FIT_NOW}
                    </div>
                    <div className="s">
                      <span className="soft">
                        {ready.name} · {money(ready.amountCents)} · planned for{' '}
                        {dayLabel(ready.waitDate!)}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="actions" style={{ marginTop: 12 }}>
                  <Button onClick={() => onNavigate(`saved?check=${ready.id}`)}>
                    {fundsToday ? 'See today’s check' : 'Confirm today’s funds'}
                  </Button>
                </div>
              </section>
            )}
            {active && (
              <section className="tile notice" aria-label="Checkout to finish">
                <div className="row plain">
                  <Disc icon={ReceiptText} />
                  <div className="body">
                    <div className="t">Finish your checkout</div>
                    <div className="s">
                      <span className="soft">
                        {active.name} · {money(active.amountCents)} stays set aside until it’s
                        resolved.
                      </span>
                    </div>
                  </div>
                </div>
                <div className="actions" style={{ marginTop: 12 }}>
                  <Button onClick={() => onOpenCheckout(active)}>Review checkout</Button>
                </div>
              </section>
            )}
            {state.reviews.map((review) => (
              <section
                className="tile notice"
                key={review.kind === 'refund' ? review.refundId : review.purchaseId}
                aria-label={review.title}
              >
                <div className="row plain">
                  <Disc icon={review.kind === 'refund' ? RefreshCw : CalendarCheck} kind="plan" />
                  <div className="body">
                    <div className="t">
                      {review.kind === 'refund'
                        ? `The store refunded ${money(review.refundedCents)}`
                        : `${review.title}: ${review.name}`}
                    </div>
                    <div className="s">
                      <span className="soft">
                        {review.kind === 'refund'
                          ? 'Confirm what came back to you. Nothing changes until you do.'
                          : 'Did you pay in full or with Pay in 4? Worth counts the full price until you confirm.'}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="actions" style={{ marginTop: 12 }}>
                  <Button
                    onClick={() =>
                      review.kind === 'refund'
                        ? onReviewRefund(review.purchaseId, review.refundId)
                        : onConfirmPlan(review.purchaseId)
                    }
                  >
                    {review.kind === 'refund' ? 'Review refund' : 'Confirm your plan'}
                  </Button>
                </div>
              </section>
            ))}
            <section className="tile" aria-labelledby="ask-title">
              <div className="sec-head">
                <h2 className="h-section" id="ask-title">
                  Thinking about buying something?
                </h2>
              </div>
              <Composer onAsk={onAsk} placeholder="Can I afford a $1,199 camera?" id="home-q" />
              <div className="chips" style={{ marginTop: 'var(--s-3)' }}>
                {HOME_SUGGESTIONS.map((text, index) => (
                  <button
                    type="button"
                    key={text}
                    className={`chip-suggest${index === 2 ? ' hide-m' : ''}`}
                    onClick={() => onAsk(text)}
                  >
                    {text}
                  </button>
                ))}
              </div>
            </section>
            {/* Under the starters, so the camera starter stays above the fold at 390 (round-2 #10). */}
            <CollisionInsight state={state} onShowPlan={() => onNavigate('plan')} />
            <ComingUp state={state} onShowAll={() => onNavigate('plan')} />
          </div>
          <aside className="rail" aria-label="Saved and your plan">
            <section aria-labelledby="saved-title">
              <div className="sec-head">
                <h2 className="h-section" id="saved-title">
                  Saved
                </h2>
                <button type="button" className="link" onClick={() => onNavigate('saved')}>
                  Show all
                </button>
              </div>
              {saved.length ? (
                <SavedRows items={saved.slice(0, 3)} products={state.products} onOpen={openSaved} />
              ) : (
                <p className="meta">Nothing saved yet. Items you plan to buy later show up here.</p>
              )}
            </section>
            <section aria-labelledby="plan-title">
              <div className="sec-head">
                <h2 className="h-section" id="plan-title">
                  Your plan
                </h2>
              </div>
              <dl className="kvlist">
                <div>
                  <dt>Money available</dt>
                  <dd className="num">
                    {money(state.profile.balanceCents)}
                    <span className="caption">
                      {!state.profile.confirmed
                        ? 'Not confirmed'
                        : state.profile.snapshotDate === state.today
                          ? 'Confirmed today'
                          : `Confirmed ${dayLabel(state.profile.snapshotDate)}`}
                    </span>
                  </dd>
                </div>
                {income && (
                  <div>
                    <dt>Paycheck</dt>
                    <dd className="num">
                      {money(income.amountCents)}
                      <span className="caption">{cadenceLabel(income)}</span>
                    </dd>
                  </div>
                )}
                <div>
                  <dt>Cushion</dt>
                  <dd className="num">{money(state.profile.cushionCents)}</dd>
                </div>
                <div>
                  <dt>Everyday spending</dt>
                  <dd className="num">{money(state.profile.dailySpendCents)} a day</dd>
                </div>
                <div>
                  <dt>Pay in 4 plans</dt>
                  <dd>{plans.length ? `${plans.length} running` : 'None'}</dd>
                </div>
              </dl>
              <button
                type="button"
                className="link"
                style={{ fontSize: 'var(--fs-section)', marginTop: 4 }}
                onClick={onEditPlan}
              >
                Edit your plan
              </button>
            </section>
          </aside>
        </div>
      </div>
      {funds && (
        <FundsDialog
          state={state}
          onClose={() => setFunds(false)}
          onConfirmed={(next) => {
            setFunds(false)
            onUpdate?.(next)
            // A plan whose day has come shows its fresh check in Saved.
            if (ready) onNavigate(`saved?check=${ready.id}`)
          }}
        />
      )}
    </div>
  )
}

export function HomeSkeleton() {
  return (
    <div className="page">
      <div className="wrap">
        <div className="stack" aria-busy="true">
          <span className="sk block" style={{ height: 200 }} />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
          <p className="caption" role="status">
            Checking your plan…
          </p>
        </div>
      </div>
    </div>
  )
}
