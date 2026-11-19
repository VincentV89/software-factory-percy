/**
 * A19: officers are created in Cognito by an admin script (no self-registration).
 *   npx tsx scripts/create-officers.ts --user-pool-id <id> --emails a@x.gov.sg,b@x.gov.sg
 * Memberships are granted afterwards in the Admin screen or the Platform API.
 */
import { AdminCreateUserCommand, CognitoIdentityProviderClient, UsernameExistsException } from '@aws-sdk/client-cognito-identity-provider';
import { arg } from './lib';

const pool = arg('user-pool-id');
const cognito = new CognitoIdentityProviderClient({});
for (const email of arg('emails').split(',').map((e) => e.trim()).filter(Boolean)) {
  try {
    await cognito.send(new AdminCreateUserCommand({ UserPoolId: pool, Username: email, UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }], DesiredDeliveryMediums: ['EMAIL'] }));
    console.log(`created ${email}`);
  } catch (e) {
    if (e instanceof UsernameExistsException) console.log(`exists ${email}`);
    else throw e;
  }
}
