import { FirehoseClient, PutRecordCommand } from '@aws-sdk/client-firehose';
import { createLogger } from '@percy/shared';
import { buildAuditEvent, type AuditClient, type AuditInput } from './audit';

const log = createLogger('audit');

/** Firehose-backed AuditClient. Audit failures are logged and rethrown: an action must not succeed unaudited. */
export class FirehoseAuditClient implements AuditClient {
  constructor(private readonly streamName: string, private readonly firehose = new FirehoseClient({}), private readonly now: () => number = Date.now) {}

  async record(input: AuditInput): Promise<void> {
    const event = buildAuditEvent(input, this.now());
    try {
      await this.firehose.send(new PutRecordCommand({ DeliveryStreamName: this.streamName, Record: { Data: Buffer.from(JSON.stringify(event) + '\n') } }));
    } catch (e) {
      log.error('audit write failed', { action: input.action, requestId: input.requestId, error: e as Error });
      throw e;
    }
  }
}
