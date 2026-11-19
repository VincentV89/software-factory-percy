import { Conflict, NotFound, cond, isConditionFailure, newId, outboxPut, makeEvent, queryAll, type Item, type KvStore, type TxOp } from '@percy/shared';
import { PLATFORM_SOURCE, type PlatformEventType, type TeamRole, type TierId } from '@percy/platform-contract';

export type TenancyStatus = 'ACTIVE' | 'SUSPENDED';

export interface Agency {
  agencyId: string;
  name: string;
  status: TenancyStatus;
  suspendReason?: string;
}

export interface Team {
  teamId: string;
  agencyId: string;
  name: string;
  tier: TierId;
  status: TenancyStatus;
  suspendReason?: string;
}

export interface Officer {
  officerId: string;
  email: string;
  cognitoSub?: string;
}

export interface OfficerGrants {
  officer?: Officer;
  platformAdmin: boolean;
  agencyAdmin: string[];
  memberships: { teamId: string; agencyId: string; roles: TeamRole[] }[];
}

const nameKey = (name: string): string => name.trim().toLowerCase();

/** platform-tenancy table access (design section 6). Only Platform writes this table. */
export class TenancyRepo {
  constructor(private readonly kv: KvStore, private readonly table: string, private readonly outboxTable: string, private readonly now: () => number) {}

  async createAgency(name: string): Promise<Agency> {
    const agency: Agency = { agencyId: newId(this.now()), name: name.trim(), status: 'ACTIVE' };
    try {
      await this.kv.transact([
        { kind: 'put', table: this.table, item: { pk: `AGENCYNAME#${nameKey(name)}`, sk: 'LOCK', agencyId: agency.agencyId }, cond: cond.itemAbsent() },
        { kind: 'put', table: this.table, item: { pk: `AGENCY#${agency.agencyId}`, sk: 'META', ...agency, gsi2pk: 'AGENCIES', gsi2sk: nameKey(name) } },
      ]);
    } catch (e) {
      if (isConditionFailure(e)) throw new Conflict(`An agency named "${agency.name}" already exists.`);
      throw e;
    }
    return agency;
  }

  async getAgency(agencyId: string): Promise<Agency | undefined> {
    const item = await this.kv.get(this.table, { pk: `AGENCY#${agencyId}`, sk: 'META' });
    return item ? toAgency(item) : undefined;
  }

  async listAgencies(): Promise<Agency[]> {
    return (await queryAll(this.kv, this.table, { index: 'gsi2', pk: 'AGENCIES' })).map(toAgency);
  }

  async createTeam(agencyId: string, name: string, tier: TierId): Promise<Team> {
    const team: Team = { teamId: newId(this.now()), agencyId, name: name.trim(), tier, status: 'ACTIVE' };
    try {
      await this.kv.transact([
        { kind: 'check', table: this.table, key: { pk: `AGENCY#${agencyId}`, sk: 'META' }, cond: cond.itemPresent() },
        { kind: 'put', table: this.table, item: { pk: `TEAMNAME#${agencyId}#${nameKey(name)}`, sk: 'LOCK', teamId: team.teamId }, cond: cond.itemAbsent() },
        { kind: 'put', table: this.table, item: { pk: `TEAM#${team.teamId}`, sk: 'META', ...team, gsi2pk: `AGENCY#${agencyId}#TEAMS`, gsi2sk: nameKey(name) } },
      ]);
    } catch (e) {
      if (isConditionFailure(e)) throw new Conflict(`A team named "${team.name}" already exists in this agency.`);
      throw e;
    }
    return team;
  }

  async getTeam(teamId: string): Promise<Team | undefined> {
    const item = await this.kv.get(this.table, { pk: `TEAM#${teamId}`, sk: 'META' });
    return item ? toTeam(item) : undefined;
  }

  async getTeams(teamIds: string[]): Promise<Team[]> {
    if (teamIds.length === 0) return [];
    return (await this.kv.batchGet(this.table, teamIds.map((t) => ({ pk: `TEAM#${t}`, sk: 'META' })))).map(toTeam);
  }

