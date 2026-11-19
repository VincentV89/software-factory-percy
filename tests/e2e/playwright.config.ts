import { defineConfig, devices } from '@playwright/test';

/** E2E-01 against a deployed dev instance (NFR-QA-05): PERCY_BASE_URL=https://<distribution> npm run e2e:dev */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 45 * 60_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [['list']],
  use: { baseURL: process.env['PERCY_BASE_URL'], ...devices['Desktop Chrome'], trace: 'retain-on-failure', actionTimeout: 30_000, navigationTimeout: 30_000 },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
