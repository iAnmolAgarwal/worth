import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../server/app.ts'
import { loadConfig } from '../server/config.ts'
import {
  activityCsv,
  ALLOWED_TOOLS,
  ConnectError,
  createPayPalConnect,
  eventType,
  MCP_ORIGIN,
} from '../server/paypalConnect.ts'
import type { TransactionInfo } from '../server/paypalConnect.ts'
import { Store } from '../server/store.ts'
import { databaseVault, memoryVault, openLink, sealLink, tokenKey } from '../server/paypalVault.ts'
import { parsePayPalCsv } from '../shared/csv.ts'
import { CSV_IMPORT_LIMITS, utf8Bytes } from '../shared/limits.ts'

// Connect PayPal (server/paypalConnect.ts). The MCP server is a fake: no test touches the network.
// The fixture is the shape of a real sandbox buyer's list_transactions reply, with made-up IDs.

const FIXTURE = readFileSync(
  new URL('./fixtures/paypal-mcp-activity.json', import.meta.url),
  'utf8',
)
const ROWS = (
  JSON.parse(FIXTURE) as { transaction_details: { transaction_info: TransactionInfo }[] }
).transaction_details.map((item) => item.transaction_info)
const ORIGIN = 'http://localhost:5173'
const CALLBACK = `${ORIGIN}/api/paypal/connect/callback`
const TOKEN = 'tok-SECRET-access-0123456789'
const REFRESH = 'refresh-SECRET-xyz'
const CODE = 'code-SECRET-abc'

const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  vi.useRealTimers()
})

