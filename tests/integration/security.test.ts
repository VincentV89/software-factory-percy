import { describe, expect, it } from 'vitest';
import { VirtualClock } from '@percy/shared';
import { createSystem, type PercySystem } from '@percy/local';
import { Officer, TEMPLATE, importCsv, launch, setupTenancy } from './helpers';

async function twoTeams(sys: PercySystem) {
  const t = await setupTenancy(sys, { 'a@percy.test': ['member', 'approver'], 'other@percy.test': ['member'] });
  const teamB = await t.admin.ok<{ teamId: string }>('POST', `/api/platform/agencies/${t.agencyId}/teams`, { name: 'Team B' });
  await t.admin.ok('PUT', `/api/platform/teams/${teamB.teamId}/members/${encodeURIComponent('b@percy.test')}`, { roles: ['member', 'approver'] });
  await t.admin.ok('PUT', `/api/platform/teams/${teamB.teamId}/members/${encodeURIComponent('b2@percy.test')}`, { roles: ['member', 'approver'] });
  const a = await new Officer(sys, 'a@percy.test').signIn();
  const b = await new Officer(sys, 'b@percy.test').signIn();
  const b2 = await new Officer(sys, 'b2@percy.test').signIn();
  return { ...t, teamA: t.teamId, teamB: teamB.teamId, a, b, b2 };
}

describe('sessions (FR-AUTH-01..04)', () => {
  it('idle timeout, absolute lifetime and revocation return 401', async () => {
    const clock = new VirtualClock();
    const sys = createSystem({ clock });
    await setupTenancy(sys, { 'a@percy.test': ['member'] });
    const a = await new Officer(sys, 'a@percy.test').signIn();
    expect((await a.call('GET', '/api/platform/me')).status).toBe(200);
    await clock.advance(16 * 60_000);
    expect((await a.call('GET', '/api/platform/me')).status).toBe(401);

    await a.signIn();
    const signedInAt = clock.now();
    for (let i = 0; i < 48; i++) {
      await clock.advance(10 * 60_000);
      const s = (await a.call('GET', '/api/platform/me')).status;
      expect(s, `${(clock.now() - signedInAt) / 60_000} min after sign-in`).toBe(clock.now() - signedInAt >= 8 * 3600_000 ? 401 : 200);
    }

    await a.signIn();
    const sid = sys.kv.scan('platform-sessions').find((x) => String(x['pk']).startsWith('SESSION#') && x['officerId'] === a.me?.officerId);
    await sys.kv.delete('platform-sessions', { pk: String(sid?.['pk']), sk: 'META' });
    expect((await a.call('GET', '/api/platform/me')).status).toBe(401);
  });

  it('removing a membership takes effect on the next request (403)', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    const t = await setupTenancy(sys, { 'a@percy.test': ['member'] });
    const a = await new Officer(sys, 'a@percy.test').signIn();
    expect((await a.call('GET', `/api/contacts/teams/${t.teamId}/lists`)).status).toBe(200);
    await t.admin.ok('DELETE', `/api/platform/teams/${t.teamId}/members/${encodeURIComponent('a@percy.test')}`);
    expect((await a.call('GET', `/api/contacts/teams/${t.teamId}/lists`)).status).toBe(403);
  });

  it('an officer without roles gets /me but 403 everywhere else (FR-AUTH-01 AC2)', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    const t = await setupTenancy(sys, {});
    const nobody = await new Officer(sys, 'nobody@percy.test').signIn();
    const me = await nobody.call<{ teams: unknown[]; platformAdmin: boolean }>('GET', '/api/platform/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ teams: [], platformAdmin: false });
    expect((await nobody.call('GET', `/api/contacts/teams/${t.teamId}/lists`)).status).toBe(403);
    expect((await nobody.call('GET', '/api/engine/kill-switches')).status).toBe(403);
  });

  it('CSRF: a POST without a valid token is 403 and changes nothing (FR-AUTH-05)', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    const t = await setupTenancy(sys, { 'a@percy.test': ['member'] });
    const a = await new Officer(sys, 'a@percy.test').signIn();
    const token = a.csrf;
    a.csrf = '';
    expect((await a.call('POST', `/api/contacts/teams/${t.teamId}/lists`, { name: 'x' })).status).toBe(403);
    a.csrf = 'wrong-token';
    expect((await a.call('POST', `/api/contacts/teams/${t.teamId}/lists`, { name: 'x' })).status).toBe(403);
    a.csrf = token;
    expect((await a.ok<{ items: unknown[] }>('GET', `/api/contacts/teams/${t.teamId}/lists`)).items).toHaveLength(0);
    expect(sys.audit.events.filter((e) => e.action === 'authorization.denied' && e.reason === 'csrf')).toHaveLength(2);
  });

  it('bootstrap grants the first platform admin only once (FR-TEN-06)', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    const { bootstrapPlatformAdmin } = await import('@percy/platform');
    await bootstrapPlatformAdmin(sys.tenancy, sys.audit, 'first@percy.test');
    await expect(bootstrapPlatformAdmin(sys.tenancy, sys.audit, 'second@percy.test')).rejects.toThrow(/already exists/);
    const first = await new Officer(sys, 'first@percy.test').signIn();
    expect((await first.call('POST', '/api/platform/agencies', { name: 'Agency X' })).status).toBe(201);
    expect((await first.call('POST', '/api/platform/agencies', { name: 'agency x' })).status).toBe(409);
  });
});

