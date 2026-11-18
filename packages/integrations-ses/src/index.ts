/** EmailSender port (Integrations context). The send worker depends only on this interface. */
export interface OutboundEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: { name: string; value: string }[];
  configurationSet?: string;
  tags?: Record<string, string>;
}

export type SendOutcome =
  | { kind: 'accepted'; messageId: string }
  /** SES definitely did not accept and will not (e.g. MessageRejected). */
  | { kind: 'rejected'; code: string }
  /** SES definitely did not accept because of throttling; safe to retry later. */
  | { kind: 'throttled'; code: string }
  /** Timeout or unknown error: SES may or may not have accepted. Never retried automatically. */
  | { kind: 'unknown'; code: string };

export interface EmailSender {
  send(email: OutboundEmail): Promise<SendOutcome>;
}

const THROTTLE_CODES = new Set(['Throttling', 'ThrottlingException', 'TooManyRequestsException', 'LimitExceededException', 'SendingPausedException']);
const REJECT_CODES = new Set(['MessageRejected', 'MailFromDomainNotVerifiedException', 'AccountSuspendedException', 'BadRequestException', 'NotFoundException']);

/** Classifies an SES error. Only definite non-acceptance may revert a claim (ADR-05). */
export function classifySesError(e: unknown): SendOutcome {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  const code = err.name ?? 'Unknown';
  if (THROTTLE_CODES.has(code)) return { kind: 'throttled', code };
  if (REJECT_CODES.has(code)) return { kind: 'rejected', code };
  return { kind: 'unknown', code };
}
