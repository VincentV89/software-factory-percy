import { DEFAULT_SESSION_POLICY, SessionRepo, TenancyRepo } from '../index';
import { cached, createLogger, requireEnv } from '@percy/shared';
import { DynamoKvStore } from '@percy/shared/dynamo';
import { AwsSecrets } from '@percy/shared/aws';
import { FirehoseAuditClient } from '@percy/platform-contract/aws';

/** Composition root shared by the Platform Lambdas: builds adapters from environment variables. */
export function platformRuntime(service: string) {
  const kv = new DynamoKvStore();
  const now = (): number => Date.now();
  const secrets = new AwsSecrets();
  return {
    kv,
    now,
    secrets,
    logger: createLogger(service, { instance: process.env['PERCY_INSTANCE'] }),
    policy: DEFAULT_SESSION_POLICY,
    tenancy: new TenancyRepo(kv, requireEnv('TENANCY_TABLE'), requireEnv('PLATFORM_OUTBOX_TABLE'), now),
    sessions: new SessionRepo(kv, requireEnv('SESSIONS_TABLE'), DEFAULT_SESSION_POLICY),
    audit: new FirehoseAuditClient(requireEnv('AUDIT_STREAM')),
    publicBaseUrl: cached(() => secrets.getParam(requireEnv('PUBLIC_BASE_URL_PARAM')), 5 * 60_000),
  };
}
