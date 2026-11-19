import type { DynamoDBStreamEvent } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { Item } from '@percy/shared';
import { createAggregator, type SendlogChange } from '../aggregator';
import { engineDpRuntime } from './runtime';

const aggregator = createAggregator(engineDpRuntime('engine-aggregator'));

type Image = Parameters<typeof unmarshall>[0];

/** engine-sendlog stream consumer (NEW_AND_OLD_IMAGES, batch size 40, bisect on error). */
export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  const changes: SendlogChange[] = event.Records.map((r) => {
    const keys = unmarshall((r.dynamodb?.Keys ?? {}) as Image) as { pk: string; sk: string };
    return {
      seq: r.dynamodb?.SequenceNumber ?? '0',
      keys,
      oldImage: r.dynamodb?.OldImage ? (unmarshall(r.dynamodb.OldImage as Image) as Item) : undefined,
      newImage: r.dynamodb?.NewImage ? (unmarshall(r.dynamodb.NewImage as Image) as Item) : undefined,
    };
  });
  await aggregator.handle(changes);
}
