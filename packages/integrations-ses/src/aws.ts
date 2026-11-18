import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { classifySesError, type EmailSender, type OutboundEmail, type SendOutcome } from './index';

/** SESv2 SendEmail adapter with a hard per-call timeout (design 7.5: 10 s). */
export class SesEmailSender implements EmailSender {
  constructor(private readonly ses = new SESv2Client({ maxAttempts: 1 }), private readonly timeoutMs = 10_000) {}

  async send(email: OutboundEmail): Promise<SendOutcome> {
    try {
      const out = await this.ses.send(
        new SendEmailCommand({
          FromEmailAddress: email.from,
          Destination: { ToAddresses: [email.to] },
          ConfigurationSetName: email.configurationSet,
          EmailTags: Object.entries(email.tags ?? {}).map(([Name, Value]) => ({ Name, Value })),
          Content: {
            Simple: {
              Subject: { Data: email.subject, Charset: 'UTF-8' },
              Body: { Html: { Data: email.html, Charset: 'UTF-8' }, Text: { Data: email.text, Charset: 'UTF-8' } },
              Headers: email.headers.map((h) => ({ Name: h.name, Value: h.value })),
            },
          },
        }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );
      if (!out.MessageId) return { kind: 'unknown', code: 'NoMessageId' };
      return { kind: 'accepted', messageId: out.MessageId };
    } catch (e) {
      return classifySesError(e);
    }
  }
}
