import { describe, expect, it } from 'vitest';
import { createSystem } from '@percy/local';
import { VirtualClock } from '@percy/shared';
import type { RecipientVerification } from '@percy/contactsg';
import { campaignState, launch, Officer, sim } from './helpers';

interface VerificationResponse {
  region: string;
  cursor?: string;
  items: { email: string; verification: { status: string; allowed: boolean } }[];
}

describe('SES verification is live and shared by UI and sends', () => {
  it('allows a newly verified recipient on retry without changing configuration', async () => {
    let verified = false;
    const reader: RecipientVerification = { snapshot: async () => ({ region: 'ap-southeast-1', checkedAt: new Date().toISOString(), identities: [{ name: 'fresh@recipient.test', type: 'EMAIL_ADDRESS', status: verified ? 'SUCCESS' : 'PENDING', verified }] }) };
    const sys = createSystem({ clock: new VirtualClock(), recipientVerification: reader });
    const run = await launch(sys, ['fresh@recipient.test'], { send: false });
    const url = `/api/contacts/teams/${run.teamId}/lists/${run.listId}/recipient-verification`;
    expect((await run.a.ok<VerificationResponse>('GET', url)).items[0]?.verification).toMatchObject({ status: 'PENDING', allowed: false });
    const send = () => run.a.ok('POST', `/api/engine/teams/${run.teamId}/campaigns/${run.campaignId}/actions/schedule`, { at: 'now' });
    await send(); await sys.runFor(5000);
    expect(await campaignState(run.a, run.teamId, run.campaignId)).toMatchObject({ state: 'APPROVED', error: expect.stringContaining('not verified in SES') });
    expect(sys.ses.calls).toHaveLength(0);
    verified = true;
    expect((await run.a.ok<VerificationResponse>('GET', url)).items[0]?.verification).toMatchObject({ status: 'VERIFIED_EMAIL', allowed: true });
    await send(); await sys.runFor(10_000);
    expect(sys.ses.calls).toHaveLength(1);
    expect(await campaignState(run.a, run.teamId, run.campaignId)).toMatchObject({ state: 'COMPLETED' });
  });

  it('checks again at send time rather than trusting a previously verified UI result', async () => {
    let verified = true;
    const sys = createSystem({ clock: new VirtualClock(), recipientVerification: { snapshot: async () => ({ region: 'ap-southeast-1', checkedAt: new Date().toISOString(), identities: [{ name: 'fresh@recipient.test', type: 'EMAIL_ADDRESS', status: verified ? 'SUCCESS' : 'FAILED', verified }] }) } });
    const run = await launch(sys, ['fresh@recipient.test'], { send: false });
    const url = `/api/contacts/teams/${run.teamId}/lists/${run.listId}/recipient-verification`;
    expect((await run.a.ok<VerificationResponse>('GET', url)).items[0]?.verification.allowed).toBe(true);
    verified = false;
    await run.a.ok('POST', `/api/engine/teams/${run.teamId}/campaigns/${run.campaignId}/actions/schedule`, { at: 'now' });
    await sys.runFor(5000);
    expect(sys.ses.calls).toHaveLength(0);
    expect((await campaignState(run.a, run.teamId, run.campaignId)).state).toBe('APPROVED');
  });

  it('returns 503 for a status outage and fails the freeze closed with a retryable campaign', async () => {
    const sys = createSystem({ clock: new VirtualClock(), recipientVerification: { snapshot: () => Promise.reject(new Error('SES unavailable')) } });
    const run = await launch(sys, ['fresh@recipient.test'], { send: false });
    expect((await run.a.call('GET', `/api/contacts/teams/${run.teamId}/lists/${run.listId}/recipient-verification`)).status).toBe(503);
    await run.a.ok('POST', `/api/engine/teams/${run.teamId}/campaigns/${run.campaignId}/actions/schedule`, { at: 'now' });
    await sys.runFor(5000);
    expect(sys.ses.calls).toHaveLength(0);
    expect(await campaignState(run.a, run.teamId, run.campaignId)).toMatchObject({ state: 'APPROVED', error: expect.stringContaining('SES verification status is unavailable') });
  });

  it('paginates only the requested list and rejects foreign team access before looking up SES', async () => {
    let reads = 0;
    const sys = createSystem({ clock: new VirtualClock(), recipientVerification: { snapshot: async () => { reads++; return { region: 'ap-southeast-1', checkedAt: new Date().toISOString(), identities: [{ name: 'private-identity@elsewhere.test', type: 'EMAIL_ADDRESS', status: 'SUCCESS', verified: true }] }; } } });
    const run = await launch(sys, sim(55), { send: false });
    const url = `/api/contacts/teams/${run.teamId}/lists/${run.listId}/recipient-verification`;
    const otherAgency = await run.admin.ok<{ agencyId: string }>('POST', '/api/platform/agencies', { name: 'Other' });
    const otherTeam = await run.admin.ok<{ teamId: string }>('POST', `/api/platform/agencies/${otherAgency.agencyId}/teams`, { name: 'Other' });
    await run.admin.ok('PUT', `/api/platform/teams/${otherTeam.teamId}/members/other%40percy.test`, { roles: ['member'] });
    const other = await new Officer(sys, 'other@percy.test').signIn();
    expect((await other.call('GET', url)).status).toBe(404);
    expect(reads).toBe(0);
    const first = await run.a.ok<VerificationResponse>('GET', url);
    expect(first.items).toHaveLength(50);
    expect(first.items.every((item) => item.verification.status === 'SIMULATOR' && item.verification.allowed)).toBe(true);
    expect(JSON.stringify(first)).not.toContain('private-identity@elsewhere.test');
    expect(first.cursor).toBeTruthy();
    expect((await run.a.ok<VerificationResponse>('GET', url + '?cursor=' + encodeURIComponent(first.cursor ?? ''))).items).toHaveLength(5);
  });
});
