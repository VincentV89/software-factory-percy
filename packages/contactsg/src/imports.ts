import { parse } from 'csv-parse/sync';
import { NotFound, cond, isConditionFailure, makeEvent, newId, outboxPut, queryAll, type Item } from '@percy/shared';
import { CONTACTSG_SOURCE, KvSuppressionReader } from '@percy/contactsg-contract';
import { checkHeader, checkRow, csvCell, emptyCounts, isValidRow, type ImportCounts, type InvalidRow, type ValidRow } from './domain/csv';
import type { ContactSgDeps } from './deps';
import { contactKey, memberPk, ListService } from './lists';

export type ImportStatus = 'UPLOADED' | 'SCANNING' | 'VALIDATING' | 'IMPORTING' | 'COMPLETED' | 'FAILED' | 'REJECTED_MALWARE';
export const FINAL_IMPORT_STATES: ImportStatus[] = ['COMPLETED', 'FAILED', 'REJECTED_MALWARE'];

export interface ImportRecord {
  importId: string;
  teamId: string;
  listId: string;
  agencyId: string;
  status: ImportStatus;
  counts?: ImportCounts;
  invalidSample?: InvalidRow[];
  reason?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChunkResult {
  imported: number;
  updated: number;
  duplicates: number;
  alreadySuppressed: number;
  /** Net additions to list counters. */
  memberDelta: number;
  eligibleDelta: number;
}

export interface ImportRef {
  agencyId: string;
  teamId: string;
  listId: string;
  importId: string;
}

const importKey = (r: Pick<ImportRef, 'teamId' | 'listId' | 'importId'>) => ({ pk: `TEAM#${r.teamId}#LIST#${r.listId}`, sk: `IMPORT#${r.importId}` });
export const rawKey = (r: ImportRef): string => `raw/${r.agencyId}/${r.teamId}/${r.listId}/${r.importId}.csv`;

export function parseRawKey(key: string): ImportRef | undefined {
  const m = /^raw\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\.csv$/.exec(key);
  if (!m) return undefined;
  return { agencyId: m[1] ?? '', teamId: m[2] ?? '', listId: m[3] ?? '', importId: m[4] ?? '' };
}

function toImport(i: Item): ImportRecord {
  return {
    importId: String(i['importId']),
    teamId: String(i['teamId']),
    listId: String(i['listId']),
    agencyId: String(i['agencyId']),
    status: i['status'] as ImportStatus,
    counts: i['counts'] as ImportCounts | undefined,
    invalidSample: i['invalidSample'] as InvalidRow[] | undefined,
    reason: i['reason'] as string | undefined,
    createdBy: String(i['createdBy']),
    createdAt: String(i['createdAt']),
    updatedAt: String(i['updatedAt']),
  };
}

export class ImportService {
  private readonly lists: ListService;
  private readonly suppressions: KvSuppressionReader;

  constructor(private readonly d: ContactSgDeps) {
    this.lists = new ListService(d);
    this.suppressions = new KvSuppressionReader(d.kv, d.tables.suppressions);
  }

  private iso(): string {
    return new Date(this.d.clock.now()).toISOString();
  }

  /** POST …/imports: creates the import (UPLOADED) and a presigned POST limited to the size cap. */
  async create(teamId: string, listId: string, officerId: string): Promise<{ importId: string; upload: { url: string; fields: Record<string, string> } }> {
    const list = await this.lists.get(teamId, listId);
    const ref: ImportRef = { agencyId: list.agencyId, teamId, listId, importId: newId(this.d.clock.now()) };
    const now = this.iso();
    await this.d.kv.put(this.d.tables.imports, { ...importKey(ref), ...ref, status: 'UPLOADED', createdBy: officerId, createdAt: now, updatedAt: now });
    const upload = await this.d.signer.presignPost(this.d.buckets.uploads, rawKey(ref), this.d.config.limits.maxBytes, this.d.config.uploadUrlTtlSeconds);
    return { importId: ref.importId, upload };
  }

