import { cond, isConditionFailure, newId } from '@percy/shared';
import type { BatchRecipient, SendBatch, SendSpec } from '../domain/send';
import type { UnsubscribeKeys } from '../domain/unsubscribe-token';
import { activeGates, eventOp, getStatus, loadSpec, type EngineDpDeps } from './deps';
import { RateLimiter } from './rate-limiter';
import { buildEmail, unsubscribeUrl } from './render-email';

const HARD_MAX_CACHE_MS = 30_000;
const CONTINUATION_MARGIN_MS = 60_000;
const INFLIGHT_SHARDS = 16;

export type BatchOutcome = 'done' | 'halted' | 'continued' | 'circuit-open';

interface CachedCheck {
  at: number;
  ok: boolean;
}

const shardOf = (addrHash: string): number => parseInt(addrHash.slice(0, 4), 16) % INFLIGHT_SHARDS;

/**
 * send-worker-<tier> (design 7.5, ADR-05). At most one SES call per recipient: a conditional
 * claim PENDING → SENDING precedes every call, throttles revert only on definite non-acceptance,
 * unknown outcomes stay SENDING (later IN_DOUBT), and any wait > 1 s forces a fresh status read.
 */
export class SendWorker {
  private readonly cache = new Map<string, CachedCheck>();
  private readonly limiter: RateLimiter;

  constructor(private readonly d: EngineDpDeps) {
    this.limiter = new RateLimiter(d.kv, d.tables.sendgate, d.clock, (tier) => d.config.rates[tier as 'standard' | 'bulk'] ?? 1);
  }

  /** Campaign SENDING and no gate covering it; cached ≤ statusCacheMs (never > 30 s). */
  async canSend(batch: Pick<SendBatch, 'campaignId' | 'agencyId' | 'teamId'>, fresh = false): Promise<boolean> {
    const now = this.d.clock.now();
    const ttl = Math.min(this.d.config.statusCacheMs, HARD_MAX_CACHE_MS);
    const hit = this.cache.get(batch.campaignId);
    if (!fresh && hit && now - hit.at < ttl) return hit.ok;
    const [status, gates] = await Promise.all([getStatus(this.d, batch.campaignId), activeGates(this.d, batch.agencyId, batch.teamId)]);
    const ok = status?.['status'] === 'SENDING' && gates.length === 0;
    this.cache.set(batch.campaignId, { at: this.d.clock.now(), ok });
    return ok;
  }

  async process(batch: SendBatch, deadline: number): Promise<BatchOutcome> {
    const d = this.d;
    const spec = await loadSpec(d, batch.campaignId);
    if (!spec) throw new Error(`send spec for ${batch.campaignId} is missing`);
    const [keys, base] = await Promise.all([d.unsubscribeKeys(), d.publicBaseUrl()]);
    let throttles = 0;
    let sawThrottle = false;
    for (let i = 0; i < batch.recipients.length; i++) {
      const r = batch.recipients[i] as BatchRecipient;
      if (deadline - d.clock.now() < CONTINUATION_MARGIN_MS) {
        await d.queue.send(d.batchQueues[batch.tier], { body: { ...batch, batchId: newId(d.clock.now()), recipients: batch.recipients.slice(i), attempt: batch.attempt + 1 } });
        return 'continued';
      }
      if (!(await this.canSend(batch, throttles > 0))) return 'halted';
      const waited = await this.limiter.acquire(batch.tier);
      if (waited > 1000 && !(await this.canSend(batch, true))) return 'halted';
      if (await d.suppressions.isSuppressed(r.addrHash, batch.agencyId)) {
        await this.write(r, { set: { status: 'SKIPPED_SUPPRESSED' } }, cond.eq('status', 'PENDING'));
        continue;
      }
      const result = await this.sendOne(spec, batch, r, keys, base);
      if (result === 'throttled') {
        throttles++;
        sawThrottle = true;
        if (await this.circuitOpen(batch)) return 'circuit-open';
        const backoff = Math.min(d.config.maxBackoffMs, 1000 * 2 ** (throttles - 1)) + Math.floor(Math.random() * 250);
        await d.clock.sleep(backoff);
        i--; // retry the same recipient after a fresh status check
        continue;
      }
      if (result === 'accepted' && sawThrottle) {
        sawThrottle = false;
        throttles = 0;
        await d.kv.update(d.tables.sendlog, { pk: `CMP#${batch.campaignId}`, sk: 'STATUS' }, { remove: ['throttledSince'] }).catch(() => undefined);
      }
    }
    return 'done';
  }

