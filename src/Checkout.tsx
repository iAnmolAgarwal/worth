import { useEffect, useRef, useState } from 'react'
import {
  Check,
  CircleAlert,
  CircleCheck,
  CircleX,
  ExternalLink,
  LoaderCircle,
  Lock,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react'
import type { Assessment, Product } from '../shared/types'
import { api, ApiError } from './api'
import type { AppState, Comparison, Purchase } from './contract'
import { firstBelow, lower } from './engine'
import { boughtOn, cx, dayLabel, money, signed } from './format'
import { PayPalButton, useEligibility, type SdkStatus } from './paypal'
import type { PayPalSdkInstance, PayPalSessionCallbacks } from './paypalSdk'
import { Alert, Button, Dialog } from './ui'

export type CheckoutView =
  | 'review'
  | 'approve'
  | 'waiting'
  | 'approved'
  | 'completed'
  | 'declined'
  | 'failed'
  | 'cancelled'
  | 'checking'

/** Status drives everything: heading, icon, body and action all come from the purchase status. */
export function checkoutView(
  purchase: Purchase | undefined,
  approved: boolean,
  /** PayPal was opened from this screen; until then a created order leads with the button. */
  opened = true,
): CheckoutView {
  if (!purchase) return 'review'
  if (purchase.status === 'completed') return 'completed'
  if (purchase.status === 'cancelled') return 'cancelled'
  if (purchase.needsReapproval) return 'declined'
  if (purchase.status === 'failed') return 'failed'
  if (purchase.status === 'pending' || purchase.status === 'unknown') return 'checking'
  return approved || purchase.mode === 'demo' ? 'approved' : opened ? 'waiting' : 'approve'
}

const STEP: Record<CheckoutView, number> = {
  review: 1,
  approve: 2,
  waiting: 2,
  declined: 2,
  approved: 3,
  checking: 3,
  completed: 4,
  failed: 0,
  cancelled: 0,
}

function Steps({ view }: { view: CheckoutView }) {
  const current = STEP[view]
  if (!current || current > 3) return null
  const labels = ['Review', current > 2 ? 'Approved' : 'Approve', 'Confirm']
  return (
    <ol className="steps" aria-label={`Step ${current} of 3`}>
      {labels.map((label, index) => {
        const n = index + 1
        return (
          <li key={label} style={{ display: 'contents' }}>
            {index > 0 && <span className="bar" aria-hidden="true" />}
            <span
              className={cx('st', n < current && 'done', n === current && 'cur')}
              aria-current={n === current ? 'step' : undefined}
            >
              <span className="dot" aria-hidden="true">
                {n < current ? <Check size={12} strokeWidth={3} /> : n}
              </span>
              {label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

export function Checkout({
  state,
  product,
  purchaseId,
  returnedApproved = false,
  returnedCancelled = false,
  acknowledge = false,
  instance,
  sdkStatus = 'off',
  onClose,
  onUpdate,
  onViewActivity,
  onConfirmPlan,
  onEditPlan,
}: {
  state: AppState
  product: Product
  purchaseId?: string
  returnedApproved?: boolean
  returnedCancelled?: boolean
  /** The user came from "Buy today anyway"; the consent box still starts unticked. */
  acknowledge?: boolean
  instance?: PayPalSdkInstance
  sdkStatus?: SdkStatus
  onClose: () => void
  onUpdate: (state: AppState) => void
  onViewActivity: () => void
  onConfirmPlan: (purchaseId: string) => void
  onEditPlan: () => void
}) {
  const [localPurchase, setLocalPurchase] = useState<Purchase | undefined>(() =>
    state.purchases.find((p) => p.id === purchaseId),
  )
  const purchase = state.purchases.find((p) => p.id === localPurchase?.id) ?? localPurchase
  const [approved, setApproved] = useState(returnedApproved)
  /** Whether PayPal was opened from this screen. A reopened or agent-prepared order starts closed. */
  const [opened, setOpened] = useState(false)
  const [assessment, setAssessment] = useState<Assessment>()
  const [room, setRoom] = useState<Comparison>()
  const [fundsOk, setFundsOk] = useState(false)
  // Consent below the cushion is always ticked here, on this review's own figures, even after
  // "Buy today anyway" (pre-merge judge finding 5).
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState(
    returnedCancelled
      ? 'You left PayPal before approving. Reopen PayPal, or cancel this checkout.'
      : '',
  )
  const [approvalUrl, setApprovalUrl] = useState('')
  /** The server asks for an explicit "buy anyway" before capturing below the cushion. */
  const [shortfall, setShortfall] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const view = checkoutView(purchase, approved, opened)
  const hasPurchase = Boolean(purchase)
  const sandbox = state.config.paypal === 'sandbox'
  const eligibility = useEligibility(sandbox ? instance : undefined, product.priceCents)
  const sdkReady = Boolean(instance) && eligibility.paypal === 'eligible'
  // While PayPal's SDK and eligibility load, hold the button's place instead of a fallback.
  const sdkPending =
    sandbox && (sdkStatus === 'loading' || (Boolean(instance) && eligibility.paypal === 'unknown'))

  // A fresh check for today's purchase: the review and "Lowest after" use it.
  useEffect(() => {
    let cancelled = false
    api<Assessment>('/assess', {
      amountCents: product.priceCents,
      itemName: product.name,
      purchaseDate: state.today,
    })
      .then((result) => !cancelled && setAssessment(result))
      .catch((failure: Error) => !cancelled && setError(failure.message))
    return () => {
      cancelled = true
    }
  }, [product, state.today, state.profile.version])
  useEffect(() => {
    if (!hasPurchase) return
    let cancelled = false
    api<Comparison>('/compare', { amountCents: 0, itemName: 'Room to spend' })
      .then((result) => !cancelled && setRoom(result))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [hasPurchase, view, state.profile.version])
  // Move focus to the heading on every status change (brief §5.4).
  useEffect(() => {
    heading.current?.focus()
  }, [view])

  function callbacks(created?: () => Purchase | undefined): PayPalSessionCallbacks {
    return {
      commit: false,
      onApprove: ({ orderId }) => {
        const current = created?.() ?? purchase
        if (!current?.orderId || current.orderId === orderId) {
          setApproved(true)
          setNotice('')
        } else setNotice('PayPal approved a different order. Check this checkout before you pay.')
      },
      onCancel: () => {
        setOpened(false)
        setNotice('You closed PayPal before approving. Open it again, or cancel this checkout.')
      },
      onError: (failure) =>
        setError(
          `PayPal’s window couldn’t finish${failure?.code ? ` (${failure.code})` : ''}. Reopen PayPal to try again.`,
        ),
    }
  }

  async function refresh() {
    try {
      onUpdate((await api<AppState>('/state')) as AppState)
    } catch {
      /* The visible status stays until the next refresh. */
    }
  }

  async function create() {
    setOpened(true)
    setBusy(true)
    setError('')
    setNotice('')
    let created: Purchase | undefined
    const order = api<{ purchase: Purchase; approvalUrl?: string; orderId?: string }>(
      '/checkout/create',
      { productId: product.id, acknowledgeShortfall: ack },
    ).then(async (result) => {
      created = result.purchase
      setLocalPurchase(result.purchase)
      setApprovalUrl(result.approvalUrl ?? '')
      await refresh()
      return result
    })
    try {
      if (sandbox && sdkReady && instance) {
        const session = instance.createPayPalOneTimePaymentSession(callbacks(() => created))
        // Start inside the click, before awaiting the order, to keep popup permission.
        await session.start(
          { presentationMode: 'auto' },
          order.then((result) => {
            const orderId = result.purchase.orderId ?? result.orderId
            if (!orderId) throw new Error('PayPal did not return an order.')
            return { orderId }
          }),
        )
      } else {
        const result = await order
        const url = result.purchase.approveUrl ?? result.approvalUrl
        if (sandbox && url) window.location.assign(url)
      }
    } catch (failure) {
      await order.catch(() => undefined)
      setError((failure as Error).message)
      if (failure instanceof ApiError && failure.details && typeof failure.details === 'object') {
        const details = failure.details as { assessment?: Assessment }
        if (details.assessment) setAssessment(details.assessment)
      }
      try {
        const latest = (await api<AppState>('/state')) as AppState
        onUpdate(latest)
        const reserved = latest.purchases.find(
          (p) => p.productId === product.id && ['created', 'pending', 'unknown'].includes(p.status),
        )
        if (reserved) setLocalPurchase(reserved)
      } catch {
        /* A reload recovers stored status. */
      }
    } finally {
      setBusy(false)
    }
  }

  async function reopen() {
    if (!purchase) return create()
    setError('')
    setNotice('')
    setApproved(false)
    setOpened(true)
    if (sandbox && sdkReady && instance && purchase.orderId) {
      try {
        await instance
          .createPayPalOneTimePaymentSession(callbacks())
          .start({ presentationMode: 'auto' }, Promise.resolve({ orderId: purchase.orderId }))
      } catch (failure) {
        setError((failure as Error).message)
      }
      return
    }
    const url = purchase.approveUrl ?? approvalUrl
    if (url) window.location.assign(url)
    else await create()
  }

  async function capture(acknowledgeShortfall = false) {
    if (!purchase) return
    if (purchase.proceedConfirmRequired && !acknowledgeShortfall && !shortfall) {
      setShortfall(true)
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await api<{ purchase: Purchase; state: AppState }>(
        `/checkout/${purchase.id}/capture`,
        acknowledgeShortfall ? { acknowledgeShortfall: true } : {},
      )
      setShortfall(false)
      setLocalPurchase(result.purchase)
      onUpdate(result.state)
    } catch (failure) {
      // A declined capture (409 PAYMENT_DECLINED) carries the purchase with needsReapproval set.
      const declined =
        failure instanceof ApiError &&
        (failure.details as { purchase?: Purchase } | undefined)?.purchase
      if (failure instanceof ApiError && failure.code === 'SHORTFALL_ACKNOWLEDGEMENT_REQUIRED')
        setShortfall(true)
      else if (declined) {
        setLocalPurchase(declined)
        setApproved(false)
      } else setError((failure as Error).message)
      try {
        const latest = (await api<AppState>('/state')) as AppState
        onUpdate(latest)
        setLocalPurchase(
          (latest.purchases.find((p) => p.id === purchase.id) ?? declined) || purchase,
        )
      } catch {
        /* The original error stays visible. */
      }
    } finally {
      setBusy(false)
    }
  }

  async function cancel() {
    if (!purchase) return
    setBusy(true)
    setError('')
    try {
      const latest = (await api<AppState>(`/checkout/${purchase.id}/cancel`, {})) as AppState
      onUpdate(latest)
      setLocalPurchase(latest.purchases.find((p) => p.id === purchase.id))
      setNotice('')
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const amount = money(product.priceCents)
  const tight = assessment?.outcome === 'tight'
  const incomplete = assessment?.outcome === 'incomplete'
  const ready = Boolean(assessment) && !incomplete && fundsOk && (!tight || ack)
  const review = state.reviews.find(
    (item) => item.kind === 'confirmPlan' && item.purchaseId === purchase?.id,
  )
  // Once a purchase is reserved, the plan already counts it, so the comparison with nothing
  // added is the balance after it. Before that, the fresh check for this price is.
  const after = purchase
    ? room && { cents: room.buyToday.lowestBalanceCents, date: room.buyToday.lowestDate }
    : assessment && !incomplete
      ? { cents: assessment.lowestBalanceCents, date: assessment.lowestDate }
      : undefined
  const lowestAfter = after && (
    <div>
      <dt>Lowest after</dt>
      <dd className="num">
        {signed(after.cents)} · {dayLabel(after.date)}
      </dd>
    </div>
  )
  const breach = room && firstBelow(room.buyToday.points, room.cushionCents)
  const mode = purchase?.mode ?? (sandbox ? 'sandbox' : 'demo')

  const content: Record<
    CheckoutView,
    { icon: LucideIcon; tone: string; title: string; body: string; spin?: boolean }
  > = {
    review: {
      icon: Lock,
      tone: 'neutral',
      title: sandbox ? 'Pay with PayPal' : 'Simulated checkout',
      body: !assessment
        ? 'Checking your plan for today…'
        : incomplete
          ? 'Your plan needs a few details before you buy.'
          : tight
            ? 'Fresh check: buying today takes you below your cushion.'
            : `Checked just now: you keep your ${money(assessment.cushionCents)} cushion.`,
    },
    approve: {
      icon: Lock,
      tone: 'neutral',
      title: 'Approve in PayPal',
      body: 'Your order is ready. Approve it in PayPal, then confirm here. Nothing is charged until you do.',
    },
    waiting: {
      icon: LoaderCircle,
      spin: true,
      tone: 'wait',
      title: 'Waiting for PayPal',
      body: 'Finish in the PayPal window. We’ll pick up here when you approve.',
    },
    approved: {
      icon: CircleCheck,
      tone: 'ok',
      title: mode === 'demo' ? 'Ready to pay (simulated)' : 'Approved in PayPal',
      body:
        mode === 'demo'
          ? 'This is a simulated checkout. Nothing is charged.'
          : 'One more step. Nothing is charged until you confirm.',
    },
    completed: {
      icon: Check,
      tone: 'ok',
      title: `Paid ${money(purchase?.amountCents ?? product.priceCents)}`,
      body: `${product.merchant} · ${dayLabel(purchase?.completedAt ? boughtOn(purchase, state.profile.timezone) : state.today)} · ${mode === 'sandbox' ? 'PayPal sandbox' : 'simulated'}`,
    },
    declined: {
      icon: CircleAlert,
      tone: 'bad',
      title: 'That card was declined',
      body:
        purchase?.lastError?.code === 'PAYER_ACTION_REQUIRED'
          ? (purchase.lastError.message ??
            'PayPal needs one more step from you. Nothing was charged.')
          : 'Your payment method was declined. Choose another way to pay in PayPal.',
    },
    failed: {
      icon: CircleAlert,
      tone: 'bad',
      title: 'Payment didn’t go through',
      body: purchase?.lastError?.message ?? 'Nothing was charged.',
    },
    cancelled: {
      icon: CircleX,
      tone: 'neutral',
      title: 'Checkout cancelled',
      body: `Nothing was charged. The ${money(purchase?.amountCents ?? product.priceCents)} set aside in your plan is free again.`,
    },
    checking: {
      icon: LoaderCircle,
      spin: true,
      tone: 'wait',
      title: 'PayPal is still confirming',
      body: 'This amount stays set aside while Worth checks with PayPal.',
    },
  }
  const c = content[view]
  // Every status line follows the order's status: a note about leaving PayPal belongs only to a
  // checkout still waiting for approval, never under "Checkout cancelled" or a payment (fix #9).
  const statusNote =
    view === 'approve' || view === 'waiting'
      ? notice ||
        (purchase?.lastError?.code === 'PAYPAL_CANCELLED' ? purchase.lastError.message : '')
      : ''

  const footer = (
    <>
      {error && (
        <p className="co-error" role="alert">
          <CircleAlert size={16} aria-hidden="true" style={{ flex: 'none', marginTop: 2 }} />
          {error}
        </p>
      )}
      {view === 'review' &&
        (incomplete ? (
          <Button block onClick={onEditPlan}>
            Review your plan
          </Button>
        ) : sdkPending ? (
          <PayPalLoading />
        ) : sandbox && sdkReady ? (
          ready ? (
            <PayPalButton onClick={() => void create()} />
          ) : (
            <p className="caption" style={{ textAlign: 'center' }}>
              Tick the box above to continue to PayPal.
            </p>
          )
        ) : (
          <Button block disabled={!ready} loading={busy} onClick={() => void create()}>
            {sandbox ? 'Continue to PayPal sandbox' : `Start simulated checkout`}
          </Button>
        ))}
      {view === 'approve' &&
        (sdkPending ? (
          <PayPalLoading />
        ) : sandbox && sdkReady ? (
          <PayPalButton onClick={() => void reopen()} />
        ) : (
          <Button block icon={ExternalLink} onClick={() => void reopen()} disabled={busy}>
            Continue to PayPal sandbox
          </Button>
        ))}
      {view === 'waiting' && (
        <>
          <Button block icon={ExternalLink} onClick={() => void reopen()} disabled={busy}>
            Reopen PayPal
          </Button>
          <Button variant="text" onClick={() => setApproved(true)} disabled={busy}>
            I’ve approved it in PayPal
          </Button>
        </>
      )}
      {view === 'approved' &&
        (shortfall ? (
          <Button block loading={busy} onClick={() => void capture(true)}>
            Buy anyway
          </Button>
        ) : (
          <Button block loading={busy} onClick={() => void capture()}>
            Pay {money(purchase?.amountCents ?? product.priceCents)}
          </Button>
        ))}
      {view === 'checking' && (
        <Button block loading={busy} onClick={() => void capture()}>
          Check payment status
        </Button>
      )}
      {view === 'declined' && (
        <Button block icon={RefreshCw} onClick={() => void reopen()} disabled={busy}>
          Choose another way to pay
        </Button>
      )}
      {view === 'completed' && (
        <>
          {review && (
            <Button block onClick={() => onConfirmPlan(purchase!.id)}>
              Confirm how you paid
            </Button>
          )}
          <Button variant="secondary" block onClick={onViewActivity}>
            View in Activity
          </Button>
        </>
      )}
      {(view === 'cancelled' || view === 'failed') && (
        <Button variant="secondary" block onClick={onClose}>
          Back to the {lower(product.name)}
        </Button>
      )}
      {['approve', 'waiting', 'approved', 'declined', 'checking'].includes(view) && (
        <Button variant="text" onClick={() => void cancel()} disabled={busy}>
          Cancel checkout
        </Button>
      )}
      {view === 'review' && (
        <Button variant="text" onClick={onClose} disabled={busy}>
          Back
        </Button>
      )}
    </>
  )

  return (
    <Dialog
      title={`Checkout · ${product.name}`}
      onClose={onClose}
      footer={footer}
      dismissible={!busy}
    >
      <div className="co">
        {purchase?.preparedBy === 'agent' && view !== 'completed' && (
          <p className="caption">
            Prepared by Worth’s assistant from your question. You approve in PayPal and confirm
            here.
          </p>
        )}
        <Steps view={view} />
        <div className="co-head">
          <span className={`co-icon ${c.tone}`} aria-hidden="true">
            <c.icon className={cx('ico', c.spin && 'spin')} />
          </span>
          <div>
            <h3 ref={heading} tabIndex={-1} data-autofocus>
              {c.title}
            </h3>
            <p>{c.body}</p>
          </div>
        </div>
        <div role="status" aria-live="polite" className="sr">
          {c.title}
        </div>
        {statusNote && <p className="meta strong">{statusNote}</p>}
        {view === 'approved' && shortfall && (
          <Alert tone="bad" icon={CircleAlert} live>
            <b>
              This purchase takes you below your{' '}
              {money(room?.cushionCents ?? state.profile.cushionCents)} cushion
              {breach ? ` on ${dayLabel(breach.date)}` : ''}. Buy anyway?
            </b>
          </Alert>
        )}
        {view !== 'completed' && view !== 'cancelled' && (
          <dl className="kvlist">
            <div>
              <dt>{view === 'approved' ? `Pay ${product.merchant}` : product.merchant}</dt>
              <dd className="num">{amount}</dd>
            </div>
            {(view === 'review' || view === 'approve' || view === 'approved') && lowestAfter}
          </dl>
        )}
        {view === 'completed' && (
          <dl className="kvlist">
            <div>
              <dt>Room to spend now</dt>
              <dd className="num">{room ? money(room.spendLess.maxPriceCents) : '…'}</dd>
            </div>
            <div>
              <dt>Cushion</dt>
              <dd>{room ? (room.buyToday.outcome === 'fits' ? 'Kept' : 'Below') : '…'}</dd>
            </div>
          </dl>
        )}
        {view === 'review' && assessment && !incomplete && (
          <div>
            <label className="check">
              <input
                type="checkbox"
                checked={fundsOk}
                onChange={(event) => setFundsOk(event.target.checked)}
              />
              <span>My money and bills are still as entered today.</span>
            </label>
            {tight && acknowledge && (
              <p className="caption" style={{ margin: '8px 0 0' }}>
                You chose to buy today anyway. These are today’s figures; tick below to confirm.
              </p>
            )}
            {tight && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(event) => setAck(event.target.checked)}
                />
                <span>
                  I understand buying today takes me below my {money(assessment.cushionCents)}{' '}
                  cushion.
                </span>
              </label>
            )}
            <p className="caption" style={{ marginTop: 8 }}>
              {sandbox
                ? 'PayPal checkout · sandbox. You’ll approve in PayPal, then confirm here.'
                : 'No PayPal credentials are set, so this checkout is a labelled simulation.'}
            </p>
          </div>
        )}
      </div>
    </Dialog>
  )
}

/** Holds the official button's place while PayPal's SDK loads, with a visible label. */
function PayPalLoading() {
  return (
    <span className="pp-loading" role="status">
      <LoaderCircle className="ico spin" aria-hidden="true" />
      Loading PayPal…
    </span>
  )
}
