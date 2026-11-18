import { describe, expect, it } from 'vitest';
import { VirtualClock, hashOf } from '@percy/shared';
import { QUEUES, createSystem, type PercySystem } from '@percy/local';
import { ObjectSnapshotReader } from '@percy/contactsg-contract';
import { Officer, campaignState, importCsv, launch, setupTenancy, sim } from './helpers';

async function team(sys: PercySystem) {
  const t = await setupTenancy(sys, { 'a@percy.test': ['member', 'approver'] });
  const a = await new Officer(sys, 'a@percy.test').signIn();
  const list = await a.ok<{ listId: string }>('POST', `/api/contacts/teams/${t.teamId}/lists`, { name: 'L' });
  return { ...t, a, listId: list.listId };
}

describe('imports (FR-CON-02..06, FR-SUP-03)', () => {
  it('normalises addresses so differently-written duplicates are one contact', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    const t = await team(sys);
    const out = await importCsv(sys, t.a, t.teamId, t.listId, 'email,name\n  Alice@Example.gov.sg ,A\nalice@example.gov.sg,B');
    expect(out['counts']).toMatchObject({ totalRows: 2, imported: 1, duplicates: 1 });
    expect(sys.kv.scan('contactsg-contacts').filter((i) => String(i['sk']).startsWith('CONTACT#'))).toHaveLength(1);
    // Re-importing the same address in a later import counts as updated.
    const again = await importCsv(sys, t.a, t.teamId, t.listId, 'email,name\nALICE@example.gov.sg,C');
    expect(again['counts']).toMatchObject({ imported: 0, updated: 1 });
    expect((await t.a.ok<{ memberCount: number }>('GET', `/api/contacts/teams/${t.teamId}/lists/${t.listId}`)).memberCount).toBe(1);
  });

  it.each([
    ['too many attribute columns', `email,${Array.from({ length: 21 }, (_, i) => `c${i}`).join(',')}\na@b.co${',x'.repeat(21)}`, 'the limit is 20'],
    ['no email column', 'name\nAnn', '"email" column'],
    ['not UTF-8', Buffer.from([0x65, 0x6d, 0x61, 0x69, 0x6c, 0x0a, 0xff, 0xfe]).toString('latin1'), 'UTF-8'],
  ])('a file with %s fails naming the limit and writes no contacts', async (_label, csv, message) => {
    const sys = createSystem({ clock: new VirtualClock() });
    const t = await team(sys);
    const body = _label === 'not UTF-8' ? Buffer.from([0x65, 0x6d, 0x61, 0x69, 0x6c, 0x0a, 0xff, 0xfe]) : Buffer.from(csv);
    const created = await t.a.ok<{ importId: string; upload: { fields: Record<string, string> } }>('POST', `/api/contacts/teams/${t.teamId}/lists/${t.listId}/imports`);
    await sys.upload(created.upload.fields['key'] ?? '', body);
    await sys.settle();
    const rec = await t.a.ok<{ status: string; reason: string }>('GET', `/api/contacts/teams/${t.teamId}/lists/${t.listId}/imports/${created.importId}`);
    expect(rec.status).toBe('FAILED');
    expect(rec.reason).toContain(message);
    expect(sys.kv.scan('contactsg-contacts').filter((i) => String(i['sk']).startsWith('MEMBER#'))).toHaveLength(0);
  });

  it('a forced failure ends FAILED with a reason and a re-upload works (FR-CON-06)', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    const t = await team(sys);
    const created = await t.a.ok<{ importId: string; upload: { fields: Record<string, string> } }>('POST', `/api/contacts/teams/${t.teamId}/lists/${t.listId}/imports`);
    const key = created.upload.fields['key'] ?? '';
    const real = sys.imports.importChunk.bind(sys.imports);
    sys.imports.importChunk = async () => {
      throw new Error('forced');
    };
    await sys.upload(key, Buffer.from('email\na@b.co'));
    await sys.settle();
    const failed = await t.a.ok<{ status: string; reason: string }>('GET', `/api/contacts/teams/${t.teamId}/lists/${t.listId}/imports/${created.importId}`);
    expect(failed).toMatchObject({ status: 'FAILED', reason: expect.stringContaining('upload the file again') });
    sys.imports.importChunk = real;
    expect((await importCsv(sys, t.a, t.teamId, t.listId, 'email\na@b.co'))['status']).toBe('COMPLETED');
  });

  it('a retried chunk is idempotent', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    const t = await team(sys);
    const created = await t.a.ok<{ importId: string; upload: { fields: Record<string, string> } }>('POST', `/api/contacts/teams/${t.teamId}/lists/${t.listId}/imports`);
    const key = created.upload.fields['key'] ?? '';
    await sys.store.put('contactsg-uploads', key, 'email,name\na@b.co,A\nb@b.co,B\na@b.co,A2');
    const ref = { agencyId: t.agencyId, teamId: t.teamId, listId: t.listId, importId: created.importId };
    await sys.imports.onScanResult(key, 'NO_THREATS_FOUND', 'r').catch(() => undefined);
    await sys.settle();
    const v = (await sys.imports.listForList(t.teamId, t.listId))[0];
    expect(v?.status).toBe('COMPLETED');
    // Re-run one chunk as Step Functions would on a retry: identical outcome, no counter drift.
    const again = await sys.imports.importChunk(ref, `chunks/${created.importId}/00000.jsonl`);
    expect(again).toMatchObject({ imported: 2, duplicates: 1, memberDelta: 2, eligibleDelta: 2 });
    expect((await t.a.ok<{ memberCount: number; eligibleCount: number }>('GET', `/api/contacts/teams/${t.teamId}/lists/${t.listId}`))).toMatchObject({ memberCount: 2, eligibleCount: 2 });
  });
});

