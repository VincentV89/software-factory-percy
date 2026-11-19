/** Cookie helpers for the BFF (design 7.1, R7). */
export const SESSION_COOKIE = 'percy_sid';
export const LOGIN_COOKIE = 'percy_login';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name && !(name in out)) out[name] = decodeURIComponent(value);
  }
  return out;
}

/** The session cookie: HttpOnly, Secure, SameSite=Strict, Path=/ (FR-AUTH-01 AC1). */
export function sessionCookie(value: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

/** The login transaction cookie must be Lax: it returns on a cross-site redirect from Cognito. */
export function loginCookie(state: string): string {
  return `${LOGIN_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=600`;
}

export function clearLoginCookie(): string {
  return `${LOGIN_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=0`;
}
