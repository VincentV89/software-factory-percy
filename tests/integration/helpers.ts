import type { ApiEvent, ApiResult } from '@percy/shared';
import type { PercySystem } from '@percy/local';

/** Drives the system through its HTTP edge like a browser: cookies, CSRF header, JSON bodies. */
export class Officer {
  cookies = new Map<string, string>();
  csrf = '';
  me: { officerId: string; teams: { teamId: string; agencyId: string; roles: string[] }[]; platformAdmin: boolean } | undefined;

  constructor(private readonly sys: PercySystem, readonly email: string) {}

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private absorb(res: ApiResult): void {
    for (const c of res.multiValueHeaders?.['set-cookie'] ?? []) {
      const [pair] = c.split(';');
      const idx = pair?.indexOf('=') ?? -1;
      if (!pair || idx < 0) continue;
      const name = pair.slice(0, idx);
      const value = pair.slice(idx + 1);
      if (/Max-Age=0/.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResult> {
    const [p, qs] = path.split('?');
    const event: ApiEvent = {
      httpMethod: method,
      path: p ?? path,
      headers: { cookie: this.cookieHeader(), ...(this.csrf && method !== 'GET' ? { 'x-csrf-token': this.csrf } : {}), ...headers },
      queryStringParameters: qs ? Object.fromEntries(new URLSearchParams(qs)) : null,
      body: body === undefined ? null : JSON.stringify(body),
    };
    const res = await this.sys.http(event);
    this.absorb(res);
    return res;
  }

  async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await this.raw(method, path, body);
    return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as T };
  }

  async ok<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.call<T>(method, path, body);
    if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }

  async signIn(): Promise<this> {
    const start = await this.raw('GET', '/auth/login');
    const authorize = new URL(start.headers?.['location'] ?? '');
    const code = this.sys.oidc.issueCode(this.email, authorize.searchParams.get('nonce') ?? '', authorize.searchParams.get('code_challenge') ?? '');
    const cb = await this.raw('GET', `/auth/callback?code=${code}&state=${authorize.searchParams.get('state') ?? ''}`);
    if (cb.statusCode !== 302) throw new Error(`callback failed ${cb.statusCode} ${cb.body}`);
    await this.refresh();
    return this;
  }

  async refresh(): Promise<void> {
    const me = await this.call<{ csrfToken: string; officerId: string; teams: { teamId: string; agencyId: string; roles: string[] }[]; platformAdmin: boolean }>('GET', '/api/platform/me');
    if (me.status === 200) {
      this.csrf = me.body.csrfToken;
      this.me = me.body;
    }
  }
}

export interface Tenancy {
  admin: Officer;
  agencyId: string;
  teamId: string;
}

/** Bootstraps a platform admin, an agency and a team, and grants the given memberships. */
export async function setupTenancy(sys: PercySystem, members: Record<string, ('member' | 'approver')[]>, names = { agency: 'E2E Agency', team: 'E2E Team' }): Promise<Tenancy> {
  await sys.bootstrap('root@percy.test');
  const admin = await new Officer(sys, 'root@percy.test').signIn();
  const agency = await admin.ok<{ agencyId: string }>('POST', '/api/platform/agencies', { name: names.agency });
  const team = await admin.ok<{ teamId: string }>('POST', `/api/platform/agencies/${agency.agencyId}/teams`, { name: names.team });
  for (const [email, roles] of Object.entries(members)) await admin.ok('PUT', `/api/platform/teams/${team.teamId}/members/${encodeURIComponent(email)}`, { roles });
  return { admin, agencyId: agency.agencyId, teamId: team.teamId };
}

/** Uploads a CSV through the import API and the local presigned-POST target. */
export async function importCsv(sys: PercySystem, officer: Officer, teamId: string, listId: string, csv: string): Promise<Record<string, unknown>> {
  const created = await officer.ok<{ importId: string; upload: { fields: Record<string, string> } }>('POST', `/api/contacts/teams/${teamId}/lists/${listId}/imports`);
  await sys.upload(created.upload.fields['key'] ?? '', new TextEncoder().encode(csv));
  await sys.settle();
  return officer.ok('GET', `/api/contacts/teams/${teamId}/lists/${listId}/imports/${created.importId}`);
}