describe('audience count and suppressions (FR-CON-07, FR-SUP-01..04, FR-UNS-02)', () => {
  it('10 members, 2 globally and 1 agency-suppressed → 7; another agency is unaffected', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    const t = await team(sys);
    const emails = sim(10);
    await importCsv(sys, t.a, t.teamId, t.listId, ['email', ...emails].join('\n'));
    for (const e of emails.slice(0, 2)) await sys.suppressions.suppress({ addrHash: hashOf(e), scope: 'GLOBAL', reason: 'HARD_BOUNCE' });
    await sys.suppressions.suppress({ addrHash: hashOf(emails[2] ?? ''), scope: 'AGENCY', agencyId: t.agencyId, reason: 'UNSUBSCRIBE' });
    // Idempotent: repeating a suppression changes nothing.
    await sys.suppressions.suppress({ addrHash: hashOf(emails[0] ?? ''), scope: 'GLOBAL', reason: 'HARD_BOUNCE' });
    expect((await t.a.ok<{ audienceCount: number }>('GET', `/api/contacts/teams/${t.teamId}/lists/${t.listId}/audience-count`)).audienceCount).toBe(7);

    const other = await t.admin.ok<{ agencyId: string }>('POST', '/api/platform/agencies', { name: 'Other' });
    const otherTeam = await t.admin.ok<{ teamId: string }>('POST', `/api/platform/agencies/${other.agencyId}/teams`, { name: 'OT' });
    await t.admin.ok('PUT', `/api/platform/teams/${otherTeam.teamId}/members/o%40percy.test`, { roles: ['member'] });
    const o = await new Officer(sys, 'o@percy.test').signIn();
    const ol = await o.ok<{ listId: string }>('POST', `/api/contacts/teams/${otherTeam.teamId}/lists`, { name: 'OL' });
    await importCsv(sys, o, otherTeam.teamId, ol.listId, ['email', ...emails].join('\n'));
    expect((await o.ok<{ audienceCount: number }>('GET', `/api/contacts/teams/${otherTeam.teamId}/lists/${ol.listId}/audience-count`)).audienceCount).toBe(8);
  });

  it('manual agency suppression by an agency admin; members cannot (FR-SUP-04)', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    const t = await team(sys);
    await importCsv(sys, t.a, t.teamId, t.listId, 'email\nx@agency.gov.sg\ny@agency.gov.sg');
    expect((await t.a.call('POST', `/api/contacts/agencies/${t.agencyId}/suppressions`, { email: 'x@agency.gov.sg' })).status).toBe(403);
    await t.admin.ok('POST', `/api/contacts/agencies/${t.agencyId}/suppressions`, { email: 'X@agency.gov.sg' });
    expect((await t.a.ok<{ audienceCount: number }>('GET', `/api/contacts/teams/${t.teamId}/lists/${t.listId}/audience-count`)).audienceCount).toBe(1);
  });
});

