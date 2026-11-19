import { describe, expect, it } from 'vitest';
import { parse } from 'csv-parse/sync';
import { makeFixtures } from '../src/testing/fixtures';

describe('browser test fixtures', () => {
  it('uses canonical EICAR bytes and unique simulator aliases across runs', () => {
    const first = makeFixtures('run1', 'me@percy.test');
    const second = makeFixtures('run2', 'me@percy.test');
    expect(Buffer.byteLength(first['eicar.csv'] ?? '')).toBe(68);
    expect(first['eicar.csv']?.startsWith('X5O!')).toBe(true);
    const rows = parse(first['mixed.csv'] ?? '', { columns: true }) as { email: string; name: string }[];
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.email.includes('@'))).toHaveLength(5);
    expect(new Set(rows.filter((r) => r.email.includes('@')).map((r) => r.email)).size).toBe(4);
    expect(second['mixed.csv']).not.toContain('+run1-');
    expect(parse(first['stop-120.csv'] ?? '', { columns: true })).toHaveLength(120);
  });
});
