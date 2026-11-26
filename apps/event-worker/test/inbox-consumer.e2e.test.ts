import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildEventEnvelope, domainTopic, topicName, type EventEnvelope } from '@tpa/event-contracts';
import { commitDomainChange, createOutboxRelayStore, type PendingOutboxEvent } from '@tpa/database/outbox';
import { createQuarantineSink, ReplayDeniedError, type InboxHandler, type QuarantineSink } from '@tpa/database/inbox';
import { createTenantDatabase, type TenantDatabase } from '@tpa/database/tenant';
import { syntheticHandler, type SyntheticOptions } from '../../../packages/database/test/fixtures/synthetic-handler.ts';
import type { OwnerAlert } from '../src/consumers/alerts.ts';
import { createInboxConsumer, type InboxConsumer } from '../src/consumers/consumer.ts';
import { allowlistAuthorizer, runReplayCommand } from '../src/consumers/replay.ts';
import { createKafkaPublisher, type KafkaEventPublisher } from '../src/kafka-publisher.ts';
import { OutboxRelay, type RelayLogger } from '../src/relay.ts';
import { startHarness, waitFor, type Harness } from './fixtures/docker-harness.ts';

// EVT-02 (#24) on real PG16 + Compose-pinned Kafka: duplicate, rebalance,
// out-of-order, gap, poison, bounded retry/parking, SIGKILL crashes and audited
// replay never repeat an effect (PT05/PT08), and nothing stored or emitted holds
// the PII marker (PT17). Each scenario has its own topic prefix + consumer group.
const MARKER = 'PT17-SYNTHETIC-MARKER-079123456789-0912345678';
const crashChild = fileURLToPath(new URL('./fixtures/inbox-crash-child.ts', import.meta.url));

