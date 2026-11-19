import { Forbidden, Unauthenticated, constantTimeEqual, type Logger } from '@percy/shared';
import { hasAnyRole, type AuditClient, type Principal } from '@percy/platform-contract';
import { parseCookies, SESSION_COOKIE } from './cookies';
import { sessionState, type SessionPolicy, type SessionRepo } from './session-repo';
import type { TenancyRepo } from './tenancy-repo';

export interface AuthorizeRequest {
  method: string;
  path: string;
  cookieHeader?: string;
  csrfHeader?: string;
  requestId: string;
}

export interface AuthorizerDeps {
  sessions: SessionRepo;
  tenancy: TenancyRepo;
  audit: AuditClient;
  policy: SessionPolicy;
  now: () => number;
  logger: Logger;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const NO_ROLE_ALLOWED = new Set(['/api/platform/me']);

/** Resolve roles live on every request (ADR-02): suspension or removal applies on the next call. */
export async function resolvePrincipal(tenancy: TenancyRepo, officerId: string, sessionId: string): Promise<Principal> {
  const grants = await tenancy.grants(officerId);
  const teams = await tenancy.getTeams(grants.memberships.map((m) => m.teamId));
  const agencies = await tenancy.getAgencies([...teams.map((t) => t.agencyId), ...grants.agencyAdmin]);
  const agencyById = new Map(agencies.map((a) => [a.agencyId, a]));
  const teamById = new Map(teams.map((t) => [t.teamId, t]));
  const principalTeams: Principal['teams'] = [];
  for (const m of grants.memberships) {
    const team = teamById.get(m.teamId);
    const agency = team && agencyById.get(team.agencyId);
    if (!team || !agency || team.status !== 'ACTIVE' || agency.status !== 'ACTIVE' || m.roles.length === 0) continue;
    principalTeams.push({ teamId: team.teamId, teamName: team.name, agencyId: agency.agencyId, agencyName: agency.name, tier: team.tier, roles: m.roles });
  }
  const agencyAdmin = grants.agencyAdmin
    .map((id) => agencyById.get(id))
    .filter((a): a is NonNullable<typeof a> => !!a && a.status === 'ACTIVE')
    .map((a) => ({ agencyId: a.agencyId, agencyName: a.name }));
  return { officerId, platformAdmin: grants.platformAdmin, agencyAdmin, teams: principalTeams, sessionId };
}

/**
 * The REQUEST authorizer use case. Throws Unauthenticated (API Gateway answers 401) or
 * Forbidden (deny policy, 403); otherwise returns the principal for the handler.
 */
export async function authorize(req: AuthorizeRequest, deps: AuthorizerDeps): Promise<Principal> {
  const now = deps.now();
  const cookie = parseCookies(req.cookieHeader)[SESSION_COOKIE];
  if (!cookie) throw new Unauthenticated();
  const session = await deps.sessions.findByCookie(cookie);
  if (!session) throw new Unauthenticated();
  const state = sessionState(session, now, deps.policy);
  if (state !== 'active') {
    await deps.sessions.delete(session.sessionId);
    throw new Unauthenticated('Your session has expired.');
  }
  const deny = async (reason: string): Promise<never> => {
    await deps.audit.record({ actor: session.officerId, action: 'authorization.denied', targetType: 'route', targetId: `${req.method} ${req.path}`, outcome: 'denied', requestId: req.requestId, reason });
    throw new Forbidden();
  };
  if (!SAFE_METHODS.has(req.method.toUpperCase())) {
    if (!req.csrfHeader || !constantTimeEqual(req.csrfHeader, session.csrfToken)) return deny('csrf');
  }
  const principal = await resolvePrincipal(deps.tenancy, session.officerId, session.sessionId);
  if (!hasAnyRole(principal) && !NO_ROLE_ALLOWED.has(req.path)) return deny('no-roles');
  if (now - session.lastSeenAt > deps.policy.touchAfterMs) await deps.sessions.touch(session.sessionId, now);
  return principal;
}
