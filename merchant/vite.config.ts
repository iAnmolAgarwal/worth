import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// The store's client: one small module, no framework. Built to dist-merchant/assets/store.js.
export default defineConfig({
  root: resolve(import.meta.dirname),
  publicDir: false,
  server: { fs: { allow: [resolve(import.meta.dirname, '..')] } },
  build: {
    outDir: resolve(import.meta.dirname, '../dist-merchant/assets'),
    emptyOutDir: true,
    lib: {
      entry: resolve(import.meta.dirname, 'client/main.ts'),
      formats: ['es'],
      fileName: () => 'store.js',
    },
  },
})
