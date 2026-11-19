import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useMe, isAdmin } from '../session';
import { downloadFixture, makeFixtures } from '../testing/fixtures';

const journeys = [
  { title: 'Invite officers and assign roles', area: 'admin', steps: ['As platform admin, open Admin and email an invitation to each tester. They set a password from the invitation.', 'Create a fresh agency and team. Add Author A and Approver B as members with approver access. Grant Agency Admin C access to the agency.', 'Use separate browser profiles for each tester. Refresh the page after changing your own membership.'], expected: 'Each officer signs in normally. Membership and administrative permissions match the selected role.' },
  { title: 'Reject a malware test upload', area: 'lists', steps: ['Create a fresh list and open it.', 'Download eicar.csv below, choose it in the upload form, and click Upload.', 'Refresh until scanning finishes.'], expected: 'REJECTED_MALWARE; zero list members. The fixture is the harmless standard antivirus test file.' },
  { title: 'Import, deduplicate, and validate contacts', area: 'lists', steps: ['Upload mixed.csv to the empty list.', 'Refresh until COMPLETED and inspect the import summary.', 'Download invalid rows to inspect the rejected address.'], expected: '6 rows; 4 imported; 1 duplicate; 1 invalid; 0 already suppressed. Initial audience: 4. Generate fresh files before repeating the full journey.' },
  { title: 'Validate and preview a template', area: 'templates/new', steps: ['Create a template using the example below. First omit the unsubscribe token from the text body and try saving.', 'Restore the token and save. Select your list and Ann in Preview.', 'Also try an unclosed merge tag or a script element in the HTML.'], expected: 'Missing unsubscribe/malformed tags are refused. Unsafe HTML is removed. Valid preview subject: Hello Ann.' },
  { title: 'Submit and enforce independent approval', area: 'campaigns', steps: ['As A, create a campaign with the mixed list and saved template. Audience should be 4.', 'Submit for approval. The page explains why the creator cannot approve. Click Verify approval restriction.', 'As B in a separate profile, open the same campaign and approve it.'], expected: 'Creator check returns 403 and leaves PENDING_APPROVAL. B changes the state to APPROVED.' },
  { title: 'Send and observe SES feedback', area: 'campaigns', steps: ['As A, refresh the approved campaign and click Send now.', 'Refresh the report until COMPLETED. Allow up to 15 minutes for feedback.', 'For a real inbox test, use inbox.csv in a separate campaign; your email address or its domain must show Verified in SES in the sending region.'], expected: 'Mixed campaign: sent 4, delivered at least 2, hard bounced 1, complained 1, skipped 0, in doubt 0. Simulator messages have no inbox.' },
  { title: 'Unsubscribe without an officer login', area: 'campaigns', steps: ['On the completed mixed campaign, click Show delivery links.', 'Find Ann and click Open unsubscribe page. Confirm the agency name and unsubscribe.', 'Create another campaign against the same list.'], expected: 'Citizen confirmation succeeds. After feedback and Ann’s unsubscribe, the next audience is 1. Unsubscribe links work outside an officer session.' },
  { title: 'Pause, resume, and stop', area: 'campaigns', steps: ['Create a fresh list from stop-120.csv, then create, submit, independently approve, and send a campaign.', 'After at least 10 sent messages, click Pause. Observe for 90 seconds, then Resume.', 'Click Stop and confirm. Refresh until reconciliation finishes.'], expected: 'Pause stops calls within 60 seconds; Resume increases sent count. Stop is final; pending is 0 and Sent + Cancelled + Failed + Skipped + In doubt = 120. Delivery feedback counters overlap Sent.' },
  { title: 'Set and clear a kill switch', area: 'kill-switch', steps: ['During a long send, as agency/platform admin open Kill switch and choose only the test team.', 'Try a blank reason, then set it with “Manual test emergency stop”. Observe the campaign for 90 seconds.', 'Try Resume, then clear the switch with a reason.'], expected: 'Blank reason is refused. Banner appears and campaign pauses within 60 seconds. Resume is refused while active. Clearing leaves the campaign PAUSED.' },
  { title: 'Edit, reject, and resubmit a campaign', area: 'campaigns', steps: ['Submit a campaign. As B, enter a rejection reason and click Reject.', 'On a draft, pending, or approved campaign, click Edit campaign; change the name, sender, template, or list and Save changes.', 'Submit again and have a different eligible approver approve.'], expected: 'Reject returns to Draft with its reason. Editing clears approval and returns to Draft. Creator and last editor cannot approve.' },
  { title: 'Schedule, unschedule, and protect lists', area: 'campaigns', steps: ['On an approved campaign, try a schedule less than 5 minutes ahead or more than 30 days ahead.', 'Schedule about 10 minutes ahead, then try deleting its source list.', 'Unschedule before it starts. Separately, delete a disposable draft using Delete draft.'], expected: 'Invalid dates are refused. A scheduled list cannot be deleted. Unschedule returns to Approved; cancelled schedule does not send. Draft deletion succeeds.' },
  { title: 'Block incomplete or unverified audiences', area: 'lists', steps: ['Import missing-name.csv into a fresh list. Create a campaign with the name template, independently approve, and Send now.', 'Repeat with unverified-recipient.csv in another fresh list.'], expected: 'Freeze refuses the send with a missing-field or SES verification explanation. Campaign returns to Approved; no messages are sent.' },
  { title: 'Check CSV failure and update paths', area: 'lists', steps: ['In fresh lists, upload missing-email-header.csv, duplicate-header.csv, reserved-header.csv, and too-many-columns.csv.', 'Upload wrong-column-count.csv and inspect invalid rows.', 'Upload success-10.csv twice to the same list before sending. Rename the list with its name form.'], expected: 'Invalid headers fail with a reason. A bad-width row is invalid. Re-upload keeps 10 unique members and records updates. Rename is reflected in Lists.' },
  { title: 'Manage members, permissions, and suppressions', area: 'admin', steps: ['Select the agency and team in Admin. Inspect Team members; remove an approver role or a membership.', 'Refresh the affected officer’s session and attempt the restricted action.', 'As agency admin, suppress one test address with Suppress an address; refresh the list audience.'], expected: 'Permission changes apply on the next request. Removed members lose team access. Manual suppression reduces this agency’s audience, leaving other agencies unaffected.' },
  { title: 'Suspend and reinstate a team or agency', area: 'admin', steps: ['During a long test send, suspend its team and supply a reason.', 'Try accessing the team as a member; inspect the paused send as administrator.', 'Reinstate the team and inspect the campaign before manually resuming.'], expected: 'Access is revoked and sending pauses. Reinstatement does not automatically resume. Platform admins can also suspend agencies and change team tiers.' },
  { title: 'Check isolation and signed-out access', area: 'campaigns', steps: ['Create a second agency/team and give another tester access only there. Open a copied first-team list or campaign URL as that tester.', 'Sign in with an invited account that has no membership.', 'Sign out and reopen a protected page. For idle expiry, close all Percy tabs for more than 15 minutes before returning.'], expected: 'Foreign resources return Not found. No-role account sees Access not set up. Signed-out and expired sessions require sign-in. Old-cookie replay and 8-hour expiry are covered by automated checks.' },
];

