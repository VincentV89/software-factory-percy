import { z } from 'zod';
import { Forbidden, NotFound, Router, json, parseBody, type Logger, type RouteContext } from '@percy/shared';
import type { OfficerInvitations } from './officer-invitations';
import { isAgencyAdmin, principalFrom, teamRoleSchema, tierSchema, type AuditClient, type Principal } from '@percy/platform-contract';
import type { SessionRepo } from './session-repo';
import type { TenancyRepo } from './tenancy-repo';

export interface PlatformApiDeps {
  tenancy: TenancyRepo;
  sessions: SessionRepo;
  audit: AuditClient;
  logger: Logger;
  invitations?: OfficerInvitations;
  testingEnabled?: boolean;
}

const nameBody = z.object({ name: z.string().trim().min(1).max(120) });
const teamBody = nameBody.extend({ tier: tierSchema.optional() });
const reasonBody = z.object({ reason: z.string().trim().min(3).max(500) });
const tierBody = z.object({ tier: tierSchema });
const rolesBody = z.object({ roles: z.array(teamRoleSchema).min(1) });
const emailParam = z.string().trim().toLowerCase().email();

function requirePlatformAdmin(p: Principal): void {
  if (!p.platformAdmin) throw new Forbidden();
}

function requireAgencyAdmin(p: Principal, agencyId: string): void {
  if (!isAgencyAdmin(p, agencyId)) throw new Forbidden();
}

