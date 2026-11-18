import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { unwrapBusMessage } from '@percy/shared';
import { audienceFrozenSchema } from '@percy/contactsg-contract';
import { parseRequestRef } from '../../domain/send';
import { engineDpRuntime } from './runtime';

const deps = engineDpRuntime('engine-saga-start');

/** AudienceFrozen consumer: starts the send saga with execution name send-<c> (idempotent). */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: SQSBatchResponse['batchItemFailures'] = [];
  for (const r of event.Records) {
    try {
      const frozen = audienceFrozenSchema.parse(unwrapBusMessage(JSON.parse(r.body)).payload);
      const { campaignId } = parseRequestRef(frozen.requestRef);
      const started = await deps.workflows.start(deps.stateMachines.saga, `send-${campaignId}`, frozen);
      deps.logger.info('saga start', { campaignId, started });
    } catch (e) {
      deps.logger.error('saga start failed', { messageId: r.messageId, error: e as Error });
      failures.push({ itemIdentifier: r.messageId });
    }
  }
  return { batchItemFailures: failures };
}