interface FakeOptions {
  /** initialize never answers (until the request is aborted). */
  hang?: boolean
  /** What list_transactions answers; the first window gets the fixture by default. */
  list?: (args: Record<string, unknown>, call: number) => string
  /** How the token endpoint answers a refresh: rotate (default), refuse (400) or be down (503). */
  refresh?: 'rotate' | 'refuse' | 'down'
  /** How it answers a revocation (RFC 7009): 200 (default) or down (503). */
  revoke?: 'ok' | 'down'
}
/** PayPal's MCP server, enough of it: registration, PKCE-checked token, and JSON-RPC over /mcp. */
function fakeMcp(options: FakeOptions = {}) {
  let challenge = ''
  let listCalls = 0
  const tools: string[] = []
  const bodies: string[] = []
  /** Access tokens the MCP server accepts, and the one refresh token it honours (rotated). */
  const access = new Set<string>()
  let refresh = REFRESH
  let issued = 0
  const grants: string[] = []
  const revoked: string[] = []
  /** While set, list_transactions waits for it: a read held mid-flight. */
  let hold: Promise<void> | undefined
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    expect(url.origin).toBe(MCP_ORIGIN)
    const body = typeof init.body === 'string' ? init.body : ''
    bodies.push(body)
    if (url.pathname === '/register') {
      expect(JSON.parse(body).redirect_uris).toEqual([CALLBACK])
      return Response.json({ client_id: 'client-1' }, { status: 201 })
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(body)
      if (form.get('token_type_hint') === 'refresh_token' && !form.has('grant_type')) {
        revoked.push(form.get('token') ?? '')
        expect(form.get('client_id')).toBe('client-1')
        return options.revoke === 'down'
          ? new Response('unavailable', { status: 503 })
          : new Response('', { status: 200 })
      }
      grants.push(form.get('grant_type') ?? '')
      if (form.get('grant_type') === 'refresh_token') {
        if (options.refresh === 'down') return new Response('unavailable', { status: 503 })
        if (form.get('client_id') !== 'client-1')
          return Response.json({ error: 'invalid_client' }, { status: 401 })
        if (options.refresh === 'refuse' || form.get('refresh_token') !== refresh)
          return Response.json(
            { error: 'invalid_grant', error_description: 'Invalid refresh token' },
            { status: 400 },
          )
        issued++
        const token = `tok-SECRET-refreshed-${issued}`
        access.add(token)
        refresh = `refresh-SECRET-${issued}`
        return Response.json({ access_token: token, refresh_token: refresh, expires_in: 3600 })
      }
      const verifier = form.get('code_verifier') ?? ''
      const ok =
        form.get('code') === CODE &&
        form.get('redirect_uri') === CALLBACK &&
        createHash('sha256').update(verifier).digest('base64url') === challenge
      if (ok) access.add(TOKEN)
      return ok
        ? Response.json({ access_token: TOKEN, refresh_token: REFRESH, expires_in: 3600 })
        : Response.json({ error: 'invalid_grant' }, { status: 400 })
    }
    if (url.pathname === '/mcp') {
      const bearer = (init.headers as Record<string, string>).Authorization?.replace(/^Bearer /, '')
      if (!access.has(bearer ?? '')) return new Response('unauthorized', { status: 401 })
      if (init.method === 'DELETE') return new Response(null, { status: 200 })
      const message = JSON.parse(body) as {
        id?: number
        method: string
        params: { name?: string; arguments?: Record<string, unknown> }
      }
      if (message.method === 'initialize') {
        if (options.hang)
          return new Promise<Response>((_resolve, reject) =>
            init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
          )
        return new Response(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n\n`,
          { headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'mcp-1' } },
        )
      }
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 })
      if (message.method === 'tools/call') {
        tools.push(message.params.name!)
        if (hold) await hold
        const call = listCalls++
        const text = options.list
          ? options.list(message.params.arguments!, call)
          : message.params.arguments!.end_date === undefined || call !== 1
            ? 'No transactions found for the given criteria.'
            : FIXTURE
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text }] },
        })
      }
    }
    return new Response('not found', { status: 404 })
  })
  return {
    fetch,
    tools,
    bodies,
    grants,
    access,
    revoked,
    /** Holds every list_transactions call until the returned function is called. */
    holdReads: () => {
      let release!: () => void
      hold = new Promise<void>((done) => (release = done))
      return () => {
        hold = undefined
        release()
      }
    },
    /** The refresh token the server would honour now. */
    refreshToken: () => refresh,
    /** PayPal stops accepting every access token issued so far (a revocation, or an early expiry). */
    revokeAccess: () => access.clear(),
    setChallenge: (value: string) => (challenge = value),
  }
}

function setup(
  fake = fakeMcp(),
  { key, ...extra }: { sessionTimeoutMs?: number; key?: Buffer } = {},
) {
  const store = new Store(':memory:')
  stores.push(store)
  const logs: Record<string, unknown>[] = []
  /** The servers' clock, moved by tests to let an access token lapse. */
  const clock = { t: Date.parse('2026-11-12T06:00:00Z') }
  const connect = createPayPalConnect({
    origin: ORIGIN,
    enabled: true,
    fetch: fake.fetch as unknown as typeof fetch,
    log: (event) => logs.push(event),
    now: () => clock.t,
    ...(key ? { vault: databaseVault(store.db, key) } : {}),
    ...extra,
  })
  const app = createApp({
    store,
    config: {
      production: false,
      origin: ORIGIN,
      paypalClientId: undefined,
      paypalSecret: undefined,
    },
    paypalConnect: connect,
    now: () => new Date(clock.t),
  })
  return { app, agent: request.agent(app), connect, logs, fake, clock, store }
}

/** Starts a login and returns the state PayPal would send back, as the fake server saw it. */
async function startLogin(
  agent: ReturnType<typeof request.agent>,
  fake: ReturnType<typeof fakeMcp>,
) {
  const start = await agent.get('/api/paypal/connect')
  expect(start.status).toBe(303)
  const url = new URL(start.headers.location!)
  fake.setChallenge(url.searchParams.get('code_challenge')!)
  return { url, state: url.searchParams.get('state')! }
}

const post = (agent: ReturnType<typeof request.agent>, path: string) =>
  agent.post(path).set('X-Worth-Client', 'web').send({})

describe('PayPal activity as an export', () => {
  it('maps event codes to export types, with Pay Later funding for T1600', () => {
    expect(eventType('T1600')).toEqual({ type: 'Pay Later Funding', label: 'PayPal Pay Later' })
    expect(eventType('T0300').type).toBe('Bank Deposit to PP Account')
    expect(eventType('T0006').type).toBe('Express Checkout Payment')
    expect(eventType('T1107').type).toBe('Payment Refund')
    expect(eventType('T1900').type).toBe('Account Correction')
    expect(eventType('T0002').type).toBe('Subscription Payment')
    expect(eventType('T9999')).toEqual({
      type: 'PayPal Activity',
      label: 'PayPal activity (T9999)',
    })
    expect(eventType(undefined).label).toBe('PayPal activity')
  })

  it('reads a real sandbox buyer’s rows through the CSV import, with the Pay in 4 purchase found', () => {
    const { csv, summary } = activityCsv(ROWS, 'America/New_York')
    expect(summary).toMatchObject({
      transactions: 39,
      first: '2026-09-30',
      last: '2026-10-03',
      skipped: 0,
      truncated: false,
    })
    const preview = parsePayPalCsv(csv, [], { today: '2026-11-12' })
    expect(preview.errors).toEqual([])
    expect(preview.needsDateOrder).toBe(false)
    // The $1,199 purchase PayPal's buyer credit paid for (T1600) is one proposed plan.
    expect(preview.instalmentPlans).toMatchObject([
      { name: 'Spike S1 camera', purchaseCents: 119900, paymentCents: 29975 },
    ])
    expect(preview.instalmentPlans[0]!.transactionIds).toHaveLength(2)
    const byKind = (kind: string) => preview.transactions.filter((t) => t.kind === kind).length
    expect(byKind('installment')).toBe(2)
    expect(byKind('adjustment')).toBe(1)
    expect(preview.transactions.find((t) => t.name === 'Initial balance')?.kind).toBe('adjustment')
    // Bank funding legs are transfers, never income.
    expect(byKind('income')).toBe(0)
    expect(preview.transactions.some((t) => t.status === 'excluded')).toBe(true)
    // No email address or token-like value can come from these rows.
    expect(csv).not.toMatch(/@/)
  })

  it('names Pay Later rows by their event, so a repayment never becomes a plan of its own', () => {
    const repayment: TransactionInfo = {
      transaction_id: 'TX900000000000001',
      transaction_event_code: 'T1800',
      transaction_initiation_date: '2026-10-17T13:55:09Z',
      transaction_amount: { currency_code: 'USD', value: '-299.75' },
      transaction_status: 'S',
      transaction_subject: 'Spike S1 camera',
    }
    const { csv } = activityCsv([...ROWS, repayment], 'America/New_York')
    expect(csv).toContain('"PayPal Pay Later","Pay Later Payment"')
    const plans = parsePayPalCsv(csv, [], { today: '2026-11-12' }).instalmentPlans
    // One plan, the camera, with the repayment as its first payment.
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ name: 'Spike S1 camera', purchaseCents: 119900 })
    expect(plans[0]!.payments).toEqual([
      { date: '2026-10-17', amountCents: 29975, status: 'completed' },
    ])
  })

  it('writes the personal export’s headers, ISO dates and the plan’s local time', () => {
    const { csv } = activityCsv(
      [
        {
          transaction_id: 'A1',
          transaction_event_code: 'T0006',
          transaction_initiation_date: '2026-10-03T13:55:09+0000',
          transaction_amount: { currency_code: 'USD', value: '-1199.00' },
          fee_amount: { currency_code: 'USD', value: '-0.50' },
          transaction_status: 'S',
          transaction_subject: 'Camera "pro"\nmodel',
        },
      ],
      'Asia/Kolkata',
    )
    const [header, row] = csv.split('\n')
    expect(header).toBe(
      '"Date","Time","TimeZone","Name","Type","Status","Currency","Net","Transaction ID","Reference Txn ID","Balance"',
    )
    expect(row).toBe(
      '"2026-10-03","19:25:09","Asia/Kolkata","Camera ""pro"" model","Express Checkout Payment","Completed","USD","-1199.50","A1","",""',
    )
  })

  it('names rows without a subject by their event, and never reads an unknown status as completed', () => {
    const { csv } = activityCsv(
      [
        {
          transaction_id: 'B1',
          transaction_event_code: 'T0300',
          transaction_initiation_date: '2026-10-01T10:00:00Z',
          transaction_amount: { currency_code: 'usd', value: '20.00' },
          transaction_status: 'X',
        },
      ],
      'UTC',
    )
    const preview = parsePayPalCsv(csv, [], { today: '2026-11-12' })
    expect(preview.transactions[0]).toMatchObject({
      name: 'Bank deposit to PayPal',
      currency: 'USD',
      status: 'excluded',
    })
  })

  it('skips rows with an unreadable date, amount or currency, and counts them', () => {
    const good: TransactionInfo = {
      transaction_id: 'C1',
      transaction_event_code: 'T0006',
      transaction_initiation_date: '2026-10-01T10:00:00Z',
      transaction_amount: { currency_code: 'USD', value: '-5.00' },
      transaction_status: 'S',
    }
    const { summary } = activityCsv(
      [
        good,
        { ...good, transaction_initiation_date: 'yesterday' },
        { ...good, transaction_amount: { currency_code: 'USD', value: '1e9' } },
        { ...good, transaction_amount: { currency_code: 'DOLLARS', value: '-5.00' } },
      ],
      'UTC',
    )
    expect(summary).toMatchObject({ transactions: 1, skipped: 3 })
  })

  it('gives a reversal listed under the ID it reverses an ID of its own', () => {
    const base = {
      transaction_initiation_date: '2026-10-04T01:54:23Z',
      transaction_status: 'P',
    }
    const { csv } = activityCsv(
      [
        {
          ...base,
          transaction_id: 'W1',
          transaction_event_code: 'T0403',
          transaction_amount: { currency_code: 'USD', value: '-10.00' },
        },
        {
          ...base,
          transaction_id: 'W1',
          transaction_event_code: 'T1101',
          transaction_amount: { currency_code: 'USD', value: '10.00' },
          transaction_status: 'D',
        },
      ],
      'UTC',
    )
    expect(csv).toContain('"W1",""')
    expect(csv).toContain('"W1-T1101"')
    expect(parsePayPalCsv(csv, [], { today: '2026-11-12' }).errors).toEqual([])
  })

  it('keeps the newest rows within the import’s size and row limits', () => {
    const rows = Array.from(
      { length: CSV_IMPORT_LIMITS.maxRows + 5 },
      (_, index): TransactionInfo => ({
        transaction_id: `R${index}`,
        transaction_event_code: 'T0006',
        transaction_initiation_date: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
        transaction_amount: { currency_code: 'USD', value: '-1.00' },
        transaction_status: 'S',
      }),
    )
    const { csv, summary } = activityCsv(rows, 'UTC')
    expect(summary.truncated).toBe(true)
    expect(summary.transactions).toBeLessThanOrEqual(CSV_IMPORT_LIMITS.maxRows)
    expect(utf8Bytes(csv)).toBeLessThanOrEqual(CSV_IMPORT_LIMITS.maxBytes)
    expect(parsePayPalCsv(csv, [], { today: '2026-11-12' }).errors).toEqual([])
    expect(csv).toContain(`"R${CSV_IMPORT_LIMITS.maxRows + 4}"`)
    expect(csv).not.toContain('"R0"')
  })
})

describe('Connect PayPal login', () => {
  it('starts with PKCE (S256) and a state bound to the session, and registers the callback', async () => {
    const { agent, fake } = setup()
    const { url, state } = await startLogin(agent, fake)
    expect(url.origin + url.pathname).toBe(`${MCP_ORIGIN}/authorize`)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'client-1',
      redirect_uri: CALLBACK,
      code_challenge_method: 'S256',
    })
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // The verifier itself never leaves the server.
    expect(url.search).not.toContain('code_verifier')
  })

  it('completes for the session that started it, and stays connected without exposing a token', async () => {
    const { agent, fake, logs } = setup()
    const { state } = await startLogin(agent, fake)
    const back = await agent.get(`/api/paypal/connect/callback?code=${CODE}&state=${state}`)
    expect(back.status).toBe(303)
    expect(back.headers.location).toBe('/#import?connect=paypal')
    expect(back.headers['referrer-policy']).toBe('no-referrer')

    const read = await post(agent, '/api/paypal/activity')
    expect(read.status).toBe(200)
    expect(read.body.summary).toMatchObject({ transactions: 39, searchedDays: 186 })
    expect(parsePayPalCsv(read.body.csv, [], { today: '2026-11-12' }).instalmentPlans).toHaveLength(
      1,
    )
    // Only the allow-listed tool was ever called, once per 31-day window.
    expect(new Set(fake.tools)).toEqual(new Set(['list_transactions']))
    expect(fake.tools).toHaveLength(6)

    // Connected: a second read needs no login, and still only lists transactions.
    const again = await post(agent, '/api/paypal/activity')
    expect(again.status).toBe(200)
    expect(new Set(fake.tools)).toEqual(new Set(['list_transactions']))
    expect((await agent.get('/api/state')).body.config.paypalLinked).toBe(true)

    // No secret in any response, header or log line.
    for (const response of [back, read, again]) {
      const seen = JSON.stringify({
        body: response.body,
        text: response.text,
        headers: response.headers,
      })
      for (const secret of [TOKEN, REFRESH, CODE]) expect(seen).not.toContain(secret)
    }
    const logged = JSON.stringify(logs)
    for (const secret of [TOKEN, REFRESH, CODE, state]) expect(logged).not.toContain(secret)
  })

  it('marks an import of exactly the connected activity as from PayPal, any other file not', async () => {
    const { agent, fake } = setup()
    const { state } = await startLogin(agent, fake)
    await agent.get(`/api/paypal/connect/callback?code=${CODE}&state=${state}`)
    const read = await post(agent, '/api/paypal/activity')
    const header = { 'X-Worth-Client': 'web' }
    const own = await agent.post('/api/import/commit').set(header).send({ csv: read.body.csv })
    expect(own.status).toBe(200)
    expect(own.body.profile).toMatchObject({ source: 'import', importedFrom: 'paypal' })
    expect(Date.parse(own.body.profile.importedAt)).not.toBeNaN()
    // The profile's own save keeps the server's word, whatever the client sends.
    const saved = await agent
      .patch('/api/profile')
      .set(header)
      .send({ profile: { ...own.body.profile, importedFrom: 'file' } })
    expect(saved.body.profile.importedFrom).toBe('paypal')
    // Any other file, even one edited by a single character, is a file.
    const edited = read.body.csv.replace(/\n$/, '') + '\n'
    const other = await agent
      .post('/api/import/commit')
      .set(header)
      .send({ csv: edited === read.body.csv ? `${edited} ` : edited })
    expect(other.body.profile.importedFrom).toBe('file')
  })

  it('refuses a callback from another session, and the state is single-use', async () => {
    const { app, agent, fake } = setup()
    const { state } = await startLogin(agent, fake)
    const other = request.agent(app)
    await other.get('/api/state')
    const stolen = await other.get(`/api/paypal/connect/callback?code=${CODE}&state=${state}`)
    expect(stolen.headers.location).toBe('/#import?connect=expired')
    // The attempt used the state up: the rightful session must log in again.
    const late = await agent.get(`/api/paypal/connect/callback?code=${CODE}&state=${state}`)
    expect(late.headers.location).toBe('/#import?connect=expired')
    expect(fake.fetch.mock.calls.some(([url]) => String(url).endsWith('/token'))).toBe(false)
    expect((await post(other, '/api/paypal/activity')).body.code).toBe('NOT_CONNECTED')
  })

  it('refuses an unknown or malformed state and a wrong PKCE verifier', async () => {
    const { agent, fake } = setup()
    await startLogin(agent, fake)
    for (const query of ['state=nope', `state=${'a'.repeat(43)}`, 'code=x'])
      expect((await agent.get(`/api/paypal/connect/callback?${query}`)).headers.location).toBe(
        '/#import?connect=expired',
      )
    const { state } = await startLogin(agent, fake)
    fake.setChallenge('a-different-challenge')
    const back = await agent.get(`/api/paypal/connect/callback?code=${CODE}&state=${state}`)
    expect(back.headers.location).toBe('/#import?connect=failed')
  })

  it('says so plainly when the user declines at PayPal', async () => {
    const { agent, fake } = setup()
    const { state } = await startLogin(agent, fake)
    const back = await agent.get(
      `/api/paypal/connect/callback?error=access_denied&error_description=%3Cscript%3E&state=${state}`,
    )
    expect(back.headers.location).toBe('/#import?connect=denied')
  })

  it('never starts a login from another site', async () => {
    const { agent, fake } = setup()
    const start = await agent.get('/api/paypal/connect').set('Sec-Fetch-Site', 'cross-site')
    expect(start.headers.location).toBe('/#import?connect=failed')
    expect(fake.fetch).not.toHaveBeenCalled()
  })

  it('counts a login once, so a shared network gets 60 an hour', async () => {
    const { app, fake } = setup()
    for (let visitor = 0; visitor < 6; visitor++) {
      const agent = request.agent(app)
      for (let index = 0; index < 10; index++) {
        const { url, state } = await startLogin(agent, fake)
        expect(url.origin).toBe(MCP_ORIGIN)
        await agent.get(`/api/paypal/connect/callback?error=access_denied&state=${state}`)
      }
    }
    const late = request.agent(app)
    expect((await late.get('/api/paypal/connect')).headers.location).toBe('/#import?connect=failed')
  })

  it('limits logins per session', async () => {
    const { agent, fake } = setup()
    for (let index = 0; index < 10; index++) await startLogin(agent, fake)
    expect((await agent.get('/api/paypal/connect')).headers.location).toBe(
      '/#import?connect=failed',
    )
  })

  it('turns PayPal failures into plain messages and keeps the token for a retry', async () => {
    const fake = fakeMcp({ list: () => JSON.stringify({ ok: false, status: 500, debug: 'x' }) })
    const { agent } = setup(fake)
    const { state } = await startLogin(agent, fake)
    await agent.get(`/api/paypal/connect/callback?code=${CODE}&state=${state}`)
    const read = await post(agent, '/api/paypal/activity')
    expect(read.status).toBe(502)
    expect(read.body).toEqual({
      error: 'PayPal couldn’t return your activity just now. Try again, or use a CSV export.',
      code: 'MCP_FAILED',
    })
    expect((await post(agent, '/api/paypal/activity')).status).toBe(502)
  })

  it('gates only the visitor after one slow session start, and everyone briefly after two', async () => {
    const fake = fakeMcp({ hang: true })
    const { app, agent } = setup(fake, { sessionTimeoutMs: 30 })
    const { state } = await startLogin(agent, fake)
    await agent.get(`/api/paypal/connect/callback?code=${CODE}&state=${state}`)
    const read = await post(agent, '/api/paypal/activity')
    expect(read.status).toBe(503)
    expect(read.body.code).toBe('MCP_TIMEOUT')
    // The visitor's browser hides Connect; everyone else still sees it.
    expect((await agent.get('/api/health')).body.paypalConnect).toBe('on')
    const other = request.agent(app)
    const second = await startLogin(other, fake)
    await other.get(`/api/paypal/connect/callback?code=${CODE}&state=${second.state}`)
    expect((await post(other, '/api/paypal/activity')).body.code).toBe('MCP_TIMEOUT')
    expect((await agent.get('/api/health')).body.paypalConnect).toBe('unavailable')
    expect((await agent.get('/api/state')).body.config.paypalConnect).toBe('unavailable')
  })
})

describe('The tool allow-list', () => {
  it('allows list_transactions only', () => {
    expect([...ALLOWED_TOOLS]).toEqual(['list_transactions'])
  })
  it.each([
    'create_invoice',
    'send_invoice',
    'list_invoices',
    'list_disputes',
    'LIST_TRANSACTIONS',
  ])('refuses %s before any request', async (tool) => {
    const fake = fakeMcp()
    const connect = createPayPalConnect({
      origin: ORIGIN,
      enabled: true,
      fetch: fake.fetch as unknown as typeof fetch,
      log: () => {},
    })
    const call = connect.callTool(TOKEN, 'mcp-1', tool, {})
    await expect(call).rejects.toBeInstanceOf(ConnectError)
    await expect(call).rejects.toMatchObject({ code: 'TOOL_REFUSED' })
    expect(fake.fetch).not.toHaveBeenCalled()
  })
})

describe('PAYPAL_CONNECT', () => {
  it('defaults to on with the sandbox client ID, and off without it', () => {
    expect(loadConfig({ PAYPAL_CLIENT_ID: 'sandbox-id' }).paypalConnect).toBe(true)
    expect(loadConfig({}).paypalConnect).toBe(false)
    expect(
      loadConfig({ PAYPAL_CLIENT_ID: 'sandbox-id', PAYPAL_CONNECT: 'off' }).paypalConnect,
    ).toBe(false)
    expect(() => loadConfig({ PAYPAL_CONNECT: 'yes' })).toThrow(/PAYPAL_CONNECT must be on or off/)
  })

  it('off: no button, no login, no read, and health says so', async () => {
    const store = new Store(':memory:')
    stores.push(store)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    try {
      const app = createApp({
        store,
        config: {
          production: false,
          origin: ORIGIN,
          paypalClientId: undefined,
          paypalConnect: false,
        },
      })
      const agent = request.agent(app)
      expect((await agent.get('/api/health')).body.paypalConnect).toBe('off')
      expect((await agent.get('/api/state')).body.config.paypalConnect).toBe('off')
      expect((await agent.get('/api/paypal/connect')).headers.location).toBe('/#import?connect=off')
      expect(
        (await agent.get(`/api/paypal/connect/callback?code=${CODE}&state=x`)).headers.location,
      ).toBe('/#import?connect=off')
      const read = await post(agent, '/api/paypal/activity')
      expect(read.status).toBe(404)
      expect(read.body.code).toBe('PAYPAL_CONNECT_OFF')
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('Keeping PayPal connected: the refresh-token vault', () => {
  const KEY = Buffer.alloc(32, 7)
  const link = { clientId: 'client-1', refreshToken: REFRESH }

  it('seals a link so nothing of the token shows, and opens it only for its own session and key', () => {
    const sealed = sealLink(KEY, 'session-a', link)
    expect(sealed).not.toContain(REFRESH)
    expect(sealed).not.toContain('client-1')
    expect(openLink(KEY, 'session-a', sealed)).toEqual(link)
    // A fresh IV every time.
    expect(sealLink(KEY, 'session-a', link)).not.toBe(sealed)
    expect(openLink(KEY, 'session-b', sealed)).toBeUndefined()
    expect(openLink(Buffer.alloc(32, 8), 'session-a', sealed)).toBeUndefined()
    // Any altered part fails authentication.
    const parts = sealed.split('.')
    for (const index of [1, 2, 3]) {
      const changed = [...parts]
      const value = changed[index]!
      changed[index] = `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`
      expect(openLink(KEY, 'session-a', changed.join('.'))).toBeUndefined()
    }
    expect(openLink(KEY, 'session-a', 'v0.x.y.z')).toBeUndefined()
  })

  it('takes PAYPAL_TOKEN_KEY only as 32 bytes of base64', () => {
    const key = Buffer.alloc(32, 1)
    expect(tokenKey(key.toString('base64'))).toEqual(key)
    expect(tokenKey(key.toString('base64url'))).toEqual(key)
    expect(tokenKey(Buffer.alloc(16).toString('base64'))).toBeUndefined()
    expect(tokenKey('not a key')).toBeUndefined()
    expect(() => loadConfig({ PAYPAL_TOKEN_KEY: 'short' })).toThrow(/PAYPAL_TOKEN_KEY/)
    expect(loadConfig({ PAYPAL_TOKEN_KEY: key.toString('base64') }).paypalTokenKey).toBeTruthy()
  })

  it('stores only the sealed link with the session, and deletes it with the session', () => {
    const store = new Store(':memory:')
    stores.push(store)
    const id = store.create({} as never)
    const vault = databaseVault(store.db, KEY)
    vault.set(id, link)
    const rows = store.db.prepare('SELECT * FROM paypal_links').all()
    expect(JSON.stringify(rows)).not.toContain(REFRESH)
    expect(vault.get(id)).toEqual(link)
    store.delete(id)
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM paypal_links').get()).toEqual({ n: 0 })
  })

  it('keeps links in memory only without a key, oldest dropped past the cap', () => {
    const vault = memoryVault(2)
    vault.set('a', link)
    vault.set('b', link)
    vault.set('c', link)
    expect([vault.get('a'), vault.get('b'), vault.get('c')]).toEqual([undefined, link, link])
    vault.delete('b')
    expect(vault.get('b')).toBeUndefined()
  })
})

describe('Keeping PayPal connected: reads without a login', () => {
  const KEY = Buffer.alloc(32, 9)
  const HOUR = 60 * 60_000
  async function connected(fake = fakeMcp(), key: Buffer | undefined = KEY) {
    const context = setup(fake, key ? { key } : {})
    const { state } = await startLogin(context.agent, fake)
    await context.agent.get(`/api/paypal/connect/callback?code=${CODE}&state=${state}`)
    return context
  }

  it('refreshes the access token once it lapses, keeping only the newest refresh token', async () => {
    const fake = fakeMcp()
    const { agent, clock, store, logs } = await connected(fake)
    expect((await post(agent, '/api/paypal/activity')).status).toBe(200)
    expect(fake.grants).toEqual(['authorization_code'])
    clock.t += HOUR
    const second = await post(agent, '/api/paypal/activity')
    expect(second.status).toBe(200)
    expect(fake.grants).toEqual(['authorization_code', 'refresh_token'])
    // PayPal honours only the newest refresh token: a second refresh works only if Worth kept it.
    clock.t += HOUR
    expect((await post(agent, '/api/paypal/activity')).status).toBe(200)
    expect(fake.grants).toEqual(['authorization_code', 'refresh_token', 'refresh_token'])
    const stored = JSON.stringify(store.db.prepare('SELECT * FROM paypal_links').all())
    const seen = JSON.stringify({ second: second.body, logs })
    for (const secret of [REFRESH, 'refresh-SECRET-1', 'refresh-SECRET-2', fake.refreshToken()]) {
      expect(stored).not.toContain(secret)
      expect(seen).not.toContain(secret)
    }
    for (const token of fake.access) expect(seen).not.toContain(token)
  })

  it('refreshes once when PayPal turns a held access token down', async () => {
    const fake = fakeMcp()
    const { agent } = await connected(fake)
    expect((await post(agent, '/api/paypal/activity')).status).toBe(200)
    fake.revokeAccess()
    expect((await post(agent, '/api/paypal/activity')).status).toBe(200)
    expect(fake.grants.at(-1)).toBe('refresh_token')
  })

  it('returns to not connected when PayPal refuses the refresh token, leaving the plan as it is', async () => {
    const fake = fakeMcp({ refresh: 'refuse' })
    const { agent, clock } = await connected(fake)
    const before = (await agent.get('/api/state')).body.profile
    clock.t += HOUR
    const read = await post(agent, '/api/paypal/activity')
    expect(read.status).toBe(409)
    expect(read.body.code).toBe('NOT_CONNECTED')
    const after = (await agent.get('/api/state')).body
    expect(after.config.paypalLinked).toBeUndefined()
    expect(after.profile).toEqual(before)
    // The link is gone: no further refresh is attempted.
    const grants = fake.grants.length
    expect((await post(agent, '/api/paypal/sync')).body.code).toBe('NOT_CONNECTED')
    expect(fake.grants).toHaveLength(grants)
  })

  it('keeps the link through a network failure, for a later visit', async () => {
    const fake = fakeMcp({ refresh: 'down' })
    const { agent, clock } = await connected(fake)
    clock.t += HOUR
    const read = await post(agent, '/api/paypal/activity')
    expect(read.status).toBe(502)
    expect(read.body.code).toBe('MCP_FAILED')
    expect((await agent.get('/api/state')).body.config.paypalLinked).toBe(true)
  })

  it('never calls another tool with a refreshed token', async () => {
    const fake = fakeMcp()
    const { agent, clock, connect } = await connected(fake)
    clock.t += HOUR
    expect((await post(agent, '/api/paypal/activity')).status).toBe(200)
    const refreshed = [...fake.access].find((token) => token !== TOKEN)!
    const calls = fake.fetch.mock.calls.length
    for (const tool of ['create_invoice', 'send_invoice', 'list_invoices'])
      await expect(connect.callTool(refreshed, 'mcp-1', tool, {})).rejects.toMatchObject({
        code: 'TOOL_REFUSED',
      })
    expect(fake.fetch.mock.calls).toHaveLength(calls)
    expect(new Set(fake.tools)).toEqual(new Set(['list_transactions']))
  })

  it('reads one at a time per session', async () => {
    const { connect, store } = await connected()
    const { id } = store.db.prepare('SELECT id FROM sessions').get() as { id: string }
    // The review's read and a background sync at once: the second is refused, never run twice.
    const first = connect.read(id, 'UTC')
    await expect(connect.read(id, 'UTC')).rejects.toMatchObject({ code: 'BUSY' })
    await expect(first).resolves.toMatchObject({ summary: { transactions: 39 } })
    await expect(connect.read(id, 'UTC')).resolves.toBeTruthy()
  })

  it('disconnects without touching the plan, and deleting the data deletes the link', async () => {
    const { agent, store } = await connected()
    const before = (await agent.get('/api/state')).body.profile
    const count = () =>
      (store.db.prepare('SELECT COUNT(*) AS n FROM paypal_links').get() as { n: number }).n
    expect(count()).toBe(1)
    const off = await post(agent, '/api/paypal/disconnect')
    expect(off.status).toBe(200)
    expect(off.body.config.paypalLinked).toBeUndefined()
    expect(off.body.profile).toEqual(before)
    expect(count()).toBe(0)
    expect((await post(agent, '/api/paypal/activity')).body.code).toBe('NOT_CONNECTED')

    const other = await connected()
    expect(
      (other.store.db.prepare('SELECT COUNT(*) AS n FROM paypal_links').get() as { n: number }).n,
    ).toBe(1)
    await post(other.agent, '/api/reset')
    expect(
      (other.store.db.prepare('SELECT COUNT(*) AS n FROM paypal_links').get() as { n: number }).n,
    ).toBe(0)
  })

  it('a Disconnect during a refresh keeps nothing, and asks PayPal to revoke both tokens', async () => {
    let release!: () => void
    const gate = new Promise<void>((done) => (release = done))
    const revoked: string[] = []
    const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const form = new URLSearchParams(String(init.body ?? ''))
      if (new URL(String(input)).pathname === '/token') {
        if (form.get('grant_type') === 'refresh_token') {
          await gate
          return Response.json({
            access_token: 'tok-new',
            refresh_token: 'rt-new',
            expires_in: 3600,
          })
        }
        revoked.push(form.get('token') ?? '')
        return new Response('', { status: 200 })
      }
      return new Response('unavailable', { status: 503 })
    }) as typeof globalThis.fetch
    const vault = memoryVault()
    const connect = createPayPalConnect({
      origin: ORIGIN,
      enabled: true,
      clientId: 'client-1',
      fetch,
      vault,
      log: () => {},
    })
    vault.set('S', { clientId: 'client-1', refreshToken: 'rt-old' })
    const read = connect.read('S', 'UTC')
    await new Promise((done) => setTimeout(done, 10))
    connect.disconnect('S')
    release()
    await expect(read).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
    expect(connect.linked('S')).toBe(false)
    expect(vault.get('S')).toBeUndefined()
    // The token Worth held, and the one PayPal issued as the Disconnect happened.
    await vi.waitFor(() => expect(revoked.sort()).toEqual(['rt-new', 'rt-old']))
  })

  it('a Disconnect while a sync is reading applies nothing to the plan', async () => {
    const fake = fakeMcp({
      list: (_args, call) => (call === 1 || call >= 7 ? FIXTURE : 'No transactions found.'),
    })
    const context = setup(fake, { key: KEY })
    const server = context.app.listen(0)
    try {
      const agent = request.agent(server)
      const { state } = await startLogin(agent, fake)
      await agent.get(`/api/paypal/connect/callback?code=${CODE}&state=${state}`)
      const csv = (await post(agent, '/api/paypal/activity')).body.csv as string
      await agent.post('/api/import/commit').set('X-Worth-Client', 'web').send({ csv })
      const before = (await agent.get('/api/state')).body.profile
      const release = fake.holdReads()
      const sync = post(agent, '/api/paypal/sync').then((response) => response)
      await vi.waitFor(() => expect(fake.tools.length).toBeGreaterThan(6))
      expect((await post(agent, '/api/paypal/disconnect')).status).toBe(200)
      release()
      const answer = await sync
      expect(answer.status).toBe(409)
      expect(answer.body.code).toBe('NOT_CONNECTED')
      const after = (await agent.get('/api/state')).body
      expect(after.profile).toEqual(before)
      expect(after.config.paypalLinked).toBeUndefined()
      expect(fake.revoked).toEqual([REFRESH])
    } finally {
      server.close()
    }
  })

  it('Delete my data while a sync is reading keeps nothing for the old session', async () => {
    const fake = fakeMcp({
      list: (_args, call) => (call === 1 || call >= 7 ? FIXTURE : 'No transactions found.'),
    })
    const context = setup(fake, { key: KEY })
    const server = context.app.listen(0)
    try {
      const agent = request.agent(server)
      const { state } = await startLogin(agent, fake)
      await agent.get(`/api/paypal/connect/callback?code=${CODE}&state=${state}`)
      const csv = (await post(agent, '/api/paypal/activity')).body.csv as string
      await agent.post('/api/import/commit').set('X-Worth-Client', 'web').send({ csv })
      const release = fake.holdReads()
      const sync = post(agent, '/api/paypal/sync').then((response) => response)
      await vi.waitFor(() => expect(fake.tools.length).toBeGreaterThan(6))
      expect((await post(agent, '/api/reset')).status).toBe(200)
      release()
      expect((await sync).status).not.toBe(200)
      const links = context.store.db.prepare('SELECT COUNT(*) AS n FROM paypal_links').get()
      expect(links).toEqual({ n: 0 })
      expect(fake.revoked).toEqual([REFRESH])
    } finally {
      server.close()
    }
  })

  it('asks PayPal to revoke on Disconnect without waiting for it or failing', async () => {
    const fake = fakeMcp({ revoke: 'down' })
    const { agent } = await connected(fake)
    const off = await post(agent, '/api/paypal/disconnect')
    expect(off.status).toBe(200)
    expect(off.body.config.paypalLinked).toBeUndefined()
    await vi.waitFor(() => expect(fake.revoked).toEqual([REFRESH]))
  })

  it('keeps the last read time when a sync was skipped, so the row stays truthful', async () => {
    const future = (call: number) =>
      call >= 12
        ? JSON.stringify({
            transaction_details: [
              ...JSON.parse(FIXTURE).transaction_details,
              {
                transaction_info: {
                  transaction_id: 'TXFUTURE',
                  transaction_event_code: 'T0006',
                  transaction_initiation_date: '2027-01-05T10:00:00Z',
                  transaction_amount: { currency_code: 'USD', value: '-5.00' },
                  transaction_status: 'S',
                },
              },
            ],
          })
        : call === 1 || call >= 6
          ? FIXTURE
          : 'No transactions found.'
    const fake = fakeMcp({ list: (_args, call) => future(call) })
    const { agent, clock } = await connected(fake)
    const csv = (await post(agent, '/api/paypal/activity')).body.csv as string
    const committed = await agent
      .post('/api/import/commit')
      .set('X-Worth-Client', 'web')
      .send({ csv })
    const at = committed.body.profile.importedAt
    clock.t += 20 * 60_000
    const ok = await post(agent, '/api/paypal/sync')
    expect(ok.body.skipped).toBeUndefined()
    expect(ok.body.state.profile.importedAt).toBe(new Date(clock.t).toISOString())
    clock.t += 20 * 60_000
    // This read has a row the import can't use: nothing is applied and the time stays.
    const skipped = await post(agent, '/api/paypal/sync')
    expect(skipped.status).toBe(200)
    expect(skipped.body.skipped).toBe(true)
    expect(skipped.body.state.profile.importedAt).toBe(ok.body.state.profile.importedAt)
    expect(at).not.toBe(ok.body.state.profile.importedAt)
  })

  it('drops links held in memory when their session expires', async () => {
    const fake = fakeMcp()
    const { app, connect, clock, store } = await connected(fake, undefined)
    const { id } = store.db.prepare('SELECT id FROM sessions').get() as { id: string }
    expect(connect.linked(id)).toBe(true)
    clock.t += 2 * 24 * HOUR
    app.locals.cleanup()
    expect(connect.linked(id)).toBe(false)
  })

  it('syncs only a plan built from Connect PayPal', async () => {
    const fake = fakeMcp({
      list: (_args, call) => (call === 1 || call === 7 ? FIXTURE : 'No transactions found.'),
    })
    const { agent, clock } = await connected(fake)
    // Still the sample: nothing to keep up to date, and PayPal isn't read for it.
    expect((await post(agent, '/api/paypal/sync')).body.code).toBe('NOT_SYNCED')
    expect(fake.tools).toHaveLength(0)
    const read = await post(agent, '/api/paypal/activity')
    const csv = read.body.csv as string
    const commit = await agent.post('/api/import/commit').set('X-Worth-Client', 'web').send({ csv })
    expect(commit.body.profile.importedFrom).toBe('paypal')
    clock.t += 20 * 60_000
    const sync = await post(agent, '/api/paypal/sync')
    expect(sync.status).toBe(200)
    expect(sync.body.changes).toEqual({ transactions: 0, plans: 0, paid: 0 })
    expect(sync.body.state.profile.importedAt).toBe(new Date(clock.t).toISOString())
    expect(JSON.stringify(sync.body)).not.toMatch(/SECRET/)
  })
})
