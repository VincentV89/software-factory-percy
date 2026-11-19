import {
  ConditionFailedError,
  TransactionCanceledError,
  type Cond,
  type Item,
  type Key,
  type KvStore,
  type QueryInput,
  type QueryOutput,
  type StreamRecord,
  type TxOp,
  type Update,
} from './types';

type Listener = (record: StreamRecord) => void;

const keyOf = (k: Key): string => `${k.pk}\u0000${k.sk}`;
const clone = <T>(v: T): T => structuredClone(v);

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function evaluate(c: Cond, item: Item | undefined): boolean {
  const v = (attr: string): unknown => (item ? item[attr] : undefined);
  switch (c.op) {
    case 'exists':
      return v(c.attr) !== undefined;
    case 'notExists':
      return v(c.attr) === undefined;
    case 'eq':
      return v(c.attr) !== undefined && equal(v(c.attr), c.value);
    case 'ne':
      return !equal(v(c.attr), c.value);
    case 'lt':
      return v(c.attr) !== undefined && compare(v(c.attr), c.value) < 0;
    case 'le':
      return v(c.attr) !== undefined && compare(v(c.attr), c.value) <= 0;
    case 'gt':
      return v(c.attr) !== undefined && compare(v(c.attr), c.value) > 0;
    case 'ge':
      return v(c.attr) !== undefined && compare(v(c.attr), c.value) >= 0;
    case 'in':
      return c.values.some((x) => equal(v(c.attr), x));
    case 'and':
      return c.conds.every((x) => evaluate(x, item));
    case 'or':
      return c.conds.some((x) => evaluate(x, item));
    case 'not':
      return !evaluate(c.cond, item);
  }
}

export function applyUpdate(key: Key, existing: Item | undefined, update: Update): Item {
  const next: Item = existing ? clone(existing) : { pk: key.pk, sk: key.sk };
  for (const [k, value] of Object.entries(update.set ?? {})) {
    if (value === undefined) Reflect.deleteProperty(next, k);
    else next[k] = clone(value);
  }
  for (const [k, delta] of Object.entries(update.add ?? {})) {
    const current = typeof next[k] === 'number' ? (next[k] as number) : 0;
    next[k] = current + delta;
  }
  for (const k of update.remove ?? []) Reflect.deleteProperty(next, k);
  return next;
}

function skMatches(sk: unknown, q: QueryInput['sk']): boolean {
  if (!q) return true;
  if (sk === undefined) return false;
  if (q.beginsWith !== undefined && !String(sk).startsWith(q.beginsWith)) return false;
  if (q.lt !== undefined && !(compare(sk, q.lt) < 0)) return false;
  if (q.le !== undefined && !(compare(sk, q.le) <= 0)) return false;
  if (q.gt !== undefined && !(compare(sk, q.gt) > 0)) return false;
  if (q.ge !== undefined && !(compare(sk, q.ge) >= 0)) return false;
  if (q.between && !(compare(sk, q.between[0]) >= 0 && compare(sk, q.between[1]) <= 0)) return false;
  return true;
}

/** In-memory KvStore with DynamoDB-compatible condition, transaction and stream semantics. */
export class InMemoryKvStore implements KvStore {
  private tables = new Map<string, Map<string, Item>>();
  private listeners = new Map<string, Listener[]>();
  private seq = 0;
  /** Optional fault injection: called before each write; throw to simulate a failure. */
  beforeWrite?: (table: string, key: Key) => void;

  private table(name: string): Map<string, Item> {
    let t = this.tables.get(name);
    if (!t) {
      t = new Map();
      this.tables.set(name, t);
    }
    return t;
  }

  onChange(table: string, listener: Listener): void {
    const list = this.listeners.get(table) ?? [];
    list.push(listener);
    this.listeners.set(table, list);
  }

  private emit(table: string, key: Key, oldImage: Item | undefined, newImage: Item | undefined): void {
    const record: StreamRecord = { table, seq: ++this.seq, key, oldImage: oldImage && clone(oldImage), newImage: newImage && clone(newImage) };
    for (const l of this.listeners.get(table) ?? []) l(record);
  }

  /** All items in a table (test helper). */
  scan(table: string): Item[] {
    return [...this.table(table).values()].map(clone);
  }

  async get(table: string, key: Key): Promise<Item | undefined> {
    await Promise.resolve();
    const item = this.table(table).get(keyOf(key));
    return item && clone(item);
  }

