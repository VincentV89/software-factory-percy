import { Conflict, Forbidden, NotFound, ValidationError, newId } from '@percy/shared';
import { isAgencyAdmin, type Principal } from '@percy/platform-contract';
import type { FreezeRequest } from '@percy/contactsg-contract';
import { transition, type CampaignAction } from '../domain/campaign-state';
import { authorizeScope, checkScheduleTime, scopesCovering, validateReason } from '../domain/rules';
import { parseRequestRef, requestRefOf, specKey, type SendSpec } from '../domain/send';

export { parseRequestRef, requestRefOf };
import { TemplateValidationError, validateTemplate, type TemplateContent } from '../domain/template';
import { CampaignRepo, type Campaign, type KillSwitch, type Template } from './campaign-repo';
import { sendCommand } from './commands';
import type { EngineCpDeps } from './deps';

/** The caller's access to one team: membership, or agency admin of the team's agency. */
export interface TeamAccess {
  teamId: string;
  agencyId: string;
  agencyName: string;
  tier: 'standard' | 'bulk';
  roles: string[];
}

export interface Actor {
  p: Principal;
  team: TeamAccess;
  requestId: string;
}

export class CampaignService {
  readonly repo: CampaignRepo;

  constructor(private readonly d: EngineCpDeps) {
    this.repo = new CampaignRepo(d.kv, d.tables.campaigns);
  }

  private iso(): string {
    return new Date(this.d.clock.now()).toISOString();
  }

  async teamAccess(p: Principal, teamId: string): Promise<TeamAccess> {
    const member = p.teams.find((t) => t.teamId === teamId);
    if (member) return { teamId, agencyId: member.agencyId, agencyName: member.agencyName, tier: member.tier, roles: member.roles };
    if (p.platformAdmin || p.agencyAdmin.length > 0) {
      const team = await this.d.teams.getTeam(teamId);
      if (team && team.status === 'ACTIVE' && isAgencyAdmin(p, team.agencyId)) {
        const agencyName = p.agencyAdmin.find((a) => a.agencyId === team.agencyId)?.agencyName ?? team.agencyId;
        return { teamId, agencyId: team.agencyId, agencyName, tier: team.tier, roles: [] };
      }
    }
    throw new NotFound();
  }

  private async audit(a: Actor, action: string, targetType: string, targetId: string, extra: { reason?: string; scope?: string; outcome?: 'success' | 'denied' } = {}): Promise<void> {
    await this.d.audit.record({ actor: a.p.officerId, agencyId: a.team.agencyId, teamId: a.team.teamId, action, targetType, targetId, outcome: extra.outcome ?? 'success', requestId: a.requestId, reason: extra.reason, scope: extra.scope });
  }

  // ---- templates -------------------------------------------------------

  private validated(input: TemplateContent) {
    try {
      return validateTemplate(input);
    } catch (e) {
      if (e instanceof TemplateValidationError) {
        throw new ValidationError(
          'The template has problems: ' + e.issues.map((i) => `${i.field} body${i.position ? ` at position ${i.position}` : ''}: ${i.reason}`).join('; '),
          e.issues.map((i) => ({ field: i.field, reason: i.reason, position: i.position })),
        );
      }
      throw e;
    }
  }