  async getAgencies(agencyIds: string[]): Promise<Agency[]> {
    if (agencyIds.length === 0) return [];
    return (await this.kv.batchGet(this.table, [...new Set(agencyIds)].map((a) => ({ pk: `AGENCY#${a}`, sk: 'META' })))).map(toAgency);
  }

  async listTeams(agencyId: string): Promise<Team[]> {
    return (await queryAll(this.kv, this.table, { index: 'gsi2', pk: `AGENCY#${agencyId}#TEAMS` })).map(toTeam);
  }

  async setTier(teamId: string, tier: TierId): Promise<Team> {
    try {
      const out = await this.kv.update(this.table, { pk: `TEAM#${teamId}`, sk: 'META' }, { set: { tier } }, { cond: cond.itemPresent() });
      return toTeam(out.new);
    } catch (e) {
      if (isConditionFailure(e)) throw new NotFound();
      throw e;
    }
  }

  /** Status change plus its domain event in one transaction (ADR-10). */
  async setStatus(target: { teamId: string } | { agencyId: string }, status: TenancyStatus, reason: string, by: string): Promise<void> {
    const now = this.now();
    const isTeam = 'teamId' in target;
    const key = isTeam ? { pk: `TEAM#${target.teamId}`, sk: 'META' } : { pk: `AGENCY#${target.agencyId}`, sk: 'META' };
    const current = await this.kv.get(this.table, key);
    if (!current) throw new NotFound();
    const agencyId = String(current['agencyId']);
    const type: PlatformEventType = isTeam ? (status === 'SUSPENDED' ? 'TeamSuspended' : 'TeamReinstated') : status === 'SUSPENDED' ? 'AgencySuspended' : 'AgencyReinstated';
    const payload: Record<string, unknown> = isTeam ? { teamId: target.teamId, agencyId, by } : { agencyId, by };
    if (status === 'SUSPENDED') payload['reason'] = reason;
    const ops: TxOp[] = [
      { kind: 'update', table: this.table, key, update: status === 'SUSPENDED' ? { set: { status, suspendReason: reason } } : { set: { status }, remove: ['suspendReason'] } },
      outboxPut(this.outboxTable, makeEvent(PLATFORM_SOURCE, type, payload, now), Math.floor(now / 1000)),
    ];
    await this.kv.transact(ops);
  }

  async findOfficerByEmail(email: string): Promise<Officer | undefined> {
    const lock = await this.kv.get(this.table, { pk: `OFFICEREMAIL#${email.toLowerCase()}`, sk: 'LOCK' });
    if (!lock) return undefined;
    return this.getOfficer(String(lock['officerId']));
  }

  async getOfficer(officerId: string): Promise<Officer | undefined> {
    const item = await this.kv.get(this.table, { pk: `OFFICER#${officerId}`, sk: 'META' });
    return item ? { officerId, email: String(item['email']), cognitoSub: item['cognitoSub'] as string | undefined } : undefined;
  }

  /** Find or create the officer record for an email (memberships are granted by Cognito email). */
  async ensureOfficer(email: string): Promise<Officer> {
    const normalised = email.trim().toLowerCase();
    const existing = await this.findOfficerByEmail(normalised);
    if (existing) return existing;
    const officer: Officer = { officerId: newId(this.now()), email: normalised };
    try {
      await this.kv.transact([
        { kind: 'put', table: this.table, item: { pk: `OFFICEREMAIL#${normalised}`, sk: 'LOCK', officerId: officer.officerId }, cond: cond.itemAbsent() },
        { kind: 'put', table: this.table, item: { pk: `OFFICER#${officer.officerId}`, sk: 'META', email: normalised } },
      ]);
      return officer;
    } catch (e) {
      if (isConditionFailure(e)) {
        const raced = await this.findOfficerByEmail(normalised);
        if (raced) return raced;
      }
      throw e;
    }
  }

