import { useEffect, useRef, useState } from 'react'
import { ArrowRight, CalendarClock, CircleAlert, Info, type LucideIcon } from 'lucide-react'
import { getUpcomingFlows } from '../shared/finance'
import type { Comparison, ScheduledFlow } from '../shared/types'
import type { AppState, Purchase } from './contract'
import { countedHold, ReservationNote } from './Reservation'
import { flowIcon, missingFix, purchasePlans } from './engine'
import { cx, dayLabel, daysFrom, displayName, money, shortDate, signed } from './format'
import { Button, Pill } from './ui'
import './hero.css'

/** Whole dollars when there are no cents: $1,450 but $324.75. */
export const compactMoney = (cents: number) => money(cents, cents % 100 !== 0)

export interface Upcoming {
  flow: ScheduledFlow
  date: string
}

/** The plan's flows over the next `days`, with the payments of Pay in 4 plans bought through Worth. */
export function upcomingWithPlans(state: AppState, days = 30): Upcoming[] {
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
      .filter(({ date }) => daysFrom(state.today, date) <= days),
  )
  return [...getUpcomingFlows(state.profile, state.today, days), ...bought].sort(
    (a, b) => a.date.localeCompare(b.date) || b.flow.amountCents - a.flow.amountCents,
  )
}

/** What the forecast takes out of the balance between today and its lowest point. */
export interface NeededParts {
  billsCents: number
  plansCents: number
  spendingCents: number
  /** Pay that lands before the low point and offsets the rest. */
  incomeCents: number
}

/**
 * The hero's split of the confirmed balance into free, needed and cushion. Free is the engine's
 * room (`spendLess.maxPriceCents`); needed is balance − cushion − free, never a figure of its own.
 */
export interface HeroSplit {
  balanceCents: number
  freeCents: number
  neededCents: number
  /** The part of the cushion still there at the plan's lowest point. */
  cushionCents: number
  /** The day of the plan's lowest point in the window. */
  lowDate?: string
  lowCents?: number
  /** The plan already dips below the cushion, before any purchase. */
  belowCushion: boolean
  /** How far below the cushion its lowest point goes. */
  shortCents: number
  /** By kind, only when the forecast's own events add up to its low point exactly. */
  parts?: NeededParts
}

export function heroSplit(balanceCents: number, room: Comparison): HeroSplit {
  const balance = Math.max(0, balanceCents)
  const points = room.buyToday.points
  let low = 0
  points.forEach((point, index) => {
    if (point.baselineMinimumCents < points[low]!.baselineMinimumCents) low = index
  })
  const lowCents = points.length ? points[low]!.baselineMinimumCents : undefined
  // What is still in the account at the lowest point. The cushion is drawn from that, so a plan
  // that dips into it (or below zero) shows everything above as needed, never as cushion.
  const kept = Math.min(Math.max(lowCents ?? balance, 0), balance)
  const cushion = Math.min(Math.max(0, room.cushionCents), kept)
  const free = Math.max(0, Math.min(room.spendLess.maxPriceCents, balance - cushion))
  const split: HeroSplit = {
    balanceCents: balance,
    freeCents: free,
    neededCents: balance - free - cushion,
    cushionCents: cushion,
    belowCushion: false,
    shortCents: 0,
  }
  if (lowCents === undefined) return split
  split.lowDate = points[low]!.date
  split.lowCents = lowCents
  split.belowCushion = lowCents < room.cushionCents
  split.shortCents = Math.max(0, room.cushionCents - lowCents)
  // A day's low is taken before its pay lands, so pay on the low day itself is not counted.
  const parts: NeededParts = { billsCents: 0, plansCents: 0, spendingCents: 0, incomeCents: 0 }
  points.slice(0, low + 1).forEach((point, index) => {
    for (const event of point.events) {
      if (event.kind === 'income') {
        if (index < low) parts.incomeCents += event.amountCents
      } else if (event.kind === 'spending') parts.spendingCents -= event.amountCents
      else if (event.kind === 'installment' || event.kind === 'purchase')
        parts.plansCents -= event.amountCents
      else parts.billsCents -= event.amountCents
    }
  })
  const net = parts.billsCents + parts.plansCents + parts.spendingCents - parts.incomeCents
  if (balanceCents - net === lowCents) split.parts = parts
  return split
}

export interface HoldChip {
  key: 'bill' | 'plan' | 'payday'
  icon: LucideIcon
  label: string
  amountCents: number
  date: string
}

/**
 * Up to three things that hold the money back: the largest bill up to the low point, the next
 * Pay in 4 (or other plan) payment, and the next payday.
 */