  async saveTemplate(a: Actor, input: TemplateContent & { name: string }, templateId?: string): Promise<Template> {
    const v = this.validated(input);
    const now = this.iso();
    const existing = templateId ? await this.repo.getTemplate(a.team.teamId, templateId) : undefined;
    const t: Template = {
      templateId: templateId ?? newId(this.d.clock.now()),
      teamId: a.team.teamId,
      name: input.name.trim(),
      subject: v.subject,
      html: v.html,
      text: v.text,
      fields: v.fields,
      removed: v.removed,
      createdBy: existing?.createdBy ?? a.p.officerId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.repo.putTemplate(t, !existing);
    await this.audit(a, existing ? 'template.update' : 'template.create', 'template', t.templateId);
    return t;
  }

  async deleteTemplate(a: Actor, templateId: string): Promise<void> {
    await this.repo.deleteTemplate(a.team.teamId, templateId);
    await this.audit(a, 'template.delete', 'template', templateId);
  }

  // ---- campaigns -------------------------------------------------------

  async create(a: Actor, input: { name: string; templateId: string; listId: string; senderName: string }): Promise<Campaign> {
    await this.repo.getTemplate(a.team.teamId, input.templateId);
    const audience = await this.d.lists.getAudience(a.team.teamId, input.listId);
    if (!audience.exists) throw new NotFound('List not found.');
    const now = this.iso();
    const c: Campaign = {
      campaignId: newId(this.d.clock.now()),
      teamId: a.team.teamId,
      agencyId: a.team.agencyId,
      agencyName: a.team.agencyName,
      name: input.name.trim(),
      templateId: input.templateId,
      listId: input.listId,
      senderName: input.senderName.trim(),
      state: 'DRAFT',
      version: 1,
      createdBy: a.p.officerId,
      lastEditedBy: a.p.officerId,
      audienceCount: audience.eligibleCount,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.createCampaign(c);
    await this.audit(a, 'campaign.create', 'campaign', c.campaignId);
    return c;
  }

  async get(a: Actor, campaignId: string): Promise<Campaign> {
    const c = await this.repo.getCampaign(a.team.teamId, campaignId);
    if (['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(c.state)) {
      const audience = await this.d.lists.getAudience(c.teamId, c.listId);
      c.audienceCount = audience.exists ? audience.eligibleCount : 0;
    }
    return c;
  }

  private async move(a: Actor, c: Campaign, action: CampaignAction, patch: Partial<Campaign> = {}): Promise<Campaign> {
    const next = transition(c.state, action);
    return this.repo.saveCampaign({ ...c, ...patch, state: next, updatedAt: this.iso() }, c.version);
  }

  async edit(a: Actor, campaignId: string, input: { name?: string; templateId?: string; listId?: string; senderName?: string }): Promise<Campaign> {
    const c = await this.repo.getCampaign(a.team.teamId, campaignId);
    if (input.templateId) await this.repo.getTemplate(a.team.teamId, input.templateId);
    if (input.listId && !(await this.d.lists.getAudience(a.team.teamId, input.listId)).exists) throw new NotFound('List not found.');
    const saved = await this.move(a, c, 'edit', {
      name: input.name?.trim() ?? c.name,
      templateId: input.templateId ?? c.templateId,
      listId: input.listId ?? c.listId,
      senderName: input.senderName?.trim() ?? c.senderName,
      lastEditedBy: a.p.officerId,
      approvedBy: undefined,
      templateSnapshot: undefined,
      error: undefined,
    });
    await this.audit(a, 'campaign.edit', 'campaign', campaignId);
    return saved;
  }

  async remove(a: Actor, campaignId: string): Promise<void> {
    const c = await this.repo.getCampaign(a.team.teamId, campaignId);
    if (c.state !== 'DRAFT') throw new Conflict(`A campaign in state ${c.state} cannot be deleted; only drafts can.`);
    await this.repo.deleteCampaign(a.team.teamId, campaignId, 'DRAFT');
    await this.audit(a, 'campaign.delete', 'campaign', campaignId);
  }

  /** submit copies the template into the campaign (FR-TPL-05). */
  async submit(a: Actor, campaignId: string): Promise<Campaign> {
    const c = await this.repo.getCampaign(a.team.teamId, campaignId);
    transition(c.state, 'submit');
    const t = await this.repo.getTemplate(c.teamId, c.templateId);
    const saved = await this.move(a, c, 'submit', { templateSnapshot: { subject: t.subject, html: t.html, text: t.text, fields: t.fields }, lastEditedBy: a.p.officerId, rejectReason: undefined });
    await this.audit(a, 'campaign.submit', 'campaign', campaignId);
    return saved;
  }

  /** FR-CMP-03/04: approver role in the team or agency admin; never the creator or last editor. */
  canApprove(p: Principal, team: TeamAccess, c: Pick<Campaign, 'createdBy' | 'lastEditedBy' | 'agencyId'>): boolean {
    const hasRole = team.roles.includes('approver') || isAgencyAdmin(p, c.agencyId);
    return hasRole && p.officerId !== c.createdBy && p.officerId !== c.lastEditedBy;
  }

  async approve(a: Actor, campaignId: string): Promise<Campaign> {
    const c = await this.repo.getCampaign(a.team.teamId, campaignId);
    if (!this.canApprove(a.p, a.team, c)) {
      await this.audit(a, 'campaign.approve', 'campaign', campaignId, { outcome: 'denied' });
      throw new Forbidden(a.p.officerId === c.createdBy || a.p.officerId === c.lastEditedBy ? 'You cannot approve a campaign you created or last edited.' : 'Only approvers can approve campaigns.');
    }
    const saved = await this.move(a, c, 'approve', { approvedBy: a.p.officerId });
    await this.audit(a, 'campaign.approve', 'campaign', campaignId);
    return saved;
  }

  async reject(a: Actor, campaignId: string, reason: string): Promise<Campaign> {
    const c = await this.repo.getCampaign(a.team.teamId, campaignId);
    if (!this.canApprove(a.p, a.team, c)) throw new Forbidden('Only another approver can reject this campaign.');
    const saved = await this.move(a, c, 'reject', { rejectReason: validateReason(reason, 1, 500), approvedBy: undefined });
    await this.audit(a, 'campaign.reject', 'campaign', campaignId, { reason });
    return saved;
  }

  async activeKillFor(agencyId: string, teamId: string): Promise<KillSwitch | undefined> {
    return (await this.repo.getKills(scopesCovering(agencyId, teamId)))[0];
  }

  /** FR-SCH-01: 409 under a kill switch, 400 outside the window, list hold, then Scheduler (or now). */
  async schedule(a: Actor, campaignId: string, at: 'now' | string): Promise<Campaign> {
    const c = await this.repo.getCampaign(a.team.teamId, campaignId);
    transition(c.state, 'schedule');
    const kill = await this.activeKillFor(c.agencyId, c.teamId);
    if (kill) throw new Conflict(`A kill switch is active (${kill.scope}): ${kill.reason}`);
    const now = this.d.clock.now();
    const sendNow = at === 'now';
    const when = sendNow ? now : Date.parse(at);
    if (!sendNow) {
      if (Number.isNaN(when)) throw new ValidationError('Send time is not a valid date.', [{ field: 'at', reason: 'invalid date' }]);
      checkScheduleTime(when, now);
    }
    await this.d.holds.acquire(c.teamId, c.listId, c.campaignId);
    const scheduleName = `percy-${this.d.config.instance}-${c.campaignId}-v${c.version + 1}`;
    let saved: Campaign;
    try {
      saved = await this.move(a, c, 'schedule', { scheduleAt: new Date(when).toISOString(), scheduleName: sendNow ? undefined : scheduleName, tier: a.team.tier, error: undefined });
      if (!sendNow) await this.d.scheduler.create(scheduleName, new Date(when), { teamId: c.teamId, campaignId: c.campaignId });
    } catch (e) {
      await this.d.holds.release(c.teamId, c.listId, c.campaignId).catch(() => undefined);
      throw e;
    }
    await this.audit(a, 'campaign.schedule', 'campaign', campaignId, { reason: sendNow ? 'now' : saved.scheduleAt });
    if (sendNow) return this.fire(c.teamId, c.campaignId);
    return saved;
  }

  async unschedule(a: Actor, campaignId: string): Promise<Campaign> {
    const c = await this.repo.getCampaign(a.team.teamId, campaignId);
    transition(c.state, 'unschedule');
    if (c.scheduleName) await this.d.scheduler.delete(c.scheduleName);
    const saved = await this.move(a, c, 'unschedule', { scheduleAt: undefined, scheduleName: undefined });
    await this.d.holds.release(c.teamId, c.listId, c.campaignId);
    await this.audit(a, 'campaign.unschedule', 'campaign', campaignId);
    return saved;
  }

  /**
   * Scheduler target (and "send now"): SCHEDULED → FREEZING, write the send spec, then the freeze
   * request (ADR-04 ordering). Idempotent on retry while FREEZING.
   */
  async fire(teamId: string, campaignId: string): Promise<Campaign> {
    let c = await this.repo.getCampaign(teamId, campaignId);
    if (c.state === 'SCHEDULED') {
      c = await this.repo.saveCampaign({ ...c, state: transition(c.state, 'fire'), freezeId: `${c.campaignId}-v${c.version + 1}`, updatedAt: this.iso() }, c.version);
    } else if (c.state !== 'FREEZING') {
      this.d.logger.info('fire ignored', { campaignId, state: c.state });
      return c;
    }
    const snap = c.templateSnapshot;
    if (!snap || !c.tier || !c.freezeId) throw new Error(`campaign ${campaignId} is missing its snapshot`);
    const spec: SendSpec = {
      campaignId: c.campaignId,
      teamId: c.teamId,
      agencyId: c.agencyId,
      agencyName: c.agencyName,
      tier: c.tier,
      listId: c.listId,
      senderName: c.senderName,
      fromAddress: this.d.config.fromAddress,
      configurationSet: this.d.config.configurationSet,
      template: { subject: snap.subject, html: snap.html, text: snap.text },
      requiredFields: snap.fields,
      createdAt: this.iso(),
    };
    await this.d.store.put(this.d.artifactsBucket, specKey(c.campaignId), JSON.stringify(spec), { contentType: 'application/json' });
    const req: FreezeRequest = { freezeId: c.freezeId, requestRef: requestRefOf(c), agencyId: c.agencyId, teamId: c.teamId, listId: c.listId, requiredFields: snap.fields };
    if (this.d.config.addressAllowList) req.addressAllowList = this.d.config.addressAllowList;
    await this.d.queue.send(this.d.queues.freeze, { body: req });
    return c;
  }

  /** Pause / resume / stop: validate, command to FIFO first, then the state write (ADR-03). Returns 202 data. */
  async control(a: Actor, campaignId: string, action: 'pause' | 'resume' | 'stop'): Promise<{ commandId: string; campaign: Campaign }> {
    const c = await this.repo.getCampaign(a.team.teamId, campaignId);
    transition(c.state, action);
    if (action === 'resume') {
      const kill = await this.activeKillFor(c.agencyId, c.teamId);
      if (kill) throw new Conflict(`A kill switch is active (${kill.scope}): ${kill.reason}`);
      if (c.frozenAt && this.d.clock.now() - Date.parse(c.frozenAt) > this.d.config.snapshotRetentionMs) throw new Conflict('The audience snapshot has expired; stop the campaign instead.');
    }
    const type = action === 'pause' ? 'PAUSE' : action === 'resume' ? 'RESUME' : 'STOP';
    const cmd = await sendCommand(this.d.queue, this.d.queues.commands, { type, campaignId, issuedBy: a.p.officerId }, this.d.clock.now());
    let saved = c;
    try {
      saved = await this.move(a, c, action, action === 'pause' ? { pausedReason: 'OFFICER' } : { pausedReason: undefined });
    } catch (e) {
      // The command is already queued; the data plane validates it and reports via events.
      if (!(e instanceof Conflict)) throw e;
    }
    if (action === 'stop' && c.state === 'SCHEDULED') {
      if (c.scheduleName) await this.d.scheduler.delete(c.scheduleName);
      await this.d.holds.release(c.teamId, c.listId, c.campaignId);
    }
    await this.audit(a, `campaign.${action}`, 'campaign', campaignId, { reason: cmd.commandId });
    return { commandId: cmd.commandId, campaign: saved };
  }

  // ---- kill switch -----------------------------------------------------

  async setKill(p: Principal, scope: string, reason: string, requestId: string): Promise<KillSwitch> {
    const r = validateReason(reason);
    const { agencyId } = await authorizeScope(p, scope, async (t) => (await this.d.teams.getTeam(t))?.agencyId);
    const kill = await this.applyKill(scope, r, p.officerId, agencyId);
    await this.d.audit.record({ actor: p.officerId, agencyId, action: 'killswitch.set', targetType: 'kill-switch', targetId: scope, outcome: 'success', requestId, scope, reason: r });
    return kill;
  }

  /** Writes KILL#scope, engages the gate, and pauses every SENDING campaign in scope (FR-CTL-04). */
  async applyKill(scope: string, reason: string, setBy: string, agencyId?: string): Promise<KillSwitch> {
    const now = this.d.clock.now();
    const kill: KillSwitch = { scope, reason, setBy, setAt: new Date(now).toISOString(), agencyId };
    await this.repo.putKill(kill);
    await sendCommand(this.d.queue, this.d.queues.commands, { type: 'SET_GATE', gateScope: scope, reason, issuedBy: setBy }, now);
    for (const c of await this.repo.sendingCampaigns()) {
      if (!scopesCovering(c.agencyId, c.teamId).includes(scope)) continue;
      await sendCommand(this.d.queue, this.d.queues.commands, { type: 'PAUSE', campaignId: c.campaignId, reason: 'KILL_SWITCH', issuedBy: setBy }, this.d.clock.now());
      await this.repo.saveCampaign({ ...c, state: 'PAUSED', pausedReason: 'KILL_SWITCH', updatedAt: this.iso() }, c.version).catch((e: unknown) => {
        if (!(e instanceof Conflict)) throw e;
      });
    }
    return kill;
  }

  async clearKill(p: Principal, scope: string, reason: string, requestId: string): Promise<void> {
    const r = validateReason(reason, 3, 500);
    const { agencyId } = await authorizeScope(p, scope, async (t) => (await this.d.teams.getTeam(t))?.agencyId);
    if (!(await this.removeKill(scope, p.officerId))) throw new NotFound('No kill switch is active for that scope.');
    await this.d.audit.record({ actor: p.officerId, agencyId, action: 'killswitch.clear', targetType: 'kill-switch', targetId: scope, outcome: 'success', requestId, scope, reason: r });
  }

  /** Clearing never resumes campaigns (FR-CTL-05). */
  async removeKill(scope: string, by: string): Promise<boolean> {
    const removed = await this.repo.deleteKill(scope);
    await sendCommand(this.d.queue, this.d.queues.commands, { type: 'CLEAR_GATE', gateScope: scope, issuedBy: by }, this.d.clock.now());
    return !!removed;
  }

  /** Kill switches visible to the caller: those covering any of their teams, plus their admin scopes. */
  async visibleKills(p: Principal): Promise<KillSwitch[]> {
    if (p.platformAdmin) return this.repo.allKills();
    const scopes = new Set<string>(['GLOBAL']);
    for (const t of p.teams) for (const s of scopesCovering(t.agencyId, t.teamId)) scopes.add(s);
    for (const a of p.agencyAdmin) scopes.add(`AGENCY#${a.agencyId}`);
    const kills = await this.repo.getKills([...scopes]);
    if (p.agencyAdmin.length > 0) {
      const own = new Set(p.agencyAdmin.map((a) => a.agencyId));
      for (const k of await this.repo.allKills()) if (k.agencyId && own.has(k.agencyId) && !kills.some((x) => x.scope === k.scope)) kills.push(k);
    }
    return kills;
  }

  /** State updates driven by data-plane and ContactSG events (no officer table check). */
  async syncState(teamId: string, campaignId: string, apply: (c: Campaign) => Partial<Campaign> | undefined): Promise<Campaign | undefined> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const c = await this.repo.getCampaign(teamId, campaignId).catch((e: unknown) => {
        if (e instanceof NotFound) return undefined;
        throw e;
      });
      if (!c) return undefined;
      const patch = apply(c);
      if (!patch) return c;
      try {
        return await this.repo.saveCampaign({ ...c, ...patch, updatedAt: this.iso() }, c.version);
      } catch (e) {
        if (!(e instanceof Conflict)) throw e;
      }
    }
    throw new Conflict(`could not update campaign ${campaignId}`);
  }
}

