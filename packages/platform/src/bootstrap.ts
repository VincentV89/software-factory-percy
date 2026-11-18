import type { AuditClient } from '@percy/platform-contract';
import type { TenancyRepo } from './tenancy-repo';

/**
 * Deploy-time bootstrap of the first platform admin (FR-TEN-06). It is the only path that grants
 * platform_admin without an existing platform admin, and it refuses once one exists unless forced.
 */
export async function bootstrapPlatformAdmin(tenancy: TenancyRepo, audit: AuditClient, email: string, opts: { force?: boolean } = {}): Promise<{ officerId: string; created: boolean }> {
  const existing = await tenancy.platformAdminCount();
  if (existing > 0 && !opts.force) throw new Error('A platform admin already exists; grant further admins through the admin API.');
  const officer = await tenancy.ensureOfficer(email);
  await tenancy.setPlatformAdmin(officer.officerId, true);
  await audit.record({ actor: 'bootstrap', action: 'platform-admin.grant', targetType: 'officer', targetId: officer.officerId, outcome: 'success', requestId: 'bootstrap' });
  return { officerId: officer.officerId, created: true };
}
