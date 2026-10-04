import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    maxWorkers: 1,
    testTimeout: 15000,
    // Tests never spend Channel3 credits, even with a key exported in the shell.
    env: { CHANNEL3_API_KEY: '' },
  },
})
