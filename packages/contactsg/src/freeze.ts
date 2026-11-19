import { gzipSync } from 'node:zlib';
import { cond, isConditionFailure, makeEvent, outboxPut, type Item } from '@percy/shared';
import { CONTACTSG_SOURCE, KvSuppressionReader, type FreezeRequest, type SnapshotManifest, type SnapshotRecipient } from '@percy/contactsg-contract';
import type { ContactSgDeps } from './deps';
import { isAllowed, missingFields } from './domain/csv';
import { contactKey, memberPk } from './lists';
import { createRecipientVerifier, type RecipientStatus, type VerificationSnapshot } from './recipient-verification';

interface FreezeProgress {
  cursor?: string;
  parts: { key: string; count: number }[];
  pending: SnapshotRecipient[];
  recipientCount: number;
  missing: Record<string, number>;
  notAllowed: number;
  excludedSuppressed: number;
}

const freezeKey = (freezeId: string) => ({ pk: `FREEZE#${freezeId}`, sk: 'META' });

/**
 * Audience freeze (FR-SCH-03/04, NFR-INF-05). Pages through the list, applies the live
 * suppression check, counts missing required fields and allow-list misses, and writes gzip JSONL
 * parts. Work is resumable: when the time budget runs out, progress is saved and the request
 * re-enqueued, so a 1M-member list completes across several invocations.
 */
export class FreezeService {
  private readonly suppressions: KvSuppressionReader;

  constructor(private readonly d: ContactSgDeps) {
    this.suppressions = new KvSuppressionReader(d.kv, d.tables.suppressions);
  }

  async handle(req: FreezeRequest): Promise<'done' | 'continued' | 'skipped'> {
    const { kv, tables, clock } = this.d;
    const started = clock.now();
    const existing = await kv.get(tables.freezes, freezeKey(req.freezeId), { consistent: true });
    if (existing && (existing['status'] === 'FROZEN' || existing['status'] === 'FAILED')) return 'skipped';
    const progress: FreezeProgress = (existing?.['progress'] as FreezeProgress | undefined) ?? { parts: [], pending: [], recipientCount: 0, missing: {}, notAllowed: 0, excludedSuppressed: 0 };
    if (!existing) await kv.put(tables.freezes, { ...freezeKey(req.freezeId), requestRef: req.requestRef, status: 'RUNNING', progress, startedAt: started }, cond.itemAbsent()).catch(ignoreCondition);

    let verification: VerificationSnapshot | undefined;
    if (this.d.recipientVerification) {
      try { verification = await this.d.recipientVerification.snapshot(); }
      catch (error) {
        this.d.logger.error('SES identity lookup failed', { freezeId: req.freezeId, error: error instanceof Error ? error : new Error('SES lookup unavailable') });
        await this.fail(req, progress, 'SES verification status is unavailable. No messages were sent. Refresh verification status and retry.');
        return 'done';
      }
    }

    const verify = verification ? createRecipientVerifier(verification) : undefined;
    do {
      const page = await kv.query(tables.contacts, { pk: memberPk(req.teamId, req.listId), sk: { beginsWith: 'MEMBER#' }, cursor: progress.cursor, limit: 500 });
      await this.processPage(req, page.items, progress, verify);
      progress.cursor = page.cursor;
      while (progress.pending.length >= this.d.config.partSize) await this.flushPart(req, progress, this.d.config.partSize);
      if (progress.cursor && clock.now() - started > this.d.config.freezeBudgetMs) {
        // Never persist recipient addresses in the progress record: flush them to a part first.
        if (progress.pending.length > 0) await this.flushPart(req, progress, progress.pending.length);
        await kv.update(tables.freezes, freezeKey(req.freezeId), { set: { progress } });
        await this.d.queue.send(this.d.freezeQueue, { body: req });
        return 'continued';
      }
    } while (progress.cursor);
    if (progress.pending.length > 0) await this.flushPart(req, progress, progress.pending.length);
    await this.finish(req, progress, verification);
    return 'done';
  }

