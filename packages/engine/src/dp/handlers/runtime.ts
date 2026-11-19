import { cached, createLogger, requireEnv, systemClock } from '@percy/shared';
import { DynamoKvStore } from '@percy/shared/dynamo';
import { AwsSecrets, CloudWatchMetrics, S3ObjectStore, SfnWorkflowStarter, SqsQueueSender } from '@percy/shared/aws';
import { KvSuppressionReader, ObjectSnapshotReader } from '@percy/contactsg-contract';
import { SesEmailSender } from '@percy/integrations-ses/aws';
import { parseUnsubscribeSecret } from '../../domain/unsubscribe-token';
import { DEFAULT_DP_CONFIG, type EngineDpDeps } from '../deps';

/** Composition root for the Engine data-plane Lambdas. No control-plane resource appears here. */
export function engineDpRuntime(service: string): EngineDpDeps {
  const kv = new DynamoKvStore();
  const store = new S3ObjectStore();
  const secrets = new AwsSecrets();
  const instance = requireEnv('PERCY_INSTANCE');
  const rates = process.env['TIER_RATES'] ? (JSON.parse(process.env['TIER_RATES']) as EngineDpDeps['config']['rates']) : DEFAULT_DP_CONFIG.rates;
  return {
    kv,
    tables: { sendlog: requireEnv('SENDLOG_TABLE'), sendgate: requireEnv('SENDGATE_TABLE'), outbox: requireEnv('ENGINE_OUTBOX_TABLE') },
    store,
    artifactsBucket: requireEnv('ARTIFACTS_BUCKET'),
    snapshots: new ObjectSnapshotReader(store, requireEnv('SNAPSHOTS_BUCKET')),
    suppressions: new KvSuppressionReader(kv, requireEnv('SUPPRESSIONS_TABLE')),
    queue: new SqsQueueSender(),
    batchQueues: { standard: process.env['BATCH_QUEUE_STANDARD_URL'] ?? '', bulk: process.env['BATCH_QUEUE_BULK_URL'] ?? '' },
    workflows: new SfnWorkflowStarter(),
    stateMachines: { saga: process.env['SAGA_STATE_MACHINE_ARN'] ?? '', redrive: process.env['REDRIVE_STATE_MACHINE_ARN'] ?? '', cancel: process.env['CANCEL_STATE_MACHINE_ARN'] ?? '' },
    sender: new SesEmailSender(),
    unsubscribeKeys: cached(async () => parseUnsubscribeSecret(await secrets.getSecret(requireEnv('UNSUBSCRIBE_SECRET_ID'))), 5 * 60_000),
    publicBaseUrl: cached(() => secrets.getParam(requireEnv('PUBLIC_BASE_URL_PARAM')), 5 * 60_000),
    metrics: new CloudWatchMetrics('Percy'),
    clock: systemClock,
    logger: createLogger(service, { instance }),
    config: {
      ...DEFAULT_DP_CONFIG,
      instance,
      rates,
      statusCacheMs: Math.min(30_000, Number(process.env['STATUS_CACHE_MS'] ?? DEFAULT_DP_CONFIG.statusCacheMs)),
      devExport: instance === 'dev' && process.env['DEV_EXPORT'] === 'true',
    },
  };
}
