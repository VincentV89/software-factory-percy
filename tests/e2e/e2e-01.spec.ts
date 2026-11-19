import { createHash } from 'node:crypto';
import { expect, request, test, type BrowserContext, type Page } from '@playwright/test';
import { E2E_SMALL_CSV, E2E_STOP_CSV, EICAR_CSV, TEMPLATE } from './fixtures';
import { setUpFixtures, signIn, target } from './target';

/**
 * E2E-01, the primary browser journey (requirements §11, NFR-QA-05). Runs against the deployed dev
 * instance (`npm run e2e:dev`, PERCY_BASE_URL) or the local in-memory Percy (`npm run e2e:local`).
 */
const KILL_REASON = 'E2E drill (team kill switch)'; // FR-CTL-04 needs 10–500 characters.
const hash = (email: string): string => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, everyMs = 1000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last = await read();
  while (!ok(last)) {
    if (Date.now() > end) throw new Error(`condition not met in ${timeoutMs} ms; last value ${JSON.stringify(last)}`);
    await sleep(everyMs);
    last = await read();
  }
  return last;
}

async function campaignState(page: Page): Promise<string> {
  await page.getByTestId('campaign-refresh').click();
  await page.waitForLoadState('networkidle');
  return (await page.getByTestId('campaign-state').textContent()) ?? '';
}

async function reportNumber(page: Page, key: string): Promise<number> {
  const cell = page.getByTestId(`report-${key}`);
  if ((await cell.count()) === 0) return 0;
  return Number(await cell.textContent());
}

async function sendLog(page: Page, campaignId: string): Promise<{ addrHash: string; status: string; sesCalledAt?: number; devUnsubUrl?: string }[]> {
  const res = await page.request.get(`/api/engine/test/campaigns/${campaignId}/send-log`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { items: { addrHash: string; status: string; sesCalledAt?: number; devUnsubUrl?: string }[] }).items;
}

const lastSesCall = async (page: Page, campaignId: string): Promise<number> => Math.max(0, ...(await sendLog(page, campaignId)).map((r) => r.sesCalledAt ?? 0));

async function upload(page: Page, name: string, csv: string, finalState: string): Promise<void> {
  await page.getByTestId('list-upload-input').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByTestId('list-upload-button').click();
  await until(
    async () => {
      await page.getByTestId('list-refresh').click();
      return (await page.getByTestId('import-status').textContent().catch(() => '')) ?? '';
    },
    (s) => ['COMPLETED', 'FAILED', 'REJECTED_MALWARE'].includes(s),
    5 * 60_000,
    1500,
  );
  await expect(page.getByTestId('import-status')).toHaveText(finalState);
}

async function createList(page: Page, teamId: string, name: string): Promise<void> {
  await page.goto(`/teams/${teamId}/lists`);
  await page.getByTestId('list-form-name').fill(name);
  await page.getByTestId('list-form-submit').click();
  await page.getByTestId('list-link').filter({ hasText: name }).click();
  await expect(page.getByTestId('list-detail')).toBeVisible();
}

async function createCampaign(page: Page, teamId: string, name: string, listName: string): Promise<string> {
  await page.goto(`/teams/${teamId}/campaigns`);
  await page.getByTestId('campaign-new-button').click();
  await page.getByTestId('campaign-form-name').fill(name);
  await page.getByTestId('campaign-form-template').selectOption({ label: TEMPLATE.name });
  await page.getByTestId('campaign-form-list').selectOption({ label: listName });
  await page.getByTestId('campaign-form-sender').fill('E2E Sender');
  await page.getByTestId('campaign-form-submit').click();
  await expect(page.getByTestId('campaign-detail')).toBeVisible();
  return page.url().split('/').pop() ?? '';
}

