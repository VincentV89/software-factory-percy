import { useState, type FormEvent } from 'react';
import { api, type KillSwitch } from '../api';
import { Empty, ErrorBox, formatTime, useLoad } from '../components';
import { useMe } from '../session';

/** Kill switch (admins only, FR-CTL-04..06). Agency admins choose their agency or one of its teams. */
export function KillSwitchPage() {
  const me = useMe();
  const kills = useLoad(() => api<{ items: KillSwitch[] }>('GET', '/api/engine/kill-switches'), []);
  const agencies = me.platformAdmin ? undefined : me.agencyAdmin;
  const teamsOf = useLoad(
    () => Promise.all((agencies ?? []).map((a) => api<{ items: { teamId: string; name: string; agencyId: string }[] }>('GET', `/api/platform/agencies/${a.agencyId}/teams`))).then((r) => r.flatMap((x) => x.items)),
    [],
  );
  const [scope, setScope] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>();

  const set = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api('POST', '/api/engine/kill-switches', { scope, reason });
      setReason('');
      kills.reload();
    } catch (err) {
      setError(err);
    }
  };
  const clear = async (s: string) => {
    const why = window.prompt('Reason for clearing the kill switch') ?? '';
    try {
      await api('POST', '/api/engine/kill-switches/clear', { scope: s, reason: why });
      kills.reload();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <section>
      <h1>Kill switch</h1>
      <form onSubmit={(e) => void set(e)} className="card" data-testid="kill-switch-form">
        <label>
          Scope
          <select value={scope} onChange={(e) => setScope(e.target.value)} required data-testid="kill-switch-scope">
            <option value="">Choose a scope</option>
            {me.platformAdmin && <option value="GLOBAL">GLOBAL (all of Percy)</option>}
            {me.agencyAdmin.map((a) => <option key={a.agencyId} value={`AGENCY#${a.agencyId}`}>Agency: {a.agencyName}</option>)}
            {teamsOf.data?.map((t) => <option key={t.teamId} value={`TEAM#${t.teamId}`}>Team: {t.name}</option>)}
            {me.platformAdmin && <option value="custom">Other (type below)</option>}
          </select>
        </label>
        {scope === 'custom' && <input placeholder="AGENCY#id or TEAM#id" onChange={(e) => setScope(e.target.value)} data-testid="kill-switch-custom-scope" />}
        <label>Reason (10–500 characters) <textarea value={reason} onChange={(e) => setReason(e.target.value)} data-testid="kill-switch-reason" /></label>
        <ErrorBox error={error} testId="kill-switch-error" />
        <button type="submit" className="danger" data-testid="kill-switch-set-button">Set kill switch</button>
      </form>
      <h2>Active</h2>
      {kills.data?.items.length === 0 && <Empty testId="kill-switch-none">No kill switch is active.</Empty>}
      <ul data-testid="kill-switch-active">
        {kills.data?.items.map((k) => (
          <li key={k.scope} data-testid="kill-switch-active-item">
            <strong>{k.scope}</strong>: {k.reason} (by {k.setBy}, {formatTime(k.setAt)}){' '}
            <button type="button" onClick={() => void clear(k.scope)} data-testid="kill-switch-clear-button">Clear</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
