import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { ChevronRight, CircleAlert, CircleCheck, Info, RefreshCw } from 'lucide-react'
import { dateInTimezone, getUpcomingFlows } from '../shared/finance'
import type { Comparison, ScheduledFlow } from '../shared/types'
import { connectAvailable, ConnectPayPalButton, syncFromPayPal, useSyncing } from './ConnectPayPal'
import type { AppState, Purchase } from './contract'
import { isActive } from './contract'
import { countedHold, ReservationNote } from './Reservation'
import { missingFix, purchasePlans } from './engine'
import { cx, dayLabel, daysFrom, money, shortDate, signed } from './format'
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
          {/* The sample's balance was never confirmed by the visitor, so it says only when it holds. */}
          {profile.source === 'demo'
            ? `Based on ${money(profile.balanceCents)} available on ${dayLabel(profile.snapshotDate)}.`
            : `Based on ${money(profile.balanceCents)} you confirmed ${profile.snapshotDate === state.today ? 'today' : `on ${dayLabel(profile.snapshotDate)}`}.`}
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
 * The figure, the label and the bar as the card first draws them. Once per session, after the data
 * has loaded, the card opens on the whole balance in one bar ("In your account"), then the bar
 * divides while the figure counts down to what is safe. The label says "Safe to spend today" only
 * when the figure is that amount. Reduced motion, a later visit or a test: the end state at once.
 */
const ENTRANCE_KEY = 'worth.heroEntrance'
const HOLD_MS = 200
const RUN_MS = 650
type Phase = 'whole' | 'run' | 'done'

function firstEntrance() {
  try {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false
    if (sessionStorage.getItem(ENTRANCE_KEY)) return false
    sessionStorage.setItem(ENTRANCE_KEY, '1')
    return true
  } catch {
    return false
  }
}

function useEntrance(fromCents: number, toCents: number) {
  const [phase, setPhase] = useState<Phase>(() =>
    typeof matchMedia === 'function' &&
    typeof requestAnimationFrame === 'function' &&
    firstEntrance()
      ? 'whole'
      : 'done',
  )
  const [shown, setShown] = useState(phase === 'done' ? toCents : fromCents)
  useEffect(() => {
    if (phase === 'done') {
      setShown(toCents)
      return
    }
    let frame = 0
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start - HOLD_MS) / RUN_MS))
      if (t > 0) setPhase((current) => (current === 'whole' ? 'run' : current))
      const eased = 1 - Math.pow(1 - t, 3)
      setShown(Math.round(fromCents + (toCents - fromCents) * eased))
      if (t < 1) frame = requestAnimationFrame(tick)
      else setPhase('done')
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
    // Runs once, on the first render with data.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return { phase, shown: phase === 'done' ? toCents : shown }
}

/**
 * The big figure: whole dollars large, the cents small, the exact amount for screen readers. The
 * size follows the number of characters, so $1,000,000 fits the card as $872 does.
 */
function Amount({ cents, exact }: { cents: number; exact: number }) {
  const rest = cents % 100
  const whole = money(cents - rest, false)
  return (
    <p className="hero-v num" data-tour="safe" style={{ '--chars': whole.length } as CSSProperties}>
      <span aria-hidden="true">
        {whole}
        {rest > 0 && <small>.{String(rest).padStart(2, '0')}</small>}
      </span>
      <span className="sr">{money(exact)}</span>
    </p>
  )
}

/** The reference's status pill: bills covered through the low point, or how short the plan is. */
/** The plan's own definition of the cushion, from Plan › Edit your plan. */
const CUSHION_MEANS = 'the least you want to keep in your account'

function StatusPill({ split, paydays }: { split: HeroSplit; paydays: string[] }) {
  if (!split.lowDate) return null
  if (split.shortCents > 0)
    return (
      <p className="hero-pill short">
        <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
        <span>
          Short by <b className="num">{compactMoney(split.shortCents)}</b> on{' '}
          {shortDate(split.lowDate)}
        </span>
      </p>
    )
  return (
    <p className="hero-pill ok">
      <CircleCheck size={16} strokeWidth={2.25} aria-hidden="true" />
      <span>
        {paydays.includes(split.lowDate)
          ? `Bills covered until payday, ${shortDate(split.lowDate)}`
          : `Bills covered through ${shortDate(split.lowDate)}`}
      </span>
    </p>
  )
}

