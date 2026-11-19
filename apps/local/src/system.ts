import {
  InMemoryKvStore,
  createLogger,
  json,
  systemClock,
  unwrapBusMessage,
  type ApiEvent,
  type ApiResult,
  type Clock,
  type EventEnvelope,
  type Logger,
  type StreamRecord,
  VirtualClock,
} from '@percy/shared';
import { MemoryMetrics, MemoryObjectStore, MemoryQueueBroker, MemoryUploadSigner, MemoryWorkflowStarter, type QueueRecord } from '@percy/shared/memory';
import { MemoryAuditClient, KvTeamReader, type Principal } from '@percy/platform-contract';
import { DEFAULT_SESSION_POLICY, SessionRepo, TenancyRepo, authorize, bootstrapPlatformAdmin, callback, createPlatformApi, login, logout, type BffDeps, type SessionPolicy } from '@percy/platform';
import {
  DEFAULT_CONTACTSG_CONFIG,
  DEFAULT_CSV_LIMITS,
  FreezeService,
  ImportService,
  ListService,
  SuppressionService,
  createContactSgApi,
  type ContactSgDeps,
  type ImportRef,
} from '@percy/contactsg';
import { KvListReader, KvMemberReader, KvSuppressionReader, ObjectSnapshotReader, audienceFrozenSchema, freezeRequestSchema, suppressionRequestSchema, type ListHoldClient } from '@percy/contactsg-contract';
import { sendCommandSchema } from '@percy/engine-contract';
import {
  CampaignService,
  DEFAULT_DP_CONFIG,
  SendSaga,
  SendWorker,
  createAggregator,
  createCommandHandler,
  createCpEventHandler,
  createEngineApi,
  createFeedbackHandler,
  createUnsubscribeHandler,
  sendBatchSchema,
  sweepInDoubt,
  type CampaignScheduler,
  type EngineCpDeps,
  type EngineDpConfig,
  type EngineDpDeps,
  type SendlogChange,
} from '@percy/engine';
import { DomainError } from '@percy/shared';
import { FakeOidc } from './fake-oidc';
import { FakeSes } from './fake-ses';

export const TABLES = {
  tenancy: 'platform-tenancy',
  sessions: 'platform-sessions',
  platformOutbox: 'platform-outbox',
  contacts: 'contactsg-contacts',
  imports: 'contactsg-imports',
  suppressions: 'contactsg-suppressions',
  freezes: 'contactsg-freezes',
  contactsgOutbox: 'contactsg-outbox',
  campaigns: 'engine-campaigns',
  sendlog: 'engine-sendlog',
  sendgate: 'engine-sendgate',
  engineOutbox: 'engine-outbox',
} as const;

export const BUCKETS = { uploads: 'contactsg-uploads', snapshots: 'contactsg-snapshots', artifacts: 'engine-artifacts' } as const;

export const QUEUES = {
  commands: 'send-commands.fifo',
  freeze: 'freeze-requests',
  batchesStandard: 'send-batches-standard',
  batchesBulk: 'send-batches-bulk',
  sesEvents: 'ses-events',
  cpEvents: 'engine-cp-events',
  sagaStart: 'engine-saga-start',
  suppress: 'contactsg-suppress-events',
  testEvents: 'test-events',
  sendlogStream: 'engine-sendlog-stream',
} as const;

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export interface SystemOptions {
  clock?: Clock;
  baseUrl?: string;
  rates?: EngineDpConfig['rates'];
  statusCacheMs?: number;
  workerConcurrency?: number;
  sessionPolicy?: SessionPolicy;
  /** Delay before simulated SES feedback events (ms of clock time). */
  feedbackDelayMs?: number;
  /** Delay before the simulated GuardDuty scan result. */
  scanDelayMs?: number;
  allowList?: string[];
  workerTimeoutMs?: number;
  logger?: Logger;
}

