import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// The store's client: one small module, no framework. Built to dist-merchant/assets/store.js.
// In development Vite serves only the client folder and the shared SDK loader, never the server.
const client = resolve(import.meta.dirname, 'client')
export default defineConfig({
  root: client,
  publicDir: false,
  server: {
    fs: {
      strict: true,
      allow: [client, resolve(import.meta.dirname, '../src/paypalSdk.ts')],
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, '../dist-merchant/assets'),
    emptyOutDir: true,
    lib: {
      entry: resolve(client, 'main.ts'),
      formats: ['es'],
      fileName: () => 'store.js',
    },
  },
})
