import { describe, expect, it } from 'vitest';
import { InMemoryKvStore, VirtualClock, createLogger } from '@percy/shared';
import { MemoryMetrics, MemoryObjectStore, MemoryQueueBroker, MemoryWorkflowStarter } from '@percy/shared/memory';
import { DEFAULT_DP_CONFIG, createAggregator, sendlogKeys, type EngineDpDeps, type SendlogChange } from '@percy/engine';

function deps(): EngineDpDeps & { kv: InMemoryKvStore } {
  const clock = new VirtualClock();
  const kv = new InMemoryKvStore();
  return {
    kv,
    tables: { sendlog: 'sendlog', sendgate: 'gate', outbox: 'outbox' },
    store: new MemoryObjectStore(),
    artifactsBucket: 'a',
    snapshots: { manifest: async () => undefined, part: async () => undefined },
    suppressions: { isSuppressed: async () => false },
    queue: new MemoryQueueBroker(clock),
    batchQueues: { standard: 's', bulk: 'b' },
    workflows: new MemoryWorkflowStarter(),
    stateMachines: { saga: 's', redrive: 'r', cancel: 'c' },
    sender: { send: async () => ({ kind: 'accepted', messageId: 'm' }) },
    unsubscribeKeys: async () => ({ current: 'k', keys: { k: 'x' } }),
    publicBaseUrl: async () => 'https://x',
    metrics: new MemoryMetrics(),
    clock,
    logger: createLogger('t'),
    config: DEFAULT_DP_CONFIG,
  };
}

const row = (part: number, idx: number, status: string, extra: Record<string, unknown> = {}) => ({ pk: sendlogKeys.partPk('c1', part), sk: sendlogKeys.rowSk(idx), campaignId: 'c1', status, ...extra });
const change = (seq: number, oldImage: ReturnType<typeof row> | undefined, newImage: ReturnType<typeof row>): SendlogChange => ({ seq: String(seq), keys: { pk: newImage.pk, sk: newImage.sk }, oldImage, newImage });

describe('engine-aggregator exactly-once counters (ADR-09)', () => {
  it('a replayed or overlapping stream batch is counted once', async () => {
    const d = deps();
    const agg = createAggregator(d);
    const batch1 = [change(1, undefined, row(0, 0, 'PENDING')), change(2, undefined, row(0, 1, 'PENDING')), change(3, undefined, row(1, 0, 'PENDING'))];
    const batch2 = [change(4, row(0, 0, 'PENDING'), row(0, 0, 'SENDING')), change(5, row(0, 0, 'SENDING'), row(0, 0, 'SENT')), change(6, row(0, 0, 'SENT'), row(0, 0, 'SENT', { delivered: true }))];
    await agg.handle(batch1);
    await agg.handle(batch1); // Lambda retry of the same batch
    await agg.handle([...batch1.slice(2), ...batch2]); // bisected/overlapping redelivery
    await agg.handle(batch2);
    const counters = await d.kv.get('sendlog', sendlogKeys.counters('c1'));
    expect(counters).toMatchObject({ pending: 2, sent: 1, delivered: 1 });
    expect(counters?.['sending'] ?? 0).toBe(0);
  });

  it('completes once all rows are final and recounts from the rows', async () => {
    const d = deps();
    const agg = createAggregator(d);
    await d.kv.put('sendlog', { ...sendlogKeys.status('c1'), status: 'SENDING', teamId: 't', rowsExpected: 2, rowsCreated: 2, partCount: 1 });
    for (const r of [row(0, 0, 'SENT'), row(0, 1, 'IN_DOUBT')]) await d.kv.put('sendlog', r);
    await agg.handle([change(1, undefined, row(0, 0, 'SENT')), change(2, undefined, row(0, 1, 'IN_DOUBT'))]);
    expect((await d.kv.get('sendlog', sendlogKeys.status('c1')))?.['status']).toBe('COMPLETED');
    expect(d.kv.scan('outbox').map((o) => (o['event'] as { type: string }).type)).toEqual(['SendCompleted']);
    await agg.handle([change(3, undefined, row(0, 0, 'SENT'))]);
    expect(d.kv.scan('outbox')).toHaveLength(1);
  });
});
