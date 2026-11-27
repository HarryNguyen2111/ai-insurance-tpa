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
import { migrateDatabase } from '../src/migrate.ts';
import { createTenantDatabase, type TenantTransaction, type TenantDatabase } from '../src/tenant.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const pgImage = 'pgvector/pgvector:0.8.7-pg16-trixie@sha256:c28c0b700f3f1b5eec14082b31ad6e7c8a566d14386323609c615315e7c0ffc8';
function docker(...args: string[]): string {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 150_000 }).trim(); }
  catch { throw new Error(`Synthetic Docker ${args[0]} failed (arguments/output suppressed)`); }
}
const sqlCode = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;

test('PT01 foundation: PG16 app role through real PgBouncer transaction pool', async (t) => {
  const name = `tpa-db16-${randomBytes(6).toString('hex')}`;
  const label = `ao.session=${process.env.AO_SESSION_ID ?? name}`;
  const scratch = await mkdtemp(join(tmpdir(), `${name}-`));
  const password = randomBytes(24).toString('hex');
  const clients: pg.Client[] = [];
  const started: string[] = [];
  let network = false;
  let db: TenantDatabase | undefined;
  let imageBuilt = false;
  const image = `${name}:test`;
  try {
    await chmod(scratch, 0o755);
    // Quiet build: never dump Docker buffers containing configuration on failure.
    docker('build', '--quiet', '--label', label, '--tag', image, join(root, 'infra/testing/pgbouncer'));
    imageBuilt = true;
    const poolerVersion = docker('run', '--rm', '--label', label, '--memory', '128m', '--cpus', '0.5', image, '--version');
    assert.match(poolerVersion, /PgBouncer 1\.26\.1/);
    t.diagnostic(`${poolerVersion.split('\n')[0]}; local test image ${docker('image', 'inspect', '--format', '{{.Id}}', image)}`);
    docker('network', 'create', '--label', label, name); network = true;
    docker('run', '--detach', '--name', name, '--label', label, '--network', name, '--network-alias', 'database',
      '--memory', '384m', '--cpus', '1', '--tmpfs', '/var/lib/postgresql/data:rw,size=512m',
      '--publish', '127.0.0.1::5432', '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=tpa', pgImage);
    started.push(name);
    const pgPort = docker('port', name, '5432/tcp').split(':').at(-1)!;
    const url = (user: string, port = pgPort) => `postgresql://${user}:${password}@127.0.0.1:${port}/tpa`;
    async function connect(connectionString: string): Promise<pg.Client> {
      const client = new pg.Client({ connectionString, connectionTimeoutMillis: 2000 });
      try { await client.connect(); clients.push(client); return client; }
      catch (error) { await client.end(); throw error; }
    }
    async function ready(connectionString: string): Promise<pg.Client> {
      const deadline = Date.now() + 40_000;
      while (true) {
        try { return await connect(connectionString); }
        catch { if (Date.now() >= deadline) throw new Error('Synthetic database/pool readiness timed out'); await delay(250); }
      }
    }
    const admin = await ready(url('postgres'));
    const pgVersion = (await admin.query('SHOW server_version')).rows[0].server_version;
    assert.match(pgVersion, /^16\./);
    t.diagnostic(`Actual PostgreSQL ${pgVersion}`);
    await admin.query(await readFile(join(root, 'infra/migrations/bootstrap.sql'), 'utf8'));
    for (const role of ['tpa_app', 'tpa_migrator']) {
      const { rows: [command] } = await admin.query("SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql", [role, password]);
      await admin.query(command.sql);
    }
    await migrateDatabase(url('tpa_migrator'));
    const owner = await connect(url('tpa_migrator'));
    await owner.query(await readFile(join(root, 'packages/database/test/fixtures/tenant.sql'), 'utf8'));
    await copyFile(join(root, 'infra/testing/pgbouncer/pgbouncer.ini'), join(scratch, 'pgbouncer.ini'));
    await writeFile(join(scratch, 'userlist.txt'), `"tpa_app" "${password}"\n`, { mode: 0o644 });
    const bouncer = `${name}-pool`;
    docker('run', '--detach', '--name', bouncer, '--label', label, '--network', name,
      '--memory', '128m', '--cpus', '0.5', '--read-only', '--cap-drop', 'ALL',
      '--publish', '127.0.0.1::6432', '--mount', `type=bind,src=${scratch},dst=/config,readonly`, image);
    started.push(bouncer);
    const port = docker('port', bouncer, '6432/tcp').split(':').at(-1)!;
    const raw = await ready(url('tpa_app', port));
    db = createTenantDatabase({ connectionString: url('tpa_app', port), max: 8, connectionTimeoutMillis: 5000 });
    const tenantDb = db;
    const a = randomUUID(), b = randomUUID(), pa = randomUUID(), pb = randomUUID();
    const pids = new Set<number>();
    const run = <T>(tenant: string, fn: (tx: TenantTransaction) => Promise<T>) => tenantDb.withTenantTransaction(tenant, async tx => {
      pids.add((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      assert.equal((await tx.query('SELECT tpa.current_tenant_id() AS id')).rows[0].id, tenant);
      return fn(tx);
    });
    await t.test('role, ownership, FORCE RLS, USING/WITH CHECK and exact composite FK inventory', async () => {
      const role = (await raw.query(`SELECT current_user AS name, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
        FROM pg_roles WHERE rolname=current_user`)).rows[0];
      assert.equal(role.name, 'tpa_app');
      assert.ok(Object.entries(role).every(([k, v]) => k === 'name' || v === false));
      const tables = (await admin.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, r.rolname AS owner
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
        WHERE n.nspname='tpa' AND c.relname IN ('isolation_parent','isolation_child') ORDER BY c.relname`)).rows;
      assert.equal(tables.length, 2);
      for (const table of tables) { assert.equal(table.owner, 'tpa_migrator'); assert.equal(table.relrowsecurity, true); assert.equal(table.relforcerowsecurity, true); }
      const policies = (await admin.query("SELECT policyname, qual, with_check FROM pg_policies WHERE schemaname='tpa'")).rows;
      assert.equal(policies.length, 38); // +outbox_events (EVT-01), +consumer_inbox/positions/parked_events (EVT-02), +workflow_command_ledger (WF-01), +6 BEN-01 snapshot tables, +6 AUTH-01 identity tables, +4 BEN-03 benefit ledger tables, +6 VWF-03 workflow definition tables, +2 BEN-04 tenant invoice allocation tables (global invoice tables have no policy and no app grant), +3 PAY-01 ledger tables
      // AUTH-01: identity discovery happens BEFORE a tenant is chosen, so exactly these two global
      // policies are scoped to the verified principal instead of a tenant. Every other policy stays tenant-scoped.
      const principalScoped: Record<string, RegExp> = {
        identity_principals_self: /^\(identity_hash = current_setting\('app\.identity_hash'::text, true\)\)$/,
        identity_directory_self: /^\(principal_id = tpa\.identity_principal_id\(\)\)$/,
      };
      assert.equal(policies.filter(p => p.policyname in principalScoped).length, 2);
      for (const policy of policies) {
        if (policy.policyname in principalScoped) { assert.match(policy.qual, principalScoped[policy.policyname]); assert.equal(policy.qual, policy.with_check); continue; }
        assert.match(policy.qual, /tenant_id = tpa.current_tenant_id/);
        // Context inserts additionally require the current membership/principal versions.
        if (policy.policyname === 'identity_context_self') { assert.match(policy.with_check, /tenant_id = tpa.current_tenant_id/); assert.match(policy.with_check, /principal_version/); continue; }
        assert.equal(policy.qual, policy.with_check);
      }
      const fk = (await admin.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='tpa.isolation_child'::regclass AND contype='f'")).rows;
      assert.deepEqual(fk, [{ definition: 'FOREIGN KEY (tenant_id, parent_id) REFERENCES tpa.isolation_parent(tenant_id, id)' }]);
      for (const tenant of [a, b]) await run(tenant, tx => tx.query('INSERT INTO tpa.isolation_parent VALUES ($1,$2,$3)', [tenant, tenant === a ? pa : pb, 'synthetic']));
      // FORCE applies to table owner as well (which is not a bypass/superuser).
      await assert.rejects(owner.query('SELECT * FROM tpa.isolation_parent'), sqlCode('42501'));
    });
    await t.test('absent and malformed contexts reject reads/writes; commit leaves no context', async () => {
      assert.equal((await raw.query("SELECT nullif(current_setting('app.current_tenant_id',true),'') AS tenant")).rows[0].tenant, null);
      await assert.rejects(raw.query('SELECT * FROM tpa.isolation_parent'), sqlCode('42501'));
      await assert.rejects(raw.query('INSERT INTO tpa.isolation_parent VALUES ($1,$2,$3)', [a, randomUUID(), 'absent']), sqlCode('42501'));
      await assert.rejects(raw.query("UPDATE tpa.isolation_parent SET label='absent'"), sqlCode('42501'));
      await assert.rejects(raw.query('DELETE FROM tpa.isolation_parent'), sqlCode('42501'));
      await raw.query('BEGIN');
      await raw.query("SELECT set_config('app.current_tenant_id',$1,true)", ['malformed']);
      await assert.rejects(raw.query('SELECT * FROM tpa.isolation_parent'), sqlCode('22P02'));
      await raw.query('ROLLBACK');
      assert.equal((await raw.query("SELECT nullif(current_setting('app.current_tenant_id',true),'') AS tenant")).rows[0].tenant, null);
    });
    await t.test('two tenants cannot read/insert/update/delete or reference each other', async () => {
      for (const [tenant, other, ownParent, otherParent] of [[a,b,pa,pb], [b,a,pb,pa]]) {
        await run(tenant, async tx => {
          assert.equal((await tx.query('SELECT * FROM tpa.isolation_parent')).rowCount, 1);
          assert.equal((await tx.query('SELECT * FROM tpa.isolation_parent WHERE tenant_id=$1', [other])).rowCount, 0);
          assert.equal((await tx.query("UPDATE tpa.isolation_parent SET label='forbidden' WHERE tenant_id=$1", [other])).rowCount, 0);
          assert.equal((await tx.query('DELETE FROM tpa.isolation_parent WHERE tenant_id=$1', [other])).rowCount, 0);
          assert.equal((await tx.query("UPDATE tpa.isolation_parent SET label='own' WHERE id=$1", [ownParent])).rowCount, 1);
          const child = randomUUID();
          assert.equal((await tx.query('INSERT INTO tpa.isolation_child VALUES ($1,$2,$3)', [tenant, child, ownParent])).rowCount, 1);
          assert.equal((await tx.query('SELECT * FROM tpa.isolation_child WHERE id=$1', [child])).rowCount, 1);
          const transient = randomUUID();
          await tx.query('INSERT INTO tpa.isolation_child VALUES ($1,$2,$3)', [tenant, transient, ownParent]);
          assert.equal((await tx.query('DELETE FROM tpa.isolation_child WHERE id=$1', [transient])).rowCount, 1);
        });
        await assert.rejects(run(tenant, tx => tx.query('INSERT INTO tpa.isolation_parent VALUES ($1,$2,$3)', [other, randomUUID(), 'forbidden'])), sqlCode('42501'));
        await assert.rejects(run(tenant, tx => tx.query('UPDATE tpa.isolation_parent SET tenant_id=$1 WHERE id=$2', [other, ownParent])), sqlCode('42501'));
        await assert.rejects(run(tenant, tx => tx.query('INSERT INTO tpa.isolation_child VALUES ($1,$2,$3)', [tenant, randomUUID(), otherParent])), sqlCode('23503'));
        await assert.rejects(run(tenant, tx => tx.query('UPDATE tpa.isolation_child SET parent_id=$1', [otherParent])), sqlCode('23503'));
        await assert.rejects(run(tenant, tx => tx.query('INSERT INTO tpa.isolation_child VALUES ($1,$2,$3)', [other, randomUUID(), otherParent])), sqlCode('42501'));
        await run(tenant, async tx => {
          assert.equal((await tx.query('SELECT * FROM tpa.isolation_child WHERE tenant_id=$1', [other])).rowCount, 0);
          assert.equal((await tx.query('DELETE FROM tpa.isolation_child WHERE tenant_id=$1', [other])).rowCount, 0);
          assert.equal((await tx.query('UPDATE tpa.isolation_child SET parent_id=$1 WHERE tenant_id=$2', [ownParent, other])).rowCount, 0);
        });
      }
    });
    await t.test('rollback, SQL failure and escaped handles never reuse an active capability', async () => {
      let escaped: TenantTransaction | undefined;
      await run(a, async tx => { escaped = tx; });
      await assert.rejects(escaped!.query('SELECT 1'), /no longer active/);
      const rollbackId = randomUUID();
      await assert.rejects(run(a, async tx => {
        escaped = tx;
        await tx.query('INSERT INTO tpa.isolation_parent VALUES ($1,$2,$3)', [a, rollbackId, 'rollback']);
        throw new Error('synthetic rollback');
      }), /synthetic rollback/);
      await assert.rejects(escaped!.query('SELECT 1'), /no longer active/);
      assert.equal((await raw.query("SELECT nullif(current_setting('app.current_tenant_id',true),'') AS tenant")).rows[0].tenant, null);
      await run(a, async tx => assert.equal((await tx.query('SELECT * FROM tpa.isolation_parent WHERE id=$1', [rollbackId])).rowCount, 0));
      await assert.rejects(run(a, async tx => { await tx.query('SELECT 1/0').catch(() => {}); }), /transaction query failed/);
      await assert.rejects(run(a, async tx => { void tx.query('SELECT 1/0'); }), /transaction query failed/);
      await run(a, async tx => { void tx.query('SELECT pg_sleep(0.005)'); });
      await run(b, async tx => assert.equal((await tx.query('SELECT * FROM tpa.isolation_parent')).rows[0].tenant_id, b));
    });
    await t.test('concurrent requests serialize onto same backend without tenant leakage', async () => {
      await Promise.all(Array.from({ length: 24 }, (_, i) => run(i % 2 ? a : b, async tx => {
        const tenant = i % 2 ? a : b;
        const other = i % 2 ? b : a;
        await tx.query('SELECT pg_sleep(0.005)');
        const rows = (await tx.query('SELECT tenant_id FROM tpa.isolation_parent')).rows;
        assert.ok(rows.length > 0 && rows.every(r => r.tenant_id === tenant));
        assert.equal((await tx.query('DELETE FROM tpa.isolation_parent WHERE tenant_id=$1', [other])).rowCount, 0);
        assert.equal((await tx.query("UPDATE tpa.isolation_parent SET label='forbidden' WHERE tenant_id=$1", [other])).rowCount, 0);
      })));
      await Promise.all(Array.from({ length: 12 }, (_, i) => {
        const tenant = i % 2 ? a : b;
        const other = i % 2 ? b : a;
        const otherParent = i % 2 ? pb : pa;
        return Promise.all([
          assert.rejects(run(tenant, tx => tx.query('INSERT INTO tpa.isolation_parent VALUES ($1,$2,$3)', [other, randomUUID(), 'forbidden'])), sqlCode('42501')),
          assert.rejects(run(tenant, tx => tx.query('INSERT INTO tpa.isolation_child VALUES ($1,$2,$3)', [tenant, randomUUID(), otherParent])), sqlCode('23503')),
        ]);
      }));
      assert.equal(pids.size, 1, 'all tenant transactions must reuse the exact same PostgreSQL backend');
      assert.equal((await raw.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, [...pids][0]);
      t.diagnostic(`All committed/rolled-back/concurrent tenant transactions reused backend PID ${[...pids][0]}`);
      assert.equal((await raw.query("SELECT nullif(current_setting('app.current_tenant_id',true),'') AS tenant")).rows[0].tenant, null);
      await assert.rejects(raw.query('SELECT * FROM tpa.isolation_parent'), sqlCode('42501'));
    });
    await t.test('pooled app cannot DDL/TRUNCATE/elevate/write globals or access private globals', async () => {
      for (const statement of [
        'CREATE TABLE tpa.forbidden(id int)', 'CREATE TABLE public.forbidden(id int)', 'CREATE TEMP TABLE forbidden(id int)',
        'ALTER TABLE tpa.isolation_parent DISABLE ROW LEVEL SECURITY', 'DROP TABLE tpa.isolation_parent',
        'TRUNCATE tpa.isolation_parent', 'SET ROLE tpa_migrator', 'SET ROLE postgres',
        'INSERT INTO tpa.isolation_global_read VALUES (2)', 'UPDATE tpa.isolation_global_read SET id=2',
        'DELETE FROM tpa.isolation_global_read', 'SELECT * FROM tpa.isolation_global_private',
        'SELECT * FROM drizzle.__drizzle_migrations',
      ]) await assert.rejects(raw.query(statement), sqlCode('42501'));
      assert.deepEqual((await raw.query('SELECT * FROM tpa.isolation_global_read')).rows, [{ id: 1 }]);
      const wrongRole = createTenantDatabase({ connectionString: url('tpa_migrator') });
      try { await assert.rejects(wrongRole.withTenantTransaction(a, async () => {}), /unprivileged tpa_app/); }
      finally { await wrongRole.close(); }
    });
  } finally {
    await db?.close();
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
