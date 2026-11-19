import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ApiError, api } from '../api';
import { ErrorBox, StateBadge, formatTime, useLoad } from '../components';
import { useMe } from '../session';
import { RecipientVerificationPanel } from '../RecipientVerification';

interface Campaign {
  campaignId: string;
  name: string;
  state: string;
  audienceCount?: number;
  senderName: string;
  listId: string;
  templateId: string;
  createdBy: string;
  lastEditedBy: string;
  scheduleAt?: string;
  error?: string;
  rejectReason?: string;
  pausedReason?: string;
  templateSnapshot?: { subject: string; fields: string[] };
  permissions: { canApprove: boolean; canEdit: boolean; actions: string[] };
}

interface Report {
  state: string;
  audience: number;
  counters: Record<string, number>;
}

const LIVE = ['FREEZING', 'SENDING', 'PAUSED'];
const REPORT_ROWS: [string, string][] = [
  ['sent', 'Sent'],
  ['delivered', 'Delivered'],
  ['bouncedHard', 'Bounced (hard)'],
  ['bouncedSoft', 'Bounced (soft)'],
  ['complained', 'Complained'],
  ['failed', 'Failed'],
  ['skipped', 'Skipped (suppressed)'],
  ['cancelled', 'Cancelled'],
  ['inDoubt', 'In doubt'],
  ['pending', 'Pending'],
];