test('E2E-01: officer journey from sign-in to stop', async ({ browser, baseURL }) => {
  test.setTimeout(target.local ? 10 * 60_000 : 45 * 60_000);
  const contexts: BrowserContext[] = [];
  const newPage = async (): Promise<Page> => {
    const ctx = await browser.newContext();
    contexts.push(ctx);
    return ctx.newPage();
  };
  const a = await newPage();
  await setUpFixtures(a);
  let teamId = '';
  let c1 = '';
  let c3 = '';

  await test.step('1 sign in; only percy_sid; no token in storage', async () => {
    await signIn(a, target.users.a);
    await expect(a.getByTestId('campaigns-empty')).toBeVisible();
    teamId = a.url().split('/teams/')[1]?.split('/')[0] ?? '';
    const cookies = await a.context().cookies(baseURL);
    expect(cookies.map((c) => c.name)).toEqual(['percy_sid']);
    expect(cookies[0]).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
    const storage = await a.evaluate(() => ({ local: Object.keys(localStorage).length, session: Object.keys(sessionStorage).length }));
    expect(storage).toEqual({ local: 0, session: 0 });
  });

  await test.step('2 EICAR upload is rejected', async () => {
    await createList(a, teamId, 'E2E List');
    await upload(a, 'eicar.csv', EICAR_CSV, 'REJECTED_MALWARE');
    await expect(a.getByTestId('list-member-count')).toHaveText('0');
  });

  await test.step('3 e2e-small.csv imports with the expected summary', async () => {
    await upload(a, 'e2e-small.csv', E2E_SMALL_CSV, 'COMPLETED');
    await expect(a.getByTestId('import-total')).toHaveText('7');
    await expect(a.getByTestId('import-imported')).toHaveText('5');
    await expect(a.getByTestId('import-duplicates')).toHaveText('1');
    await expect(a.getByTestId('import-invalid')).toHaveText('1');
    await expect(a.getByTestId('import-suppressed')).toHaveText('1');
    await expect(a.getByTestId('import-latest')).toContainText('row 6');
  });

  await test.step('4 template without unsubscribe in the text body is refused', async () => {
    await a.goto(`/teams/${teamId}/templates/new`);
    await a.getByTestId('template-form-name').fill(TEMPLATE.name);
    await a.getByTestId('template-form-subject').fill(TEMPLATE.subject);
    await a.getByTestId('template-form-html').fill(TEMPLATE.html);
    await a.getByTestId('template-form-text').fill('Hi {{name}}');
    await a.getByTestId('template-form-submit').click();
    await expect(a.getByTestId('template-form-error')).toContainText('text');
    await a.getByTestId('template-form-text').fill(TEMPLATE.text);
    await a.getByTestId('template-form-submit').click();
    await expect(a.getByTestId('template-saved')).toBeVisible();
  });

  await test.step('5 preview with Ann', async () => {
    await a.getByTestId('template-preview-list').selectOption({ label: 'E2E List' });
    await a.getByTestId('template-preview-contact').selectOption({ label: 'Ann (success+e2e1@simulator.amazonses.com)' });
    await a.getByTestId('template-preview-button').click();
    await expect(a.getByTestId('template-preview-subject')).toHaveText('Hello Ann');
  });

  await test.step('6 campaign audience is 4', async () => {
    c1 = await createCampaign(a, teamId, 'E2E Campaign', 'E2E List');
    await expect(a.getByTestId('campaign-audience-count')).toHaveText('4');
  });

  await test.step('7 submit; the author sees no approve button', async () => {
    await a.getByTestId('campaign-submit-button').click();
    await expect(a.getByTestId('campaign-state')).toHaveText('PENDING_APPROVAL');
    await expect(a.getByTestId('campaign-approve-button')).toHaveCount(0);
  });

  await test.step('8 the approve API called from the page returns 403', async () => {
    const status = await a.evaluate(async ({ t, c }) => {
      const me = (await (await fetch('/api/platform/me')).json()) as { csrfToken: string };
      const res = await fetch(`/api/engine/teams/${t}/campaigns/${c}/actions/approve`, { method: 'POST', headers: { 'x-csrf-token': me.csrfToken, 'content-type': 'application/json' }, body: '{}' });
      return res.status;
    }, { t: teamId, c: c1 });
    expect(status).toBe(403);
  });

  const b = await newPage();
  await test.step('9 officer-b approves; the approval is audited', async () => {
    await signIn(b, target.users.b);
    await b.goto(`/teams/${teamId}/campaigns/${c1}`);
    await b.getByTestId('campaign-approve-button').click();
    await expect(b.getByTestId('campaign-state')).toHaveText('APPROVED');
    if (target.local) {
      const res = await b.request.get(`/_local/test/audit?action=campaign.approve&targetId=${c1}`);
      expect(((await res.json()) as { count: number }).count).toBe(1);
    } else {
      test.info().annotations.push({ type: 'manual', description: 'Audit lands in S3 via Firehose; check with the deploy runbook audit query.' });
    }
  });

  await test.step('10 send now: SCHEDULED → FREEZING → SENDING', async () => {
    await a.reload();
    await a.getByTestId('campaign-send-now-button').click();
    await until(() => campaignState(a), (s) => ['SENDING', 'COMPLETED'].includes(s), 5 * 60_000, 2000);
  });

  await test.step('11 report settles: sent 4, bounced 1, complained 1', async () => {
    await until(
      async () => ({ state: await campaignState(a), sent: await reportNumber(a, 'sent'), bounced: await reportNumber(a, 'bouncedHard'), complained: await reportNumber(a, 'complained'), delivered: await reportNumber(a, 'delivered') }),
      (r) => r.state === 'COMPLETED' && r.bounced === 1 && r.complained === 1 && r.delivered >= 2,
      target.reportWaitMs,
      3000,
    );
    await expect(a.getByTestId('report-sent')).toHaveText('4');
    await expect(a.getByTestId('report-skipped')).toHaveText('0');
    await expect(a.getByTestId('report-inDoubt')).toHaveText('0');
  });

  await test.step('12 unsubscribe Ann through her link', async () => {
    const row = (await sendLog(a, c1)).find((r) => r.addrHash === hash('success+e2e1@simulator.amazonses.com'));
    expect(row?.devUnsubUrl).toBeTruthy();
    const u = await newPage();
    await u.goto(row?.devUnsubUrl ?? '');
    await expect(u.getByTestId('unsubscribe-agency')).toHaveText('E2E Agency');
    await u.getByTestId('unsubscribe-confirm').click();
    await expect(u.getByTestId('unsubscribe-success')).toBeVisible();
  });

  await test.step('13 campaign 2 on the same list has audience 1', async () => {
    await createCampaign(a, teamId, 'E2E Campaign 2', 'E2E List');
    await until(async () => {
      await a.reload();
      return (await a.getByTestId('campaign-audience-count').textContent()) ?? '';
    }, (v) => v === '1', 15 * 60_000, 3000);
  });

  await test.step('14 120-recipient campaign starts sending', async () => {
    await createList(a, teamId, 'E2E Stop');
    await upload(a, 'e2e-stop.csv', E2E_STOP_CSV, 'COMPLETED');
    c3 = await createCampaign(a, teamId, 'E2E Campaign 3', 'E2E Stop');
    await a.getByTestId('campaign-submit-button').click();
    await expect(a.getByTestId('campaign-state')).toHaveText('PENDING_APPROVAL');
    await b.goto(`/teams/${teamId}/campaigns/${c3}`);
    await b.getByTestId('campaign-approve-button').click();
    await expect(b.getByTestId('campaign-state')).toHaveText('APPROVED');
    await a.reload();
    await a.getByTestId('campaign-send-now-button').click();
    await until(() => campaignState(a), (s) => s === 'SENDING', 5 * 60_000, 2000);
  });

  await test.step('15 pause: no SES call after the stop budget', async () => {
    await until(async () => (await campaignState(a), reportNumber(a, 'sent')), (n) => n >= 10, 5 * 60_000, 2000);
    await a.getByTestId('campaign-pause-button').click();
    await expect(a.getByTestId('campaign-notice')).toBeVisible();
    const t1 = Date.now();
    await until(() => campaignState(a), (s) => s === 'PAUSED', target.stopLimitMs, 1000);
    await sleep(Math.max(0, t1 + target.stopLimitMs - Date.now()));
    const sentAtLimit = (await campaignState(a), await reportNumber(a, 'sent'));
    await sleep(Math.max(0, t1 + target.stopWaitMs - Date.now()));
    expect((await campaignState(a), await reportNumber(a, 'sent'))).toBe(sentAtLimit);
    expect(await lastSesCall(a, c3)).toBeLessThanOrEqual(t1 + target.stopLimitMs);
  });

  await test.step('16 resume: sending continues', async () => {
    const before = await reportNumber(a, 'sent');
    await a.getByTestId('campaign-resume-button').click();
    await until(() => campaignState(a), (s) => s === 'SENDING', 60_000, 1000);
    await until(async () => (await campaignState(a), reportNumber(a, 'sent')), (n) => n > before, 5 * 60_000, 2000);
  });

  const c = await newPage();
  await test.step('17 kill switch without a reason is refused', async () => {
    await signIn(c, target.users.c);
    await c.goto('/kill-switch');
    await c.getByTestId('kill-switch-scope').selectOption({ label: 'Team: E2E Team' });
    await c.getByTestId('kill-switch-set-button').click();
    await expect(c.getByTestId('kill-switch-error')).toBeVisible();
  });

  await test.step('18 team kill switch: banner shown, campaign paused, no SES call after the budget', async () => {
    await c.getByTestId('kill-switch-reason').fill(KILL_REASON);
    await c.getByTestId('kill-switch-set-button').click();
    await expect(c.getByTestId('kill-switch-active-item')).toContainText(KILL_REASON);
    const t2 = Date.now();
    await a.reload();
    await expect(a.getByTestId('kill-switch-banner')).toContainText(KILL_REASON);
    await expect(a.getByTestId('kill-switch-banner')).toContainText('E2E Team');
    await until(() => campaignState(a), (s) => s === 'PAUSED', target.stopLimitMs, 1000);
    await sleep(Math.max(0, t2 + target.stopWaitMs - Date.now()));
    expect(await lastSesCall(a, c3)).toBeLessThanOrEqual(t2 + target.stopLimitMs);
  });

  await test.step('19 resume is refused with the kill switch reason', async () => {
    await a.getByTestId('campaign-resume-button').click();
    await expect(a.getByTestId('campaign-action-error')).toContainText(KILL_REASON);
  });

  await test.step('20 clear: banner goes, campaign stays PAUSED', async () => {
    c.once('dialog', (d) => void d.accept('drill over'));
    await c.getByTestId('kill-switch-clear-button').click();
    await expect(c.getByTestId('kill-switch-none')).toBeVisible();
    await a.reload();
    await expect(a.getByTestId('kill-switch-banner')).toHaveCount(0);
    await sleep(3000);
    expect(await campaignState(a)).toBe('PAUSED');
  });

  await test.step('21 stop: remaining recipients cancelled; totals = 120', async () => {
    a.once('dialog', (d) => void d.accept());
    await a.getByTestId('campaign-stop-button').click();
    await until(() => campaignState(a), (s) => s === 'STOPPED', 60_000, 1000);
    const totals = await until(
      async () => {
        await campaignState(a);
        const k = ['sent', 'cancelled', 'failed', 'skipped', 'inDoubt'];
        const values = await Promise.all(k.map((x) => reportNumber(a, x)));
        return { sum: values.reduce((s, v) => s + v, 0), cancelled: values[1] ?? 0, pending: await reportNumber(a, 'pending') };
      },
      (r) => r.sum === 120 && r.pending === 0,
      2 * 60_000,
      2000,
    );
    expect(totals.cancelled).toBeGreaterThan(0);
  });

  await test.step('22 sign out; the old cookie gets 401', async () => {
    const old = (await a.context().cookies(baseURL)).find((x) => x.name === 'percy_sid')?.value ?? '';
    await a.getByTestId('sign-out-button').click();
    await a.waitForLoadState();
    const api = await request.newContext({ baseURL, extraHTTPHeaders: { cookie: `percy_sid=${old}` } });
    const res = await api.get(`/api/engine/teams/${teamId}/campaigns`);
    expect(res.status()).toBe(401);
    await api.dispose();
  });

  for (const ctx of contexts) await ctx.close();
});
