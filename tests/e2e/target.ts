import { expect, type Page } from '@playwright/test';

/** Differences between the deployed dev instance and the local in-memory target, kept in one place. */
export const target = {
  local: process.env['E2E_TARGET'] === 'local',
  /** NFR-SAFE-01: no SES call more than this long after the command was accepted. */
  stopLimitMs: Number(process.env['E2E_STOP_LIMIT_MS'] ?? 60_000),
  /** How long to watch after the command (requirements step 15: 90 s). */
  stopWaitMs: Number(process.env['E2E_STOP_WAIT_MS'] ?? 90_000),
  /** Step 11: report must settle within 15 min. */
  reportWaitMs: Number(process.env['E2E_REPORT_WAIT_MS'] ?? 15 * 60_000),
  users: {
    a: process.env['E2E_OFFICER_A'] ?? (process.env['E2E_TARGET'] === 'local' ? 'officer-a@percy.local' : 'officer-a'),
    b: process.env['E2E_OFFICER_B'] ?? (process.env['E2E_TARGET'] === 'local' ? 'officer-b@percy.local' : 'officer-b'),
    c: process.env['E2E_ADMIN_C'] ?? (process.env['E2E_TARGET'] === 'local' ? 'admin-c@percy.local' : 'admin-c'),
  },
};

/** Sign in through the hosted UI (Cognito when deployed, the local stand-in otherwise). */
export async function signIn(page: Page, user: string): Promise<void> {
  await page.goto('/');
  if (target.local) {
    await page.getByTestId('local-signin-email').fill(user);
    await page.getByTestId('local-signin-submit').click();
  } else {
    // Cognito managed login: username + password from the fixture script's Secrets Manager output.
    const password = process.env[`E2E_PASSWORD_${user.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`];
    if (!password) throw new Error(`set E2E_PASSWORD_${user.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()} (printed by scripts/e2e-fixtures.ts)`);
    await page.locator('input[name="username"]:visible').fill(user);
    await page.locator('input[name="password"]:visible').fill(password);
    await page.locator('[type="submit"]:visible').first().click();
  }
  await expect(page.getByTestId('whoami')).toBeVisible();
}

export async function setUpFixtures(page: Page): Promise<void> {
  if (target.local) {
    const res = await page.request.post('/_local/test/fixtures');
    expect(res.ok()).toBe(true);
  }
  // Deployed: fixtures are created beforehand by `tsx scripts/e2e-fixtures.ts` (not by the test).
}