/** A routing rule of the percy-domain bus: source + detail-types → consumer queue. */
const BUS_RULES: { source: string; types: string[]; queue: string }[] = [
  { source: 'percy.platform', types: ['TeamSuspended', 'TeamReinstated', 'AgencySuspended', 'AgencyReinstated'], queue: QUEUES.cpEvents },
  { source: 'percy.contactsg', types: ['AudienceFrozen'], queue: QUEUES.sagaStart },
  { source: 'percy.contactsg', types: ['AudienceFreezeFailed'], queue: QUEUES.cpEvents },
  { source: 'percy.contactsg', types: ['ImportCompleted', 'SuppressionAdded', 'AudienceFrozen'], queue: QUEUES.testEvents },
  { source: 'percy.engine', types: ['SuppressionRequested'], queue: QUEUES.suppress },
  { source: 'percy.engine', types: ['SendStarted', 'SendPaused', 'SendResumed', 'SendStopped', 'SendCompleted'], queue: QUEUES.cpEvents },
];

/**
 * The whole Percy send path wired in-process with in-memory adapters (ADR-11). Used by the
 * integration tests, the virtual-clock delivery simulation and the local dev server.
 */
export function createSystem(opts: SystemOptions = {}) {
  const clock = opts.clock ?? systemClock;
  const now = (): number => clock.now();
  const baseUrl = opts.baseUrl ?? 'http://localhost:4173';
  const logger = opts.logger ?? createLogger('percy-local', { instance: 'local' });
  const kv = new InMemoryKvStore();
  const store = new MemoryObjectStore();
  const broker = new MemoryQueueBroker(clock);
  const audit = new MemoryAuditClient(now);
  const metrics = new MemoryMetrics();
  const errors: unknown[] = [];
  const workflows = new MemoryWorkflowStarter({}, (e) => {
    errors.push(e);
    logger.error('workflow failed', { error: e as Error });
  });
  const busEvents: EventEnvelope[] = [];
  const policy = opts.sessionPolicy ?? DEFAULT_SESSION_POLICY;

  // ---- Outbox → Pipes → percy-domain bus ---------------------------------
  const publish = (record: StreamRecord): void => {
    if (record.oldImage || !record.newImage) return;
    const event = record.newImage['event'] as EventEnvelope;
    busEvents.push(event);
    for (const rule of BUS_RULES) if (rule.source === event.source && rule.types.includes(event.type)) void broker.send(rule.queue, { body: { detail: event } });
  };
  for (const t of [TABLES.platformOutbox, TABLES.contactsgOutbox, TABLES.engineOutbox]) kv.onChange(t, publish);
  kv.onChange(TABLES.sendlog, (r) => {
    const change: SendlogChange = { seq: String(r.seq), keys: r.key, oldImage: r.oldImage, newImage: r.newImage };
    void broker.send(QUEUES.sendlogStream, { body: change });
  });

  // ---- Platform -----------------------------------------------------------
  const tenancy = new TenancyRepo(kv, TABLES.tenancy, TABLES.platformOutbox, now);
  const sessions = new SessionRepo(kv, TABLES.sessions, policy);
  const oidc = new FakeOidc(baseUrl);
  const bff: BffDeps = { sessions, tenancy, oidc, audit, policy, publicBaseUrl: async () => baseUrl, now, logger };
  const platformApi = createPlatformApi({ tenancy, sessions, audit, logger, testingEnabled: true,
    invitations: { invite: async () => ({ delivery: 'local' as const }) },
  });

  // ---- ContactSG ----------------------------------------------------------
  const contactSg: ContactSgDeps = {
    kv,
    tables: { contacts: TABLES.contacts, imports: TABLES.imports, suppressions: TABLES.suppressions, freezes: TABLES.freezes, outbox: TABLES.contactsgOutbox },
    store,
    signer: new MemoryUploadSigner(baseUrl),
    buckets: { uploads: BUCKETS.uploads, snapshots: BUCKETS.snapshots },
    workflows,
    importStateMachine: 'import',
    queue: broker,
    freezeQueue: QUEUES.freeze,
    audit,
    clock,
    logger,
    config: { ...DEFAULT_CONTACTSG_CONFIG, limits: DEFAULT_CSV_LIMITS },
  };
  const lists = new ListService(contactSg);
  const imports = new ImportService(contactSg);
  const suppressions = new SuppressionService(contactSg);
  const freezes = new FreezeService(contactSg);
  const contactSgApi = createContactSgApi(contactSg);
  workflows.register('import', (input) => imports.runWorkflow(input as ImportRef));
  const holds: ListHoldClient = { acquire: (t, l, r) => lists.acquireHold(t, l, r), release: (t, l, r) => lists.releaseHold(t, l, r) };

  // ---- Engine control plane -----------------------------------------------
  const scheduled = new Map<string, { teamId: string; campaignId: string }>();
  const late: { campaigns?: CampaignService } = {};
  const scheduler: CampaignScheduler = {
    async create(name, at, payload) {
      await Promise.resolve();
      scheduled.set(name, payload);
      void clock.sleep(at.getTime() - clock.now()).then(async () => {
        if (!scheduled.delete(name)) return;
        await late.campaigns?.fire(payload.teamId, payload.campaignId).catch((e: unknown) => errors.push(e));
      });
    },
    async delete(name) {
      await Promise.resolve();
      scheduled.delete(name);
    },
  };
  const allowList = opts.allowList ?? ['*@simulator.amazonses.com'];
  const cp: EngineCpDeps = {
    kv,
    tables: { campaigns: TABLES.campaigns, sendlog: TABLES.sendlog },
    queue: broker,
    queues: { commands: QUEUES.commands, freeze: QUEUES.freeze },
    store,
    artifactsBucket: BUCKETS.artifacts,
    scheduler,
    lists: new KvListReader(kv, TABLES.contacts),
    members: new KvMemberReader(kv, TABLES.contacts),
    holds,
    teams: new KvTeamReader(kv, TABLES.tenancy),
    audit,
    clock,
    logger,
    config: { instance: 'dev', fromAddress: 'percy-dev@example.gov.sg', configurationSet: 'percy-dev', addressAllowList: allowList, devExport: true, snapshotRetentionMs: 7 * 24 * 3600_000 },
  };
  const cpService = new CampaignService(cp);
  late.campaigns = cpService;
  const engineApi = createEngineApi(cp);
  const cpEvents = createCpEventHandler(cp);

  // ---- Engine data plane --------------------------------------------------
  const ses = new FakeSes(clock, { queue: broker, url: QUEUES.sesEvents, delayMs: opts.feedbackDelayMs ?? 2000 });
  const unsubscribeKeys = { current: 'k1', keys: { k1: 'local-unsubscribe-hmac-key-not-a-secret' } };
  const dpConfig: EngineDpConfig = {
    ...DEFAULT_DP_CONFIG,
    rates: opts.rates ?? { standard: 10, bulk: 10 },
    statusCacheMs: opts.statusCacheMs ?? DEFAULT_DP_CONFIG.statusCacheMs,
    workerTimeoutMs: opts.workerTimeoutMs ?? DEFAULT_DP_CONFIG.workerTimeoutMs,
    devExport: true,
  };
  const dp: EngineDpDeps = {
    kv,
    tables: { sendlog: TABLES.sendlog, sendgate: TABLES.sendgate, outbox: TABLES.engineOutbox },
    store,
    artifactsBucket: BUCKETS.artifacts,
    snapshots: new ObjectSnapshotReader(store, BUCKETS.snapshots),
    suppressions: new KvSuppressionReader(kv, TABLES.suppressions),
    queue: broker,
    batchQueues: { standard: QUEUES.batchesStandard, bulk: QUEUES.batchesBulk },
    workflows,
    stateMachines: { saga: 'saga', redrive: 'redrive', cancel: 'cancel' },
    sender: ses,
    unsubscribeKeys: async () => unsubscribeKeys,
    publicBaseUrl: async () => baseUrl,
    metrics,
    clock,
    logger,
    config: dpConfig,
  };
  const saga = new SendSaga(dp);
  const commands = createCommandHandler(dp);
  const feedback = createFeedbackHandler(dp);
  const aggregator = createAggregator(dp);
  const unsubscribe = createUnsubscribeHandler(dp);
  const workers: SendWorker[] = [];
  workflows.register('saga', (input) => saga.runSaga(audienceFrozenSchema.parse(input)));
  workflows.register('redrive', async (input) => void (await saga.redrive((input as { campaignId: string }).campaignId)));
  workflows.register('cancel', async (input) => void (await saga.cancel((input as { campaignId: string }).campaignId)));

  // ---- Queue subscriptions (Lambda event source mappings) -----------------
  const each = (fn: (r: QueueRecord) => Promise<unknown>) => async (records: QueueRecord[]) => {
    const failedIds: string[] = [];
    for (const r of records) {
      try {
        await fn(r);
      } catch (e) {
        errors.push(e);
        logger.error('consumer failed', { messageId: r.messageId, error: e as Error });
        failedIds.push(r.messageId);
      }
    }
    return { failedIds };
  };
  broker.subscribe(QUEUES.commands, each((r) => commands(sendCommandSchema.parse(r.body))), { fifo: true, batchSize: 1, concurrency: 10 });
  broker.subscribe(QUEUES.freeze, each((r) => freezes.handle(freezeRequestSchema.parse(r.body))), { concurrency: 2 });
  broker.subscribe(QUEUES.sagaStart, each(async (r) => {
    const frozen = audienceFrozenSchema.parse(unwrapBusMessage(r.body).payload);
    const campaignId = frozen.requestRef.split(':')[1] ?? frozen.requestRef;
    await workflows.start('saga', `send-${campaignId}`, frozen);
  }));
  const workerOpts = { batchSize: 1, concurrency: opts.workerConcurrency ?? 5, visibilityMs: 6 * dpConfig.workerTimeoutMs, maxReceive: 3 };
  for (const q of [QUEUES.batchesStandard, QUEUES.batchesBulk]) {
    broker.subscribe(
      q,
      each(async (r) => {
        const worker = new SendWorker(dp);
        workers.push(worker);
        await worker.process(sendBatchSchema.parse(r.body), clock.now() + dpConfig.workerTimeoutMs);
      }),
      workerOpts,
    );
  }
  broker.subscribe(QUEUES.sesEvents, each((r) => feedback(r.body)), { batchSize: 10, concurrency: 2 });
  broker.subscribe(QUEUES.cpEvents, each((r) => cpEvents(unwrapBusMessage(r.body))), { concurrency: 1 });
  broker.subscribe(QUEUES.suppress, each((r) => suppressions.suppress(suppressionRequestSchema.parse(unwrapBusMessage(r.body).payload))), { concurrency: 2 });
  broker.subscribe(QUEUES.sendlogStream, async (records) => {
    try {
      await aggregator.handle(records.map((r) => r.body as SendlogChange));
    } catch (e) {
      errors.push(e);
      return { failedIds: records.map((r) => r.messageId) };
    }
    return {};
  }, { batchSize: 40, concurrency: 1, visibilityMs: 1000, maxReceive: 10 });

  // ---- HTTP edge (CloudFront behaviours + API Gateway + authorizer) -------
  async function http(event: ApiEvent): Promise<ApiResult> {
    const path = event.path;
    const requestId = event.requestContext?.requestId ?? `req-${clock.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const headerOf = (n: string): string | undefined => Object.entries(event.headers ?? {}).find(([k]) => k.toLowerCase() === n)?.[1] ?? undefined;
    try {
      if (path === '/auth/login' && event.httpMethod === 'GET') return await login(bff);
      if (path === '/auth/callback' && event.httpMethod === 'GET') return await callback({ code: event.queryStringParameters?.['code'], state: event.queryStringParameters?.['state'], cookieHeader: headerOf('cookie'), requestId }, bff);
      if (path === '/auth/logout' && event.httpMethod === 'POST') return await logout({ cookieHeader: headerOf('cookie'), csrfHeader: headerOf('x-csrf-token'), requestId }, bff);
      if (path.startsWith('/u/')) return await unsubscribe(event);
      if (path.startsWith('/api/')) {
        let principal: Principal;
        try {
          principal = await authorize({ method: event.httpMethod, path, cookieHeader: headerOf('cookie'), csrfHeader: headerOf('x-csrf-token'), requestId }, { sessions, tenancy, audit, policy, now, logger });
        } catch (e) {
          if (e instanceof DomainError && e.status === 401) return json(401, { message: 'Unauthorized' });
          if (e instanceof DomainError && e.status === 403) return json(403, { message: 'User is not authorized to access this resource' });
          throw e;
        }
        const withAuth: ApiEvent = { ...event, requestContext: { ...(event.requestContext ?? {}), requestId, authorizer: { principal: JSON.stringify(principal) } } };
        if (path.startsWith('/api/platform/')) return await platformApi.handle(withAuth);
        if (path.startsWith('/api/contacts/')) return await contactSgApi.handle(withAuth);
        if (path.startsWith('/api/engine/')) return await engineApi.handle(withAuth);
        return json(403, { message: 'Missing Authentication Token' });
      }
      return json(404, { message: 'Not found' });
    } catch (e) {
      if (e instanceof DomainError) return json(e.status, { error: { code: e.code, message: e.message, details: e.details, requestId } });
      errors.push(e);
      logger.error('edge error', { path, error: e as Error });
      return json(500, { error: { code: 'INTERNAL', message: 'Something went wrong.', details: [], requestId } });
    }
  }

  /** Local presigned-POST target plus the GuardDuty simulation (EICAR → THREATS_FOUND). */
  async function upload(key: string, body: Uint8Array): Promise<void> {
    if (body.byteLength > DEFAULT_CSV_LIMITS.maxBytes) throw new Error('EntityTooLarge');
    await store.put(BUCKETS.uploads, key, body);
    await imports.onObjectCreated(key);
    const infected = Buffer.from(body).toString('latin1').includes(EICAR);
    const scan = async (): Promise<void> => imports.onScanResult(key, infected ? 'THREATS_FOUND' : 'NO_THREATS_FOUND', `scan-${key}`);
    if (opts.scanDelayMs) void clock.sleep(opts.scanDelayMs).then(scan);
    else await scan();
  }

  /** Wait until every queue, workflow and timer-free task has drained (virtual clock friendly). */
  async function settle(): Promise<void> {
    if (clock instanceof VirtualClock) return clock.settle(200);
    for (let i = 0; i < 50; i++) {
      await new Promise<void>((r) => setImmediate(r));
      await broker.whenIdle();
    }
  }

  return {
    clock,
    kv,
    store,
    broker,
    audit,
    metrics,
    ses,
    errors,
    busEvents,
    tenancy,
    sessions,
    oidc,
    lists,
    imports,
    suppressions,
    freezes,
    campaigns: cpService,
    saga,
    commands,
    feedback,
    aggregator,
    dp,
    cp,
    contactSg,
    workers,
    scheduled,
    http,
    upload,
    settle,
    /** Advance virtual time (VirtualClock only), firing timers and draining work on the way. */
    runFor: async (ms: number): Promise<void> => {
      if (!(clock instanceof VirtualClock)) throw new Error('runFor needs a VirtualClock');
      await clock.advance(ms);
    },
    sweep: () => sweepInDoubt(dp),
    bootstrap: (email: string) => bootstrapPlatformAdmin(tenancy, audit, email, { force: true }),
    unsubscribeKeys,
    EICAR,
  };
}

export type PercySystem = ReturnType<typeof createSystem>;
