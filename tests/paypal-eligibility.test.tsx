// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useEligibility } from '../src/paypal'
import type { PayPalSdkInstance } from '../src/paypalSdk'

/** A fake SDK v6 instance whose Pay Later answer carries the given product and country. */
function instance(later: boolean, productCode?: string, countryCode?: string) {
  return {
    findEligibleMethods: async () => ({
      isEligible: (method: 'paypal' | 'paylater') => method === 'paypal' || later,
      getDetails: () => (productCode ? { productCode, countryCode } : undefined),
    }),
  } as unknown as PayPalSdkInstance
}
async function payIn4(sdk: PayPalSdkInstance) {
  const { result } = renderHook(() => useEligibility(sdk, 119900))
  await waitFor(() => expect(result.current.paypal).toBe('eligible'))
  return result.current.payIn4
}

describe('Pay in 4 from PayPal’s v6 eligibility answer', () => {
  it('reads PAY_LATER_SHORT_TERM in the US as Pay in 4', async () => {
    expect(await payIn4(instance(true, 'PAY_LATER_SHORT_TERM', 'US'))).toBe('eligible')
  })
  it('reads PayPal’s Pay Later no as unknown, as the store does', async () => {
    expect(await payIn4(instance(false))).toBe('unknown')
  })
  it('leaves PAYLATER, another country, a missing or unknown code as unknown', async () => {
    for (const sdk of [
      instance(true, 'PAYLATER', 'US'),
      instance(true, 'PAY_LATER_SHORT_TERM', 'GB'),
      instance(true),
      instance(true, 'PAY_IN_4', 'US'),
    ])
      expect(await payIn4(sdk)).toBe('unknown')
  })
})
