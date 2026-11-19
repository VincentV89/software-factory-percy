import type { Clock, KvStore, Logger, ObjectStore, QueueSender, UploadSigner, WorkflowStarter } from '@percy/shared';
import type { AuditClient } from '@percy/platform-contract';
import type { CsvLimits } from './domain/csv';

export interface ContactSgTables {
  contacts: string;
  imports: string;
  suppressions: string;
  freezes: string;
  outbox: string;
}

export interface ContactSgConfig {
  limits: CsvLimits;
  chunkSize: number;
  partSize: number;
  uploadUrlTtlSeconds: number;
  /** Freeze work budget per invocation before it re-enqueues itself. */
  freezeBudgetMs: number;
}

export const DEFAULT_CONTACTSG_CONFIG: Omit<ContactSgConfig, 'limits'> = { chunkSize: 5000, partSize: 10_000, uploadUrlTtlSeconds: 900, freezeBudgetMs: 10 * 60_000 };

export interface ContactSgDeps {
  kv: KvStore;
  tables: ContactSgTables;
  store: ObjectStore;
  signer: UploadSigner;
  buckets: { uploads: string; snapshots: string };
  workflows: WorkflowStarter;
  importStateMachine: string;
  queue: QueueSender;
  freezeQueue: string;
  audit: AuditClient;
  clock: Clock;
  logger: Logger;
  config: ContactSgConfig;
}
