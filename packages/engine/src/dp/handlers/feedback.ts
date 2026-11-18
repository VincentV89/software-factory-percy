import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { createFeedbackHandler } from '../feedback';
import { engineDpRuntime } from './runtime';

const deps = engineDpRuntime('engine-feedback');
const handle = createFeedbackHandler(deps);

/** ses-events consumer (batch 10, partial failures). SNS raw message delivery is on. */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: SQSBatchResponse['batchItemFailures'] = [];
  for (const r of event.Records) {
    try {
      await handle(JSON.parse(r.body));
    } catch (e) {
      deps.logger.error('feedback failed', { messageId: r.messageId, error: e as Error });
      failures.push({ itemIdentifier: r.messageId });
    }
  }
  return { batchItemFailures: failures };
}
