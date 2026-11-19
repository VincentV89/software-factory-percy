/** Per-instance configuration (design section 8). Values are configuration, not code. */
export interface InstanceConfig {
  instance: string;
  account: string;
  region: string;
  /** Emails per second per tier (A10: 1/s each in the SES sandbox). */
  tierRates: { standard: number; bulk: number };
  /** Reserved concurrency per send-worker tier (NFR-INF-07: 5 in dev). */
  workerReservedConcurrency: number;
  /** percy-cp stage throttle (NFR-INF-07: 50 rps in dev). */
  apiThrottleRps: number;
  statusCacheMs: number;
  /** Optional legacy recipient restriction for custom instances; dev reads SES verification live. */
  addressAllowList?: string[];
  sesIdentity: string;
  auditRetentionDays: number;
  snapshotRetentionDays: number;
  /** dev → DESTROY + autoDeleteObjects; uat/prod → RETAIN + deletion protection (NFR-INF-06). */
  retain: boolean;
  /** Dev-only send-log export for E2E-01 (U7). */
  devExport: boolean;
  wafRateLimits: { unsubscribe: number; default: number };
}

export function loadConfig(instance: string, ctx: { account?: string; sesIdentity?: string } = {}): InstanceConfig {
  const account = ctx.account ?? process.env['CDK_DEFAULT_ACCOUNT'] ?? '000000000000';
  const region = 'ap-southeast-1';
  const sesIdentity = ctx.sesIdentity ?? 'percy-dev@example.gov.sg';
  const base: InstanceConfig = {
    instance,
    account,
    region,
    tierRates: { standard: 1, bulk: 1 },
    workerReservedConcurrency: 5,
    apiThrottleRps: 50,
    statusCacheMs: 10_000,
    sesIdentity,
    auditRetentionDays: 365,
    snapshotRetentionDays: 7,
    retain: false,
    devExport: false,
    wafRateLimits: { unsubscribe: 300, default: 2000 },
  };
  switch (instance) {
    case 'dev':
      return { ...base, devExport: true };
    case 'uat':
    case 'prod':
      return { ...base, retain: true, workerReservedConcurrency: 20 };
    default:
      if (!/^[a-z][a-z0-9-]{1,15}$/.test(instance)) throw new Error(`invalid instance id ${instance}`);
      return { ...base, addressAllowList: [sesIdentity, '*@simulator.amazonses.com'] };
  }
}
