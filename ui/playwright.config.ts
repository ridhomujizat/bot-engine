import { defineConfig, devices } from '@playwright/test'

// E2E against the real Go server (embedded SPA at /studio/). Started by e2e-ui/run.sh,
// which exports E2E_BASE, E2E_EMAIL, E2E_PASSWORD, E2E_BOT_ID, E2E_DSN and E2E_SHOTS.
export default defineConfig({
  testDir: 'e2e',
 // The legacy parity specs run only through `make e2e-parity` (E2E_PARITY=1), never in e2e-ui.
  testIgnore: process.env.E2E_PARITY === '1' ? [] : ['**/parity-*.spec.ts'],
 // One serial editor journey; each step depends on the one before.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE ?? 'http://localhost:3917',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
  },
})
