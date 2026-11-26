import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';
import { EventContractError, type DomainEventDraft } from '@tpa/event-contracts';
import { migrateDatabase } from '../src/migrate.ts';
import { createTenantDatabase, type TenantDatabase } from '../src/tenant.ts';
import { appendOutboxEvent, commitDomainChange, createOutboxRelayStore, type OutboxRelayStore, type PendingOutboxEvent } from '../src/outbox.ts';
import type { AuditInput } from '../src/audit.ts';

// EVT-01 (#23) database half of PT05: atomic business+audit+outbox, RLS, immutability,
// relay mark-after-publish. Kafka/process-crash half lives in apps/event-worker e2e.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const pgImage = 'pgvector/pgvector:0.8.7-pg16-trixie@sha256:c28c0b700f3f1b5eec14082b31ad6e7c8a566d14386323609c615315e7c0ffc8';
function docker(...args: string[]): string {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 150_000 }).trim(); }
  catch { throw new Error(`Synthetic Docker ${args[0]} failed (arguments/output suppressed)`); }
}
const sqlCode = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;
const MARKER = 'SYNTHETIC-PII-MARKER-079123456789';

test('EVT-01 outbox: PG16 + PgBouncer atomic business/audit/outbox, RLS, immutability and ack-before-mark', async (t) => {
  const name = `tpa-evt01-${randomBytes(6).toString('hex')}`;
  const label = `ao.session=${process.env.AO_SESSION_ID ?? name}`;
  const scratch = await mkdtemp(join(tmpdir(), `${name}-`));
  const password = randomBytes(24).toString('hex');
  const clients: pg.Client[] = [];
  const closers: { close(): Promise<void> }[] = [];
  const started: string[] = [];
  let network = false, imageBuilt = false;
  const image = `${name}:test`;
  try {
    await chmod(scratch, 0o755);
    docker('build', '--quiet', '--label', label, '--tag', image, join(root, 'infra/testing/pgbouncer')); imageBuilt = true;
    docker('network', 'create', '--label', label, name); network = true;
    docker('run', '--detach', '--name', name, '--label', label, '--network', name, '--network-alias', 'database',
      '--memory', '384m', '--cpus', '1', '--tmpfs', '/var/lib/postgresql/data:rw,size=512m',
      '--publish', '127.0.0.1::5432', '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=tpa', pgImage);
    started.push(name);
    const pgPort = docker('port', name, '5432/tcp').split(':').at(-1)!;
    const url = (user: string, port = pgPort) => `postgresql://${user}:${password}@127.0.0.1:${port}/tpa`;
    async function ready(connectionString: string): Promise<pg.Client> {
      const deadline = Date.now() + 40_000;
      while (true) {
        const client = new pg.Client({ connectionString, connectionTimeoutMillis: 2000 });
        try { await client.connect(); clients.push(client); return client; }
        catch { await client.end().catch(() => {}); if (Date.now() >= deadline) throw new Error('Synthetic database readiness timed out'); await delay(250); }
      }
    }
    const admin = await ready(url('postgres'));
    assert.match((await admin.query('SHOW server_version')).rows[0].server_version, /^16\./);
    await admin.query(await readFile(join(root, 'infra/migrations/bootstrap.sql'), 'utf8'));
    for (const role of ['tpa_app', 'tpa_migrator']) {
      const { rows: [command] } = await admin.query("SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql", [role, password]);
      await admin.query(command.sql);
    }
    await migrateDatabase(url('tpa_migrator'));
    const owner = await ready(url('tpa_migrator'));
    await owner.query(await readFile(join(root, 'packages/database/test/fixtures/tenant.sql'), 'utf8')); // synthetic business table
    await copyFile(join(root, 'infra/testing/pgbouncer/pgbouncer.ini'), join(scratch, 'pgbouncer.ini'));
    await writeFile(join(scratch, 'userlist.txt'), `"tpa_app" "${password}"\n`, { mode: 0o644 });
    const bouncer = `${name}-pool`;
    docker('run', '--detach', '--name', bouncer, '--label', label, '--network', name, '--memory', '128m', '--cpus', '0.5',
      '--read-only', '--cap-drop', 'ALL', '--publish', '127.0.0.1::6432', '--mount', `type=bind,src=${scratch},dst=/config,readonly`, image);
    started.push(bouncer);
    const bouncerPort = docker('port', bouncer, '6432/tcp').split(':').at(-1)!;
    const raw = await ready(url('tpa_app', bouncerPort));
    const track = <T extends { close(): Promise<void> }>(x: T) => { closers.push(x); return x; };
    const pooled: TenantDatabase = track(createTenantDatabase({ connectionString: url('tpa_app', bouncerPort), max: 4 }));
    const direct: TenantDatabase = track(createTenantDatabase({ connectionString: url('tpa_app'), max: 6 }));
    const relayPooled: OutboxRelayStore = track(createOutboxRelayStore({ connectionString: url('tpa_app', bouncerPort), max: 2 }));
    const relayA: OutboxRelayStore = track(createOutboxRelayStore({ connectionString: url('tpa_app'), max: 2 }));
    const relayB: OutboxRelayStore = track(createOutboxRelayStore({ connectionString: url('tpa_app'), max: 2 }));
    t.diagnostic('Actual PostgreSQL 16; app traffic via PgBouncer transaction pool and direct backends');

    const [A, B] = [randomUUID(), randomUUID()];
    const actor = randomUUID();
    const auditFor = (entityId: string, action = 'SUBMIT'): AuditInput =>
      ({ entityType: 'CLAIM', entityId, actorType: 'USER', actorId: actor, action, payload: { after_hash: 'a'.repeat(64) } });
    const eventFor = (aggregateId: string, aggregateVersion = 1, overrides: Partial<DomainEventDraft> = {}): DomainEventDraft => ({
      eventType: 'claim.submitted', aggregateId, aggregateVersion, correlationId: randomUUID(), causationId: randomUUID(), payload: {}, ...overrides,
    });
    const submit = (db: TenantDatabase, tenant: string, aggregate = randomUUID(), events?: DomainEventDraft[]) =>
      commitDomainChange(db, tenant, async tx => {
        // Business row deliberately carries a PII marker: it must never leave PostgreSQL.
        await tx.query('INSERT INTO tpa.isolation_parent VALUES (tpa.current_tenant_id(), $1, $2)', [aggregate, MARKER]);
        return { result: aggregate, audit: [auditFor(aggregate)], events: events ?? [eventFor(aggregate)] };
      });
    const counts = (tenant: string, aggregate: string) => direct.withTenantTransaction(tenant, async tx => (await tx.query(
      `SELECT (SELECT count(*)::int FROM tpa.isolation_parent WHERE id=$1) AS business,
              (SELECT count(*)::int FROM tpa.audit_logs WHERE entity_id=$1) AS audit,
              (SELECT count(*)::int FROM tpa.outbox_events WHERE aggregate_id=$1) AS outbox`, [aggregate])).rows[0]);
    const drainAll = async (store: OutboxRelayStore, sink: PendingOutboxEvent[]) => {
      for (const tenant of await store.pendingTenants(100)) {
        while ((await store.relayTenantBatch(tenant, 50, async events => { sink.push(...events); })).published > 0) { /* drain */ }
      }
    };

    await t.test('commit through PgBouncer: business + audit + outbox land together with server-derived fields', async () => {
      const aggregate = randomUUID();
      const out = await submit(pooled, A, aggregate);
      assert.deepEqual(await counts(A, aggregate), { business: 1, audit: 1, outbox: 1 });
      const [event] = out.events;
      assert.equal(event.partitionKey, `${A}:${aggregate}`);
      assert.equal(event.envelope.tenantId, A);
      const row = await direct.withTenantTransaction(A, async tx => (await tx.query(
        'SELECT *, envelope::text AS text, created_at <= now() AS server_time FROM tpa.outbox_events WHERE event_id=$1', [event.eventId])).rows[0]);
      assert.equal(row.partition_key, `${A}:${aggregate}`);
      assert.equal(row.topic, 'claim');
      assert.equal(row.published_at, null);
      assert.ok(row.server_time);
      assert.deepEqual(JSON.parse(row.text), event.envelope);
      assert.ok(!row.text.includes(MARKER), 'PT17: business PII never copied into the outbox');
      assert.equal(out.audit[0].entity_id, aggregate);
    });

    await t.test('any failure rolls back business, audit and outbox together', async () => {
      const invalid = randomUUID();
      await assert.rejects(submit(pooled, A, invalid, [eventFor(invalid, 1, { payload: { note: MARKER } })]), EventContractError);
      assert.deepEqual(await counts(A, invalid), { business: 0, audit: 0, outbox: 0 });
      const thrown = randomUUID();
      await assert.rejects(direct.withTenantTransaction(A, async tx => {
        await tx.query('INSERT INTO tpa.isolation_parent VALUES (tpa.current_tenant_id(), $1, $2)', [thrown, 'x']);
        await appendOutboxEvent(tx, eventFor(thrown));
        throw new Error('crash before commit');
      }), /crash before commit/);
      assert.deepEqual(await counts(A, thrown), { business: 0, audit: 0, outbox: 0 });
      const duplicate = randomUUID();
      await submit(direct, A, duplicate);
      await assert.rejects(commitDomainChange(direct, A, async tx => {
        await tx.query('INSERT INTO tpa.isolation_parent VALUES (tpa.current_tenant_id(), $1, $2)', [randomUUID(), 'x']);
        return { result: 0, audit: [auditFor(duplicate, 'RETRY')], events: [eventFor(duplicate, 1)] }; // same aggregate version+type
      }), sqlCode('23505'));
      assert.deepEqual(await counts(A, duplicate), { business: 1, audit: 1, outbox: 1 }, 'second change fully rolled back');
    });

    await t.test('RLS: outbox is tenant-isolated and fails closed without context', async () => {
      const aggregate = randomUUID();
      await submit(direct, B, aggregate);
      assert.equal(await direct.withTenantTransaction(A, async tx => (await tx.query(
        'SELECT count(*)::int AS n FROM tpa.outbox_events WHERE aggregate_id=$1', [aggregate])).rows[0].n), 0);
      assert.equal(await direct.withTenantTransaction(A, async tx => (await tx.query(
        "UPDATE tpa.outbox_events SET published_at=now() WHERE aggregate_id=$1", [aggregate])).rowCount), 0);
      await assert.rejects(raw.query('SELECT * FROM tpa.outbox_events'), sqlCode('42501'));
      const forged = { eventId: randomUUID(), eventType: 'claim.submitted', schemaVersion: '1.0.0', tenantId: B, aggregateId: aggregate,
        aggregateVersion: 9, occurredAt: new Date().toISOString(), correlationId: randomUUID(), causationId: randomUUID(), payload: {} };
      await assert.rejects(direct.withTenantTransaction(A, tx => tx.query(
        `INSERT INTO tpa.outbox_events (tenant_id,event_id,event_type,schema_version,aggregate_id,aggregate_version,topic,envelope)
         VALUES ($1,$2,'claim.submitted','1.0.0',$3,9,'claim',$4)`, [B, forged.eventId, aggregate, JSON.stringify(forged)])), sqlCode('42501'));
      await assert.rejects(direct.withTenantTransaction(A, tx => tx.query(
        `INSERT INTO tpa.outbox_events (tenant_id,event_id,event_type,schema_version,aggregate_id,aggregate_version,topic,envelope)
         VALUES ($1,$2,'claim.submitted','1.0.0',$3,9,'claim',$4)`, [A, randomUUID(), aggregate, JSON.stringify({ ...forged, tenantId: A })])),
        sqlCode('23514'), 'envelope must match its columns');
    });

    await t.test('immutability: app may only stamp published_at once; owner cannot rewrite or drop pending rows', async () => {
      const aggregate = randomUUID();
      const { events: [event] } = await submit(direct, A, aggregate);
      const where = [event.eventId];
      for (const sql of ["UPDATE tpa.outbox_events SET envelope='{}' WHERE event_id=$1", "UPDATE tpa.outbox_events SET topic='x' WHERE event_id=$1",
        'DELETE FROM tpa.outbox_events WHERE event_id=$1']) {
        await assert.rejects(direct.withTenantTransaction(A, tx => tx.query(sql, where)), sqlCode('42501'), sql);
      }
      await assert.rejects(direct.withTenantTransaction(A, tx => tx.query('TRUNCATE tpa.outbox_events')), sqlCode('42501'));
      await assert.rejects(direct.withTenantTransaction(A, tx => tx.query('UPDATE tpa.outbox_events SET published_at=NULL WHERE event_id=$1', where)), sqlCode('42501'));
      // FORCE RLS: the owner has no write policy, so its writes match nothing...
      assert.equal((await owner.query("UPDATE tpa.outbox_events SET envelope='{}' WHERE event_id=$1", where)).rowCount, 0);
      assert.equal((await owner.query('DELETE FROM tpa.outbox_events WHERE event_id=$1', where)).rowCount, 0);
      // ...and even an RLS-bypassing superuser hits the guard trigger.
      await assert.rejects(admin.query("UPDATE tpa.outbox_events SET envelope='{}' WHERE event_id=$1", where), sqlCode('42501'));
      await assert.rejects(admin.query('DELETE FROM tpa.outbox_events WHERE event_id=$1', where), sqlCode('42501'));
      await assert.rejects(owner.query('TRUNCATE tpa.outbox_events'), sqlCode('42501'));
      const stamp = "UPDATE tpa.outbox_events SET published_at='2000-01-01' WHERE event_id=$1 RETURNING published_at > now() - interval '1 minute' AS server";
      assert.equal((await direct.withTenantTransaction(A, tx => tx.query(stamp, where))).rows[0].server, true, 'server clock stamps publication');
      await assert.rejects(direct.withTenantTransaction(A, tx => tx.query(stamp, where)), sqlCode('42501'), 'published rows are immutable');
      // Discovery returns tenant UUIDs only and is the sole cross-tenant capability.
      const { rows: columns } = await admin.query(`SELECT proname, prosecdef, pg_get_function_result(oid) AS result FROM pg_proc
        WHERE pronamespace='tpa'::regnamespace AND proname='outbox_pending_tenants'`);
      assert.deepEqual(columns, [{ proname: 'outbox_pending_tenants', prosecdef: true, result: 'TABLE(tenant_id uuid)' }]);
      assert.deepEqual((await admin.query(`SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee='tpa_app' AND table_name='outbox_events' ORDER BY 1`)).rows.map(r => r.privilege_type), ['INSERT', 'SELECT']);
      assert.deepEqual((await admin.query(`SELECT column_name, privilege_type FROM information_schema.column_privileges
        WHERE grantee='tpa_app' AND table_name='outbox_events' AND privilege_type='UPDATE'`)).rows, [{ column_name: 'published_at', privilege_type: 'UPDATE' }]);
    });

    await t.test('relay: discovery, ordered batches, mark only after publish resolves, failure leaves rows pending', async () => {
      const drained: PendingOutboxEvent[] = [];
      await drainAll(relayPooled, drained); // clear rows from earlier subtests
      assert.deepEqual(await relayPooled.pendingTenants(10), []);
      const aggregate = randomUUID();
      const versions = [1, 2, 3];
      await submit(pooled, A, aggregate, [eventFor(aggregate, 1)]);
      for (const v of versions.slice(1)) {
        await commitDomainChange(pooled, A, async () => ({ result: v, audit: [auditFor(aggregate, 'TRANSITION')],
          events: [eventFor(aggregate, v, { eventType: 'claim.state-changed', payload: { fromStatus: 'SUBMITTED', toStatus: 'AI_PROCESSING' } })] }));
      }
      const other = randomUUID();
      await submit(pooled, B, other);
      assert.deepEqual(await relayPooled.pendingTenants(10), [A, B], 'oldest pending tenant first, ids only');

      await assert.rejects(relayPooled.relayTenantBatch(A, 10, async () => { throw new Error('broker unavailable'); }), /broker unavailable/);
      const pending = await direct.withTenantTransaction(A, async tx => (await tx.query(
        'SELECT count(*)::int AS n FROM tpa.outbox_events WHERE published_at IS NULL')).rows[0].n);
      assert.equal(pending, 3, 'publish failure marks nothing');

      const seen: PendingOutboxEvent[] = [];
      const first = await relayPooled.relayTenantBatch(A, 2, async events => {
        // While publish is in flight the rows are still unpublished (mark happens after ack).
        const n = await direct.withTenantTransaction(A, async tx => (await tx.query(
          'SELECT count(*)::int AS n FROM tpa.outbox_events WHERE published_at IS NOT NULL AND aggregate_id=$1', [aggregate])).rows[0].n);
        assert.equal(n, 0);
        seen.push(...events);
      });
      assert.deepEqual(first, { locked: true, published: 2 });
      assert.deepEqual((await relayPooled.relayTenantBatch(A, 50, async events => { seen.push(...events); })), { locked: true, published: 1 });
      assert.deepEqual(seen.map(e => JSON.parse(e.value).aggregateVersion), versions, 'per-aggregate order preserved');
      assert.ok(seen.every(e => e.partitionKey === `${A}:${aggregate}` && e.topic === 'claim'));
      assert.ok(seen.every(e => !e.value.includes(MARKER) && !e.value.includes(' ')), 'compact envelope, no business PII');
      assert.deepEqual(await relayPooled.pendingTenants(10), [B]);
      assert.deepEqual(await relayPooled.relayTenantBatch(A, 50, async () => { throw new Error('not called'); }), { locked: true, published: 0 });
    });

    await t.test('relay: one active relay per tenant; competing replica skips instead of reordering', async () => {
      const aggregate = randomUUID();
      await submit(direct, A, aggregate);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void;
      const inFlight = new Promise<void>(resolve => { entered = resolve; });
      const holder = relayA.relayTenantBatch(A, 50, async () => { entered(); await gate; });
      await inFlight;
      assert.deepEqual(await relayB.relayTenantBatch(A, 50, async () => { throw new Error('must not publish'); }), { locked: false, published: 0 });
      release();
      assert.deepEqual(await holder, { locked: true, published: 1 });
      const sink: PendingOutboxEvent[] = [];
      await drainAll(relayB, sink);
      assert.ok(sink.every(e => JSON.parse(e.value).tenantId === B), 'only tenant B remained');
      await assert.rejects(track(createOutboxRelayStore({ connectionString: url('tpa_migrator'), max: 1 })).pendingTenants(1), /tpa_app/);
    });
  } finally {
    await Promise.allSettled(closers.map(c => c.close()));
    await Promise.allSettled(clients.map(c => c.end()));
    let cleanupFailed = false;
    for (const args of [
      ...started.reverse().map(container => ['rm', '--force', container]),
      ...(network ? [['network', 'rm', name]] : []),
      ...(imageBuilt ? [['image', 'rm', image]] : []),
    ]) { try { docker(...args); } catch { cleanupFailed = true; } }
    await rm(scratch, { recursive: true, force: true });
    if (cleanupFailed) throw new Error(`Owned test resource cleanup failed for ${name}`);
  }
});
