import { describe, expect, it } from 'vitest';
import { VirtualClock, hashOf } from '@percy/shared';
import { QUEUES, createSystem } from '@percy/local';
import { SendWorker, sendBatchSchema } from '@percy/engine';
import { assertSafety, campaignState, launch, report, sim } from './helpers';

/**
 * Delivery simulation (design section 10): real data-plane handlers on in-memory adapters and a
 * deterministic virtual clock, with the production defaults (10 s status cache, batch size 50).
 */
const STOP_BUDGET_MS = 60_000;

describe('NFR-SAFE-01: stop within 60 s', () => {
  const lastCallAfter = (calls: { at: number }[], t: number): number => Math.max(...calls.map((c) => c.at)) - t;

  it.each(['pause', 'stop'] as const)('%s mid-send: last SES call ≤ 60 s after accept', async (action) => {
    const clock = new VirtualClock();
    const sys = createSystem({ clock, rates: { standard: 10, bulk: 10 } });
    const l = await launch(sys, sim(400));
    await sys.runFor(8_000);
    expect(sys.ses.calls.length).toBeGreaterThan(40);
    const t = clock.now();
    const res = await l.a.call('POST', `/api/engine/teams/${l.teamId}/campaigns/${l.campaignId}/actions/${action}`);
    expect(res.status).toBe(202);
    await sys.runFor(180_000);
    expect(lastCallAfter(sys.ses.calls, t)).toBeLessThanOrEqual(34_000);
    const c = await campaignState(l.a, l.teamId, l.campaignId);
    expect(c.state).toBe(action === 'pause' ? 'PAUSED' : 'STOPPED');
    const r = await report(l.a, l.teamId, l.campaignId);
    if (action === 'stop') {
      expect(r.counters['cancelled']).toBe(400 - (r.counters['sent'] ?? 0));
      expect((await l.a.call('POST', `/api/engine/teams/${l.teamId}/campaigns/${l.campaignId}/actions/resume`)).status).toBe(409);
    } else {
      expect(r.counters['pending']).toBe(400 - (r.counters['sent'] ?? 0));
      // FR-CTL-02: resume re-drives PENDING; every recipient ends in exactly one final state, none twice.
      expect((await l.a.call('POST', `/api/engine/teams/${l.teamId}/campaigns/${l.campaignId}/actions/resume`)).status).toBe(202);
      await sys.runFor(120_000);
      const done = await report(l.a, l.teamId, l.campaignId);
      expect(done.state).toBe('COMPLETED');
      expect(done.counters['sent']).toBe(400);
      expect(new Set(sys.ses.calls.map((x) => x.to)).size).toBe(400);
    }
    await assertSafety(sys);
    expect(sys.errors).toEqual([]);
  });

  it('global kill switch mid-send pauses within 60 s; schedule is refused while set', async () => {
    const clock = new VirtualClock();
    const sys = createSystem({ clock, rates: { standard: 10, bulk: 10 } });
    const l = await launch(sys, sim(300));
    await sys.runFor(5_000);
    const t = clock.now();
    expect((await l.admin.call('POST', '/api/engine/kill-switches', { scope: 'GLOBAL', reason: 'platform-wide drill' })).status).toBe(201);
    await sys.runFor(120_000);
    expect(lastCallAfter(sys.ses.calls, t)).toBeLessThanOrEqual(STOP_BUDGET_MS);
    expect((await campaignState(l.a, l.teamId, l.campaignId)).state).toBe('PAUSED');
    await assertSafety(sys);
  });

  it('team suspension sets the kill switch and pauses within 60 s (FR-TEN-05); reinstating does not resume', async () => {
    const clock = new VirtualClock();
    const sys = createSystem({ clock, rates: { standard: 10, bulk: 10 } });
    const l = await launch(sys, sim(300));
    await sys.runFor(5_000);
    const t = clock.now();
    expect((await l.admin.call('POST', `/api/platform/teams/${l.teamId}/suspend`, { reason: 'security review' })).status).toBe(200);
    await sys.runFor(120_000);
    expect(lastCallAfter(sys.ses.calls, t)).toBeLessThanOrEqual(STOP_BUDGET_MS);
    const kills = await l.admin.ok<{ items: { scope: string; reason: string }[] }>('GET', '/api/engine/kill-switches');
    expect(kills.items).toEqual([expect.objectContaining({ scope: `TEAM#${l.teamId}`, reason: 'suspended: security review' })]);
    // The suspended team's members lose access on their next request (FR-AUTH-04).
    expect((await l.a.call('GET', `/api/engine/teams/${l.teamId}/campaigns`)).status).toBe(403);
    expect((await l.admin.call('POST', `/api/platform/teams/${l.teamId}/reinstate`, { reason: 'review done' })).status).toBe(200);
    await sys.runFor(10_000);
    expect((await l.admin.ok<{ items: unknown[] }>('GET', '/api/engine/kill-switches')).items).toHaveLength(0);
    expect((await campaignState(l.a, l.teamId, l.campaignId)).state).toBe('PAUSED');
  });
});

