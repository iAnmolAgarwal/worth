import { defineConfig, devices } from '@playwright/test'

/**
 * The two-origin E2E (C8): Worth and Larkspur Supply on their own origins, driven in a real
 * browser. `npm run test:e2e` builds both apps first; tests/e2e/global-setup.ts starts the servers.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.spec.ts',
  globalSetup: './tests/e2e/global-setup.ts',
  // One server set is shared, and every test is its own shopper, so tests can run side by side.
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  forbidOnly: Boolean(process.env.CI),
  // A flake is a failure: nothing is retried.
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop-1440',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'phone-390',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        isMobile: false,
        hasTouch: true,
      },
    },
  ],
})