export function holdChips(upcoming: Upcoming[], lowDate?: string): HoldChip[] {
  const payday = upcoming.find(({ flow }) => flow.kind === 'income')
  const until = lowDate ?? payday?.date
  const bill = upcoming
    .filter(
      ({ flow, date }) =>
        (flow.kind === 'bill' || flow.kind === 'subscription') && (!until || date <= until),
    )
    .reduce<Upcoming | undefined>(
      (big, item) => (!big || item.flow.amountCents > big.flow.amountCents ? item : big),
      undefined,
    )
  const plan = upcoming.find(({ flow }) => flow.kind === 'installment')
  const chips: HoldChip[] = []
  if (bill)
    chips.push({
      key: 'bill',
      icon: flowIcon(bill.flow),
      label: displayName(bill.flow.name),
      amountCents: bill.flow.amountCents,
      date: bill.date,
    })
  if (plan) {
    // The plan's own name as written ("Laptop", "Northline Outfitters"), never lower-cased.
    const name =
      displayName(
        plan.flow.name
          .split('·')[0]!
          .replace(/\bpay\s+in\s+4\b/i, '')
          .trim(),
      ) || 'Instalment'
    const payIn4 = /\bpay\s+in\s+4\b/i.test(plan.flow.name)
    chips.push({
      key: 'plan',
      icon: CalendarClock,
      label: `${name} ${payIn4 ? 'Pay in 4' : 'plan'}`,
      amountCents: plan.flow.amountCents,
      date: plan.date,
    })
  }
  if (payday)
    chips.push({
      key: 'payday',
      icon: flowIcon(payday.flow),
      label: 'Payday',
      amountCents: payday.flow.amountCents,
      date: payday.date,
    })
  return chips
}

/** The big figure: whole dollars large, the cents small, the exact amount for screen readers. */
function Amount({ cents }: { cents: number }) {
  const rest = cents % 100
  return (
    <p className="hero-v num">
      <span aria-hidden="true">
        {money(cents - rest, false)}
        {rest > 0 && <small>.{String(rest).padStart(2, '0')}</small>}
      </span>
      <span className="sr">{money(cents)}</span>
    </p>
  )
}

function SplitBar({ split }: { split: HeroSplit }) {
  const { balanceCents: total, freeCents, neededCents, cushionCents } = split
  const segments = [
    {
      key: 'free',
      // The short line below already names the date when nothing is free.
      label: freeCents > 0 ? 'Free' : 'Nothing free',
      cents: freeCents,
    },
    {
      key: 'needed',
      label: split.lowDate
        ? `Needed through ${shortDate(split.lowDate)}`
        : 'Needed for what’s coming',
      cents: neededCents,
    },
    {
      key: 'cushion',
      label: split.belowCushion ? 'Cushion left' : 'Cushion',
      cents: cushionCents,
    },
  ]
  return (
    <div className="hero-split">
      <div className="hero-bar" aria-hidden="true">
        {segments.map(
          (segment) =>
            segment.cents > 0 && (
              <i key={segment.key} className={segment.key} style={{ flexGrow: segment.cents }} />
            ),
        )}
      </div>
      <div className="hero-legend">
        <ul aria-label={`Your ${money(total)}`}>
          {segments
            // "Nothing free" always shows; a needed or cushion part of $0 does not.
            .filter((segment) => segment.cents > 0 || segment.key === 'free')
            .map((segment) => (
              <li key={segment.key} className={segment.key}>
                {segment.cents > 0 && <i aria-hidden="true" />}
                <span>{segment.label}</span>
                {segment.cents > 0 && <b className="num">{compactMoney(segment.cents)}</b>}
              </li>
            ))}
          {split.shortCents > 0 && split.lowDate && (
            <li className="short">
              <CircleAlert size={16} aria-hidden="true" />
              <span>
                Short by <b className="num">{compactMoney(split.shortCents)}</b> on{' '}
                {shortDate(split.lowDate)}
              </span>
            </li>
          )}
        </ul>
        <p className="hero-of" title="The money available you confirmed">
          of <b className="num">{compactMoney(total)}</b> in your account
        </p>
      </div>
    </div>
  )
}

