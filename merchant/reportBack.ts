import { retryDelay } from '../server/paypal.ts'
import type { Handoff, OutcomeBody } from './handoff-stub.ts'

/** Contract §5: two retries after the first attempt, each attempt limited to five seconds. */
export const REPORT_RETRIES = 2
export const REPORT_TIMEOUT_MS = 5_000

export interface ReportOptions {
  worthOrigin: string
  handoff: Pick<Handoff, 'signOutcome'>
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** Receives outcomes and failures; never the token, body or signature. */
  log?: (event: Record<string, unknown>) => void
  timeoutMs?: number
}

export type ReportResult = 'sent' | 'rejected' | 'failed'

/**
 * Sends one signed report-back to Worth. A 429, 5xx, timeout or network failure is retried with
 * the PayPal gateway's backoff, re-signed each time so the timestamp stays fresh; other answers
 * are final. It never throws: a failed report must never touch the shopper's checkout, and Worth
 * is idempotent on captureId, so the capture and webhook paths can both send.
 */
export async function reportOutcome(
  body: OutcomeBody,
  options: ReportOptions,
): Promise<ReportResult> {
  const http = options.fetch ?? fetch
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const log =
    options.log ?? ((event: Record<string, unknown>) => console.warn('Report-back:', event))
  const url = `${options.worthOrigin}/api/handoff/outcome`
  for (let attempt = 0; ; attempt++) {
    let status = 0
    try {
      const signed = options.handoff.signOutcome(body)
      const response = await http(url, {
        method: 'POST',
        headers: signed.headers,
        body: signed.body,
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs ?? REPORT_TIMEOUT_MS),
      })
      status = response.status
      // The answer is not needed; draining it frees the connection.
      await response.body?.cancel().catch(() => undefined)
      if (response.ok) {
        log({ event: 'report_sent', captureId: body.captureId, attempt })
        return 'sent'
      }
      if (status !== 429 && status < 500) {
        log({ event: 'report_rejected', captureId: body.captureId, status })
        return 'rejected'
      }
    } catch (error) {
      status = 0
      log({
        event: 'report_transport_error',
        captureId: body.captureId,
        attempt,
        issue:
          error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR',
      })
    }
    if (attempt >= REPORT_RETRIES) {
      log({ event: 'report_failed', captureId: body.captureId, status })
      return 'failed'
    }
    await sleep(retryDelay(attempt + 1, null))
  }
}