describe('tenancy rules (FR-TEN-01..04, FR-CMP-03/04)', () => {
  it('duplicate team names in one agency are 409; tiers are platform-admin only', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    const t = await setupTenancy(sys, {});
    expect((await t.admin.call('POST', `/api/platform/agencies/${t.agencyId}/teams`, { name: 'e2e team' })).status).toBe(409);
    await t.admin.ok('PUT', `/api/platform/agencies/${t.agencyId}/admins/${encodeURIComponent('aa@percy.test')}`);
    const aa = await new Officer(sys, 'aa@percy.test').signIn();
    expect((await aa.call('PATCH', `/api/platform/teams/${t.teamId}`, { tier: 'bulk' })).status).toBe(403);
    expect((await t.admin.ok<{ tier: string }>('PATCH', `/api/platform/teams/${t.teamId}`, { tier: 'bulk' })).tier).toBe('bulk');
  });

  it('a member without the approver role cannot approve; an agency admin who did not author can', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    const l = await launch(sys, ['success+x@simulator.amazonses.com'], { send: false });
    await l.a.ok('POST', `/api/engine/teams/${l.teamId}/campaigns/${l.campaignId}/actions/schedule`, { at: new Date(sys.clock.now() + 3600_000).toISOString() });
    // An officer of another agency has no access at all.
    const other = await l.admin.ok<{ agencyId: string }>('POST', '/api/platform/agencies', { name: 'Other Agency' });
    await l.admin.ok('PUT', `/api/platform/agencies/${other.agencyId}/admins/${encodeURIComponent('otheradmin@percy.test')}`);
    const otherAdmin = await new Officer(sys, 'otheradmin@percy.test').signIn();
    expect((await otherAdmin.call('GET', `/api/engine/teams/${l.teamId}/campaigns/${l.campaignId}`)).status).toBe(404);
    const c2 = await l.a.ok<{ campaignId: string }>('POST', `/api/engine/teams/${l.teamId}/campaigns`, { name: 'two', templateId: l.templateId, listId: l.listId, senderName: 's' });
    await l.a.ok('POST', `/api/engine/teams/${l.teamId}/campaigns/${c2.campaignId}/actions/submit`);
    expect((await l.a.call('POST', `/api/engine/teams/${l.teamId}/campaigns/${c2.campaignId}/actions/approve`)).status).toBe(403);
    await l.admin.ok('PUT', `/api/platform/agencies/${l.agencyId}/admins/${encodeURIComponent('ag@percy.test')}`);
    const ag = await new Officer(sys, 'ag@percy.test').signIn();
    expect((await ag.call('POST', `/api/engine/teams/${l.teamId}/campaigns/${c2.campaignId}/actions/approve`)).status).toBe(200);
    // Schedule window and unschedule (FR-SCH-01 AC2, FR-SCH-02)
    expect((await l.a.call('POST', `/api/engine/teams/${l.teamId}/campaigns/${c2.campaignId}/actions/schedule`, { at: new Date(sys.clock.now() + 60_000).toISOString() })).status).toBe(400);
    expect(sys.scheduled.size).toBe(1);
    await l.a.ok('POST', `/api/engine/teams/${l.teamId}/campaigns/${l.campaignId}/actions/unschedule`);
    expect(sys.scheduled.size).toBe(0);
    await sys.runFor(2 * 3600_000);
    expect(sys.busEvents.filter((e) => e.type === 'AudienceFrozen')).toHaveLength(0);
  });

  it('a later edit clears approval and later template edits never change a submitted campaign (FR-TPL-05)', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    const l = await launch(sys, ['success+x@simulator.amazonses.com'], { send: false });
    await l.a.ok('PUT', `/api/engine/teams/${l.teamId}/templates/${l.templateId}`, { ...TEMPLATE, subject: 'Changed {{name}}' });
    const c = await l.a.ok<{ templateSnapshot: { subject: string }; state: string }>('GET', `/api/engine/teams/${l.teamId}/campaigns/${l.campaignId}`);
    expect(c).toMatchObject({ state: 'APPROVED', templateSnapshot: { subject: 'Hello {{name}}' } });
    const edited = await l.b.ok<{ state: string; permissions: { canApprove: boolean } }>('PUT', `/api/engine/teams/${l.teamId}/campaigns/${l.campaignId}`, { name: 'renamed' });
    expect(edited.state).toBe('DRAFT');
    await l.b.ok('POST', `/api/engine/teams/${l.teamId}/campaigns/${l.campaignId}/actions/submit`);
    // officer-b is now the last editor and cannot approve (FR-CMP-03)
    expect((await l.b.call('POST', `/api/engine/teams/${l.teamId}/campaigns/${l.campaignId}/actions/approve`)).status).toBe(403);
    expect((await l.b.call('DELETE', `/api/engine/teams/${l.teamId}/campaigns/${l.campaignId}`)).status).toBe(409);
  });
});

