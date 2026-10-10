import { resolve } from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDevClient } from '../../merchant/devClient.ts'

// The development client server must serve the store's client module and nothing of its server.
describe('store development client', () => {
  let vite: Awaited<ReturnType<typeof createDevClient>>
  const app = express()
  beforeAll(async () => {
    vite = await createDevClient()
    app.use(vite.middlewares)
    app.use((_req, res) => res.status(404).send('Not found.'))
  })
  afterAll(async () => {
    await vite.close()
  })

  it('serves the client module and the shared SDK loader it imports', async () => {
    const main = await request(app).get('/main.ts').expect(200)
    expect(main.text).toContain('mountCheckout')
    const sdk = main.text.match(/from "(\/@fs\/[^"]+paypalSdk\.ts)"/)?.[1]
    expect(sdk).toBeDefined()
    await request(app).get(sdk!).expect(200)
  })

  it('never serves server code, config or secrets', async () => {
    const root = resolve(import.meta.dirname, '../..')
    for (const path of [
      '/app.ts',
      '/config.ts',
      '/handoff-stub.ts',
      '/../app.ts',
      `/@fs${root}/merchant/app.ts`,
      `/@fs${root}/merchant/handoff-stub.ts`,
      `/@fs${root}/server/config.ts`,
      `/@fs${root}/.env`,
      `/@fs${root}/package.json`,
    ]) {
      const res = await request(app).get(path)
      expect([403, 404], path).toContain(res.status)
    }
  })
})
