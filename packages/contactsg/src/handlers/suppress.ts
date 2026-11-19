import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { unwrapBusMessage } from '@percy/shared';
import { suppressionRequestSchema } from '@percy/contactsg-contract';
import { SuppressionService } from '../index';
import { contactSgRuntime } from './runtime';

const deps = contactSgRuntime('contactsg-suppress');
const suppressions = new SuppressionService(deps);

/** Consumer of SuppressionRequested events from the percy-domain bus (FR-FBK-02, FR-UNS-02). */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      const envelope = unwrapBusMessage(JSON.parse(record.body));
      await suppressions.suppress(suppressionRequestSchema.parse(envelope.payload));
    } catch (e) {
      deps.logger.error('suppression failed', { messageId: record.messageId, error: e as Error });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
