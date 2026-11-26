import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildEventEnvelope, type EventEnvelope } from '@tpa/event-contracts';
import { NonRetryableEventError, type InboxHandler, type ParkReason, type QuarantineSink, type RecordSource } from '@tpa/database/inbox';
import type { TenantDatabase } from '@tpa/database/tenant';
import type { OwnerAlert } from '../src/consumers/alerts.ts';
import { handleRecord, parseRecord, type ConsumerDeps, type IncomingRecord } from '../src/consumers/consumer.ts';
import { allowlistAuthorizer, runReplayCommand, ReplayUsageError } from '../src/consumers/replay.ts';

const MARKER = 'PT17-SYNTHETIC-MARKER-079123456789';
const tenant = randomUUID();
const handler: InboxHandler = { consumerName: 'unit-projection', owner: 'platform-events', eventTypes: ['claim.submitted'],
  ordering: 'aggregate-version', async apply() {} };
const db = {} as TenantDatabase;
function record(overrides: Partial<IncomingRecord> = {}, envelope?: EventEnvelope): IncomingRecord {
  const built = buildEventEnvelope(tenant, { eventType: 'claim.submitted', aggregateId: randomUUID(), aggregateVersion: 1,
    correlationId: randomUUID(), causationId: randomUUID(), payload: {} });
  const e = envelope ?? built.envelope;
  return { topic: 'tpa.unit.claim', partition: 0, offset: '5', key: Buffer.from(`${e.tenantId}:${e.aggregateId}`),
    value: Buffer.from(JSON.stringify(e)), headers: { 'tpa-event-id': Buffer.from(e.eventId) }, ...overrides };
}
function deps(overrides: Partial<ConsumerDeps> = {}) {
  const alerts: OwnerAlert[] = [];
  const quarantined: [RecordSource, string][] = [];
  const parked: [ParkReason, number, string][] = [];
  const quarantine: QuarantineSink = { async quarantine(_c, source, _raw, reason) { quarantined.push([source, reason]); return true; }, async close() {} };
  const d: ConsumerDeps = {
    db, quarantine, handler, topicPrefix: 'tpa.unit', maxAttempts: 3, retryBackoffMs: 1,
    alerts: { alert: a => alerts.push(a) },
    park: async (_db, _h, _e, reason, attempts, error) => { parked.push([reason, attempts, (error as Error).name]);
      return { kind: 'parked', parkedId: randomUUID(), reason, created: true }; },
    ...overrides,
  };
  return { d, alerts, quarantined, parked };
}

test('poison records are classified and quarantined with an owner alert; content never surfaces', async () => {
  const good = record();
  const tampered = JSON.parse(good.value!.toString());
  const cases: [IncomingRecord, string][] = [
    [record({ value: null }), 'UNPARSEABLE'],
    [record({ value: Buffer.from(`not json ${MARKER}`) }), 'UNPARSEABLE'],
    [record({ value: Buffer.from(JSON.stringify({ ...tampered, payload: { note: MARKER } })) }), 'SCHEMA_INVALID'],
    [record({ key: Buffer.from(`${tenant}:${randomUUID()}`) }, tampered), 'ROUTING_MISMATCH'],
    [record({ headers: { 'tpa-event-id': Buffer.from(randomUUID()) } }, tampered), 'ROUTING_MISMATCH'],
    [record({ topic: 'tpa.unit.payment' }, tampered), 'ROUTING_MISMATCH'],
  ];
  for (const [input, reason] of cases) {
    const { d, alerts, quarantined } = deps({ process: async () => { throw new Error('must not process poison'); } });
    assert.deepEqual(await handleRecord(d, input), { kind: 'quarantined', reason, created: true });
    assert.equal(quarantined.length, 1);
    assert.deepEqual(alerts.map(a => [a.kind, a.reasonCode, a.owner]), [['RECORD_QUARANTINED', reason, 'platform-events']]);
    assert.ok(!JSON.stringify(alerts).includes(MARKER));
  }
  assert.ok('envelope' in parseRecord(good, 'tpa.unit'));
});

