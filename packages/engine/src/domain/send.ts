import { z } from 'zod';
import type { Item } from '@percy/shared';

/** Recipient send-log row status lifecycle (design section 6). */
export const RECIPIENT_STATUSES = ['PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED_SUPPRESSED', 'CANCELLED', 'IN_DOUBT'] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const COUNTER_NAMES = ['pending', 'sending', 'sent', 'delivered', 'bouncedHard', 'bouncedSoft', 'complained', 'failed', 'skipped', 'cancelled', 'inDoubt'] as const;
export type CounterName = (typeof COUNTER_NAMES)[number];
export type Counters = Record<CounterName, number>;

export const zeroCounters = (): Counters => Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0])) as Counters;

const STATUS_COUNTER: Record<RecipientStatus, CounterName> = {
  PENDING: 'pending',
  SENDING: 'sending',
  SENT: 'sent',
  FAILED: 'failed',
  SKIPPED_SUPPRESSED: 'skipped',
  CANCELLED: 'cancelled',
  IN_DOUBT: 'inDoubt',
};

/** Counter contribution of one send-log row image. */
export function contribution(row: Item | undefined): Partial<Counters> {
  if (!row || typeof row['status'] !== 'string') return {};
  const out: Partial<Counters> = {};
  const c = STATUS_COUNTER[row['status'] as RecipientStatus];
  if (c) out[c] = 1;
  if (row['delivered']) out.delivered = 1;
  if (row['bounced'] === 'hard') out.bouncedHard = 1;
  if (row['bounced'] === 'soft') out.bouncedSoft = 1;
  if (row['complained']) out.complained = 1;
  return out;
}

/** new − old, the delta a stream record contributes (ADR-09). */
export function counterDelta(oldRow: Item | undefined, newRow: Item | undefined): Partial<Counters> {
  const a = contribution(oldRow);
  const b = contribution(newRow);
  const out: Partial<Counters> = {};
  for (const n of COUNTER_NAMES) {
    const d = (b[n] ?? 0) - (a[n] ?? 0);
    if (d !== 0) out[n] = d;
  }
  return out;
}

export const FINAL_STATUSES: RecipientStatus[] = ['SENT', 'FAILED', 'SKIPPED_SUPPRESSED', 'CANCELLED', 'IN_DOUBT'];

/** Send status of a campaign in the data plane (`CMP#c / STATUS`). */
export type SendStatus = 'SENDING' | 'PAUSED' | 'STOPPED' | 'COMPLETED';

/** Immutable send spec written by cp before the freeze request and read by dp (ADR-04). */
export const sendSpecSchema = z.object({
  campaignId: z.string(),
  teamId: z.string(),
  agencyId: z.string(),
  agencyName: z.string(),
  tier: z.enum(['standard', 'bulk']),
  listId: z.string(),
  senderName: z.string(),
  fromAddress: z.string(),
  configurationSet: z.string().optional(),
  template: z.object({ subject: z.string(), html: z.string(), text: z.string() }),
  requiredFields: z.array(z.string()),
  createdAt: z.string(),
});
export type SendSpec = z.infer<typeof sendSpecSchema>;
export const specKey = (campaignId: string): string => `specs/${campaignId}.json`;

/** Batch message on send-batches-<tier> (design 5.3). */
export const batchRecipientSchema = z.object({ pk: z.string(), sk: z.string(), addrHash: z.string(), email: z.string(), attrs: z.record(z.string(), z.string()) });
export type BatchRecipient = z.infer<typeof batchRecipientSchema>;
export const sendBatchSchema = z.object({
  campaignId: z.string(),
  batchId: z.string(),
  tier: z.enum(['standard', 'bulk']),
  agencyId: z.string(),
  teamId: z.string(),
  recipients: z.array(batchRecipientSchema).max(50),
  attempt: z.number().int(),
});
export type SendBatch = z.infer<typeof sendBatchSchema>;

export const sendlogKeys = {
  status: (c: string) => ({ pk: `CMP#${c}`, sk: 'STATUS' }),
  counters: (c: string) => ({ pk: `CMP#${c}`, sk: 'COUNTERS' }),
  partPk: (c: string, part: number) => `CMP#${c}#P#${String(part).padStart(5, '0')}`,
  rowSk: (idx: number) => `R#${String(idx).padStart(6, '0')}`,
};

/** Opaque freeze requestRef: `<teamId>:<campaignId>`. */
export const requestRefOf = (c: { teamId: string; campaignId: string }): string => `${c.teamId}:${c.campaignId}`;
export function parseRequestRef(ref: string): { teamId: string; campaignId: string } {
  const [teamId, campaignId, extra] = ref.split(':');
  if (!teamId || !campaignId || extra !== undefined) throw new Error(`bad requestRef ${ref}`);
  return { teamId, campaignId };
}
