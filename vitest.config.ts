import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { include: ['tests/**/*.test.{ts,tsx}'], maxWorkers: 1, testTimeout: 15000 },
})
