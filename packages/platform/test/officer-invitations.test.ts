import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { AdminCreateUserCommand, CognitoIdentityProviderClient, UsernameExistsException } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoOfficerInvitations } from '../src/officer-invitations';

const cognito = mockClient(CognitoIdentityProviderClient);
beforeEach(() => cognito.reset());
describe('Cognito officer invitations', () => {
  it('requests email delivery without granting roles or returning credentials', async () => {
    cognito.on(AdminCreateUserCommand).resolves({});
    const invitations = new CognitoOfficerInvitations('test-pool');
    expect(await invitations.invite('new@percy.test')).toEqual({ delivery: 'email' });
    expect(cognito.commandCalls(AdminCreateUserCommand)[0]?.args[0].input).toEqual({
      UserPoolId: 'test-pool', Username: 'new@percy.test',
      UserAttributes: [{ Name: 'email', Value: 'new@percy.test' }], DesiredDeliveryMediums: ['EMAIL'],
    });
  });
  it('reports an existing login instead of resetting or resending its credentials', async () => {
    cognito.on(AdminCreateUserCommand).rejects(new UsernameExistsException({ message: 'exists', $metadata: {} }));
    await expect(new CognitoOfficerInvitations('test-pool').invite('existing@percy.test')).rejects.toMatchObject({ status: 409 });
  });
});
