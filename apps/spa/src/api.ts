/** Thin API client: same-origin cookies, CSRF header on writes, 401 → sign-in (FR-SPA-03). */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly details: { field?: string; reason: string }[] = []) {
    super(message);
  }
}

let csrfToken = '';
export function setCsrf(token: string): void {
  csrfToken = token;
}

export function signIn(): void {
  window.location.assign('/auth/login');
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  if (res.status === 401) {
    signIn();
    throw new ApiError(401, 'Your session has ended. Redirecting to sign-in…');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : {};
  if (!res.ok) {
    const err = (data as { error?: { message?: string; details?: { field?: string; reason: string }[] }; message?: string }) ?? {};
    const message = err.error?.message ?? err.message ?? `Request failed (${res.status}).`;
    throw new ApiError(res.status, res.status === 409 ? `Not allowed right now: ${message}` : message, err.error?.details ?? []);
  }
  return data as T;
}

export async function signOut(): Promise<void> {
  const out = await api<{ logoutUrl: string }>('POST', '/auth/logout');
  window.location.assign(out.logoutUrl || '/');
}

export interface Team {
  teamId: string;
  teamName: string;
  agencyId: string;
  agencyName: string;
  tier: string;
  roles: string[];
}

export interface Me {
  officerId: string;
  email?: string;
  platformAdmin: boolean;
  agencyAdmin: { agencyId: string; agencyName: string }[];
  teams: Team[];
  csrfToken: string;
}

export interface KillSwitch {
  scope: string;
  reason: string;
  setBy: string;
  setAt: string;
}
