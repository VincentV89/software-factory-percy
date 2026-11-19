import { describe, expect, it } from 'vitest';
import { DEFAULT_CSV_LIMITS, checkHeader, checkRow, csvCell, isAllowed, isValidRow, missingFields } from '../src/domain/csv';

describe('CSV rules (FR-CON-02, FR-CON-03)', () => {
  it('requires an email column and valid, unique, unreserved names', () => {
    expect(checkHeader(['email', 'name'], DEFAULT_CSV_LIMITS)).toEqual({ emailIndex: 0, attributeColumns: [{ index: 1, name: 'name' }] });
    expect(checkHeader(['name'], DEFAULT_CSV_LIMITS)).toEqual({ error: expect.stringContaining('"email"') });
    expect(checkHeader([''], DEFAULT_CSV_LIMITS)).toEqual({ error: 'A header row is required.' });
    expect(checkHeader(['email', 'Name', 'name'], DEFAULT_CSV_LIMITS)).toEqual({ error: expect.stringContaining('more than once') });
    expect(checkHeader(['email', 'first name'], DEFAULT_CSV_LIMITS)).toEqual({ error: expect.stringContaining('not valid') });
    expect(checkHeader(['email', 'unsubscribe_url'], DEFAULT_CSV_LIMITS)).toEqual({ error: expect.stringContaining('reserved') });
  });

  it('names the attribute-column limit', () => {
    const header = ['email', ...Array.from({ length: 21 }, (_, i) => `c${i}`)];
    expect(checkHeader(header, DEFAULT_CSV_LIMITS)).toEqual({ error: 'The file has 21 attribute columns; the limit is 20.' });
  });

  it('normalises one address to one hash and flags bad rows', () => {
    const h = checkHeader(['email', 'name'], DEFAULT_CSV_LIMITS);
    if ('error' in h) throw new Error(h.error);
    const a = checkRow(['  Alice@Example.gov.sg ', 'A'], 1, h, 2);
    const b = checkRow(['alice@example.gov.sg', ''], 2, h, 2);
    expect(isValidRow(a) && isValidRow(b) && a.addrHash === b.addrHash).toBe(true);
    if (isValidRow(b)) expect(b.attrs).toEqual({});
    expect(checkRow(['not-an-email', 'x'], 3, h, 2)).toEqual({ row: 3, reason: 'email syntax is invalid' });
    expect(checkRow(['a@b.co'], 4, h, 2)).toEqual({ row: 4, reason: 'expected 2 columns, found 1' });
  });

  it('escapes CSV cells, matches allow-lists and missing fields', () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(7)).toBe('7');
    expect(isAllowed('x@simulator.amazonses.com', ['*@simulator.amazonses.com'])).toBe(true);
    expect(isAllowed('me@agency.gov.sg', ['Me@Agency.gov.sg'])).toBe(true);
    expect(isAllowed('x@gmail.com', ['*@simulator.amazonses.com'])).toBe(false);
    expect(missingFields({ name: ' ' }, ['name', 'email', 'unsubscribe_url', 'city'])).toEqual(['name', 'city']);
  });
});
