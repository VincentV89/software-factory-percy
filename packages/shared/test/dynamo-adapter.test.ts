import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConditionFailedError, TransactionCanceledError, cond } from '../src';
import { DynamoKvStore, ExpressionBuilder } from '../src/kv/dynamo';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-southeast-1' }));
const mock = mockClient(doc);

describe('DynamoKvStore translates to the expected DynamoDB expressions', () => {
  beforeEach(() => mock.reset());

  it('claim: conditional UpdateItem on the prior status (FR-DLV-05)', async () => {
    mock.on(UpdateCommand).resolves({ Attributes: { pk: 'p', sk: 's', status: 'SENDING' } });
    const kv = new DynamoKvStore(doc);
    await kv.update('sendlog', { pk: 'p', sk: 's' }, { set: { status: 'SENDING', claimToken: 't' } }, { cond: cond.eq('status', 'PENDING') });
    const input = mock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.UpdateExpression).toBe('SET #n0 = :v0, #n1 = :v1');
    expect(input?.ConditionExpression).toBe('#n0 = :v2');
    expect(input?.ExpressionAttributeNames).toEqual({ '#n0': 'status', '#n1': 'claimToken' });
    expect(input?.ExpressionAttributeValues).toEqual({ ':v0': 'SENDING', ':v1': 't', ':v2': 'PENDING' });
  });

  it('row creation is a conditional PutItem, never BatchWrite (ADR-05)', async () => {
    mock.on(PutCommand).resolves({});
    await new DynamoKvStore(doc).put('sendlog', { pk: 'p', sk: 'R#1', status: 'PENDING' }, cond.itemAbsent());
    expect(mock.commandCalls(PutCommand)[0]?.args[0].input.ConditionExpression).toBe('attribute_not_exists(#n0)');
    expect(mock.calls().map((c) => c.args[0].constructor.name)).toEqual(['PutCommand']);
  });

  it('maps ConditionalCheckFailed to ConditionFailedError', async () => {
    mock.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
    await expect(new DynamoKvStore(doc).put('t', { pk: 'a', sk: 'b' }, cond.itemAbsent())).rejects.toBeInstanceOf(ConditionFailedError);
  });

  it('transactions carry per-item conditions and map cancellation reasons', async () => {
    mock.on(TransactWriteCommand).rejects(Object.assign(new Error('cancel'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }] }));
    const kv = new DynamoKvStore(doc);
    const err = await kv
      .transact([
        { kind: 'update', table: 'c', key: { pk: 'CMP#1', sk: 'COUNTERS' }, update: { add: { sent: 1 } } },
        { kind: 'update', table: 'c', key: { pk: 'CKPT#p', sk: 'CKPT' }, update: { set: { lastSeq: '9' } }, cond: cond.notExists('lastSeq') },
        { kind: 'delete', table: 'c', key: { pk: 'a', sk: 'b' }, cond: cond.exists('pk') },
        { kind: 'check', table: 'c', key: { pk: 'a', sk: 'b' }, cond: cond.ne('x', 1) },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransactionCanceledError);
    expect((err as TransactionCanceledError).conditionFailed).toBe(true);
    const items = mock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];
    expect(items[0]?.Update?.UpdateExpression).toBe('ADD #n0 :v0');
    expect(items[1]?.Update?.ConditionExpression).toBe('attribute_not_exists(#n0)');
    expect(items[2]?.Delete?.ConditionExpression).toBe('attribute_exists(#n0)');
    expect(items[3]?.ConditionCheck?.ConditionExpression).toBe('(attribute_not_exists(#n0) OR #n0 <> :v0)');
  });

  it('queries translate key conditions, index names and cursors', async () => {
    mock.on(QueryCommand).resolves({ Items: [{ pk: 'a' }], LastEvaluatedKey: { pk: 'a', sk: 'b' } });
    const out = await new DynamoKvStore(doc).query('t', { index: 'gsi2', pk: 'INFLIGHT#3', sk: { lt: 100 }, limit: 10, consistent: true });
    const input = mock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(input).toMatchObject({ IndexName: 'gsi2', KeyConditionExpression: '#n0 = :v0 AND #n1 < :v1', ExpressionAttributeNames: { '#n0': 'gsi2pk', '#n1': 'gsi2sk' }, Limit: 10, ConsistentRead: undefined });
    expect(out.cursor).toBeDefined();
  });

  it('expression builder handles remove, IN, OR and NOT', () => {
    const b = new ExpressionBuilder();
    expect(b.update({ set: { a: 1, gone: undefined }, remove: ['b'] })).toBe('SET #n0 = :v0 REMOVE #n1, #n2');
    expect(b.cond(cond.or(cond.in('s', ['A', 'B']), cond.not(cond.ge('n', 2))))).toBe('(#n3 IN (:v1, :v2) OR (NOT #n4 >= :v3))');
  });
});
