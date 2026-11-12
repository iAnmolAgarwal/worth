import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import express, { type Express } from 'express'
import { createApp } from '../../server/app.ts'
import { Store } from '../../server/store.ts'
import { createMerchantApp } from '../../merchant/app.ts'
import { fakePayPalGateway } from './fakePayPal.ts'
import { fakeMcpFetch } from './fakeMcp.ts'
import { createPayPalConnect } from '../../server/paypalConnect.ts'

/**
 * Starts the E2E's three servers on free ports and prints their origins as one JSON line:
 * - Worth, with the hand-off on, serving the built app under the full Content-Security-Policy;
 * - Larkspur Supply on its own origin (localhost, so its cookies are apart from Worth's 127.0.0.1),
 *   serving its built client, with a fake PayPal gateway;
 * - a second Worth with the hand-off off.
 * The shared HANDOFF_SECRET is a test key from the environment. Claude is off, PayPal is faked on
 * both servers, and Channel3 answers from its recorded fixtures.
 */
const secret = process.env.E2E_HANDOFF_SECRET
if (!secret) throw new Error('E2E_HANDOFF_SECRET is not set.')
const root = resolve(import.meta.dirname, '../..')

async function listen(host: string) {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, host, done))
  return { server, port: (server.address() as AddressInfo).port }
}

/** The built SPA, as server/index.ts serves it in production. */
function serveWorth(app: Express) {
  const dist = resolve(root, 'dist')
  app.use(express.static(dist, { index: false }))
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')))
  return app
}

function worth(port: number, handoff?: { merchantOrigin: string }, connect = false) {
  const origin = `http://127.0.0.1:${port}`
  return serveWorth(
    createApp({
      // Connect PayPal against a fake MCP server, on its own Worth only.
      ...(connect
        ? {
            paypalConnect: createPayPalConnect({
              origin,
              enabled: true,
              fetch: fakeMcpFetch(),
              log: () => {},
            }),
          }
        : {}),
      store: new Store(':memory:'),
      config: {
        production: false,
        // The production policy, so a CSP violation on either origin fails the run.
        contentSecurityPolicy: true,
        origin: `http://127.0.0.1:${port}`,
        port,
        // Each test is a different shopper on its own network (X-Forwarded-For), so Worth's
        // per-IP limits never carry over from one test to the next.
        trustProxy: 1,
        paypalClientId: undefined,
        paypalSecret: undefined,
        paypalWebhookId: undefined,
        anthropicKey: undefined,
        channel3ApiKey: undefined,
        channel3Mode: 'fixture',
        handoffSecret: handoff ? secret : undefined,
        merchantOrigin: handoff?.merchantOrigin,
      },
    }),
  )
}

const worthServer = await listen('127.0.0.1')
const storeServer = await listen('127.0.0.1')
const offServer = await listen('127.0.0.1')
const connectServer = await listen('127.0.0.1')
const worthOrigin = `http://127.0.0.1:${worthServer.port}`
const storeOrigin = `http://localhost:${storeServer.port}`
const offOrigin = `http://127.0.0.1:${offServer.port}`
const connectOrigin = `http://127.0.0.1:${connectServer.port}`

// A browser may reach localhost over IPv6 first; the store answers there too when it can.
const storeV6 = createServer()
await new Promise<void>((done) => {
  storeV6.once('error', () => done())
  storeV6.listen(storeServer.port, '::1', done)
})

worthServer.server.on('request', worth(worthServer.port, { merchantOrigin: storeOrigin }))
offServer.server.on('request', worth(offServer.port))
connectServer.server.on('request', worth(connectServer.port, undefined, true))

const store = createMerchantApp({
  env: {},
  config: {
    production: false,
    origin: storeOrigin,
    worthOrigin,
    port: storeServer.port,
    trustProxy: 1,
    handoffSecret: Buffer.from(secret, 'base64url'),
    // Public and fake: it only turns the PayPal button on; the SDK is the browser-side fake.
    paypalClientId: 'e2e-sandbox-client',
    paypalSecret: undefined,
    paypalWebhookId: undefined,
  },
  paypal: fakePayPalGateway(),
  scriptSrc: '/assets/store.js',
  worthCheckSrc: '/assets/worth-check.js',
  report: { log: () => {} },
})
store.use('/assets', express.static(resolve(root, 'dist-merchant/assets')))
store.use((_req, res) => res.status(404).type('text').send('Not found.'))
storeServer.server.on('request', store)
storeV6.on('request', store)

const servers: Server[] = [
  worthServer.server,
  storeServer.server,
  offServer.server,
  connectServer.server,
  storeV6,
]
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    for (const server of servers) server.close()
    process.exit(0)
  })
console.log(JSON.stringify({ ready: true, worthOrigin, storeOrigin, offOrigin, connectOrigin }))
