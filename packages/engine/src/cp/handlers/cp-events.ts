import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { unwrapBusMessage } from '@percy/shared';
import { createCpEventHandler } from '../events';
import { engineCpRuntime } from './runtime';

const deps = engineCpRuntime('engine-cp-events');
const handle = createCpEventHandler(deps);

/** percy-domain bus consumer for the control plane. */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: SQSBatchResponse['batchItemFailures'] = [];
  for (const r of event.Records) {
    try {
      await handle(unwrapBusMessage(JSON.parse(r.body)));
    } catch (e) {
      deps.logger.error('cp event failed', { messageId: r.messageId, error: e as Error });
      failures.push({ itemIdentifier: r.messageId });
    }
  }
  return { batchItemFailures: failures };
}
