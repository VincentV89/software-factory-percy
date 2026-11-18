import { describe, expect, it } from 'vitest';
import { ConditionFailedError, InMemoryKvStore, TransactionCanceledError, cond, queryAll } from '../src';

describe('InMemoryKvStore semantics (ADR-11 fake parity)', () => {
  it('conditional put and update', async () => {
    const kv = new InMemoryKvStore();
    await kv.put('t', { pk: 'a', sk: '1', status: 'PENDING' }, cond.itemAbsent());
    await expect(kv.put('t', { pk: 'a', sk: '1' }, cond.itemAbsent())).rejects.toBeInstanceOf(ConditionFailedError);
    const out = await kv.update('t', { pk: 'a', sk: '1' }, { set: { status: 'SENDING' }, add: { n: 2 } }, { cond: cond.eq('status', 'PENDING') });
    expect(out.old?.['status']).toBe('PENDING');
    expect(out.new).toMatchObject({ status: 'SENDING', n: 2 });
    await expect(kv.update('t', { pk: 'a', sk: '1' }, { set: { status: 'SENT' } }, { cond: cond.eq('status', 'PENDING') })).rejects.toBeInstanceOf(ConditionFailedError);
    await kv.update('t', { pk: 'a', sk: '1' }, { remove: ['n'], set: { x: undefined } });
    expect(await kv.get('t', { pk: 'a', sk: '1' })).toEqual({ pk: 'a', sk: '1', status: 'SENDING' });
  });

  it('evaluates every condition operator', async () => {
    const kv = new InMemoryKvStore();
    await kv.put('t', { pk: 'a', sk: '1', n: 5, s: 'b' });
    const ok = async (c: Parameters<typeof cond.and>[0]) => kv.update('t', { pk: 'a', sk: '1' }, {}, { cond: c }).then(() => true, () => false);
    expect(await ok(cond.lt('n', 6))).toBe(true);
    expect(await ok(cond.le('n', 5))).toBe(true);
    expect(await ok(cond.gt('n', 5))).toBe(false);
    expect(await ok(cond.ge('n', 5))).toBe(true);
    expect(await ok(cond.ne('missing', 1))).toBe(true);
    expect(await ok(cond.in('s', ['a', 'b']))).toBe(true);
    expect(await ok(cond.or(cond.eq('s', 'z'), cond.exists('n')))).toBe(true);
    expect(await ok(cond.not(cond.exists('n')))).toBe(false);
    expect(await ok(cond.lt('missing', 1))).toBe(false);
  });

  it('transactions are all-or-nothing and report reasons per op', async () => {
    const kv = new InMemoryKvStore();
    await kv.put('t', { pk: 'a', sk: '1' });
    try {
      await kv.transact([
        { kind: 'put', table: 't', item: { pk: 'b', sk: '1' } },
        { kind: 'put', table: 't', item: { pk: 'a', sk: '1' }, cond: cond.itemAbsent() },
      ]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TransactionCanceledError);
      expect((e as TransactionCanceledError).reasons).toEqual(['None', 'ConditionalCheckFailed']);
    }
    expect(await kv.get('t', { pk: 'b', sk: '1' })).toBeUndefined();
    await kv.transact([{ kind: 'check', table: 't', key: { pk: 'a', sk: '1' }, cond: cond.itemPresent() }, { kind: 'delete', table: 't', key: { pk: 'a', sk: '1' } }]);
    expect(await kv.get('t', { pk: 'a', sk: '1' })).toBeUndefined();
  });

  it('queries with sort-key conditions, sparse GSIs, filters and cursors', async () => {
    const kv = new InMemoryKvStore();
    for (let i = 0; i < 5; i++) await kv.put('t', { pk: 'p', sk: `R#${i}`, n: i, ...(i % 2 ? { gsi1pk: 'odd', gsi1sk: String(9 - i) } : {}) });
    await kv.put('t', { pk: 'p', sk: 'X' });
    expect((await kv.query('t', { pk: 'p', sk: { beginsWith: 'R#' } })).items).toHaveLength(5);
    expect((await kv.query('t', { pk: 'p', sk: { between: ['R#1', 'R#3'] } })).items.map((i) => i['n'])).toEqual([1, 2, 3]);
    expect((await kv.query('t', { pk: 'p', sk: { lt: 'R#2' } })).items).toHaveLength(2);
    expect((await kv.query('t', { pk: 'p', sk: { gt: 'R#3', le: 'R#4' } })).items).toHaveLength(1);
    expect((await kv.query('t', { pk: 'p', sk: { ge: 'R#4' }, forward: false })).items.map((i) => i['sk'])).toEqual(['X', 'R#4']);
    expect((await kv.query('t', { index: 'gsi1', pk: 'odd' })).items.map((i) => i['n'])).toEqual([3, 1]);
    expect((await kv.query('t', { pk: 'p', filter: cond.gt('n', 2) })).items).toHaveLength(2);
    const page1 = await kv.query('t', { pk: 'p', limit: 4 });
    expect(page1.items).toHaveLength(4);
    expect(page1.cursor).toBeDefined();
    expect((await queryAll(kv, 't', { pk: 'p', limit: 2 })).length).toBe(6);
    expect(await kv.batchGet('t', [{ pk: 'p', sk: 'R#0' }, { pk: 'p', sk: 'nope' }])).toHaveLength(1);
  });

  it('emits stream records with old and new images', async () => {
    const kv = new InMemoryKvStore();
    const records: { old?: unknown; new?: unknown }[] = [];
    kv.onChange('t', (r) => records.push({ old: r.oldImage?.['v'], new: r.newImage?.['v'] }));
    await kv.put('t', { pk: 'a', sk: '1', v: 1 });
    await kv.update('t', { pk: 'a', sk: '1' }, { set: { v: 2 } });
    await kv.delete('t', { pk: 'a', sk: '1' });
    expect(records).toEqual([{ old: undefined, new: 1 }, { old: 1, new: 2 }, { old: 2, new: undefined }]);
    expect(kv.scan('t')).toEqual([]);
  });
});
