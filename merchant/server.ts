import 'dotenv/config'
import { resolve } from 'node:path'
import express from 'express'
import { ConfigError } from '../server/config.ts'
import { createMerchantApp } from './app.ts'
import type { MerchantConfig } from './config.ts'

// Larkspur Supply, the demo store on its own origin. Production serves the built client from
// dist-merchant; development lets Vite compile it on request (see devClient.ts).
const production = process.env.NODE_ENV === 'production'
let app: ReturnType<typeof createMerchantApp>
try {
  app = createMerchantApp({
    scriptSrc: production ? '/assets/store.js' : '/main.ts',
    worthCheckSrc: production ? '/assets/worth-check.js' : '/worth-check.ts',
  })
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error)
  process.exit(1)
}
const config = app.locals.config as MerchantConfig
if (production) {
  app.use('/assets', express.static(resolve('dist-merchant/assets'), { maxAge: '1h' }))
} else {
  const { createDevClient } = await import('./devClient.ts')
  app.use((await createDevClient()).middlewares)
}
app.use((_req, res) => res.status(404).type('text').send('Not found.'))
const server = app.listen(config.port, config.host, () =>
  console.log(
    `Larkspur Supply is ready at ${config.origin} (listening on ${config.host}:${config.port})`,
  ),
)
const cleanup = setInterval(() => app.locals.cleanup(), 60 * 1000)
cleanup.unref()
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    clearInterval(cleanup)
    server.close(() => process.exit(0))
  })
