import { Conflict, NotFound, cond, isConditionFailure, newId, queryAll, type Item } from '@percy/shared';
import { listKeys } from '@percy/contactsg-contract';
import type { ContactSgDeps } from './deps';

export interface ContactList {
  listId: string;
  teamId: string;
  agencyId: string;
  name: string;
  memberCount: number;
  eligibleCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Member {
  addrHash: string;
  email?: string;
  attrs: Record<string, string>;
  suppressed: boolean;
}

export const memberPk = (teamId: string, listId: string): string => `TEAM#${teamId}#LIST#${listId}`;
export const contactKey = (agencyId: string, addrHash: string) => ({ pk: `AGENCY#${agencyId}`, sk: `CONTACT#${addrHash}` });

function toList(i: Item): ContactList {
  return {
    listId: String(i['listId']),
    teamId: String(i['teamId']),
    agencyId: String(i['agencyId']),
    name: String(i['name']),
    memberCount: Number(i['memberCount'] ?? 0),
    eligibleCount: Number(i['eligibleCount'] ?? 0),
    createdAt: String(i['createdAt']),
    updatedAt: String(i['updatedAt']),
  };
}

/** Lists, memberships and list holds in contactsg-contacts. */
export class ListService {
  constructor(private readonly d: Pick<ContactSgDeps, 'kv' | 'tables' | 'clock'>) {}

  private get t(): string {
    return this.d.tables.contacts;
  }

  async create(teamId: string, agencyId: string, name: string): Promise<ContactList> {
    const now = new Date(this.d.clock.now()).toISOString();
    const listId = newId(this.d.clock.now());
    const item = { pk: listKeys.pk(teamId), sk: listKeys.sk(listId), listId, teamId, agencyId, name: name.trim(), memberCount: 0, eligibleCount: 0, createdAt: now, updatedAt: now };
    await this.d.kv.put(this.t, item, cond.itemAbsent());
    return toList(item);
  }

  async get(teamId: string, listId: string): Promise<ContactList> {
    const i = await this.d.kv.get(this.t, { pk: listKeys.pk(teamId), sk: listKeys.sk(listId) });
    if (!i || i['deleted']) throw new NotFound('List not found.');
    return toList(i);
  }

  async list(teamId: string): Promise<ContactList[]> {
    const items = await queryAll(this.d.kv, this.t, { pk: listKeys.pk(teamId), sk: { beginsWith: 'LIST#' } });
    return items.filter((i) => !i['deleted']).map(toList).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async rename(teamId: string, listId: string, name: string): Promise<ContactList> {
    try {
      const out = await this.d.kv.update(
        this.t,
        { pk: listKeys.pk(teamId), sk: listKeys.sk(listId) },
        { set: { name: name.trim(), updatedAt: new Date(this.d.clock.now()).toISOString() } },
        { cond: cond.and(cond.itemPresent(), cond.notExists('deleted')) },
      );
      return toList(out.new);
    } catch (e) {
      if (isConditionFailure(e)) throw new NotFound('List not found.');
      throw e;
    }
  }

  /** Refuses with 409 while a campaign holds the list (FR-CON-01). */
  async delete(teamId: string, listId: string): Promise<void> {
    await this.get(teamId, listId);
    const holds = await this.d.kv.query(this.t, { pk: memberPk(teamId, listId), sk: { beginsWith: 'HOLD#' }, limit: 1, consistent: true });
    if (holds.items.length > 0) throw new Conflict('This list is used by a scheduled or sending campaign and cannot be deleted.');
    await this.d.kv.update(this.t, { pk: listKeys.pk(teamId), sk: listKeys.sk(listId) }, { set: { deleted: true, updatedAt: new Date(this.d.clock.now()).toISOString() } });
  }

  async acquireHold(teamId: string, listId: string, holderRef: string): Promise<void> {
    await this.get(teamId, listId);
    await this.d.kv.put(this.t, { pk: memberPk(teamId, listId), sk: `HOLD#${holderRef}`, at: this.d.clock.now() });
  }

  async releaseHold(teamId: string, listId: string, holderRef: string): Promise<void> {
    await this.d.kv.delete(this.t, { pk: memberPk(teamId, listId), sk: `HOLD#${holderRef}` });
  }

  async members(teamId: string, listId: string, cursor?: string, limit = 50): Promise<{ items: Member[]; cursor?: string }> {
    const list = await this.get(teamId, listId);
    const page = await this.d.kv.query(this.t, { pk: memberPk(teamId, listId), sk: { beginsWith: 'MEMBER#' }, cursor, limit });
    const contacts = await this.d.kv.batchGet(this.t, page.items.map((m) => contactKey(list.agencyId, String(m['addrHash']))));
    const emailByHash = new Map(contacts.map((c) => [String(c['sk']).slice('CONTACT#'.length), String(c['email'])]));
    return {
      items: page.items.map((m) => ({ addrHash: String(m['addrHash']), email: emailByHash.get(String(m['addrHash'])), attrs: (m['attrs'] as Record<string, string>) ?? {}, suppressed: m['suppressed'] === true })),
      cursor: page.cursor,
    };
  }
}
