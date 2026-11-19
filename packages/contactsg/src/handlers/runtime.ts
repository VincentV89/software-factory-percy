import { DEFAULT_CONTACTSG_CONFIG, DEFAULT_CSV_LIMITS, type ContactSgDeps } from '../index';
import { createLogger, requireEnv, systemClock } from '@percy/shared';
import { DynamoKvStore } from '@percy/shared/dynamo';
import { S3ObjectStore, SfnWorkflowStarter, SqsQueueSender } from '@percy/shared/aws';
import { FirehoseAuditClient } from '@percy/platform-contract/aws';

/** Composition root shared by the ContactSG Lambdas. */
export function contactSgRuntime(service: string): ContactSgDeps {
  const store = new S3ObjectStore();
  return {
    kv: new DynamoKvStore(),
    tables: {
      contacts: requireEnv('CONTACTS_TABLE'),
      imports: requireEnv('IMPORTS_TABLE'),
      suppressions: requireEnv('SUPPRESSIONS_TABLE'),
      freezes: requireEnv('FREEZES_TABLE'),
      outbox: requireEnv('CONTACTSG_OUTBOX_TABLE'),
    },
    store,
    signer: store,
    buckets: { uploads: requireEnv('UPLOADS_BUCKET'), snapshots: requireEnv('SNAPSHOTS_BUCKET') },
    workflows: new SfnWorkflowStarter(),
    importStateMachine: process.env['IMPORT_STATE_MACHINE_ARN'] ?? '',
    queue: new SqsQueueSender(),
    freezeQueue: process.env['FREEZE_QUEUE_URL'] ?? '',
    audit: new FirehoseAuditClient(requireEnv('AUDIT_STREAM')),
    clock: systemClock,
    logger: createLogger(service, { instance: process.env['PERCY_INSTANCE'] }),
    config: { ...DEFAULT_CONTACTSG_CONFIG, limits: DEFAULT_CSV_LIMITS },
  };
}
