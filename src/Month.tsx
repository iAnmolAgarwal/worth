// A's month-led Home for imported PayPal activity (P3a): the next 30 days grouped by week, the
// PayPal Pay in 4 plans in progress, and how the month was built, by origin.
import { CalendarClock, CircleCheck, FileUp, KeyRound, Wallet } from 'lucide-react'
import { addDays, getUpcomingFlows, planCollisions } from '../shared/finance'
import { dayPhrase, originCounts } from '../shared/onboarding'
import type { Comparison, ScheduledFlow } from '../shared/types'
import type { AppState } from './contract'
import {
  allPlans,
  cadenceLabel,
  flowIcon,
  kindLabel,
  purchasePlans,
  type RunningPlan,
} from './engine'
import { capitalize, dayLabel, daysFrom, displayName, money, shortDate, signed } from './format'
import { TimelineNote } from './Onboarding'
import { Disc } from './ui'

const ESTIMATE_NOTE =
  'Pay in 4 dates are Worth’s estimate from your PayPal activity, about every 2 weeks. PayPal sets the actual schedule.'

/**
 * Groups dated items by calendar week, Sunday to Saturday: "This week" first, then "Oct 11 – Oct 17"
 * (the grouping of PayPal's own Activity list).
 */
export function weekGroups<T extends { date: string }>(items: T[], today: string) {
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay()
  const thisWeekEnd = addDays(today, 6 - weekday)
  const groups: { label: string; items: T[] }[] = []
  for (const item of items) {
    const offset = Math.max(0, Math.ceil(daysFrom(thisWeekEnd, item.date) / 7))
    const end = addDays(thisWeekEnd, 7 * offset)
    const label = offset === 0 ? 'This week' : `${shortDate(addDays(end, -6))} – ${shortDate(end)}`
    const last = groups.at(-1)
    if (last?.label === label) last.items.push(item)
    else groups.push({ label, items: [item] })
  }
  return groups
}

/** The plan name without "· Pay in 4": the store. */
const merchantOf = (plan: Pick<RunningPlan, 'name'>) => plan.name.split('·')[0]!.trim()
/** The item, from a plan named "Larkspur Supply · Headphones · Pay in 4". */
const itemOf = (name: string) => {
  const parts = name.split('·').map((part) => part.trim())
  return parts.length === 3 ? parts[1] : undefined
}
/** A plan payment on the timeline reads by its item when the export named it: "Headphones · Pay in 4". */
const rowName = (flow: ScheduledFlow) => {
  const item = flow.kind === 'installment' ? itemOf(flow.name) : undefined
  return item ? `${item} · Pay in 4` : displayName(flow.name)
}

/** Timeline notes for plan payments that land next to a bill, keyed by plan and date. */
function collisionNotes(state: AppState) {
  const notes = new Map<string, string>()
  for (const { payment, bill } of planCollisions(state.profile, state.purchases, state.today)) {
    if (bill.kind !== 'bill') continue
    notes.set(
      `${payment.planId}|${payment.date}`,
      `${capitalize(dayPhrase(bill.daysFromInstalment, displayName(bill.name)))}.`,
    )
  }
  return notes
}

type Upcoming = { date: string; flow: ScheduledFlow }

