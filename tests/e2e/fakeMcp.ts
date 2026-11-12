import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * PayPal's MCP server for the E2E, enough of it for Connect PayPal: client registration, the code
 * and refresh grants (refresh tokens rotate, and only the newest is honoured, as live), and
 * list_transactions. The first read of a login returns the sandbox buyer's activity (redacted
 * fixture); every later read adds one new purchase, so a background sync has something to apply.
 */
const FIXTURE = readFileSync(
  resolve(import.meta.dirname, '../fixtures/paypal-mcp-activity.json'),
  'utf8',
)
const fixture = JSON.parse(FIXTURE) as { transaction_details: unknown[] }

export function fakeMcpFetch(): typeof fetch {
  let families = 0
  /** Per login: the access tokens it may use, its newest refresh token and how many reads it made. */
  const logins = new Map<number, { refresh: string; reads: number; issued: number }>()
  const byAccess = new Map<string, number>()
  const issue = (family: number) => {
    const login = logins.get(family)!
    login.issued++
    const access = `e2e-access-${family}-${login.issued}`
    login.refresh = `e2e-refresh-${family}-${login.issued}`
    byAccess.set(access, family)
    return Response.json({ access_token: access, refresh_token: login.refresh, expires_in: 3600 })
  }
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const body = typeof init.body === 'string' ? init.body : ''
    if (url.pathname === '/register')
      return Response.json({ client_id: 'e2e-client' }, { status: 201 })
    if (url.pathname === '/token') {
      const form = new URLSearchParams(body)
      if (form.get('grant_type') === 'authorization_code') {
        const family = ++families
        logins.set(family, { refresh: '', reads: 0, issued: 0 })
        return issue(family)
      }
      const family = [...logins].find(([, login]) => login.refresh === form.get('refresh_token'))
      return family ? issue(family[0]) : Response.json({ error: 'invalid_grant' }, { status: 400 })
    }
    const token = String((init.headers as Record<string, string>).Authorization ?? '').slice(7)
    const family = byAccess.get(token)
    if (family === undefined) return new Response('unauthorized', { status: 401 })
    if (init.method === 'DELETE') return new Response(null, { status: 200 })
    const message = JSON.parse(body) as {
      id?: number
      method: string
      params: { name?: string; arguments?: Record<string, string> }
    }
    if (message.method === 'initialize') {
      logins.get(family)!.reads++
      return Response.json(
        { jsonrpc: '2.0', id: message.id, result: {} },
        { headers: { 'mcp-session-id': `e2e-${family}` } },
      )
    }
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 })
    const { start_date: start = '', end_date: end = '' } = message.params.arguments ?? {}
    const later = logins.get(family)!.reads > 1
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    const rows = [
      ...(start <= '2026-10-03' && '2026-10-03' <= end ? fixture.transaction_details : []),
      ...(later && start <= yesterday && yesterday <= end
        ? [
            {
              transaction_info: {
                transaction_id: `E2ENEW${family}`,
                transaction_event_code: 'T0006',
                transaction_initiation_date: yesterday,
                transaction_amount: { currency_code: 'USD', value: '-12.00' },
                transaction_status: 'S',
                transaction_subject: 'Corner coffee',
              },
            },
          ]
        : []),
    ]
    const text = rows.length
      ? JSON.stringify({ transaction_details: rows, total_pages: 1 })
      : 'No transactions found for the given criteria.'
    return Response.json({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text }] },
    })
  }) as typeof fetch
}
