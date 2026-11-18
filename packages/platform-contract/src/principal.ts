import { z } from 'zod';
import { Forbidden, NotFound, Unauthenticated, type ApiEvent } from '@percy/shared';

export const TIERS = ['standard', 'bulk'] as const;
export const tierSchema = z.enum(TIERS);
export type TierId = z.infer<typeof tierSchema>;

export const TEAM_ROLES = ['member', 'approver'] as const;
export const teamRoleSchema = z.enum(TEAM_ROLES);
export type TeamRole = z.infer<typeof teamRoleSchema>;

export const principalTeamSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  agencyId: z.string(),
  agencyName: z.string(),
  tier: tierSchema,
  roles: z.array(teamRoleSchema),
});
export type PrincipalTeam = z.infer<typeof principalTeamSchema>;

/** Authorizer output passed to every /api/* handler (design 7.1 step 3). */
export const principalSchema = z.object({
  officerId: z.string(),
  platformAdmin: z.boolean(),
  agencyAdmin: z.array(z.object({ agencyId: z.string(), agencyName: z.string() })),
  teams: z.array(principalTeamSchema),
  sessionId: z.string(),
});
export type Principal = z.infer<typeof principalSchema>;

export function hasAnyRole(p: Principal): boolean {
  return p.platformAdmin || p.agencyAdmin.length > 0 || p.teams.length > 0;
}

export function isAgencyAdmin(p: Principal, agencyId: string): boolean {
  return p.platformAdmin || p.agencyAdmin.some((a) => a.agencyId === agencyId);
}

/** Read the principal the authorizer placed on the request context. */
export function principalFrom(event: ApiEvent): Principal {
  const raw = event.requestContext?.authorizer?.['principal'];
  if (typeof raw !== 'string') throw new Unauthenticated();
  return principalSchema.parse(JSON.parse(raw));
}

/**
 * Resolve a team the caller may act in. Unknown or foreign team ids return 404, never 403,
 * so a caller cannot probe other teams' existence (FR-TEN-03).
 */
export function requireTeam(p: Principal, teamId: string): PrincipalTeam {
  const team = p.teams.find((t) => t.teamId === teamId);
  if (!team) throw new NotFound();
  return team;
}

export function requireAnyRole(p: Principal): void {
  if (!hasAnyRole(p)) throw new Forbidden('Your access has not been set up.');
}
