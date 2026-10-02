import 'dotenv/config'
import { resolve } from 'node:path'
import express from 'express'
import { createApp } from './app.ts'

const app = createApp()
const port = Number(process.env.PORT ?? 5173)
if (process.env.NODE_ENV === 'production') {
  const directory = resolve('dist')
  app.use(express.static(directory, { index: false }))
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(directory, 'index.html')))
} else {
  const { createServer } = await import('vite')
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' })
  app.use(vite.middlewares)
}
const server = app.listen(port, process.env.HOST ?? '127.0.0.1', () =>
  console.log(`Worth is ready at http://localhost:${port}`),
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
