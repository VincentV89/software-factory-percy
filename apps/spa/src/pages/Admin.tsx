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
      {me.platformAdmin && <OfficerInvitation />}
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
      {selected && <AgencyTeams key={selected} agencyId={selected} onError={setError} />}
      {selected && <AgencySuppression key={'suppression-' + selected} agencyId={selected} />}
    </section>
  );
}

function AgencyTeams({ agencyId, onError }: { agencyId: string; onError: (e: unknown) => void }) {
  const me = useMe();
  const teams = useLoad(() => api<{ items: Team[] }>('GET', `/api/platform/agencies/${agencyId}/teams`), [agencyId]);
  const [name, setName] = useState('');
  const [member, setMember] = useState({ teamId: '', email: '', approver: false });
  const [adminEmail, setAdminEmail] = useState('');
  const [memberVersion, setMemberVersion] = useState(0);
  const [notice, setNotice] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      teams.reload();
      setMemberVersion((v) => v + 1);
      setNotice('Changes saved.');
    } catch (e) {
      onError(e);
    }
  };
  return (
    <div className="card" data-testid="agency-teams">
      <h2>Teams</h2>
      {notice && <p className="notice" role="status">{notice}</p>}
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
      {member.teamId && <TeamMembers teamId={member.teamId} version={memberVersion} />}
      <h3>Agency admins</h3>
      <form onSubmit={(e) => { e.preventDefault(); void run(() => api('PUT', `/api/platform/agencies/${agencyId}/admins/${encodeURIComponent(adminEmail)}`)); }} className="inline">
        <input type="email" placeholder="admin@agency.gov.sg" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} required data-testid="agency-admin-email" />
        <button type="submit" data-testid="agency-admin-submit">Grant agency admin</button>
        <button type="button" className="danger" onClick={() => {
          if (adminEmail && window.confirm(`Revoke agency-admin access for ${adminEmail}?`)) {
            void run(() => api('DELETE', `/api/platform/agencies/${agencyId}/admins/${encodeURIComponent(adminEmail)}`));
          }
        }} data-testid="agency-admin-revoke">Revoke agency admin</button>
      </form>
    </div>
  );
}

function OfficerInvitation() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<unknown>();
  const invite = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(undefined); setNotice('');
    try {
      const result = await api<{ delivery: 'email' | 'local' }>('POST', '/api/platform/officer-invitations', { email });
      setNotice(result.delivery === 'local' ? `Local login ready for ${email}; no email was sent. Grant access below, then use local sign-in.` : `Invitation sent to ${email}. Grant team membership or agency-admin access below.`);
      setEmail('');
    } catch (err) { setError(err); }
    finally { setBusy(false); }
  };
  return <form className="card" onSubmit={(e) => void invite(e)}>
    <h2>Invite an officer</h2>
    <p>Send a login invitation and temporary password by email. Invitations do not grant access to any team.</p>
    <label>Email <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} data-testid="invite-email" /></label>
    <button type="submit" disabled={busy} data-testid="invite-submit">{busy ? 'Sending…' : 'Email login invitation'}</button>
    {notice && <p className="notice" role="status" data-testid="invite-notice">{notice}</p>}
    <ErrorBox error={error} />
  </form>;
}

function TeamMembers({ teamId, version }: { teamId: string; version: number }) {
  const members = useLoad(() => api<{ items: { officerId: string; email?: string; roles: string[] }[] }>('GET', `/api/platform/teams/${teamId}/members`), [teamId, version]);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState('');
  const update = async (email: string, roles?: string[]) => {
    setBusy(email); setError(undefined);
    try {
      await api(roles ? 'PUT' : 'DELETE', `/api/platform/teams/${teamId}/members/${encodeURIComponent(email)}`, roles ? { roles } : undefined);
      members.reload();
    } catch (err) { setError(err); }
    finally { setBusy(''); }
  };
  return <section data-testid="team-members">
    <h3>Team members</h3>
    <button type="button" className="link" onClick={members.reload}>Refresh members</button>
    <ErrorBox error={error ?? members.error} />
    {members.data?.items.length === 0 && <p>No members in this team.</p>}
    <table><thead><tr><th>Officer</th><th>Roles</th><th>Actions</th></tr></thead><tbody>
      {members.data?.items.map((member) => <tr key={member.officerId} data-testid="team-member-row">
        <td>{member.email ?? member.officerId}</td><td>{member.roles.join(', ')}</td>
        <td>{member.email && <div className="actions">
          <button type="button" disabled={!!busy} onClick={() => void update(member.email ?? '', member.roles.includes('approver') ? ['member'] : ['member', 'approver'])}>
            {member.roles.includes('approver') ? 'Remove approver role' : 'Make approver'}
          </button>
          <button type="button" className="danger" disabled={!!busy} onClick={() => {
            if (window.confirm(`Remove ${member.email} from this team? Their next request will lose team access.`)) void update(member.email ?? '');
          }}>Remove member</button>
        </div>}</td>
      </tr>)}
    </tbody></table>
  </section>;
}

function AgencySuppression({ agencyId }: { agencyId: string }) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  return <form className="card" onSubmit={(event) => {
    event.preventDefault();
    if (!window.confirm(`Suppress ${email} for this agency? Future campaigns will exclude this address.`)) return;
    setBusy(true); setError(undefined); setNotice('');
    void api('POST', `/api/contacts/agencies/${agencyId}/suppressions`, { email })
      .then(() => { setNotice(`Suppression saved for ${email}. Refresh the list audience to see the change.`); setEmail(''); }, setError)
      .finally(() => setBusy(false));
  }}>
    <h2>Suppress an address</h2>
    <p>Exclude an address from future sends by this agency. Other agencies are unaffected.</p>
    <label>Email <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} data-testid="suppression-email" /></label>
    <button type="submit" disabled={busy} data-testid="suppression-submit">Suppress for this agency</button>
    {notice && <p className="notice" role="status" data-testid="suppression-notice">{notice}</p>}
    <ErrorBox error={error} />
  </form>;
}
