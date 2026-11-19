import { makeEvent, outboxPut, type Clock, type KvStore, type Logger, type MetricsSink, type ObjectStore, type QueueSender, type TxOp, type WorkflowStarter } from '@percy/shared';
import type { SnapshotReader, SuppressionReader } from '@percy/contactsg-contract';
import { ENGINE_SOURCE } from '@percy/engine-contract';
import type { EmailSender } from '@percy/integrations-ses';
import type { TierId } from '@percy/platform-contract';
import { scopesCovering } from '../domain/rules';
import { sendSpecSchema, sendlogKeys, specKey, type SendSpec } from '../domain/send';
import type { UnsubscribeKeys } from '../domain/unsubscribe-token';

export interface EngineDpConfig {
  instance: string;
  /** Emails per second per tier (FR-TEN-04, A10). */
  rates: Record<TierId, number>;
  /** Status/gate cache, ≤ 10 s by default, 30 s hard maximum (FR-DLV-03). */
  statusCacheMs: number;
  batchSize: number;
  workerTimeoutMs: number;
  inDoubtMs: number;
  circuitBreakerMs: number;
  maxBackoffMs: number;
  /** Writes devUnsubUrl on rows (dev only, U7). */
  devExport: boolean;
}

export const DEFAULT_DP_CONFIG: EngineDpConfig = {
  instance: 'dev',
  rates: { standard: 1, bulk: 1 },
  statusCacheMs: 10_000,
  batchSize: 50,
  workerTimeoutMs: 900_000,
  inDoubtMs: 15 * 60_000,
  circuitBreakerMs: 5 * 60_000,
  maxBackoffMs: 60_000,
  devExport: false,
};

export interface EngineDpDeps {
  kv: KvStore;
  tables: { sendlog: string; sendgate: string; outbox: string };
  store: ObjectStore;
  artifactsBucket: string;
  snapshots: SnapshotReader;
  suppressions: SuppressionReader;
  queue: QueueSender;
  batchQueues: Record<TierId, string>;
  workflows: WorkflowStarter;
  stateMachines: { saga: string; redrive: string; cancel: string };
  sender: EmailSender;
  unsubscribeKeys: () => Promise<UnsubscribeKeys>;
  publicBaseUrl: () => Promise<string>;
  metrics: MetricsSink;
  clock: Clock;
  logger: Logger;
  config: EngineDpConfig;
}

export function eventOp(d: Pick<EngineDpDeps, 'tables' | 'clock'>, type: string, payload: Record<string, unknown>): TxOp {
  const now = d.clock.now();
  return outboxPut(d.tables.outbox, makeEvent(ENGINE_SOURCE, type, payload, now), Math.floor(now / 1000));
}

export async function activeGates(d: Pick<EngineDpDeps, 'kv' | 'tables'>, agencyId: string, teamId: string): Promise<string[]> {
  const items = await d.kv.batchGet(d.tables.sendgate, scopesCovering(agencyId, teamId).map((s) => ({ pk: `GATE#${s}`, sk: 'GATE' })));
  return items.map((i) => String(i['pk']).slice('GATE#'.length));
}

const specCache = new Map<string, SendSpec>();

/** Send specs are immutable once written, so they are cached per container. */
export async function loadSpec(d: Pick<EngineDpDeps, 'store' | 'artifactsBucket'>, campaignId: string): Promise<SendSpec | undefined> {
  const hit = specCache.get(`${d.artifactsBucket}/${campaignId}`);
  if (hit) return hit;
  const body = await d.store.get(d.artifactsBucket, specKey(campaignId));
  if (!body) return undefined;
  const spec = sendSpecSchema.parse(JSON.parse(Buffer.from(body).toString('utf8')));
  specCache.set(`${d.artifactsBucket}/${campaignId}`, spec);
  return spec;
}

export async function getStatus(d: Pick<EngineDpDeps, 'kv' | 'tables'>, campaignId: string) {
  return d.kv.get(d.tables.sendlog, sendlogKeys.status(campaignId), { consistent: true });
}

export type { Logger };
