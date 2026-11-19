import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { ListEmailIdentitiesCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { SesRecipientVerification } from '../src/aws-recipient-verification';
const ses = mockClient(SESv2Client);
beforeEach(() => ses.reset());
describe('live SES verification reader', () => {
  it('paginates identities and reads fresh status on every call in the configured region', async () => {
    ses.on(ListEmailIdentitiesCommand)
      .resolvesOnce({ EmailIdentities: [{ IdentityName: 'new@inbox.test', IdentityType: 'EMAIL_ADDRESS', VerificationStatus: 'PENDING', SendingEnabled: false }], NextToken: 'next' })
      .resolvesOnce({ EmailIdentities: [{ IdentityName: 'example.test', IdentityType: 'DOMAIN', VerificationStatus: 'SUCCESS', SendingEnabled: true }] })
      .resolvesOnce({ EmailIdentities: [{ IdentityName: 'new@inbox.test', IdentityType: 'EMAIL_ADDRESS', VerificationStatus: 'SUCCESS', SendingEnabled: true }] });
    const reader = new SesRecipientVerification(new SESv2Client({ region: 'ap-southeast-1' }));
    const first = await reader.snapshot();
    expect(first.region).toBe('ap-southeast-1');
    expect(first.identities).toHaveLength(2);
    expect(first.identities[0]).toMatchObject({ status: 'PENDING', verified: false });
    expect(ses.commandCalls(ListEmailIdentitiesCommand)[1]?.args[0].input.NextToken).toBe('next');
    expect((await reader.snapshot()).identities[0]).toMatchObject({ status: 'SUCCESS', verified: true });
  });
  it('does not convert an SES outage into permission to send', async () => {
    ses.on(ListEmailIdentitiesCommand).rejects(new Error('SES unavailable'));
    await expect(new SesRecipientVerification(new SESv2Client({ region: 'ap-southeast-1' })).snapshot()).rejects.toThrow('SES unavailable');
  });
});
