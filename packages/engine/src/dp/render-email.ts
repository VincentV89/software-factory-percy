import type { OutboundEmail } from '@percy/integrations-ses';
import type { BatchRecipient, SendSpec } from '../domain/send';
import { render, UNSUBSCRIBE_FIELD } from '../domain/template';
import { signUnsubscribeToken, type UnsubscribeKeys } from '../domain/unsubscribe-token';

export function unsubscribeUrl(base: string, spec: Pick<SendSpec, 'campaignId' | 'agencyId'>, addrHash: string, keys: UnsubscribeKeys): string {
  return `${base.replace(/\/$/, '')}/u/${signUnsubscribeToken({ campaignId: spec.campaignId, agencyId: spec.agencyId, addrHash }, keys)}`;
}

/** Builds one recipient's email from the frozen spec and attributes (FR-DLV-09). */
export function buildEmail(spec: SendSpec, r: BatchRecipient, unsubUrl: string): OutboundEmail {
  const rendered = render(spec.template, { ...r.attrs, email: r.email, [UNSUBSCRIBE_FIELD]: unsubUrl });
  const display = spec.senderName.replace(/["\\\r\n]/g, '').slice(0, 100);
  return {
    from: `"${display}" <${spec.fromAddress}>`,
    to: r.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    headers: [
      { name: 'List-Unsubscribe', value: `<${unsubUrl}>` },
      { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
    ],
    configurationSet: spec.configurationSet,
    tags: { campaignId: spec.campaignId },
  };
}
