import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { InMemoryKvStore, TransactionCanceledError, cond, isConditionFailure, type KvStore } from '@percy/shared';
import { DynamoKvStore } from '@percy/shared/dynamo';

/**
 * Fake parity suite (R2): one contract run against the in-memory fake and, when PERCY_DDB_ENDPOINT
 * and PERCY_DDB_TABLE point at DynamoDB (Local or a dev table with pk/sk and gsi1), against the real thing.
 * In the build runtime only the fake runs; the DynamoDB half is reported as skipped.
 */
function contract(name: string, make: () => { kv: KvStore; table: string }) {
  describe(`KvStore contract: ${name}`, () => {
    const id = `parity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    it('claim semantics: only one of two conditional claims wins', async () => {
      const { kv, table } = make();
      await kv.put(table, { pk: id, sk: 'R#1', status: 'PENDING' }, cond.itemAbsent());
      const claim = (token: string) => kv.update(table, { pk: id, sk: 'R#1' }, { set: { status: 'SENDING', claimToken: token } }, { cond: cond.eq('status', 'PENDING') }).then(() => token, (e: unknown) => (isConditionFailure(e) ? null : Promise.reject(e)));
      const results = await Promise.all([claim('a'), claim('b')]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('transactions cancel atomically with a condition failure', async () => {
      const { kv, table } = make();
      await kv.put(table, { pk: id, sk: 'CKPT', lastSeq: '5' });
      const err = await kv
        .transact([
          { kind: 'update', table, key: { pk: id, sk: 'COUNTERS' }, update: { add: { sent: 1 } } },
          { kind: 'update', table, key: { pk: id, sk: 'CKPT' }, update: { set: { lastSeq: '6' } }, cond: cond.eq('lastSeq', '4') },
        ])
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransactionCanceledError);
      expect(await kv.get(table, { pk: id, sk: 'COUNTERS' }, { consistent: true })).toBeUndefined();
    });

    it('ADD on a missing attribute starts at zero; REMOVE clears', async () => {
      const { kv, table } = make();
      const out = await kv.update(table, { pk: id, sk: 'C' }, { add: { n: 3 }, set: { s: 'x' } });
      expect(out.new).toMatchObject({ n: 3, s: 'x' });
      await kv.update(table, { pk: id, sk: 'C' }, { remove: ['s'] });
      expect((await kv.get(table, { pk: id, sk: 'C' }, { consistent: true }))?.['s']).toBeUndefined();
    });

    it('begins_with query on the sort key', async () => {
      const { kv, table } = make();
      for (const sk of ['MEMBER#a', 'MEMBER#b', 'HOLD#x']) await kv.put(table, { pk: `${id}-q`, sk });
      const out = await kv.query(table, { pk: `${id}-q`, sk: { beginsWith: 'MEMBER#' }, consistent: true });
      expect(out.items.map((i) => i['sk'])).toEqual(['MEMBER#a', 'MEMBER#b']);
    });
  });
}

contract('in-memory fake', () => ({ kv: new InMemoryKvStore(), table: 'parity' }));

const endpoint = process.env['PERCY_DDB_ENDPOINT'];
const ddbTable = process.env['PERCY_DDB_TABLE'];
if (endpoint && ddbTable) {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ endpoint }), { marshallOptions: { removeUndefinedValues: true } });
  contract(`DynamoDB at ${endpoint}`, () => ({ kv: new DynamoKvStore(doc), table: ddbTable }));
} else {
  describe.skip('KvStore contract: real DynamoDB (set PERCY_DDB_ENDPOINT and PERCY_DDB_TABLE)', () => {
    it('not run in this environment', () => undefined);
  });
}
