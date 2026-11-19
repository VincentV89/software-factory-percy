import { describe, expect, it } from 'vitest';
import { recipientStatus, type VerificationSnapshot } from '../src/recipient-verification';
const snapshot: VerificationSnapshot = { region: 'ap-southeast-1', checkedAt: '2026-11-19T00:00:00Z', identities: [
  { name: 'verified@inbox.test', type: 'EMAIL_ADDRESS', status: 'SUCCESS', verified: true },
  { name: 'pending@inbox.test', type: 'EMAIL_ADDRESS', status: 'PENDING', verified: false },
  { name: 'example.test', type: 'DOMAIN', status: 'SUCCESS', verified: true },
  { name: 'pending.test', type: 'DOMAIN', status: 'PENDING', verified: false },
] };
describe('SES recipient eligibility', () => {
  it.each([
    [' VERIFIED@INBOX.TEST ', true, 'VERIFIED_EMAIL'],
    ['new@example.test', true, 'VERIFIED_DOMAIN'],
    ['new@sub.example.test', true, 'VERIFIED_DOMAIN'],
    ['success+case@simulator.amazonses.com', true, 'SIMULATOR'],
    ['bounce@simulator.amazonses.com', true, 'SIMULATOR'],
    ['pending@inbox.test', false, 'PENDING'],
    ['new@pending.test', false, 'PENDING'],
    ['new@evil-example.test', false, 'NOT_VERIFIED'],
    ['new@example.test.evil', false, 'NOT_VERIFIED'],
    ['success@simulator.amazonses.com.evil', false, 'NOT_VERIFIED'],
    ['simulator.amazonses.com', false, 'NOT_VERIFIED'],
    ['unknown@inbox.test', false, 'NOT_VERIFIED'],
  ])('%s has the expected status', (email, allowed, status) => {
    expect(recipientStatus(email, snapshot)).toMatchObject({ allowed, status });
  });
  it('allows inherited domain verification even if an explicit email identity is still pending', () => {
    expect(recipientStatus('pending@example.test', { ...snapshot, identities: [...snapshot.identities, { name: 'pending@example.test', type: 'EMAIL_ADDRESS', status: 'PENDING', verified: false }] })).toMatchObject({ allowed: true, status: 'VERIFIED_DOMAIN' });
  });
});
