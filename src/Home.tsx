import { useState } from 'react'
import {
  Bookmark,
  Bot,
  CalendarCheck,
  CalendarClock,
  ChevronRight,
  ReceiptText,
  RefreshCw,
} from 'lucide-react'
import { mainCollision, nearPhrase, planLabel } from '../shared/collision'
import { planCollisions } from '../shared/finance'
import type { Product, SavedItem } from '../shared/types'
import type { AppState, Purchase } from './contract'
import { isActive } from './contract'
import { ASSESSMENT_ONLY, MAY_FIT_NOW } from './copy'
import { FundsDialog } from './Saved'
import {
  allPlans,
  boughtProductIds,
  cadenceLabel,
  flowIcon,
  kindLabel,
  useComparison,
} from './engine'
import { dayLabel, daysFrom, money, signed, displayName } from './format'
import { Hero, upcomingWithPlans } from './Hero'
import { MonthBuilt, NextThirtyDays, PlanCards, PlanSummaryLine } from './Month'
import { Button, Disc, SkeletonRow } from './ui'

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
  const upcoming = upcomingWithPlans(state)
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
                      : product
                        ? (product.subtitle ?? product.category)
                        : ASSESSMENT_ONLY}
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

/** The rail's way in to Settings › Connect an agent: Worth as a tool an AI shopping agent calls. */
function AgentEntry({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="row plain small agent-entry" onClick={onOpen}>
      <Disc icon={Bot} kind="plan" />
      <div className="body">
        <div className="t">Connect an agent</div>
        <div className="s">
          <span className="soft">Let your AI agent ask Worth before it pays</span>
        </div>
      </div>
      <ChevronRight className="ico" aria-hidden="true" />
    </button>
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
  // Imported PayPal activity, confirmed: the month-led Home. The sample keeps its own layout.
  const month = state.profile.source === 'import' && state.profile.confirmed
  const { comparison: room, loading } = useComparison(
    { amountCents: 0, itemName: 'Room to spend' },
    state.profile.version,
  )
  const nextDays = <NextThirtyDays state={state} onShowAll={() => onNavigate('plan')} />
  return (
    <div className="page">
      <div className="wrap">
        <h1 className="sr">Home</h1>
        <div className="home-band">
          <Hero
            state={state}
            room={room}
            loading={loading}
            onAsk={() => onAsk()}
            onPlan={onEditPlan}
            onNavigate={onNavigate}
            onOpenCheckout={onOpenCheckout}
            onConfirmFunds={() => setFunds(true)}
            fundsElsewhere={Boolean(ready) && !fundsToday}
          />
        </div>
        <div className="grid">
          <div className="stack">
            {month && <PlanSummaryLine state={state} />}
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
            <CollisionInsight state={state} onShowPlan={() => onNavigate('plan')} />
            {month ? nextDays : <ComingUp state={state} onShowAll={() => onNavigate('plan')} />}
          </div>
          <aside
            className="rail"
            aria-label={
              month
                ? 'Your Pay in 4 plans, how your month was built and Saved'
                : 'Saved and your plan'
            }
          >
            {month && <PlanCards state={state} room={room} />}
            {month && <MonthBuilt state={state} onImport={onImport} onEditPlan={onEditPlan} />}
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
                <p className="meta">Nothing saved yet.</p>
              )}
            </section>
            <AgentEntry onOpen={() => onNavigate('settings')} />
            {!month && (
              <section aria-labelledby="plan-title">
                <div className="sec-head">
                  <h2 className="h-section" id="plan-title">
                    Your plan
                  </h2>
                </div>
                <dl className="kvlist">
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
            )}
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
