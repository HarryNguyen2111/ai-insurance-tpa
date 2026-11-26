import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';
import type * as KafkaJs from 'kafkajs';
import { topicName, validateEventEnvelope, type DomainEventDraft } from '@tpa/event-contracts';
import { migrateDatabase } from '@tpa/database/migrate';
import { createTenantDatabase, type TenantDatabase } from '@tpa/database/tenant';
import { commitDomainChange, createOutboxRelayStore, type OutboxRelayStore } from '@tpa/database/outbox';
import { createKafkaPublisher, type KafkaEventPublisher } from '../src/kafka-publisher.ts';
import { OutboxRelay, type RelayLogger } from '../src/relay.ts';

// PT05 (outbox crash recovery) + PT17 (no PII in events) on real PG16 and the
// Kafka broker image pinned by the development Compose stack (#3).
const kafkajs = createRequire(import.meta.url)('kafkajs') as typeof KafkaJs;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const pgImage = 'pgvector/pgvector:0.8.7-pg16-trixie@sha256:c28c0b700f3f1b5eec14082b31ad6e7c8a566d14386323609c615315e7c0ffc8';
const crashChild = fileURLToPath(new URL('./fixtures/relay-crash-child.ts', import.meta.url));
const relayMain = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const MARKER = 'PT17-SYNTHETIC-MARKER-079123456789-0912345678';
const PREFIX = 'tpa.e2e';
const DOMAINS = ['claim', 'eob', 'payment', 'catalog', 'workspace'];
const TOPICS = DOMAINS.map(d => topicName(PREFIX, d));

function docker(...args: string[]): string {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 }).trim(); }
  catch { throw new Error(`Synthetic Docker ${args[0]} failed (arguments/output suppressed)`); }
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, ms = 90_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (true) {
    try { const value = await probe(); if (value !== undefined) return value; } catch { /* retry */ }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(250);
  }
}

interface Consumed { topic: string; partition: number; offset: string; key: string; value: string; headers: Record<string, string> }