  async batchGet(table: string, keys: Key[]): Promise<Item[]> {
    await Promise.resolve();
    return keys.map((k) => this.table(table).get(keyOf(k))).filter((x): x is Item => !!x).map(clone);
  }

  async put(table: string, item: Item, c?: Cond): Promise<void> {
    await Promise.resolve();
    const key = { pk: String(item['pk']), sk: String(item['sk']) };
    this.beforeWrite?.(table, key);
    const existing = this.table(table).get(keyOf(key));
    if (c && !evaluate(c, existing)) throw new ConditionFailedError(table, key);
    this.table(table).set(keyOf(key), clone(item));
    this.emit(table, key, existing, item);
  }

  async update(table: string, key: Key, update: Update, opts?: { cond?: Cond }): Promise<{ old?: Item; new: Item }> {
    await Promise.resolve();
    this.beforeWrite?.(table, key);
    const existing = this.table(table).get(keyOf(key));
    if (opts?.cond && !evaluate(opts.cond, existing)) throw new ConditionFailedError(table, key);
    const next = applyUpdate(key, existing, update);
    this.table(table).set(keyOf(key), next);
    this.emit(table, key, existing, next);
    return { old: existing && clone(existing), new: clone(next) };
  }

  async delete(table: string, key: Key, c?: Cond): Promise<Item | undefined> {
    await Promise.resolve();
    this.beforeWrite?.(table, key);
    const existing = this.table(table).get(keyOf(key));
    if (c && !evaluate(c, existing)) throw new ConditionFailedError(table, key);
    if (existing) {
      this.table(table).delete(keyOf(key));
      this.emit(table, key, existing, undefined);
    }
    return existing && clone(existing);
  }

  async query(table: string, q: QueryInput): Promise<QueryOutput> {
    await Promise.resolve();
    const pkAttr = q.index ? `${q.index}pk` : 'pk';
    const skAttr = q.index ? `${q.index}sk` : 'sk';
    const all = [...this.table(table).values()]
      .filter((i) => i[pkAttr] === q.pk && skMatches(i[skAttr], q.sk))
      .sort((a, b) => compare(a[skAttr], b[skAttr]) || compare(a['pk'], b['pk']) || compare(a['sk'], b['sk']));
    if (q.forward === false) all.reverse();
    let start = 0;
    if (q.cursor) {
      const last = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as Key;
      const idx = all.findIndex((i) => i['pk'] === last.pk && i['sk'] === last.sk);
      start = idx + 1;
    }
    const limit = q.limit ?? Number.POSITIVE_INFINITY;
    const page = all.slice(start, start + limit);
    const more = start + page.length < all.length;
    const lastItem = page[page.length - 1];
    const filtered = q.filter ? page.filter((i) => evaluate(q.filter as Cond, i)) : page;
    return {
      items: filtered.map(clone),
      cursor: more && lastItem ? Buffer.from(JSON.stringify({ pk: lastItem['pk'], sk: lastItem['sk'] })).toString('base64url') : undefined,
    };
  }

  async transact(ops: TxOp[]): Promise<void> {
    await Promise.resolve();
    if (ops.length > 100) throw new Error('transaction exceeds 100 items');
    const reasons = ops.map((op) => {
      const key = op.kind === 'put' ? { pk: String(op.item['pk']), sk: String(op.item['sk']) } : op.key;
      const existing = this.table(op.table).get(keyOf(key));
      return op.cond && !evaluate(op.cond, existing) ? 'ConditionalCheckFailed' : 'None';
    });
    if (reasons.some((r) => r !== 'None')) throw new TransactionCanceledError(reasons);
    for (const op of ops) {
      const key = op.kind === 'put' ? { pk: String(op.item['pk']), sk: String(op.item['sk']) } : op.key;
      this.beforeWrite?.(op.table, key);
    }
    for (const op of ops) {
      if (op.kind === 'check') continue;
      const key = op.kind === 'put' ? { pk: String(op.item['pk']), sk: String(op.item['sk']) } : op.key;
      const existing = this.table(op.table).get(keyOf(key));
      if (op.kind === 'put') {
        this.table(op.table).set(keyOf(key), clone(op.item));
        this.emit(op.table, key, existing, op.item);
      } else if (op.kind === 'update') {
        const next = applyUpdate(key, existing, op.update);
        this.table(op.table).set(keyOf(key), next);
        this.emit(op.table, key, existing, next);
      } else if (existing) {
        this.table(op.table).delete(keyOf(key));
        this.emit(op.table, key, existing, undefined);
      }
    }
  }
}
