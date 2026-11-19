import { describe, expect, it } from 'vitest';
import { DEFAULT_SESSION_POLICY, clearSessionCookie, loginCookie, parseCookies, sessionCookie, sessionState } from '../src';

describe('session policy (FR-AUTH-02)', () => {
  const s = { sessionId: 'x', officerId: 'o', csrfToken: 'c', createdAt: 0, lastSeenAt: 0 };
  it('expires after 15 minutes idle or 8 hours absolute', () => {
    expect(sessionState(s, 14 * 60_000, DEFAULT_SESSION_POLICY)).toBe('active');
    expect(sessionState(s, 15 * 60_000, DEFAULT_SESSION_POLICY)).toBe('idle-expired');
    expect(sessionState({ ...s, lastSeenAt: 8 * 3600_000 - 1 }, 8 * 3600_000, DEFAULT_SESSION_POLICY)).toBe('absolute-expired');
  });
});

describe('cookies (FR-AUTH-01 AC1, R7)', () => {
  it('session cookie is HttpOnly, Secure, SameSite=Strict, Path=/', () => {
    expect(sessionCookie('v', 60)).toBe('percy_sid=v; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=60');
    expect(clearSessionCookie()).toContain('Max-Age=0');
  });
  it('login transaction cookie is Lax and scoped to /auth', () => {
    expect(loginCookie('s')).toBe('percy_login=s; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=600');
  });
  it('parses cookie headers, first value wins', () => {
    expect(parseCookies('a=1; percy_sid=abc%3D; a=2; bad')).toEqual({ a: '1', percy_sid: 'abc=' });
    expect(parseCookies(undefined)).toEqual({});
  });
});
