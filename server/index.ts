import 'dotenv/config'
import { resolve } from 'node:path'
import express from 'express'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import type { AppConfig } from './config.ts'

let config: AppConfig
try {
  config = loadConfig()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
const app = createApp({ config })
if (config.production) {
  const directory = resolve('dist')
  app.use(express.static(directory, { index: false }))
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(directory, 'index.html')))
} else {
  const { createServer } = await import('vite')
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' })
  app.use(vite.middlewares)
}
const server = app.listen(config.port, config.host, () =>
  console.log(`Worth is ready at ${config.origin} (listening on ${config.host}:${config.port})`),
)
const cleanup = setInterval(() => app.locals.cleanup(), 60 * 1000)
cleanup.unref()
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    clearInterval(cleanup)
    server.close(() => {
      app.locals.store.close()
      process.exit(0)
    })
  })