  async get(teamId: string, listId: string, importId: string): Promise<ImportRecord> {
    const i = await this.d.kv.get(this.d.tables.imports, importKey({ teamId, listId, importId }));
    if (!i) throw new NotFound('Import not found.');
    return toImport(i);
  }

  async listForList(teamId: string, listId: string): Promise<ImportRecord[]> {
    const items = await queryAll(this.d.kv, this.d.tables.imports, { pk: `TEAM#${teamId}#LIST#${listId}`, sk: { beginsWith: 'IMPORT#' } });
    return items.map(toImport).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async setStatus(ref: ImportRef, status: ImportStatus, from: ImportStatus[], extra: Record<string, unknown> = {}): Promise<boolean> {
    try {
      await this.d.kv.update(this.d.tables.imports, importKey(ref), { set: { status, updatedAt: this.iso(), ...extra } }, { cond: cond.in('status', from) });
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  }

  /** S3 Object Created on raw/: the scan is now in progress (FR-CON-04 AC2). */
  async onObjectCreated(key: string): Promise<void> {
    const ref = parseRawKey(key);
    if (ref) await this.setStatus(ref, 'SCANNING', ['UPLOADED']);
  }

  /** GuardDuty Malware Protection result. Only NO_THREATS_FOUND starts the import. */
  async onScanResult(key: string, result: string, requestId: string): Promise<void> {
    const ref = parseRawKey(key);
    if (!ref) return;
    const rec = await this.get(ref.teamId, ref.listId, ref.importId).catch(() => undefined);
    if (!rec || FINAL_IMPORT_STATES.includes(rec.status)) return;
    if (result === 'NO_THREATS_FOUND') {
      if (await this.setStatus(ref, 'VALIDATING', ['UPLOADED', 'SCANNING'])) {
        await this.d.workflows.start(this.d.importStateMachine, `import-${ref.importId}`, ref);
      }
      return;
    }
    // THREATS_FOUND or any non-clean result: quarantine, never parse.
    const body = await this.d.store.get(this.d.buckets.uploads, key);
    if (body) await this.d.store.put(this.d.buckets.uploads, `quarantine/${ref.importId}.csv`, body);
    await this.d.store.delete(this.d.buckets.uploads, key);
    const reason = result === 'THREATS_FOUND' ? 'Malware was detected in the file.' : `The file could not be scanned (${result}).`;
    await this.setStatus(ref, 'REJECTED_MALWARE', ['UPLOADED', 'SCANNING', 'VALIDATING'], { reason });
    await this.d.audit.record({ actor: rec.createdBy, agencyId: ref.agencyId, teamId: ref.teamId, action: 'import.result', targetType: 'import', targetId: ref.importId, outcome: 'denied', requestId, reason: 'REJECTED_MALWARE' });
  }

  /**
   * Validate step: one pass over the CSV. Limit breaches fail the import before any write.
   * Valid rows go to JSONL chunks; the first 100 invalid rows are kept with reasons.
   */
  async validate(ref: ImportRef): Promise<{ chunkKeys: string[] } | { failed: string }> {
    const limits = this.d.config.limits;
    const body = await this.d.store.get(this.d.buckets.uploads, rawKey(ref));
    if (!body) return { failed: 'The uploaded file was not found.' };
    if (body.byteLength > limits.maxBytes) return { failed: `The file is larger than the ${Math.round(limits.maxBytes / 1024 / 1024)} MB limit.` };
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body).replace(/^\uFEFF/, '');
    } catch {
      return { failed: 'The file is not valid UTF-8.' };
    }
    let records: string[][];
    try {
      records = parse(text, { relax_column_count: true, skip_empty_lines: true, bom: true }) as string[][];
    } catch (e) {
      return { failed: `The file is not valid comma-separated CSV (${(e as Error).message.split('\n')[0] ?? 'parse error'}).` };
    }
    const [header, ...rows] = records;
    if (!header) return { failed: 'A header row is required.' };
    const h = checkHeader(header, limits);
    if ('error' in h) return { failed: h.error };
    if (rows.length > limits.maxRows) return { failed: `The file has ${rows.length} data rows; the limit is ${limits.maxRows.toLocaleString('en')}.` };

    const valid: ValidRow[] = [];
    const invalid: InvalidRow[] = [];
    rows.forEach((fields, idx) => {
      const r = checkRow(fields, idx + 1, h, header.length);
      if (isValidRow(r)) valid.push(r);
      else invalid.push(r);
    });
    const chunkKeys: string[] = [];
    for (let i = 0; i < valid.length; i += this.d.config.chunkSize) {
      const key = `chunks/${ref.importId}/${String(chunkKeys.length).padStart(5, '0')}.jsonl`;
      await this.d.store.put(this.d.buckets.uploads, key, valid.slice(i, i + this.d.config.chunkSize).map((r) => JSON.stringify(r)).join('\n'));
      chunkKeys.push(key);
    }
    const sample = invalid.slice(0, 100);
    const csv = ['row,reason', ...sample.map((r) => `${r.row},${csvCell(r.reason)}`)].join('\n');
    await this.d.store.put(this.d.buckets.uploads, `chunks/${ref.importId}/invalid-rows.csv`, csv, { contentType: 'text/csv' });
    const counts = { ...emptyCounts(), totalRows: rows.length, invalid: invalid.length };
    await this.setStatus(ref, 'IMPORTING', ['VALIDATING'], { counts, invalidSample: sample });
    return { chunkKeys };
  }

