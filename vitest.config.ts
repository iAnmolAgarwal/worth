import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    maxWorkers: 1,
    testTimeout: 15000,
    // Tests never spend Channel3 credits, even with a key exported in the shell.
    // Nor do they read a hand-off key or store origin from the shell.
    // Their numbers are Maya's, so a new session starts as her (tests/alex-scenario.test.ts and
    // tests/alex-sample.test.ts cover Alex, the default).
    env: { CHANNEL3_API_KEY: '', HANDOFF_SECRET: '', MERCHANT_ORIGIN: '', SAMPLE_PERSONA: 'maya' },
  },
})
