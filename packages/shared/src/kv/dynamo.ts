import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  ConditionFailedError,
  TransactionCanceledError,
  type Cond,
  type Item,
  type Key,
  type KvStore,
  type QueryInput,
  type QueryOutput,
  type TxOp,
  type Update,
} from './types';

/** Accumulates expression attribute names and values with stable placeholders. */
export class ExpressionBuilder {
  names: Record<string, string> = {};
  values: Record<string, unknown> = {};
  private n = 0;
  private v = 0;
  private nameIndex = new Map<string, string>();

  name(attr: string): string {
    const existing = this.nameIndex.get(attr);
    if (existing) return existing;
    const ph = `#n${this.n++}`;
    this.names[ph] = attr;
    this.nameIndex.set(attr, ph);
    return ph;
  }

  value(val: unknown): string {
    const ph = `:v${this.v++}`;
    this.values[ph] = val;
    return ph;
  }

  cond(c: Cond): string {
    switch (c.op) {
      case 'exists':
        return `attribute_exists(${this.name(c.attr)})`;
      case 'notExists':
        return `attribute_not_exists(${this.name(c.attr)})`;
      case 'eq':
        return `${this.name(c.attr)} = ${this.value(c.value)}`;
      case 'ne':
        return `(attribute_not_exists(${this.name(c.attr)}) OR ${this.name(c.attr)} <> ${this.value(c.value)})`;
      case 'lt':
        return `${this.name(c.attr)} < ${this.value(c.value)}`;
      case 'le':
        return `${this.name(c.attr)} <= ${this.value(c.value)}`;
      case 'gt':
        return `${this.name(c.attr)} > ${this.value(c.value)}`;
      case 'ge':
        return `${this.name(c.attr)} >= ${this.value(c.value)}`;
      case 'in':
        return `${this.name(c.attr)} IN (${c.values.map((x) => this.value(x)).join(', ')})`;
      case 'and':
        return `(${c.conds.map((x) => this.cond(x)).join(' AND ')})`;
      case 'or':
        return `(${c.conds.map((x) => this.cond(x)).join(' OR ')})`;
      case 'not':
        return `(NOT ${this.cond(c.cond)})`;
    }
  }

  update(u: Update): string {
    const parts: string[] = [];
    const sets = Object.entries(u.set ?? {}).filter(([, v]) => v !== undefined);
    const removes = [...(u.remove ?? []), ...Object.entries(u.set ?? {}).filter(([, v]) => v === undefined).map(([k]) => k)];
    if (sets.length) parts.push('SET ' + sets.map(([k, v]) => `${this.name(k)} = ${this.value(v)}`).join(', '));
    const adds = Object.entries(u.add ?? {});
    if (adds.length) parts.push('ADD ' + adds.map(([k, v]) => `${this.name(k)} ${this.value(v)}`).join(', '));
    if (removes.length) parts.push('REMOVE ' + removes.map((k) => this.name(k)).join(', '));
    return parts.join(' ');
  }

  get attributeNames(): Record<string, string> | undefined {
    return Object.keys(this.names).length ? this.names : undefined;
  }

  get attributeValues(): Record<string, unknown> | undefined {
    return Object.keys(this.values).length ? this.values : undefined;
  }
}

const encodeCursor = (k: Record<string, unknown> | undefined): string | undefined =>
  k ? Buffer.from(JSON.stringify(k)).toString('base64url') : undefined;
const decodeCursor = (c: string | undefined): Record<string, unknown> | undefined =>
  c ? (JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as Record<string, unknown>) : undefined;