function SplitBar({ split, phase }: { split: HeroSplit; phase: Phase }) {
  const { balanceCents: total, freeCents, neededCents, cushionCents } = split
  const segments = [
    { key: 'free', label: freeCents > 0 ? 'Free' : 'Nothing free', cents: freeCents },
    {
      key: 'needed',
      label: split.lowDate ? `Needed by ${shortDate(split.lowDate)}` : 'Needed for what’s coming',
      cents: neededCents,
    },
    {
      key: 'cushion',
      label: split.belowCushion ? 'Cushion left' : 'Cushion',
      cents: cushionCents,
    },
  ]
  // The entrance's first beat: the whole balance as one bar.
  const whole = phase === 'whole'
  const drawn = segments.filter((segment) => segment.cents > 0)
  return (
    <div className="hero-split" data-tour="bar">
      <div className="hero-bar" aria-hidden="true">
        {drawn.map((segment, index) => (
          // A $0 part is not drawn; the others grow by their amounts, each keeping a sliver. On
          // the first beat the first part holds the whole bar, and the rest grow out of it.
          <i
            key={segment.key}
            className={segment.key}
            style={{ flexGrow: whole ? Number(index === 0) : segment.cents }}
          />
        ))}
      </div>
      <div className="hero-legend">
        <ul aria-label={`Your ${money(total)}`}>
          {segments
            // "Nothing free" always shows; a needed or cushion part of $0 does not.
            .filter((segment) => segment.cents > 0 || segment.key === 'free')
            .map((segment) => (
              <li
                key={segment.key}
                className={segment.key}
                title={
                  segment.key === 'cushion'
                    ? 'The least you want to keep in your account.'
                    : undefined
                }
              >
                {segment.cents > 0 && <i aria-hidden="true" />}
                <span>{segment.label}</span>
                {segment.key === 'cushion' && <span className="sr">, {CUSHION_MEANS}</span>}
                {segment.cents > 0 && <b className="num">{compactMoney(segment.cents)}</b>}
              </li>
            ))}
        </ul>
        <p className="hero-of">
          of <b className="num">{compactMoney(total)}</b> money available
        </p>
      </div>
    </div>
  )
}

/** Worth's W, as on the badge. */
function Mark() {
  return (
    <span className="hero-mark" aria-hidden="true">
      <svg viewBox="0 0 472 362">
        <path d={W_PATH} transform="translate(24 32)" fill="#5cc6ff" opacity=".9" />
        <path d={W_PATH} fill="#ffffff" />
      </svg>
    </span>
  )
}
const W_PATH =
  'M 2.136 9.729 Q 2 2 10 2 L 76 2 Q 84 2 83.777 9.812 L 77.733 221.071 Q 77.649 224 79.154 221.104 L 188.987 9.723 Q 193 2 201 2 L 247 2 Q 255 2 255.162 9.723 L 259.589 221.104 Q 259.649 224 261.026 221.071 L 360.328 9.812 Q 364 2 372 2 L 438 2 Q 446 2 442.01 9.729 L 282.208 319.304 Q 277.719 328 268.719 328 L 210.719 328 Q 201.719 328 201.234 319.393 L 191.001 137.869 Q 190.839 135 189.247 137.869 L 88.496 319.393 Q 83.719 328 74.719 328 L 16.719 328 Q 7.719 328 7.567 319.304 Z'

/** The old start strip's line for an open checkout, which blocks importing until it's resolved. */
const BUSY_LINE = 'Finish or cancel your active checkout before importing PayPal activity.'

/** Where the card's numbers come from: the sample, an imported file, or Connect PayPal. */
export type HeroSource = 'sample' | 'file' | 'paypal'

export function heroSource(state: AppState): HeroSource {
  if (state.profile.source !== 'import') return 'sample'
  // "PayPal connected" only while Worth can still read it; otherwise Connect PayPal is offered again.
  return state.profile.importedFrom === 'paypal' && state.config.paypalLinked ? 'paypal' : 'file'
}

/** "updated today", or the day of the import when it was earlier. */
export function updatedLabel(state: AppState) {
  const at = state.profile.importedAt
  if (!at) return undefined
  const day = dateInTimezone(at, state.profile.timezone)
  return day === state.today ? 'updated today' : `updated ${shortDate(day)}`
}

/**
 * The hero's actions: Check a purchase, and where the numbers come from with the ways to change it.
 * Placement is CSS on the hero's grid, so the rows can sit beside the card or under it.
 */
