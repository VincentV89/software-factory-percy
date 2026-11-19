import { z } from 'zod';
import { Forbidden, NotFound, Router, json, parseBody, type RouteContext } from '@percy/shared';
import { principalFrom, requireAnyRole } from '@percy/platform-contract';
import { CAMPAIGN_ACTIONS, canTransition, type CampaignAction } from '../domain/campaign-state';
import { render } from '../domain/template';
import { SendlogReader } from '../sendlog-read';
import { CampaignService, type Actor } from './campaigns';
import type { Campaign } from './campaign-repo';
import type { EngineCpDeps } from './deps';

const templateBody = z.object({
  name: z.string().trim().min(1).max(120),
  subject: z.string().min(1).max(998),
  html: z.string().min(1).max(500_000),
  text: z.string().min(1).max(200_000),
});
const previewBody = z.object({ listId: z.string().optional(), addrHash: z.string().optional(), values: z.record(z.string(), z.string()).optional() });
const campaignBody = z.object({ name: z.string().trim().min(1).max(120), templateId: z.string().min(1), listId: z.string().min(1), senderName: z.string().trim().min(1).max(100) });
const campaignEdit = campaignBody.partial();
const scheduleBody = z.object({ at: z.union([z.literal('now'), z.string().datetime({ offset: true })]) });
const reasonBody = z.object({ reason: z.string().optional() });
const killBody = z.object({ scope: z.string().min(1), reason: z.string().optional() });

const OFFICER_ACTIONS = ['submit', 'approve', 'reject', 'schedule', 'unschedule', 'pause', 'resume', 'stop'] as const;
type OfficerAction = (typeof OFFICER_ACTIONS)[number];

