import { cond, isConditionFailure, type Clock, type KvStore } from '@percy/shared';

/**
 * Distributed per-tier rate limit (ADR-06): a DynamoDB per-second window counter
 * `RATE#<tier>#<epochSec>`, incremented only while count < rate. Exact across any concurrency.
 */
export class RateLimiter {
  constructor(private readonly kv: KvStore, private readonly table: string, private readonly clock: Clock, private readonly rateOf: (tier: string) => number) {}

  /** Waits for a send slot; returns the milliseconds spent waiting. */
  async acquire(tier: string): Promise<number> {
    const started = this.clock.now();
    const rate = Math.max(1, Math.floor(this.rateOf(tier)));
    for (;;) {
      const now = this.clock.now();
      const sec = Math.floor(now / 1000);
      try {
        await this.kv.update(
          this.table,
          { pk: `RATE#${tier}#${sec}`, sk: 'RATE' },
          { add: { count: 1 }, set: { expiresAt: sec + 120 } },
          { cond: cond.or(cond.notExists('count'), cond.lt('count', rate)) },
        );
        return this.clock.now() - started;
      } catch (e) {
        if (!isConditionFailure(e)) throw e;
        await this.clock.sleep((sec + 1) * 1000 - now + Math.floor(Math.random() * 5));
      }
    }
  }
}
