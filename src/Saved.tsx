import { useEffect, useMemo, useState } from 'react'
import {
  Bookmark,
  BookmarkCheck,
  Bot,
  CalendarCheck,
  CalendarClock,
  CircleAlert,
  Clock,
  Compass,
  CreditCard,
  ExternalLink,
  Eye,
  FileUp,
  Globe,
  Info,
  ShoppingBag,
  Sparkles,
  Store,
  Trash2,
  Unplug,
  Wallet,
} from 'lucide-react'
import { addDays, WAIT_SEARCH_DAYS } from '../shared/finance'
import { DEMO_PRESET_DAYS } from '../shared/seed'
import type { Product, SavedItem, SavedPriceCheck } from '../shared/types'
import { api, ApiError } from './api'
import { usePriceDrop } from './Alternatives'
import { ClaudeSwitch, JudgeBadge } from './Ask'
import { ConnectAgent } from './ConnectAgent'
import {
  ASSESSMENT_ONLY,
  CHANNEL3_LINK_DATA,
  CHANNEL3_SHARED_DATA,
  CLAUDE_SHARED_DATA,
  claudeUses,
  MAY_FIT_NOW,
  paypalModeLine,
  pinnedSample,
  replayToast,
  SAMPLE_WHO,
} from './copy'
import { SettingsAction, SettingsGroup, SettingsMore, SettingsRow } from './SettingsList'
import { startTour } from './Tour'
import type { DecisionRequest } from './Decision'
import { claudeOn, fits, fitStatus, lowestSentence, useComparison } from './engine'
import type { AppState, Purchase } from './contract'
import { isActive, savedSource, saveRequest } from './contract'
import { dayLabel, fromMoney, fullDate, money, sampleDate, shortDate } from './format'
import { Alert, Button, DateStepper, Dialog, Disc, Field, Pill, Toggle } from './ui'

/** The browser's old per-device wait dates, from before plans moved to the server (G5-6). */
const PLANNED_KEY = 'worth:planned'
/**
 * Reads the old wait dates once, sends them to the server, then clears them. A malformed value is
 * cleared without sending; a failed request leaves it for the next load.
 */
export async function migratePlanned(onUpdate: (state: AppState) => void) {
  let raw: string | null
  try {
    raw = localStorage.getItem(PLANNED_KEY)
  } catch {
    return
  }
  if (raw === null) return
  let planned: unknown
  try {
    planned = JSON.parse(raw)
  } catch {
    planned = undefined
  }
  const clear = () => {
    try {
      localStorage.removeItem(PLANNED_KEY)
    } catch {
      /* Storage can be unavailable; the server already holds the plan. */
    }
  }
  if (!planned || typeof planned !== 'object' || Array.isArray(planned)) return clear()
  try {
    const result = await api<{ state: AppState }>('/saved/migrate', { planned })
    onUpdate(result.state)
    clear()
  } catch (failure) {
    // A rejected payload will never succeed; a network failure may on the next load.
    if (failure instanceof ApiError && failure.status === 400) clear()
  }
}

/** A saved item's comparison, at its saved price or at a price just re-checked. */
const decisionFor = (item: SavedItem, amountCents = item.amountCents): DecisionRequest =>
  item.kind === 'catalog'
    ? { productId: item.productId }
    : { amountCents, itemName: item.name.slice(0, 150), ...savedSource(item) }

/** Who set a store item's saved price, in the card's words (C6). */
const priceNote = (item: SavedItem) =>
  item.priceSource === 'component'
    ? `price from ${storeName(item)}`
    : item.priceSource === 'channel3'
      ? 'price read by Channel3, confirmed by you'
      : 'price you confirmed'

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** A catalog item's second line: what it is, never the demo store's name (owner decision). */
const productLine = (product: Product) => product.subtitle ?? product.category

/** The store's name for "Back to <store>": its own name, or the link's domain. */
const storeName = (item: SavedItem) =>
  item.merchantName ?? new URL(item.sourceUrl!).hostname.replace(/^www\./, '')

/**
 * The ready day's price re-check (C6), for an item whose price Channel3 read. It asks once each
 * time the Saved screen shows the ready plan, never on a timer; a failure keeps the saved price.
 */
