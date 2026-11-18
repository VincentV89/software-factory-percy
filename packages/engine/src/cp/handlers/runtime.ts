import { createLogger, requireEnv, systemClock } from '@percy/shared';
import { DynamoKvStore } from '@percy/shared/dynamo';
import { S3ObjectStore, SqsQueueSender } from '@percy/shared/aws';
import { FirehoseAuditClient } from '@percy/platform-contract/aws';
import { KvTeamReader } from '@percy/platform-contract';
import { KvListReader, KvMemberReader } from '@percy/contactsg-contract';
import { LambdaListHoldClient } from '@percy/contactsg-contract/aws';
import { AwsCampaignScheduler } from '../aws-scheduler';
import type { EngineCpDeps } from '../deps';

/** Composition root for the Engine control-plane Lambdas. */
export function engineCpRuntime(service: string): EngineCpDeps {
  const kv = new DynamoKvStore();
  const instance = requireEnv('PERCY_INSTANCE');
  const allow = process.env['ADDRESS_ALLOW_LIST'];
  return {
    kv,
    tables: { campaigns: requireEnv('CAMPAIGNS_TABLE'), sendlog: requireEnv('SENDLOG_TABLE') },
    queue: new SqsQueueSender(),
    queues: { commands: requireEnv('COMMANDS_QUEUE_URL'), freeze: requireEnv('FREEZE_QUEUE_URL') },
    store: new S3ObjectStore(),
    artifactsBucket: requireEnv('ARTIFACTS_BUCKET'),
    scheduler: new AwsCampaignScheduler({ group: requireEnv('SCHEDULER_GROUP'), targetArn: process.env['SCHEDULE_FIRE_ARN'] ?? '', roleArn: requireEnv('SCHEDULER_ROLE_ARN') }),
    lists: new KvListReader(kv, requireEnv('CONTACTS_TABLE')),
    members: new KvMemberReader(kv, requireEnv('CONTACTS_TABLE')),
    holds: new LambdaListHoldClient(requireEnv('LIST_HOLD_FUNCTION')),
    teams: new KvTeamReader(kv, requireEnv('TENANCY_TABLE')),
    audit: new FirehoseAuditClient(requireEnv('AUDIT_STREAM')),
    clock: systemClock,
    logger: createLogger(service, { instance }),
    config: {
      instance,
      fromAddress: requireEnv('FROM_ADDRESS'),
      configurationSet: process.env['CONFIGURATION_SET'],
      addressAllowList: allow ? allow.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      devExport: instance === 'dev' && process.env['DEV_EXPORT'] === 'true',
      snapshotRetentionMs: 7 * 24 * 3600_000,
    },
  };
}