  async linkCognitoSub(officerId: string, sub: string): Promise<void> {
    await this.kv.update(this.table, { pk: `OFFICER#${officerId}`, sk: 'META' }, { set: { cognitoSub: sub } });
  }

  async grants(officerId: string): Promise<OfficerGrants> {
    const items = await queryAll(this.kv, this.table, { pk: `OFFICER#${officerId}`, consistent: true });
    const out: OfficerGrants = { platformAdmin: false, agencyAdmin: [], memberships: [] };
    for (const i of items) {
      const sk = String(i['sk']);
      if (sk === 'META') out.officer = { officerId, email: String(i['email']), cognitoSub: i['cognitoSub'] as string | undefined };
      else if (sk === 'PLATFORMADMIN') out.platformAdmin = true;
      else if (sk.startsWith('AGENCYADMIN#')) out.agencyAdmin.push(sk.slice('AGENCYADMIN#'.length));
      else if (sk.startsWith('MEMBER#TEAM#')) out.memberships.push({ teamId: String(i['teamId']), agencyId: String(i['agencyId']), roles: i['roles'] as TeamRole[] });
    }
    return out;
  }

  async setMembership(officerId: string, team: Team, roles: TeamRole[]): Promise<void> {
    await this.kv.put(this.table, {
      pk: `OFFICER#${officerId}`,
      sk: `MEMBER#TEAM#${team.teamId}`,
      teamId: team.teamId,
      agencyId: team.agencyId,
      roles,
      gsi1pk: `TEAM#${team.teamId}`,
      gsi1sk: `OFFICER#${officerId}`,
    });
  }

  async removeMembership(officerId: string, teamId: string): Promise<boolean> {
    return !!(await this.kv.delete(this.table, { pk: `OFFICER#${officerId}`, sk: `MEMBER#TEAM#${teamId}` }));
  }

  async teamMembers(teamId: string): Promise<{ officerId: string; roles: TeamRole[] }[]> {
    const items = await queryAll(this.kv, this.table, { index: 'gsi1', pk: `TEAM#${teamId}` });
    return items.map((i) => ({ officerId: String(i['pk']).slice('OFFICER#'.length), roles: i['roles'] as TeamRole[] }));
  }

  async setAgencyAdmin(officerId: string, agencyId: string, granted: boolean): Promise<void> {
    const key = { pk: `OFFICER#${officerId}`, sk: `AGENCYADMIN#${agencyId}` };
    if (granted) await this.kv.put(this.table, { ...key, agencyId });
    else await this.kv.delete(this.table, key);
  }

  async setPlatformAdmin(officerId: string, granted: boolean): Promise<void> {
    const key = { pk: `OFFICER#${officerId}`, sk: 'PLATFORMADMIN' };
    const listKey = { pk: 'PLATFORMADMINS', sk: `OFFICER#${officerId}` };
    if (granted) await this.kv.transact([{ kind: 'put', table: this.table, item: key }, { kind: 'put', table: this.table, item: listKey }]);
    else await this.kv.transact([{ kind: 'delete', table: this.table, key }, { kind: 'delete', table: this.table, key: listKey }]);
  }

  async platformAdminCount(): Promise<number> {
    return (await queryAll(this.kv, this.table, { pk: 'PLATFORMADMINS' })).length;
  }
}

function toAgency(i: Item): Agency {
  return { agencyId: String(i['agencyId']), name: String(i['name']), status: (i['status'] as TenancyStatus) ?? 'ACTIVE', suspendReason: i['suspendReason'] as string | undefined };
}

function toTeam(i: Item): Team {
  return {
    teamId: String(i['teamId']),
    agencyId: String(i['agencyId']),
    name: String(i['name']),
    tier: (i['tier'] as TierId) ?? 'standard',
    status: (i['status'] as TenancyStatus) ?? 'ACTIVE',
    suspendReason: i['suspendReason'] as string | undefined,
  };
}
