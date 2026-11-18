/**
 * FR-TEN-06: create the first platform admin on a fresh deployment.
 *   npx tsx scripts/bootstrap-platform-admin.ts --instance dev --email you@agency.gov.sg [--user-pool-id ap-southeast-1_x]
 * With --user-pool-id it also creates the Cognito user (Cognito emails a temporary password).
 */
import { AdminCreateUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoKvStore } from '@percy/shared/dynamo';
import { FirehoseAuditClient } from '@percy/platform-contract/aws';
import { TenancyRepo, bootstrapPlatformAdmin } from '@percy/platform';
import { arg, auditStream, flag, tableName } from './lib';

const instance = arg('instance', 'dev');
const email = arg('email');
const pool = process.argv.includes('--user-pool-id') ? arg('user-pool-id') : undefined;
const tenancy = new TenancyRepo(new DynamoKvStore(), tableName(instance, 'platform-tenancy'), tableName(instance, 'platform-outbox'), Date.now);
const out = await bootstrapPlatformAdmin(tenancy, new FirehoseAuditClient(auditStream(instance)), email, { force: flag('force') });
if (pool) {
  await new CognitoIdentityProviderClient({}).send(
    new AdminCreateUserCommand({ UserPoolId: pool, Username: email, UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }], DesiredDeliveryMediums: ['EMAIL'] }),
  );
}
console.log(`platform admin ${email} → officer ${out.officerId}`);
