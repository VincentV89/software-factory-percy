/**
 * NFR-PERF-04 capacity harness: drives the real send path (saga, workers, rate limiter, aggregator)
 * with a stubbed SES at a configured rate and reports emails per second per worker and end to end.
 *   npx tsx scripts/capacity-harness.ts --recipients 2000 --rate 20 --concurrency 5 [--ses-latency-ms 40]
 * Runs in-process on a virtual clock, so results describe the algorithm and limiter, not AWS latency.
 */
import { VirtualClock, setLogLevel } from '@percy/shared';
import { createSystem } from '../apps/local/src/system';
import { arg } from './lib';

setLogLevel('ERROR');
const recipients = Number(arg('recipients', '2000'));
const rate = Number(arg('rate', '20'));
const concurrency = Number(arg('concurrency', '5'));
const latency = Number(arg('ses-latency-ms', '40'));
const clock = new VirtualClock();
const sys = createSystem({ clock, rates: { standard: rate, bulk: rate }, workerConcurrency: concurrency });
sys.ses.latencyMs = latency;
await sys.bootstrap('harness@percy.local');
const agency = await sys.tenancy.createAgency('Harness');
const team = await sys.tenancy.createTeam(agency.agencyId, 'Harness', 'standard');
const list = await sys.lists.create(team.teamId, agency.agencyId, 'harness');
const csv = ['email,name', ...Array.from({ length: recipients }, (_, i) => `success+h${i}@simulator.amazonses.com,H${i}`)].join('\n');
const created = await sys.imports.create(team.teamId, list.listId, 'harness');
await sys.upload(created.upload.fields['key'] ?? '', new TextEncoder().encode(csv));
await sys.settle();
// The send spec is written before the freeze request, exactly as engine-schedule-fire does (ADR-04).
const spec = { campaignId: 'harness', teamId: team.teamId, agencyId: agency.agencyId, agencyName: 'Harness', tier: 'standard', listId: list.listId, senderName: 'H', fromAddress: 'h@example.gov.sg', template: { subject: 'Hi {{name}}', html: '<p>{{name}} {{unsubscribe_url}}</p>', text: '{{name}} {{unsubscribe_url}}' }, requiredFields: ['name'], createdAt: new Date().toISOString() };
await sys.store.put('engine-artifacts', 'specs/harness.json', JSON.stringify(spec));
const start = clock.now();
// AudienceFrozen goes through the outbox and bus to the saga, as in AWS.
await sys.freezes.handle({ freezeId: 'h1', requestRef: `${team.teamId}:harness`, agencyId: agency.agencyId, teamId: team.teamId, listId: list.listId, requiredFields: ['name'] });
while (sys.ses.calls.length < recipients && clock.now() - start < 24 * 3600_000) await clock.advance(1000);
const times = sys.ses.calls.map((c) => c.at).sort((a, b) => a - b);
const seconds = ((times[times.length - 1] ?? start) - (times[0] ?? start)) / 1000 || 1;
const perSecond = times.length / seconds;
console.log(JSON.stringify({ recipients, configuredRate: rate, concurrency, sesLatencyMs: latency, sent: times.length, endToEndPerSecond: Number(perSecond.toFixed(2)), perWorkerPerSecond: Number((perSecond / concurrency).toFixed(2)), duplicates: times.length - new Set(sys.ses.calls.map((c) => c.to)).size, errors: sys.errors.length }, null, 2));
