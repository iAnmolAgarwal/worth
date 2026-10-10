import 'dotenv/config'
import { resolve } from 'node:path'
import express from 'express'
import { ConfigError } from '../server/config.ts'
import { createMerchantApp } from './app.ts'
import type { MerchantConfig } from './config.ts'

// Larkspur Supply, the demo store on its own origin. Production serves the built client from
// dist-merchant; development lets Vite compile it on request (no injected scripts, so the full
// CSP stays on).
const production = process.env.NODE_ENV === 'production'
let app: ReturnType<typeof createMerchantApp>
try {
  app = createMerchantApp({ scriptSrc: production ? '/assets/store.js' : '/client/main.ts' })
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error)
  process.exit(1)
}
const config = app.locals.config as MerchantConfig
if (production) {
  app.use('/assets', express.static(resolve('dist-merchant/assets'), { maxAge: '1h' }))
} else {
  const { createServer } = await import('vite')
  const vite = await createServer({
    configFile: resolve('merchant/vite.config.ts'),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
  })
  app.use(vite.middlewares)
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
