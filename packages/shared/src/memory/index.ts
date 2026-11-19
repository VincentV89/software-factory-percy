import type { Clock } from '../clock';
import { systemClock } from '../clock';
import type { MetricsSink, ObjectStore, OutgoingMessage, ParamStore, PresignedUpload, QueueSender, SecretStore, UploadSigner, WorkflowStarter } from '../ports';

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  private k = (b: string, key: string): string => `${b}/${key}`;

  async put(bucket: string, key: string, body: string | Uint8Array): Promise<void> {
    await Promise.resolve();
    this.objects.set(this.k(bucket, key), typeof body === 'string' ? new TextEncoder().encode(body) : body);
  }
  async get(bucket: string, key: string): Promise<Uint8Array | undefined> {
    await Promise.resolve();
    return this.objects.get(this.k(bucket, key));
  }
  async delete(bucket: string, key: string): Promise<void> {
    await Promise.resolve();
    this.objects.delete(this.k(bucket, key));
  }
  async list(bucket: string, prefix: string): Promise<string[]> {
    await Promise.resolve();
    const p = this.k(bucket, prefix);
    return [...this.objects.keys()].filter((k) => k.startsWith(p)).map((k) => k.slice(bucket.length + 1)).sort();
  }
}

export class MemoryUploadSigner implements UploadSigner {
  constructor(private readonly baseUrl: string) {}
  async presignPost(bucket: string, key: string, maxBytes: number): Promise<PresignedUpload> {
    await Promise.resolve();
    return { url: `${this.baseUrl}/_local/upload`, fields: { bucket, key, maxBytes: String(maxBytes) } };
  }
}

export interface QueueRecord {
  messageId: string;
  body: unknown;
  groupId?: string;
  receiveCount: number;
}

export type QueueHandler = (records: QueueRecord[]) => Promise<{ failedIds?: string[] }>;

interface Subscription {
  handler: QueueHandler;
  batchSize: number;
  concurrency: number;
  visibilityMs: number;
  maxReceive: number;
  fifo: boolean;
}

interface QueueState {
  ready: QueueRecord[];
  inflight: number;
  activeGroups: Set<string>;
  dlq: QueueRecord[];
  sent: number;
}

/**
 * In-process SQS stand-in with batch size, consumer concurrency, FIFO group ordering,
 * partial-batch failures, visibility-timeout redelivery and a DLQ after maxReceive.
 */
export class MemoryQueueBroker implements QueueSender {
  private queues = new Map<string, QueueState>();
  private subs = new Map<string, Subscription>();
  private seq = 0;
  private paused = new Set<string>();
  private idleWaiters: (() => void)[] = [];
  private running = 0;

  constructor(private readonly clock: Clock = systemClock) {}

  private state(queue: string): QueueState {
    let s = this.queues.get(queue);
    if (!s) {
      s = { ready: [], inflight: 0, activeGroups: new Set(), dlq: [], sent: 0 };
      this.queues.set(queue, s);
    }
    return s;
  }

  subscribe(queue: string, handler: QueueHandler, opts: Partial<Omit<Subscription, 'handler'>> = {}): void {
    this.subs.set(queue, {
      handler,
      batchSize: opts.batchSize ?? 1,
      concurrency: opts.concurrency ?? 1,
      visibilityMs: opts.visibilityMs ?? 30_000,
      maxReceive: opts.maxReceive ?? 3,
      fifo: opts.fifo ?? queue.endsWith('.fifo'),
    });
    this.pump(queue);
  }

  /** Stop delivering (simulates concurrency 0); messages stay queued. */
  pause(queue: string): void {
    this.paused.add(queue);
  }

  resume(queue: string): void {
    this.paused.delete(queue);
    this.pump(queue);
  }

  async send(queue: string, message: OutgoingMessage): Promise<void> {
    await Promise.resolve();
    const s = this.state(queue);
    s.sent++;
    const record: QueueRecord = { messageId: `m${++this.seq}`, body: structuredClone(message.body), groupId: message.groupId, receiveCount: 0 };
    if (message.delaySeconds && message.delaySeconds > 0) {
      this.track(this.clock.sleep(message.delaySeconds * 1000).then(() => this.enqueue(queue, record)));
    } else {
      this.enqueue(queue, record);
    }
  }

  private enqueue(queue: string, record: QueueRecord): void {
    this.state(queue).ready.push(record);
    this.pump(queue);
  }

