import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VirtualClock, setLogLevel, setLogSink } from '@percy/shared';
import { createSystem } from '@percy/local';
import { E2E_SMALL_CSV, Officer, TEMPLATE, importCsv, setupTenancy } from './helpers';

/** NFR-SEC-03: capture every log line of a full send and scan for email addresses. */
describe('no PII in logs', () => {
  const lines: string[] = [];
  let restore: (l: string) => void;
  beforeAll(() => {
    setLogLevel('DEBUG');
    restore = setLogSink((l) => lines.push(l));
  });
  afterAll(() => {
    setLogSink(restore);
    setLogLevel('INFO');
  });

  it('a full import, send, feedback and unsubscribe logs no address', async () => {
    const sys = createSystem({ clock: new VirtualClock() });
    const t = await setupTenancy(sys, { 'a@percy.test': ['member'], 'b@percy.test': ['member', 'approver'] });
    const a = await new Officer(sys, 'a@percy.test').signIn();
    const b = await new Officer(sys, 'b@percy.test').signIn();
    const list = await a.ok<{ listId: string }>('POST', `/api/contacts/teams/${t.teamId}/lists`, { name: 'L' });
    await importCsv(sys, a, t.teamId, list.listId, E2E_SMALL_CSV);
    const tpl = await a.ok<{ templateId: string }>('POST', `/api/engine/teams/${t.teamId}/templates`, TEMPLATE);
    const c = await a.ok<{ campaignId: string }>('POST', `/api/engine/teams/${t.teamId}/campaigns`, { name: 'c', templateId: tpl.templateId, listId: list.listId, senderName: 's' });
    await a.ok('POST', `/api/engine/teams/${t.teamId}/campaigns/${c.campaignId}/actions/submit`);
    await b.ok('POST', `/api/engine/teams/${t.teamId}/campaigns/${c.campaignId}/actions/approve`);
    await a.ok('POST', `/api/engine/teams/${t.teamId}/campaigns/${c.campaignId}/actions/schedule`, { at: 'now' });
    sys.ses.behaviour = (email, i) => (i === 1 ? 'throw' : { kind: 'accepted', messageId: '' });
    await sys.runFor(120_000);
    const log = await a.ok<{ items: { devUnsubUrl?: string }[] }>('GET', `/api/engine/test/campaigns/${c.campaignId}/send-log`);
    const url = log.items.find((i) => i.devUnsubUrl)?.devUnsubUrl ?? '';
    await sys.http({ httpMethod: 'POST', path: new URL(url).pathname, body: '' });
    await sys.runFor(10_000);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.some((l) => l.includes('suppression applied'))).toBe(true);
    const leaks = lines.filter((l) => /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(l));
    expect(leaks).toEqual([]);
  });
});
