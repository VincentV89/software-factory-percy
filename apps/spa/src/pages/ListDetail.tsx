import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api } from '../api';
import { Empty, ErrorBox, StateBadge, formatTime, useLoad } from '../components';

interface ImportRecord {
  importId: string;
  status: string;
  reason?: string;
  counts?: { totalRows: number; imported: number; updated: number; duplicates: number; invalid: number; alreadySuppressed: number };
  invalidSample?: { row: number; reason: string }[];
  createdAt: string;
}

const FINAL = ['COMPLETED', 'FAILED', 'REJECTED_MALWARE'];

/** List detail with CSV upload through a presigned POST and import status (FR-CON-03..06). */
export function ListDetail() {
  const { teamId = '', listId = '' } = useParams();
  const navigate = useNavigate();
  const base = `/api/contacts/teams/${teamId}/lists/${listId}`;
  const [poll, setPoll] = useState<number>();
  const list = useLoad(() => api<{ name: string; memberCount: number; eligibleCount: number }>('GET', base), [base], poll);
  const imports = useLoad(() => api<{ items: ImportRecord[] }>('GET', `${base}/imports`), [base], poll);
  const members = useLoad(() => api<{ items: { addrHash: string; email?: string; attrs: Record<string, string>; suppressed: boolean }[] }>('GET', `${base}/members`), [base, list.data?.memberCount]);
  const [error, setError] = useState<unknown>();
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const running = imports.data?.items.some((i) => !FINAL.includes(i.status)) ?? false;
  useEffect(() => setPoll(running ? 2000 : undefined), [running]);

  const upload = async () => {
    const f = file.current?.files?.[0];
    if (!f) return;
    setError(undefined);
    setUploading(true);
    try {
      const created = await api<{ importId: string; upload: { url: string; fields: Record<string, string> } }>('POST', `${base}/imports`);
      const form = new FormData();
      for (const [k, v] of Object.entries(created.upload.fields)) form.append(k, v);
      form.append('file', f);
      const res = await fetch(created.upload.url, { method: 'POST', body: form });
      if (!res.ok) throw new Error(`Upload failed (${res.status}). Check the file is under 200 MB.`);
      if (file.current) file.current.value = '';
    } catch (e) {
      setError(e);
    } finally {
      setUploading(false);
      imports.reload();
      list.reload();
    }
  };

  const remove = async () => {
    try {
      await api('DELETE', base);
      navigate(`/teams/${teamId}/lists`);
    } catch (e) {
      setError(e);
    }
  };

  if (list.error) return <ErrorBox error={list.error} />;
  return (
    <section data-testid="list-detail">
      <h1>{list.data?.name}</h1>
      <p>Members: <span data-testid="list-member-count">{list.data?.memberCount ?? 0}</span> · Audience: <span data-testid="list-audience-count">{list.data?.eligibleCount ?? 0}</span></p>
      <div className="card">
        <h2>Upload a CSV</h2>
        <p className="muted">UTF-8, comma-separated, a header row with an <code>email</code> column and up to 20 other columns, up to 1,000,000 rows and 200 MB.</p>
        <input type="file" accept=".csv,text/csv" ref={file} data-testid="list-upload-input" />
        <button type="button" disabled={uploading} onClick={() => void upload()} data-testid="list-upload-button">Upload</button>
        <button type="button" className="link" onClick={() => { imports.reload(); list.reload(); }} data-testid="list-refresh">Refresh</button>
      </div>
      <ErrorBox error={error} />
      <h2>Imports</h2>
      {imports.data?.items.length === 0 && <Empty testId="imports-empty">No imports yet. Upload a CSV.</Empty>}
      {imports.data?.items.map((i, idx) => (
        <div key={i.importId} className="card" data-testid={idx === 0 ? 'import-latest' : 'import-older'}>
          <p>Import {formatTime(i.createdAt)}: <StateBadge state={i.status} testId={idx === 0 ? 'import-status' : undefined} /></p>
          {i.reason && <p className="error" data-testid={idx === 0 ? 'import-reason' : undefined}>{i.reason}</p>}
          {i.counts && i.status === 'COMPLETED' && (
            <ul className="counts" data-testid={idx === 0 ? 'import-summary' : undefined}>
              <li>Total rows: <span data-testid="import-total">{i.counts.totalRows}</span></li>
              <li>Imported: <span data-testid="import-imported">{i.counts.imported}</span></li>
              <li>Updated: <span data-testid="import-updated">{i.counts.updated}</span></li>
              <li>Duplicates: <span data-testid="import-duplicates">{i.counts.duplicates}</span></li>
              <li>Invalid: <span data-testid="import-invalid">{i.counts.invalid}</span></li>
              <li>Already suppressed: <span data-testid="import-suppressed">{i.counts.alreadySuppressed}</span></li>
            </ul>
          )}
          {i.invalidSample && i.invalidSample.length > 0 && (
            <p>
              Invalid rows: {i.invalidSample.map((r) => `row ${r.row} (${r.reason})`).join(', ')}{' '}
              <a href={`${base}/imports/${i.importId}/invalid-rows.csv`} data-testid="import-invalid-download">Download CSV</a>
            </p>
          )}
        </div>
      ))}
      <h2>Members</h2>
      {members.data?.items.length === 0 && <Empty testId="members-empty">This list has no members. Upload a CSV.</Empty>}
      {members.data && members.data.items.length > 0 && (
        <table data-testid="members-table">
          <thead><tr><th>Email</th><th>Attributes</th><th>Suppressed</th></tr></thead>
          <tbody>
            {members.data.items.map((m) => (
              <tr key={m.addrHash}><td>{m.email}</td><td>{Object.entries(m.attrs).map(([k, v]) => `${k}=${v}`).join(', ')}</td><td>{m.suppressed ? 'yes' : 'no'}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      <button type="button" className="danger" onClick={() => void remove()} data-testid="list-delete-button">Delete list</button>
    </section>
  );
}
