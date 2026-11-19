import { queryAll, type KvStore } from '@percy/shared';
import { COUNTER_NAMES, sendlogKeys, zeroCounters, type Counters } from '../domain/send';

/**
 * Read-only view of engine-sendlog for the control plane (report, dev export). The control plane
 * never writes this table (NFR-ARC-02); this module holds no write path.
 */
export interface CampaignReport {
  status?: string;
  reason?: string;
  audience: number;
  counters: Counters;
}

export class SendlogReader {
  constructor(private readonly kv: KvStore, private readonly table: string) {}

  async report(campaignId: string): Promise<CampaignReport> {
    const [status, counters] = await this.kv.batchGet(this.table, [sendlogKeys.status(campaignId), sendlogKeys.counters(campaignId)]).then((items) => [
      items.find((i) => i['sk'] === 'STATUS'),
      items.find((i) => i['sk'] === 'COUNTERS'),
    ]);
    const c = zeroCounters();
    for (const n of COUNTER_NAMES) c[n] = Math.max(0, Number(counters?.[n] ?? 0));
    return { status: status?.['status'] as string | undefined, reason: status?.['reason'] as string | undefined, audience: Number(status?.['rowsExpected'] ?? 0), counters: c };
  }

  async teamOf(campaignId: string): Promise<string | undefined> {
    const s = await this.kv.get(this.table, sendlogKeys.status(campaignId));
    return s?.['teamId'] as string | undefined;
  }

  /** Dev-only rows with sesCalledAt and the dev unsubscribe URL (E2E-01 steps 12, 15, 18). */
  async devRows(campaignId: string): Promise<{ addrHash: string; status: string; sesCalledAt?: number; devUnsubUrl?: string }[]> {
    const s = await this.kv.get(this.table, sendlogKeys.status(campaignId));
    const parts = Number(s?.['partCount'] ?? 0);
    const out: { addrHash: string; status: string; sesCalledAt?: number; devUnsubUrl?: string }[] = [];
    for (let p = 0; p < parts; p++) {
      for (const r of await queryAll(this.kv, this.table, { pk: sendlogKeys.partPk(campaignId, p) })) {
        out.push({ addrHash: String(r['addrHash']), status: String(r['status']), sesCalledAt: r['sesCalledAt'] as number | undefined, devUnsubUrl: r['devUnsubUrl'] as string | undefined });
      }
    }
    return out;
  }
}
