import { z } from 'zod';
import { newId } from '@percy/shared';

export const auditOutcomeSchema = z.enum(['success', 'denied', 'error']);

/** Audit record (FR-AUD-01). Never contains email addresses, attributes or template bodies. */
export const auditEventSchema = z.object({
  eventId: z.string(),
  timestamp: z.string(),
  actor: z.string(),
  agencyId: z.string().optional(),
  teamId: z.string().optional(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  outcome: auditOutcomeSchema,
  requestId: z.string(),
  scope: z.string().optional(),
  reason: z.string().optional(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditInput = Omit<AuditEvent, 'eventId' | 'timestamp'>;

export interface AuditClient {
  record(event: AuditInput): Promise<void>;
}

export function buildAuditEvent(input: AuditInput, now: number): AuditEvent {
  return auditEventSchema.parse({ ...input, eventId: newId(now), timestamp: new Date(now).toISOString() });
}

/** In-memory audit sink for tests and the local runtime. */
export class MemoryAuditClient implements AuditClient {
  readonly events: AuditEvent[] = [];
  constructor(private readonly now: () => number = Date.now) {}
  async record(input: AuditInput): Promise<void> {
    await Promise.resolve();
    this.events.push(buildAuditEvent(input, this.now()));
  }
}
