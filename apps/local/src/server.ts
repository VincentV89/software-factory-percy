/**
 * Local Percy: the whole system in one Node process with in-memory adapters, a fake OIDC sign-in
 * page, a local presigned-POST target with a GuardDuty simulation, and a stub SES with
 * mailbox-simulator feedback. It mirrors the CloudFront behaviours (/, /api/*, /auth/*, /u/*).
 * For development and the local Playwright run only; never deployed.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashOf, setLogLevel, type ApiEvent, type ApiResult } from '@percy/shared';
import { createSystem } from './system';

const PORT = Number(process.env['PORT'] ?? 4173);
const BASE = process.env['PERCY_LOCAL_BASE_URL'] ?? `http://localhost:${PORT}`;
const SPA_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../spa/dist');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'";

setLogLevel((process.env['LOG_LEVEL'] as 'INFO' | 'WARN' | undefined) ?? 'WARN');
const rate = Number(process.env['PERCY_LOCAL_RATE'] ?? 2);
const sys = createSystem({
  baseUrl: BASE,
  rates: { standard: rate, bulk: rate },
  statusCacheMs: Number(process.env['PERCY_LOCAL_STATUS_CACHE_MS'] ?? 2000),
  feedbackDelayMs: 1500,
  scanDelayMs: 1500,
});
setInterval(() => void sys.sweep(), 60_000).unref();

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, r: ApiResult): void {
  const headers: Record<string, string | string[]> = { ...(r.headers ?? {}) };
  for (const [k, v] of Object.entries(r.multiValueHeaders ?? {})) headers[k] = v;
  res.writeHead(r.statusCode, headers);
  res.end(r.body);
}

function html(res: ServerResponse, status: number, content: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'cache-control': 'no-store' });
  res.end(content);
}

const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function signInPage(url: URL, res: ServerResponse): Promise<void> {
  const fields = ['state', 'nonce', 'code_challenge', 'redirect_uri'].map((k) => `<input type="hidden" name="${k}" value="${escape(url.searchParams.get(k) ?? '')}">`).join('');
  html(
    res,
    200,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Percy local sign-in</title></head><body><main><h1>Local sign-in (stands in for the Cognito hosted UI)</h1><form method="post" action="/_local/oidc/authorize">${fields}<label>Email <input name="email" type="email" required data-testid="local-signin-email"></label> <button type="submit" data-testid="local-signin-submit">Sign in</button></form></main></body></html>`,
  );
}

async function fixtures(): Promise<Record<string, string>> {
  // Equivalent of scripts/e2e-fixtures.ts against the in-memory system (E2E-01 fixtures).
  await sys.bootstrap('platform-admin@percy.local');
  const tenancy = sys.tenancy;
  const agency = (await tenancy.listAgencies()).find((a) => a.name === 'E2E Agency') ?? (await tenancy.createAgency('E2E Agency'));
  const team = (await tenancy.listTeams(agency.agencyId)).find((t) => t.name === 'E2E Team') ?? (await tenancy.createTeam(agency.agencyId, 'E2E Team', 'standard'));
  const a = await tenancy.ensureOfficer('officer-a@percy.local');
  const b = await tenancy.ensureOfficer('officer-b@percy.local');
  const c = await tenancy.ensureOfficer('admin-c@percy.local');
  await tenancy.setMembership(a.officerId, team, ['member']);
  await tenancy.setMembership(b.officerId, team, ['member', 'approver']);
  await tenancy.setAgencyAdmin(c.officerId, agency.agencyId, true);
  await sys.suppressions.suppress({ addrHash: hashOf('success+supp@simulator.amazonses.com'), scope: 'GLOBAL', reason: 'MANUAL' });
  return { agencyId: agency.agencyId, teamId: team.teamId };
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(SPA_DIST, safe.includes('.') ? safe : 'index.html');
  if (!file.startsWith(SPA_DIST)) return html(res, 404, 'Not found');
  try {
    const content = await readFile(file);
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type, 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY' });
    res.end(content);
  } catch {
    html(res, 404, '<p>The SPA is not built. Run <code>npm run spa:build</code>.</p>');
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', BASE);
    const method = req.method ?? 'GET';
    if (url.pathname === '/_local/oidc/authorize' && method === 'GET') return signInPage(url, res);
    if (url.pathname === '/_local/oidc/authorize' && method === 'POST') {
      const form = new URLSearchParams((await body(req)).toString('utf8'));
      const code = sys.oidc.issueCode(form.get('email') ?? '', form.get('nonce') ?? '', form.get('code_challenge') ?? '');
      const target = new URL(form.get('redirect_uri') ?? `${BASE}/auth/callback`);
      target.searchParams.set('code', code);
      target.searchParams.set('state', form.get('state') ?? '');
      res.writeHead(302, { location: target.toString() });
      return res.end();
    }
    if (url.pathname === '/_local/upload' && method === 'POST') {
      const request = new Request(url, { method: 'POST', headers: req.headers as Record<string, string>, body: new Uint8Array(await body(req)) });
      const form = await request.formData();
      const file = form.get('file');
      const key = String(form.get('key') ?? '');
      if (!(file instanceof Blob) || !key.startsWith('raw/')) return send(res, { statusCode: 400, body: 'bad upload' });
      await sys.upload(key, new Uint8Array(await file.arrayBuffer()));
      return send(res, { statusCode: 204, body: '' });
    }
    if (url.pathname === '/_local/test/fixtures' && method === 'POST') return send(res, { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(await fixtures()) });
    if (url.pathname === '/_local/test/audit' && method === 'GET') {
      const count = sys.audit.events.filter((e) => e.action === url.searchParams.get('action') && e.outcome === 'success' && (!url.searchParams.get('targetId') || e.targetId === url.searchParams.get('targetId'))).length;
      return send(res, { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count }) });
    }
    if (url.pathname === '/_local/test/ses-calls' && method === 'GET') {
      const campaignId = url.searchParams.get('campaignId');
      const calls = sys.ses.calls.filter((c) => !campaignId || c.campaignId === campaignId).map((c) => ({ at: c.at, outcome: c.outcome }));
      return send(res, { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ calls }) });
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/u/')) {
      const raw = await body(req);
      const event: ApiEvent = {
        httpMethod: method,
        path: url.pathname,
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v])),
        queryStringParameters: url.search ? Object.fromEntries(url.searchParams) : null,
        body: raw.length ? raw.toString('utf8') : null,
      };
      return send(res, await sys.http(event));
    }
    return serveStatic(url.pathname, res);
  })().catch((e: unknown) => {
    console.error('local server error', e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`Percy local listening on ${BASE}`));