  /** Import one chunk; safe to retry (row outcome is stored on the membership). */
  async importChunk(ref: ImportRef, chunkKey: string): Promise<ChunkResult> {
    const body = await this.d.store.get(this.d.buckets.uploads, chunkKey);
    if (!body) throw new Error(`chunk ${chunkKey} missing`);
    const rows = Buffer.from(body).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ValidRow);
    const result: ChunkResult = { imported: 0, updated: 0, duplicates: 0, alreadySuppressed: 0, memberDelta: 0, eligibleDelta: 0 };
    for (const row of rows) await this.importRow(ref, row, result);
    return result;
  }

  private async importRow(ref: ImportRef, row: ValidRow, result: ChunkResult, attempt = 0): Promise<void> {
    const { kv, tables } = this.d;
    const key = { pk: memberPk(ref.teamId, ref.listId), sk: `MEMBER#${row.addrHash}` };
    const old = await kv.get(tables.contacts, key, { consistent: true });
    if (old && old['importId'] === ref.importId) {
      if (old['importRow'] === row.row) {
        // Retry of this exact row: reuse the stored outcome so chunk results stay identical.
        const outcome = old['importOutcome'] as 'imported' | 'updated';
        this.count(result, outcome, old['importSuppressed'] === true, old['importNew'] === true, Number(old['importEligibleDelta'] ?? 0));
      } else {
        result.duplicates++;
      }
      return;
    }
    const suppressed = (await this.suppressions.isSuppressed(row.addrHash, ref.agencyId)) || old?.['suppressed'] === true;
    await kv.put(tables.contacts, { ...contactKey(ref.agencyId, row.addrHash), email: row.email }, cond.itemAbsent()).catch((e: unknown) => {
      if (!isConditionFailure(e)) throw e;
    });
    const outcome = old ? 'updated' : 'imported';
    const wasEligible = old ? old['suppressed'] !== true : false;
    try {
      await kv.update(
        tables.contacts,
        key,
        {
          set: {
            addrHash: row.addrHash,
            attrs: row.attrs,
            suppressed,
            agencyId: ref.agencyId,
            teamId: ref.teamId,
            listId: ref.listId,
            importId: ref.importId,
            importRow: row.row,
            importOutcome: outcome,
            importSuppressed: suppressed,
            importNew: !old,
            importEligibleDelta: (suppressed ? 0 : 1) - (old ? (wasEligible ? 1 : 0) : 0),
            gsi1pk: `ADDR#${row.addrHash}`,
            gsi1sk: `${ref.agencyId}#${ref.teamId}#${ref.listId}`,
          },
        },
        { cond: old ? cond.eq('importId', old['importId']) : cond.itemAbsent() },
      );
    } catch (e) {
      if (isConditionFailure(e) && attempt < 2) return this.importRow(ref, row, result, attempt + 1);
      throw e;
    }
    this.count(result, outcome, suppressed, !old, (suppressed ? 0 : 1) - (old ? (wasEligible ? 1 : 0) : 0));
  }

