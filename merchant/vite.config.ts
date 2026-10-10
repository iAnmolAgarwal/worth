import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// The store's client: two small modules, no framework, built to dist-merchant/assets: store.js
// (checkout) and worth-check.js (the <worth-check> element from shared/worthCheck.ts, the file any
// store would serve). In development Vite serves only the client folder and the shared files the
// modules import, never the server.
const client = resolve(import.meta.dirname, 'client')
const shared = (file: string) => resolve(import.meta.dirname, '../shared', file)
export default defineConfig({
  root: client,
  publicDir: false,
  server: {
    fs: {
      strict: true,
      allow: [client, resolve(import.meta.dirname, '../src/paypalSdk.ts'), shared('worthCheck.ts')],
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, '../dist-merchant/assets'),
    emptyOutDir: true,
    lib: {
      entry: {
        store: resolve(client, 'main.ts'),
        'worth-check': resolve(client, 'worth-check.ts'),
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
  },
})
