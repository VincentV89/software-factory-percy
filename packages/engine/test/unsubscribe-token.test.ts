import { describe, expect, it } from 'vitest';
import { base64url } from '@percy/shared';
import { parseUnsubscribeSecret, signUnsubscribeToken, verifyUnsubscribeToken } from '../src/domain/unsubscribe-token';

const keys = { current: 'k2', keys: { k1: 'old-key', k2: 'new-key' } };
const claims = { campaignId: 'cmp1', agencyId: 'agy1', addrHash: 'a'.repeat(64) };

describe('unsubscribe token (FR-UNS-01, FR-UNS-03)', () => {
  it('round-trips and carries no readable address', () => {
    const token = signUnsubscribeToken(claims, keys);
    expect(token).not.toContain('@');
    expect(verifyUnsubscribeToken(token, keys)).toEqual({ kid: 'k2', ...claims });
  });

  it('still verifies tokens signed with an older kid after rotation', () => {
    const old = signUnsubscribeToken(claims, { current: 'k1', keys: keys.keys });
    expect(verifyUnsubscribeToken(old, keys)?.kid).toBe('k1');
  });

  it('rejects tampered, unknown-key and malformed tokens', () => {
    const token = signUnsubscribeToken(claims, keys);
    const [payload, sig] = token.split('.') as [string, string];
    const forged = base64url(Buffer.from(payload, 'base64url').toString().replace('agy1', 'agy2'));
    expect(verifyUnsubscribeToken(`${forged}.${sig}`, keys)).toBeUndefined();
    expect(verifyUnsubscribeToken(`${payload}.${sig.slice(1)}x`, keys)).toBeUndefined();
    expect(verifyUnsubscribeToken(token, { current: 'k3', keys: { k3: 'other' } })).toBeUndefined();
    expect(verifyUnsubscribeToken('not-a-token', keys)).toBeUndefined();
    expect(verifyUnsubscribeToken(`${token}.extra`, keys)).toBeUndefined();
    expect(verifyUnsubscribeToken(`${base64url('v2.k2.a.b.c')}.${sig}`, keys)).toBeUndefined();
    expect(verifyUnsubscribeToken('x'.repeat(600), keys)).toBeUndefined();
  });

  it('refuses unsafe claim characters and missing current key', () => {
    expect(() => signUnsubscribeToken({ ...claims, campaignId: 'a.b' }, keys)).toThrow();
    expect(() => signUnsubscribeToken(claims, { current: 'k9', keys: keys.keys })).toThrow();
  });

  it('parses the Secrets Manager formats', () => {
    expect(parseUnsubscribeSecret('{"current":"k1","k1":"abc"}')).toEqual({ current: 'k1', keys: { k1: 'abc' } });
    expect(parseUnsubscribeSecret('{"current":"k2","keys":{"k2":"z"}}')).toEqual({ current: 'k2', keys: { k2: 'z' } });
    expect(() => parseUnsubscribeSecret('{"k1":"abc"}')).toThrow();
    expect(() => parseUnsubscribeSecret('{"current":"k2","k1":"abc"}')).toThrow();
  });
});
