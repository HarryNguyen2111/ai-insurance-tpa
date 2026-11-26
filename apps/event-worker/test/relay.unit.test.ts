import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { OutboxRelayStore, PendingOutboxEvent } from '@tpa/database/outbox';
import { readRelayConfig } from '../src/config.ts';
import { toKafkaMessage } from '../src/kafka-publisher.ts';
import { OutboxRelay, type RelayLogger } from '../src/relay.ts';

const SECRET = 'SYNTHETIC-SECRET-0912345678';
function pending(tenant: string, n: number): PendingOutboxEvent[] {
  return Array.from({ length: n }, (_, i) => {
    const eventId = randomUUID(), aggregate = randomUUID();
    return { seq: String(i + 1), eventId, eventType: 'claim.submitted', schemaVersion: '1.0.0', topic: 'claim',
      partitionKey: `${tenant}:${aggregate}`, value: JSON.stringify({ eventId }) };
  });
}
/** Mirrors the real store contract: mark only after publish resolves; throw leaves rows pending. */
function fakeStore(rows: Map<string, PendingOutboxEvent[]>, busy = new Set<string>()): Pick<OutboxRelayStore, 'pendingTenants' | 'relayTenantBatch'> {
  return {
    async pendingTenants(limit) { return [...rows].filter(([, r]) => r.length > 0).map(([t]) => t).slice(0, limit); },
    async relayTenantBatch(tenant, limit, publish) {
      if (busy.has(tenant)) return { locked: false, published: 0 };
      const batch = (rows.get(tenant) ?? []).slice(0, limit);
      if (batch.length === 0) return { locked: true, published: 0 };
      await publish(batch);
      rows.set(tenant, rows.get(tenant)!.slice(batch.length));
      return { locked: true, published: batch.length };
    },
  };
}
const capture = () => {
  const lines: string[] = [];
  const logger: RelayLogger = { info: (m, f) => lines.push(JSON.stringify({ m, f })), error: (m, f) => lines.push(JSON.stringify({ m, f })) };
  return { lines, logger };
};

test('relay drains every tenant in batches and publishes in outbox order', async () => {
  const [A, B] = [randomUUID(), randomUUID()];
  const rows = new Map([[A, pending(A, 5)], [B, pending(B, 1)]]);
  const expected = [...rows.get(A)!, ...rows.get(B)!].map(e => e.eventId);
  const published: string[] = [];
  const relay = new OutboxRelay({ store: fakeStore(rows), publisher: { async publish(events) { published.push(...events.map(e => e.eventId)); } },
    batchSize: 2, maxTenantsPerCycle: 10 });
  assert.deepEqual(await relay.runOnce(), { tenants: 2, published: 6, busyTenants: 0, failedTenants: 0 });
  assert.deepEqual(published, expected);
  assert.deepEqual(await relay.runOnce(), { tenants: 0, published: 0, busyTenants: 0, failedTenants: 0 });
});

test('publish failure leaves rows pending, isolates the tenant, and logs no data', async () => {
  const [A, B] = [randomUUID(), randomUUID()];
  const rows = new Map([[A, pending(A, 2)], [B, pending(B, 2)]]);
  const { lines, logger } = capture();
  const relay = new OutboxRelay({
    store: fakeStore(rows, new Set()),
    publisher: { async publish(events) { if (events[0].partitionKey.startsWith(A)) throw new Error(`broker down ${SECRET}`); } },
    batchSize: 10, maxTenantsPerCycle: 10, logger,
  });
  assert.deepEqual(await relay.runOnce(), { tenants: 2, published: 2, busyTenants: 0, failedTenants: 1 });
  assert.equal(rows.get(A)!.length, 2, 'failed tenant stays pending for retry');
  assert.equal(rows.get(B)!.length, 0, 'healthy tenant still relayed');
  assert.ok(lines.length > 0 && lines.every(l => !l.includes(SECRET) && !l.includes(A)), 'logs carry counters only');
});

test('a tenant owned by another replica is skipped, not reordered', async () => {
  const A = randomUUID();
  const rows = new Map([[A, pending(A, 3)]]);
  let calls = 0;
  const relay = new OutboxRelay({ store: fakeStore(rows, new Set([A])), publisher: { async publish() { calls++; } }, batchSize: 10, maxTenantsPerCycle: 10 });
  assert.deepEqual(await relay.runOnce(), { tenants: 1, published: 0, busyTenants: 1, failedTenants: 0 });
  assert.equal(calls, 0);
});

test('run() backs off on failure and stops promptly on abort', async () => {
  let discoveries = 0;
  const controller = new AbortController();
  const relay = new OutboxRelay({
    store: { async pendingTenants() { discoveries++; if (discoveries === 3) controller.abort(); throw new Error('db down'); },
      async relayTenantBatch() { throw new Error('unreachable'); } },
    publisher: { async publish() {} }, batchSize: 1, maxTenantsPerCycle: 1, pollIntervalMs: 10, maxBackoffMs: 40,
  });
  const started = Date.now();
  await relay.run(controller.signal);
  assert.equal(discoveries, 3);
  assert.ok(Date.now() - started < 2000);
});

test('Kafka record: key is tenantId:aggregateId, headers carry routing ids, value is the envelope', () => {
  const [event] = pending(randomUUID(), 1);
  const message = toKafkaMessage(event);
  assert.equal(message.key, event.partitionKey);
  assert.equal(message.value, event.value);
  assert.deepEqual(message.headers, { 'tpa-event-id': event.eventId, 'tpa-event-type': 'claim.submitted',
    'tpa-schema-version': '1.0.0', 'content-type': 'application/json' });
});

test('config: tpa_app only, validated brokers/prefix/bounds, errors never echo secrets', () => {
  const base = { EVENT_RELAY_DATABASE_URL: `postgresql://tpa_app:${SECRET}@db:5432/tpa`, KAFKA_BROKERS: 'kafka:9092, k2:9092', EVENT_TOPIC_PREFIX: 'tpa.dev' };
  const config = readRelayConfig(base);
  assert.deepEqual(config.brokers, ['kafka:9092', 'k2:9092']);
  assert.equal(config.batchSize, 100);
  for (const bad of [
    { ...base, EVENT_RELAY_DATABASE_URL: `postgresql://tpa_migrator:${SECRET}@db/tpa` },
    { ...base, EVENT_RELAY_DATABASE_URL: `not a url ${SECRET}` },
    { ...base, KAFKA_BROKERS: '' }, { ...base, EVENT_TOPIC_PREFIX: 'TPA' }, { ...base, EVENT_TOPIC_PREFIX: undefined },
    { ...base, EVENT_RELAY_BATCH_SIZE: '0' }, { ...base, EVENT_RELAY_BATCH_SIZE: '1.5' },
  ]) {
    assert.throws(() => readRelayConfig(bad), (e: unknown) => e instanceof Error && !e.message.includes(SECRET));
  }
});
