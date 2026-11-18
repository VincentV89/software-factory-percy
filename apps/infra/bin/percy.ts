import { buildApp } from '../src/app';

const instance = process.env['PERCY_INSTANCE'] ?? process.argv.find((a) => a.startsWith('instance='))?.slice(9);
// `cdk synth -c instance=dev` passes context through CDK_CONTEXT_JSON; buildApp reads it via App.
const { app } = buildApp(instance ?? readInstanceFromContext());
app.synth();

function readInstanceFromContext(): string {
  const raw = process.env['CDK_CONTEXT_JSON'];
  const ctx = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  return typeof ctx['instance'] === 'string' ? ctx['instance'] : 'dev';
}
