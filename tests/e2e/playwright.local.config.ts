import { defineConfig, devices } from '@playwright/test';

/**
 * E2E-01 against the local in-memory Percy (apps/local). Same spec as the deployed run; timing
 * windows are scaled down and the stub SES gives mailbox-simulator feedback in seconds.
 */
const port = Number(process.env['PORT'] ?? 4173);
process.env['E2E_TARGET'] = 'local';
process.env['E2E_STOP_LIMIT_MS'] ??= '15000';
process.env['E2E_STOP_WAIT_MS'] ??= '20000';
process.env['E2E_REPORT_WAIT_MS'] ??= '60000';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 10 * 60_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list']],
  outputDir: '/tmp/percy-playwright-results',
  use: { baseURL: `http://localhost:${port}`, ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'npm run spa:build && npx tsx apps/local/src/server.ts',
    cwd: '../..',
    url: `http://localhost:${port}/auth/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PORT: String(port), PERCY_LOCAL_RATE: '2', PERCY_LOCAL_STATUS_CACHE_MS: '2000', LOG_LEVEL: 'WARN' },
  },
});
