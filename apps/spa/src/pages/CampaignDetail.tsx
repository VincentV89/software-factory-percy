import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api } from '../api';
import { ErrorBox, StateBadge, formatTime, useLoad } from '../components';

interface Campaign {
  campaignId: string;
  name: string;
  state: string;
  audienceCount?: number;
  senderName: string;
  scheduleAt?: string;
  error?: string;
  rejectReason?: string;
  pausedReason?: string;
  templateSnapshot?: { subject: string; fields: string[] };
  permissions: { canApprove: boolean; actions: string[] };
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
  const { teamId = '', campaignId = '' } = useParams();
  const navigate = useNavigate();
  const [actionError, setActionError] = useState<unknown>();
  const [notice, setNotice] = useState('');
  const [scheduleAt, setScheduleAt] = useState('');
  const [rejectReason, setRejectReason] = useState('');
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
      {c.error && <p className="error" data-testid="campaign-error">{c.error}</p>}
      {c.rejectReason && c.state === 'DRAFT' && <p className="error" data-testid="campaign-reject-reason">Rejected: {c.rejectReason}</p>}

      <div className="actions">
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
    </section>
  );
}
