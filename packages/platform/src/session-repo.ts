import { randomToken, sha256Hex, type KvStore } from '@percy/shared';

export interface SessionPolicy {
  idleMs: number;
  absoluteMs: number;
  /** lastSeenAt is refreshed only when older than this (design 7.1). */
  touchAfterMs: number;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = { idleMs: 15 * 60_000, absoluteMs: 8 * 3600_000, touchAfterMs: 60_000 };

export interface Session {
  sessionId: string;
  officerId: string;
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
}

export type SessionState = 'active' | 'idle-expired' | 'absolute-expired';

/** Pure expiry rule (FR-AUTH-02 AC1). */
export function sessionState(s: Session, now: number, policy: SessionPolicy): SessionState {
  if (now - s.createdAt >= policy.absoluteMs) return 'absolute-expired';
  if (now - s.lastSeenAt >= policy.idleMs) return 'idle-expired';
  return 'active';
}

export interface LoginTransaction {
  state: string;
  verifier: string;
  nonce: string;
  createdAt: number;
}

/** platform-sessions table. The cookie value is never stored; only its SHA-256. */
export class SessionRepo {
  constructor(private readonly kv: KvStore, private readonly table: string, private readonly policy: SessionPolicy) {}

  async create(officerId: string, now: number): Promise<{ cookieValue: string; session: Session }> {
    const cookieValue = randomToken(32);
    const session: Session = { sessionId: sha256Hex(cookieValue), officerId, csrfToken: randomToken(32), createdAt: now, lastSeenAt: now };
    await this.kv.put(this.table, {
      pk: `SESSION#${session.sessionId}`,
      sk: 'META',
      ...session,
      expiresAt: Math.floor((now + this.policy.absoluteMs) / 1000),
    });
    return { cookieValue, session };
  }

  async findByCookie(cookieValue: string): Promise<Session | undefined> {
    return this.get(sha256Hex(cookieValue));
  }

  async get(sessionId: string): Promise<Session | undefined> {
    const i = await this.kv.get(this.table, { pk: `SESSION#${sessionId}`, sk: 'META' }, { consistent: true });
    if (!i) return undefined;
    return { sessionId, officerId: String(i['officerId']), csrfToken: String(i['csrfToken']), createdAt: Number(i['createdAt']), lastSeenAt: Number(i['lastSeenAt']) };
  }

  async touch(sessionId: string, now: number): Promise<void> {
    await this.kv.update(this.table, { pk: `SESSION#${sessionId}`, sk: 'META' }, { set: { lastSeenAt: now } }, { cond: { op: 'exists', attr: 'pk' } }).catch(() => undefined);
  }

  async delete(sessionId: string): Promise<void> {
    await this.kv.delete(this.table, { pk: `SESSION#${sessionId}`, sk: 'META' });
  }

  async putLogin(tx: LoginTransaction): Promise<void> {
    await this.kv.put(this.table, { pk: `LOGIN#${tx.state}`, sk: 'META', ...tx, expiresAt: Math.floor(tx.createdAt / 1000) + 600 });
  }

  /** Reads and deletes the login transaction (single use). */
  async takeLogin(state: string, now: number): Promise<LoginTransaction | undefined> {
    const i = await this.kv.delete(this.table, { pk: `LOGIN#${state}`, sk: 'META' });
    if (!i) return undefined;
    const tx = { state, verifier: String(i['verifier']), nonce: String(i['nonce']), createdAt: Number(i['createdAt']) };
    if (now - tx.createdAt > 600_000) return undefined;
    return tx;
  }
}
