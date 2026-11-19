import { z } from 'zod';
import { cond, isConditionFailure, type TxOp } from '@percy/shared';
import type { SuppressionRequest } from '@percy/contactsg-contract';
import { eventOp, type EngineDpDeps } from './deps';

/** The subset of the SES event-publishing JSON the feedback consumer reads. */
export const sesEventSchema = z.object({
  eventType: z.string().optional(),
  notificationType: z.string().optional(),
  mail: z.object({ messageId: z.string() }),
  bounce: z.object({ bounceType: z.string() }).optional(),
});
export type SesEvent = z.infer<typeof sesEventSchema>;

export type FeedbackOutcome = 'unmatched' | 'applied' | 'duplicate' | 'ignored';

/**
 * engine-feedback (FR-FBK-01..05, design 7.7). Each flag is set only if absent, so a replayed
 * event is a no-op; a permanent bounce or complaint writes SuppressionRequested{GLOBAL} in the
 * same transaction.
 */
export function createFeedbackHandler(d: EngineDpDeps) {
  return async function handle(raw: unknown): Promise<FeedbackOutcome> {
    const e = sesEventSchema.parse(raw);
    const type = e.eventType ?? e.notificationType ?? '';
    const messageId = e.mail.messageId;
    const match = await d.kv.query(d.tables.sendlog, { index: 'gsi1', pk: messageId, limit: 1 });
    const row = match.items[0];
    if (!row) {
      d.logger.info('unmatched SES event dropped', { sesMessageId: messageId, type });
      return 'unmatched';
    }
    const key = { pk: String(row['pk']), sk: String(row['sk']) };
    const campaignId = String(row['campaignId']);
    const addrHash = String(row['addrHash']);
    const suppress = (reason: SuppressionRequest['reason']): TxOp =>
      eventOp(d, 'SuppressionRequested', { addrHash, scope: 'GLOBAL', reason, sourceCampaignId: campaignId } satisfies SuppressionRequest);

    let ops: TxOp[];
    switch (type) {
      case 'Delivery':
        ops = [{ kind: 'update', table: d.tables.sendlog, key, update: { set: { delivered: true } }, cond: cond.notExists('delivered') }];
        break;
      case 'Bounce': {
        const hard = e.bounce?.bounceType === 'Permanent';
        ops = [
          {
            kind: 'update',
            table: d.tables.sendlog,
            key,
            update: { set: { bounced: hard ? 'hard' : 'soft' } },
            cond: hard ? cond.or(cond.notExists('bounced'), cond.eq('bounced', 'soft')) : cond.notExists('bounced'),
          },
        ];
        if (hard) ops.push(suppress('HARD_BOUNCE'));
        break;
      }
      case 'Complaint':
        ops = [{ kind: 'update', table: d.tables.sendlog, key, update: { set: { complained: true } }, cond: cond.notExists('complained') }, suppress('COMPLAINT')];
        break;
      case 'Reject':
      case 'Rendering Failure':
        ops = [{ kind: 'update', table: d.tables.sendlog, key, update: { set: { status: 'FAILED', errorCode: type } }, cond: cond.in('status', ['SENT', 'SENDING', 'IN_DOUBT']) }];
        break;
      default:
        return 'ignored';
    }
    try {
      await d.kv.transact(ops);
      return 'applied';
    } catch (err) {
      if (isConditionFailure(err)) return 'duplicate';
      throw err;
    }
  };
}
