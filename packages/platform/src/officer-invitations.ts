import { AdminCreateUserCommand, CognitoIdentityProviderClient, UsernameExistsException } from '@aws-sdk/client-cognito-identity-provider';
import { Conflict } from '@percy/shared';

export interface OfficerInvitations {
  invite(email: string): Promise<{ delivery: 'email' | 'local' }>;
}

/** Invitations create a login only; agency/team access is granted separately. */
export class CognitoOfficerInvitations implements OfficerInvitations {
  constructor(private readonly poolId: string, private readonly client = new CognitoIdentityProviderClient({})) {}

  async invite(email: string): Promise<{ delivery: 'email' | 'local' }> {
    try {
      await this.client.send(new AdminCreateUserCommand({
        UserPoolId: this.poolId, Username: email,
        UserAttributes: [{ Name: 'email', Value: email }],
        DesiredDeliveryMediums: ['EMAIL'],
      }));
      return { delivery: 'email' };
    } catch (error) {
      if (error instanceof UsernameExistsException) throw new Conflict('This officer already has a login. You can grant team access below.');
      throw error;
    }
  }
}
