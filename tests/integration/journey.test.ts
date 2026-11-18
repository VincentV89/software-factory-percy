import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualClock, hashOf } from '@percy/shared';
import { createSystem, type PercySystem } from '@percy/local';
import { E2E_SMALL_CSV, Officer, TEMPLATE, importCsv, setupTenancy } from './helpers';

/**
 * E2E-01 (requirements §11) at the API level, against the in-memory system on a virtual clock.
 * The browser version lives in tests/e2e; this proves the same 22 steps deterministically.
 */
// FR-CTL-04 requires 10–500 characters; the requirements' example "E2E drill" is 9, so the fixture is longer.
const KILL_REASON = 'E2E drill (team kill switch)';

describe('E2E-01 primary journey (API level, virtual clock)', () => {
  let sys: PercySystem;
  let clock: VirtualClock;
  let a: Officer;
  let b: Officer;
  let c: Officer;
  let teamId: string;
  let agencyId: string;

  beforeEach(async () => {
    clock = new VirtualClock();
    sys = createSystem({ clock, rates: { standard: 1, bulk: 1 }, feedbackDelayMs: 5000 });
    const t = await setupTenancy(sys, { 'officer-a@percy.test': ['member'], 'officer-b@percy.test': ['member', 'approver'] });
    teamId = t.teamId;
    agencyId = t.agencyId;
    await t.admin.ok('PUT', `/api/platform/agencies/${agencyId}/admins/${encodeURIComponent('admin-c@percy.test')}`);
    a = await new Officer(sys, 'officer-a@percy.test').signIn();
    b = await new Officer(sys, 'officer-b@percy.test').signIn();
    c = await new Officer(sys, 'admin-c@percy.test').signIn();
  });

  const report = (id: string) => a.ok<{ state: string; counters: Record<string, number>; audience: number }>('GET', `/api/engine/teams/${teamId}/campaigns/${id}/report`);
  const campaign = (o: Officer, id: string) => o.ok<{ state: string; audienceCount: number; permissions: { canApprove: boolean } }>('GET', `/api/engine/teams/${teamId}/campaigns/${id}`);

  async function createApprovedCampaign(name: string, listId: string, templateId: string): Promise<string> {
    const cmp = await a.ok<{ campaignId: string }>('POST', `/api/engine/teams/${teamId}/campaigns`, { name, templateId, listId, senderName: 'E2E Sender' });
    await a.ok('POST', `/api/engine/teams/${teamId}/campaigns/${cmp.campaignId}/actions/submit`);
    await b.ok('POST', `/api/engine/teams/${teamId}/campaigns/${cmp.campaignId}/actions/approve`);
    return cmp.campaignId;
  }

  it('runs steps 1–22', async () => {
    // Step 1: signed in; the session cookie is the only cookie; /me works.
    expect([...a.cookies.keys()]).toEqual(['percy_sid']);
    expect(a.me?.teams[0]?.roles).toEqual(['member']);

    // Pre-existing GLOBAL suppression fixture.
    await sys.suppressions.suppress({ addrHash: hashOf('success+supp@simulator.amazonses.com'), scope: 'GLOBAL', reason: 'MANUAL' });

    // Step 2: EICAR upload is rejected and never parsed.
    const list = await a.ok<{ listId: string }>('POST', `/api/contacts/teams/${teamId}/lists`, { name: 'E2E List' });
    const eicar = await importCsv(sys, a, teamId, list.listId, `email,name\n${sys.EICAR}`);
    expect(eicar['status']).toBe('REJECTED_MALWARE');
    expect((await a.ok<{ memberCount: number }>('GET', `/api/contacts/teams/${teamId}/lists/${list.listId}`)).memberCount).toBe(0);

    // Step 3: 7 rows, 5 imported, 1 duplicate, 1 invalid (row 6), 1 already suppressed.
    const imported = await importCsv(sys, a, teamId, list.listId, E2E_SMALL_CSV);
    expect(imported['status']).toBe('COMPLETED');
    expect(imported['counts']).toMatchObject({ totalRows: 7, imported: 5, duplicates: 1, invalid: 1, alreadySuppressed: 1 });
    expect(imported['invalidSample']).toEqual([{ row: 6, reason: 'email syntax is invalid' }]);

    // Step 4: template without unsubscribe in the text body is refused, naming the text body.
    const bad = await a.call<{ error: { message: string; details: { field: string }[] } }>('POST', `/api/engine/teams/${teamId}/templates`, { ...TEMPLATE, text: 'Hi {{name}}' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.map((d) => d.field)).toContain('text');
    const tpl = await a.ok<{ templateId: string }>('POST', `/api/engine/teams/${teamId}/templates`, TEMPLATE);

    // Step 5: preview with Ann.
    const members = await a.ok<{ items: { addrHash: string; attrs: Record<string, string> }[] }>('GET', `/api/contacts/teams/${teamId}/lists/${list.listId}/members`);
    const ann = members.items.find((m) => m.attrs['name'] === 'Ann');
    const preview = await a.ok<{ subject: string }>('POST', `/api/engine/teams/${teamId}/templates/${tpl.templateId}/preview`, { listId: list.listId, addrHash: ann?.addrHash });
    expect(preview.subject).toBe('Hello Ann');

    // Step 6: audience count 4.
    const cmp = await a.ok<{ campaignId: string; audienceCount: number }>('POST', `/api/engine/teams/${teamId}/campaigns`, { name: 'E2E Campaign', templateId: tpl.templateId, listId: list.listId, senderName: 'E2E Sender' });
    expect(cmp.audienceCount).toBe(4);

    // Steps 7–8: submit; the author sees no approve permission and gets 403 calling it.
    await a.ok('POST', `/api/engine/teams/${teamId}/campaigns/${cmp.campaignId}/actions/submit`);
    expect((await campaign(a, cmp.campaignId)).permissions.canApprove).toBe(false);
    expect((await a.call('POST', `/api/engine/teams/${teamId}/campaigns/${cmp.campaignId}/actions/approve`)).status).toBe(403);

    // Step 9: officer-b approves; one audit record.
    expect((await campaign(b, cmp.campaignId)).permissions.canApprove).toBe(true);
    await b.ok('POST', `/api/engine/teams/${teamId}/campaigns/${cmp.campaignId}/actions/approve`);
    expect(sys.audit.events.filter((e) => e.action === 'campaign.approve' && e.outcome === 'success' && e.targetId === cmp.campaignId)).toHaveLength(1);

    // Step 10: send now → FREEZING → SENDING.
    const scheduled = await a.ok<{ state: string }>('POST', `/api/engine/teams/${teamId}/campaigns/${cmp.campaignId}/actions/schedule`, { at: 'now' });
    expect(scheduled.state).toBe('FREEZING');
    await sys.runFor(1000);
    expect(['SENDING', 'COMPLETED']).toContain((await campaign(a, cmp.campaignId)).state);

    // Step 11: report settles.
    await sys.runFor(60_000);
    const r1 = await report(cmp.campaignId);
    expect(r1.state).toBe('COMPLETED');
    expect(r1.counters).toMatchObject({ sent: 4, bouncedHard: 1, complained: 1, skipped: 0, inDoubt: 0, pending: 0 });
    expect(r1.counters['delivered']).toBeGreaterThanOrEqual(2);
    expect(sys.ses.callsFor('success+supp@simulator.amazonses.com')).toHaveLength(0);

    // Step 12: unsubscribe Ann through the dev send-log export.
    const log = await a.ok<{ items: { addrHash: string; devUnsubUrl?: string }[] }>('GET', `/api/engine/test/campaigns/${cmp.campaignId}/send-log`);
    const annRow = log.items.find((i) => i.addrHash === hashOf('success+e2e1@simulator.amazonses.com'));
    const unsubPath = new URL(annRow?.devUnsubUrl ?? '').pathname;
    const confirm = await sys.http({ httpMethod: 'GET', path: unsubPath });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.body).toContain('E2E Agency');
    expect((await sys.http({ httpMethod: 'POST', path: unsubPath, body: 'confirm=yes' })).body).toContain('You have been unsubscribed');
    await sys.runFor(1000);

    // Step 13: campaign 2 audience is 1 (Ann unsubscribed, Cat and Dan globally suppressed).
    const cmp2 = await a.ok<{ audienceCount: number }>('POST', `/api/engine/teams/${teamId}/campaigns`, { name: 'E2E Campaign 2', templateId: tpl.templateId, listId: list.listId, senderName: 'E2E Sender' });
    expect(cmp2.audienceCount).toBe(1);

    // Step 14: 120-recipient campaign.
    const stopList = await a.ok<{ listId: string }>('POST', `/api/contacts/teams/${teamId}/lists`, { name: 'E2E Stop' });
    const rows = Array.from({ length: 120 }, (_, i) => `success+stop${String(i).padStart(3, '0')}@simulator.amazonses.com,Stop${i}`);
    expect((await importCsv(sys, a, teamId, stopList.listId, ['email,name', ...rows].join('\n')))['status']).toBe('COMPLETED');
    const c3 = await createApprovedCampaign('E2E Campaign 3', stopList.listId, tpl.templateId);
    await a.ok('POST', `/api/engine/teams/${teamId}/campaigns/${c3}/actions/schedule`, { at: 'now' });
    await sys.runFor(15_000);
    expect((await campaign(a, c3)).state).toBe('SENDING');
    const sentBefore = (await report(c3)).counters['sent'] ?? 0;
    expect(sentBefore).toBeGreaterThanOrEqual(10);

    // Step 15: pause; no SES call more than 60 s after the accept.
    const callsFor3 = () => sys.ses.calls.filter((x) => x.campaignId === c3);
    const t1 = clock.now();
    const pause = await a.call('POST', `/api/engine/teams/${teamId}/campaigns/${c3}/actions/pause`);
    expect(pause.status).toBe(202);
    await sys.runFor(90_000);
    expect((await campaign(a, c3)).state).toBe('PAUSED');
    expect(Math.max(...callsFor3().map((x) => x.at)) - t1).toBeLessThanOrEqual(60_000);

    // Step 16: resume; sending continues.
    const pausedCount = callsFor3().length;
    expect((await a.call('POST', `/api/engine/teams/${teamId}/campaigns/${c3}/actions/resume`)).status).toBe(202);
    await sys.runFor(10_000);
    expect((await campaign(a, c3)).state).toBe('SENDING');
    expect(callsFor3().length).toBeGreaterThan(pausedCount);

    // Step 17: kill switch without reason → 400.
    expect((await c.call('POST', '/api/engine/kill-switches', { scope: `TEAM#${teamId}` })).status).toBe(400);
    // An agency admin cannot set GLOBAL (FR-CTL-04 AC2).
    expect((await c.call('POST', '/api/engine/kill-switches', { scope: 'GLOBAL', reason: 'E2E drill reason' })).status).toBe(403);

    // Step 18: kill switch on the team; banner visible to officer-a; campaign paused within 60 s.
    const t2 = clock.now();
    expect((await c.call('POST', '/api/engine/kill-switches', { scope: `TEAM#${teamId}`, reason: KILL_REASON })).status).toBe(201);
    const banner = await a.ok<{ items: { scope: string; reason: string }[] }>('GET', '/api/engine/kill-switches');
    expect(banner.items).toEqual([expect.objectContaining({ scope: `TEAM#${teamId}`, reason: KILL_REASON })]);
    await sys.runFor(90_000);
    expect((await campaign(a, c3)).state).toBe('PAUSED');
    expect(Math.max(...callsFor3().map((x) => x.at)) - t2).toBeLessThanOrEqual(60_000);

    // Step 19: resume refused with the reason.
    const refused = await a.call<{ error: { message: string } }>('POST', `/api/engine/teams/${teamId}/campaigns/${c3}/actions/resume`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain(KILL_REASON);

    // Step 20: clear; campaign stays PAUSED.
    expect((await c.call('POST', '/api/engine/kill-switches/clear', { scope: `TEAM#${teamId}`, reason: 'drill over' })).status).toBe(200);
    await sys.runFor(5000);
    expect((await a.ok<{ items: unknown[] }>('GET', '/api/engine/kill-switches')).items).toHaveLength(0);
    expect((await campaign(a, c3)).state).toBe('PAUSED');

    // Step 21: stop; remaining recipients cancelled; totals = 120.
    expect((await a.call('POST', `/api/engine/teams/${teamId}/campaigns/${c3}/actions/stop`)).status).toBe(202);
    await sys.runFor(10_000);
    const r3 = await report(c3);
    expect(r3.state).toBe('STOPPED');
    const k = r3.counters;
    expect((k['sent'] ?? 0) + (k['cancelled'] ?? 0) + (k['failed'] ?? 0) + (k['skipped'] ?? 0) + (k['inDoubt'] ?? 0)).toBe(120);
    expect(k['cancelled']).toBeGreaterThan(0);
    expect((await a.call('POST', `/api/engine/teams/${teamId}/campaigns/${c3}/actions/resume`)).status).toBe(409);

    // No recipient got more than one SES call (NFR-SAFE-02).
    const perAddress = new Map<string, number>();
    for (const call of sys.ses.calls) perAddress.set(`${call.campaignId}/${call.to}`, (perAddress.get(`${call.campaignId}/${call.to}`) ?? 0) + 1);
    expect(Math.max(...perAddress.values())).toBe(1);

    // Step 22: sign out; the old cookie returns 401.
    const oldCookie = a.cookies.get('percy_sid') ?? '';
    await a.ok('POST', '/auth/logout');
    const replay = await sys.http({ httpMethod: 'GET', path: `/api/engine/teams/${teamId}/campaigns`, headers: { cookie: `percy_sid=${oldCookie}` } });
    expect(replay.statusCode).toBe(401);
    expect(sys.errors).toEqual([]);
  });
});