describe('at-most-once delivery (FR-DLV-03..07, NFR-SAFE-02)', () => {
  it('FR-DLV-01: a 7-recipient campaign gets 7 PENDING rows and one batch', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    sys.broker.pause(QUEUES.batchesStandard);
    await launch(sys, sim(7));
    await sys.runFor(1000);
    const batches = sys.broker.peek(QUEUES.batchesStandard);
    expect(batches).toHaveLength(1);
    expect(sendBatchSchema.parse(batches[0]?.body).recipients).toHaveLength(7);
    expect(sys.kv.scan('engine-sendlog').filter((r) => String(r['sk']).startsWith('R#') && r['status'] === 'PENDING')).toHaveLength(7);
  });

  it('two workers given the same batch make exactly one SES call per recipient', async () => {
    const sys = createSystem({ clock: new VirtualClock(), rates: { standard: 50, bulk: 50 } });
    sys.broker.pause(QUEUES.batchesStandard);
    await launch(sys, sim(50));
    await sys.runFor(1000);
    const batch = sendBatchSchema.parse(sys.broker.take(QUEUES.batchesStandard)[0]?.body);
    const w1 = new SendWorker(sys.dp);
    const w2 = new SendWorker(sys.dp);
    const runs = Promise.all([w1.process(batch, sys.clock.now() + 900_000), w2.process(batch, sys.clock.now() + 900_000)]);
    await sys.runFor(30_000);
    await runs;
    expect(sys.ses.calls).toHaveLength(50);
    await assertSafety(sys);
  });

  it('a crash between claim and result, then redelivery: at most one SES call; later IN_DOUBT', async () => {
    const sys = createSystem({ clock: new VirtualClock(), rates: { standard: 10, bulk: 10 } });
    const victim = 'success+r0003@simulator.amazonses.com';
    const inner = sys.ses.behaviour;
    let victimCalls = 0;
    sys.ses.behaviour = (email, i) => {
      if (email.to === victim && ++victimCalls === 1) {
        // SES is called, then the worker process dies before writing the result.
        throw new Error('worker crashed after the SES call');
      }
      return inner(email, i);
    };
    const l = await launch(sys, sim(10));
    // Well past the 90-minute visibility timeout, so SQS redelivers the batch.
    await sys.runFor(2 * 3600_000);
    expect(victimCalls).toBe(1);
    await l.a.signIn();
    await sys.sweep();
    await sys.runFor(10_000);
    const r = await report(l.a, l.teamId, l.campaignId);
    expect(r.counters['inDoubt']).toBe(1);
    expect(r.counters['sent']).toBe(9);
    expect(r.state).toBe('COMPLETED');
    await assertSafety(sys);
  });

  it('a timeout leaves the recipient SENDING; it is never retried automatically (FR-DLV-07)', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    const victim = 'success+r0001@simulator.amazonses.com';
    const inner = sys.ses.behaviour;
    sys.ses.behaviour = (email, i) => (email.to === victim ? 'throw' : inner(email, i));
    const l = await launch(sys, sim(5));
    await sys.runFor(20 * 60_000);
    await sys.sweep();
    await sys.runFor(10_000);
    expect(sys.ses.callsFor(victim)).toHaveLength(1);
    await l.a.signIn();
    const r = await report(l.a, l.teamId, l.campaignId);
    expect(r.counters).toMatchObject({ sent: 4, inDoubt: 1, pending: 0, sending: 0 });
    expect(r.state).toBe('COMPLETED');
  });

  it('an address suppressed after the freeze but before its batch gets no SES call (FR-DLV-04)', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    sys.broker.pause(QUEUES.batchesStandard);
    const l = await launch(sys, sim(5));
    await sys.runFor(1000);
    const late = 'success+r0002@simulator.amazonses.com';
    await sys.suppressions.suppress({ addrHash: hashOf(late), scope: 'GLOBAL', reason: 'COMPLAINT' });
    sys.broker.resume(QUEUES.batchesStandard);
    await sys.runFor(30_000);
    expect(sys.ses.callsFor(late)).toHaveLength(0);
    const r = await report(l.a, l.teamId, l.campaignId);
    expect(r.counters).toMatchObject({ sent: 4, skipped: 1 });
  });

  it('always-throttling SES pauses the campaign with SES_THROTTLED within 6 minutes and fails nobody (FR-FBK-04)', async () => {
    const clock = new VirtualClock();
    const sys = createSystem({ clock });
    sys.ses.behaviour = () => ({ kind: 'throttled', code: 'TooManyRequestsException' });
    const l = await launch(sys, sim(20));
    const start = clock.now();
    let pausedAt: number | undefined;
    for (let i = 0; i < 80 && !pausedAt; i++) {
      await sys.runFor(5_000);
      if ((await report(l.a, l.teamId, l.campaignId)).status === 'PAUSED') pausedAt = clock.now();
    }
    expect(pausedAt).toBeDefined();
    expect((pausedAt ?? 0) - start).toBeLessThanOrEqual(6 * 60_000);
    const r = await report(l.a, l.teamId, l.campaignId);
    expect(r.reason).toBe('SES_THROTTLED');
    expect(r.counters['failed']).toBe(0);
    await sys.runFor(10_000);
    const c = await campaignState(l.a, l.teamId, l.campaignId);
    expect(c).toMatchObject({ state: 'PAUSED', pausedReason: 'SES_THROTTLED' });
    expect(sys.metrics.points.some((p) => p.name === 'CircuitBreakerPaused')).toBe(true);
  });
});

describe('FR-DLV-02: tier rate', () => {
  it('10/s for 60 s averages within ±10% and never exceeds 12/s in any 5 s window', async () => {
    const clock = new VirtualClock();
    const sys = createSystem({ clock, rates: { standard: 10, bulk: 10 }, workerConcurrency: 5 });
    await launch(sys, sim(800));
    await sys.runFor(70_000);
    const times = sys.ses.calls.map((c) => c.at).sort((x, y) => x - y);
    const first = times[0] ?? 0;
    const inMinute = times.filter((t) => t < first + 60_000).length;
    expect(inMinute / 60).toBeGreaterThanOrEqual(9);
    expect(inMinute / 60).toBeLessThanOrEqual(11);
    let maxWindow = 0;
    for (let i = 0, j = 0; i < times.length; i++) {
      while ((times[i] ?? 0) - (times[j] ?? 0) >= 5_000) j++;
      maxWindow = Math.max(maxWindow, i - j + 1);
    }
    expect(maxWindow).toBeLessThanOrEqual(60);
  });
});
