# Runbook: deploy, verify and tear down a dev instance

The build runtime has no AWS credentials (U1), so nothing below has been run yet. Each step
says how to confirm it worked.

## 0. Prerequisites

- One AWS account for dev, region ap-southeast-1, and an operator role with CloudFormation admin rights.
- Node 22+ and `npm ci` at the repo root.
- The Lambda concurrency quota is at least 100. New accounts often have a quota of 10, which makes
  reserved concurrency fail (risk R3). Check it with
  `aws service-quotas get-service-quota --service-code lambda --quota-code L-B99A9384` and request
  an increase first if it is lower.

## 1. Bootstrap and deploy

```bash
export CDK_DEFAULT_ACCOUNT=<account-id>
npm run spa:build
cd apps/infra
npx cdk bootstrap aws://$CDK_DEFAULT_ACCOUNT/ap-southeast-1 aws://$CDK_DEFAULT_ACCOUNT/us-east-1
npx cdk deploy --all -c instance=dev -c sesIdentity=<your-verified-sender@agency.gov.sg> -c account=$CDK_DEFAULT_ACCOUNT
```

To verify, check that all six stacks reach `CREATE_COMPLETE`. Then read `/percy/dev/public-base-url`
in SSM: it holds the CloudFront URL.

## 2. SES identity (U2 default: email identity)

`percy-account` creates the email identity, and SES sends a verification mail to that address.
Click the link in it. The account stays in the SES sandbox, which allows 1 email per second and
200 per day (risk R4). Verify each real test recipient as an email identity, or verify its domain. Mailbox-simulator
addresses need no verification.

The dev instance reads SES verification live in its sending region. There is no separate fixed
Percy recipient allow-list to edit or redeploy. Lists and campaigns show **SES recipient verification**;
click **Refresh SES status** after completing verification. Percy checks again during audience freeze,
and refuses the send if an eligible recipient is unverified or SES status cannot be read. Suppressions
still apply independently. Only the ContactSG API and freeze function have read-only
`ses:ListEmailIdentities` permission; production behavior is unchanged.

## 3. First platform admin and officers

```bash
POOL=$(aws cognito-idp list-user-pools --max-results 20 --query "UserPools[?Name=='percy-dev-officers'].Id" --output text)
npx tsx scripts/bootstrap-platform-admin.ts --instance dev --email you@agency.gov.sg --user-pool-id $POOL
npx tsx scripts/create-officers.ts --user-pool-id $POOL --emails officer1@agency.gov.sg,officer2@agency.gov.sg
```

To verify, sign in at the public URL. The admin screen should list no agencies, and you should be
able to create one.

## 4. E2E-01

```bash
npx tsx scripts/e2e-fixtures.ts --instance dev --user-pool-id $POOL     # prints the exports
eval "$(npx tsx scripts/e2e-fixtures.ts --instance dev --user-pool-id $POOL | grep ^export)"
PERCY_BASE_URL=$(aws ssm get-parameter --name /percy/dev/public-base-url --query Parameter.Value --output text) npm run e2e:dev
```

The run sends about 130 emails, so it fits the sandbox's daily limit about once a day. Also check
these deployed-only behaviours:

- **GuardDuty:** step 2 ends `REJECTED_MALWARE`, and `quarantine/` holds the object for one day.
  Confirm the GuardDuty Malware Protection size and region limits for 200 MB uploads (risk R10).
- **Audit:** within 60 s, objects appear under `s3://<audit-bucket>/audit/yyyy/MM/dd/`. Check that
  each officer action in the run has exactly one record, and that no record contains `@`.
- **Feedback:** the bounce and complaint simulator addresses appear in `percy-dev-contactsg-suppressions`
  within 15 minutes (NFR-SAFE-03).
- **Pipes:** `percy-dev-contactsg-test-events` receives `ImportCompleted`, `SuppressionAdded` and
  `AudienceFrozen` (FR-CON-08).
- **Fake parity:** run `PERCY_DDB_ENDPOINT=https://dynamodb.ap-southeast-1.amazonaws.com PERCY_DDB_TABLE=<scratch table with pk/sk> npx vitest run tests/integration/kv-parity.test.ts`
  before trusting the local safety tests (risk R2).

## 5. Performance (recorded, not gated)

- NFR-PERF-01: run a k6-style script with 100 virtual officers against `/api/*` reads and writes.
  Record p95 latency.
- NFR-PERF-02/03: import a 1,000,000-row CSV, freeze it, and call `audience-count`. Record the
  durations. The import Validate step loads the whole file into a 3 GB Lambda; if 200 MB files fail,
  switch it to streaming.
- NFR-PERF-04: run `scripts/capacity-harness.ts` locally. Use it with a stubbed SES in dev to size
  reserved concurrency.

## 6. Teardown (NFR-INF-06)

```bash
cd apps/infra && npx cdk destroy --all -c instance=dev
```

Dev tables and buckets are deleted. The audit bucket is retained on purpose: its policy denies
`s3:DeleteObject*`. To remove it, delete the bucket policy as the account admin, empty the bucket,
then delete it. Delete the `/percy/dev/e2e/*` secrets by hand.