/** Campaign detail: state, role-aware actions, approval, schedule, controls and report (FR-SPA-01/02, FR-RPT-02). */
export function CampaignDetail() {
  const me = useMe();
  const { teamId = '', campaignId = '' } = useParams();
  const navigate = useNavigate();
  const [actionError, setActionError] = useState<unknown>();
  const [notice, setNotice] = useState('');
  const [scheduleAt, setScheduleAt] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [editing, setEditing] = useState(false);
  const [showLinks, setShowLinks] = useState(false);
  const [approvalCheck, setApprovalCheck] = useState('');
  const [verificationVersion, setVerificationVersion] = useState(0);
  const base = `/api/engine/teams/${teamId}/campaigns/${campaignId}`;
  const [pollMs, setPollMs] = useState<number>();
  const campaign = useLoad(() => api<Campaign>('GET', base), [base], pollMs);
  const live = campaign.data ? LIVE.includes(campaign.data.state) : false;
  useEffect(() => setPollMs(live ? 15_000 : undefined), [live]);
  const report = useLoad(() => api<Report>('GET', `${base}/report`), [base, campaign.data?.state], pollMs);
  const c = campaign.data;

  const act = async (action: string, body?: unknown) => {
    setActionError(undefined);
    setNotice('');
    try {
      await api('POST', `${base}/actions/${action}`, body ?? {});
      setNotice(`${action} accepted`);
    } catch (e) {
      setActionError(e);
    }
    campaign.reload();
    report.reload();
  };

  if (campaign.error) return <ErrorBox error={campaign.error} />;
  if (!c) return <p>Loading…</p>;
  const can = (a: string) => c.permissions.actions.includes(a);
  const refresh = () => {
    campaign.reload();
    report.reload();
    setVerificationVersion((v) => v + 1);
  };

  return (
    <section data-testid="campaign-detail">
      <h1 data-testid="campaign-name">{c.name}</h1>
      <p>
        State: <StateBadge state={c.state} testId="campaign-state" />
        {c.pausedReason && c.state === 'PAUSED' && <span data-testid="campaign-paused-reason"> ({c.pausedReason})</span>}
        <button type="button" className="link" onClick={refresh} data-testid="campaign-refresh">Refresh</button>
      </p>
      <dl className="facts">
        <dt>Audience</dt><dd data-testid="campaign-audience-count">{c.audienceCount ?? '—'}</dd>
        <dt>Sender</dt><dd>{c.senderName}</dd>
        <dt>Scheduled</dt><dd>{formatTime(c.scheduleAt)}</dd>
        {c.templateSnapshot && (<><dt>Subject</dt><dd>{c.templateSnapshot.subject}</dd></>)}
      </dl>
      {c.error && <div className="error"><p data-testid="campaign-error">Last send attempt: {c.error}</p>{me.testingEnabled && c.state === 'APPROVED' && <p>After correcting the issue, refresh the recipient status below and retry Send now. A successful refresh does not resend the campaign.</p>}</div>}
      <RecipientVerificationPanel key={teamId + c.listId} teamId={teamId} listId={c.listId} version={c.state + (c.error ?? '') + verificationVersion} />
      {c.rejectReason && c.state === 'DRAFT' && <p className="error" data-testid="campaign-reject-reason">Rejected: {c.rejectReason}</p>}
      {c.state === 'PENDING_APPROVAL' && (c.createdBy === me.officerId || c.lastEditedBy === me.officerId) && <p className="muted">You cannot approve a campaign you created or last edited. Ask another approver to sign in.</p>}
      {editing && <CampaignEditor campaign={c} teamId={teamId} base={base} onSaved={() => { setEditing(false); refresh(); }} onCancel={() => setEditing(false)} />}

      <div className="actions">
        {c.permissions.canEdit && !editing && <button type="button" onClick={() => setEditing(true)} data-testid="campaign-edit-button">Edit campaign</button>}
        {can('submit') && <button type="button" onClick={() => void act('submit')} data-testid="campaign-submit-button">Submit for approval</button>}
        {c.permissions.canApprove && <button type="button" onClick={() => void act('approve')} data-testid="campaign-approve-button">Approve</button>}
        {c.permissions.canApprove && (
          <span>
            <input placeholder="Reason for rejecting" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} data-testid="campaign-reject-reason-input" />
            <button type="button" onClick={() => void act('reject', { reason: rejectReason })} data-testid="campaign-reject-button">Reject</button>
          </span>
        )}
        {can('schedule') && (
          <span>
            <button type="button" onClick={() => void act('schedule', { at: 'now' })} data-testid="campaign-send-now-button">Send now</button>
            <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} data-testid="campaign-schedule-input" />
            <button type="button" disabled={!scheduleAt} onClick={() => void act('schedule', { at: new Date(scheduleAt).toISOString() })} data-testid="campaign-schedule-button">Schedule</button>
          </span>
        )}
        {can('unschedule') && <button type="button" onClick={() => void act('unschedule')} data-testid="campaign-unschedule-button">Unschedule</button>}
        {can('pause') && <button type="button" onClick={() => void act('pause')} data-testid="campaign-pause-button">Pause</button>}
        {can('resume') && <button type="button" onClick={() => void act('resume')} data-testid="campaign-resume-button">Resume</button>}
        {can('stop') && (
          <button type="button" className="danger" onClick={() => window.confirm('Stop is final. Remaining recipients will be cancelled.') && void act('stop')} data-testid="campaign-stop-button">Stop</button>
        )}
        {c.state === 'DRAFT' && (
          <button type="button" className="danger" onClick={() => void api('DELETE', base).then(() => navigate(`/teams/${teamId}/campaigns`), setActionError)} data-testid="campaign-delete-button">Delete draft</button>
        )}
      </div>
      {notice && <p className="notice" data-testid="campaign-notice">{notice}</p>}
      <ErrorBox error={actionError} testId="campaign-action-error" />
      {me.testingEnabled && c.state === 'PENDING_APPROVAL' && !c.permissions.canApprove && <div className="card">
        <p>Check that the server enforces the approval restriction for your account.</p>
        <button type="button" data-testid="approval-check" onClick={() => {
          setApprovalCheck('Checking…');
          void api('POST', `${base}/actions/approve`, {}).then(() => {
            setApprovalCheck('Unexpected: approval was accepted.'); refresh();
          }, (error: unknown) => setApprovalCheck(error instanceof ApiError && error.status === 403 ? 'Passed: approval refused (403). Campaign remains pending.' : error instanceof Error ? error.message : 'Check failed.'));
        }}>Verify approval restriction</button>
        <p role="status" data-testid="approval-check-result">{approvalCheck}</p>
      </div>}

      {report.data && report.data.audience > 0 && (
        <section className="card" data-testid="campaign-report">
          <h2>Report</h2>
          <p>Audience frozen: <span data-testid="report-audience">{report.data.audience}</span></p>
          <table>
            <tbody>
              {REPORT_ROWS.map(([k, label]) => (
                <tr key={k}><th>{label}</th><td data-testid={`report-${k}`}>{report.data?.counters[k] ?? 0}</td></tr>
              ))}
            </tbody>
          </table>
          {live && <p className="muted">Refreshes every 15 seconds.</p>}
        </section>
      )}
      {me.testingEnabled && report.data && report.data.audience > 0 && <section className="card">
        <h2>Test delivery links</h2>
        <p>SES simulator messages have no inbox. Open a recipient’s unsubscribe page here to test the citizen journey.</p>
        <button type="button" onClick={() => setShowLinks(!showLinks)} data-testid="delivery-links-toggle">{showLinks ? 'Hide delivery links' : 'Show delivery links'}</button>
        {showLinks && <DeliveryLinks campaignId={campaignId} teamId={teamId} listId={c.listId} />}
      </section>}
    </section>
  );
}

