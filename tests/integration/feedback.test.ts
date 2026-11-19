import { describe, expect, it } from 'vitest';
import { VirtualClock, hashOf } from '@percy/shared';
import { QUEUES, createSystem } from '@percy/local';
import { launch, report } from './helpers';

describe('SES feedback (FR-FBK-01..05, NFR-SAFE-03)', () => {
  it('replaying every event type twice gives the same state and one suppression each', async () => {
    const clock = new VirtualClock();
    const sys = createSystem({ clock, feedbackDelayMs: 1000 });
    const emails = ['success+d@simulator.amazonses.com', 'bounce+h@simulator.amazonses.com', 'complaint+c@simulator.amazonses.com', 'success+soft@simulator.amazonses.com'];
    const l = await launch(sys, emails);
    await sys.runFor(60_000);
    const first = await report(l.a, l.teamId, l.campaignId);
    expect(first.counters).toMatchObject({ sent: 4, delivered: 3, bouncedHard: 1, complained: 1 });
    const id = (to: string) => sys.ses.callsFor(to)[0]?.messageId ?? '';
    const events = [
      { eventType: 'Delivery', mail: { messageId: id(emails[0] ?? '') } },
      { eventType: 'Bounce', mail: { messageId: id(emails[1] ?? '') }, bounce: { bounceType: 'Permanent' } },
      { eventType: 'Complaint', mail: { messageId: id(emails[2] ?? '') } },
      { eventType: 'Bounce', mail: { messageId: id(emails[3] ?? '') }, bounce: { bounceType: 'Transient' } },
    ];
    for (let round = 0; round < 2; round++) for (const e of events) await sys.broker.send(QUEUES.sesEvents, { body: e });
    await sys.runFor(30_000);
    const after = await report(l.a, l.teamId, l.campaignId);
    expect(after.counters).toMatchObject({ ...first.counters, bouncedSoft: 1 });
    const supp = sys.kv.scan('contactsg-suppressions');
    expect(supp.map((s) => [s['pk'], s['sk'], s['reason']]).sort()).toEqual(
      [
        [`ADDR#${hashOf(emails[1] ?? '')}`, 'GLOBAL', 'HARD_BOUNCE'],
        [`ADDR#${hashOf(emails[2] ?? '')}`, 'GLOBAL', 'COMPLAINT'],
      ].sort(),
    );
    expect(sys.broker.dlq(QUEUES.sesEvents)).toHaveLength(0);
  });

  it('unmatched events are logged and dropped without reaching the DLQ (FR-FBK-05); reject marks FAILED', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    const l = await launch(sys, ['success+r@simulator.amazonses.com']);
    await sys.runFor(30_000);
    await sys.broker.send(QUEUES.sesEvents, { body: { eventType: 'Bounce', mail: { messageId: 'nope' }, bounce: { bounceType: 'Permanent' } } });
    await sys.broker.send(QUEUES.sesEvents, { body: { eventType: 'Reject', mail: { messageId: sys.ses.calls[0]?.messageId } } });
    await sys.runFor(30_000);
    expect(sys.broker.dlq(QUEUES.sesEvents)).toHaveLength(0);
    expect(sys.errors).toEqual([]);
    expect((await report(l.a, l.teamId, l.campaignId)).counters).toMatchObject({ sent: 0, failed: 1 });
  });

  it('a later campaign skips addresses suppressed by feedback (FR-FBK-02)', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    const l = await launch(sys, ['bounce+z@simulator.amazonses.com', 'success+k@simulator.amazonses.com']);
    await sys.runFor(60_000);
    const c2 = await l.a.ok<{ campaignId: string; audienceCount: number }>('POST', `/api/engine/teams/${l.teamId}/campaigns`, { name: 'c2', templateId: l.templateId, listId: l.listId, senderName: 's' });
    expect(c2.audienceCount).toBe(1);
  });

  it('a burst of synthetic bounces drains with an empty DLQ (NFR-SAFE-03, duration recorded not gated)', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    await launch(sys, ['success+one@simulator.amazonses.com']);
    await sys.runFor(10_000);
    const started = Date.now();
    for (let i = 0; i < 2000; i++) await sys.broker.send(QUEUES.sesEvents, { body: { eventType: 'Bounce', mail: { messageId: `synthetic-${i}` }, bounce: { bounceType: 'Permanent' } } });
    await sys.runFor(60_000);
    expect(sys.broker.dlq(QUEUES.sesEvents)).toHaveLength(0);
    expect(sys.broker.depth(QUEUES.sesEvents)).toBe(0);
    expect(Date.now() - started).toBeLessThan(60_000);
  });
});