export function TestJourneysPage() {
  const me = useMe();
  const [teamId, setTeamId] = useState(me.teams[0]?.teamId ?? '');
  const storageKey = 'percy-test-fixtures:' + me.officerId;
  const [tag, setTag] = useState(() => {
    try { return sessionStorage.getItem(storageKey) ?? 'ui' + Date.now().toString(36); }
    catch { return 'ui' + Date.now().toString(36); }
  });
  useEffect(() => { try { sessionStorage.setItem(storageKey, tag); } catch { /* The current run still works when browser storage is unavailable. */ } }, [storageKey, tag]);
  const [completed, setCompleted] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey + ':checks') ?? '[]');
      return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === 'string' && journeys.some((journey) => journey.title === item)) : [];
    } catch { return []; }
  });
  useEffect(() => { try { sessionStorage.setItem(storageKey + ':checks', JSON.stringify(completed)); } catch { /* Checklist remains available in memory. */ } }, [storageKey, completed]);
  const [csrfResult, setCsrfResult] = useState('');
  const [checking, setChecking] = useState(false);
  const fixtures = makeFixtures(tag, me.email ?? '');
  const destination = (area: string) => area === 'admin' || area === 'kill-switch' ? (isAdmin(me) ? '/' + area : undefined) : teamId ? `/teams/${teamId}/${area}` : undefined;
  return <section data-testid="test-journeys">
    <h1>Test journeys</h1>
    <p>Use real officer sessions to walk through the dev instance. Actions use normal permission checks; sends use the configured SES service.</p>
    <div className="card">
      <h2>Start a fresh run</h2>
      <p>Invite your testers in Admin, create a separate agency/team, and grant memberships. Two tabs in the same browser profile share a login.</p>
      <p>{me.platformAdmin ? <Link to="/admin">Open Admin to invite officers and set up access</Link> : 'Ask your platform administrator to invite the other testers.'}</p>
      <label>Team for journey links <select value={teamId} onChange={(e) => setTeamId(e.target.value)} data-testid="journey-team"><option value="">Choose a team</option>{me.teams.map((team) => <option value={team.teamId} key={team.teamId}>{team.agencyName} / {team.teamName}</option>)}</select></label>
      <button type="button" className="link" onClick={() => window.location.reload()}>Refresh my access</button>
      <p>Fixture set: <strong data-testid="fixture-tag">{tag}</strong>. Keep one set for a complete journey. New simulator aliases prevent earlier feedback suppressions from affecting a rerun.</p>
      <button type="button" onClick={() => { setTag('ui' + Date.now().toString(36)); setCompleted([]); }} data-testid="fresh-fixtures">Generate fresh fixtures</button>
      <div className="actions">{['mixed.csv', 'success-10.csv', 'stop-120.csv', 'inbox.csv', 'eicar.csv'].map((name) => <button type="button" key={name} onClick={() => downloadFixture(name, fixtures[name] ?? '')} data-testid={'download-' + name}>Download {name}</button>)}</div>
      <details><summary>Additional CSV validation files</summary><div className="actions">{Object.entries(fixtures).filter(([name]) => !['mixed.csv', 'success-10.csv', 'stop-120.csv', 'inbox.csv', 'eicar.csv'].includes(name)).map(([name, content]) => <button type="button" key={name} onClick={() => downloadFixture(name, content)} data-testid={'download-' + name}>Download {name}</button>)}</div></details>
      <p className="muted">The EICAR file is a harmless antivirus test. Inbox CSV uses your signed-in email; verify that email address or its domain in SES first, then refresh SES status in the list or campaign. No code changes are required. Checkboxes below record your own observations, not automated verification.</p>
    </div>
    <details className="card"><summary>Example template to copy</summary><p>Subject</p><pre>Hello {'{{name}}'}</pre><p>HTML body</p><pre>{'<p>Hi {{name}},</p><p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>'}</pre><p>Text body</p><pre>{'Hi {{name}}. Unsubscribe: {{unsubscribe_url}}'}</pre></details>
    <p role="status">{completed.length} of {journeys.length} journeys checked by you in this browser session.</p>
    {journeys.map((journey) => <details className="card" key={journey.title} data-testid="journey-card">
      <summary>{journey.title}</summary>
      <ol>{journey.steps.map((step) => <li key={step}>{step}</li>)}</ol>
      <p><strong>Expected:</strong> {journey.expected}</p>
      {destination(journey.area) && <Link className="button" to={destination(journey.area) ?? '/test-journeys'}>Open {journey.area === 'templates/new' ? 'new template' : journey.area.replace('-', ' ')}</Link>}
      <p><label className="check"><input type="checkbox" checked={completed.includes(journey.title)} onChange={(e) => setCompleted((items) => e.target.checked ? [...items, journey.title] : items.filter((item) => item !== journey.title))} /> I observed the expected result</label></p>
    </details>)}
    <div className="card">
      <h2>Check write protection</h2>
      <p>Send a test create-list request without the CSRF token. The server should reject it with 403. Select a team you belong to above.</p>
      <button type="button" disabled={!teamId || checking} data-testid="csrf-check" onClick={() => {
        setChecking(true); setCsrfResult('Checking…');
        void fetch(`/api/contacts/teams/${teamId}/lists`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'CSRF protection probe ' + tag }) })
          .then((response) => setCsrfResult(response.status === 403 ? 'Passed: write refused (403). No list was created.' : `Unexpected response: ${response.status}. Inspect Lists before continuing.`), () => setCsrfResult('Network error. Try again.'))
          .finally(() => setChecking(false));
      }}>Check blocked write without CSRF</button>
      <p role="status" data-testid="csrf-check-result">{csrfResult}</p>
    </div>
    <p className="muted">Worker crashes, concurrent delivery, event replay, SES throttling, load tests, raw audit verification, and old-cookie replay remain automated/operator checks. This page does not inject faults into running workers.</p>
  </section>;
}