test('transient failures retry with backoff and succeed without parking', async () => {
  let calls = 0;
  const heartbeats: number[] = [];
  const { d, parked, alerts } = deps({ process: async () => { if (++calls < 3) throw new Error('db blip'); return { kind: 'applied', version: 1 }; } });
  assert.deepEqual(await handleRecord(d, record(), async () => { heartbeats.push(calls); }), { kind: 'applied', version: 1 });
  assert.equal(calls, 3);
  assert.deepEqual(heartbeats, [1, 2], 'heartbeat between retries keeps group membership');
  assert.deepEqual([parked, alerts], [[], []]);
});

test('retries are bounded: exhausted events park with RETRY_EXHAUSTED and alert the owner', async () => {
  let calls = 0;
  const { d, parked, alerts } = deps({ process: async () => { calls++; throw new TypeError(`downstream ${MARKER}`); } });
  const outcome = await handleRecord(d, record());
  assert.equal(outcome.kind, 'parked');
  assert.equal(calls, 3);
  assert.deepEqual(parked, [['RETRY_EXHAUSTED', 3, 'TypeError']]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'EVENT_PARKED');
  assert.equal(alerts[0].attempts, 3);
  assert.equal(alerts[0].tenantId, tenant);
  assert.ok(!JSON.stringify(alerts).includes(MARKER), 'alerts carry codes, not error messages');
});

test('non-retryable rejection parks immediately; duplicates and stale outcomes do not alert', async () => {
  let calls = 0;
  const { d, parked } = deps({ process: async () => { calls++; throw new NonRetryableEventError(); } });
  assert.equal((await handleRecord(d, record())).kind, 'parked');
  assert.equal(calls, 1);
  assert.deepEqual(parked, [['HANDLER_REJECTED', 1, 'NonRetryableEventError']]);
  for (const result of [{ kind: 'duplicate' }, { kind: 'stale', version: 4 }, { kind: 'ignored' },
    { kind: 'parked', parkedId: randomUUID(), reason: 'BLOCKED_BY_PARKED', created: false }] as const) {
    const run = deps({ process: async () => result });
    assert.deepEqual(await handleRecord(run.d, record()), result);
    assert.equal(run.alerts.length, 0);
  }
  const blocked = deps({ process: async () => ({ kind: 'parked', parkedId: randomUUID(), reason: 'BLOCKED_BY_PARKED', created: true }) });
  await handleRecord(blocked.d, record());
  assert.deepEqual(blocked.alerts.map(a => a.reasonCode), ['BLOCKED_BY_PARKED'], 'live parking alerts once');
});

test('replay authorization allowlist fails closed', async () => {
  const op = randomUUID();
  const req = (actorId: string) => ({ action: 'event.replay' as const, tenantId: tenant, consumerName: 'unit-projection', actorId });
  assert.equal(await allowlistAuthorizer(undefined)(req(op)), false);
  assert.equal(await allowlistAuthorizer('')(req(op)), false);
  assert.equal(await allowlistAuthorizer(`${op},not-a-uuid`)(req(op)), false, 'any malformed entry disables the list');
  assert.equal(await allowlistAuthorizer(` ${op.toUpperCase()} `)(req(op)), true);
  assert.equal(await allowlistAuthorizer(op)(req(randomUUID())), false);
});

test('replay command validates arguments before touching the database', async () => {
  const untouchable = { withTenantTransaction() { throw new Error('db touched'); }, async close() {} } as unknown as TenantDatabase;
  const base = { db: untouchable, handlers: [handler], authorize: async () => true, out() {} };
  const op = randomUUID();
  for (const argv of [[], ['drop'], ['list', '--tenant', 'x', '--consumer', 'unit-projection'],
    ['list', '--tenant', tenant, '--consumer', 'unknown-consumer'], ['replay', '--tenant', tenant, '--consumer', 'unit-projection'],
    ['replay', '--tenant', tenant, '--consumer', 'unit-projection', '--operator', op, '--parked', 'x'],
    ['discard', '--tenant', tenant, '--consumer', 'unit-projection', '--operator', op],
    ['list', '--tenant', tenant, '--consumer', 'unit-projection', '--tenant', tenant], ['list', '--sql', 'DROP']]) {
    await assert.rejects(runReplayCommand(argv, base), ReplayUsageError, JSON.stringify(argv));
  }
});
