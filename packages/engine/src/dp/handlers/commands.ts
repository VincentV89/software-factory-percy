import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { sendCommandSchema } from '@percy/engine-contract';
import { createCommandHandler } from '../commands';
import { engineDpRuntime } from './runtime';

const deps = engineDpRuntime('engine-commands');
const handle = createCommandHandler(deps);

/** send-commands.fifo consumer. Malformed messages are logged and acknowledged, never retried. */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: SQSBatchResponse['batchItemFailures'] = [];
  for (const r of event.Records) {
    const parsed = sendCommandSchema.safeParse(JSON.parse(r.body));
    if (!parsed.success) {
      deps.logger.error('invalid command dropped', { messageId: r.messageId });
      continue;
    }
    try {
      const outcome = await handle(parsed.data);
      deps.logger.info('command applied', { commandId: parsed.data.commandId, type: parsed.data.type, campaignId: parsed.data.campaignId, outcome });
    } catch (e) {
      deps.logger.error('command failed', { commandId: parsed.data.commandId, error: e as Error });
      failures.push({ itemIdentifier: r.messageId });
    }
  }
  return { batchItemFailures: failures };
}
