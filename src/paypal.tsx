import { useEffect, useRef, useState } from 'react'
import { payIn4Offer } from '../shared/payLater'
import { loadPayPalSdk, type PayPalSdkInstance } from './paypalSdk'

export type SdkStatus = 'off' | 'loading' | 'ready' | 'error'

/** Loads PayPal's SDK v6 once per client ID. 'off' when no sandbox client is configured. */
export function usePayPalSdk(clientId: string | undefined, enabled = true) {
  const [result, setResult] = useState<{
    clientId?: string
    instance?: PayPalSdkInstance
    status: SdkStatus
  }>({ status: 'off' })
  useEffect(() => {
    if (!clientId || !enabled) return
    let cancelled = false
    loadPayPalSdk(clientId).then(
      (instance) => !cancelled && setResult({ clientId, instance, status: 'ready' }),
      () => !cancelled && setResult({ clientId, status: 'error' }),
    )
    return () => {
      cancelled = true
    }
  }, [clientId, enabled])
  if (!clientId || !enabled) return { status: 'off' as SdkStatus, instance: undefined }
  if (result.clientId !== clientId) return { status: 'loading' as SdkStatus, instance: undefined }
  return { status: result.status, instance: result.instance }
}

export type Eligibility = 'eligible' | 'not-eligible' | 'unknown'

/** Asks PayPal, with this amount, whether the PayPal button and Pay in 4 are offered. */
export function useEligibility(instance: PayPalSdkInstance | undefined, amountCents: number) {
  const [state, setState] = useState<{
    key?: string
    paypal: Eligibility
    payIn4: Eligibility
  }>({ paypal: 'unknown', payIn4: 'unknown' })
  const key = instance ? String(amountCents) : undefined
  useEffect(() => {
    if (!instance || !key) return
    let cancelled = false
    instance
      .findEligibleMethods({ currencyCode: 'USD', amount: (amountCents / 100).toFixed(2) })
      .then((methods) => {
        if (cancelled) return
        // PayPal's v6 code for Pay in 4 is PAY_LATER_SHORT_TERM; PAYLATER doesn't say which product.
        // A no is unknown, as on the store: before the buyer logs in, PayPal's sandbox says no
        // even where PayPal Messages offers Pay in 4 for the same amount.
        setState({
          key,
          paypal: methods.isEligible('paypal') ? 'eligible' : 'not-eligible',
          payIn4: payIn4Offer(methods) ? 'eligible' : 'unknown',
        })
      })
      .catch(() => !cancelled && setState({ key, paypal: 'unknown', payIn4: 'unknown' }))
    return () => {
      cancelled = true
    }
  }, [instance, key, amountCents])
  return state.key === key
    ? state
    : { paypal: 'unknown' as Eligibility, payIn4: 'unknown' as Eligibility }
}

/**
 * PayPal Messages, the official component, unstyled. PayPal writes its own terms.
 * Pinned to the Pay in 4 offer: left alone, larger amounts get PayPal's monthly
 * financing message, which is not the plan Worth compares.
 */
export function PayPalMessage({
  instance,
  amountCents,
}: {
  instance: PayPalSdkInstance | undefined
  amountCents: number
}) {
  const ref = useRef<HTMLElement>(null)
  const booted = useRef(false)
  useEffect(() => {
    if (!instance?.createPayPalMessages || booted.current) return
    booted.current = true
    try {
      instance.createPayPalMessages()
    } catch {
      /* Messages are optional; the comparison stands without them. */
    }
  }, [instance])
  useEffect(() => {
    const element = ref.current as (HTMLElement & { amount?: string }) | null
    if (element) element.amount = (amountCents / 100).toFixed(2)
  }, [amountCents])
  if (!instance?.createPayPalMessages) return null
  return (
    <div className="pp-slot">
      <paypal-message
        ref={ref}
        auto-bootstrap="true"
        amount={(amountCents / 100).toFixed(2)}
        currency-code="USD"
        offer-types="PAY_LATER_SHORT_TERM"
      />
    </div>
  )
}

/** The official SDK v6 PayPal button. Worth never draws one of its own. */
export function PayPalButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="pp-button-slot">
      <paypal-button type="pay" onClick={onClick} />
    </div>
  )
}
