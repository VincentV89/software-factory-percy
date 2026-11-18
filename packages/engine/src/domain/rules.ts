import { Forbidden, ValidationError } from '@percy/shared';
import type { Principal } from '@percy/platform-contract';

/** Kill switch scope rules (FR-CTL-04). Scope is GLOBAL, AGENCY#<id> or TEAM#<id>. */
export type KillScope = string;

export function scopesCovering(agencyId: string, teamId: string): KillScope[] {
  return ['GLOBAL', `AGENCY#${agencyId}`, `TEAM#${teamId}`];
}

export function parseScope(scope: string): { kind: 'GLOBAL' } | { kind: 'AGENCY'; agencyId: string } | { kind: 'TEAM'; teamId: string } {
  if (scope === 'GLOBAL') return { kind: 'GLOBAL' };
  const m = /^(AGENCY|TEAM)#([^#\s]+)$/.exec(scope);
  if (!m) throw new ValidationError('Scope must be GLOBAL, AGENCY#<id> or TEAM#<id>.', [{ field: 'scope', reason: 'invalid scope' }]);
  return m[1] === 'AGENCY' ? { kind: 'AGENCY', agencyId: m[2] ?? '' } : { kind: 'TEAM', teamId: m[2] ?? '' };
}

export function validateReason(reason: string | undefined, min = 10, max = 500): string {
  const r = (reason ?? '').trim();
  if (r.length < min || r.length > max) throw new ValidationError(`A reason of ${min}–${max} characters is required.`, [{ field: 'reason', reason: `must be ${min}–${max} characters` }]);
  return r;
}

/**
 * Platform admins may use any scope; agency admins only their own agency or its teams.
 * `teamAgency` resolves a team's agency (Platform's read-only TeamReader).
 */
export async function authorizeScope(p: Principal, scope: string, teamAgency: (teamId: string) => Promise<string | undefined>): Promise<{ agencyId?: string }> {
  const parsed = parseScope(scope);
  if (p.platformAdmin) {
    if (parsed.kind === 'AGENCY') return { agencyId: parsed.agencyId };
    if (parsed.kind === 'TEAM') return { agencyId: await teamAgency(parsed.teamId) };
    return {};
  }
  const own = new Set(p.agencyAdmin.map((a) => a.agencyId));
  if (parsed.kind === 'GLOBAL') throw new Forbidden('Only platform admins can set a global kill switch.');
  if (parsed.kind === 'AGENCY') {
    if (!own.has(parsed.agencyId)) throw new Forbidden();
    return { agencyId: parsed.agencyId };
  }
  const agencyId = await teamAgency(parsed.teamId);
  if (!agencyId || !own.has(agencyId)) throw new Forbidden();
  return { agencyId };
}

/** Schedule window (FR-SCH-01, A16): now, or 5 minutes to 30 days ahead. */
export function checkScheduleTime(at: number, now: number, minMs = 5 * 60_000, maxMs = 30 * 24 * 3600_000): void {
  if (at < now + minMs || at > now + maxMs) throw new ValidationError('The send time must be between 5 minutes and 30 days from now.', [{ field: 'at', reason: 'outside the schedule window' }]);
}