export function HeroActions({
  state,
  onAsk,
  onImport,
}: {
  state: AppState
  onAsk: () => void
  /** Opens the import step: choose a CSV, try the sample export, or enter bills yourself. */
  onImport: () => void
}) {
  const source = heroSource(state)
  const busy = state.purchases.some(isActive)
  const connect = connectAvailable(state)
  const syncing = useSyncing()
  const updated = updatedLabel(state)
  const Updated = updated && `${updated[0]!.toUpperCase()}${updated.slice(1)}`
  // While a checkout is open, imports wait; the row says why instead of greying out silently.
  const why = busy ? BUSY_LINE : undefined
  const importLink = (label: string) => (
    <button type="button" className="hero-src-alt" onClick={onImport} disabled={busy} title={why}>
      {label}
    </button>
  )
  return (
    <nav className="hero-actions" aria-label="Next steps">
      <button type="button" className="hero-act primary hero-cta" data-tour="check" onClick={onAsk}>
        <span className="hero-act-main">
          <span className="hero-act-t">Check a purchase</span>
          <span className="hero-act-s">See the day it fits</span>
        </span>
        <ChevronRight className="chev" size={20} aria-hidden="true" />
      </button>
      <div
        className={cx(
          'hero-act',
          'hero-src',
          source,
          (source === 'paypal' || !connect) && 'static',
        )}
        data-tour="connect"
      >
        {source === 'paypal' ? (
          <>
            <span className="hero-act-main">
              <span className="hero-act-t hero-src-pill">
                <i aria-hidden="true" />
                PayPal connected
              </span>
              <span className="hero-act-s">{why ?? Updated ?? 'From PayPal'}</span>
            </span>
            {connect && (
              <button
                type="button"
                className="hero-src-refresh"
                aria-label="Read your PayPal activity again"
                title={why ?? 'Read your PayPal activity again'}
                disabled={busy || syncing}
                aria-busy={syncing || undefined}
                onClick={() => void syncFromPayPal()}
              >
                <RefreshCw size={18} className={syncing ? 'spin' : undefined} aria-hidden="true" />
              </button>
            )}
          </>
        ) : connect ? (
          <>
            <ConnectPayPalButton
              pop
              disabled={busy}
              trigger={(props) => (
                <button type="button" className="hero-act-main" title={why} {...props}>
                  <span className="hero-act-t">Connect PayPal</span>
                  <span className="hero-act-s">
                    {why ??
                      (source === 'sample'
                        ? 'You’re viewing sample data'
                        : state.profile.importedFrom === 'paypal'
                          ? (Updated ?? 'From PayPal')
                          : 'From your imported file')}
                  </span>
                </button>
              )}
            />
            {importLink(source === 'sample' ? 'Import a file' : 'Import again')}
            <ChevronRight className="chev" size={20} aria-hidden="true" />
          </>
        ) : (
          <>
            <span className="hero-act-main">
              <span className="hero-act-t">
                {source === 'sample' ? 'Sample data' : 'Your PayPal activity'}
              </span>
              <span className="hero-act-s">
                {why ??
                  (source === 'sample'
                    ? 'Bring your own PayPal activity'
                    : (Updated ?? 'From a file'))}
              </span>
            </span>
            {importLink(source === 'sample' ? 'Import a file' : 'Import again')}
          </>
        )}
      </div>
    </nav>
  )
}

/**
 * Home's hero: a flat sky-blue card with how much is safe to spend today and a picture of why it is
 * less than the balance, and its actions beside it. Before the plan is confirmed, or while a detail
 * is missing, it says what to fix instead.
 */
export function Hero({
  state,
  room,
  loading,
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
  // One section in every state, so the region stays the same element when the numbers arrive.
  return (
    <section
      className="hero"
      aria-busy={loading || !room || undefined}
      aria-label="Safe to spend today"
    >
      {loading || !room ? (
        <div className="hero-card">
          <div className="hero-top">
            <Mark />
            <h2 className="hero-k">Safe to spend today</h2>
          </div>
          <span className="sk hero-sk" />
        </div>
      ) : (
        <HeroCard
          state={state}
          room={room}
          hold={hold}
          onAsk={onAsk}
          onImport={() => onNavigate('import')}
          onOpenCheckout={onOpenCheckout}
        />
      )}
    </section>
  )
}

function HeroCard({
  state,
  room,
  hold,
  onAsk,
  onImport,
  onOpenCheckout,
}: {
  state: AppState
  room: Comparison
  hold?: Purchase
  onAsk: () => void
  onImport: () => void
  onOpenCheckout: (purchase: Purchase) => void
}) {
  const split = heroSplit(state.profile.balanceCents, room)
  const paydays = upcomingWithPlans(state)
    .filter(({ flow }) => flow.kind === 'income')
    .map(({ date }) => date)
  const { phase, shown } = useEntrance(split.balanceCents, split.freeCents)
  const name = state.profile.source === 'demo' ? state.profile.name.trim() : ''
  return (
    <>
      <div className={cx('hero-card', `is-${phase}`, split.freeCents === 0 && 'zero')}>
        <div className="hero-top">
          <Mark />
          <div className="hero-id">
            <h2 className="hero-k">
              {phase === 'done' ? (
                'Safe to spend today'
              ) : (
                <>
                  {/* Never "Safe to spend" over a figure that is still counting. */}
                  <span aria-hidden="true">
                    {phase === 'whole' ? 'In your account' : 'Taking out what’s needed'}
                  </span>
                  <span className="sr">Safe to spend today</span>
                </>
              )}
            </h2>
            <p className="hero-sub">
              {name ? `${name} · ` : ''}
              {dayLabel(state.today)}
            </p>
          </div>
          <HowWorkedOut state={state} room={room} split={split} paydays={paydays} />
        </div>
        <Amount cents={shown} exact={split.freeCents} />
        <StatusPill split={split} paydays={paydays} />
        <SplitBar split={split} phase={phase} />
        {hold && <ReservationNote purchase={hold} onReview={onOpenCheckout} />}
      </div>
      <HeroActions state={state} onAsk={onAsk} onImport={onImport} />
    </>
  )
}