describe('freeze (FR-SCH-03/04, NFR-INF-05)', () => {
  it('a list of 10 with 3 suppressed freezes to exactly 7 recipients with only the used fields', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    const t = await team(sys);
    const emails = sim(10);
    await importCsv(sys, t.a, t.teamId, t.listId, ['email,name,city', ...emails.map((e, i) => `${e},N${i},C${i}`)].join('\n'));
    for (const e of emails.slice(7)) await sys.suppressions.suppress({ addrHash: hashOf(e), scope: 'GLOBAL', reason: 'COMPLAINT' });
    await sys.freezes.handle({ freezeId: 'f1', requestRef: 'team:cmp', agencyId: t.agencyId, teamId: t.teamId, listId: t.listId, requiredFields: ['name'] });
    const frozen = sys.busEvents.find((e) => e.type === 'AudienceFrozen');
    expect(frozen?.payload).toMatchObject({ freezeId: 'f1', recipientCount: 7 });
    const reader = new ObjectSnapshotReader(sys.store, 'contactsg-snapshots');
    const manifest = await reader.manifest(String(frozen?.payload['manifestKey']));
    const part = await reader.part(manifest?.parts[0]?.key ?? '');
    expect(part).toHaveLength(7);
    expect(Object.keys(part?.[0]?.attrs ?? {})).toEqual(['name']);
    // Re-delivery of the same request is a no-op.
    expect(await sys.freezes.handle({ freezeId: 'f1', requestRef: 'team:cmp', agencyId: t.agencyId, teamId: t.teamId, listId: t.listId, requiredFields: ['name'] })).toBe('skipped');
  });

  it('missing merge fields block the send: 2 of 5 lack name → APPROVED with "name: 2"', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    const l = await launch(sys, sim(5), { extraCsvColumns: (i) => (i < 2 ? '' : `N${i}`) });
    await sys.runFor(5000);
    const c = await campaignState(l.a, l.teamId, l.campaignId);
    expect(c.state).toBe('APPROVED');
    expect(c.error).toContain('name: 2');
    expect(sys.ses.calls).toHaveLength(0);
    expect(sys.kv.scan('contactsg-snapshots')).toHaveLength(0);
    // The list hold is released, so the list can be deleted again.
    expect((await l.a.call('DELETE', `/api/contacts/teams/${l.teamId}/lists/${l.listId}`)).status).toBe(204);
  });

  it('an address outside the dev allow-list fails the freeze with a clear error', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    const l = await launch(sys, ['success+ok@simulator.amazonses.com', 'someone@gmail.com']);
    await sys.runFor(5000);
    const c = await campaignState(l.a, l.teamId, l.campaignId);
    expect(c.state).toBe('APPROVED');
    expect(c.error).toContain('not on this instance');
    expect(sys.ses.calls).toHaveLength(0);
  });

  it('a list used by a scheduled campaign cannot be deleted (FR-CON-01)', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    const l = await launch(sys, sim(2), { send: false });
    await l.a.ok('POST', `/api/engine/teams/${l.teamId}/campaigns/${l.campaignId}/actions/schedule`, { at: new Date(sys.clock.now() + 600_000).toISOString() });
    expect((await l.a.call('DELETE', `/api/contacts/teams/${l.teamId}/lists/${l.listId}`)).status).toBe(409);
    await l.a.ok('POST', `/api/engine/teams/${l.teamId}/campaigns/${l.campaignId}/actions/unschedule`);
    expect((await l.a.call('DELETE', `/api/contacts/teams/${l.teamId}/lists/${l.listId}`)).status).toBe(204);
  });

  it('domain events reach the test consumer queue (FR-CON-08)', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    await launch(sys, ['bounce+x@simulator.amazonses.com', 'success+y@simulator.amazonses.com']);
    await sys.runFor(60_000);
    const types = sys.broker.peek(QUEUES.testEvents).map((r) => (r.body as { detail: { type: string } }).detail.type);
    expect(types).toEqual(expect.arrayContaining(['ImportCompleted', 'AudienceFrozen', 'SuppressionAdded']));
  });
});
