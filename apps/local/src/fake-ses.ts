import type { Clock, QueueSender } from '@percy/shared';
import { classifySesError, type EmailSender, type OutboundEmail, type SendOutcome } from '@percy/integrations-ses';

export interface SesCall {
  to: string;
  at: number;
  campaignId?: string;
  subject: string;
  outcome: SendOutcome['kind'];
  messageId?: string;
  email: OutboundEmail;
}

export type SesBehaviour = (email: OutboundEmail, callIndex: number) => SendOutcome | 'throw' | Promise<SendOutcome | 'throw'>;

/**
 * Stub SES with the mailbox-simulator semantics used by the E2E fixtures: after acceptance it
 * publishes Delivery, Bounce (bounce@) or Complaint (complaint@) events to ses-events.
 */
export class FakeSes implements EmailSender {
  readonly calls: SesCall[] = [];
  behaviour: SesBehaviour = () => ({ kind: 'accepted', messageId: '' });
  /** Delay of a simulated SES call in ms of clock time. */
  latencyMs = 0;
  private seq = 0;

  constructor(private readonly clock: Clock, private readonly feedback?: { queue: QueueSender; url: string; delayMs: number }) {}

  async send(email: OutboundEmail): Promise<SendOutcome> {
    const at = this.clock.now();
    if (this.latencyMs > 0) await this.clock.sleep(this.latencyMs);
    let outcome: SendOutcome | 'throw' = await this.behaviour(email, this.calls.length);
    if (outcome === 'throw') outcome = classifySesError(Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }));
    if (outcome.kind === 'accepted' && !outcome.messageId) outcome = { kind: 'accepted', messageId: `ses-${++this.seq}-${at}` };
    this.calls.push({ to: email.to, at, campaignId: email.tags?.['campaignId'], subject: email.subject, outcome: outcome.kind, messageId: outcome.kind === 'accepted' ? outcome.messageId : undefined, email });
    if (outcome.kind === 'accepted' && this.feedback) void this.publishFeedback(email.to, outcome.messageId);
    return outcome;
  }

  private async publishFeedback(to: string, messageId: string): Promise<void> {
    const fb = this.feedback;
    if (!fb) return;
    await this.clock.sleep(fb.delayMs);
    const local = to.split('@')[0] ?? '';
    const mail = { messageId };
    if (local.startsWith('bounce')) await fb.queue.send(fb.url, { body: { eventType: 'Bounce', mail, bounce: { bounceType: 'Permanent' } } });
    else if (local.startsWith('complaint')) {
      await fb.queue.send(fb.url, { body: { eventType: 'Delivery', mail } });
      await fb.queue.send(fb.url, { body: { eventType: 'Complaint', mail } });
    } else await fb.queue.send(fb.url, { body: { eventType: 'Delivery', mail } });
  }

  callsFor(to: string): SesCall[] {
    return this.calls.filter((c) => c.to === to);
  }
}
