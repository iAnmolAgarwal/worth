import { useState } from 'react'
import {
  ArrowRight,
  ArrowUp,
  CalendarCheck,
  CircleAlert,
  ReceiptText,
  RefreshCw,
} from 'lucide-react'
import { getUpcomingFlows } from '../shared/finance'
import type { Product } from '../shared/types'
import type { AppState, Purchase } from './contract'
import { isActive } from './contract'
import { allPlans, cadenceLabel, flowIcon, kindLabel, purchasePlans, useComparison } from './engine'
import { dayLabel, daysFrom, money, signed } from './format'
import { Button, Disc, Pill, SkeletonRow } from './ui'

export const HOME_SUGGESTIONS = [
  'What’s coming up?',
  'How much can I spend today?',
  'Can I afford a $1,199 camera?',
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
}: {
  state: AppState
  onAsk: () => void
  onPlan: () => void
}) {
  const { comparison: room, loading } = useComparison(
    { amountCents: 0, itemName: 'Room to spend' },
    state.profile.version,
  )
  const income = getUpcomingFlows(state.profile, state.today, 30).find(
    ({ flow }) => flow.kind === 'income',
  )
  if (!state.profile.confirmed || (room && room.recommendation === null))
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
  const soon = upcoming.filter(({ date }) => daysFrom(state.today, date) <= 14)
  const later = upcoming.filter(({ date }) => daysFrom(state.today, date) > 14)
  const biggest = soon
    .filter(({ flow }) => flow.kind === 'bill')
    .sort((a, b) => b.flow.amountCents - a.flow.amountCents)[0]
  const sameMonth = later.every(({ date }) => date.slice(0, 7) === state.today.slice(0, 7))
  const row = ({ flow, date }: (typeof upcoming)[number]) => {
    const plan =
      flow.kind === 'installment'
        ? plans.find((p) => p.planId === (flow.planId ?? flow.id))
        : undefined
    const index = plan ? plan.dates.indexOf(date) : -1
    const paymentNumber = plan?.total ? plan.total - plan.left + index + 1 : undefined
    const days = daysFrom(state.today, date)
    return (
      <div className="row" key={`${flow.id}-${date}`}>
        <Disc
          icon={flowIcon(flow)}
          kind={
            flow.kind === 'income' ? 'income' : flow.kind === 'installment' ? 'plan' : undefined
          }
        />
        <div className="body">
          <div className="t">{flow.name}</div>
          <div className="s">
            {dayLabel(date)}
            {biggest?.flow.id === flow.id && biggest.date === date && days > 1
              ? ` · in ${days} days`
              : ''}{' '}
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
          <div className="rows">{later.slice(0, 4).map(row)}</div>
        </>
      )}
    </section>
  )
}

export function SavedRows({
  products,
  onOpen,
}: {
  products: Product[]
  onOpen: (product: Product) => void
}) {
  return (
    <div className="rows">
      {products.map((product) => (
        <button
          type="button"
          className="row plain small"
          key={product.id}
          onClick={() => onOpen(product)}
        >
          <img className="thumb" src={product.image} alt="" />
          <div className="body">
            <div className="t">{product.name}</div>
            <div className="s">
              <span className="soft">{product.merchant}</span>
            </div>
          </div>
          <div className="amt num">{money(product.priceCents)}</div>
        </button>
      ))}
    </div>
  )
}

export function Home({
  state,
  onAsk,
  onNavigate,
  onOpenProduct,
  onEditPlan,
  onOpenCheckout,
  onConfirmPlan,
  onReviewRefund,
}: {
  state: AppState
  onAsk: (text?: string) => void
  onNavigate: (hash: string) => void
  onOpenProduct: (product: Product) => void
  onEditPlan: () => void
  onOpenCheckout: (purchase: Purchase) => void
  onConfirmPlan: (purchaseId: string) => void
  onReviewRefund: (purchaseId: string, refundId: string) => void
}) {
  const active = state.purchases.find(isActive)
  const saved = state.products.filter((product) => state.wishlist.includes(product.id))
  const income = state.profile.flows.find((flow) => flow.kind === 'income' && flow.active)
  const plans = allPlans(state)
  return (
    <div className="page">
      <div className="wrap">
        <h1 className="sr">Home</h1>
        <div className="grid">
          <div className="stack">
            <HeroTile state={state} onAsk={() => onAsk()} onPlan={onEditPlan} />
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
                <SavedRows products={saved.slice(0, 3)} onOpen={onOpenProduct} />
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
