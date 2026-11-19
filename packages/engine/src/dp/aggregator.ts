import { TransactionCanceledError, cond, queryAll, type Item, type TxOp } from '@percy/shared';
import { contribution, counterDelta, sendlogKeys, zeroCounters, type Counters } from '../domain/send';
import { eventOp, getStatus, type EngineDpDeps } from './deps';

export interface SendlogChange {
  /** Stream sequence number, compared as a zero-padded string. */
  seq: string;
  keys: { pk: string; sk: string };
  oldImage?: Item;
  newImage?: Item;
}

const pad = (seq: string): string => seq.padStart(40, '0');
const ckptKey = (partitionPk: string) => ({ pk: `CKPT#${partitionPk}`, sk: 'CKPT' });
const isRow = (sk: string): boolean => sk.startsWith('R#');
const MAX_RECORDS_PER_TX = 40;

/**
 * engine-aggregator (ADR-09). Counter deltas from the send-log stream are applied in one
 * TransactWriteItems together with a per-partition checkpoint, so a replayed batch is skipped and
 * counters move exactly once. Completion triggers one recount from the rows.
 */
export function createAggregator(d: EngineDpDeps) {
  async function applySlice(records: SendlogChange[]): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const partitions = [...new Set(records.map((r) => r.keys.pk))];
      const ckpts = await d.kv.batchGet(d.tables.sendlog, partitions.map(ckptKey));
      const seen = new Map(ckpts.map((c) => [String(c['pk']).slice('CKPT#'.length), String(c['lastSeq'])]));
      const fresh = records.filter((r) => {
        const last = seen.get(r.keys.pk);
        return last === undefined || pad(r.seq) > last;
      });
      if (fresh.length === 0) return;
      const deltas = new Map<string, Partial<Counters>>();
      const maxSeq = new Map<string, string>();
      for (const r of fresh) {
        const campaignId = String(r.newImage?.['campaignId'] ?? r.oldImage?.['campaignId'] ?? '');
        if (!campaignId) continue;
        const acc = deltas.get(campaignId) ?? {};
        for (const [k, v] of Object.entries(counterDelta(r.oldImage, r.newImage))) acc[k as keyof Counters] = (acc[k as keyof Counters] ?? 0) + (v ?? 0);
        deltas.set(campaignId, acc);
        const prev = maxSeq.get(r.keys.pk);
        if (!prev || pad(r.seq) > prev) maxSeq.set(r.keys.pk, pad(r.seq));
      }
      const ops: TxOp[] = [];
      for (const [campaignId, delta] of deltas) {
        const add = Object.fromEntries(Object.entries(delta).filter(([, v]) => v !== 0)) as Record<string, number>;
        if (Object.keys(add).length) ops.push({ kind: 'update', table: d.tables.sendlog, key: sendlogKeys.counters(campaignId), update: { add } });
      }
      for (const [pk, seq] of maxSeq) {
        const observed = seen.get(pk);
        ops.push({ kind: 'update', table: d.tables.sendlog, key: ckptKey(pk), update: { set: { lastSeq: seq } }, cond: observed === undefined ? cond.notExists('lastSeq') : cond.eq('lastSeq', observed) });
      }
      try {
        await d.kv.transact(ops);
        return;
      } catch (e) {
        if (!(e instanceof TransactionCanceledError)) throw e;
        // A concurrent or replayed apply moved a checkpoint: re-read and retry with what is left.
      }
    }
    throw new Error('aggregator could not apply counter deltas');
  }

  async function recount(campaignId: string, partCount: number): Promise<Counters> {
    const totals = zeroCounters();
    for (let p = 0; p < partCount; p++) {
      for (const row of await queryAll(d.kv, d.tables.sendlog, { pk: sendlogKeys.partPk(campaignId, p), consistent: true })) {
        for (const [k, v] of Object.entries(contribution(row))) totals[k as keyof Counters] += v ?? 0;
      }
    }
    return totals;
  }

  /** Completion: all rows created, none PENDING or SENDING (IN_DOUBT counts as final). */
  async function maybeComplete(campaignId: string): Promise<boolean> {
    const status = await getStatus(d, campaignId);
    if (!status || status['status'] !== 'SENDING') return false;
    if (status['rowsCreated'] === undefined || Number(status['rowsCreated']) !== Number(status['rowsExpected'])) return false;
    const counters = await d.kv.get(d.tables.sendlog, sendlogKeys.counters(campaignId), { consistent: true });
    if (Number(counters?.['pending'] ?? 0) > 0 || Number(counters?.['sending'] ?? 0) > 0) return false;
    const final = await recount(campaignId, Number(status['partCount'] ?? 0));
    if (final.pending > 0 || final.sending > 0) {
      await d.kv.put(d.tables.sendlog, { ...sendlogKeys.counters(campaignId), ...final });
      return false;
    }
    try {
      await d.kv.transact([
        { kind: 'put', table: d.tables.sendlog, item: { ...sendlogKeys.counters(campaignId), ...final } },
        { kind: 'update', table: d.tables.sendlog, key: sendlogKeys.status(campaignId), update: { set: { status: 'COMPLETED', completedAt: d.clock.now() } }, cond: cond.eq('status', 'SENDING') },
        eventOp(d, 'SendCompleted', { campaignId, teamId: String(status['teamId']) }),
      ]);
      d.logger.info('campaign completed', { campaignId, sent: final.sent, failed: final.failed, inDoubt: final.inDoubt });
      return true;
    } catch (e) {
      if (e instanceof TransactionCanceledError) return false;
      throw e;
    }
  }

  return {
    async handle(changes: SendlogChange[]): Promise<void> {
      const rows = changes.filter((c) => isRow(c.keys.sk));
      for (let i = 0; i < rows.length; i += MAX_RECORDS_PER_TX) await applySlice(rows.slice(i, i + MAX_RECORDS_PER_TX));
      const touched = new Set<string>();
      for (const c of changes) {
        if (isRow(c.keys.sk)) touched.add(String(c.newImage?.['campaignId'] ?? c.oldImage?.['campaignId'] ?? ''));
        else if (c.keys.sk === 'STATUS') touched.add(c.keys.pk.slice('CMP#'.length));
      }
      touched.delete('');
      for (const campaignId of touched) await maybeComplete(campaignId);
    },
    maybeComplete,
    recount,
  };
}

