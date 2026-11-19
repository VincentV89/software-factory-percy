import { cond, isConditionFailure, makeEvent, outboxPut, queryAll } from '@percy/shared';
import { CONTACTSG_SOURCE, suppressionKeys, type SuppressionRequest } from '@percy/contactsg-contract';
import type { ContactSgDeps } from './deps';

/**
 * The only writer of contactsg-suppressions (FR-SUP-01). Idempotent: the suppression is put if
 * absent, and the membership fan-out uses conditional writes so retries never double-decrement.
 */
export class SuppressionService {
  constructor(private readonly d: Pick<ContactSgDeps, 'kv' | 'tables' | 'clock' | 'logger'>) {}

  async suppress(req: SuppressionRequest): Promise<{ added: boolean; flagged: number }> {
    const { kv, tables } = this.d;
    const now = this.d.clock.now();
    const sk = req.scope === 'GLOBAL' ? suppressionKeys.globalSk : suppressionKeys.agencySk(req.agencyId ?? '');
    let added = true;
    try {
      await kv.transact([
        {
          kind: 'put',
          table: tables.suppressions,
          item: { pk: suppressionKeys.pk(req.addrHash), sk, reason: req.reason, sourceCampaignId: req.sourceCampaignId, at: new Date(now).toISOString() },
          cond: cond.itemAbsent(),
        },
        outboxPut(tables.outbox, makeEvent(CONTACTSG_SOURCE, 'SuppressionAdded', { addrHash: req.addrHash, scope: sk, reason: req.reason }, now), Math.floor(now / 1000)),
      ]);
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
      added = false;
    }
    const flagged = await this.fanOut(req);
    this.d.logger.info('suppression applied', { addrHash: req.addrHash, scope: sk, reason: req.reason, added, flagged });
    return { added, flagged };
  }

  /** Flag affected memberships and decrement their list's eligibleCount once (ADR-07). */
  private async fanOut(req: SuppressionRequest): Promise<number> {
    const { kv, tables } = this.d;
    const memberships = await queryAll(kv, tables.contacts, { index: 'gsi1', pk: `ADDR#${req.addrHash}` });
    let flagged = 0;
    for (const m of memberships) {
      if (m['suppressed'] === true) continue;
      if (req.scope === 'AGENCY' && m['agencyId'] !== req.agencyId) continue;
      try {
        await kv.transact([
          { kind: 'update', table: tables.contacts, key: { pk: String(m['pk']), sk: String(m['sk']) }, update: { set: { suppressed: true } }, cond: cond.eq('suppressed', false) },
          { kind: 'update', table: tables.contacts, key: { pk: `TEAM#${String(m['teamId'])}`, sk: `LIST#${String(m['listId'])}` }, update: { add: { eligibleCount: -1 } } },
        ]);
        flagged++;
      } catch (e) {
        if (!isConditionFailure(e)) throw e;
      }
    }
    return flagged;
  }
}
