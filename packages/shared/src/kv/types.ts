/**
 * KvStore: the narrow slice of DynamoDB semantics Percy relies on (ADR-11).
 * Repositories are written once against this port; InMemoryKvStore implements the same
 * condition, transaction, GSI and TTL-free semantics for local tests, DynamoKvStore
 * translates to DynamoDB expressions.
 *
 * Conventions: every item has string `pk` and `sk`. A GSI named `gsiN` is keyed by the
 * attributes `gsiNpk` / `gsiNsk`; items without `gsiNpk` are absent from the index (sparse).
 */
export type Item = Record<string, unknown>;

export interface Key {
  pk: string;
  sk: string;
}

export type Cond =
  | { op: 'exists' | 'notExists'; attr: string }
  | { op: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge'; attr: string; value: unknown }
  | { op: 'in'; attr: string; values: unknown[] }
  | { op: 'and' | 'or'; conds: Cond[] }
  | { op: 'not'; cond: Cond };

export const cond = {
  exists: (attr: string): Cond => ({ op: 'exists', attr }),
  notExists: (attr: string): Cond => ({ op: 'notExists', attr }),
  itemAbsent: (): Cond => ({ op: 'notExists', attr: 'pk' }),
  itemPresent: (): Cond => ({ op: 'exists', attr: 'pk' }),
  eq: (attr: string, value: unknown): Cond => ({ op: 'eq', attr, value }),
  ne: (attr: string, value: unknown): Cond => ({ op: 'ne', attr, value }),
  lt: (attr: string, value: unknown): Cond => ({ op: 'lt', attr, value }),
  le: (attr: string, value: unknown): Cond => ({ op: 'le', attr, value }),
  gt: (attr: string, value: unknown): Cond => ({ op: 'gt', attr, value }),
  ge: (attr: string, value: unknown): Cond => ({ op: 'ge', attr, value }),
  in: (attr: string, values: unknown[]): Cond => ({ op: 'in', attr, values }),
  and: (...conds: Cond[]): Cond => ({ op: 'and', conds }),
  or: (...conds: Cond[]): Cond => ({ op: 'or', conds }),
  not: (c: Cond): Cond => ({ op: 'not', cond: c }),
};

export interface Update {
  set?: Record<string, unknown>;
  /** Numeric increment; a missing attribute counts as 0. */
  add?: Record<string, number>;
  remove?: string[];
}

export interface SkCondition {
  beginsWith?: string;
  lt?: string | number;
  le?: string | number;
  gt?: string | number;
  ge?: string | number;
  between?: [string | number, string | number];
}

export interface QueryInput {
  index?: string;
  pk: string;
  sk?: SkCondition;
  limit?: number;
  cursor?: string;
  forward?: boolean;
  filter?: Cond;
  consistent?: boolean;
}

export interface QueryOutput {
  items: Item[];
  cursor?: string;
}

export type TxOp =
  | { kind: 'put'; table: string; item: Item; cond?: Cond }
  | { kind: 'update'; table: string; key: Key; update: Update; cond?: Cond }
  | { kind: 'delete'; table: string; key: Key; cond?: Cond }
  | { kind: 'check'; table: string; key: Key; cond: Cond };

export class ConditionFailedError extends Error {
  constructor(readonly table: string, readonly key: Key) {
    super(`condition failed on ${table} ${key.pk}/${key.sk}`);
    this.name = 'ConditionFailedError';
  }
}

export class TransactionCanceledError extends Error {
  /** One entry per op: 'None' or 'ConditionalCheckFailed' (or another Dynamo code). */
  constructor(readonly reasons: string[]) {
    super(`transaction canceled: ${reasons.join(',')}`);
    this.name = 'TransactionCanceledError';
  }
  get conditionFailed(): boolean {
    return this.reasons.includes('ConditionalCheckFailed');
  }
}

export interface StreamRecord {
  table: string;
  seq: number;
  key: Key;
  oldImage?: Item;
  newImage?: Item;
}

export interface KvStore {
  get(table: string, key: Key, opts?: { consistent?: boolean }): Promise<Item | undefined>;
  batchGet(table: string, keys: Key[]): Promise<Item[]>;
  put(table: string, item: Item, cond?: Cond): Promise<void>;
  update(table: string, key: Key, update: Update, opts?: { cond?: Cond }): Promise<{ old?: Item; new: Item }>;
  delete(table: string, key: Key, cond?: Cond): Promise<Item | undefined>;
  query(table: string, input: QueryInput): Promise<QueryOutput>;
  transact(ops: TxOp[]): Promise<void>;
}

/** Query every page. Use only where the result set is known to be bounded. */
export async function queryAll(store: KvStore, table: string, input: QueryInput): Promise<Item[]> {
  const out: Item[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.query(table, { ...input, cursor });
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return out;
}

export function isConditionFailure(e: unknown): boolean {
  return e instanceof ConditionFailedError || (e instanceof TransactionCanceledError && e.conditionFailed);
}
