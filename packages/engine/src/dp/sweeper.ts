import { cond, isConditionFailure, queryAll } from '@percy/shared';
import type { EngineDpDeps } from './deps';

/**
 * In-doubt sweeper (FR-DLV-06): rows SENDING for longer than inDoubtMs become IN_DOUBT. They are
 * never re-sent automatically (FR-DLV-07). A late SES success may still move IN_DOUBT → SENT.
 */
export async function sweepInDoubt(d: EngineDpDeps): Promise<number> {
  const cutoff = d.clock.now() - d.config.inDoubtMs;
  let marked = 0;
  for (let shard = 0; shard < 16; shard++) {
    const stale = await queryAll(d.kv, d.tables.sendlog, { index: 'gsi2', pk: `INFLIGHT#${shard}`, sk: { lt: cutoff } });
    for (const row of stale) {
      try {
        await d.kv.update(
          d.tables.sendlog,
          { pk: String(row['pk']), sk: String(row['sk']) },
          { set: { status: 'IN_DOUBT' }, remove: ['gsi2pk', 'gsi2sk'] },
          { cond: cond.and(cond.eq('status', 'SENDING'), cond.eq('claimToken', row['claimToken'])) },
        );
        marked++;
      } catch (e) {
        if (!isConditionFailure(e)) throw e;
      }
    }
  }
  if (marked > 0) d.logger.warn('recipients marked in doubt', { count: marked });
  return marked;
}
