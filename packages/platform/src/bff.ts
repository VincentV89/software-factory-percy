import { createHash } from 'node:crypto';
import { Unauthenticated, ValidationError, base64url, constantTimeEqual, randomToken, type ApiResult, type Logger } from '@percy/shared';
import type { AuditClient } from '@percy/platform-contract';
import { clearLoginCookie, clearSessionCookie, loginCookie, LOGIN_COOKIE, parseCookies, SESSION_COOKIE, sessionCookie } from './cookies';
import type { SessionPolicy, SessionRepo } from './session-repo';
import type { TenancyRepo } from './tenancy-repo';

/** OIDC provider port (Cognito hosted UI in AWS, a fake provider locally). */
export interface OidcClient {
  authorizeUrl(p: { state: string; nonce: string; codeChallenge: string; redirectUri: string }): Promise<string>;
  exchangeCode(code: string, verifier: string, redirectUri: string): Promise<{ idToken: string }>;
  verifyIdToken(idToken: string, nonce: string): Promise<{ sub: string; email: string }>;
  logoutUrl(returnTo: string): Promise<string>;
}

export interface BffDeps {
  sessions: SessionRepo;
  tenancy: TenancyRepo;
  oidc: OidcClient;
  audit: AuditClient;
  policy: SessionPolicy;
  publicBaseUrl: () => Promise<string>;
  now: () => number;
  logger: Logger;
}

function redirect(location: string, cookies: string[]): ApiResult {
  return { statusCode: 302, headers: { location, 'cache-control': 'no-store' }, multiValueHeaders: { 'set-cookie': cookies }, body: '' };
}

export async function login(deps: BffDeps): Promise<ApiResult> {
  const state = randomToken(24);
  const verifier = randomToken(48);
  const nonce = randomToken(24);
  await deps.sessions.putLogin({ state, verifier, nonce, createdAt: deps.now() });
  const base = await deps.publicBaseUrl();
  const codeChallenge = base64url(createHash('sha256').update(verifier).digest());
  const url = await deps.oidc.authorizeUrl({ state, nonce, codeChallenge, redirectUri: `${base}/auth/callback` });
  return redirect(url, [loginCookie(state)]);
}

export async function callback(q: { code?: string; state?: string; cookieHeader?: string; requestId: string }, deps: BffDeps): Promise<ApiResult> {
  const cookieState = parseCookies(q.cookieHeader)[LOGIN_COOKIE];
  if (!q.code || !q.state || !cookieState || !constantTimeEqual(cookieState, q.state)) throw new ValidationError('Sign-in could not be completed. Please try again.');
  const tx = await deps.sessions.takeLogin(q.state, deps.now());
  if (!tx) throw new ValidationError('Sign-in expired. Please try again.');
  const base = await deps.publicBaseUrl();
  const { idToken } = await deps.oidc.exchangeCode(q.code, tx.verifier, `${base}/auth/callback`);
  const claims = await deps.oidc.verifyIdToken(idToken, tx.nonce);
  // Tokens are discarded here: nothing from Cognito is stored or returned to the browser.
  const officer = await deps.tenancy.ensureOfficer(claims.email);
  if (officer.cognitoSub !== claims.sub) await deps.tenancy.linkCognitoSub(officer.officerId, claims.sub);
  const { cookieValue } = await deps.sessions.create(officer.officerId, deps.now());
  await deps.audit.record({ actor: officer.officerId, action: 'auth.sign-in', targetType: 'officer', targetId: officer.officerId, outcome: 'success', requestId: q.requestId });
  return redirect(`${base}/`, [sessionCookie(cookieValue, Math.floor(deps.policy.absoluteMs / 1000)), clearLoginCookie()]);
}

export async function logout(q: { cookieHeader?: string; csrfHeader?: string; requestId: string }, deps: BffDeps): Promise<ApiResult> {
  const sid = parseCookies(q.cookieHeader)[SESSION_COOKIE];
  if (!sid) throw new Unauthenticated();
  const session = await deps.sessions.findByCookie(sid);
  if (session) {
    if (!q.csrfHeader || !constantTimeEqual(q.csrfHeader, session.csrfToken)) throw new Unauthenticated();
    await deps.sessions.delete(session.sessionId);
    await deps.audit.record({ actor: session.officerId, action: 'auth.sign-out', targetType: 'officer', targetId: session.officerId, outcome: 'success', requestId: q.requestId });
  }
  const base = await deps.publicBaseUrl();
  const logoutUrl = await deps.oidc.logoutUrl(`${base}/`);
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    multiValueHeaders: { 'set-cookie': [clearSessionCookie()] },
    body: JSON.stringify({ logoutUrl }),
  };
}
