import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorBox, useLoad } from '../components';
import { useMe } from '../session';

interface Agency {
  agencyId: string;
  name: string;
  status: string;
}

interface Team {
  teamId: string;
  name: string;
  tier: string;
  status: string;
}

/** Admin: agencies, teams, memberships and tiers (FR-TEN-01..05). */
export function AdminPage() {
  const me = useMe();
  const agencies = useLoad(() => api<{ items: Agency[] }>('GET', '/api/platform/agencies'), []);
  const [agencyName, setAgencyName] = useState('');
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<unknown>();
  const run = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
      agencies.reload();
    } catch (e) {
      setError(e);
    }
  };
  const createAgency = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api('POST', '/api/platform/agencies', { name: agencyName }).then(() => setAgencyName('')));
  };
  return (
    <section>
      <h1>Admin</h1>
      <ErrorBox error={error ?? agencies.error} />
      {me.platformAdmin && (
        <form onSubmit={createAgency} className="inline" data-testid="agency-form">
          <input placeholder="New agency name" value={agencyName} onChange={(e) => setAgencyName(e.target.value)} required data-testid="agency-form-name" />
          <button type="submit" data-testid="agency-form-submit">Create agency</button>
        </form>
      )}
      <ul data-testid="agency-list">
        {agencies.data?.items.map((a) => (
          <li key={a.agencyId}>
            <button type="button" className="link" onClick={() => setSelected(a.agencyId)} data-testid="agency-select">{a.name}</button> ({a.status})
            {me.platformAdmin && (
              <button type="button" onClick={() => void run(() => api('POST', `/api/platform/agencies/${a.agencyId}/${a.status === 'ACTIVE' ? 'suspend' : 'reinstate'}`, { reason: window.prompt('Reason') ?? '' }))} data-testid="agency-suspend-toggle">
                {a.status === 'ACTIVE' ? 'Suspend' : 'Reinstate'}
              </button>
            )}
          </li>
        ))}
      </ul>
      {selected && <AgencyTeams agencyId={selected} onError={setError} />}
    </section>
  );
}

function AgencyTeams({ agencyId, onError }: { agencyId: string; onError: (e: unknown) => void }) {
  const me = useMe();
  const teams = useLoad(() => api<{ items: Team[] }>('GET', `/api/platform/agencies/${agencyId}/teams`), [agencyId]);
  const [name, setName] = useState('');
  const [member, setMember] = useState({ teamId: '', email: '', approver: false });
  const [adminEmail, setAdminEmail] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      teams.reload();
    } catch (e) {
      onError(e);
    }
  };
  return (
    <div className="card" data-testid="agency-teams">
      <h2>Teams</h2>
      <form onSubmit={(e) => { e.preventDefault(); void run(() => api('POST', `/api/platform/agencies/${agencyId}/teams`, { name }).then(() => setName(''))); }} className="inline">
        <input placeholder="New team name" value={name} onChange={(e) => setName(e.target.value)} required data-testid="team-form-name" />
        <button type="submit" data-testid="team-form-submit">Create team</button>
      </form>
      <table>
        <thead><tr><th>Team</th><th>Tier</th><th>Status</th><th /></tr></thead>
        <tbody>
          {teams.data?.items.map((t) => (
            <tr key={t.teamId}>
              <td>{t.name}</td>
              <td>
                {me.platformAdmin ? (
                  <select value={t.tier} onChange={(e) => void run(() => api('PATCH', `/api/platform/teams/${t.teamId}`, { tier: e.target.value }))} data-testid="team-tier-select">
                    <option value="standard">standard</option>
                    <option value="bulk">bulk</option>
                  </select>
                ) : t.tier}
              </td>
              <td>{t.status}</td>
              <td>
                <button type="button" onClick={() => void run(() => api('POST', `/api/platform/teams/${t.teamId}/${t.status === 'ACTIVE' ? 'suspend' : 'reinstate'}`, { reason: window.prompt('Reason') ?? '' }))} data-testid="team-suspend-toggle">
                  {t.status === 'ACTIVE' ? 'Suspend' : 'Reinstate'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Add a member</h3>
      <form onSubmit={(e) => { e.preventDefault(); void run(() => api('PUT', `/api/platform/teams/${member.teamId}/members/${encodeURIComponent(member.email)}`, { roles: member.approver ? ['member', 'approver'] : ['member'] })); }} className="inline">
        <select value={member.teamId} onChange={(e) => setMember({ ...member, teamId: e.target.value })} required data-testid="member-form-team">
          <option value="">Team</option>
          {teams.data?.items.map((t) => <option key={t.teamId} value={t.teamId}>{t.name}</option>)}
        </select>
        <input type="email" placeholder="officer@agency.gov.sg" value={member.email} onChange={(e) => setMember({ ...member, email: e.target.value })} required data-testid="member-form-email" />
        <label className="check"><input type="checkbox" checked={member.approver} onChange={(e) => setMember({ ...member, approver: e.target.checked })} data-testid="member-form-approver" /> approver</label>
        <button type="submit" data-testid="member-form-submit">Save membership</button>
      </form>
      <h3>Agency admins</h3>
      <form onSubmit={(e) => { e.preventDefault(); void run(() => api('PUT', `/api/platform/agencies/${agencyId}/admins/${encodeURIComponent(adminEmail)}`)); }} className="inline">
        <input type="email" placeholder="admin@agency.gov.sg" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} required data-testid="agency-admin-email" />
        <button type="submit" data-testid="agency-admin-submit">Grant agency admin</button>
      </form>
    </div>
  );
}