export function createPlatformApi(deps: PlatformApiDeps): Router {
  const { tenancy, audit } = deps;
  const r = new Router(deps.logger);

  const record = (ctx: RouteContext, p: Principal, action: string, targetType: string, targetId: string, extra: { agencyId?: string; teamId?: string; reason?: string; detail?: Record<string, string> } = {}): Promise<void> =>
    audit.record({ actor: p.officerId, action, targetType, targetId, outcome: 'success', requestId: ctx.requestId, ...extra });

  const teamOr404 = async (teamId: string) => {
    const team = await tenancy.getTeam(teamId);
    if (!team) throw new NotFound();
    return team;
  };

  r.get('/api/platform/me', async (ctx) => {
    const p = principalFrom(ctx.event);
    const session = await deps.sessions.get(p.sessionId);
    const officer = await tenancy.getOfficer(p.officerId);
    return json(200, { officerId: p.officerId, email: officer?.email, platformAdmin: p.platformAdmin, agencyAdmin: p.agencyAdmin, teams: p.teams, csrfToken: session?.csrfToken, testingEnabled: deps.testingEnabled ?? false });
  });

  r.post('/api/platform/officer-invitations', async (ctx) => {
    const p = principalFrom(ctx.event);
    requirePlatformAdmin(p);
    if (!deps.invitations) throw new NotFound('Officer invitations are not available.');
    const body = parseBody(z.object({ email: emailParam }), ctx.json());
    const invitation = await deps.invitations.invite(body.email);
    const officer = await tenancy.ensureOfficer(body.email);
    await record(ctx, p, 'officer.invite', 'officer', officer.officerId);
    return json(201, { officerId: officer.officerId, delivery: invitation.delivery });
  });

  r.get('/api/platform/agencies', async (ctx) => {
    const p = principalFrom(ctx.event);
    if (p.platformAdmin) return json(200, { items: await tenancy.listAgencies() });
    if (p.agencyAdmin.length === 0) throw new Forbidden();
    return json(200, { items: await tenancy.getAgencies(p.agencyAdmin.map((a) => a.agencyId)) });
  });

  r.post('/api/platform/agencies', async (ctx) => {
    const p = principalFrom(ctx.event);
    requirePlatformAdmin(p);
    const body = parseBody(nameBody, ctx.json());
    const agency = await tenancy.createAgency(body.name);
    await record(ctx, p, 'agency.create', 'agency', agency.agencyId, { agencyId: agency.agencyId });
    return json(201, agency);
  });

  for (const action of ['suspend', 'reinstate'] as const) {
    r.post(`/api/platform/agencies/:a/${action}`, async (ctx) => {
      const p = principalFrom(ctx.event);
      requirePlatformAdmin(p);
      const body = parseBody(reasonBody, ctx.json());
      const agencyId = ctx.params['a'] ?? '';
      await tenancy.setStatus({ agencyId }, action === 'suspend' ? 'SUSPENDED' : 'ACTIVE', body.reason, p.officerId);
      await record(ctx, p, `agency.${action}`, 'agency', agencyId, { agencyId, reason: body.reason });
      return json(200, { agencyId, status: action === 'suspend' ? 'SUSPENDED' : 'ACTIVE' });
    });

    r.post(`/api/platform/teams/:t/${action}`, async (ctx) => {
      const p = principalFrom(ctx.event);
      const team = await teamOr404(ctx.params['t'] ?? '');
      requireAgencyAdmin(p, team.agencyId);
      const body = parseBody(reasonBody, ctx.json());
      await tenancy.setStatus({ teamId: team.teamId }, action === 'suspend' ? 'SUSPENDED' : 'ACTIVE', body.reason, p.officerId);
      await record(ctx, p, `team.${action}`, 'team', team.teamId, { agencyId: team.agencyId, teamId: team.teamId, reason: body.reason });
      return json(200, { teamId: team.teamId, status: action === 'suspend' ? 'SUSPENDED' : 'ACTIVE' });
    });
  }

  r.get('/api/platform/agencies/:a/teams', async (ctx) => {
    const p = principalFrom(ctx.event);
    const agencyId = ctx.params['a'] ?? '';
    requireAgencyAdmin(p, agencyId);
    return json(200, { items: await tenancy.listTeams(agencyId) });
  });

  r.post('/api/platform/agencies/:a/teams', async (ctx) => {
    const p = principalFrom(ctx.event);
    const agencyId = ctx.params['a'] ?? '';
    requireAgencyAdmin(p, agencyId);
    const body = parseBody(teamBody, ctx.json());
    if (body.tier && body.tier !== 'standard' && !p.platformAdmin) throw new Forbidden('Only platform admins assign tiers.');
    const team = await tenancy.createTeam(agencyId, body.name, body.tier ?? 'standard');
    await record(ctx, p, 'team.create', 'team', team.teamId, { agencyId, teamId: team.teamId });
    return json(201, team);
  });

  r.patch('/api/platform/teams/:t', async (ctx) => {
    const p = principalFrom(ctx.event);
    requirePlatformAdmin(p);
    const body = parseBody(tierBody, ctx.json());
    const team = await tenancy.setTier(ctx.params['t'] ?? '', body.tier);
    await record(ctx, p, 'team.tier.change', 'team', team.teamId, { agencyId: team.agencyId, teamId: team.teamId, detail: { tier: body.tier } });
    return json(200, team);
  });

  r.get('/api/platform/teams/:t/members', async (ctx) => {
    const p = principalFrom(ctx.event);
    const team = await teamOr404(ctx.params['t'] ?? '');
    requireAgencyAdmin(p, team.agencyId);
    const members = await tenancy.teamMembers(team.teamId);
    const withEmail = await Promise.all(members.map(async (m) => ({ ...m, email: (await tenancy.getOfficer(m.officerId))?.email })));
    return json(200, { items: withEmail });
  });

  r.put('/api/platform/teams/:t/members/:email', async (ctx) => {
    const p = principalFrom(ctx.event);
    const team = await teamOr404(ctx.params['t'] ?? '');
    requireAgencyAdmin(p, team.agencyId);
    const body = parseBody(rolesBody, ctx.json());
    const officer = await tenancy.ensureOfficer(parseBody(emailParam, ctx.params['email']));
    await tenancy.setMembership(officer.officerId, team, body.roles);
    await record(ctx, p, 'membership.set', 'officer', officer.officerId, { agencyId: team.agencyId, teamId: team.teamId, detail: { roles: body.roles.join(',') } });
    return json(200, { officerId: officer.officerId, teamId: team.teamId, roles: body.roles });
  });

  r.del('/api/platform/teams/:t/members/:email', async (ctx) => {
    const p = principalFrom(ctx.event);
    const team = await teamOr404(ctx.params['t'] ?? '');
    requireAgencyAdmin(p, team.agencyId);
    const officer = await tenancy.findOfficerByEmail(parseBody(emailParam, ctx.params['email']));
    if (!officer || !(await tenancy.removeMembership(officer.officerId, team.teamId))) throw new NotFound();
    await record(ctx, p, 'membership.remove', 'officer', officer.officerId, { agencyId: team.agencyId, teamId: team.teamId });
    return { statusCode: 204, body: '' };
  });

  for (const [method, granted] of [['PUT', true], ['DELETE', false]] as const) {
    r.add(method, '/api/platform/agencies/:a/admins/:email', async (ctx) => {
      const p = principalFrom(ctx.event);
      const agencyId = ctx.params['a'] ?? '';
      requireAgencyAdmin(p, agencyId);
      if (!(await tenancy.getAgency(agencyId))) throw new NotFound();
      const officer = await tenancy.ensureOfficer(parseBody(emailParam, ctx.params['email']));
      await tenancy.setAgencyAdmin(officer.officerId, agencyId, granted);
      await record(ctx, p, granted ? 'agency-admin.grant' : 'agency-admin.revoke', 'officer', officer.officerId, { agencyId });
      return json(200, { officerId: officer.officerId, agencyId, agencyAdmin: granted });
    });

    r.add(method, '/api/platform/platform-admins/:email', async (ctx) => {
      const p = principalFrom(ctx.event);
      requirePlatformAdmin(p);
      const officer = await tenancy.ensureOfficer(parseBody(emailParam, ctx.params['email']));
      await tenancy.setPlatformAdmin(officer.officerId, granted);
      await record(ctx, p, granted ? 'platform-admin.grant' : 'platform-admin.revoke', 'officer', officer.officerId);
      return json(200, { officerId: officer.officerId, platformAdmin: granted });
    });
  }

  return r;
}
