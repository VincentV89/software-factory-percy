import { cond, isConditionFailure, newId, queryAll, type Item } from '@percy/shared';
import type { AudienceFrozen, SnapshotRecipient } from '@percy/contactsg-contract';
import { parseRequestRef, sendlogKeys, zeroCounters, type BatchRecipient, type SendBatch } from '../domain/send';
import { activeGates, eventOp, getStatus, loadSpec, type EngineDpDeps } from './deps';

export interface SagaStart {
  campaignId: string;
  mode: 'send' | 'cancel' | 'done';
  parts: { index: number; key: string }[];
}

/**
 * Send saga steps (FR-DLV-01, design 7.4). In AWS a Standard state machine runs
 * InitStatus → Map(parts, concurrency 10) → MarkCreated; locally `runSaga` runs them in order.
 */
export class SendSaga {
  constructor(private readonly d: EngineDpDeps) {}

  async initStatus(frozen: AudienceFrozen): Promise<SagaStart> {
    const d = this.d;
    const { campaignId } = parseRequestRef(frozen.requestRef);
    const spec = await loadSpec(d, campaignId);
    if (!spec) throw new Error(`send spec for ${campaignId} is missing`);
    const manifest = await d.snapshots.manifest(frozen.manifestKey);
    if (!manifest) throw new Error(`snapshot manifest ${frozen.manifestKey} is missing`);
    const parts = manifest.parts.map((p, index) => ({ index, key: p.key }));
    const base = {
      campaignId,
      teamId: spec.teamId,
      agencyId: spec.agencyId,
      tier: spec.tier,
      rowsExpected: frozen.recipientCount,
      rowsCreated: 0,
      partCount: parts.length,
      manifestKey: frozen.manifestKey,
    };
    const gates = await activeGates(d, spec.agencyId, spec.teamId);
    const gated = gates.length > 0;
    try {
      await d.kv.transact([
        { kind: 'put', table: d.tables.sendlog, item: { ...sendlogKeys.status(campaignId), ...base, status: gated ? 'PAUSED' : 'SENDING', ...(gated ? { reason: 'KILL_SWITCH' } : {}) }, cond: cond.itemAbsent() },
        { kind: 'put', table: d.tables.sendlog, item: { ...sendlogKeys.counters(campaignId), ...zeroCounters() }, cond: cond.itemAbsent() },
        gated ? eventOp(d, 'SendPaused', { campaignId, teamId: spec.teamId, reason: 'KILL_SWITCH' }) : eventOp(d, 'SendStarted', { campaignId, teamId: spec.teamId }),
      ]);
      return { campaignId, mode: 'send', parts };
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
    }
    const status = await getStatus(d, campaignId);
    if (status?.['status'] === 'STOPPED' && status['rowsExpected'] === undefined) {
      // Stopped while freezing: record every recipient as cancelled and end.
      await d.kv.transact([
        { kind: 'update', table: d.tables.sendlog, key: sendlogKeys.status(campaignId), update: { set: { ...base } }, cond: cond.notExists('rowsExpected') },
        { kind: 'put', table: d.tables.sendlog, item: { ...sendlogKeys.counters(campaignId), ...zeroCounters() }, cond: cond.itemAbsent() },
        eventOp(d, 'SendStopped', { campaignId, teamId: spec.teamId }),
      ]).catch((err: unknown) => {
        if (!isConditionFailure(err)) throw err;
      });
      return { campaignId, mode: 'cancel', parts };
    }
    if (status?.['status'] === 'STOPPED') return { campaignId, mode: 'cancel', parts };
    if (status?.['status'] === 'COMPLETED') return { campaignId, mode: 'done', parts: [] };
    return { campaignId, mode: 'send', parts };
  }

