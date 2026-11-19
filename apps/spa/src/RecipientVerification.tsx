import { useState } from 'react';
import { api } from './api';
import { ErrorBox, useLoad } from './components';
import { useMe } from './session';

interface VerificationPage {
  mode: 'ses-verified' | 'unrestricted';
  region?: string;
  checkedAt?: string;
  cursor?: string;
  items: { addrHash: string; email?: string; attrs: Record<string, string>; suppressed: boolean; verification: { allowed: boolean; status: string; identity?: string } }[];
}
const labels: Record<string, string> = {
  SIMULATOR: 'Simulator (allowed)', VERIFIED_EMAIL: 'Verified email', VERIFIED_DOMAIN: 'Verified domain',
  PENDING: 'Pending verification', FAILED: 'Verification failed', NOT_STARTED: 'Not started',
  TEMPORARY_FAILURE: 'Temporary failure', NOT_VERIFIED: 'Not verified',
};

export function RecipientVerificationPanel({ teamId, listId, version }: { teamId: string; listId: string; version?: string | number }) {
  const me = useMe();
  const [cursor, setCursor] = useState<string>();
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const result = useLoad(() => me.testingEnabled
    ? api<VerificationPage>('GET', `/api/contacts/teams/${teamId}/lists/${listId}/recipient-verification${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`)
    : Promise.resolve<VerificationPage>({ mode: 'unrestricted', items: [] }), [teamId, listId, version, cursor, me.testingEnabled]);
  if (!me.testingEnabled || result.data?.mode === 'unrestricted') return null;
  return <section className="card" data-testid="recipient-verification">
    <h2>SES recipient verification</h2>
    <p>Verified email addresses, addresses covered by a verified domain, and SES simulator addresses are allowed automatically. No Percy allow-list change or redeployment is needed.</p>
    <p>Statuses are checked in the sending region{result.data?.region ? ': ' + result.data.region : ''}. Sending checks SES again when the audience is frozen.</p>
    <button type="button" onClick={result.reload} data-testid="verification-refresh">Refresh SES status</button>
    {result.data?.checkedAt && <p className="muted">Last checked: {new Date(result.data.checkedAt).toLocaleString()}</p>}
    <ErrorBox error={result.error} testId="verification-error" />
    {!result.data && !result.error && <p role="status">Checking SES verification…</p>}
    {!!result.error && <p>Verification could not be displayed. Refresh or check your team access. Sending always uses a fresh SES check.</p>}
    {result.data && !result.error && <>
      {result.data.items.length === 0 ? <p>No recipients in this list yet. Upload a CSV to check verification.</p> : <div className="table-scroll"><table data-testid="verification-table">
        <thead><tr><th>Recipient / SES status</th><th>Attributes</th><th>Matched identity</th><th>Suppressed</th></tr></thead>
        <tbody>{result.data.items.map((member) => <tr key={member.addrHash} data-testid="verification-row">
          <td><span className="recipient-address">{member.email ?? 'Address unavailable'}</span><span className={'badge ' + (member.verification.allowed ? 'badge-completed' : 'badge-scanning')} data-testid="verification-status">{labels[member.verification.status] ?? 'Not verified'}</span></td>
          <td>{Object.entries(member.attrs).map(([key, value]) => key + '=' + value).join(', ')}</td>
          <td>{member.verification.identity ?? '—'}</td><td>{member.suppressed ? 'Yes — excluded' : 'No'}</td>
        </tr>)}</tbody>
      </table></div>}
      <div className="actions">
        {history.length > 0 && <button type="button" onClick={() => { setCursor(history[history.length - 1]); setHistory(history.slice(0, -1)); }}>Previous recipients</button>}
        {result.data.cursor && <button type="button" onClick={() => { setHistory([...history, cursor]); setCursor(result.data?.cursor); }}>Next recipients</button>}
      </div>
    </>}
    <p className="muted">For pending or unverified addresses, finish verification in Amazon SES in the region shown above, then refresh here. Signing in to Percy does not verify an address in SES. Verified status never overrides unsubscribe, bounce, complaint, or manual suppression.</p>
    {result.data?.region && result.data.region !== 'local' && <a href={'https://console.aws.amazon.com/ses/home?region=' + encodeURIComponent(result.data.region)} target="_blank" rel="noopener noreferrer">Open Amazon SES</a>}
    {result.data?.region === 'local' && <p className="muted">Local mode simulates SES statuses. The deployed dev instance reads real SES verification.</p>}
  </section>;
}