/** "Next 30 days": Coming up for imported data, with Pay in 4 payments and their calm note. */
export function NextThirtyDays({ state, onShowAll }: { state: AppState; onShowAll: () => void }) {
  const plans = allPlans(state)
  const notes = collisionNotes(state)
  const bought: Upcoming[] = purchasePlans(state).flatMap((plan) =>
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
  // The next two weeks always show, so rent is never hidden; later items fill up to six rows.
  const soon = upcoming.filter(({ date }) => daysFrom(state.today, date) <= 14)
  const later = upcoming.filter(({ date }) => daysFrom(state.today, date) > 14)
  const shown = [...soon, ...later.slice(0, Math.max(0, 6 - soon.length))]
  const hidden = upcoming.slice(shown.length)
  const row = ({ flow, date }: Upcoming) => {
    const planId = flow.planId ?? flow.id
    const plan =
      flow.kind === 'installment' ? plans.find((item) => item.planId === planId) : undefined
    const index = plan ? plan.dates.indexOf(date) : -1
    const number = plan?.total ? plan.total - plan.left + index + 1 : undefined
    const origin =
      flow.origin === 'paypal' ? 'from PayPal' : flow.origin === 'you' ? 'you added' : undefined
    const note = plan ? notes.get(`${planId}|${date}`) : undefined
    const parts =
      flow.kind === 'installment'
        ? [`about ${dayLabel(date)}`, number ? `Payment ${number} of ${plan!.total}` : 'Payment']
        : [
            dayLabel(date),
            flow.kind === 'income' ? 'Payday' : kindLabel(flow.kind),
            cadenceLabel({ cadence: flow.cadence, nextDate: date })
              .replace(/^E/, 'e')
              .replace(/^M/, 'm'),
          ]
    return (
      <div className="row" key={`${flow.id}-${date}`}>
        <Disc
          icon={flowIcon(flow)}
          kind={
            flow.kind === 'income' ? 'income' : flow.kind === 'installment' ? 'plan' : undefined
          }
        />
        <div className="body">
          <div className="t">{rowName(flow)}</div>
          <div className="s">
            {parts[0]}{' '}
            <span className="soft">
              · {[...parts.slice(1), origin].filter(Boolean).join(' · ')}
            </span>
          </div>
          {note && <TimelineNote>{note}</TimelineNote>}
        </div>
        <div className={`amt num${flow.kind === 'income' ? ' pos' : ''}`}>
          {flow.kind === 'income' ? signed(flow.amountCents, true) : signed(-flow.amountCents)}
        </div>
      </div>
    )
  }
  return (
    <section aria-labelledby="next30-title">
      <div className="sec-head">
        <h2 className="h-section" id="next30-title">
          Next 30 days
        </h2>
        <button type="button" className="link" onClick={onShowAll}>
          Show all
        </button>
      </div>
      {!upcoming.length && (
        <p className="meta">Nothing scheduled in the next 30 days. Add your bills in your plan.</p>
      )}
      {weekGroups(shown, state.today).map((group, index) => (
        <div key={group.label}>
          <h3 className="group-label" style={index ? { marginTop: 'var(--s-4)' } : undefined}>
            {group.label}
          </h3>
          <div className="rows">{group.items.map(row)}</div>
        </div>
      ))}
      {hidden.length > 0 && (
        <button type="button" className="link" onClick={onShowAll} style={{ marginTop: 8 }}>
          And {hidden.length} more through {shortDate(hidden.at(-1)!.date)}
        </button>
      )}
    </section>
  )
}

/** "PayPal Pay in 4: 2 in progress · next about Oct 17": under the hero on a phone. */
export function PlanSummaryLine({ state }: { state: AppState }) {
  const plans = allPlans(state)
  if (!plans.length) return null
  const next = plans.map((plan) => plan.next).sort()[0]!
  return (
    <p className="plan-line show-m">
      <CalendarClock className="ico" aria-hidden="true" />
      <span>
        <b>PayPal Pay in 4:</b> {plans.length} in progress · next about {shortDate(next)}
      </span>
    </p>
  )
}

/** The rail's plan cards, shaped like PayPal's own list of active plans. */
export function PlanCards({ state, room }: { state: AppState; room?: Comparison }) {
  const plans = allPlans(state)
  const notes = new Map<string, string>()
  for (const { payment, bill } of planCollisions(state.profile, state.purchases, state.today)) {
    if (bill.kind !== 'bill' || notes.has(payment.planId)) continue
    const plan = plans.find((item) => item.planId === payment.planId)
    const index = plan ? plan.dates.indexOf(payment.date) : -1
    const number = plan?.total ? plan.total - plan.left + index + 1 : undefined
    notes.set(
      payment.planId,
      `${number ? `Payment ${number} of ${plan!.total}: ` : ''}${money(payment.amountCents)} on ${dayLabel(payment.date)}, ${dayPhrase(bill.daysFromInstalment, displayName(bill.name))}.`,
    )
  }
  return (
    <section aria-labelledby="plans-title">
      <div className="sec-head">
        <h2 className="h-section" id="plans-title">
          PayPal Pay in 4 plans in progress ({plans.length})
        </h2>
      </div>
      {plans.length === 0 && (
        <p className="meta">None running. Pay in 4 plans in your PayPal activity show up here.</p>
      )}
      {plans.map((plan) => {
        const paid = plan.total ? plan.total - plan.left : undefined
        const merchant = merchantOf(plan)
        const item = itemOf(plan.name)
        const total = state.profile.flows.find(
          (flow) => (flow.planId ?? flow.id) === plan.planId && flow.planTotalCents,
        )?.planTotalCents
        return (
          <article className="pcard" key={plan.planId} aria-label={`${merchant} Pay in 4 plan`}>
            <div className="top">
              <span className="mono" aria-hidden="true">
                {merchant.slice(0, 1).toUpperCase()}
              </span>
              <div className="who">
                <div className="merchant">{displayName(merchant)}</div>
                <div className="sub">
                  {item || total
                    ? [item, total && money(total)].filter(Boolean).join(' · ')
                    : `${plan.left} ${plan.left === 1 ? 'payment' : 'payments'} left`}
                </div>
              </div>
              <div className="each">
                <div className="merchant num">{money(plan.amountCents)}</div>
                <div className="sub">each</div>
              </div>
            </div>
            {paid !== undefined && (
              <div className="bar" role="img" aria-label={`${paid} of ${plan.total} paid`}>
                <i style={{ width: `${(paid / plan.total!) * 100}%` }} />
              </div>
            )}
            <div className="foot">
              {paid !== undefined && (
                <span>
                  <b>
                    {paid} of {plan.total} paid
                  </b>
                </span>
              )}
              <span>
                {plan.left === 1 ? 'Last' : 'Next'} payment about <b>{dayLabel(plan.next)}</b>
              </span>
            </div>
            {notes.has(plan.planId) && <TimelineNote>{notes.get(plan.planId)!}</TimelineNote>}
          </article>
        )
      })}
      {plans.length > 0 && room && room.recommendation !== null && (
        <p className={room.buyToday.outcome === 'fits' ? 'fits' : 'fits calm'}>
          {room.buyToday.outcome === 'fits' ? (
            <CircleCheck className="ico" aria-hidden="true" />
          ) : (
            <CalendarClock className="ico" aria-hidden="true" />
          )}
          <span>
            {room.buyToday.outcome === 'fits'
              ? `With what you’ve confirmed, ${plans.length === 1 ? 'this plan fits' : `these ${plans.length} plans fit`} your month: your lowest point stays above your ${money(room.cushionCents)} cushion.`
              : `With what you’ve confirmed, your month dips below your ${money(room.cushionCents)} cushion on ${dayLabel(room.buyToday.lowestDate)}, with these payments counted.`}
          </span>
        </p>
      )}
      {plans.length > 0 && <p className="caption">{ESTIMATE_NOTE}</p>}
    </section>
  )
}

/** "How your month was built": what came from PayPal, what the user added, what they entered. */
export function MonthBuilt({
  state,
  onImport,
  onEditPlan,
}: {
  state: AppState
  onImport?: () => void
  onEditPlan: () => void
}) {
  const { profile } = state
  const counts = originCounts(profile.flows)
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const found = [
    counts.paydays && count(counts.paydays, 'payday', 'paydays'),
    counts.bills && count(counts.bills, 'bill or subscription', 'bills and subscriptions'),
    counts.plans && count(counts.plans, 'Pay in 4 plan', 'Pay in 4 plans'),
  ].filter(Boolean)
  const added = [...new Set(counts.added.map((flow) => displayName(flow.name)))]
  const row = (Icon: typeof FileUp, you: boolean, title: string, text: string) => (
    <div className="row plain">
      <span className={`disc sm${you ? ' you' : ' plan'}`} aria-hidden="true">
        <Icon className="ico" strokeWidth={2} />
      </span>
      <div className="body">
        <div className="t">{title}</div>
        <div className="s">
          <span className="soft">{text}</span>
        </div>
      </div>
    </div>
  )
  return (
    <section aria-labelledby="built-title">
      <div className="sec-head">
        <h2 className="h-section" id="built-title">
          How your month was built
        </h2>
      </div>
      <div className="prov">
        {row(
          FileUp,
          false,
          'From your PayPal activity',
          `${found.length ? `${found.join(', ')}, and e` : 'E'}veryday spending of about ${money(profile.dailySpendCents)} a day, from ${profile.coverageDays} days of activity.`,
        )}
        {row(
          KeyRound,
          true,
          'You added',
          added.length
            ? `${added.slice(0, 3).join(', ')}${added.length > 3 ? ` and ${added.length - 3} more` : ''}, paid outside PayPal`
            : 'Nothing yet. Add any bill you pay outside PayPal in your plan.',
        )}
        {row(
          Wallet,
          true,
          'You entered',
          `Money available ${profile.snapshotDate === state.today ? 'today' : `on ${dayLabel(profile.snapshotDate)}`}: ${money(profile.balanceCents)} · cushion ${money(profile.cushionCents)}`,
        )}
      </div>
      <p className="actions" style={{ marginTop: 'var(--s-3)' }}>
        {onImport && (
          <button type="button" className="link" onClick={onImport}>
            Import newer activity
          </button>
        )}
        <button type="button" className="link" onClick={onEditPlan}>
          Edit your plan
        </button>
      </p>
    </section>
  )
}
