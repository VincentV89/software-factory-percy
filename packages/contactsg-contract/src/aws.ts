import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { NotFound } from '@percy/shared';
import type { ListHoldClient, ListHoldRequest } from './index';

/** cp→cp synchronous call to contactsg-internal (design 5.5). */
export class LambdaListHoldClient implements ListHoldClient {
  constructor(private readonly functionName: string, private readonly lambda = new LambdaClient({})) {}

  private async call(req: ListHoldRequest): Promise<void> {
    const out = await this.lambda.send(new InvokeCommand({ FunctionName: this.functionName, Payload: Buffer.from(JSON.stringify(req)) }));
    if (out.FunctionError) throw new Error(`contactsg-internal failed: ${out.FunctionError}`);
    const result = JSON.parse(Buffer.from(out.Payload ?? new Uint8Array()).toString('utf8') || '{}') as { ok?: boolean; notFound?: boolean };
    if (result.notFound) throw new NotFound('List not found.');
  }

  acquire(teamId: string, listId: string, holderRef: string): Promise<void> {
    return this.call({ op: 'acquire', teamId, listId, holderRef });
  }

  release(teamId: string, listId: string, holderRef: string): Promise<void> {
    return this.call({ op: 'release', teamId, listId, holderRef });
  }
}