  depth(queue: string): number {
    const s = this.state(queue);
    return s.ready.length + s.inflight;
  }

  dlq(queue: string): QueueRecord[] {
    return this.state(queue).dlq;
  }

  sentCount(queue: string): number {
    return this.state(queue).sent;
  }

  /** Messages waiting in a queue without a subscriber (test inspection). */
  peek(queue: string): QueueRecord[] {
    return [...this.state(queue).ready];
  }

  /** Remove and return waiting messages (for queues the test drives by hand). */
  take(queue: string): QueueRecord[] {
    const s = this.state(queue);
    const out = s.ready;
    s.ready = [];
    return out;
  }

  private track(p: Promise<unknown>): void {
    this.running++;
    void p.finally(() => {
      this.running--;
      if (this.running === 0) for (const w of this.idleWaiters.splice(0)) w();
    });
  }

  /** Resolves when no handler or delayed delivery is in flight. */
  whenIdle(): Promise<void> {
    if (this.running === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private pump(queue: string): void {
    const sub = this.subs.get(queue);
    if (!sub || this.paused.has(queue)) return;
    const s = this.state(queue);
    while (s.inflight < sub.concurrency && s.ready.length > 0) {
      const batch = this.takeBatch(s, sub);
      if (batch.length === 0) return;
      s.inflight++;
      this.track(this.deliver(queue, sub, s, batch));
    }
  }

  private takeBatch(s: QueueState, sub: Subscription): QueueRecord[] {
    if (!sub.fifo) return s.ready.splice(0, sub.batchSize);
    const idx = s.ready.findIndex((r) => !s.activeGroups.has(r.groupId ?? ''));
    if (idx < 0) return [];
    const group = s.ready[idx]?.groupId ?? '';
    const batch: QueueRecord[] = [];
    for (let i = idx; i < s.ready.length && batch.length < sub.batchSize; ) {
      const r = s.ready[i];
      if (r && (r.groupId ?? '') === group) {
        batch.push(r);
        s.ready.splice(i, 1);
      } else i++;
    }
    s.activeGroups.add(group);
    return batch;
  }

  private async deliver(queue: string, sub: Subscription, s: QueueState, batch: QueueRecord[]): Promise<void> {
    for (const r of batch) r.receiveCount++;
    let failed: QueueRecord[] = [];
    try {
      const result = await sub.handler(batch.map((r) => ({ ...r, body: structuredClone(r.body) })));
      const ids = new Set(result?.failedIds ?? []);
      failed = batch.filter((r) => ids.has(r.messageId));
    } catch {
      failed = batch;
    }
    if (sub.fifo) s.activeGroups.delete(batch[0]?.groupId ?? '');
    s.inflight--;
    for (const r of failed) {
      if (r.receiveCount >= sub.maxReceive) s.dlq.push(r);
      else this.track(this.clock.sleep(sub.visibilityMs).then(() => this.enqueue(queue, r)));
    }
    this.pump(queue);
  }
}

export class MemoryWorkflowStarter implements WorkflowStarter {
  readonly executions = new Map<string, unknown>();
  constructor(private readonly runners: Record<string, (input: unknown) => Promise<void>> = {}, private readonly onError?: (e: unknown) => void) {}

  register(stateMachine: string, runner: (input: unknown) => Promise<void>): void {
    this.runners[stateMachine] = runner;
  }

  async start(stateMachine: string, executionName: string, input: unknown): Promise<boolean> {
    await Promise.resolve();
    const id = `${stateMachine}:${executionName}`;
    if (this.executions.has(id)) return false;
    this.executions.set(id, input);
    const runner = this.runners[stateMachine];
    if (runner) void runner(input).catch((e: unknown) => this.onError?.(e));
    return true;
  }
}

export class MemorySecrets implements SecretStore, ParamStore {
  constructor(private readonly values: Record<string, string>) {}
  async getSecret(id: string): Promise<string> {
    await Promise.resolve();
    const v = this.values[id];
    if (v === undefined) throw new Error(`unknown secret ${id}`);
    return v;
  }
  getParam(name: string): Promise<string> {
    return this.getSecret(name);
  }
}

export class MemoryMetrics implements MetricsSink {
  readonly points: { name: string; value: number; dimensions?: Record<string, string> }[] = [];
  async put(name: string, value: number, dimensions?: Record<string, string>): Promise<void> {
    await Promise.resolve();
    this.points.push({ name, value, dimensions });
  }
}
