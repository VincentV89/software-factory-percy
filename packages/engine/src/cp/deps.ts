import type { Clock, KvStore, Logger, ObjectStore, QueueSender } from '@percy/shared';
import type { AuditClient, TeamReader } from '@percy/platform-contract';
import type { ListHoldClient, ListReader, MemberReader } from '@percy/contactsg-contract';

/** One-time schedule port (EventBridge Scheduler in AWS). */
export interface CampaignScheduler {
  create(name: string, at: Date, payload: { teamId: string; campaignId: string }): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface EngineCpConfig {
  instance: string;
  fromAddress: string;
  configurationSet?: string;
  /** Optional legacy restriction for custom instances. Dev eligibility is read from SES by ContactSG. */
  addressAllowList?: string[];
  /** Enables the dev-only send-log export (U7). */
  devExport: boolean;
  snapshotRetentionMs: number;
}

export interface EngineCpDeps {
  kv: KvStore;
  tables: { campaigns: string; sendlog: string };
  queue: QueueSender;
  queues: { commands: string; freeze: string };
  store: ObjectStore;
  artifactsBucket: string;
  scheduler: CampaignScheduler;
  lists: ListReader;
  members: MemberReader;
  holds: ListHoldClient;
  teams: TeamReader;
  audit: AuditClient;
  clock: Clock;
  logger: Logger;
  config: EngineCpConfig;
}
