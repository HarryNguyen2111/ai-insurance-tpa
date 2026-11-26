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
import { buildEventEnvelope } from '@tpa/event-contracts';
import { migrateDatabase } from '../src/migrate.ts';
import { createTenantDatabase, type TenantDatabase } from '../src/tenant.ts';
import { createQuarantineSink, processInboxEvent } from '../src/inbox.ts';
import { inboxScenarios } from './fixtures/inbox-scenarios.ts';
import { syntheticHandler } from './fixtures/synthetic-handler.ts';

// EVT-02 (#24) database half: PT08 duplicate/old/gap, park/replay/discard, RLS,
// immutability and PT17 storage scan. Kafka offsets/rebalance/crash: event-worker e2e.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const pgImage = 'pgvector/pgvector:0.8.7-pg16-trixie@sha256:c28c0b700f3f1b5eec14082b31ad6e7c8a566d14386323609c615315e7c0ffc8';
function docker(...args: string[]): string {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 150_000 }).trim(); }
  catch { throw new Error(`Synthetic Docker ${args[0]} failed (arguments/output suppressed)`); }
}

test('EVT-02 inbox: PG16 + PgBouncer dedup, ordering, parking, audited replay and guards', async (t) => {
  const name = `tpa-evt02-${randomBytes(6).toString('hex')}`;
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
    await owner.query(await readFile(join(root, 'packages/database/test/fixtures/consumer.sql'), 'utf8')); // synthetic consumer targets
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
    const direct: TenantDatabase = track(createTenantDatabase({ connectionString: url('tpa_app'), max: 8 }));
    const quarantine = track(createQuarantineSink({ connectionString: url('tpa_app') }));
    t.diagnostic('Actual PostgreSQL 16; direct backends for real lock contention, PgBouncer transaction pool for reuse');

    await t.test('through PgBouncer transaction pooling: apply once, redelivery is a duplicate', async () => {
      const handler = syntheticHandler({ consumerName: 'pooled-projection' });
      const tenant = randomUUID();
      const envelope = buildEventEnvelope(tenant, { eventType: 'claim.submitted', aggregateId: randomUUID(), aggregateVersion: 1,
        correlationId: randomUUID(), causationId: randomUUID(), payload: {} }).envelope;
      assert.equal((await processInboxEvent(pooled, handler, envelope)).kind, 'applied');
      assert.equal((await processInboxEvent(pooled, handler, envelope)).kind, 'duplicate');
      const n = await direct.withTenantTransaction(tenant, async tx => (await tx.query(
        'SELECT count(*)::int AS n FROM tpa.synthetic_effects WHERE event_id=$1', [envelope.eventId])).rows[0].n);
      assert.equal(n, 1);
    });
    await inboxScenarios(t, { db: direct, admin, raw, quarantine });
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