export class DynamoKvStore implements KvStore {
  constructor(private readonly doc: DynamoDBDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })) {}

  async get(table: string, key: Key, opts?: { consistent?: boolean }): Promise<Item | undefined> {
    const out = await this.doc.send(new GetCommand({ TableName: table, Key: { pk: key.pk, sk: key.sk }, ConsistentRead: opts?.consistent }));
    return out.Item;
  }

  async batchGet(table: string, keys: Key[]): Promise<Item[]> {
    const items: Item[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      let request: Record<string, { Keys: Record<string, unknown>[] }> | undefined = {
        [table]: { Keys: keys.slice(i, i + 100).map((k) => ({ pk: k.pk, sk: k.sk })) },
      };
      while (request && Object.keys(request).length) {
        const out = await this.doc.send(new BatchGetCommand({ RequestItems: request }));
        items.push(...(out.Responses?.[table] ?? []));
        request = out.UnprocessedKeys as typeof request;
      }
    }
    return items;
  }

  async put(table: string, item: Item, c?: Cond): Promise<void> {
    const b = new ExpressionBuilder();
    const expr = c ? b.cond(c) : undefined;
    try {
      await this.doc.send(new PutCommand({ TableName: table, Item: item, ConditionExpression: expr, ExpressionAttributeNames: b.attributeNames, ExpressionAttributeValues: b.attributeValues }));
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) throw new ConditionFailedError(table, { pk: String(item['pk']), sk: String(item['sk']) });
      throw e;
    }
  }

  async update(table: string, key: Key, update: Update, opts?: { cond?: Cond }): Promise<{ old?: Item; new: Item }> {
    const b = new ExpressionBuilder();
    const updateExpr = b.update(update);
    const condExpr = opts?.cond ? b.cond(opts.cond) : undefined;
    try {
      const out = await this.doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { pk: key.pk, sk: key.sk },
          UpdateExpression: updateExpr,
          ConditionExpression: condExpr,
          ExpressionAttributeNames: b.attributeNames,
          ExpressionAttributeValues: b.attributeValues,
          ReturnValues: 'ALL_NEW',
        }),
      );
      return { new: out.Attributes ?? { ...key } };
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) throw new ConditionFailedError(table, key);
      throw e;
    }
  }

  async delete(table: string, key: Key, c?: Cond): Promise<Item | undefined> {
    const b = new ExpressionBuilder();
    const expr = c ? b.cond(c) : undefined;
    try {
      const out = await this.doc.send(
        new DeleteCommand({ TableName: table, Key: { pk: key.pk, sk: key.sk }, ConditionExpression: expr, ExpressionAttributeNames: b.attributeNames, ExpressionAttributeValues: b.attributeValues, ReturnValues: 'ALL_OLD' }),
      );
      return out.Attributes;
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) throw new ConditionFailedError(table, key);
      throw e;
    }
  }

  async query(table: string, q: QueryInput): Promise<QueryOutput> {
    const b = new ExpressionBuilder();
    const pkAttr = q.index ? `${q.index}pk` : 'pk';
    const skAttr = q.index ? `${q.index}sk` : 'sk';
    let keyExpr = `${b.name(pkAttr)} = ${b.value(q.pk)}`;
    const s = q.sk;
    if (s?.beginsWith !== undefined) keyExpr += ` AND begins_with(${b.name(skAttr)}, ${b.value(s.beginsWith)})`;
    if (s?.between) keyExpr += ` AND ${b.name(skAttr)} BETWEEN ${b.value(s.between[0])} AND ${b.value(s.between[1])}`;
    if (s?.lt !== undefined) keyExpr += ` AND ${b.name(skAttr)} < ${b.value(s.lt)}`;
    if (s?.le !== undefined) keyExpr += ` AND ${b.name(skAttr)} <= ${b.value(s.le)}`;
    if (s?.gt !== undefined) keyExpr += ` AND ${b.name(skAttr)} > ${b.value(s.gt)}`;
    if (s?.ge !== undefined) keyExpr += ` AND ${b.name(skAttr)} >= ${b.value(s.ge)}`;
    const filterExpr = q.filter ? b.cond(q.filter) : undefined;
    const out = await this.doc.send(
      new QueryCommand({
        TableName: table,
        IndexName: q.index,
        KeyConditionExpression: keyExpr,
        FilterExpression: filterExpr,
        ExpressionAttributeNames: b.attributeNames,
        ExpressionAttributeValues: b.attributeValues,
        Limit: q.limit,
        ExclusiveStartKey: decodeCursor(q.cursor),
        ScanIndexForward: q.forward ?? true,
        ConsistentRead: q.index ? undefined : q.consistent,
      }),
    );
    return { items: out.Items ?? [], cursor: encodeCursor(out.LastEvaluatedKey) };
  }

  async transact(ops: TxOp[]): Promise<void> {
    const items: NonNullable<TransactWriteCommandInput['TransactItems']> = ops.map((op) => {
      const b = new ExpressionBuilder();
      switch (op.kind) {
        case 'put': {
          const expr = op.cond ? b.cond(op.cond) : undefined;
          return { Put: { TableName: op.table, Item: op.item, ConditionExpression: expr, ExpressionAttributeNames: b.attributeNames, ExpressionAttributeValues: b.attributeValues } };
        }
        case 'update': {
          const u = b.update(op.update);
          const expr = op.cond ? b.cond(op.cond) : undefined;
          return { Update: { TableName: op.table, Key: { pk: op.key.pk, sk: op.key.sk }, UpdateExpression: u, ConditionExpression: expr, ExpressionAttributeNames: b.attributeNames, ExpressionAttributeValues: b.attributeValues } };
        }
        case 'delete': {
          const expr = op.cond ? b.cond(op.cond) : undefined;
          return { Delete: { TableName: op.table, Key: { pk: op.key.pk, sk: op.key.sk }, ConditionExpression: expr, ExpressionAttributeNames: b.attributeNames, ExpressionAttributeValues: b.attributeValues } };
        }
        case 'check': {
          const expr = b.cond(op.cond);
          return { ConditionCheck: { TableName: op.table, Key: { pk: op.key.pk, sk: op.key.sk }, ConditionExpression: expr, ExpressionAttributeNames: b.attributeNames, ExpressionAttributeValues: b.attributeValues } };
        }
      }
    });
    try {
      await this.doc.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (e) {
      const err = e as { name?: string; CancellationReasons?: { Code?: string }[] };
      if (err.name === 'TransactionCanceledException') throw new TransactionCanceledError((err.CancellationReasons ?? []).map((r) => r.Code ?? 'None'));
      throw e;
    }
  }
}