  private count(result: ChunkResult, outcome: 'imported' | 'updated', suppressed: boolean, isNew: boolean, eligibleDelta?: number): void {
    if (outcome === 'imported') result.imported++;
    else result.updated++;
    if (suppressed) result.alreadySuppressed++;
    if (isNew) result.memberDelta++;
    result.eligibleDelta += eligibleDelta ?? (isNew && !suppressed ? 1 : 0);
  }

  /** Sum chunk results, adjust list counters, COMPLETED + ImportCompleted in one transaction. */
  async summarise(ref: ImportRef, results: ChunkResult[], requestId = 'import'): Promise<ImportRecord> {
    const rec = await this.get(ref.teamId, ref.listId, ref.importId);
    if (rec.status === 'COMPLETED') return rec;
    const counts: ImportCounts = { ...(rec.counts ?? emptyCounts()) };
    let memberDelta = 0;
    let eligibleDelta = 0;
    for (const r of results) {
      counts.imported += r.imported;
      counts.updated += r.updated;
      counts.duplicates += r.duplicates;
      counts.alreadySuppressed += r.alreadySuppressed;
      memberDelta += r.memberDelta;
      eligibleDelta += r.eligibleDelta;
    }
    const now = this.d.clock.now();
    await this.d.kv.transact([
      { kind: 'update', table: this.d.tables.imports, key: importKey(ref), update: { set: { status: 'COMPLETED', counts, updatedAt: this.iso() } }, cond: cond.eq('status', 'IMPORTING') },
      { kind: 'update', table: this.d.tables.contacts, key: { pk: `TEAM#${ref.teamId}`, sk: `LIST#${ref.listId}` }, update: { add: { memberCount: memberDelta, eligibleCount: eligibleDelta }, set: { updatedAt: this.iso() } } },
      outboxPut(this.d.tables.outbox, makeEvent(CONTACTSG_SOURCE, 'ImportCompleted', { importId: ref.importId, teamId: ref.teamId, listId: ref.listId, status: 'COMPLETED' }, now), Math.floor(now / 1000)),
    ]);
    await this.d.audit.record({ actor: rec.createdBy, agencyId: ref.agencyId, teamId: ref.teamId, action: 'import.result', targetType: 'import', targetId: ref.importId, outcome: 'success', requestId, detail: { imported: counts.imported, invalid: counts.invalid } });
    return { ...rec, status: 'COMPLETED', counts };
  }

  async fail(ref: ImportRef, reason: string, requestId = 'import'): Promise<void> {
    const changed = await this.setStatus(ref, 'FAILED', ['UPLOADED', 'SCANNING', 'VALIDATING', 'IMPORTING'], { reason });
    if (!changed) return;
    const rec = await this.get(ref.teamId, ref.listId, ref.importId);
    await this.d.audit.record({ actor: rec.createdBy, agencyId: ref.agencyId, teamId: ref.teamId, action: 'import.result', targetType: 'import', targetId: ref.importId, outcome: 'error', requestId, reason: reason.slice(0, 200) });
  }

  async invalidRowsCsv(teamId: string, listId: string, importId: string): Promise<string> {
    await this.get(teamId, listId, importId);
    const body = await this.d.store.get(this.d.buckets.uploads, `chunks/${importId}/invalid-rows.csv`);
    return body ? Buffer.from(body).toString('utf8') : 'row,reason';
  }

  /** In-process equivalent of the import state machine, used locally and in tests. */
  async runWorkflow(ref: ImportRef): Promise<void> {
    try {
      const v = await this.validate(ref);
      if ('failed' in v) return await this.fail(ref, v.failed);
      const results: ChunkResult[] = [];
      for (const key of v.chunkKeys) results.push(await this.importChunk(ref, key));
      await this.summarise(ref, results);
    } catch (e) {
      this.d.logger.error('import failed', { importId: ref.importId, error: e as Error });
      await this.fail(ref, 'The import failed unexpectedly. Please upload the file again.');
    }
  }
}

