import { Conflict, NotFound, cond, isConditionFailure, queryAll, type Item, type KvStore } from '@percy/shared';
import type { TierId } from '@percy/platform-contract';
import type { CampaignState } from '../domain/campaign-state';
import type { TemplateContent } from '../domain/template';

export interface Template extends TemplateContent {
  templateId: string;
  teamId: string;
  name: string;
  fields: string[];
  removed: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Campaign {
  campaignId: string;
  teamId: string;
  agencyId: string;
  agencyName: string;
  name: string;
  templateId: string;
  listId: string;
  senderName: string;
  state: CampaignState;
  version: number;
  createdBy: string;
  lastEditedBy: string;
  approvedBy?: string;
  rejectReason?: string;
  templateSnapshot?: TemplateContent & { fields: string[] };
  audienceCount?: number;
  scheduleAt?: string;
  scheduleName?: string;
  tier?: TierId;
  freezeId?: string;
  frozenAt?: string;
  pausedReason?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KillSwitch {
  scope: string;
  reason: string;
  setBy: string;
  setAt: string;
  agencyId?: string;
}

const campaignKey = (teamId: string, campaignId: string) => ({ pk: `TEAM#${teamId}`, sk: `CAMPAIGN#${campaignId}` });
const templateKey = (teamId: string, templateId: string) => ({ pk: `TEAM#${teamId}`, sk: `TEMPLATE#${templateId}` });
const killKey = (scope: string) => ({ pk: `KILL#${scope}`, sk: 'CURRENT' });

function strip(i: Item): Item {
  const { pk: _pk, sk: _sk, gsi1pk: _g1, gsi1sk: _g1s, ...rest } = i;
  return rest;
}

/** engine-campaigns table (control plane only). Campaign writes use optimistic concurrency on version. */
export class CampaignRepo {
  constructor(private readonly kv: KvStore, private readonly table: string) {}

  async putTemplate(t: Template, isNew: boolean): Promise<void> {
    await this.kv.put(this.table, { ...templateKey(t.teamId, t.templateId), ...t }, isNew ? cond.itemAbsent() : cond.itemPresent()).catch((e: unknown) => {
      if (isConditionFailure(e)) throw isNew ? new Conflict('Template already exists.') : new NotFound('Template not found.');
      throw e;
    });
  }

  async getTemplate(teamId: string, templateId: string): Promise<Template> {
    const i = await this.kv.get(this.table, templateKey(teamId, templateId));
    if (!i) throw new NotFound('Template not found.');
    return strip(i) as unknown as Template;
  }

  async listTemplates(teamId: string): Promise<Template[]> {
    const items = await queryAll(this.kv, this.table, { pk: `TEAM#${teamId}`, sk: { beginsWith: 'TEMPLATE#' } });
    return items.map((i) => strip(i) as unknown as Template).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async deleteTemplate(teamId: string, templateId: string): Promise<void> {
    const out = await this.kv.delete(this.table, templateKey(teamId, templateId));
    if (!out) throw new NotFound('Template not found.');
  }

  async getCampaign(teamId: string, campaignId: string): Promise<Campaign> {
    const i = await this.kv.get(this.table, campaignKey(teamId, campaignId), { consistent: true });
    if (!i) throw new NotFound('Campaign not found.');
    return strip(i) as unknown as Campaign;
  }

  async listCampaigns(teamId: string): Promise<Campaign[]> {
    const items = await queryAll(this.kv, this.table, { pk: `TEAM#${teamId}`, sk: { beginsWith: 'CAMPAIGN#' } });
    return items.map((i) => strip(i) as unknown as Campaign).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** SENDING campaigns via the sparse GSI1 (kill-switch fan-out). */
  async sendingCampaigns(): Promise<Campaign[]> {
    return (await queryAll(this.kv, this.table, { index: 'gsi1', pk: 'STATE#SENDING' })).map((i) => strip(i) as unknown as Campaign);
  }

  private toItem(c: Campaign): Item {
    const item: Item = { ...campaignKey(c.teamId, c.campaignId), ...c };
    if (c.state === 'SENDING') {
      item['gsi1pk'] = 'STATE#SENDING';
      item['gsi1sk'] = c.campaignId;
    }
    for (const k of Object.keys(item)) if (item[k] === undefined) Reflect.deleteProperty(item, k);
    return item;
  }

  async createCampaign(c: Campaign): Promise<void> {
    await this.kv.put(this.table, this.toItem(c), cond.itemAbsent());
  }

  /** Save with version check; throws Conflict when someone else changed the campaign first. */
  async saveCampaign(next: Campaign, expectedVersion: number): Promise<Campaign> {
    const saved = { ...next, version: expectedVersion + 1 };
    try {
      await this.kv.put(this.table, this.toItem(saved), cond.eq('version', expectedVersion));
    } catch (e) {
      if (isConditionFailure(e)) throw new Conflict('The campaign was changed by someone else. Reload and try again.');
      throw e;
    }
    return saved;
  }

  async deleteCampaign(teamId: string, campaignId: string, expectedState: CampaignState): Promise<void> {
    try {
      await this.kv.delete(this.table, campaignKey(teamId, campaignId), cond.eq('state', expectedState));
    } catch (e) {
      if (isConditionFailure(e)) throw new Conflict('Only draft campaigns can be deleted.');
      throw e;
    }
  }

  async putKill(k: KillSwitch): Promise<void> {
    await this.kv.put(this.table, { ...killKey(k.scope), ...k, gsi1pk: 'KILLS', gsi1sk: k.scope });
  }

  async deleteKill(scope: string): Promise<KillSwitch | undefined> {
    const out = await this.kv.delete(this.table, killKey(scope));
    return out ? (strip(out) as unknown as KillSwitch) : undefined;
  }

  async getKills(scopes: string[]): Promise<KillSwitch[]> {
    if (scopes.length === 0) return [];
    return (await this.kv.batchGet(this.table, [...new Set(scopes)].map(killKey))).map((i) => strip(i) as unknown as KillSwitch);
  }

  async allKills(): Promise<KillSwitch[]> {
    return (await queryAll(this.kv, this.table, { index: 'gsi1', pk: 'KILLS' })).map((i) => strip(i) as unknown as KillSwitch);
  }
}
