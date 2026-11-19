import { ListEmailIdentitiesCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { RecipientVerification, SesIdentity, VerificationSnapshot } from './recipient-verification';

/** No cache: a refresh or a new freeze reads the current region's SES identities. */
export class SesRecipientVerification implements RecipientVerification {
  constructor(private readonly ses = new SESv2Client({})) {}
  async snapshot(): Promise<VerificationSnapshot> {
    const identities: SesIdentity[] = [];
    let nextToken: string | undefined;
    do {
      const response = await this.ses.send(new ListEmailIdentitiesCommand({ PageSize: 1000, NextToken: nextToken }));
      for (const identity of response.EmailIdentities ?? []) {
        if (!identity.IdentityName || (identity.IdentityType !== 'EMAIL_ADDRESS' && identity.IdentityType !== 'DOMAIN')) continue;
        identities.push({ name: identity.IdentityName, type: identity.IdentityType, status: identity.VerificationStatus ?? 'NOT_STARTED', verified: identity.VerificationStatus === 'SUCCESS' && identity.SendingEnabled === true });
      }
      nextToken = response.NextToken;
    } while (nextToken);
    return { region: await this.ses.config.region(), checkedAt: new Date().toISOString(), identities };
  }
}