test('EVT-02 inbox consumer: PG16 + Compose Kafka dedup, ordering, parking, crash, rebalance and replay', async (t) => {
  let h: Harness | undefined;
  const consumers: InboxConsumer[] = [];
  const children: ChildProcess[] = [];
  const closers: { close(): Promise<void> }[] = [];
  const publishers: KafkaEventPublisher[] = [];
  const alerts: OwnerAlert[] = [];
  const logLines: string[] = [];
  const processOutput: string[] = [];
  try {
    h = await startHarness(['packages/database/test/fixtures/consumer.sql']);
    const harness = h;
    t.diagnostic(harness.versions);
    const db: TenantDatabase = createTenantDatabase({ connectionString: harness.url('tpa_app'), max: 8 });
    const quarantine: QuarantineSink = createQuarantineSink({ connectionString: harness.url('tpa_app') });
    closers.push(db, quarantine);
    const logger: RelayLogger = { info: (m, f) => logLines.push(JSON.stringify({ m, f })), error: (m, f) => logLines.push(JSON.stringify({ m, f })) };

    let scenario = 0;
    const setup = async () => {
      const prefix = `tpa.e2e${++scenario}`;
      await harness.createTopics(['claim'].map(d => topicName(prefix, d)));
      const publisher = createKafkaPublisher({ brokers: harness.brokers, clientId: `evt02-pub-${scenario}`, topicPrefix: prefix, sendTimeoutMs: 30_000 });
      await publisher.connect();
      publishers.push(publisher);
      return { prefix, topic: topicName(prefix, 'claim'), publisher, consumerName: `e2e-projection-${scenario}` };
    };
    const startConsumer = async (prefix: string, handler: InboxHandler, overrides: { maxAttempts?: number } = {}) => {
      const consumer = createInboxConsumer({ brokers: harness.brokers, clientId: `${handler.consumerName}-${consumers.length}`, domains: ['claim'],
        topicPrefix: prefix, db, quarantine, handler, maxAttempts: overrides.maxAttempts ?? 3, retryBackoffMs: 50, sessionTimeoutMs: 8000,
        alerts: { alert: a => alerts.push(a) }, logger });
      consumers.push(consumer);
      await consumer.start();
      return consumer;
    };
    const ev = (tenant: string, aggregateId: string, aggregateVersion: number, toStatus = 'AI_PROCESSING'): Readonly<EventEnvelope> =>
      buildEventEnvelope(tenant, aggregateVersion === 1
        ? { eventType: 'claim.submitted', aggregateId, aggregateVersion, correlationId: randomUUID(), causationId: randomUUID(), payload: {} }
        : { eventType: 'claim.state-changed', aggregateId, aggregateVersion, correlationId: randomUUID(), causationId: randomUUID(),
          payload: { fromStatus: 'SUBMITTED', toStatus } }).envelope;
    const wire = (e: Readonly<EventEnvelope>): PendingOutboxEvent => ({ seq: '0', eventId: e.eventId, eventType: e.eventType,
      schemaVersion: e.schemaVersion, topic: domainTopic(e.eventType), partitionKey: `${e.tenantId}:${e.aggregateId}`, value: JSON.stringify(e) });
    const q = async <R>(tenant: string, sql: string, params: unknown[] = []) =>
      db.withTenantTransaction(tenant, async tx => (await tx.query(sql, params)).rows as R[]);
    const effects = async (tenant: string, consumer: string, eventId?: string) => (await q<{ n: number }>(tenant,
      `SELECT count(*)::int AS n FROM tpa.synthetic_effects WHERE consumer_name=$1 AND ($2::uuid IS NULL OR event_id=$2::uuid)`, [consumer, eventId ?? null]))[0].n;
    const inboxCount = async (tenant: string, consumer: string) => (await q<{ n: number }>(tenant,
      'SELECT count(*)::int AS n FROM tpa.consumer_inbox WHERE consumer_name=$1', [consumer]))[0].n;
    const outcome = async (tenant: string, eventId: string) => (await q<{ outcome: string }>(tenant,
      'SELECT outcome FROM tpa.consumer_inbox WHERE event_id=$1', [eventId]))[0]?.outcome;
    const projection = async (tenant: string, aggregate: string) => (await q<{ version: number; status: string }>(tenant,
      'SELECT version, status FROM tpa.synthetic_projection WHERE aggregate_id=$1', [aggregate]))[0];
    /** Committed group offset == log end on every partition (nothing left uncommitted). */
    const lagZero = (groupId: string, topic: string) => waitFor(`zero lag for ${groupId}`, async () => {
      const [ends, [committed]] = await Promise.all([harness.admin.fetchTopicOffsets(topic), harness.admin.fetchOffsets({ groupId, topics: [topic] })]);
      const byPartition = new Map(committed.partitions.map(p => [p.partition, p.offset]));
      return ends.every(p => p.high === '0' || byPartition.get(p.partition) === p.high) ? true : undefined;
    }, 60_000);

    await t.test('PT05/PT08 duplicates: relay output plus re-published copies (crash after ack) apply exactly once', async () => {
      const { prefix, topic, publisher, consumerName } = await setup();
      const tenant = randomUUID();
      const relayDb = createOutboxRelayStore({ connectionString: harness.url('tpa_app'), max: 2 });
      closers.push(relayDb);
      const events: Readonly<EventEnvelope>[] = [];
      for (let i = 0; i < 5; i++) {
        const aggregate = randomUUID();
        const { events: [out] } = await commitDomainChange(db, tenant, async tx => {
          await tx.query('INSERT INTO tpa.synthetic_source VALUES (tpa.current_tenant_id(), $1, 1, $2)', [aggregate, MARKER]);
          return { result: null, audit: [{ entityType: 'CLAIM', entityId: aggregate, actorType: 'SYSTEM', actorId: randomUUID(), action: 'SUBMIT', payload: {} }],
            events: [{ eventType: 'claim.submitted', aggregateId: aggregate, aggregateVersion: 1, correlationId: randomUUID(), causationId: randomUUID(), payload: {} }] };
        });
        events.push(out.envelope);
      }
      await new OutboxRelay({ store: relayDb, publisher, batchSize: 50, maxTenantsPerCycle: 100 }).runOnce();
      await publisher.publish([wire(events[0]), wire(events[3])]); // explicit duplicates, as after a relay crash post-ack
      await startConsumer(prefix, syntheticHandler({ consumerName }));
      await waitFor('5 inbox rows', async () => (await inboxCount(tenant, consumerName)) === 5 ? true : undefined);
      await lagZero(consumerName, topic);
      for (const e of events) assert.equal(await effects(tenant, consumerName, e.eventId), 1);
      assert.equal(await effects(tenant, consumerName), 5, '7 records, 5 effects');
    });

    await t.test('PT08 out-of-order and gap: v1, v3, v2 -> applied, reconciled from snapshot, stale; never rolled back', async () => {
      const { prefix, topic, publisher, consumerName } = await setup();
      const [tenant, aggregate] = [randomUUID(), randomUUID()];
      await db.withTenantTransaction(tenant, tx => tx.query("INSERT INTO tpa.synthetic_source VALUES (tpa.current_tenant_id(), $1, 3, 'EOB_READY')", [aggregate]));
      const [v1, v2, v3] = [ev(tenant, aggregate, 1), ev(tenant, aggregate, 2, 'DOCTOR_REVIEW'), ev(tenant, aggregate, 3, 'EOB_READY')];
      await publisher.publish([wire(v1), wire(v3), wire(v2)]); // same key -> same partition, delivered in this order
      await startConsumer(prefix, syntheticHandler({ consumerName, withReconcile: true }));
      await waitFor('3 inbox rows', async () => (await inboxCount(tenant, consumerName)) === 3 ? true : undefined);
      await lagZero(consumerName, topic);
      assert.deepEqual([await outcome(tenant, v1.eventId), await outcome(tenant, v3.eventId), await outcome(tenant, v2.eventId)], ['APPLIED', 'RECONCILED', 'STALE']);
      assert.deepEqual(await projection(tenant, aggregate), { version: 3, status: 'EOB_READY' });
      assert.equal(await effects(tenant, consumerName, v2.eventId), 0);
    });

    await t.test('poison records are quarantined (hash + coordinates only), alerted, and do not block the partition', async () => {
      const { prefix, topic, publisher, consumerName } = await setup();
      const [tenant, aggregate] = [randomUUID(), randomUUID()];
      const valid = ev(tenant, aggregate, 1);
      const producer = harness.kafka.producer();
      await producer.connect();
      const key = `${tenant}:${aggregate}`;
      await producer.send({ topic, acks: -1, messages: [
        { key, value: `not json ${MARKER}` },
        { key, value: JSON.stringify({ ...valid, eventId: randomUUID(), payload: { phone: MARKER } }), headers: { 'tpa-event-id': randomUUID() } },
        { key: `${tenant}:${randomUUID()}`, value: JSON.stringify(valid), headers: { 'tpa-event-id': valid.eventId } },
      ] });
      await producer.disconnect();
      await publisher.publish([wire(valid)]);
      await startConsumer(prefix, syntheticHandler({ consumerName }));
      await waitFor('valid event after poison', async () => (await effects(tenant, consumerName, valid.eventId)) === 1 ? true : undefined);
      await lagZero(consumerName, topic);
      const { rows } = await harness.pgAdmin.query('SELECT reason_code, q::text AS text FROM tpa.consumer_quarantine q WHERE consumer_name=$1 ORDER BY source_offset', [consumerName]);
      // The misrouted record has another key, so it may sit on another partition: compare as sets.
      assert.deepEqual(rows.map(r => r.reason_code).sort(), ['ROUTING_MISMATCH', 'SCHEMA_INVALID', 'UNPARSEABLE']);
      assert.ok(rows.every(r => !r.text.includes(MARKER)));
      assert.deepEqual(alerts.filter(a => a.consumerName === consumerName).map(a => `${a.kind}:${a.reasonCode}`).sort(),
        ['RECORD_QUARANTINED:ROUTING_MISMATCH', 'RECORD_QUARANTINED:SCHEMA_INVALID', 'RECORD_QUARANTINED:UNPARSEABLE']);
    });

    await t.test('bounded retry parks, later versions park behind it, other aggregates flow; authorized audited replay restores order', async () => {
      const { prefix, topic, publisher, consumerName } = await setup();
      const [tenant, stuck, healthy] = [randomUUID(), randomUUID(), randomUUID()];
      let broken = true;
      let attempts = 0;
      const options: SyntheticOptions = { consumerName, fail: e => {
        if (e.aggregateId !== stuck || !broken) return undefined;
        attempts++;
        return new TypeError(`downstream rejected ${MARKER}`);
      } };
      const handler = syntheticHandler(options);
      const [s1, s2, ok1] = [ev(tenant, stuck, 1), ev(tenant, stuck, 2, 'DOCTOR_REVIEW'), ev(tenant, healthy, 1)];
      await publisher.publish([wire(s1), wire(s2), wire(ok1)]);
      await startConsumer(prefix, handler, { maxAttempts: 3 });
      await waitFor('healthy aggregate applied', async () => (await effects(tenant, consumerName, ok1.eventId)) === 1 ? true : undefined);
      await lagZero(consumerName, topic);
      assert.equal(attempts, 3, 'exactly maxAttempts attempts');
      const mine = alerts.filter(a => a.consumerName === consumerName);
      assert.deepEqual(mine.map(a => [a.kind, a.reasonCode, a.owner]),
        [['EVENT_PARKED', 'RETRY_EXHAUSTED', 'platform-events'], ['EVENT_PARKED', 'BLOCKED_BY_PARKED', 'platform-events']]);
      assert.ok(!JSON.stringify(mine).includes(MARKER));

      broken = false;
      const operator = randomUUID();
      const out: string[] = [];
      const command = ['replay', '--tenant', tenant, '--consumer', consumerName, '--operator', operator];
      await assert.rejects(runReplayCommand(command, { db, handlers: [handler], authorize: allowlistAuthorizer(randomUUID()), out: l => out.push(l) }), ReplayDeniedError);
      assert.equal(await effects(tenant, consumerName, s1.eventId), 0, 'denied replay changed nothing');
      await runReplayCommand(command, { db, handlers: [handler], authorize: allowlistAuthorizer(operator), out: l => out.push(l) });
      assert.deepEqual(JSON.parse(out.at(-1)!), { command: 'replay', consumer: consumerName, applied: 2, reconciled: 0, stale: 0, stillParked: 0, failed: 0, alreadyResolved: 0 });
      assert.deepEqual(await projection(tenant, stuck), { version: 2, status: 'DOCTOR_REVIEW' });
      const audits = await q<{ action: string; actor_id: string }>(tenant,
        "SELECT action, actor_id FROM tpa.audit_logs WHERE entity_type='PARKED_EVENT' ORDER BY id");
      assert.deepEqual(audits, [{ action: 'EVENT_REPLAY', actor_id: operator }, { action: 'EVENT_REPLAY', actor_id: operator }]);
      await publisher.publish([wire(s1), wire(s2)]); // late redelivery after replay
      await lagZero(consumerName, topic);
      for (const e of [s1, s2]) assert.equal(await effects(tenant, consumerName, e.eventId), 1);
    });

    for (const mode of ['after-commit', 'mid-effect'] as const) {
      await t.test(`PT05 consumer SIGKILL ${mode === 'after-commit' ? 'after effect COMMIT, before offset commit' : 'inside the effect transaction'}: restart applies once`, async () => {
        const { prefix, topic, publisher, consumerName } = await setup();
        const tenant = randomUUID();
        const batch = [ev(tenant, randomUUID(), 1), ev(tenant, randomUUID(), 1), ev(tenant, randomUUID(), 1)];
        const target = batch[1];
        await publisher.publish(batch.map(wire));
        const child = spawn(process.execPath, [crashChild], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH, CRASH_DATABASE_URL: harness.url('tpa_app'), CRASH_BROKERS: harness.brokers.join(','), CRASH_PREFIX: prefix,
            CRASH_MODE: mode, CRASH_EVENT: target.eventId, CRASH_CONSUMER: consumerName } });
        children.push(child);
        let out = '';
        child.stdout!.on('data', d => { out += d; processOutput.push(String(d)); });
        child.stderr!.on('data', d => processOutput.push(String(d)));
        await waitFor('crash point', async () => {
          if (child.exitCode !== null) throw new Error('child exited');
          return out.includes('CRASH_POINT') ? true : undefined;
        }, 90_000);
        child.kill('SIGKILL');
        if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
        assert.equal(await effects(tenant, consumerName, target.eventId), mode === 'after-commit' ? 1 : 0,
          mode === 'after-commit' ? 'effect committed before the crash' : 'uncommitted effect rolled back');
        await startConsumer(prefix, syntheticHandler({ consumerName }));
        await waitFor('all 3 applied after restart', async () => (await inboxCount(tenant, consumerName)) === 3 ? true : undefined, 90_000);
        await lagZero(consumerName, topic);
        for (const e of batch) assert.equal(await effects(tenant, consumerName, e.eventId), 1, 'redelivery did not repeat the effect');
      });
    }

    await t.test('rebalance: members join and leave mid-stream; every event applied once, per-aggregate order kept', async () => {
      const { prefix, topic, publisher, consumerName } = await setup();
      const tenant = randomUUID();
      const handler = syntheticHandler({ consumerName });
      const wave = (n: number) => {
        const aggregates = Array.from({ length: n }, () => randomUUID());
        return { aggregates, events: aggregates.flatMap(a => [ev(tenant, a, 1), ev(tenant, a, 2, 'DOCTOR_REVIEW'), ev(tenant, a, 3, 'EOB_READY')]) };
      };
      const first = wave(5), second = wave(5);
      const a = await startConsumer(prefix, handler);
      await publisher.publish(first.events.map(wire));
      const b = await startConsumer(prefix, handler); // join -> rebalance while consuming
      await publisher.publish(second.events.map(wire));
      await waitFor('some progress before leave', async () => (await inboxCount(tenant, consumerName)) >= 10 ? true : undefined);
      await a.stop(); // leave -> rebalance again
      await waitFor('30 inbox rows', async () => (await inboxCount(tenant, consumerName)) === 30 ? true : undefined, 90_000);
      await lagZero(consumerName, topic);
      assert.equal(await effects(tenant, consumerName), 30);
      for (const aggregate of [...first.aggregates, ...second.aggregates]) {
        assert.deepEqual(await projection(tenant, aggregate), { version: 3, status: 'EOB_READY' });
      }
      const stale = await q<{ n: number }>(tenant, "SELECT count(*)::int AS n FROM tpa.consumer_inbox WHERE consumer_name=$1 AND outcome <> 'APPLIED'", [consumerName]);
      assert.equal(stale[0].n, 0, 'in-partition order kept: no stale/gap outcomes');
      await b.stop();
    });

    await t.test('PT17: no PII marker in inbox, positions, parking, quarantine, alerts, logs or process output', async () => {
      const { rows: [{ n }] } = await harness.pgAdmin.query(`SELECT
        (SELECT count(*) FROM tpa.consumer_inbox x WHERE x::text LIKE $1) + (SELECT count(*) FROM tpa.consumer_aggregate_positions x WHERE x::text LIKE $1)
        + (SELECT count(*) FROM tpa.consumer_parked_events x WHERE x::text LIKE $1) + (SELECT count(*) FROM tpa.consumer_quarantine x WHERE x::text LIKE $1)
        + (SELECT count(*) FROM tpa.outbox_events x WHERE x::text LIKE $1) AS n`, [`%${MARKER}%`]);
      assert.equal(Number(n), 0);
      const { rows: [{ planted }] } = await harness.pgAdmin.query('SELECT count(*)::int AS planted FROM tpa.synthetic_source WHERE status=$1', [MARKER]);
      assert.ok(planted > 0, 'marker really existed in business state');
      for (const [what, lines] of [['alerts', alerts.map(a => JSON.stringify(a))], ['logs', logLines], ['process output', processOutput]] as const) {
        assert.ok(lines.every(l => !l.includes(MARKER)), `${what} free of marker`);
      }
      assert.ok(alerts.length >= 5 && processOutput.length >= 2);
      t.diagnostic(`PT17 scanned ${alerts.length} alerts, ${logLines.length} log lines, ${processOutput.length} process output chunks`);
    });
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.allSettled(consumers.map(c => c.stop()));
    await Promise.allSettled(publishers.map(p => p.disconnect()));
    await Promise.allSettled(closers.map(c => c.close()));
    await h?.cleanup();
  }
});
