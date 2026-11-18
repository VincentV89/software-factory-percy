# Runbook: last-resort stop of all sending (FR-CTL-07)

Use this only when the kill switch in the SPA or `POST /api/engine/kill-switches` does not stop
sending. Examples: the command consumer is failing, or `send-commands.fifo` has messages in its DLQ.

## Stop

```bash
npx tsx scripts/kill-send-workers.ts --instance dev --tier all      # or --tier standard | bulk
```

The script sets reserved concurrency to 0 on `percy-dev-send-worker-standard` and
`percy-dev-send-worker-bulk` and prints the value it reads back. Lambda then stops polling the
batch queues. A batch that is already running finishes its current recipient: it makes at most one
SES call, with a 10 s timeout. Unprocessed batches stay on the queues.

## Verify that no further SES calls happen

1. CloudWatch → Metrics → AWS/Lambda → `Invocations` for both worker functions: the sum is 0 for
   two consecutive minutes.
2. In the dev account, the newest `sesCalledAt` for each affected campaign stops advancing. Check
   it with `GET /api/engine/test/campaigns/<id>/send-log` (dev only), or with a query on
   `percy-dev-engine-sendlog`.
3. SES → Account dashboard: "Sends" stops growing.

## Recover

1. Fix the cause. For example, redrive or purge the commands DLQ after inspecting it.
2. Restore concurrency with `npx tsx scripts/kill-send-workers.ts --instance dev --tier all --restore 5`.
3. Workers resume only campaigns whose send status is still SENDING. Paused campaigns stay paused
   until an officer resumes them.
