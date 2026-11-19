import type { Context, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { sendBatchSchema } from '../../domain/send';
import { SendWorker } from '../worker';
import { engineDpRuntime } from './runtime';

const deps = engineDpRuntime('send-worker');
const worker = new SendWorker(deps);

/** send-worker-<tier>: batch size 1, ReportBatchItemFailures, reserved concurrency per tier. */
export async function handler(event: SQSEvent, context: Context): Promise<SQSBatchResponse> {
  const deadline = Date.now() + context.getRemainingTimeInMillis();
  const failures: SQSBatchResponse['batchItemFailures'] = [];
  for (const r of event.Records) {
    try {
      const batch = sendBatchSchema.parse(JSON.parse(r.body));
      const outcome = await worker.process(batch, deadline);
      deps.logger.info('batch processed', { campaignId: batch.campaignId, batchId: batch.batchId, outcome, size: batch.recipients.length });
    } catch (e) {
      deps.logger.error('batch failed', { messageId: r.messageId, error: e as Error });
      failures.push({ itemIdentifier: r.messageId });
    }
  }
  return { batchItemFailures: failures };
}
