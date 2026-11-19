import { describe, expect, it } from 'vitest';
import { createSystem } from '@percy/local';
import { Officer, setupTenancy } from './helpers';

 describe('officer invitation permissions', () => {
  it('only platform admins can invite; inviting alone grants no access and audits no address', async () => {
    const sys = createSystem();
    const tenancy = await setupTenancy(sys, { 'member@percy.test': ['member'] });
    const member = await new Officer(sys, 'member@percy.test').signIn();
    expect((await member.call('POST', '/api/platform/officer-invitations', { email: 'new@percy.test' })).status).toBe(403);
    await tenancy.admin.ok('PUT', `/api/platform/agencies/${tenancy.agencyId}/admins/${encodeURIComponent(member.email)}`);
    expect((await member.call('POST', '/api/platform/officer-invitations', { email: 'new@percy.test' })).status).toBe(403);
    const result = await tenancy.admin.call('POST', '/api/platform/officer-invitations', { email: '  NEW@percy.test ' });
    expect(result).toMatchObject({ status: 201, body: { delivery: 'local' } });
    const invited = await new Officer(sys, 'new@percy.test').signIn();
    expect(invited.me).toMatchObject({ platformAdmin: false, teams: [] });
    const records = sys.audit.events.filter((event) => event.action === 'officer.invite');
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain('@');
  });
});