  /**
   * Creates rows with conditional PutItem (never BatchWrite) so a retried part cannot reset a
   * claimed row, then enqueues batches of up to 50 with inline recipient data.
   */
  async createPart(campaignId: string, part: { index: number; key: string }, mode: 'send' | 'cancel'): Promise<number> {
    const d = this.d;
    const recipients = await d.snapshots.part(part.key);
    if (!recipients) throw new Error(`snapshot part ${part.key} is missing`);
    const status = await getStatus(d, campaignId);
    const tier = (status?.['tier'] as SendBatch['tier']) ?? 'standard';
    const toEnqueue: BatchRecipient[] = [];
    const pk = sendlogKeys.partPk(campaignId, part.index);
    for (const [idx, r] of recipients.entries()) {
      const sk = sendlogKeys.rowSk(idx);
      try {
        await d.kv.put(d.tables.sendlog, { pk, sk, campaignId, addrHash: r.addrHash, status: mode === 'cancel' ? 'CANCELLED' : 'PENDING' }, cond.itemAbsent());
        if (mode === 'send') toEnqueue.push({ pk, sk, addrHash: r.addrHash, email: r.email, attrs: r.attrs });
      } catch (e) {
        if (!isConditionFailure(e)) throw e;
        // Retry after a crash between create and enqueue: re-enqueue rows still PENDING.
        const existing = await d.kv.get(d.tables.sendlog, { pk, sk }, { consistent: true });
        if (mode === 'send' && existing?.['status'] === 'PENDING') toEnqueue.push({ pk, sk, addrHash: r.addrHash, email: r.email, attrs: r.attrs });
        if (mode === 'cancel' && existing?.['status'] === 'PENDING') await this.cancelRow(pk, sk);
      }
    }
    if (status) await this.enqueue(campaignId, String(status['agencyId']), String(status['teamId']), tier, toEnqueue);
    return recipients.length;
  }

  async enqueue(campaignId: string, agencyId: string, teamId: string, tier: SendBatch['tier'], recipients: BatchRecipient[]): Promise<number> {
    const d = this.d;
    let batches = 0;
    for (let i = 0; i < recipients.length; i += d.config.batchSize) {
      const batch: SendBatch = { campaignId, batchId: newId(d.clock.now()), tier, agencyId, teamId, recipients: recipients.slice(i, i + d.config.batchSize), attempt: 0 };
      await d.queue.send(d.batchQueues[tier], { body: batch });
      batches++;
    }
    return batches;
  }

  async markCreated(campaignId: string): Promise<void> {
    const status = await getStatus(this.d, campaignId);
    if (!status) return;
    await this.d.kv.update(this.d.tables.sendlog, sendlogKeys.status(campaignId), { set: { rowsCreated: status['rowsExpected'] } });
  }

  async runSaga(frozen: AudienceFrozen): Promise<void> {
    const start = await this.initStatus(frozen);
    if (start.mode === 'done') return;
    for (const p of start.parts) await this.createPart(start.campaignId, p, start.mode);
    await this.markCreated(start.campaignId);
  }

  private async rowsOfPart(campaignId: string, index: number): Promise<Item[]> {
    return queryAll(this.d.kv, this.d.tables.sendlog, { pk: sendlogKeys.partPk(campaignId, index), consistent: true });
  }

  private async cancelRow(pk: string, sk: string): Promise<void> {
    await this.d.kv.update(this.d.tables.sendlog, { pk, sk }, { set: { status: 'CANCELLED' } }, { cond: cond.eq('status', 'PENDING') }).catch((e: unknown) => {
      if (!isConditionFailure(e)) throw e;
    });
  }

  /** Resume: re-enqueue rows still PENDING, reading recipient data from the snapshot (FR-CTL-02). */
  async redrive(campaignId: string): Promise<number> {
    const d = this.d;
    const status = await getStatus(d, campaignId);
    if (!status || status['status'] !== 'SENDING') return 0;
    const manifest = await d.snapshots.manifest(String(status['manifestKey']));
    if (!manifest) {
      d.logger.warn('redrive: snapshot expired', { campaignId });
      return 0;
    }
    let total = 0;
    for (const [index, p] of manifest.parts.entries()) {
      const pending = new Set((await this.rowsOfPart(campaignId, index)).filter((r) => r['status'] === 'PENDING').map((r) => String(r['sk'])));
      if (pending.size === 0) continue;
      const recipients: SnapshotRecipient[] = (await d.snapshots.part(p.key)) ?? [];
      const batch: BatchRecipient[] = [];
      recipients.forEach((r, idx) => {
        const sk = sendlogKeys.rowSk(idx);
        if (pending.has(sk)) batch.push({ pk: sendlogKeys.partPk(campaignId, index), sk, addrHash: r.addrHash, email: r.email, attrs: r.attrs });
      });
      total += batch.length;
      await this.enqueue(campaignId, String(status['agencyId']), String(status['teamId']), status['tier'] as SendBatch['tier'], batch);
    }
    return total;
  }

  /** Stop: PENDING rows become CANCELLED (FR-CTL-03). */
  async cancel(campaignId: string): Promise<number> {
    const status = await getStatus(this.d, campaignId);
    const parts = Number(status?.['partCount'] ?? 0);
    let n = 0;
    for (let index = 0; index < parts; index++) {
      for (const r of await this.rowsOfPart(campaignId, index)) {
        if (r['status'] !== 'PENDING') continue;
        await this.cancelRow(String(r['pk']), String(r['sk']));
        n++;
      }
    }
    return n;
  }
}
