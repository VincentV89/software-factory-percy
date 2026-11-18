import { describe, expect, it } from 'vitest';
import { Forbidden, ValidationError } from '@percy/shared';
import type { Principal } from '@percy/platform-contract';
import { authorizeScope, checkScheduleTime, parseScope, scopesCovering, validateReason } from '../src/domain/rules';
import { contribution, counterDelta, parseRequestRef, requestRefOf, sendlogKeys, zeroCounters } from '../src/domain/send';

const principal = (over: Partial<Principal> = {}): Principal => ({ officerId: 'o1', platformAdmin: false, agencyAdmin: [], teams: [], sessionId: 's', ...over });

describe('send-log counters (ADR-09)', () => {
  it('maps statuses and flags to counters', () => {
    expect(contribution({ status: 'SENT', delivered: true, bounced: 'hard', complained: true })).toEqual({ sent: 1, delivered: 1, bouncedHard: 1, complained: 1 });
    expect(contribution({ status: 'SENT', bounced: 'soft' })).toEqual({ sent: 1, bouncedSoft: 1 });
    expect(contribution({ status: 'IN_DOUBT' })).toEqual({ inDoubt: 1 });
    expect(contribution(undefined)).toEqual({});
    expect(contribution({ pk: 'x' })).toEqual({});
  });

  it('derives deltas from old and new images', () => {
    expect(counterDelta(undefined, { status: 'PENDING' })).toEqual({ pending: 1 });
    expect(counterDelta({ status: 'PENDING' }, { status: 'SENDING' })).toEqual({ pending: -1, sending: 1 });
    expect(counterDelta({ status: 'SENT' }, { status: 'SENT', delivered: true })).toEqual({ delivered: 1 });
    expect(counterDelta({ status: 'SENT' }, { status: 'SENT' })).toEqual({});
    expect(Object.values(zeroCounters()).every((v) => v === 0)).toBe(true);
  });

  it('keys and request refs', () => {
    expect(sendlogKeys.partPk('c', 3)).toBe('CMP#c#P#00003');
    expect(sendlogKeys.rowSk(12)).toBe('R#000012');
    expect(parseRequestRef(requestRefOf({ teamId: 't', campaignId: 'c' }))).toEqual({ teamId: 't', campaignId: 'c' });
    expect(() => parseRequestRef('nope')).toThrow();
  });
});

describe('kill switch scope rules (FR-CTL-04)', () => {
  const teamAgency = async (t: string) => (t === 'tA' ? 'agyA' : t === 'tB' ? 'agyB' : undefined);

  it('scopes covering a campaign', () => {
    expect(scopesCovering('a', 't')).toEqual(['GLOBAL', 'AGENCY#a', 'TEAM#t']);
    expect(parseScope('TEAM#t1')).toEqual({ kind: 'TEAM', teamId: 't1' });
    expect(() => parseScope('TEAM#')).toThrow(ValidationError);
    expect(() => parseScope('global')).toThrow(ValidationError);
  });

  it('platform admins may use any scope', async () => {
    const p = principal({ platformAdmin: true });
    await expect(authorizeScope(p, 'GLOBAL', teamAgency)).resolves.toEqual({});
    await expect(authorizeScope(p, 'TEAM#tB', teamAgency)).resolves.toEqual({ agencyId: 'agyB' });
    await expect(authorizeScope(p, 'AGENCY#agyB', teamAgency)).resolves.toEqual({ agencyId: 'agyB' });
  });

  it('agency admins only their agency or its teams (AC2)', async () => {
    const p = principal({ agencyAdmin: [{ agencyId: 'agyA', agencyName: 'A' }] });
    await expect(authorizeScope(p, 'AGENCY#agyA', teamAgency)).resolves.toEqual({ agencyId: 'agyA' });
    await expect(authorizeScope(p, 'TEAM#tA', teamAgency)).resolves.toEqual({ agencyId: 'agyA' });
    await expect(authorizeScope(p, 'GLOBAL', teamAgency)).rejects.toBeInstanceOf(Forbidden);
    await expect(authorizeScope(p, 'AGENCY#agyB', teamAgency)).rejects.toBeInstanceOf(Forbidden);
    await expect(authorizeScope(p, 'TEAM#tB', teamAgency)).rejects.toBeInstanceOf(Forbidden);
    await expect(authorizeScope(p, 'TEAM#unknown', teamAgency)).rejects.toBeInstanceOf(Forbidden);
  });

  it('reason must be 10–500 characters (AC1)', () => {
    expect(() => validateReason(undefined)).toThrow(ValidationError);
    expect(() => validateReason('short')).toThrow(ValidationError);
    expect(() => validateReason('x'.repeat(501))).toThrow(ValidationError);
    expect(validateReason('  long enough reason  ')).toBe('long enough reason');
  });

  it('schedule window is 5 minutes to 30 days (FR-SCH-01 AC2)', () => {
    const now = 1_000_000_000_000;
    expect(() => checkScheduleTime(now + 4 * 60_000, now)).toThrow(ValidationError);
    expect(() => checkScheduleTime(now + 31 * 24 * 3600_000, now)).toThrow(ValidationError);
    expect(() => checkScheduleTime(now + 10 * 60_000, now)).not.toThrow();
  });
});