  private async write(r: BatchRecipient, update: Parameters<EngineDpDeps['kv']['update']>[2], c: ReturnType<typeof cond.eq>): Promise<boolean> {
    try {
      await this.d.kv.update(this.d.tables.sendlog, { pk: r.pk, sk: r.sk }, update, { cond: c });
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  }

  private async sendOne(spec: SendSpec, batch: SendBatch, r: BatchRecipient, keys: UnsubscribeKeys, base: string): Promise<'accepted' | 'rejected' | 'throttled' | 'unknown' | 'lost-claim'> {
    const d = this.d;
    const claimToken = newId(d.clock.now());
    const claimedAt = d.clock.now();
    const unsubUrl = unsubscribeUrl(base, spec, r.addrHash, keys);
    const claimSet: Record<string, unknown> = { status: 'SENDING', claimToken, claimedAt, sesCalledAt: claimedAt, gsi2pk: `INFLIGHT#${shardOf(r.addrHash)}`, gsi2sk: claimedAt };
    if (d.config.devExport) claimSet['devUnsubUrl'] = unsubUrl;
    // Claim: only the winner of PENDING → SENDING calls SES (FR-DLV-05).
    if (!(await this.write(r, { set: claimSet }, cond.eq('status', 'PENDING')))) return 'lost-claim';
    const outcome = await d.sender.send(buildEmail(spec, r, unsubUrl));
    const mine = cond.eq('claimToken', claimToken);
    switch (outcome.kind) {
      case 'accepted':
        await this.write(r, { set: { status: 'SENT', sesMessageId: outcome.messageId, gsi1pk: outcome.messageId, gsi1sk: r.pk }, remove: ['gsi2pk', 'gsi2sk'] }, cond.and(mine, cond.in('status', ['SENDING', 'IN_DOUBT'])));
        return 'accepted';
      case 'rejected':
        await this.write(r, { set: { status: 'FAILED', errorCode: outcome.code }, remove: ['gsi2pk', 'gsi2sk'] }, cond.and(mine, cond.eq('status', 'SENDING')));
        return 'rejected';
      case 'throttled':
        // SES did not accept: revert the claim so the recipient can be sent later.
        await this.write(r, { set: { status: 'PENDING' }, remove: ['claimToken', 'claimedAt', 'sesCalledAt', 'gsi2pk', 'gsi2sk'] }, cond.and(mine, cond.eq('status', 'SENDING')));
        return 'throttled';
      case 'unknown':
        d.logger.warn('ses outcome unknown; recipient left SENDING', { campaignId: batch.campaignId, rowKey: `${r.pk}/${r.sk}`, code: outcome.code });
        return 'unknown';
    }
  }

  /** FR-FBK-04: after continuous throttling for circuitBreakerMs, pause with SES_THROTTLED. */
  private async circuitOpen(batch: SendBatch): Promise<boolean> {
    const d = this.d;
    const now = d.clock.now();
    const key = { pk: `CMP#${batch.campaignId}`, sk: 'STATUS' };
    await d.kv.update(d.tables.sendlog, key, { set: { throttledSince: now } }, { cond: cond.and(cond.notExists('throttledSince'), cond.eq('status', 'SENDING')) }).catch((e: unknown) => {
      if (!isConditionFailure(e)) throw e;
    });
    const status = await getStatus(d, batch.campaignId);
    const since = Number(status?.['throttledSince'] ?? now);
    if (status?.['status'] !== 'SENDING' || now - since < d.config.circuitBreakerMs) return status?.['status'] !== 'SENDING';
    try {
      await d.kv.transact([
        { kind: 'update', table: d.tables.sendlog, key, update: { set: { status: 'PAUSED', reason: 'SES_THROTTLED' }, remove: ['throttledSince'] }, cond: cond.eq('status', 'SENDING') },
        eventOp(d, 'SendPaused', { campaignId: batch.campaignId, teamId: batch.teamId, reason: 'SES_THROTTLED' }),
      ]);
      await d.metrics.put('CircuitBreakerPaused', 1, { instance: d.config.instance });
      d.logger.error('circuit breaker paused campaign', { campaignId: batch.campaignId });
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
    }
    this.cache.delete(batch.campaignId);
    return true;
  }
}
