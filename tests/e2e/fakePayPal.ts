import {
  PayPalError,
  type OrderSource,
  type PayPalGateway,
  type PayPalOrder,
} from '../../server/paypal.ts'

/**
 * The store server's PayPal for the two-origin E2E, so CI needs no sandbox credentials: orders are
 * created and captured in memory, at the amount the store asked for. The browser's half is
 * PAYPAL_SDK_STUB in fixtures.ts. Everything between them (the store's order routes, its capture
 * check and its report-back to Worth) is the real code.
 */
export function fakePayPalGateway(): PayPalGateway {
  const orders = new Map<string, { source: OrderSource; captureId?: string; capturedAt?: string }>()
  let count = 0
  const view = (id: string): PayPalOrder => {
    const order = orders.get(id)
    if (!order) throw new PayPalError(404, 'RESOURCE_NOT_FOUND')
    const value = (order.source.amountCents / 100).toFixed(2)
    return {
      id,
      status: order.captureId ? 'COMPLETED' : 'PAYER_ACTION_REQUIRED',
      purchase_units: [
        {
          reference_id: order.source.id,
          custom_id: order.source.id,
          amount: { currency_code: 'USD', value },
          payee: { merchant_id: 'LARKSPURE2E' },
          ...(order.captureId
            ? {
                payments: {
                  captures: [
                    {
                      id: order.captureId,
                      status: 'COMPLETED',
                      amount: { currency_code: 'USD', value },
                      create_time: order.capturedAt,
                    },
                  ],
                },
              }
            : {}),
        },
      ],
    }
  }
  return {
    async create(source) {
      const id = `E2E-ORDER-${++count}`
      orders.set(id, { source })
      return view(id)
    },
    async capture(orderId) {
      const order = orders.get(orderId)
      if (order && !order.captureId) {
        order.captureId = orderId.replace('ORDER', 'CAPTURE')
        order.capturedAt = new Date().toISOString()
      }
      return view(orderId)
    },
    async get(orderId) {
      return view(orderId)
    },
    async getRefund() {
      throw new PayPalError(404, 'RESOURCE_NOT_FOUND')
    },
    // Lets a test redeliver PAYMENT.CAPTURE.COMPLETED for an order this fake captured.
    async verify() {
      return true
    },
    async eligibility() {
      return { payLater: true }
    },
  }
}