describe('FR-TEN-03: team B data is invisible to team A (404, no leak)', () => {
  it('every list, contact, import, template, campaign and report endpoint', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    const s = await twoTeams(sys);
    // Team B data.
    const listB = await s.b.ok<{ listId: string }>('POST', `/api/contacts/teams/${s.teamB}/lists`, { name: 'SecretListB' });
    const impB = await importCsv(sys, s.b, s.teamB, listB.listId, 'email,name\nsuccess+b@simulator.amazonses.com,SecretNameB');
    const tplB = await s.b.ok<{ templateId: string }>('POST', `/api/engine/teams/${s.teamB}/templates`, { ...TEMPLATE, name: 'SecretTemplateB' });
    const cmpB = await s.b.ok<{ campaignId: string }>('POST', `/api/engine/teams/${s.teamB}/campaigns`, { name: 'SecretCampaignB', templateId: tplB.templateId, listId: listB.listId, senderName: 'B' });
    const members = await s.b.ok<{ items: { addrHash: string }[] }>('GET', `/api/contacts/teams/${s.teamB}/lists/${listB.listId}/members`);
    const hashB = members.items[0]?.addrHash ?? '';
    // Team A has its own list for the "own team path, foreign id" variant.
    const listA = await s.a.ok<{ listId: string }>('POST', `/api/contacts/teams/${s.teamA}/lists`, { name: 'A' });
    const tplA = await s.a.ok<{ templateId: string }>('POST', `/api/engine/teams/${s.teamA}/templates`, TEMPLATE);
    const ids = { l: listB.listId, i: String(impB['importId']), tp: tplB.templateId, c: cmpB.campaignId };
    const calls: [string, string, unknown?][] = [];
    for (const t of [s.teamB, s.teamA]) {
      const L = `/api/contacts/teams/${t}/lists`;
      const T = `/api/engine/teams/${t}/templates`;
      const C = `/api/engine/teams/${t}/campaigns`;
      calls.push(
        ['GET', `${L}/${ids.l}`], ['PATCH', `${L}/${ids.l}`, { name: 'x' }], ['DELETE', `${L}/${ids.l}`], ['GET', `${L}/${ids.l}/members`], ['GET', `${L}/${ids.l}/audience-count`],
        ['POST', `${L}/${ids.l}/imports`], ['GET', `${L}/${ids.l}/imports`], ['GET', `${L}/${ids.l}/imports/${ids.i}`], ['GET', `${L}/${ids.l}/imports/${ids.i}/invalid-rows.csv`],
        ['GET', `${T}/${ids.tp}`], ['PUT', `${T}/${ids.tp}`, TEMPLATE], ['DELETE', `${T}/${ids.tp}`], ['POST', `${T}/${ids.tp}/preview`, { listId: ids.l, addrHash: hashB }],
        ['GET', `${C}/${ids.c}`], ['PUT', `${C}/${ids.c}`, { name: 'x' }], ['DELETE', `${C}/${ids.c}`], ['GET', `${C}/${ids.c}/report`],
        ...['submit', 'approve', 'reject', 'schedule', 'unschedule', 'pause', 'resume', 'stop'].map((x) => ['POST', `${C}/${ids.c}/actions/${x}`, { at: 'now', reason: 'x' }] as [string, string, unknown]),
      );
      if (t === s.teamB) calls.push(['GET', L], ['POST', L, { name: 'x' }], ['GET', T], ['POST', T, TEMPLATE], ['GET', C], ['POST', C, { name: 'x', templateId: tplA.templateId, listId: listA.listId, senderName: 's' }]);
    }
    calls.push(['POST', `/api/engine/teams/${s.teamA}/templates/${tplA.templateId}/preview`, { listId: ids.l, addrHash: hashB }]);
    calls.push(['POST', `/api/engine/teams/${s.teamA}/campaigns`, { name: 'x', templateId: tplA.templateId, listId: ids.l, senderName: 's' }]);
    calls.push(['GET', `/api/engine/test/campaigns/${ids.c}/send-log`]);
    for (const [method, path, body] of calls) {
      const res = await s.a.raw(method, path, body);
      expect(res.statusCode, `${method} ${path}`).toBe(404);
      expect(res.body).not.toMatch(/SecretListB|SecretNameB|SecretTemplateB|SecretCampaignB|success\+b@/);
    }
    // Team B's data is untouched.
    expect((await s.b.ok<{ name: string }>('GET', `/api/contacts/teams/${s.teamB}/lists/${listB.listId}`)).name).toBe('SecretListB');
    expect((await s.b.ok<{ name: string }>('GET', `/api/engine/teams/${s.teamB}/campaigns/${cmpB.campaignId}`)).name).toBe('SecretCampaignB');
  });
});

