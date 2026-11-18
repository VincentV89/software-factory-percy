import type { KvStore } from '@percy/shared';
import type { TierId } from './principal';

export interface TeamInfo {
  teamId: string;
  agencyId: string;
  name: string;
  tier: TierId;
  status: 'ACTIVE' | 'SUSPENDED';
}

/** Read-only team lookup published by Platform (design 5.5 pattern): `TEAM#t / META` in platform-tenancy. */
export interface TeamReader {
  getTeam(teamId: string): Promise<TeamInfo | undefined>;
}

export class KvTeamReader implements TeamReader {
  constructor(private readonly kv: KvStore, private readonly table: string) {}
  async getTeam(teamId: string): Promise<TeamInfo | undefined> {
    const i = await this.kv.get(this.table, { pk: `TEAM#${teamId}`, sk: 'META' });
    if (!i) return undefined;
    return { teamId, agencyId: String(i['agencyId']), name: String(i['name']), tier: (i['tier'] as TierId) ?? 'standard', status: (i['status'] as TeamInfo['status']) ?? 'ACTIVE' };
  }
}
