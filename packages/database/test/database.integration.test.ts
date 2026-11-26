import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { numeric, pgSchema, text } from 'drizzle-orm/pg-core';
import { migrateDatabase } from '../src/migrate.ts';

// Same verified PG16/pgvector pin as #3; no Compose stack or shared DB needed.
const image = 'pgvector/pgvector:0.8.7-pg16-trixie@sha256:c28c0b700f3f1b5eec14082b31ad6e7c8a566d14386323609c615315e7c0ffc8';
const migrations = fileURLToPath(new URL('../../../infra/migrations/', import.meta.url));
const fixture = pgSchema('tpa').table('numeric_probe', {
  id: text('id').primaryKey(), amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
});

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function denied(client: pg.Client, sql: string): Promise<void> {
  await assert.rejects(client.query(sql), (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === '42501');
}

test('PG16: reproducible migrations, PT01 role subset and NUMERIC string roundtrip', async (t) => {
  const name = `tpa-db15-${randomBytes(6).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const scratch = await mkdtemp(join(tmpdir(), 'tpa-db15-'));
  const clients: pg.Client[] = [];
  let started = false;
  try {
    docker('run', '--detach', '--name', name, '--label', `ao.session=${process.env.AO_SESSION_ID ?? name}`,
      '--memory', '384m', '--cpus', '1', '--tmpfs', '/var/lib/postgresql/data:rw,size=512m',
      '--publish', '127.0.0.1::5432', '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=tpa', image);
    started = true;
    const port = docker('port', name, '5432/tcp').split(':').at(-1)!;
    const url = (user: string, database = 'tpa') => `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`;
    const connect = async (user: string, database = 'tpa') => {
      const client = new pg.Client({ connectionString: url(user, database), connectionTimeoutMillis: 2000 });
      await client.connect(); clients.push(client); return client;
    };
    const deadline = Date.now() + 45_000;
    while (true) {
      const probe = new pg.Client({ connectionString: url('postgres'), connectionTimeoutMillis: 1000 });
      try { await probe.connect(); break; }
      catch { if (Date.now() >= deadline) throw new Error('Synthetic PostgreSQL readiness timed out'); await delay(250); }
      finally { await probe.end(); }
    }
    const admin = await connect('postgres');
    const bootstrap = await readFile(join(migrations, 'bootstrap.sql'), 'utf8');
    await admin.query(bootstrap);
    await admin.query(bootstrap); // Repeat bootstrap preserves state/passwords.
    for (const role of ['tpa_app', 'tpa_migrator']) {
      const { rows: [command] } = await admin.query('SELECT format(\'ALTER ROLE %I PASSWORD %L\', $1::text, $2::text) AS sql', [role, password]);
      await admin.query(command.sql);
    }
    const migrator = await connect('tpa_migrator');
    const app = await connect('tpa_app');
    await t.test('fresh + repeated + concurrent migration runs retain committed history records', async () => {
      await migrateDatabase(url('tpa_migrator'));
      await migrateDatabase(url('tpa_migrator'));
      await Promise.all([migrateDatabase(url('tpa_migrator')), migrateDatabase(url('tpa_migrator'))]);
      const { rows: [row] } = await migrator.query('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations');
      assert.equal(row.count, 6);
      const { rows } = await admin.query("SELECT extname FROM pg_extension WHERE extname IN ('vector','pg_trgm','pgcrypto') ORDER BY extname");
      assert.deepEqual(rows.map(r => r.extname), ['pg_trgm', 'pgcrypto', 'vector']);
      const { rows: tables } = await migrator.query("SELECT tablename FROM pg_tables WHERE schemaname='tpa'");
      assert.deepEqual(tables.map(r => r.tablename).sort(), ['audit_anchors', 'audit_chain_heads', 'audit_logs', 'idempotency_records', 'outbox_events', 'outbox_relay_tenants']);
    });
    await t.test('incremental upgrade matches fresh database catalog/history', async () => {
      await admin.query('CREATE DATABASE tpa_upgrade');
      const upgrade = await connect('postgres', 'tpa_upgrade');
      await assert.rejects(migrateDatabase(url('tpa_migrator', 'tpa_upgrade')), /bootstrap/);
      await upgrade.query(bootstrap);
      const partial = join(scratch, 'partial');
      await cp(migrations, partial, { recursive: true });
      const journalPath = join(partial, 'meta/_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      journal.entries = journal.entries.slice(0, 1);
      await writeFile(journalPath, JSON.stringify(journal));
      await migrateDatabase(url('tpa_migrator', 'tpa_upgrade'), partial);
      const upgraded = await connect('tpa_migrator', 'tpa_upgrade');
      assert.equal((await upgraded.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n, 1);
      await migrateDatabase(url('tpa_migrator', 'tpa_upgrade'));
      const catalog = `SELECT n.nspname, r.rolname, n.nspacl::text FROM pg_namespace n
        JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname IN ('tpa','drizzle') ORDER BY n.nspname`;
      assert.deepEqual((await upgraded.query(catalog)).rows, (await migrator.query(catalog)).rows);
      const defaults = `SELECT defaclobjtype, defaclacl::text FROM pg_default_acl ORDER BY defaclobjtype`;
      assert.deepEqual((await upgraded.query(defaults)).rows, (await migrator.query(defaults)).rows);
      const history = 'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at';
      assert.deepEqual((await upgraded.query(history)).rows, (await migrator.query(history)).rows);
    });
    await t.test('edited applied SQL and failed migrations are rejected without advancing history', async () => {
      const changed = join(scratch, 'changed');
      await cp(migrations, changed, { recursive: true });
      await writeFile(join(changed, '0000_application_schema.sql'), '-- edited\n');
      await assert.rejects(migrateDatabase(url('tpa_migrator'), changed), /Migration history differs/);
      const failed = join(scratch, 'failed');
      await cp(migrations, failed, { recursive: true });
      const journalPath = join(failed, 'meta/_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      journal.entries.push({ idx: 6, version: '7', when: journal.entries[5].when + 1, tag: '0006_failed', breakpoints: true });
      await writeFile(journalPath, JSON.stringify(journal));
      await writeFile(join(failed, '0006_failed.sql'), 'CREATE TABLE tpa.must_rollback(id text);\n--> statement-breakpoint\nSELECT 1 / 0;');
      await assert.rejects(migrateDatabase(url('tpa_migrator'), failed));
      assert.equal((await migrator.query("SELECT to_regclass('tpa.must_rollback') AS name")).rows[0].name, null);
      assert.equal((await migrator.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n, 6);
      await migrateDatabase(url('tpa_migrator')); // Lock/connection recovered.
    });
    await t.test('app role has no ownership, elevated attributes or role memberships', async () => {
      const { rows: [role] } = await app.query(`SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
        FROM pg_roles WHERE rolname=current_user`);
      assert.ok(Object.values(role).every(v => v === false));
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='tpa_app'`)).rows[0].n, 0);
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM pg_shdepend d JOIN pg_roles r ON r.oid=d.refobjid
        WHERE d.refclassid='pg_authid'::regclass AND d.deptype='o' AND r.rolname='tpa_app'`)).rows[0].n, 0);
      await assert.rejects(migrateDatabase(url('tpa_app')), /unprivileged tpa_migrator/);
    });
    await migrator.query(`CREATE TABLE tpa.numeric_probe(id text PRIMARY KEY, amount numeric(15,2) NOT NULL);
      GRANT SELECT, INSERT, UPDATE, DELETE ON tpa.numeric_probe TO tpa_app;
      CREATE TABLE tpa.closed_probe(id text);
      CREATE FUNCTION tpa.closed_function() RETURNS integer LANGUAGE SQL AS 'SELECT 1'`);
    await t.test('real app connection cannot DDL/TRUNCATE, elevate, change ownership or migration history', async () => {
      for (const statement of [
        'CREATE TABLE tpa.forbidden(id int)', 'CREATE TABLE public.forbidden(id int)',
        'CREATE TEMP TABLE forbidden(id int)', 'CREATE SCHEMA forbidden',
        'CREATE FUNCTION tpa.forbidden() RETURNS int LANGUAGE SQL AS \'SELECT 1\'',
        'ALTER TABLE tpa.numeric_probe ADD COLUMN forbidden text', 'DROP TABLE tpa.numeric_probe',
        'TRUNCATE tpa.numeric_probe', 'ALTER TABLE tpa.numeric_probe OWNER TO tpa_app',
        'SET ROLE tpa_migrator', 'SET ROLE postgres', 'ALTER ROLE tpa_app SUPERUSER',
        'ALTER ROLE tpa_app BYPASSRLS', 'CREATE ROLE forbidden',
        'CREATE EXTENSION hstore', 'DROP EXTENSION vector',
        'SELECT * FROM drizzle.__drizzle_migrations', 'DELETE FROM drizzle.__drizzle_migrations',
        'SELECT * FROM tpa.closed_probe', 'SELECT tpa.closed_function()',
      ]) await denied(app, statement);
    });
    await t.test('NUMERIC(15,2) returns JSON strings using pg and Drizzle without float conversion', async () => {
      const db = drizzle(app);
      const values = ['0.00', '720000.00', '9999999999999.99', '-9999999999999.99', '0.01'];
      for (const [index, amount] of values.entries()) {
        const id = String(index);
        const [row] = await db.insert(fixture).values({ id, amount }).returning();
        assert.equal(typeof row.amount, 'string');
        assert.equal(row.amount, amount);
        const raw = await app.query('SELECT amount FROM tpa.numeric_probe WHERE id=$1', [id]);
        assert.equal(raw.rows[0].amount, amount);
        assert.equal(JSON.parse(JSON.stringify(row)).amount, amount);
      }
      await assert.rejects(db.insert(fixture).values({ id: 'overflow', amount: '10000000000000.00' }));
      const { rows: [column] } = await app.query(`SELECT numeric_precision, numeric_scale FROM information_schema.columns
        WHERE table_schema='tpa' AND table_name='numeric_probe' AND column_name='amount'`);
      assert.deepEqual(column, { numeric_precision: 15, numeric_scale: 2 });
    });
  } finally {
    await Promise.allSettled(clients.map(client => client.end()));
    if (started) docker('rm', '--force', name);
    await rm(scratch, { recursive: true, force: true });
  }
});
