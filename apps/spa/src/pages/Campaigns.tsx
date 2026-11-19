import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api';
import { Empty, ErrorBox, StateBadge, formatTime, useLoad } from '../components';
import { useMe } from '../session';

interface CampaignRow {
  campaignId: string;
  name: string;
  state: string;
  createdBy: string;
  audienceCount?: number;
  scheduleAt?: string;
  updatedAt: string;
}

/** Campaign list, newest first (FR-CMP-05), and create (FR-CMP-01). */
export function CampaignsPage() {
  const { teamId = '' } = useParams();
  const me = useMe();
  const navigate = useNavigate();
  const campaigns = useLoad(() => api<{ items: CampaignRow[] }>('GET', `/api/engine/teams/${teamId}/campaigns`), [teamId]);
  const templates = useLoad(() => api<{ items: { templateId: string; name: string }[] }>('GET', `/api/engine/teams/${teamId}/templates`), [teamId]);
  const lists = useLoad(() => api<{ items: { listId: string; name: string }[] }>('GET', `/api/contacts/teams/${teamId}/lists`), [teamId]);
  const [form, setForm] = useState({ name: '', templateId: '', listId: '', senderName: '' });
  const [error, setError] = useState<unknown>();
  const [showForm, setShowForm] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      const c = await api<{ campaignId: string }>('POST', `/api/engine/teams/${teamId}/campaigns`, form);
      navigate(`/teams/${teamId}/campaigns/${c.campaignId}`);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <section>
      <h1>Campaigns</h1>
      <ErrorBox error={campaigns.error} />
      <button type="button" onClick={() => setShowForm(!showForm)} data-testid="campaign-new-button">New campaign</button>
      {showForm && (
        <form onSubmit={(e) => void submit(e)} className="card" data-testid="campaign-form">
          <label>Name <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required data-testid="campaign-form-name" /></label>
          <label>
            Template
            <select value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value })} required data-testid="campaign-form-template">
              <option value="">Choose a template</option>
              {templates.data?.items.map((t) => <option key={t.templateId} value={t.templateId}>{t.name}</option>)}
            </select>
          </label>
          <label>
            List
            <select value={form.listId} onChange={(e) => setForm({ ...form, listId: e.target.value })} required data-testid="campaign-form-list">
              <option value="">Choose a list</option>
              {lists.data?.items.map((l) => <option key={l.listId} value={l.listId}>{l.name}</option>)}
            </select>
          </label>
          <label>Sender display name <input value={form.senderName} onChange={(e) => setForm({ ...form, senderName: e.target.value })} required data-testid="campaign-form-sender" /></label>
          <ErrorBox error={error} testId="campaign-form-error" />
          <button type="submit" data-testid="campaign-form-submit">Create campaign</button>
        </form>
      )}
      {campaigns.data && campaigns.data.items.length === 0 && (
        <Empty testId="campaigns-empty">
          No campaigns yet. <Link to={`/teams/${teamId}/templates/new`}>Create a template</Link>, then create a campaign.
        </Empty>
      )}
      {campaigns.data && campaigns.data.items.length > 0 && (
        <table data-testid="campaigns-table">
          <thead>
            <tr><th>Name</th><th>State</th><th>Author</th><th>Audience</th><th>Scheduled</th><th>Updated</th></tr>
          </thead>
          <tbody>
            {campaigns.data.items.map((c) => (
              <tr key={c.campaignId} data-testid="campaigns-table-row">
                <td><Link to={`/teams/${teamId}/campaigns/${c.campaignId}`} data-testid="campaign-link">{c.name}</Link></td>
                <td><StateBadge state={c.state} /></td>
                <td>{c.createdBy === me.officerId ? 'You' : c.createdBy}</td>
                <td>{c.audienceCount ?? '—'}</td>
                <td>{formatTime(c.scheduleAt)}</td>
                <td>{formatTime(c.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