function CampaignEditor({ campaign, teamId, base, onSaved, onCancel }: { campaign: Campaign; teamId: string; base: string; onSaved: () => void; onCancel: () => void }) {
  const [form, setForm] = useState({ name: campaign.name, senderName: campaign.senderName, listId: campaign.listId, templateId: campaign.templateId });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const templates = useLoad(() => api<{ items: { templateId: string; name: string }[] }>('GET', `/api/engine/teams/${teamId}/templates`), [teamId]);
  const lists = useLoad(() => api<{ items: { listId: string; name: string }[] }>('GET', `/api/contacts/teams/${teamId}/lists`), [teamId]);
  return <form className="card" data-testid="campaign-edit-form" onSubmit={(event) => {
    event.preventDefault(); setBusy(true); setError(undefined);
    void api('PUT', base, form).then(onSaved, setError).finally(() => setBusy(false));
  }}>
    <h2>Edit campaign</h2>
    <p>Saving returns this campaign to Draft and clears any existing approval. Submit it again for independent approval.</p>
    <label>Name <input required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="campaign-edit-name" /></label>
    <label>Sender display name <input required maxLength={100} value={form.senderName} onChange={(e) => setForm({ ...form, senderName: e.target.value })} /></label>
    <label>Template <select required value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value })}>{templates.data?.items.map((item) => <option key={item.templateId} value={item.templateId}>{item.name}</option>)}</select></label>
    <label>List <select required value={form.listId} onChange={(e) => setForm({ ...form, listId: e.target.value })}>{lists.data?.items.map((item) => <option key={item.listId} value={item.listId}>{item.name}</option>)}</select></label>
    <ErrorBox error={error ?? templates.error ?? lists.error} />
    <div className="actions"><button type="submit" disabled={busy} data-testid="campaign-edit-save">Save changes</button><button type="button" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </form>;
}

function DeliveryLinks({ campaignId, teamId, listId }: { campaignId: string; teamId: string; listId: string }) {
  const data = useLoad(async () => {
    const [log, contacts] = await Promise.all([
      api<{ items: { addrHash: string; status: string; sesCalledAt?: number; devUnsubUrl?: string }[] }>('GET', `/api/engine/test/campaigns/${campaignId}/send-log`),
      api<{ items: { addrHash: string; email?: string; attrs: Record<string, string> }[] }>('GET', `/api/contacts/teams/${teamId}/lists/${listId}/members`),
    ]);
    return log.items.map((row) => ({ ...row, contact: contacts.items.find((item) => item.addrHash === row.addrHash) }));
  }, [campaignId, teamId, listId]);
  return <div data-testid="delivery-links">
    <button type="button" className="link" onClick={data.reload}>Refresh delivery links</button>
    <ErrorBox error={data.error} />
    <div className="table-scroll"><table><thead><tr><th>Recipient</th><th>Status</th><th>Send attempted</th><th>Citizen journey</th></tr></thead><tbody>
      {data.data?.map((row) => <tr key={row.addrHash}><td>{row.contact?.attrs['name'] ?? row.contact?.email ?? row.addrHash.slice(0, 12)}</td><td>{row.status}</td><td>{row.sesCalledAt ? new Date(row.sesCalledAt).toLocaleString() : '—'}</td><td>{row.devUnsubUrl ? <a href={row.devUnsubUrl} target="_blank" rel="noopener noreferrer" data-testid="delivery-unsubscribe-link">Open unsubscribe page</a> : 'Not available yet'}</td></tr>)}
    </tbody></table></div>
  </div>;
}
