import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { freezeRequestSchema } from '@percy/contactsg-contract';
import { FreezeService } from '../index';
import { contactSgRuntime } from './runtime';

const deps = contactSgRuntime('contactsg-freeze');
const freezes = new FreezeService(deps);

/** freeze-requests consumer (batch size 1). */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      const req = freezeRequestSchema.parse(JSON.parse(record.body));
      const outcome = await freezes.handle(req);
      deps.logger.info('freeze step', { freezeId: req.freezeId, outcome });
    } catch (e) {
      deps.logger.error('freeze failed', { messageId: record.messageId, error: e as Error });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
