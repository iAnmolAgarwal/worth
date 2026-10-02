import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CreditCard,
  ExternalLink,
  LoaderCircle,
  ShieldCheck,
} from 'lucide-react'
import type { AppState, Assessment, Product, Purchase } from '../shared/types'
import { addDays } from '../shared/finance'
import { api, ApiError } from './api'
import { money, shortDate } from './format'
import { AssessmentCard } from './Assistant'
import { Button, Field, Footnote, Modal, Step, Tag } from './ui'
import { loadPayPalSdk, type PayPalSdkInstance } from './paypalSdk'

export function PurchaseDialog({
  state,
  product,
  existingPurchase,
  onClose,
  onUpdate,
  onPlan,
}: {
  state: AppState
  product: Product
  existingPurchase?: Purchase
  onClose: () => void
  onUpdate: (s: AppState) => void
  onPlan: () => void
}) {
  const [date, setDate] = useState(state.today)
  const [amount, setAmount] = useState(product.priceCents)
  const [assessment, setAssessment] = useState<Assessment>()
  const [stage, setStage] = useState<'assess' | 'review' | 'payment'>(
    existingPurchase ? 'payment' : 'assess',
  )
  const [localPurchase, setPurchase] = useState<Purchase | undefined>(existingPurchase)
  const purchase = state.purchases.find((p) => p.id === localPurchase?.id) ?? localPurchase
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [ack, setAck] = useState(false)
  const [fundsConfirmed, setFundsConfirmed] = useState(false)
  const [approvalUrl, setApprovalUrl] = useState('')
  const [approvalNotice, setApprovalNotice] = useState('')
  const sdk = useRef<PayPalSdkInstance | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    const id = state.config.paypalClientId
    if (id)
      void loadPayPalSdk(id)
        .then(async (instance) => {
          const methods = await instance.findEligibleMethods({
            currencyCode: 'USD',
          })
          if (!cancelled && methods.isEligible('paypal')) sdk.current = instance
        })
        .catch(() => {
          /* The server-provided approval link remains available. */
        })
    return () => {
      cancelled = true
    }
  }, [state.config.paypalClientId])
  useEffect(() => {
    if (stage !== 'assess') return
    let cancelled = false
    // This request synchronizes the visible quote with its date, price and plan version.
    // oxlint-disable-next-line react/set-state-in-effect
    setLoading(true)
    setAssessment(undefined)
    setError('')
    api<Assessment>('/assess', {
      amountCents: amount,
      itemName: amount === product.priceCents ? product.name : 'Lower-price alternative',
      purchaseDate: date,
    })
      .then((a) => {
        if (!cancelled) setAssessment(a)
      })
      .catch((e) => {
        if (!cancelled) setError(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [date, amount, product, stage, state.profile.version])
  async function review() {
    setBusy(true)
    setError('')
    try {
      const a = await api<Assessment>('/assess', {
        amountCents: product.priceCents,
        itemName: product.name,
        purchaseDate: state.today,
      })
      setAssessment(a)
      setDate(state.today)
      setAmount(product.priceCents)
      setAck(false)
      setFundsConfirmed(false)
      setStage('review')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function create() {
    setBusy(true)
    setError('')
    setApprovalNotice('')
    let created: Purchase | undefined
    const orderPromise = api<{
      purchase: Purchase
      approvalUrl?: string
      mode: 'demo' | 'sandbox'
    }>('/checkout/create', {
      productId: product.id,
      acknowledgeShortfall: ack,
    }).then(async (result) => {
      created = result.purchase
      setPurchase(result.purchase)
      setApprovalUrl(result.approvalUrl ?? '')
      setStage('payment')
      onUpdate(await api<AppState>('/state'))
      return result
    })
    try {
      if (sdk.current && state.config.paypal === 'sandbox') {
        const session = sdk.current.createPayPalOneTimePaymentSession({
          commit: false,
          onApprove: ({ orderId }) => {
            setApprovalNotice(
              created?.orderId === orderId
                ? 'Approved in PayPal. Confirm below to complete your sandbox payment.'
                : 'Return to this checkout and check the payment status before proceeding.',
            )
          },
          onCancel: () => {
            setApprovalNotice(
              'PayPal approval was cancelled. You can reopen PayPal or cancel this checkout to release its allocation.',
            )
          },
          onError: () => {
            setError(
              'PayPal’s checkout window could not finish. Use “Return to PayPal approval” to continue in this tab.',
            )
          },
        })
        // Start in the click event, before awaiting the order, to preserve popup permission.
        await session.start(
          { presentationMode: 'auto' },
          orderPromise.then((result) => {
            if (!result.purchase.orderId) throw new Error('PayPal did not return an order.')
            return { orderId: result.purchase.orderId }
          }),
        )
      } else {
        const result = await orderPromise
        if (result.approvalUrl) window.location.assign(result.approvalUrl)
      }
    } catch (e) {
      // Observe any outstanding create result even if the SDK fails before consuming it.
      await orderPromise.catch(() => undefined)
      setError((e as Error).message)
      if (
        e instanceof ApiError &&
        e.details &&
        typeof e.details === 'object' &&
        'assessment' in e.details
      )
        setAssessment(e.details.assessment as Assessment)
      try {
        const latest = await api<AppState>('/state')
        onUpdate(latest)
        const reserved = latest.purchases.find(
          (p) => p.productId === product.id && ['created', 'pending', 'unknown'].includes(p.status),
        )
        if (reserved) {
          setPurchase(reserved)
          setStage('payment')
        }
      } catch {
        /* A reload can recover stored status. */
      }
    } finally {
      setBusy(false)
    }
  }
  async function capture() {
    if (!purchase) return
    setBusy(true)
    setError('')
    try {
      const result = await api<{ purchase: Purchase; state: AppState }>(
        `/checkout/${purchase.id}/capture`,
        {},
      )
      setPurchase(result.purchase)
      onUpdate(result.state)
    } catch (e) {
      setError((e as Error).message)
      try {
        const latest = await api<AppState>('/state')
        onUpdate(latest)
        setPurchase(latest.purchases.find((p) => p.id === purchase.id) ?? purchase)
      } catch {
        /* Original error remains visible. */
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
      const latest = await api<AppState>(`/checkout/${purchase.id}/cancel`, {})
      onUpdate(latest)
      setPurchase(latest.purchases.find((p) => p.id === purchase.id))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const completed = purchase?.status === 'completed'
  const closed = purchase?.status === 'cancelled' || purchase?.status === 'failed'
  const uncertain = purchase?.status === 'pending' || purchase?.status === 'unknown'
  return (
    <Modal
      open
      onClose={busy ? () => undefined : onClose}
      title={
        completed
          ? 'Payment complete'
          : stage === 'payment'
            ? 'Your checkout'
            : stage === 'review'
              ? 'Review buying today'
              : 'Check the fit'
      }
      className="purchase-modal"
    >
      <div className="checkout-steps">
        <Step index={1} done={stage !== 'assess'} label="Check the fit" />
        <Step index={2} done={stage === 'payment'} label="Review today" />
        <Step
          index={3}
          done={completed}
          label={state.config.paypal === 'sandbox' ? 'PayPal sandbox' : 'Demo checkout'}
        />
      </div>
      <div className="purchase-product">
        <img src={product.image} alt={product.name} />
        <div>
          <h3>{product.name}</h3>
          <span>{product.merchant} · No goods are sold or shipped</span>
        </div>
        <strong>{money(product.priceCents, true)}</strong>
      </div>
      {stage === 'assess' && (
        <>
          <div className="purchase-controls">
            <Field label="When would you like to buy?" hint="Planning up to 30 days ahead">
              <input
                type="date"
                value={date}
                min={state.today}
                max={addDays(state.today, 30)}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
            {amount !== product.priceCents && (
              <div className="notice">
                <strong>Comparing a {money(amount, true)} alternative.</strong>
                <button className="inline-link" onClick={() => setAmount(product.priceCents)}>
                  Restore catalog price
                </button>
              </div>
            )}
          </div>
          {loading && (
            <div className="assessment-loading">
              <LoaderCircle className="spin" size={22} /> Checking your upcoming commitments…
            </div>
          )}
          {assessment && (
            <AssessmentCard
              assessment={assessment}
              compact
              onPlan={onPlan}
              onScenario={(next, total) => {
                setDate(next)
                if (total !== undefined) setAmount(total)
              }}
            />
          )}
          <div className="purchase-actions">
            <span>
              <ShieldCheck size={15} /> Total includes all demo charges.
            </span>
            <Button
              onClick={review}
              loading={busy}
              disabled={!assessment || assessment.outcome === 'incomplete'}
            >
              Review buying today <ArrowRight size={16} />
            </Button>
          </div>
          <Footnote>
            Choosing a future date helps you plan. Checkout always checks buying today again before
            proceeding.
          </Footnote>
        </>
      )}
      {stage === 'review' && assessment && (
        <>
          <div className="notice">
            <CalendarLabel date={state.today} />
            <p>Today’s plan · Full {money(product.priceCents, true)} total</p>
          </div>
          {assessment.outcome === 'incomplete' ? (
            <AssessmentCard assessment={assessment} compact onPlan={onPlan} />
          ) : (
            <section className="checkout-review" aria-label="Current purchase assessment">
              <Tag tone={assessment.outcome === 'fits' ? 'green' : 'amber'}>
                {assessment.outcome === 'fits' ? 'Fits your plan' : 'Below your cushion'}
              </Tag>
              <dl>
                <div>
                  <dt>Projected low · {shortDate(assessment.lowestDate)}</dt>
                  <dd>{money(assessment.lowestBalanceCents, true)}</dd>
                </div>
                <div>
                  <dt>Your cushion</dt>
                  <dd>{money(assessment.cushionCents)}</dd>
                </div>
                <div>
                  <dt>With 20% more daily spending</dt>
                  <dd>{money(assessment.stressLowestCents, true)}</dd>
                </div>
              </dl>
              <p>Conditional on your confirmed funds and commitments.</p>
            </section>
          )}
          {assessment.outcome !== 'incomplete' && (
            <div className="checkout-confirmations">
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={fundsConfirmed}
                  onChange={(e) => setFundsConfirmed(e.target.checked)}
                />
                <span>
                  My available funds and commitments are still current, including spending outside
                  PayPal.
                </span>
              </label>
              {assessment.outcome === 'tight' && (
                <label className="check-row warning-check">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  <span>
                    I understand buying today would fall below my cushion. I still want to try this
                    sandbox checkout.
                  </span>
                </label>
              )}
            </div>
          )}
          <div className="form-actions">
            <Button variant="ghost" onClick={() => setStage('assess')}>
              <ArrowLeft size={15} /> Back to planning
            </Button>
            <Button
              className="paypal-button"
              onClick={create}
              loading={busy}
              disabled={
                assessment.outcome === 'incomplete' ||
                !fundsConfirmed ||
                (assessment.outcome === 'tight' && !ack)
              }
            >
              <span className="paypal-word">PayPal</span>
              {state.config.paypal === 'sandbox'
                ? 'Continue to sandbox'
                : 'Start simulated checkout'}
              <ExternalLink size={15} />
            </Button>
          </div>
          <Footnote>
            {state.config.paypal === 'sandbox'
              ? 'Use a sandbox buyer. Approve in PayPal, then confirm payment here.'
              : 'No PayPal credentials are configured. This checkout is a labelled local simulation.'}
          </Footnote>
        </>
      )}
      {stage === 'payment' && purchase && (
        <div className="payment-result">
          {approvalNotice && !completed && (
            <div className="notice" role="status">
              {approvalNotice}
            </div>
          )}
          <span className={`payment-result-icon ${completed ? 'success' : ''}`}>
            {completed ? (
              <Check size={34} />
            ) : closed ? (
              <ArrowLeft size={30} />
            ) : (
              <CreditCard size={30} />
            )}
          </span>
          <Tag tone={completed ? 'green' : uncertain ? 'amber' : 'neutral'}>
            {purchase.mode === 'sandbox' ? 'PAYPAL SANDBOX' : 'LOCAL SIMULATION'} ·{' '}
            {purchase.status.toUpperCase()}
          </Tag>
          <h3>
            {completed
              ? 'All accounted for.'
              : closed
                ? 'No completed payment.'
                : uncertain
                  ? 'Let’s check where things stand.'
                  : 'Ready for your final confirmation.'}
          </h3>
          <p>
            {completed
              ? `${money(purchase.amountCents, true)} is now recorded once in your activity and included in your forecast.`
              : closed
                ? 'You can close this window and return to planning.'
                : uncertain
                  ? 'The payment is pending or its result is uncertain. This amount stays allocated while we check PayPal.'
                  : purchase.mode === 'sandbox'
                    ? 'If you approved this order in PayPal, confirm below to finish the sandbox payment.'
                    : 'This is a simulated payment. Confirm below to see how a completed purchase updates your plan.'}
          </p>
          <details className="receipt-details">
            <summary>Payment details</summary>
            <dl className="payment-details">
              <div>
                <dt>Item</dt>
                <dd>{purchase.name}</dd>
              </div>
              <div>
                <dt>Total USD</dt>
                <dd>{money(purchase.amountCents, true)}</dd>
              </div>
              {purchase.orderId && (
                <div>
                  <dt>Sandbox order</dt>
                  <dd className="mono">{purchase.orderId}</dd>
                </div>
              )}
              {purchase.captureId && (
                <div>
                  <dt>Capture</dt>
                  <dd className="mono">{purchase.captureId}</dd>
                </div>
              )}
            </dl>
          </details>
          {completed || closed ? (
            <Button onClick={onClose}>
              Back to my plan <ArrowRight size={16} />
            </Button>
          ) : (
            <>
              <Button loading={busy} onClick={capture}>
                {uncertain
                  ? 'Check payment status'
                  : purchase.mode === 'sandbox'
                    ? 'Confirm sandbox payment'
                    : 'Confirm simulated payment'}
                <ArrowRight size={15} />
              </Button>
              {purchase.mode === 'sandbox' && !uncertain && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    if (approvalUrl) location.assign(approvalUrl)
                    else void create()
                  }}
                >
                  Return to PayPal approval <ExternalLink size={14} />
                </Button>
              )}
              <button className="text-link" disabled={busy} onClick={cancel}>
                Cancel this checkout
              </button>
              <Footnote>
                Closing this window keeps the checkout available. A pending or uncertain payment
                stays reserved until verified.
              </Footnote>
            </>
          )}
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </Modal>
  )
}
function CalendarLabel({ date }: { date: string }) {
  return <strong>Buying today · {shortDate(date)}</strong>
}
