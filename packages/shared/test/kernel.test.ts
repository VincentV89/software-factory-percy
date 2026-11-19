import { describe, expect, it } from 'vitest';
import { Router, VirtualClock, addressHash, createLogger, hashOf, json, normaliseEmail, redact, setLogSink, unwrapBusMessage, makeEvent, NotFound, ValidationError } from '../src';

describe('email normalisation and hashing (FR-CON-02)', () => {
  it('trims, lower-cases the whole address and hashes with SHA-256', () => {
    const a = normaliseEmail('  Alice@Example.gov.sg ');
    expect(a).toEqual({ ok: true, value: 'alice@example.gov.sg' });
    if (a.ok) expect(addressHash(a.value)).toBe(hashOf('alice@example.gov.sg'));
    expect(hashOf('x@y.co')).toMatch(/^[0-9a-f]{64}$/);
    expect(normaliseEmail('')).toEqual({ ok: false, error: 'email is empty' });
    expect(normaliseEmail('a@b')).toEqual({ ok: false, error: 'email syntax is invalid' });
    expect(normaliseEmail(`${'a'.repeat(250)}@b.co`).ok).toBe(false);
    expect(() => hashOf('nope')).toThrow();
  });
});

describe('PII-safe logger (NFR-SEC-03)', () => {
  it('drops deny-listed keys and masks email-like values', () => {
    const lines: string[] = [];
    const prev = setLogSink((l) => lines.push(l));
    createLogger('t', { campaignId: 'c1' }).child({ r: 1 }).warn('sent to someone@agency.gov.sg', { email: 'x@y.com', mergeName: 'Ann', nested: { to: 'z@q.io' }, attrs: { name: 'A' } });
    setLogSink(prev);
    const record = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(record).toMatchObject({ level: 'WARN', message: 'sent to [email]', email: '[redacted]', mergeName: '[redacted]', attrs: '[redacted]', nested: { to: '[email]' }, campaignId: 'c1', r: 1 });
    expect(redact(new Error('bad a@b.co'))).toEqual({ name: 'Error', message: 'bad [email]' });
  });
});

describe('router and events', () => {
  it('routes, maps domain errors and rejects bad JSON', async () => {
    const r = new Router().get('/x/:id', async (ctx) => json(200, { id: ctx.params['id'] })).post('/x', async (ctx) => json(200, ctx.json())).get('/nf', async () => {
      throw new NotFound();
    });
    expect((await r.handle({ httpMethod: 'GET', path: '/x/a%20b' })).body).toBe('{"id":"a b"}');
    expect((await r.handle({ httpMethod: 'GET', path: '/nf' })).statusCode).toBe(404);
    expect((await r.handle({ httpMethod: 'GET', path: '/missing' })).statusCode).toBe(404);
    expect((await r.handle({ httpMethod: 'POST', path: '/x', body: '{bad' })).statusCode).toBe(400);
    const v = new ValidationError('bad', [{ field: 'f', reason: 'r' }]);
    expect(v.status).toBe(400);
  });

  it('unwraps bus messages from EventBridge, Pipes and direct shapes', () => {
    const e = makeEvent('percy.engine', 'SendStarted', { campaignId: 'c' }, 0);
    expect(unwrapBusMessage({ detail: e })).toEqual(e);
    expect(unwrapBusMessage(e)).toEqual(e);
    const pipes = { detail: { dynamodb: { NewImage: { event: { M: { eventId: { S: e.eventId }, type: { S: e.type }, source: { S: e.source }, occurredAt: { S: e.occurredAt }, schemaVersion: { N: '1' }, payload: { M: { campaignId: { S: 'c' } } } } } } } } };
    expect(unwrapBusMessage(pipes)).toEqual(e);
  });
});

describe('VirtualClock', () => {
  it('fires timers in order and advances time', async () => {
    const clock = new VirtualClock(0);
    const order: number[] = [];
    void clock.sleep(200).then(() => order.push(clock.now()));
    void clock.sleep(100).then(() => order.push(clock.now()));
    await clock.run();
    expect(order).toEqual([100, 200]);
    await clock.advance(1000);
    expect(clock.now()).toBe(1200);
  });
});
