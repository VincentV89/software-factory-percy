import { addressHash, normaliseEmail } from '@percy/shared';

/** CSV limits (FR-CON-03, A17). */
export interface CsvLimits {
  maxBytes: number;
  maxRows: number;
  maxAttributeColumns: number;
}

export const DEFAULT_CSV_LIMITS: CsvLimits = { maxBytes: 200 * 1024 * 1024, maxRows: 1_000_000, maxAttributeColumns: 20 };

export const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED_FIELDS = new Set(['unsubscribe_url']);

export interface HeaderCheck {
  emailIndex: number;
  attributeColumns: { index: number; name: string }[];
}

/** Validates the header row; returns an error naming the broken limit or rule. */
export function checkHeader(header: string[], limits: CsvLimits): HeaderCheck | { error: string } {
  const names = header.map((h) => h.trim());
  if (names.length === 0 || names.every((n) => n === '')) return { error: 'A header row is required.' };
  const lower = names.map((n) => n.toLowerCase());
  const emailIndex = lower.indexOf('email');
  if (emailIndex < 0) return { error: 'The header row must contain an "email" column.' };
  const seen = new Set<string>();
  for (const n of lower) {
    if (seen.has(n)) return { error: `The column "${n}" appears more than once.` };
    seen.add(n);
  }
  const attributeColumns = names.map((name, index) => ({ index, name })).filter((c) => c.index !== emailIndex);
  if (attributeColumns.length > limits.maxAttributeColumns) return { error: `The file has ${attributeColumns.length} attribute columns; the limit is ${limits.maxAttributeColumns}.` };
  for (const c of attributeColumns) {
    if (!FIELD_NAME.test(c.name)) return { error: `The column name "${c.name}" is not valid; use letters, digits and underscores.` };
    if (RESERVED_FIELDS.has(c.name.toLowerCase())) return { error: `The column name "${c.name}" is reserved.` };
  }
  return { emailIndex, attributeColumns };
}

export interface ValidRow {
  row: number;
  email: string;
  addrHash: string;
  attrs: Record<string, string>;
}

export interface InvalidRow {
  row: number;
  reason: string;
}

export function checkRow(fields: string[], row: number, header: HeaderCheck, columnCount: number): ValidRow | InvalidRow {
  if (fields.length !== columnCount) return { row, reason: `expected ${columnCount} columns, found ${fields.length}` };
  const email = normaliseEmail(fields[header.emailIndex] ?? '');
  if (!email.ok) return { row, reason: email.error };
  const attrs: Record<string, string> = {};
  for (const c of header.attributeColumns) {
    const v = (fields[c.index] ?? '').trim();
    if (v !== '') attrs[c.name] = v;
  }
  return { row, email: email.value, addrHash: addressHash(email.value), attrs };
}

export function isValidRow(r: ValidRow | InvalidRow): r is ValidRow {
  return 'addrHash' in r;
}

/** Escape a value for a CSV cell. */
export function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Import row outcome classification (design 7.2). */
export type RowOutcome = 'imported' | 'updated' | 'duplicate';

export interface ImportCounts {
  totalRows: number;
  imported: number;
  updated: number;
  duplicates: number;
  invalid: number;
  alreadySuppressed: number;
}

export const emptyCounts = (): ImportCounts => ({ totalRows: 0, imported: 0, updated: 0, duplicates: 0, invalid: 0, alreadySuppressed: 0 });

/** Address allow-list match for the dev SES sandbox (NFR-INF-05). Patterns are exact or `*@domain`. */
export function isAllowed(email: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.startsWith('*@') ? email.endsWith(p.slice(1).toLowerCase()) : email === p.toLowerCase()));
}

/** Missing-field rule (FR-SCH-04): a required field with no non-empty value counts as missing. */
export function missingFields(attrs: Record<string, string>, required: string[]): string[] {
  return required.filter((f) => f !== 'email' && f !== 'unsubscribe_url' && !(attrs[f] ?? '').trim());
}
