/**
 * FR-CTL-07 last resort: set reserved concurrency of the send workers to 0 (no further SES calls).
 *   npx tsx scripts/kill-send-workers.ts --instance dev --tier standard|bulk|all
 *   npx tsx scripts/kill-send-workers.ts --instance dev --tier all --restore 5
 * See docs/runbooks/kill-switch-last-resort.md for the verify step.
 */
import { GetFunctionConcurrencyCommand, LambdaClient, PutFunctionConcurrencyCommand } from '@aws-sdk/client-lambda';
import { arg } from './lib';

const instance = arg('instance', 'dev');
const tier = arg('tier');
const restore = process.argv.includes('--restore') ? Number(arg('restore')) : undefined;
const tiers = tier === 'all' ? ['standard', 'bulk'] : [tier];
if (!tiers.every((t) => t === 'standard' || t === 'bulk')) throw new Error('--tier must be standard, bulk or all');
const lambda = new LambdaClient({});
for (const t of tiers) {
  const FunctionName = `percy-${instance}-send-worker-${t}`;
  await lambda.send(new PutFunctionConcurrencyCommand({ FunctionName, ReservedConcurrentExecutions: restore ?? 0 }));
  const now = await lambda.send(new GetFunctionConcurrencyCommand({ FunctionName }));
  console.log(`${FunctionName}: reserved concurrency ${now.ReservedConcurrentExecutions}`);
}