  private async processPage(req: FreezeRequest, members: Item[], progress: FreezeProgress, verify?: (email: string) => RecipientStatus): Promise<void> {
    const contacts = await this.d.kv.batchGet(this.d.tables.contacts, members.map((m) => contactKey(req.agencyId, String(m['addrHash']))));
    const emailByHash = new Map(contacts.map((c) => [String(c['sk']).slice('CONTACT#'.length), String(c['email'])]));
    for (const m of members) {
      const addrHash = String(m['addrHash']);
      if (m['suppressed'] === true || (await this.suppressions.isSuppressed(addrHash, req.agencyId))) {
        progress.excludedSuppressed++;
        continue;
      }
      const email = emailByHash.get(addrHash);
      if (!email) continue;
      const attrs = (m['attrs'] as Record<string, string> | undefined) ?? {};
      for (const f of missingFields(attrs, req.requiredFields)) progress.missing[f] = (progress.missing[f] ?? 0) + 1;
      if (verify ? !verify(email).allowed : req.addressAllowList && !isAllowed(email, req.addressAllowList)) progress.notAllowed++;
      const used: Record<string, string> = {};
      for (const f of req.requiredFields) if (attrs[f] !== undefined) used[f] = attrs[f];
      progress.pending.push({ addrHash, email, attrs: used });
      progress.recipientCount++;
    }
  }

  private async flushPart(req: FreezeRequest, progress: FreezeProgress, size: number): Promise<void> {
    const batch = progress.pending.splice(0, size);
    const key = `snapshots/${req.freezeId}/part-${String(progress.parts.length).padStart(5, '0')}.jsonl.gz`;
    await this.d.store.put(this.d.buckets.snapshots, key, gzipSync(batch.map((r) => JSON.stringify(r)).join('\n')));
    progress.parts.push({ key, count: batch.length });
  }

  private async fail(req: FreezeRequest, progress: FreezeProgress, reason: string, extra: Record<string, unknown> = {}): Promise<void> {
    for (const part of progress.parts) await this.d.store.delete(this.d.buckets.snapshots, part.key);
    const now = this.d.clock.now();
    const payload = { ...extra, freezeId: req.freezeId, requestRef: req.requestRef, reason };
    await this.d.kv.transact([
      { kind: 'update', table: this.d.tables.freezes, key: freezeKey(req.freezeId), update: { set: { status: 'FAILED', reason }, remove: ['progress'] }, cond: cond.ne('status', 'FAILED') },
      outboxPut(this.d.tables.outbox, makeEvent(CONTACTSG_SOURCE, 'AudienceFreezeFailed', payload, now), Math.floor(now / 1000)),
    ]).catch(ignoreCondition);
  }

  private async finish(req: FreezeRequest, progress: FreezeProgress, verification?: VerificationSnapshot): Promise<void> {
    const { kv, tables, clock } = this.d;
    const now = clock.now();
    const missingAny = Object.keys(progress.missing).length > 0;
    if (missingAny || progress.notAllowed > 0) {
      const reasons: string[] = [];
      if (missingAny) reasons.push('Recipients are missing merge fields: ' + Object.entries(progress.missing).map(([f, n]) => `${f}: ${n}`).join(', '));
      if (progress.notAllowed > 0) reasons.push(verification
        ? `${progress.notAllowed} recipient address(es) are not verified in SES (${verification.region}). Verify the email address or its domain in SES, then retry.`
        : `${progress.notAllowed} recipient address(es) are not on this instance's allow-list`);
      const payload: Record<string, unknown> = { freezeId: req.freezeId, requestRef: req.requestRef, reason: reasons.join('; ') };
      if (missingAny) payload['missingFields'] = progress.missing;
      if (progress.notAllowed > 0) payload['notAllowedCount'] = progress.notAllowed;
      await this.fail(req, progress, String(payload['reason']), payload);
      return;
    }
    const manifestKey = `snapshots/${req.freezeId}/manifest.json`;
    const manifest: SnapshotManifest = { freezeId: req.freezeId, requestRef: req.requestRef, agencyId: req.agencyId, createdAt: new Date(now).toISOString(), recipientCount: progress.recipientCount, parts: progress.parts };
    await this.d.store.put(this.d.buckets.snapshots, manifestKey, JSON.stringify(manifest), { contentType: 'application/json' });
    await kv.transact([
      { kind: 'update', table: tables.freezes, key: freezeKey(req.freezeId), update: { set: { status: 'FROZEN', manifestKey, recipientCount: progress.recipientCount, excludedSuppressed: progress.excludedSuppressed }, remove: ['progress'] }, cond: cond.ne('status', 'FROZEN') },
      outboxPut(tables.outbox, makeEvent(CONTACTSG_SOURCE, 'AudienceFrozen', { freezeId: req.freezeId, requestRef: req.requestRef, manifestKey, recipientCount: progress.recipientCount }, now), Math.floor(now / 1000)),
    ]).catch(ignoreCondition);
  }
}

function ignoreCondition(e: unknown): void {
  if (!isConditionFailure(e)) throw e;
}
