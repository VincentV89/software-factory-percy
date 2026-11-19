import { z } from 'zod';
import { Forbidden, Router, hashOf, json, parseBody, type Logger, type RouteContext } from '@percy/shared';
import { isAgencyAdmin, principalFrom, requireTeam, type Principal, type PrincipalTeam } from '@percy/platform-contract';
import type { ContactSgDeps } from './deps';
import { ImportService } from './imports';
import { ListService } from './lists';
import { SuppressionService } from './suppressions';

const nameBody = z.object({ name: z.string().trim().min(1).max(120) });
const manualSuppressionBody = z.object({ email: z.string().trim().email() });

export function createContactSgApi(d: ContactSgDeps & { logger: Logger }): Router {
  const lists = new ListService(d);
  const imports = new ImportService(d);
  const suppressions = new SuppressionService(d);
  const r = new Router(d.logger);

  const scope = (ctx: RouteContext): { p: Principal; team: PrincipalTeam } => {
    const p = principalFrom(ctx.event);
    return { p, team: requireTeam(p, ctx.params['t'] ?? '') };
  };
  const audit = (ctx: RouteContext, p: Principal, team: PrincipalTeam, action: string, targetType: string, targetId: string): Promise<void> =>
    d.audit.record({ actor: p.officerId, agencyId: team.agencyId, teamId: team.teamId, action, targetType, targetId, outcome: 'success', requestId: ctx.requestId });

  const base = '/api/contacts/teams/:t/lists';

  r.get(base, async (ctx) => {
    const { team } = scope(ctx);
    return json(200, { items: await lists.list(team.teamId) });
  });

  r.post(base, async (ctx) => {
    const { p, team } = scope(ctx);
    const body = parseBody(nameBody, ctx.json());
    const list = await lists.create(team.teamId, team.agencyId, body.name);
    await audit(ctx, p, team, 'list.create', 'list', list.listId);
    return json(201, list);
  });

  r.get(`${base}/:l`, async (ctx) => {
    const { team } = scope(ctx);
    return json(200, await lists.get(team.teamId, ctx.params['l'] ?? ''));
  });

  r.patch(`${base}/:l`, async (ctx) => {
    const { p, team } = scope(ctx);
    const body = parseBody(nameBody, ctx.json());
    const list = await lists.rename(team.teamId, ctx.params['l'] ?? '', body.name);
    await audit(ctx, p, team, 'list.rename', 'list', list.listId);
    return json(200, list);
  });

  r.del(`${base}/:l`, async (ctx) => {
    const { p, team } = scope(ctx);
    const listId = ctx.params['l'] ?? '';
    await lists.delete(team.teamId, listId);
    await audit(ctx, p, team, 'list.delete', 'list', listId);
    return { statusCode: 204, body: '' };
  });

  r.get(`${base}/:l/members`, async (ctx) => {
    const { team } = scope(ctx);
    return json(200, await lists.members(team.teamId, ctx.params['l'] ?? '', ctx.query['cursor']));
  });

  r.get(`${base}/:l/audience-count`, async (ctx) => {
    const { team } = scope(ctx);
    const list = await lists.get(team.teamId, ctx.params['l'] ?? '');
    return json(200, { listId: list.listId, audienceCount: list.eligibleCount, memberCount: list.memberCount });
  });

  r.post(`${base}/:l/imports`, async (ctx) => {
    const { p, team } = scope(ctx);
    const listId = ctx.params['l'] ?? '';
    const out = await imports.create(team.teamId, listId, p.officerId);
    await audit(ctx, p, team, 'import.start', 'import', out.importId);
    return json(201, out);
  });

  r.get(`${base}/:l/imports`, async (ctx) => {
    const { team } = scope(ctx);
    const listId = ctx.params['l'] ?? '';
    await lists.get(team.teamId, listId);
    return json(200, { items: await imports.listForList(team.teamId, listId) });
  });

  r.get(`${base}/:l/imports/:i`, async (ctx) => {
    const { team } = scope(ctx);
    return json(200, await imports.get(team.teamId, ctx.params['l'] ?? '', ctx.params['i'] ?? ''));
  });

  r.get(`${base}/:l/imports/:i/invalid-rows.csv`, async (ctx) => {
    const { team } = scope(ctx);
    const csv = await imports.invalidRowsCsv(team.teamId, ctx.params['l'] ?? '', ctx.params['i'] ?? '');
    return { statusCode: 200, headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="invalid-rows.csv"', 'cache-control': 'no-store' }, body: csv };
  });

  r.post('/api/contacts/agencies/:a/suppressions', async (ctx) => {
    const p = principalFrom(ctx.event);
    const agencyId = ctx.params['a'] ?? '';
    if (!isAgencyAdmin(p, agencyId)) throw new Forbidden();
    const body = parseBody(manualSuppressionBody, ctx.json());
    const addrHash = hashOf(body.email);
    await suppressions.suppress({ addrHash, scope: 'AGENCY', agencyId, reason: 'MANUAL' });
    await d.audit.record({ actor: p.officerId, agencyId, action: 'suppression.manual', targetType: 'address', targetId: addrHash, outcome: 'success', requestId: ctx.requestId });
    return json(201, { addrHash, scope: `AGENCY#${agencyId}`, reason: 'MANUAL' });
  });

  return r;
}