describe('FR-AUD-01: one audit record per action, no PII', () => {
  it('records each covered action exactly once', async () => {
    const clock = new VirtualClock();
    const sys = createSystem({ clock });
    const l = await launch(sys, ['success+1@simulator.amazonses.com', 'success+2@simulator.amazonses.com'], { send: false });
    const T = `/api/engine/teams/${l.teamId}`;
    const reject = await l.a.ok<{ campaignId: string }>('POST', `${T}/campaigns`, { name: 'rej', templateId: l.templateId, listId: l.listId, senderName: 's' });
    await l.a.ok('PUT', `${T}/campaigns/${reject.campaignId}`, { name: 'rej2' });
    await l.a.ok('POST', `${T}/campaigns/${reject.campaignId}/actions/submit`);
    await l.b.ok('POST', `${T}/campaigns/${reject.campaignId}/actions/reject`, { reason: 'fix the subject' });
    await l.a.ok('DELETE', `${T}/campaigns/${reject.campaignId}`);
    await l.a.ok('POST', `${T}/campaigns/${l.campaignId}/actions/schedule`, { at: new Date(clock.now() + 3600_000).toISOString() });
    await l.a.ok('POST', `${T}/campaigns/${l.campaignId}/actions/unschedule`);
    await l.a.ok('POST', `${T}/campaigns/${l.campaignId}/actions/schedule`, { at: 'now' });
    await sys.runFor(1000);
    await l.a.ok('POST', `${T}/campaigns/${l.campaignId}/actions/pause`).catch(() => undefined);
    await sys.runFor(1000);
    await l.a.call('POST', `${T}/campaigns/${l.campaignId}/actions/resume`);
    await sys.runFor(1000);
    await l.a.call('POST', `${T}/campaigns/${l.campaignId}/actions/stop`);
    await l.a.ok('PATCH', `/api/contacts/teams/${l.teamId}/lists/${l.listId}`, { name: 'renamed' });
    const tmp = await l.a.ok<{ listId: string }>('POST', `/api/contacts/teams/${l.teamId}/lists`, { name: 'tmp' });
    await l.a.ok('DELETE', `/api/contacts/teams/${l.teamId}/lists/${tmp.listId}`);
    const tpl = await l.a.ok<{ templateId: string }>('POST', `${T}/templates`, { ...TEMPLATE, name: 'tmp' });
    await l.a.ok('PUT', `${T}/templates/${tpl.templateId}`, { ...TEMPLATE, name: 'tmp2' });
    await l.a.ok('DELETE', `${T}/templates/${tpl.templateId}`);
    await l.admin.ok('PATCH', `/api/platform/teams/${l.teamId}`, { tier: 'bulk' });
    await l.admin.ok('POST', '/api/engine/kill-switches', { scope: 'GLOBAL', reason: 'audit test reason' });
    await l.admin.ok('POST', '/api/engine/kill-switches/clear', { scope: 'GLOBAL', reason: 'done now' });
    await l.admin.ok('POST', `/api/platform/teams/${l.teamId}/suspend`, { reason: 'audit check' });
    await l.admin.ok('POST', `/api/platform/teams/${l.teamId}/reinstate`, { reason: 'audit check' });
    await l.admin.ok('DELETE', `/api/platform/teams/${l.teamId}/members/${encodeURIComponent('officer-a@percy.test')}`);
    await l.a.call('GET', `/api/contacts/teams/${l.teamId}/lists`);
    await l.b.ok('POST', '/auth/logout');

    const count = (action: string, outcome = 'success') => sys.audit.events.filter((e) => e.action === action && e.outcome === outcome).length;
    for (const action of ['campaign.edit', 'campaign.reject', 'campaign.delete', 'campaign.unschedule', 'list.rename', 'list.delete', 'template.update', 'template.delete', 'team.tier.change', 'killswitch.set', 'killswitch.clear', 'team.suspend', 'team.reinstate', 'membership.remove', 'auth.sign-out']) {
      expect(count(action), action).toBe(1);
    }
    expect(count('campaign.schedule')).toBe(2);
    expect(count('campaign.submit')).toBe(2);
    expect(count('campaign.approve')).toBe(1);
    expect(count('campaign.create')).toBe(2);
    expect(count('import.start')).toBe(1);
    expect(count('import.result')).toBe(1);
    expect(count('authorization.denied', 'denied')).toBeGreaterThanOrEqual(1);
    expect(count('auth.sign-in')).toBe(3);
    expect(count('membership.set')).toBe(2);
    for (const e of sys.audit.events) expect(e.requestId).toBeTruthy();
    const json = JSON.stringify(sys.audit.events);
    expect(json).not.toMatch(/@/);
    expect(json).not.toContain('<p>');
    expect(sys.audit.events.find((e) => e.action === 'killswitch.set')).toMatchObject({ scope: 'GLOBAL', reason: 'audit test reason' });
  });
});
