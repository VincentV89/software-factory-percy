/**
 * E2E-01 fixtures on a deployed dev instance (requirements §11, "created by a setup script, not by the test").
 *   npx tsx scripts/e2e-fixtures.ts --instance dev --user-pool-id <id>
 * Creates E2E Agency / E2E Team (standard), Cognito users officer-a, officer-b, admin-c with passwords
 * stored in Secrets Manager (/percy/<instance>/e2e/<user>), the memberships, and the GLOBAL suppression
 * fixture for success+supp@simulator.amazonses.com. Prints the environment for `npm run e2e:dev`.
 */
import { randomBytes } from 'node:crypto';
import { AdminCreateUserCommand, AdminSetUserPasswordCommand, CognitoIdentityProviderClient, UsernameExistsException } from '@aws-sdk/client-cognito-identity-provider';
import { CreateSecretCommand, PutSecretValueCommand, ResourceExistsException, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { hashOf, createLogger, systemClock } from '@percy/shared';
import { DynamoKvStore } from '@percy/shared/dynamo';
import { TenancyRepo } from '@percy/platform';
import { SuppressionService } from '@percy/contactsg';
import { arg, tableName } from './lib';

const instance = arg('instance', 'dev');
const pool = arg('user-pool-id');
const kv = new DynamoKvStore();
const tenancy = new TenancyRepo(kv, tableName(instance, 'platform-tenancy'), tableName(instance, 'platform-outbox'), Date.now);
const cognito = new CognitoIdentityProviderClient({});
const sm = new SecretsManagerClient({});

const agency = (await tenancy.listAgencies()).find((a) => a.name === 'E2E Agency') ?? (await tenancy.createAgency('E2E Agency'));
const team = (await tenancy.listTeams(agency.agencyId)).find((t) => t.name === 'E2E Team') ?? (await tenancy.createTeam(agency.agencyId, 'E2E Team', 'standard'));
const users = { 'officer-a': ['member'], 'officer-b': ['member', 'approver'], 'admin-c': [] } as const;
const env: string[] = [];
for (const [user, roles] of Object.entries(users)) {
  const email = arg(`${user}-email`, `${user}@e2e.percy.invalid`);
  const password = `${randomBytes(18).toString('base64url')}aA1!`;
  try {
    await cognito.send(new AdminCreateUserCommand({ UserPoolId: pool, Username: email, UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }], MessageAction: 'SUPPRESS' }));
  } catch (e) {
    if (!(e instanceof UsernameExistsException)) throw e;
  }
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: pool, Username: email, Password: password, Permanent: true }));
  const secretId = `/percy/${instance}/e2e/${user}`;
  try {
    await sm.send(new CreateSecretCommand({ Name: secretId, SecretString: password }));
  } catch (e) {
    if (!(e instanceof ResourceExistsException)) throw e;
    await sm.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: password }));
  }
  const officer = await tenancy.ensureOfficer(email);
  if (roles.length) await tenancy.setMembership(officer.officerId, team, [...roles]);
  else await tenancy.setAgencyAdmin(officer.officerId, agency.agencyId, true);
  const key = email.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  env.push(`export E2E_${user.replace('-', '_').toUpperCase()}=${email}`, `export E2E_PASSWORD_${key}=$(aws secretsmanager get-secret-value --secret-id ${secretId} --query SecretString --output text)`);
}
const suppressions = new SuppressionService({
  kv,
  tables: { contacts: tableName(instance, 'contactsg-contacts'), imports: tableName(instance, 'contactsg-imports'), suppressions: tableName(instance, 'contactsg-suppressions'), freezes: tableName(instance, 'contactsg-freezes'), outbox: tableName(instance, 'contactsg-outbox') },
  clock: systemClock,
  logger: createLogger('e2e-fixtures'),
});
await suppressions.suppress({ addrHash: hashOf('success+supp@simulator.amazonses.com'), scope: 'GLOBAL', reason: 'MANUAL' });
console.log(['# E2E-01 fixtures ready', `# agency ${agency.agencyId}, team ${team.teamId}`, ...env].join('\n'));