test('PT05/PT17: outbox relay crash recovery and PII-free events on PG16 + Compose Kafka', async (t) => {
  const name = `tpa-evt01e2e-${randomBytes(6).toString('hex')}`;
  const label = `ao.session=${process.env.AO_SESSION_ID ?? name}`;
  const password = randomBytes(24).toString('hex');
  const started: string[] = [];
  const clients: pg.Client[] = [];
  const closers: { close(): Promise<void> }[] = [];
  const children: ChildProcess[] = [];
  const processOutput: string[] = [];
  let admin: KafkaJs.Admin | undefined;
  let publisher: KafkaEventPublisher | undefined;
  try {
    // --- PostgreSQL 16 (same pin/bootstrap/migrations as the database suites) ---
    docker('run', '--detach', '--name', name, '--label', label, '--memory', '384m', '--cpus', '1',
      '--tmpfs', '/var/lib/postgresql/data:rw,size=512m', '--publish', '127.0.0.1::5432',
      '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=tpa', pgImage);
    started.push(name);
    const pgPort = docker('port', name, '5432/tcp').split(':').at(-1)!;
    const url = (user: string) => `postgresql://${user}:${password}@127.0.0.1:${pgPort}/tpa`;
    const connect = (user: string) => waitFor('PostgreSQL', async () => {
      const client = new pg.Client({ connectionString: url(user), connectionTimeoutMillis: 2000 });
      try { await client.connect(); clients.push(client); return client; } catch (e) { await client.end().catch(() => {}); throw e; }
    });
    const pgAdmin = await connect('postgres');
    await pgAdmin.query(await readFile(`${root}infra/migrations/bootstrap.sql`, 'utf8'));
    for (const role of ['tpa_app', 'tpa_migrator']) {
      const { rows: [command] } = await pgAdmin.query("SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql", [role, password]);
      await pgAdmin.query(command.sql);
    }
    await migrateDatabase(url('tpa_migrator'));
    const owner = await connect('tpa_migrator');
    await owner.query(await readFile(`${root}packages/database/test/fixtures/tenant.sql`, 'utf8')); // synthetic business table

    // --- Kafka: exact image pinned by infra/compose/compose.yaml (single-node KRaft, dev only) ---
    const compose = await readFile(`${root}infra/compose/compose.yaml`, 'utf8');
    const kafkaImage = /\n {2}kafka:\n(?: {4}.*\n)*? {4}image: (apache\/kafka:\S+@sha256:[a-f0-9]{64})/.exec(compose)?.[1];
    assert.ok(kafkaImage, 'Compose Kafka image pin found');
    const kafkaPort = await freePort();
    const kafkaName = `${name}-kafka`;
    docker('run', '--detach', '--name', kafkaName, '--label', label, '--memory', '768m', '--cpus', '1',
      '--publish', `127.0.0.1:${kafkaPort}:9092`,
      '--env', 'CLUSTER_ID=MkU3OEVBNTcwNTJENDM2Qk', '--env', 'KAFKA_NODE_ID=1', '--env', 'KAFKA_PROCESS_ROLES=broker,controller',
      '--env', 'KAFKA_LISTENERS=PLAINTEXT://:9092,CONTROLLER://:9093',
      '--env', `KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://127.0.0.1:${kafkaPort}`,
      '--env', 'KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER', '--env', 'KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
      '--env', 'KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:9093', '--env', 'KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1',
      '--env', 'KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1', '--env', 'KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1',
      '--env', 'KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0', '--env', 'KAFKA_AUTO_CREATE_TOPICS_ENABLE=false',
      '--env', 'KAFKA_HEAP_OPTS=-Xms256m -Xmx256m', kafkaImage);
    started.push(kafkaName);
    const brokers = [`127.0.0.1:${kafkaPort}`];
    const kafka = new kafkajs.Kafka({ clientId: 'pt05-observer', brokers, logLevel: kafkajs.logLevel.NOTHING, retry: { retries: 2 } });
    admin = kafka.admin();
    await waitFor('Kafka broker', async () => { await admin!.connect(); await admin!.listTopics(); return true; }, 150_000);
    await admin.createTopics({ waitForLeaders: true, topics: TOPICS.map(topic => ({ topic, numPartitions: 3, replicationFactor: 1 })) });
    t.diagnostic(`PostgreSQL ${(await pgAdmin.query('SHOW server_version')).rows[0].server_version}; Kafka ${kafkaImage.split('@')[0]}`);

    // --- Helpers ---
    const track = <T extends { close(): Promise<void> }>(x: T) => { closers.push(x); return x; };
    const db: TenantDatabase = track(createTenantDatabase({ connectionString: url('tpa_app'), max: 4 }));
    const store: OutboxRelayStore = track(createOutboxRelayStore({ connectionString: url('tpa_app'), max: 2 }));
    publisher = createKafkaPublisher({ brokers, clientId: 'pt05-relay', topicPrefix: PREFIX, sendTimeoutMs: 30_000 });
    await publisher.connect();
    const logLines: string[] = [];
    const logger: RelayLogger = { info: (m, f) => logLines.push(JSON.stringify({ m, f })), error: (m, f) => logLines.push(JSON.stringify({ m, f })) };
    const relay = new OutboxRelay({ store, publisher, batchSize: 50, maxTenantsPerCycle: 100, logger });
    const pendingCount = (tenant: string) => db.withTenantTransaction(tenant, async tx => (await tx.query(
      'SELECT count(*)::int AS n FROM tpa.outbox_events WHERE published_at IS NULL')).rows[0].n as number);
    /** Recover until the tenant has nothing pending (another relay's lock may still be draining). */
    const recover = (tenant: string) => waitFor('relay recovery', async () => {
      await relay.runOnce();
      return (await pendingCount(tenant)) === 0 ? true : undefined;
    }, 30_000);

    async function readAll(): Promise<Consumed[]> {
      const offsets = await Promise.all(TOPICS.map(topic => admin!.fetchTopicOffsets(topic)));
      const total = offsets.flat().reduce((n, p) => n + Number(p.high) - Number(p.low), 0);
      const records: Consumed[] = [];
      if (total === 0) return records;
      const consumer = kafka.consumer({ groupId: `pt05-observer-${randomUUID()}` });
      await consumer.connect();
      try {
        await consumer.subscribe({ topics: TOPICS, fromBeginning: true });
        let resolveAll!: () => void;
        const all = new Promise<void>(resolve => { resolveAll = resolve; });
        await consumer.run({ eachMessage: async ({ topic, partition, message }) => {
          records.push({ topic, partition, offset: message.offset, key: message.key?.toString('utf8') ?? '', value: message.value?.toString('utf8') ?? '',
            headers: Object.fromEntries(Object.entries(message.headers ?? {}).map(([k, v]) => [k, String(v)])) });
          if (records.length >= total) resolveAll();
        } });
        await Promise.race([all, delay(60_000).then(() => { throw new Error('Timed out consuming records'); })]);
      } finally { await consumer.disconnect(); }
      return records;
    }
    const ofEvent = (records: Consumed[], eventId: string) => records.filter(r => r.headers['tpa-event-id'] === eventId);
    const outboxRow = (tenant: string, aggregate: string) => db.withTenantTransaction(tenant, async tx => (await tx.query(
      'SELECT event_id::text, published_at FROM tpa.outbox_events WHERE aggregate_id=$1 ORDER BY seq', [aggregate])).rows);
    const audit = (entityId: string, action = 'SUBMIT') => ({ entityType: 'CLAIM', entityId, actorType: 'USER' as const, actorId: randomUUID(), action, payload: {} });
    const draft = (aggregateId: string, aggregateVersion: number, overrides: Partial<DomainEventDraft> = {}): DomainEventDraft => ({
      eventType: 'claim.submitted', aggregateId, aggregateVersion, correlationId: randomUUID(), causationId: randomUUID(), payload: {}, ...overrides });
    const submit = (tenant: string, aggregate: string) => commitDomainChange(db, tenant, async tx => {
      await tx.query('INSERT INTO tpa.isolation_parent VALUES (tpa.current_tenant_id(), $1, $2)', [aggregate, MARKER]);
      return { result: null, audit: [audit(aggregate)], events: [draft(aggregate, 1)] };
    });
    async function crashAt(mode: string, tenant: string, aggregate: string): Promise<ChildProcess> {
      const child = spawn(process.execPath, [crashChild], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, PT05_DATABASE_URL: url('tpa_app'), PT05_BROKERS: brokers.join(','), PT05_TOPIC_PREFIX: PREFIX,
          PT05_MODE: mode, PT05_INPUT: JSON.stringify({ tenant, aggregate, label: MARKER }) },
      });
      children.push(child);
      let out = '';
      child.stdout!.on('data', d => { out += d; processOutput.push(String(d)); });
      child.stderr!.on('data', d => processOutput.push(String(d)));
      await waitFor(`crash point ${mode}`, async () => {
        if (child.exitCode !== null) throw Object.assign(new Error(`crash child exited ${child.exitCode}`), { fatal: true });
        return out.includes('CRASH_POINT') ? true : undefined;
      }, 60_000).catch(e => { if (child.exitCode !== null) throw new Error(`crash child exited early (${child.exitCode})`); throw e; });
      return child;
    }
    const kill = async (child: ChildProcess) => { child.kill('SIGKILL'); if (child.exitCode === null && child.signalCode === null) await once(child, 'exit'); };

    await t.test('PT05-A1 writer crash after COMMIT, before any publish: event relayed exactly once after recovery', async () => {
      const [tenant, aggregate] = [randomUUID(), randomUUID()];
      await kill(await crashAt('after-commit', tenant, aggregate));
      const [row] = await outboxRow(tenant, aggregate);
      assert.ok(row && row.published_at === null, 'committed event waits in the outbox');
      assert.equal(ofEvent(await readAll(), row.event_id).length, 0, 'nothing published before recovery');
      await recover(tenant);
      const copies = ofEvent(await readAll(), row.event_id);
      assert.equal(copies.length, 1);
      assert.equal(copies[0].key, `${tenant}:${aggregate}`);
      assert.equal(copies[0].topic, `${PREFIX}.claim`);
      assert.deepEqual(copies[0].headers, { 'tpa-event-id': row.event_id, 'tpa-event-type': 'claim.submitted', 'tpa-schema-version': '1.0.0', 'content-type': 'application/json' });
      assert.notEqual((await outboxRow(tenant, aggregate))[0].published_at, null, 'marked after ack');
    });

    await t.test('PT05-A2 relay crash after claiming rows, before publish: rows stay pending, no loss, no duplicate', async () => {
      const [tenant, aggregate] = [randomUUID(), randomUUID()];
      const { events: [event] } = await submit(tenant, aggregate);
      const child = await crashAt('before-publish', tenant, aggregate);
      const busy = await relay.runOnce();
      assert.ok(busy.busyTenants >= 1, 'crashed relay still owned the tenant slot; no concurrent reordering');
      await kill(child);
      assert.equal(ofEvent(await readAll(), event.eventId).length, 0);
      assert.equal((await outboxRow(tenant, aggregate))[0].published_at, null);
      await recover(tenant);
      assert.equal(ofEvent(await readAll(), event.eventId).length, 1, 'recovered exactly once');
    });

    await t.test('PT05-B relay crash after broker ack, before mark: event re-published; duplicate is explicit and dedupable', async () => {
      const [tenant, aggregate] = [randomUUID(), randomUUID()];
      const { events: [event] } = await submit(tenant, aggregate);
      await kill(await crashAt('after-ack', tenant, aggregate));
      assert.equal(ofEvent(await readAll(), event.eventId).length, 1, 'broker acknowledged before the crash');
      assert.equal((await outboxRow(tenant, aggregate))[0].published_at, null, 'mark was never committed');
      await recover(tenant);
      const copies = ofEvent(await readAll(), event.eventId);
      assert.equal(copies.length, 2, 'at-least-once: the same event is delivered twice');
      assert.equal(copies[0].key, copies[1].key);
      assert.equal(copies[0].partition, copies[1].partition, 'same key -> same partition');
      assert.deepEqual(JSON.parse(copies[0].value), JSON.parse(copies[1].value), 'identical envelope incl. eventId');
      // Consumer-side dedup by eventId (the inbox contract owned by EVT-02 #24) applies one side effect.
      const applied = new Set<string>();
      let sideEffects = 0;
      for (const record of copies) { const id = JSON.parse(record.value).eventId; if (!applied.has(id)) { applied.add(id); sideEffects++; } }
      assert.equal(sideEffects, 1);
      await relay.runOnce();
      assert.equal(ofEvent(await readAll(), event.eventId).length, 2, 'no further re-publish once marked');
    });

    await t.test('ordering: tenantId:aggregateId key keeps each aggregate on one partition in version order', async () => {
      const tenant = randomUUID();
      const aggregates = [randomUUID(), randomUUID(), randomUUID()];
      for (const aggregate of aggregates) await submit(tenant, aggregate);
      for (const version of [2, 3, 4]) {
        for (const aggregate of aggregates) {
          await commitDomainChange(db, tenant, async () => ({ result: null, audit: [audit(aggregate, 'TRANSITION')],
            events: [draft(aggregate, version, { eventType: 'claim.state-changed', payload: { fromStatus: 'SUBMITTED', toStatus: 'AI_PROCESSING' } })] }));
        }
      }
      await recover(tenant);
      const records = await readAll();
      for (const aggregate of aggregates) {
        const mine = records.filter(r => r.key === `${tenant}:${aggregate}`);
        assert.equal(mine.length, 4);
        assert.equal(new Set(mine.map(r => r.partition)).size, 1);
        const byOffset = [...mine].sort((a, b) => Number(BigInt(a.offset) - BigInt(b.offset)));
        assert.deepEqual(byOffset.map(r => JSON.parse(r.value).aggregateVersion), [1, 2, 3, 4]);
      }
    });

    await t.test('relay process: main.ts publishes with real wiring and drains gracefully on SIGTERM', async () => {
      const [tenant, aggregate] = [randomUUID(), randomUUID()];
      const { events: [event] } = await submit(tenant, aggregate);
      const child = spawn(process.execPath, [relayMain], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, EVENT_RELAY_DATABASE_URL: url('tpa_app'), KAFKA_BROKERS: brokers.join(','),
          EVENT_TOPIC_PREFIX: PREFIX, EVENT_RELAY_POLL_MS: '100' },
      });
      children.push(child);
      child.stdout!.on('data', d => processOutput.push(String(d)));
      child.stderr!.on('data', d => processOutput.push(String(d)));
      await waitFor('relay process publish', async () => (await outboxRow(tenant, aggregate))[0].published_at !== null ? true : undefined, 60_000);
      child.kill('SIGTERM');
      const [code] = await once(child, 'exit');
      assert.equal(code, 0, 'graceful shutdown');
      assert.equal(ofEvent(await readAll(), event.eventId).length, 1);
    });

    await t.test('PT17: no PII marker in any Kafka record, outbox envelope, relay log or process output', async () => {
      // A payload carrying PII is rejected before anything is written.
      const [tenant, aggregate] = [randomUUID(), randomUUID()];
      await assert.rejects(commitDomainChange(db, tenant, async tx => {
        await tx.query('INSERT INTO tpa.isolation_parent VALUES (tpa.current_tenant_id(), $1, $2)', [aggregate, MARKER]);
        return { result: null, audit: [audit(aggregate)], events: [draft(aggregate, 1, { payload: { phone: MARKER } })] };
      }));
      assert.equal((await outboxRow(tenant, aggregate)).length, 0);
      const records = await readAll();
      assert.ok(records.length >= 17, `scanned ${records.length} records (A1 1 + A2 1 + B 2 + ordering 12 + process 1)`);
      for (const record of records) {
        assert.ok(!JSON.stringify(record).includes(MARKER), 'Kafka key/value/headers free of PII marker');
        const envelope = JSON.parse(record.value);
        validateEventEnvelope(envelope); // every record satisfies its registered schema + PII guard
        assert.equal(record.key, `${envelope.tenantId}:${envelope.aggregateId}`);
      }
      const outboxLeaks = (await pgAdmin.query('SELECT count(*)::int AS n FROM tpa.outbox_events WHERE envelope::text LIKE $1', [`%${MARKER}%`])).rows[0].n;
      const businessRows = (await pgAdmin.query('SELECT count(*)::int AS n FROM tpa.isolation_parent WHERE label = $1', [MARKER])).rows[0].n;
      assert.ok(businessRows > 0, 'marker really was present in business state');
      assert.equal(outboxLeaks, 0, 'no outbox envelope contains the marker');
      assert.ok(logLines.length > 0 && logLines.every(l => !l.includes(MARKER)), 'relay logs carry counters only');
      assert.ok(processOutput.length > 0 && processOutput.every(o => !o.includes(MARKER)), 'crash-child and relay process output free of marker');
      t.diagnostic(`PT17 scanned ${records.length} Kafka records, ${logLines.length} relay log lines, ${processOutput.length} process output chunks`);
    });
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.allSettled([publisher?.disconnect(), admin?.disconnect()]);
    await Promise.allSettled(closers.map(c => c.close()));
    await Promise.allSettled(clients.map(c => c.end()));
    let cleanupFailed = false;
    for (const container of started.reverse()) { try { docker('rm', '--force', '--volumes', container); } catch { cleanupFailed = true; } }
    if (cleanupFailed) throw new Error(`Owned test resource cleanup failed for ${name}`);
  }
});