export function createEngineApi(d: EngineCpDeps): Router {
  const svc = new CampaignService(d);
  const sendlog = new SendlogReader(d.kv, d.tables.sendlog);
  const r = new Router(d.logger);

  const actor = async (ctx: RouteContext): Promise<Actor> => {
    const p = principalFrom(ctx.event);
    requireAnyRole(p);
    return { p, team: await svc.teamAccess(p, ctx.params['t'] ?? ''), requestId: ctx.requestId };
  };

  const view = (a: Actor, c: Campaign) => ({
    ...c,
    templateSnapshot: c.templateSnapshot ? { subject: c.templateSnapshot.subject, fields: c.templateSnapshot.fields } : undefined,
    permissions: {
      canApprove: c.state === 'PENDING_APPROVAL' && svc.canApprove(a.p, a.team, c),
      actions: CAMPAIGN_ACTIONS.filter((x): x is CampaignAction & OfficerAction => (OFFICER_ACTIONS as readonly string[]).includes(x) && canTransition(c.state, x)).filter(
        (x) => (x !== 'approve' && x !== 'reject') || svc.canApprove(a.p, a.team, c),
      ),
    },
  });

  const tpl = '/api/engine/teams/:t/templates';
  r.get(tpl, async (ctx) => {
    const a = await actor(ctx);
    return json(200, { items: await svc.repo.listTemplates(a.team.teamId) });
  });
  r.post(tpl, async (ctx) => {
    const a = await actor(ctx);
    return json(201, await svc.saveTemplate(a, parseBody(templateBody, ctx.json())));
  });
  r.get(`${tpl}/:id`, async (ctx) => {
    const a = await actor(ctx);
    return json(200, await svc.repo.getTemplate(a.team.teamId, ctx.params['id'] ?? ''));
  });
  r.put(`${tpl}/:id`, async (ctx) => {
    const a = await actor(ctx);
    return json(200, await svc.saveTemplate(a, parseBody(templateBody, ctx.json()), ctx.params['id']));
  });
  r.del(`${tpl}/:id`, async (ctx) => {
    const a = await actor(ctx);
    await svc.deleteTemplate(a, ctx.params['id'] ?? '');
    return { statusCode: 204, body: '' };
  });
  r.post(`${tpl}/:id/preview`, async (ctx) => {
    const a = await actor(ctx);
    const t = await svc.repo.getTemplate(a.team.teamId, ctx.params['id'] ?? '');
    const body = parseBody(previewBody, ctx.json());
    let values: Record<string, string> = { ...(body.values ?? {}) };
    if (body.listId && body.addrHash) {
      const m = await d.members.getMember(a.team.teamId, body.listId, body.addrHash);
      if (!m) throw new NotFound('Contact not found in that list.');
      values = { ...m.attrs, email: m.email };
    }
    values['unsubscribe_url'] = values['unsubscribe_url'] ?? '#unsubscribe-preview';
    return json(200, render(t, values, { highlightMissing: true }));
  });

  const cmp = '/api/engine/teams/:t/campaigns';
  r.get(cmp, async (ctx) => {
    const a = await actor(ctx);
    const items = await svc.repo.listCampaigns(a.team.teamId);
    return json(200, { items: items.map((c) => ({ campaignId: c.campaignId, name: c.name, state: c.state, createdBy: c.createdBy, audienceCount: c.audienceCount, scheduleAt: c.scheduleAt, updatedAt: c.updatedAt, createdAt: c.createdAt })) });
  });
  r.post(cmp, async (ctx) => {
    const a = await actor(ctx);
    return json(201, view(a, await svc.create(a, parseBody(campaignBody, ctx.json()))));
  });
  r.get(`${cmp}/:c`, async (ctx) => {
    const a = await actor(ctx);
    return json(200, view(a, await svc.get(a, ctx.params['c'] ?? '')));
  });
  r.put(`${cmp}/:c`, async (ctx) => {
    const a = await actor(ctx);
    return json(200, view(a, await svc.edit(a, ctx.params['c'] ?? '', parseBody(campaignEdit, ctx.json()))));
  });
  r.del(`${cmp}/:c`, async (ctx) => {
    const a = await actor(ctx);
    await svc.remove(a, ctx.params['c'] ?? '');
    return { statusCode: 204, body: '' };
  });
  r.post(`${cmp}/:c/actions/:action`, async (ctx) => {
    const a = await actor(ctx);
    const id = ctx.params['c'] ?? '';
    const action = ctx.params['action'] as OfficerAction;
    if (!(OFFICER_ACTIONS as readonly string[]).includes(action)) throw new NotFound('Unknown action.');
    switch (action) {
      case 'submit':
        return json(200, view(a, await svc.submit(a, id)));
      case 'approve':
        return json(200, view(a, await svc.approve(a, id)));
      case 'reject':
        return json(200, view(a, await svc.reject(a, id, parseBody(reasonBody, ctx.json()).reason ?? '')));
      case 'schedule':
        return json(200, view(a, await svc.schedule(a, id, parseBody(scheduleBody, ctx.json()).at)));
      case 'unschedule':
        return json(200, view(a, await svc.unschedule(a, id)));
      default: {
        const out = await svc.control(a, id, action);
        return json(202, { commandId: out.commandId, campaign: view(a, out.campaign) });
      }
    }
  });
  r.get(`${cmp}/:c/report`, async (ctx) => {
    const a = await actor(ctx);
    const c = await svc.repo.getCampaign(a.team.teamId, ctx.params['c'] ?? '');
    const report = await sendlog.report(c.campaignId);
    return json(200, { campaignId: c.campaignId, state: c.state, ...report, audience: report.audience || 0 });
  });

  r.get('/api/engine/kill-switches', async (ctx) => {
    const p = principalFrom(ctx.event);
    requireAnyRole(p);
    return json(200, { items: await svc.visibleKills(p) });
  });
  r.post('/api/engine/kill-switches', async (ctx) => {
    const p = principalFrom(ctx.event);
    if (!p.platformAdmin && p.agencyAdmin.length === 0) throw new Forbidden();
    const body = parseBody(killBody, ctx.json());
    return json(201, await svc.setKill(p, body.scope, body.reason ?? '', ctx.requestId));
  });
  r.post('/api/engine/kill-switches/clear', async (ctx) => {
    const p = principalFrom(ctx.event);
    if (!p.platformAdmin && p.agencyAdmin.length === 0) throw new Forbidden();
    const body = parseBody(killBody, ctx.json());
    await svc.clearKill(p, body.scope, body.reason ?? '', ctx.requestId);
    return json(200, { scope: body.scope, cleared: true });
  });

  if (d.config.devExport && d.config.instance === 'dev') {
    r.get('/api/engine/test/campaigns/:c/send-log', async (ctx) => {
      const p = principalFrom(ctx.event);
      const campaignId = ctx.params['c'] ?? '';
      const teamId = await sendlog.teamOf(campaignId);
      if (!teamId || !p.teams.some((t) => t.teamId === teamId)) throw new NotFound();
      return json(200, { items: await sendlog.devRows(campaignId) });
    });
  }

  return r;
}
