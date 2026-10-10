import { resolve } from 'node:path'

/**
 * Development only: Vite compiles the store's client module on request. Its root is the client
 * folder and only that folder and the shared SDK loader may be read (vite.config.ts), so the
 * store's server code is never served. No HMR, no websocket and no injected scripts, so the full
 * CSP stays on.
 */
export async function createDevClient() {
  const { createServer } = await import('vite')
  return createServer({
    configFile: resolve(import.meta.dirname, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
    logLevel: 'warn',
  })
}