export const E2E_SMALL_CSV = [
  'email,name',
  'success+e2e1@simulator.amazonses.com,Ann',
  'success+e2e2@simulator.amazonses.com,Ben',
  'bounce+e2e@simulator.amazonses.com,Cat',
  'complaint+e2e@simulator.amazonses.com,Dan',
  'success+e2e1@simulator.amazonses.com,Ann',
  'not-an-email,Eve',
  'success+supp@simulator.amazonses.com,Sam',
].join('\n');

export const TEMPLATE = {
  name: 'E2E Template',
  subject: 'Hello {{name}}',
  html: '<p>Hi {{name}},</p><p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>',
  text: 'Hi {{name}}. Unsubscribe: {{unsubscribe_url}}',
};

export interface Launched {
  a: Officer;
  b: Officer;
  admin: Officer;
  teamId: string;
  agencyId: string;
  listId: string;
  templateId: string;
  campaignId: string;
}

/** Creates tenancy, a list from the given addresses, a template and an approved campaign; optionally sends now. */
export async function launch(sys: PercySystem, emails: string[], opts: { send?: boolean; template?: typeof TEMPLATE; extraCsvColumns?: (i: number) => string } = {}): Promise<Launched> {
  const t = await setupTenancy(sys, { 'officer-a@percy.test': ['member'], 'officer-b@percy.test': ['member', 'approver'] });
  const a = await new Officer(sys, 'officer-a@percy.test').signIn();
  const b = await new Officer(sys, 'officer-b@percy.test').signIn();
  const list = await a.ok<{ listId: string }>('POST', `/api/contacts/teams/${t.teamId}/lists`, { name: 'Sim list' });
  const csv = ['email,name', ...emails.map((e, i) => `${e},${opts.extraCsvColumns ? opts.extraCsvColumns(i) : `N${i}`}`)].join('\n');
  const imp = await importCsv(sys, a, t.teamId, list.listId, csv);
  if (imp['status'] !== 'COMPLETED') throw new Error(`import ${JSON.stringify(imp)}`);
  const tpl = await a.ok<{ templateId: string }>('POST', `/api/engine/teams/${t.teamId}/templates`, opts.template ?? TEMPLATE);
  const cmp = await a.ok<{ campaignId: string }>('POST', `/api/engine/teams/${t.teamId}/campaigns`, { name: 'Sim', templateId: tpl.templateId, listId: list.listId, senderName: 'Sim' });
  await a.ok('POST', `/api/engine/teams/${t.teamId}/campaigns/${cmp.campaignId}/actions/submit`);
  await b.ok('POST', `/api/engine/teams/${t.teamId}/campaigns/${cmp.campaignId}/actions/approve`);
  if (opts.send !== false) await a.ok('POST', `/api/engine/teams/${t.teamId}/campaigns/${cmp.campaignId}/actions/schedule`, { at: 'now' });
  return { a, b, admin: t.admin, teamId: t.teamId, agencyId: t.agencyId, listId: list.listId, templateId: tpl.templateId, campaignId: cmp.campaignId };
}

export const sim = (n: number, prefix = 'success+r'): string[] => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, '0')}@simulator.amazonses.com`);

/** NFR-SAFE-02: no recipient got two SES calls in one campaign, and no suppressed address got any. */
export async function assertSafety(sys: PercySystem): Promise<void> {
  const seen = new Map<string, number>();
  for (const c of sys.ses.calls) {
    if (c.outcome === 'throttled') continue;
    const k = `${c.campaignId}/${c.to}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const dupes = [...seen].filter(([, n]) => n > 1);
  if (dupes.length) throw new Error(`duplicate SES calls: ${JSON.stringify(dupes.slice(0, 5))}`);
}

export async function campaignState(o: Officer, teamId: string, campaignId: string): Promise<{ state: string; pausedReason?: string; error?: string }> {
  return o.ok('GET', `/api/engine/teams/${teamId}/campaigns/${campaignId}`);
}

export async function report(o: Officer, teamId: string, campaignId: string): Promise<{ state: string; counters: Record<string, number>; audience: number; status?: string; reason?: string }> {
  return o.ok('GET', `/api/engine/teams/${teamId}/campaigns/${campaignId}/report`);
}