function usePriceRecheck(item: SavedItem) {
  const { id, status, priceSource, sourceUrl } = item
  const due = status === 'ready' && priceSource === 'channel3' && Boolean(sourceUrl)
  const [check, setCheck] = useState<SavedPriceCheck>()
  useEffect(() => {
    if (!due) return
    let cancelled = false
    api<SavedPriceCheck>(`/saved/${id}/recheck`, {})
      .catch((): SavedPriceCheck => ({ status: 'unavailable', savedPriceCents: item.amountCents }))
      .then((result) => !cancelled && setCheck(result))
    return () => {
      cancelled = true
    }
    // Asked again only for another item, or the same item saved at another price.
  }, [due, id, item.amountCents])
  return { due, check, checking: due && !check }
}

/** "Back to <store>": a plain link to the store page the item came from, with nothing added. */
function BackToStore({ item, primary }: { item: SavedItem; primary?: boolean }) {
  return (
    <a
      className={`btn ${primary ? 'btn-primary' : 'btn-secondary'}`}
      href={item.sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
    >
      Back to {storeName(item)}
      <ExternalLink className="ico" aria-hidden="true" />
      <span className="sr"> (opens in a new tab)</span>
    </a>
  )
}

/** A saved item's picture: the store photo, or a plain disc for an assessment-only item. */
function Picture({
  item,
  product,
  large,
}: {
  item: SavedItem
  product?: Product
  large?: boolean
}) {
  if (product)
    return large ? (
      <img className="hide-m" src={product.image} alt={product.name} />
    ) : (
      <img className="thumb" src={product.image} alt="" />
    )
  return large ? (
    <span className="ph hide-m" aria-hidden="true">
      <ShoppingBag className="ico" strokeWidth={1.75} />
    </span>
  ) : (
    <Disc icon={item.sourceUrl ? Store : item.retailer ? ShoppingBag : Bookmark} kind="plan" />
  )
}

function statusPill(item: SavedItem, fit?: ReturnType<typeof fitStatus>) {
  if (fit) return <Pill tone={fit.tone}>{fit.text}</Pill>
  if (item.status === 'ready') return <Pill tone="ok">May fit now</Pill>
  if (item.waitDate) return <Pill tone="sug">Planned for {shortDate(item.waitDate)}</Pill>
  return null
}

function SavedCard({
  item,
  product,
  fit,
  onOpen,
  onRemove,
}: {
  item: SavedItem
  product?: Product
  /** Whether it fits on the plan today, as the card's main status. */
  fit?: ReturnType<typeof fitStatus>
  onOpen: () => void
  onRemove: () => void
}) {
  const dropped = usePriceDrop(item)
  return (
    <article className="saved-card" style={{ position: 'relative' }}>
      <Picture item={item} product={product} large />
      <div className="row plain show-m" style={{ padding: 0 }}>
        <Picture item={item} product={product} />
        <div className="body">
          <div className="t" style={{ fontSize: 'var(--fs-body)' }}>
            {item.name}
          </div>
          <div className="s soft">
            {(product && productLine(product)) ??
              (item.sourceUrl
                ? item.priceSource === 'component'
                  ? sentence(priceNote(item))
                  : `${storeName(item)} · ${priceNote(item)}`
                : item.retailer
                  ? `${item.retailer} · ${ASSESSMENT_ONLY}`
                  : ASSESSMENT_ONLY)}
          </div>
        </div>
        <div className="amt num" style={{ fontSize: 'var(--fs-body)' }}>
          {money(item.amountCents)}
        </div>
      </div>
      <div className="hide-m">
        <div className="t">{item.name}</div>
        <div className="meta">
          {(product && productLine(product)) ??
            (item.sourceUrl ? storeName(item) : (item.retailer ?? ASSESSMENT_ONLY))}
        </div>
        <div className="num strong" style={{ fontWeight: 700, marginTop: 4 }}>
          {money(item.amountCents)}
        </div>
      </div>
      {/* A typed item reads like a listed one: name, one line, price, then whether it fits. */}
      {item.kind === 'custom' && item.sourceUrl && (
        <p className="caption hide-m">{sentence(priceNote(item))}</p>
      )}
      {item.status === 'bought' && <span className="corner-pill">Bought</span>}
      {item.status !== 'bought' && statusPill(item, fit) && <div>{statusPill(item, fit)}</div>}
      {item.status !== 'bought' && dropped !== undefined && (
        <div>
          <Pill tone="ok">Price dropped to {money(dropped)}</Pill>
        </div>
      )}
      <div className="foot">
        <button
          type="button"
          className="link"
          onClick={onOpen}
          aria-label={`${item.status === 'bought' ? 'View' : 'Check'} ${item.name}`}
        >
          {item.status === 'bought' ? 'View' : 'Check'}
        </button>
        <button
          type="button"
          className="icon-btn quiet"
          aria-pressed="true"
          aria-label={`Remove ${item.name} from Saved`}
          onClick={onRemove}
        >
          <BookmarkCheck className="ico" aria-hidden="true" />
        </button>
      </div>
    </article>
  )
}

/**
 * Confirming today's funds (C-17): the money available now, the one-time payments since the last
 * snapshot, and the Worth purchases already in that amount. Nothing is bought here.
 */
export function FundsDialog({
  state,
  onClose,
  onConfirmed,
}: {
  state: AppState
  onClose: () => void
  onConfirmed: (state: AppState) => void
}) {
  const { profile, fundsProjection } = state
  const sample = profile.source === 'demo'
  const stale = profile.snapshotDate < state.today
  const [amount, setAmount] = useState(() =>
    fundsProjection
      ? (fundsProjection.cents / 100).toFixed(2)
      : stale && !sample
        ? ''
        : (profile.balanceCents / 100).toFixed(2),
  )
  const due = profile.flows.filter(
    (flow) =>
      flow.active &&
      flow.cadence === 'once' &&
      flow.nextDate < state.today &&
      flow.paidOn !== flow.nextDate,
  )
  const unreflected = state.purchases.filter(
    (p) => p.status === 'completed' && !p.archived && !profile.reflectedPurchaseIds.includes(p.id),
  )
  // Only the sample's own projection already counts these payments, so only it starts them ticked.
  // On any other plan each one stays unticked until the user says it has happened.
  const projected = Boolean(fundsProjection) && profile.userEdited === false
  const [paid, setPaid] = useState<string[]>(projected ? due.map((flow) => flow.id) : [])
  const [included, setIncluded] = useState<string[]>(projected ? unreflected.map((p) => p.id) : [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((item) => item !== id) : [...list, id]
  async function confirm() {
    const cents = fromMoney(amount)
    if (!amount.trim() || !Number.isSafeInteger(cents) || cents < 0)
      return setError('Enter the money available to you today, like 1,250.00.')
    setBusy(true)
    setError('')
    try {
      const next = (await api<AppState>('/funds/confirm', {
        balanceCents: cents,
        paidFlowIds: paid,
        reflectedPurchaseIds: included,
      })) as AppState
      onConfirmed(next)
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      title="Confirm today’s funds"
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button block loading={busy} onClick={() => void confirm()}>
            Confirm and check again
          </Button>
          <Button variant="text" onClick={onClose} disabled={busy}>
            Not now
          </Button>
        </>
      }
    >
      <form
        className="stack tight"
        onSubmit={(event) => {
          event.preventDefault()
          void confirm()
        }}
      >
        <p className="meta">
          Worth checks a saved plan against today’s money before anything is bought. Nothing is
          charged here.
        </p>
        <Field
          label="Money available today"
          error={error}
          hint={
            fundsProjection
              ? `${profile.name}’s sample plan projects this for the start of ${dayLabel(state.today)}, from the funds confirmed ${dayLabel(fundsProjection.from)}. Sample data only.`
              : `Last confirmed ${money(profile.balanceCents)} on ${dayLabel(profile.snapshotDate)}.${stale ? ' Enter what your accounts show now.' : ''}`
          }
        >
          <span className="money-input">
            <span aria-hidden="true">$</span>
            <input
              className="input num"
              inputMode="decimal"
              value={amount}
              aria-invalid={Boolean(error)}
              onChange={(event) => setAmount(event.target.value)}
            />
          </span>
        </Field>
        {(due.length > 0 || unreflected.length > 0) && (
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="meta strong" style={{ fontWeight: 700, marginBottom: 4 }}>
              Already in this amount
            </legend>
            <p className="caption" style={{ margin: '0 0 4px' }}>
              {projected
                ? `Ticked because ${profile.name}’s sample projection already counts them. Sample data only.`
                : 'Tick each one your accounts already show.'}
            </p>
            {due.map((flow) => (
              <label className="check" key={flow.id}>
                <input
                  type="checkbox"
                  checked={paid.includes(flow.id)}
                  onChange={() => setPaid(toggle(paid, flow.id))}
                />
                <span>
                  {flow.name}, {money(flow.amountCents)} on {dayLabel(flow.nextDate)}: paid
                </span>
              </label>
            ))}
            {unreflected.map((purchase) => (
              <label className="check" key={purchase.id}>
                <input
                  type="checkbox"
                  checked={included.includes(purchase.id)}
                  onChange={() => setIncluded(toggle(included, purchase.id))}
                />
                <span>
                  {purchase.name}, {money(purchase.amountCents)}: bought through Worth
                </span>
              </label>
            ))}
          </fieldset>
        )}
      </form>
    </Dialog>
  )
}

/**
 * A wait plan whose day has come: confirm today's funds, see the fresh check, then (catalog items
 * only, behind checkoutGuards) buy with PayPal (G5-4). An item from
 * another store's page links back to that store instead (C6); a price Channel3 read is read again
 * first, and the fresh check uses the price now.
 */
function ReadyPlan({
  item,
  product,
  state,
  onConfirm,
  onUpdate,
  onToast,
  onOpenCheckout,
  onOpen,
}: {
  item: SavedItem
  product?: Product
  state: AppState
  onConfirm: () => void
  onUpdate: (state: AppState) => void
  onToast: (text: string) => void
  onOpenCheckout: (purchase: Purchase) => void
  /** Opens the item's options, at the price now when it was just re-checked. */
  onOpen: (amountCents?: number) => void
}) {
  const fundsToday = state.profile.confirmed && state.profile.snapshotDate === state.today
  // Today's funds, once confirmed, hold for every plan whose day has come.
  const fresh = fundsToday
  const recheck = usePriceRecheck(item)
  const priceCents =
    recheck.check?.status === 'changed' ? recheck.check.priceCents! : item.amountCents
  const { comparison: c, loading } = useComparison(
    fresh && !recheck.checking ? decisionFor(item, priceCents) : null,
    state.profile.version,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = state.purchases.find(isActive)
  async function buy() {
    setBusy(true)
    setError('')
    try {
      const result = await api<{ purchase: Purchase; state: AppState }>(
        `/saved/${item.id}/prepare`,
        {},
      )
      onUpdate(result.state)
      onOpenCheckout(result.purchase)
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function moveDate(date: string) {
    try {
      const result = await api<{ state: AppState }>(
        '/saved',
        saveRequest(
          item.kind === 'catalog'
            ? { kind: 'catalog', productId: item.productId! }
            : {
                kind: 'custom',
                name: item.name,
                amountCents: item.amountCents,
                // The store page stays with the plan; the price stays the one the shopper confirmed.
                ...(item.sourceUrl
                  ? {
                      sourceUrl: item.sourceUrl,
                      merchantName: item.merchantName,
                      priceSource: item.priceSource,
                    }
                  : {}),
              },
          { waitDate: date },
        ),
      )
      onUpdate(result.state)
      onToast(`Saved for ${dayLabel(date)}. Check it again then.`)
    } catch (failure) {
      setError((failure as Error).message)
    }
  }
  const fitsNow = c ? fits(c.buyToday) : false
  return (
    <section className="tile notice" aria-label={`${item.name}: your saved plan`}>
      <div className="row plain">
        <Disc icon={CalendarCheck} kind="plan" />
        <div className="body">
          <div className="t">
            {fresh && c
              ? fitsNow
                ? 'Fresh check: this fits today'
                : 'Fresh check: not yet'
              : MAY_FIT_NOW}
          </div>
          <div className="s">
            <span className="soft">
              {item.name} · {money(priceCents)} · planned for {dayLabel(item.waitDate!)}
              {item.sourceUrl ? ` · ${storeName(item)}` : ''}
            </span>
          </div>
          {recheck.checking && <p className="caption">Checking the price at {storeName(item)}…</p>}
          {recheck.check?.status === 'changed' && (
            <p className="meta strong" style={{ marginTop: 4 }}>
              Price now {money(recheck.check.priceCents!)} (was{' '}
              {money(recheck.check.savedPriceCents)})
            </p>
          )}
          {recheck.check?.status === 'same' && (
            <p className="caption">
              Price checked just now: still {money(item.amountCents)} at {storeName(item)}.
            </p>
          )}
          {recheck.check?.status === 'unavailable' && (
            <p className="caption">
              Couldn’t re-check the price. Showing the {money(item.amountCents)} you confirmed.
            </p>
          )}
          {fresh && loading && <p className="caption">Checking your plan for today…</p>}
          {fresh && c && (
            <p className="meta" style={{ marginTop: 4 }} role="status">
              {fitsNow
                ? `Checked just now: buying today keeps your ${money(c.cushionCents)} cushion. ${lowestSentence(c.buyToday.lowestBalanceCents, c.buyToday.lowestDate)}.`
                : c.wait.date
                  ? `Checked just now: not yet. Your plan now suggests ${dayLabel(c.wait.date)}.`
                  : `Checked just now: it doesn’t fit in the next ${WAIT_SEARCH_DAYS} days.`}
            </p>
          )}
          {fresh && c && fitsNow && item.kind === 'custom' && !item.sourceUrl && (
            <p className="caption">{ASSESSMENT_ONLY}.</p>
          )}
          {error && (
            <p className="co-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
      <div className="actions">
        {!fresh ? (
          <Button onClick={onConfirm}>Confirm today’s funds</Button>
        ) : c && fitsNow && item.sourceUrl ? null : c && fitsNow && product ? (
          active ? (
            <Button variant="secondary" onClick={() => onOpenCheckout(active)}>
              {active.productId === item.productId
                ? 'Finish checkout'
                : 'Finish your open checkout first'}
            </Button>
          ) : (
            <Button loading={busy} onClick={() => void buy()}>
              Buy with PayPal
            </Button>
          )
        ) : c && !fitsNow && c.wait.date ? (
          <Button variant="secondary" onClick={() => void moveDate(c.wait.date!)}>
            Save for {dayLabel(c.wait.date)}
          </Button>
        ) : c ? (
          <Button variant="secondary" onClick={() => onOpen(priceCents)}>
            See your options
          </Button>
        ) : null}
        {/* Another store's item is bought on its own page, never through Worth (C6). */}
        {item.sourceUrl && <BackToStore item={item} primary={fresh && Boolean(c) && fitsNow} />}
      </div>
    </section>
  )
}

export function Saved({
  state,
  checkId,
  onOpenDecision,
  onUpdate,
  onToast,
  onOpenCheckout,
}: {
  state: AppState
  /** A saved item to confirm funds for on arrival, e.g. from Home's ready-plan prompt. */
  checkId?: string
  onOpenDecision: (request: DecisionRequest) => void
  onUpdate: (state: AppState) => void
  onToast: (text: string) => void
  onOpenCheckout: (purchase: Purchase) => void
}) {
  const saved = state.saved ?? []
  const productOf = (item: SavedItem) =>
    item.kind === 'catalog' ? state.products.find((p) => p.id === item.productId) : undefined
  const ready = saved.filter((item) => item.status === 'ready')
  // One engine run per saved amount, again only when the plan or Saved changes.
  const fits = useMemo(
    () =>
      new Map(
        (state.saved ?? [])
          .filter((item) => item.status !== 'bought')
          .map(
            (item) =>
              [
                item.id,
                fitStatus(state, item.amountCents, {
                  productId: item.kind === 'catalog' ? item.productId : undefined,
                  itemName: item.name,
                }),
              ] as const,
          ),
      ),
    [state],
  )
  const fundsToday = state.profile.confirmed && state.profile.snapshotDate === state.today
  const asked = checkId && ready.some((item) => item.id === checkId) ? checkId : undefined
  // Arriving for a plan: confirm today's funds first, unless they were just confirmed today.
  const [confirming, setConfirming] = useState<string | undefined>(() =>
    fundsToday ? undefined : asked,
  )
  async function remove(item: SavedItem) {
    try {
      onUpdate((await api<AppState>(`/saved/${item.id}/remove`, {})) as AppState)
      onToast(`${item.name} is no longer in Saved.`)
    } catch (failure) {
      onToast((failure as Error).message)
    }
  }
  return (
    <div className="page plain">
      <div className="wrap">
        <h1 className="title" style={{ marginBottom: 'var(--s-6)' }}>
          Saved
        </h1>
        <p className="meta" style={{ margin: '-12px 0 var(--s-5)' }}>
          {saved.length
            ? `${saved.length} saved · plans are checked when you come back, never bought for you`
            : 'Nothing saved yet. Save an item from Ask Worth or a comparison to check it again later.'}
        </p>
        {ready.length > 0 && (
          <div className="stack" style={{ marginBottom: 'var(--s-5)' }}>
            {ready.map((item) => (
              <ReadyPlan
                key={item.id}
                item={item}
                product={productOf(item)}
                state={state}
                onConfirm={() => setConfirming(item.id)}
                onUpdate={onUpdate}
                onToast={onToast}
                onOpenCheckout={onOpenCheckout}
                onOpen={(amountCents) => onOpenDecision(decisionFor(item, amountCents))}
              />
            ))}
          </div>
        )}
        {saved.length > 0 && (
          <div className="saved-grid">
            {saved.map((item) => (
              <SavedCard
                key={item.id}
                item={item}
                product={productOf(item)}
                fit={fits.get(item.id)}
                onOpen={() => onOpenDecision(decisionFor(item))}
                onRemove={() => void remove(item)}
              />
            ))}
          </div>
        )}
      </div>
      {confirming && (
        <FundsDialog
          state={state}
          onClose={() => setConfirming(undefined)}
          onConfirmed={(next) => {
            onUpdate(next)
            setConfirming(undefined)
          }}
        />
      )}
    </div>
  )
}

/** "Keep my plan on this device for 30 days" (D-9 a). Off by default. */
function RetentionSwitch({
  state,
  onUpdate,
}: {
  state: AppState
  onUpdate: (s: AppState) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const keep = state.retention?.keep30 ?? false
  const until = state.retention ? new Date(state.retention.expiresAt) : undefined
  const when = until
    ? until.toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : ''
  // Retention runs on real time, even while the demo clock moves the sample's day.
  const real = state.demoClock ? ' (real time)' : ''
  async function change(next: boolean) {
    setBusy(true)
    setError('')
    try {
      onUpdate((await api<AppState>('/retention', { keep30: next })) as AppState)
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsRow
      icon={Clock}
      label="Keep my plan for 30 days"
      sub={
        <span id="keep-note">
          {keep
            ? `Kept until ${when}${real}. Only this browser can open it: no account, no recovery.`
            : `Otherwise deleted ${when ? `on ${when}${real}` : 'after 24 hours'}.`}
          {error && (
            <span className="co-error" role="alert">
              {' '}
              {error}
            </span>
          )}
        </span>
      }
      control={
        <Toggle
          checked={keep}
          busy={busy}
          label="Keep my plan on this device for 30 days"
          describedBy="keep-note"
          onChange={(next) => void change(next)}
        />
      }
    />
  )
}

/**
 * The labelled demo clock (C-17): moves only the synthetic persona's day, so a video can show a
 * return visit on the wait date. Imported data never follows it.
 */
function DemoClock({
  state,
  onUpdate,
  onToast,
}: {
  state: AppState
  onUpdate: (s: AppState) => void
  onToast: (text: string) => void
}) {
  const sample = state.profile.source === 'demo'
  const { name } = state.profile
  const alex = state.config.sample === 'alex'
  const from = state.profile.snapshotDate
  const planned = (state.saved ?? [])
    .map((item) => item.waitDate)
    .filter((date): date is string => Boolean(date && date > state.today))
    .sort()
  const [date, setDate] = useState(planned[0] ?? addDays(state.today, 1))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = state.purchases.some(isActive)
  async function set(body: object, done: string | ((next: AppState) => string)) {
    setBusy(true)
    setError('')
    try {
      const next = (await api<AppState>('/demo-clock', body)) as AppState
      onUpdate(next)
      onToast(typeof done === 'string' ? done : done(next))
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (!sample)
    return (
      <p className="meta">
        The demo clock works only on the sample persona. Your imported data always uses today’s
        date.
      </p>
    )
  return (
    <>
      <p className="meta">
        Moves only {name}’s sample plan, so a demo can show a return visit on a plan’s date. Your
        own data never uses it.{' '}
        {state.demoClock
          ? `${name}’s day is ${fullDate(state.today)}.`
          : `${name}’s day follows today’s date.`}
      </p>
      <div className="actions" style={{ marginTop: 12 }}>
        {alex ? (
          <>
            <Button
              variant="secondary"
              disabled={busy || active}
              onClick={() => void set({ preset: 'demo' }, replayToast)}
            >
              Sample day · {sampleDate(DEMO_PRESET_DAYS.demo)}
            </Button>
            <Button
              variant="secondary"
              disabled={busy || active}
              onClick={() => void set({ preset: 'demo-dec15' }, replayToast)}
            >
              Return visit · {sampleDate(DEMO_PRESET_DAYS['demo-dec15'])}
            </Button>
          </>
        ) : (
          <Button
            variant="secondary"
            disabled={busy || active}
            onClick={() => void set({ preset: 'video' }, replayToast)}
          >
            Video replay · {sampleDate(DEMO_PRESET_DAYS.video)}
          </Button>
        )}
        {/* Alex's dates are fixed, so his pinned days have nowhere else to go back to. */}
        {state.demoClock && !pinnedSample(state) && (
          <Button
            variant="text"
            disabled={busy || active}
            onClick={() =>
              void set({ preset: 'today' }, (next) =>
                next.demoClock
                  ? `${next.profile.name}’s sample is back on ${sampleDate(next.today)}.`
                  : `${next.profile.name}’s sample plan is back on today’s date.`,
              )
            }
          >
            {alex ? 'Back to the sample day' : 'Back to today'}
          </Button>
        )}
      </div>
      <div style={{ marginTop: 12 }}>
        <DateStepper
          label={`Move ${name}’s day to`}
          value={date < from ? from : date}
          min={from}
          max={addDays(from, 60)}
          onChange={setDate}
          disabled={busy || active}
        />
        <div className="actions" style={{ marginTop: 8 }}>
          <Button
            variant="secondary"
            icon={Clock}
            disabled={busy || active}
            onClick={() => void set({ date }, `${name}’s day is now ${dayLabel(date)}.`)}
          >
            Set {name}’s day
          </Button>
        </div>
      </div>
      {active && (
        <p className="caption" style={{ marginTop: 8 }}>
          Finish or cancel your checkout before changing the demo clock.
        </p>
      )}
      {error && (
        <p className="co-error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

export function Settings({
  state,
  onUpdate,
  onReset,
  onEditPlan,
  onImport,
  onToast,
}: {
  state: AppState
  onUpdate: (state: AppState) => void
  onReset: (state: AppState) => void
  onEditPlan: (step: number) => void
  onImport: () => void
  onToast?: (text: string) => void
}) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = state.purchases.some(isActive)
  const [disconnecting, setDisconnecting] = useState(false)
  /** Forgets the kept PayPal connection; the plan stays exactly as it is. */
  async function disconnect() {
    setDisconnecting(true)
    setError('')
    try {
      onUpdate((await api<AppState>('/paypal/disconnect', {})) as AppState)
      onToast?.('PayPal disconnected. Your plan stays as it is.')
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setDisconnecting(false)
    }
  }
  async function reset() {
    setBusy(true)
    setError('')
    try {
      onReset((await api<AppState>('/reset', {})) as AppState)
      setConfirm(false)
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const browserZone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      return undefined
    }
  })()
  const demo = state.profile.source === 'demo'
  const claude = state.config.ai === 'anthropic'
  return (
    <div className="page plain settings-page">
      <div className="wrap narrow">
        <h1 className="title" style={{ marginBottom: 'var(--s-6)' }}>
          Settings and privacy
        </h1>
        <div className="set-groups">
          <SettingsGroup title="Assistant">
            <SettingsRow
              icon={Sparkles}
              label="Ask Worth assistant"
              sub={
                !claude
                  ? 'Not connected here: answers use Worth’s own calculation'
                  : claudeOn(state)
                    ? 'On · powered by Claude · every number is Worth’s'
                    : 'Off · answers use Worth’s own calculation'
              }
              control={<ClaudeSwitch state={state} onUpdate={onUpdate} bare />}
            />
            <SettingsMore
              icon={Eye}
              label="What Claude sees"
              sub="Plan totals and short labels, never your login"
            >
              <dl className="kvlist">
                {claudeUses(claudeOn(state)).map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="caption">
                When the assistant is on, these go to Anthropic (Claude): {CLAUDE_SHARED_DATA}.
              </p>
            </SettingsMore>
          </SettingsGroup>

          <SettingsGroup title="PayPal">
            <SettingsRow
              icon={Wallet}
              label="Your PayPal activity"
              sub={
                demo ? 'Showing the sample month' : `Imported · ${state.profile.coverageDays} days`
              }
            />
            {/* Disconnect PayPal goes here, for a plan read through Connect PayPal. */}
            <SettingsAction
              icon={FileUp}
              label={demo ? 'Use your own PayPal activity' : 'Import PayPal activity'}
              sub="Connect PayPal or choose a CSV export"
              onClick={onImport}
            />
            <SettingsRow
              icon={CreditCard}
              label="PayPal checkout"
              control={
                <span className="set-value">
                  {state.config.paypal === 'sandbox' ? 'Sandbox' : 'Simulated'}
                </span>
              }
            />
          </SettingsGroup>

          <SettingsGroup title="AI agents">
            <SettingsMore
              icon={Bot}
              label="Connect an agent"
              sub="Let an agent like Claude Desktop ask Worth before it pays"
            >
              <ConnectAgent state={state} onToast={onToast} />
            </SettingsMore>
          </SettingsGroup>

          <SettingsGroup title="Sample and demo">
            <SettingsAction
              icon={Compass}
              label="Take the tour"
              sub="Six steps around Home"
              onClick={() => {
                startTour()
                window.location.hash = 'home'
              }}
            />
            {/* The clock's controls show only while a sample day is pinned: always for Alex, and
                for the test fixture persona only after a ?replay= link. */}
            {state.demoClock && (
              <SettingsMore
                icon={CalendarClock}
                label="Demo clock"
                sub={demo ? `${state.profile.name}’s day: ${fullDate(state.today)}` : undefined}
              >
                <DemoClock
                  state={state}
                  onUpdate={onUpdate}
                  onToast={onToast ?? (() => undefined)}
                />
              </SettingsMore>
            )}
            <SettingsMore
              icon={Info}
              label="About this demo"
              sub={
                demo
                  ? 'A sample month for a made-up shopper · no real money moves'
                  : 'A hackathon app, not a PayPal product'
              }
            >
              {demo && (
                <p>
                  This is {SAMPLE_WHO}. No real money moves, and{' '}
                  {paypalModeLine(state.config.paypal)}.
                </p>
              )}
              <p>
                <JudgeBadge state={state} />
              </p>
              <p className="meta">
                Worth is an independent hackathon app, not a PayPal product.{' '}
                <a
                  href="https://github.com/iAnmolAgarwal/worth#readme"
                  target="_blank"
                  rel="noreferrer"
                >
                  Read the README
                </a>
              </p>
            </SettingsMore>
          </SettingsGroup>

          <SettingsGroup title="Privacy">
            <SettingsMore
              icon={Store}
              label="Similar items and pasted links"
              sub="Channel3 gets a kind of item and a price limit, never your name"
              region="Similar items and pasted links (Channel3)"
            >
              <dl className="kvlist">
                <div>
                  <dt>Sent to Channel3</dt>
                  <dd>{CHANNEL3_SHARED_DATA}</dd>
                </div>
                <div>
                  <dt>A product link you paste</dt>
                  <dd>{CHANNEL3_LINK_DATA}</dd>
                </div>
                <div>
                  <dt>Your name, plan or other words</dt>
                  <dd>Never</dd>
                </div>
              </dl>
            </SettingsMore>
            <SettingsRow
              icon={Globe}
              label="Time zone"
              sub={
                browserZone && browserZone !== state.profile.timezone
                  ? `This browser: ${browserZone}`
                  : undefined
              }
              control={
                <>
                  <span className="set-value">{state.profile.timezone}</span>
                  <button type="button" className="link" onClick={() => onEditPlan(0)}>
                    Change
                  </button>
                </>
              }
            />
            <RetentionSwitch state={state} onUpdate={onUpdate} />
          </SettingsGroup>

          <SettingsGroup title="Your data" danger>
            {state.config.paypalLinked && (
              <SettingsAction
                icon={Unplug}
                label="Disconnect PayPal"
                sub="Worth stops reading your PayPal activity. Your plan stays as it is."
                onClick={() => void disconnect()}
                disabled={disconnecting}
              />
            )}
            <SettingsAction
              icon={Trash2}
              label="Delete my data now"
              sub={
                active
                  ? 'Finish or cancel your checkout before deleting your data.'
                  : 'Your plan, history and saved items. Worth starts again with the sample.'
              }
              onClick={() => setConfirm(true)}
              disabled={active}
              danger
            />
          </SettingsGroup>
        </div>
      </div>
      {confirm && (
        <Dialog
          title="Delete your data?"
          onClose={() => setConfirm(false)}
          dismissible={!busy}
          footer={
            <>
              {error && (
                <p className="co-error" role="alert">
                  {error}
                </p>
              )}
              <Button block loading={busy} onClick={() => void reset()}>
                Delete and start over
              </Button>
              <Button variant="text" onClick={() => setConfirm(false)} disabled={busy}>
                Keep my data
              </Button>
            </>
          }
        >
          <Alert tone="bad" icon={CircleAlert}>
            Your imported history, your plan, your saved items and your Worth purchase records are
            deleted. Worth starts again with the sample profile.
          </Alert>
        </Dialog>
      )}
    </div>
  )
}
