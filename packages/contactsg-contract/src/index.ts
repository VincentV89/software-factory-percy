import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import type { KvStore, ObjectStore } from '@percy/shared';

export const CONTACTSG_SOURCE = 'percy.contactsg';

export const suppressionReasonSchema = z.enum(['HARD_BOUNCE', 'COMPLAINT', 'UNSUBSCRIBE', 'MANUAL']);
export type SuppressionReason = z.infer<typeof suppressionReasonSchema>;

/**
 * Suppression request (owned by ContactSG; the Engine conforms to it, NFR-ARC-03).
 * Published by the Engine as event type `SuppressionRequested` on source `percy.engine`.
 */
export const suppressionRequestSchema = z
  .object({
    addrHash: z.string().regex(/^[0-9a-f]{64}$/),
    scope: z.enum(['GLOBAL', 'AGENCY']),
    agencyId: z.string().optional(),
    reason: suppressionReasonSchema,
    sourceCampaignId: z.string().optional(),
  })
  .refine((v) => v.scope === 'GLOBAL' || !!v.agencyId, { message: 'agencyId is required for AGENCY scope' });
export type SuppressionRequest = z.infer<typeof suppressionRequestSchema>;

/** Message on the `freeze-requests` queue (design 5.3). requestRef is opaque to ContactSG. */
export const freezeRequestSchema = z.object({
  freezeId: z.string(),
  requestRef: z.string(),
  agencyId: z.string(),
  teamId: z.string(),
  listId: z.string(),
  requiredFields: z.array(z.string()),
  addressAllowList: z.array(z.string()).optional(),
});
export type FreezeRequest = z.infer<typeof freezeRequestSchema>;

export const audienceFrozenSchema = z.object({ freezeId: z.string(), requestRef: z.string(), manifestKey: z.string(), recipientCount: z.number().int() });
export type AudienceFrozen = z.infer<typeof audienceFrozenSchema>;

export const audienceFreezeFailedSchema = z.object({
  freezeId: z.string(),
  requestRef: z.string(),
  reason: z.string(),
  missingFields: z.record(z.string(), z.number()).optional(),
  notAllowedCount: z.number().optional(),
});
export type AudienceFreezeFailed = z.infer<typeof audienceFreezeFailedSchema>;

export const importCompletedSchema = z.object({ importId: z.string(), teamId: z.string(), listId: z.string(), status: z.string() });
export const suppressionAddedSchema = z.object({ addrHash: z.string(), scope: z.string(), reason: suppressionReasonSchema });

/** Snapshot format: a manifest plus gzip JSONL parts in the snapshot bucket. */
export const snapshotRecipientSchema = z.object({ addrHash: z.string(), email: z.string(), attrs: z.record(z.string(), z.string()) });
export type SnapshotRecipient = z.infer<typeof snapshotRecipientSchema>;
export const snapshotManifestSchema = z.object({
  freezeId: z.string(),
  requestRef: z.string(),
  agencyId: z.string(),
  createdAt: z.string(),
  recipientCount: z.number().int(),
  parts: z.array(z.object({ key: z.string(), count: z.number().int() })),
});
export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;

/** Key layout published by the owner so readers do not guess it. */
export const suppressionKeys = {
  pk: (addrHash: string): string => `ADDR#${addrHash}`,
  globalSk: 'GLOBAL',
  agencySk: (agencyId: string): string => `AGENCY#${agencyId}`,
};
export const listKeys = { pk: (teamId: string): string => `TEAM#${teamId}`, sk: (listId: string): string => `LIST#${listId}` };

export interface SuppressionReader {
  isSuppressed(addrHash: string, agencyId: string): Promise<boolean>;
}

/** One Query on ADDR#<hash> returns every scope (D-12). Read-only. */
export class KvSuppressionReader implements SuppressionReader {
  constructor(private readonly kv: KvStore, private readonly table: string) {}
  async isSuppressed(addrHash: string, agencyId: string): Promise<boolean> {
    const out = await this.kv.query(this.table, { pk: suppressionKeys.pk(addrHash), consistent: true });
    return out.items.some((i) => i['sk'] === suppressionKeys.globalSk || i['sk'] === suppressionKeys.agencySk(agencyId));
  }
}

export interface AudienceInfo {
  exists: boolean;
  name?: string;
  memberCount: number;
  eligibleCount: number;
}

export interface ListReader {
  getAudience(teamId: string, listId: string): Promise<AudienceInfo>;
}

export class KvListReader implements ListReader {
  constructor(private readonly kv: KvStore, private readonly table: string) {}
  async getAudience(teamId: string, listId: string): Promise<AudienceInfo> {
    const i = await this.kv.get(this.table, { pk: listKeys.pk(teamId), sk: listKeys.sk(listId) });
    if (!i || i['deleted']) return { exists: false, memberCount: 0, eligibleCount: 0 };
    return { exists: true, name: String(i['name']), memberCount: Number(i['memberCount'] ?? 0), eligibleCount: Number(i['eligibleCount'] ?? 0) };
  }
}

export interface SnapshotReader {
  manifest(manifestKey: string): Promise<SnapshotManifest | undefined>;
  part(partKey: string): Promise<SnapshotRecipient[] | undefined>;
}

export class ObjectSnapshotReader implements SnapshotReader {
  constructor(private readonly store: ObjectStore, private readonly bucket: string) {}
  async manifest(manifestKey: string): Promise<SnapshotManifest | undefined> {
    const body = await this.store.get(this.bucket, manifestKey);
    return body ? snapshotManifestSchema.parse(JSON.parse(Buffer.from(body).toString('utf8'))) : undefined;
  }
  async part(partKey: string): Promise<SnapshotRecipient[] | undefined> {
    const body = await this.store.get(this.bucket, partKey);
    if (!body) return undefined;
    return gunzipSync(body)
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => snapshotRecipientSchema.parse(JSON.parse(l)));
  }
}

export interface ListHoldClient {
  acquire(teamId: string, listId: string, holderRef: string): Promise<void>;
  release(teamId: string, listId: string, holderRef: string): Promise<void>;
}

export const listHoldRequestSchema = z.object({ op: z.enum(['acquire', 'release']), teamId: z.string(), listId: z.string(), holderRef: z.string() });
export type ListHoldRequest = z.infer<typeof listHoldRequestSchema>;

export interface MemberInfo {
  addrHash: string;
  email: string;
  attrs: Record<string, string>;
}

/** Read one list member with its address (template preview, FR-TPL-04). Read-only. */
export interface MemberReader {
  getMember(teamId: string, listId: string, addrHash: string): Promise<MemberInfo | undefined>;
}

export class KvMemberReader implements MemberReader {
  constructor(private readonly kv: KvStore, private readonly table: string) {}
  async getMember(teamId: string, listId: string, addrHash: string): Promise<MemberInfo | undefined> {
    const list = await this.kv.get(this.table, { pk: listKeys.pk(teamId), sk: listKeys.sk(listId) });
    if (!list || list['deleted']) return undefined;
    const m = await this.kv.get(this.table, { pk: `TEAM#${teamId}#LIST#${listId}`, sk: `MEMBER#${addrHash}` });
    if (!m) return undefined;
    const c = await this.kv.get(this.table, { pk: `AGENCY#${String(list['agencyId'])}`, sk: `CONTACT#${addrHash}` });
    return { addrHash, email: String(c?.['email'] ?? ''), attrs: (m['attrs'] as Record<string, string>) ?? {} };
  }
}
