import { unmarshall } from '@aws-sdk/util-dynamodb';
import { z } from 'zod';
import { newId } from './crypto';
import type { TxOp } from './kv/types';

/** Domain event envelope on the percy-domain bus (design 5.4). Payloads carry ids and hashes only. */
export const eventEnvelopeSchema = z.object({
  eventId: z.string(),
  type: z.string(),
  source: z.string(),
  occurredAt: z.string(),
  schemaVersion: z.literal(1),
  payload: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export function makeEvent(source: string, type: string, payload: Record<string, unknown>, now: number): EventEnvelope {
  return { eventId: newId(now), type, source, occurredAt: new Date(now).toISOString(), schemaVersion: 1, payload };
}

/** Outbox row: written in the same transaction as the state change, published by Streams → Pipes. */
export function outboxPut(table: string, event: EventEnvelope, nowSeconds: number): TxOp {
  return {
    kind: 'put',
    table,
    item: { pk: `EVT#${event.eventId}`, sk: 'EVT', event, expiresAt: nowSeconds + 7 * 24 * 3600 },
    cond: { op: 'notExists', attr: 'pk' },
  };
}

/**
 * Bus consumers receive the EventBridge envelope `{ detail: <event> }` via SQS; local runs pass
 * the event directly. Returns the validated envelope.
 */
export function unwrapBusMessage(body: unknown): EventEnvelope {
  let candidate = body && typeof body === 'object' && 'detail' in body ? (body as { detail: unknown }).detail : body;
  // EventBridge Pipes forwards the DynamoDB stream record as the detail; the outbox row holds the event.
  const image = (candidate as { dynamodb?: { NewImage?: Record<string, unknown> } } | undefined)?.dynamodb?.NewImage;
  if (image) candidate = (unmarshall(image as Parameters<typeof unmarshall>[0]) as { event?: unknown }).event;
  return eventEnvelopeSchema.parse(candidate);
}