/** The cushion, the confirmed balance and the arithmetic, one click away instead of on the face. */
function HowWorkedOut({
  state,
  room,
  split,
  paydays,
}: {
  state: AppState
  room: Comparison
  split: HeroSplit
  paydays: string[]
}) {
  const { profile } = state
  const { parts, lowDate, lowCents } = split
  const rows = parts
    ? ([
        ['Bills and subscriptions', -parts.billsCents],
        ['Pay in 4 and other plans', -parts.plansCents],
        ['Everyday spending', -parts.spendingCents],
        ['Pay coming in', parts.incomeCents],
      ] as const)
    : []
  const sum = Boolean(lowDate) && rows.some(([, cents]) => cents !== 0)
  const ref = useRef<HTMLDetailsElement>(null)
  const [open, setOpen] = useState(false)
  // A popover, not a page section: Escape or a click outside closes it.
  useEffect(() => {
    const details = ref.current
    if (!open || !details) return
    const close = (focus: boolean) => {
      details.open = false
      setOpen(false)
      if (focus) details.querySelector('summary')?.focus()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close(true)
    }
    const onDown = (event: PointerEvent) => {
      if (details.contains(event.target as Node)) return
      const hadFocus = details.contains(document.activeElement)
      close(false)
      // Focus goes back to the summary only when it was inside and the click landed on nothing
      // focusable; a click on another control keeps its focus.
      if (hadFocus)
        setTimeout(() => {
          if (!document.activeElement || document.activeElement === document.body)
            details.querySelector('summary')?.focus()
        })
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open])
  return (
    <details
      className="hero-info"
      ref={ref}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-label="How Worth worked this out">
        <Info size={20} aria-hidden="true" />
      </summary>
      <div className="hero-pop">
        <p>
          {split.belowCushion && lowDate
            ? `Your plan already dips below your ${money(room.cushionCents)} cushion on ${dayLabel(lowDate)}.`
            : `Keeps your ${money(room.cushionCents)} cushion, if your plan holds.`}{' '}
          Based on {money(profile.balanceCents)} you confirmed{' '}
          {profile.snapshotDate === state.today ? 'today' : `on ${dayLabel(profile.snapshotDate)}`}.
        </p>
        {lowDate && lowCents !== undefined && (
          <p>
            Your lowest point is about {lowCents < 0 ? '−' : ''}
            {money(Math.abs(lowCents), false)} on {dayLabel(lowDate)}
            {/* A bill on payday leaves first, so a low is often the morning of payday itself. */}
            {paydays.includes(lowDate)
              ? ', the morning of payday'
              : paydays.some((date) => daysFrom(lowDate, date) === 1)
                ? ', the day before payday'
                : ''}
            .{sum && ' Until then:'}
          </p>
        )}
        {sum && lowDate && (
          <dl className="hero-sum" aria-label={`From today to ${dayLabel(lowDate)}`}>
            {rows
              .filter(([, cents]) => cents !== 0)
              .map(([label, cents]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd className="num">{signed(cents, true)}</dd>
                </div>
              ))}
          </dl>
        )}
      </div>
    </details>
  )
}

/**
 * Home's hero: how much is safe to spend today, and a picture of why it is less than the balance.
 * Before the plan is confirmed, or while a detail is missing, it says what to fix instead.
 */
export function Hero({
  state,
  room,
  loading,
  month = false,
  onAsk,
  onPlan,
  onNavigate,
  onOpenCheckout,
  onConfirmFunds,
  fundsElsewhere = false,
}: {
  state: AppState
  room?: Comparison
  loading: boolean
  /** Imported PayPal activity: the hero says where the plan came from. */
  month?: boolean
  onAsk: () => void
  onPlan: () => void
  onNavigate: (hash: string) => void
  onOpenCheckout: (purchase: Purchase) => void
  onConfirmFunds: () => void
  /** The saved plan's own card below asks for today's funds, so this tile doesn't repeat it. */
  fundsElsewhere?: boolean
}) {
  const hold = countedHold(state)
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
      <section className="hero" aria-busy="true" aria-label="Safe to spend today">
        <h2 className="hero-k">Safe to spend today</h2>
        <span className="sk hero-sk" />
      </section>
    )
  const split = heroSplit(state.profile.balanceCents, room)
  const upcoming = upcomingWithPlans(state)
  const paydays = upcoming.filter(({ flow }) => flow.kind === 'income').map(({ date }) => date)
  const chips = holdChips(upcoming, split.lowDate)
  return (
    <section className={cx('hero', split.freeCents === 0 && 'zero')} aria-labelledby="hero-k">
      <div className="hero-top">
        <h2 className="hero-k" id="hero-k">
          Safe to spend today
        </h2>
        {month && <span className="hero-tag">From your PayPal activity</span>}
        <HowWorkedOut state={state} room={room} split={split} paydays={paydays} />
      </div>
      <Amount cents={split.freeCents} />
      <SplitBar split={split} />
      {chips.length > 0 && (
        <ul className="hero-chips" aria-label="What holds the rest back">
          {chips.map(({ key, icon: Icon, label, amountCents, date }) => (
            <li key={key} className={key}>
              <span className="ic" aria-hidden="true">
                <Icon size={16} strokeWidth={2} />
              </span>
              <span>
                {label}{' '}
                <b className="num">
                  {key === 'payday' ? '+' : ''}
                  {compactMoney(amountCents)}
                </b>
                <span className="when"> · {shortDate(date)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {hold && <ReservationNote purchase={hold} onReview={onOpenCheckout} onBrand />}
      <a
        className="btn hero-cta"
        href="#ask"
        onClick={(event) => {
          event.preventDefault()
          onAsk()
        }}
      >
        Check a purchase <ArrowRight size={18} aria-hidden="true" />
      </a>
    </section>
  )
}
