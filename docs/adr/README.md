# Architecture decisions

The decisions are recorded in the AI-DLC `mvp-auto-design` artifact (section 11). This index
lists them and the places where the implementation differs from the design.

| ADR | Decision | Where |
|---|---|---|
| ADR-01 | Monorepo of four contexts with contract packages | `packages/*`, `.dependency-cruiser.cjs` |
| ADR-02 | BFF and REQUEST authorizer over server-side sessions, TTL 0 | `packages/platform/src/{bff,authorizer}.ts` |
| ADR-03 | The control plane sends the FIFO command before writing state | `packages/engine/src/cp/campaigns.ts` (`control`) |
| ADR-04 | The send spec is in S3 and is written before the freeze request | `cp/campaigns.ts` (`fire`), `dp/deps.ts` (`loadSpec`) |
| ADR-05 | At-most-once worker | `packages/engine/src/dp/worker.ts` |
| ADR-06 | DynamoDB per-second rate window | `packages/engine/src/dp/rate-limiter.ts` |
| ADR-07 | Counted audience; live suppression check at freeze and send | `contactsg/src/{imports,suppressions,freeze}.ts` |
| ADR-08 | Attributes stored per list membership | `contactsg/src/imports.ts` |
| ADR-09 | Per-partition checkpoints plus a final recount | `packages/engine/src/dp/aggregator.ts` |
| ADR-10 | Outbox table per context | `packages/shared/src/outbox.ts`, `apps/infra/src/constructs.ts` (`outboxPipe`) |
| ADR-11 | Local verification through ports and a virtual clock | `packages/shared/src/kv`, `apps/local`, `tests/integration` |
| ADR-12 | Credential-free synth; late-bound values read by name | `apps/infra/src/stacks/edge-stack.ts` |
| ADR-13 | secretlint | `.secretlintrc.json` |

## Implementation deviations

1. **Fake level (ADR-11).** Repositories are written against a small `KvStore` port that covers
   conditions, transactions, sparse GSIs, cursors and streams. The in-memory fake implements that
   port and is not a DynamoDB expression parser. `aws-sdk-client-mock` tests check the expressions
   that are actually sent. `tests/integration/kv-parity.test.ts` runs the same contract against
   real DynamoDB when `PERCY_DDB_ENDPOINT` is set.
2. **Pipes payload (ADR-10).** The pipe forwards the raw stream record and sets `detail-type` and
   `source` from the outbox row. Consumers unmarshall `detail.dynamodb.NewImage.event`
   (`unwrapBusMessage`). This avoids input templates.
3. **Import state machine.** It uses an inline `Map` with concurrency 20. A 1M-row file gives at
   most 200 chunk keys. It does not use a Distributed Map with ResultWriter.
4. **Freeze.** The freeze runs in a Lambda that saves its progress and re-enqueues itself on
   `freeze-requests` when its time budget runs out, instead of a Step Functions loop.
5. **Observability.** Logging uses an in-house JSON logger with the deny-list and email redaction,
   in place of the Powertools Logger. Tracing is Lambda and Step Functions active X-Ray. Custom
   metrics use `PutMetricData`.
6. **`sesCalledAt`.** It is written in the same conditional claim write, right before the SES call,
   which saves one write per recipient.
7. **FR-DLV-08 (officer resend of in-doubt recipients)** is not built. U5 names it as the first item
   to drop. The `RESEND` command type is accepted and ignored.
8. **Cognito client secret.** It is created by EdgeStack, where the app client is created, and read
   by the BFF by name. Foundation holds no placeholder.
9. **Platform tenancy keys.** Teams live at `TEAM#t / META`, and GSI2 lists the teams of an agency.
   Campaign lists are sorted in memory, so there is no GSI2 on `engine-campaigns`.
10. **Kill-switch fixture.** The requirements' E2E reason "E2E drill" has 9 characters, but FR-CTL-04
    requires 10–500. The tests use "E2E drill (team kill switch)".
11. **E2E step 22.** The test replays the old cookie on `/api/engine/teams/{t}/campaigns`, because
    `/api/campaigns` is not a route.
12. **Lambda runtime.** Functions run on `nodejs24.x`, the LTS the code is tested on. CDK also offers
    `nodejs26.x`. The cdk-nag L1 finding is suppressed with that reason.
13. **Audit bucket.** It is retained even in dev, because its deny-delete policy would otherwise
    block `cdk destroy`.
14. **Engine access for admins.** Agency admins (and platform admins) can read, and approve in,
    the Engine routes of teams in their agency. ContactSG routes stay limited to team members.
