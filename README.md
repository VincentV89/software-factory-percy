# Percy 2 MVP: core send path

Percy lets agency officers import contacts, build templates, get campaigns approved and send them
through Amazon SES, with a 60-second stop, a kill switch, SES feedback suppression and citizen
unsubscribe. This repository is the MVP slice described in the AI-DLC `mvp-auto-design` artifact.

## Layout

| Path | What |
|---|---|
| `packages/shared` | Kernel: errors, `Result`, ids, clock (incl. `VirtualClock`), PII-safe logger, router, outbox envelope, `KvStore` port with in-memory and DynamoDB adapters, AWS adapters |
| `packages/platform`, `platform-contract` | Tenancy, roles, tiers, sessions, BFF (OIDC + PKCE), REQUEST authorizer, audit client |
| `packages/contactsg`, `contactsg-contract` | Lists, CSV import with scan gate, suppressions, audience count, freeze; published readers |
| `packages/engine`, `engine-contract` | `src/domain` (state machine, templates, tokens), `src/cp` control plane, `src/dp` data plane |
| `packages/integrations-ses` | `EmailSender` port and SESv2 adapter |
| `apps/infra` | CDK app: `percy-account`, foundation, contactsg, engine, edgewaf (us-east-1), edge; cdk-nag; assertion and architecture tests |
| `apps/spa` | React 19 officer SPA (Vite) |
| `apps/local` | The whole system in one process on in-memory adapters, used by tests and `npm run local` |
| `tests/integration` | Journey, security, ContactSG, delivery simulation, feedback, aggregator, PII-log and fake-parity tests |
| `tests/e2e` | Playwright E2E-01 (22 steps) for a deployed instance or the local server |
| `scripts` | Bootstrap admin, create officers, E2E fixtures, kill send workers, capacity harness |
| `docs` | Runbooks and the ADR index |

## Commands

```bash
npm ci
npm run check        # eslint, tsc, vitest (+80% domain coverage), dependency-cruiser, CDK tests, cdk synth, secretlint
npm run local        # local Percy on http://localhost:4173 (build the SPA first: npm run spa:build)
npm run e2e:local    # Playwright E2E-01 against the local server
PERCY_BASE_URL=https://<distribution> npm run e2e:dev   # E2E-01 against a deployed dev instance
npx tsx scripts/capacity-harness.ts --recipients 2000 --rate 20 --concurrency 5
```

`npm run check` needs only Node: no Docker, Java or AWS credentials. Synth output goes to
`/tmp/percy-cdk.out`. Deployment is described in `docs/runbooks/deploy.md`.

## Boundaries

dependency-cruiser enforces the context rules in `.dependency-cruiser.cjs`. ContactSG never imports
the Engine. The Engine data plane and control plane never import each other. Contexts meet only
through `*-contract` packages, bus events, queues and owner-published read-only adapters. The
template architecture tests in `apps/infra/test` check the same rules in IAM: one writer context
per table, and no data-plane role that can write a control-plane table, invoke a control-plane
function or call `percy-cp`.
