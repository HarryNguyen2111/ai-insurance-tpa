import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/migrate.ts';
import { createTenantDatabase, type TenantDatabase } from '../src/tenant.ts';
import {
  beginIdempotent, executeIdempotent, expireIdempotencyRecords, IdempotencyOwnershipLostError, releaseIdempotent,
  requestHash, runOwnedEffect, type IdempotencyScope, type IdempotentEffect, type IdempotentOutcome,
} from '../src/idempotency.ts';

// Same verified PG16/pgvector pin and PgBouncer harness as PT01 (#16/#3).
const root = fileURLToPath(new URL('../../../', import.meta.url));
const pgImage = 'pgvector/pgvector:0.8.7-pg16-trixie@sha256:c28c0b700f3f1b5eec14082b31ad6e7c8a566d14386323609c615315e7c0ffc8';
const crashChild = fileURLToPath(new URL('./fixtures/idempotency-crash-child.ts', import.meta.url));
function docker(...args: string[]): string {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 150_000 }).trim(); }
  catch { throw new Error(`Synthetic Docker ${args[0]} failed (arguments/output suppressed)`); }
}
const sqlCode = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;
const kinds = (outcomes: IdempotentOutcome[]) => outcomes.reduce<Record<string, number>>((acc, o) => ({ ...acc, [o.kind]: (acc[o.kind] ?? 0) + 1 }), {});

test('PT22 idempotency: PG16 + PgBouncer payload hash, concurrency, crash, retention and actor boundaries', async (t) => {
  const name = `tpa-api01-${randomBytes(6).toString('hex')}`;
  const label = `ao.session=${process.env.AO_SESSION_ID ?? name}`;
  const scratch = await mkdtemp(join(tmpdir(), `${name}-`));
  const password = randomBytes(24).toString('hex');
  const clients: pg.Client[] = [];
  const databases: TenantDatabase[] = [];
  const started: string[] = [];
  let network = false;
  let imageBuilt = false;
  const image = `${name}:test`;
  try {
    await chmod(scratch, 0o755);
    docker('build', '--quiet', '--label', label, '--tag', image, join(root, 'infra/testing/pgbouncer'));
    imageBuilt = true;
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
    await admin.query(await readFile(join(root, 'infra/migrations/bootstrap.sql'), 'utf8'));
    for (const role of ['tpa_app', 'tpa_migrator']) {
      const { rows: [command] } = await admin.query("SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql", [role, password]);
      await admin.query(command.sql);
    }
    await migrateDatabase(url('tpa_migrator'));
    const owner = await connect(url('tpa_migrator'));
    // Synthetic effect target only (TEST fixture relation, not business schema).
    await owner.query(await readFile(join(root, 'packages/database/test/fixtures/tenant.sql'), 'utf8'));
    await copyFile(join(root, 'infra/testing/pgbouncer/pgbouncer.ini'), join(scratch, 'pgbouncer.ini'));
    await writeFile(join(scratch, 'userlist.txt'), `"tpa_app" "${password}"\n`, { mode: 0o644 });
    const bouncer = `${name}-pool`;
    docker('run', '--detach', '--name', bouncer, '--label', label, '--network', name,
      '--memory', '128m', '--cpus', '0.5', '--read-only', '--cap-drop', 'ALL',
      '--publish', '127.0.0.1::6432', '--mount', `type=bind,src=${scratch},dst=/config,readonly`, image);
    started.push(bouncer);
    const bouncerPort = docker('port', bouncer, '6432/tcp').split(':').at(-1)!;
    const raw = await ready(url('tpa_app', bouncerPort));
    t.diagnostic(`Actual PostgreSQL ${pgVersion}; app traffic via PgBouncer transaction pool and direct PG16 backends`);
    const open = (connectionString: string, max: number) => {
      const db = createTenantDatabase({ connectionString, max, connectionTimeoutMillis: 10_000 });
      databases.push(db); return db;
    };
    const pooled = open(url('tpa_app', bouncerPort), 8); // One real server connection behind PgBouncer.
    const direct = open(url('tpa_app'), 10); // Real concurrent backends for lock contention.

    const [A, B, C] = [randomUUID(), randomUUID(), randomUUID()];
    const actor = randomUUID();
    const scopeFor = (overrides: Partial<IdempotencyScope> = {}): IdempotencyScope => ({
      operation: 'syntheticCreate', actorType: 'USER', actorId: actor, key: `pt22-${randomBytes(12).toString('hex')}`, ...overrides,
    });
    const newLabel = () => `fx-${randomBytes(8).toString('hex')}`;
    const request = { amount: '720000.00', lines: [{ code: 'A', qty: 1 }], memberRef: 'SYNTHETIC_PII_MARKER' };
    const effect = (fx: string): IdempotentEffect => async (tx, { attempt }) => {
      const { rows: [row] } = await tx.query('INSERT INTO tpa.isolation_parent VALUES (tpa.current_tenant_id(), gen_random_uuid(), $1) RETURNING id', [fx]);
      return { status: 201, body: { id: row.id, amount: '720000.00', attempt: String(attempt) } };
    };
    const effects = (tenant: string, fx: string) => direct.withTenantTransaction(tenant, async tx =>
      (await tx.query('SELECT count(*)::int AS n FROM tpa.isolation_parent WHERE label = $1', [fx])).rows[0].n as number);
    const record = (tenant: string, scope: IdempotencyScope) => direct.withTenantTransaction(tenant, async tx => (await tx.query(
      `SELECT r.*, extract(epoch FROM expires_at - created_at)::int AS retention, to_jsonb(r)::text AS row_text
       FROM tpa.idempotency_records r WHERE actor_type=$1 AND actor_id=$2 AND operation=$3 AND idempotency_key=$4`,
      [scope.actorType, scope.actorId, scope.operation, scope.key])).rows[0]);
    async function waitFor(condition: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
      const deadline = Date.now() + ms;
      while (!(await condition())) { if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`); await delay(25); }
    }
    const lockWaiters = async () => (await admin.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='tpa_app' AND wait_event_type='Lock'")).rows[0].n as number;
    const idleInTransaction = async () => (await admin.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='tpa_app' AND state LIKE 'idle in transaction%'")).rows[0].n as number;

    await t.test('PT22 through PgBouncer: same canonical payload replays original status/body; changed payload 409', async () => {
      const scope = scopeFor(), fx = newLabel();
      const first = await executeIdempotent(pooled, A, scope, request, effect(fx));
      assert.equal(first.kind, 'executed');
      assert.equal(first.kind === 'executed' && first.response.status, 201);
      const reordered = { memberRef: 'SYNTHETIC_PII_MARKER', lines: [{ qty: 1, code: 'A' }], amount: '720000.00' };
      for (let i = 0; i < 3; i++) {
        assert.deepEqual(await executeIdempotent(pooled, A, scope, reordered, effect(fx)),
          { kind: 'replayed', response: first.kind === 'executed' && first.response });
      }
      for (const changed of [{ ...request, amount: '720000.01' }, { ...request, lines: [] }, { request }]) {
        assert.deepEqual(await executeIdempotent(pooled, A, scope, changed, effect(fx)), { kind: 'conflict' });
      }
      assert.equal(await effects(A, fx), 1, 'exactly one committed synthetic effect');
      const row = await record(A, scope);
      assert.equal(row.state, 'COMPLETED');
      assert.equal(row.response_status, 201);
      assert.equal(row.request_hash, requestHash(request));
      assert.equal(row.request_hash_version, '1');
      assert.equal(row.retention, 86_400, 'default retention is the contract minimum of 24h');
      assert.equal(row.owner_token, null);
      assert.ok(!row.row_text.includes('SYNTHETIC_PII_MARKER'), 'raw request is never stored, only its hash');
      const week = scopeFor();
      assert.equal((await executeIdempotent(pooled, A, week, request, effect(newLabel()), { retentionSeconds: 604_800 })).kind, 'executed');
      assert.equal((await record(A, week)).retention, 604_800);
    });

    await t.test('concurrent duplicates (direct backends and PgBouncer) produce exactly one committed effect', async () => {
      const scope = scopeFor(), fx = newLabel();
      const slowEffect = (label: string): IdempotentEffect => async (tx, context) => {
        await tx.query('SELECT pg_sleep(0.3)'); return effect(label)(tx, context);
      };
      const slow = slowEffect(fx);
      const outcomes = await Promise.all(Array.from({ length: 20 }, () => executeIdempotent(direct, A, scope, request, slow)));
      const counts = kinds(outcomes);
      t.diagnostic(`20 concurrent direct duplicates: ${JSON.stringify(counts)}`);
      assert.equal(counts.executed, 1);
      assert.equal((counts.in_progress ?? 0) + (counts.replayed ?? 0), 19);
      assert.ok((counts.in_progress ?? 0) >= 1, 'duplicates overlapping the owner observe in-progress');
      for (const o of outcomes) if (o.kind === 'in_progress') assert.ok(o.retryAfterSeconds >= 1 && o.retryAfterSeconds <= 30);
      const executed = outcomes.find(o => o.kind === 'executed')!;
      for (const o of outcomes) if (o.kind === 'replayed') assert.deepEqual(o.response, executed.kind === 'executed' && executed.response);
      assert.equal(await effects(A, fx), 1);
      assert.equal((await executeIdempotent(direct, A, scope, request, slow)).kind, 'replayed');

      const mixed = scopeFor(), fxMixed = newLabel();
      const different = await Promise.all(Array.from({ length: 12 }, (_, i) =>
        executeIdempotent(direct, A, mixed, { ...request, amount: `${720000 + i}.00` }, slowEffect(fxMixed))));
      assert.deepEqual(kinds(different), { executed: 1, conflict: 11 });
      assert.equal(await effects(A, fxMixed), 1);

      const viaPool = scopeFor(), fxPool = newLabel();
      const pooledOutcomes = await Promise.all(Array.from({ length: 12 }, () => executeIdempotent(pooled, A, viaPool, request, effect(fxPool))));
      const pooledCounts = kinds(pooledOutcomes);
      t.diagnostic(`12 concurrent PgBouncer duplicates: ${JSON.stringify(pooledCounts)}`);
      assert.equal(pooledCounts.executed, 1);
      assert.equal((pooledCounts.in_progress ?? 0) + (pooledCounts.replayed ?? 0), 11);
      assert.equal(await effects(A, fxPool), 1);
    });

    await t.test('uncommitted first claim blocks a concurrent duplicate; rollback frees the key, commit yields in-progress', async () => {
      for (const commit of [false, true]) {
        const scope = scopeFor(), hash = requestHash(request);
        let decide!: (commit: boolean) => void, claimed!: () => void;
        const gate = new Promise<boolean>(resolve => { decide = resolve; });
        const ready = new Promise<void>(resolve => { claimed = resolve; });
        const first = direct.withTenantTransaction(A, async tx => {
          const result = await beginIdempotent(tx, scope, hash);
          claimed();
          if (!(await gate)) throw new Error('synthetic rollback');
          return result;
        });
        await ready;
        let finished = false;
        const second = direct.withTenantTransaction(A, tx => beginIdempotent(tx, scope, hash)).finally(() => { finished = true; });
        try {
          await waitFor(async () => (await lockWaiters()) > 0, 'second backend to wait on the uncommitted key');
          assert.equal(finished, false);
        } finally { decide(commit); }
        if (commit) {
          assert.equal((await first).kind, 'acquired');
          const blocked = await second;
          assert.equal(blocked.kind, 'in_progress');
          assert.ok(blocked.kind === 'in_progress' && blocked.retryAfterSeconds >= 1 && blocked.retryAfterSeconds <= 30);
        } else {
          await assert.rejects(first, /synthetic rollback/);
          const taken = await second;
          assert.equal(taken.kind, 'acquired', 'rolled-back claim leaves no record behind');
          assert.equal(taken.kind === 'acquired' && taken.attempt, 1);
        }
      }
    });

    async function crash(mode: string, tenant: string, scope: IdempotencyScope, fx: string, leaseSeconds: number): Promise<void> {
      const child = spawn(process.execPath, [crashChild], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH ?? '', TPA_CRASH_DATABASE_URL: url('tpa_app'), TPA_CRASH_MODE: mode,
          TPA_CRASH_INPUT: JSON.stringify({ tenant, scope, request, label: fx, leaseSeconds }) },
      });
      const exited = once(child, 'exit');
      try {
        await new Promise<void>((resolve, reject) => {
          let output = '';
          const timer = setTimeout(() => reject(new Error('crash child did not reach its crash point')), 30_000);
          child.stdout!.on('data', chunk => { output += chunk; if (output.includes('CRASH_POINT')) { clearTimeout(timer); resolve(); } });
          child.once('exit', () => { clearTimeout(timer); reject(new Error('crash child exited before its crash point')); });
        });
      } finally {
        child.kill('SIGKILL');
        await exited;
      }
      // PostgreSQL aborts the dead client's open transaction when it sees EOF.
      await waitFor(async () => (await idleInTransaction()) === 0, 'killed backend transaction to abort');
    }
    async function recover(tenant: string, scope: IdempotencyScope, fx: string): Promise<IdempotentOutcome> {
      let outcome: IdempotentOutcome;
      let blocked = 0;
      const deadline = Date.now() + 20_000;
      while ((outcome = await executeIdempotent(direct, tenant, scope, request, effect(fx), { leaseSeconds: 4 })).kind === 'in_progress') {
        blocked++;
        if (Date.now() >= deadline) throw new Error('crashed owner lease never lapsed');
        await delay(250);
      }
      assert.ok(blocked > 0, 'retry inside the crashed owner lease is rejected as in-progress, not re-executed');
      return outcome;
    }

    await t.test('SIGKILL crash after ownership commit: retry is in-progress until lease lapses, then one takeover effect', async () => {
      const scope = scopeFor(), fx = newLabel();
      await crash('after-begin', A, scope, fx, 5);
      assert.equal((await record(A, scope)).state, 'IN_PROGRESS');
      const outcome = await recover(A, scope, fx);
      assert.equal(outcome.kind, 'executed');
      assert.equal(outcome.kind === 'executed' && outcome.attempt, 2);
      assert.equal(await effects(A, fx), 1);
      assert.equal((await executeIdempotent(direct, A, scope, request, effect(fx))).kind, 'replayed');
    });

    await t.test('SIGKILL crash mid-effect: uncommitted effect vanishes; takeover commits exactly one effect', async () => {
      const scope = scopeFor(), fx = newLabel();
      await crash('during-effect', A, scope, fx, 5);
      assert.equal(await effects(A, fx), 0, 'effect written by the killed owner was rolled back');
      assert.equal((await record(A, scope)).state, 'IN_PROGRESS');
      const outcome = await recover(A, scope, fx);
      assert.equal(outcome.kind, 'executed');
      assert.equal(outcome.kind === 'executed' && outcome.attempt, 2);
      assert.equal(await effects(A, fx), 1);
    });

    await t.test('SIGKILL crash after commit (response lost): retry replays the stored response with no new effect', async () => {
      const scope = scopeFor(), fx = newLabel();
      await crash('after-commit', A, scope, fx, 5);
      assert.deepEqual(await executeIdempotent(direct, A, scope, request, effect(fx)),
        { kind: 'replayed', response: { status: 201, body: { label: fx, phase: 'child' } } });
      assert.equal(await effects(A, fx), 1);
    });

    await t.test('lease fencing: a stalled owner loses ownership; a lapsed lease never splits a running effect', async () => {
      const scope = scopeFor(), fx = newLabel(), hash = requestHash(request);
      const stalled = await direct.withTenantTransaction(A, tx => beginIdempotent(tx, scope, hash, { leaseSeconds: 1 }));
      assert.equal(stalled.kind, 'acquired');
      await delay(1_300);
      const staleToken = stalled.kind === 'acquired' ? stalled.ownerToken : '';
      const taker = await direct.withTenantTransaction(A, tx => beginIdempotent(tx, scope, hash));
      assert.equal(taker.kind, 'acquired');
      assert.equal(taker.kind === 'acquired' && taker.attempt, 2);
      let stalledEffects = 0;
      const stalledRun = () => direct.withTenantTransaction(A, tx => runOwnedEffect(tx, scope, staleToken, 1,
        async (inner, context) => { stalledEffects++; return effect(fx)(inner, context); }));
      // Stalled owner wakes while the new owner is still IN_PROGRESS: only the token fence can stop it.
      await assert.rejects(stalledRun(), (error: unknown) => error instanceof IdempotencyOwnershipLostError);
      assert.equal(await direct.withTenantTransaction(A, tx => releaseIdempotent(tx, scope, staleToken)), false,
        'a stale owner cannot release the new owner');
      assert.equal((await record(A, scope)).owner_token, taker.kind === 'acquired' && taker.ownerToken);
      const finished = await direct.withTenantTransaction(A, tx =>
        runOwnedEffect(tx, scope, taker.kind === 'acquired' ? taker.ownerToken : '', 2, effect(fx)));
      assert.equal(finished.status, 201);
      await assert.rejects(stalledRun(), (error: unknown) => error instanceof IdempotencyOwnershipLostError);
      assert.equal(stalledEffects, 0);
      assert.equal(await effects(A, fx), 1);
      assert.deepEqual(await executeIdempotent(direct, A, scope, request, effect(fx)), { kind: 'replayed', response: finished });

      const running = scopeFor(), fxRunning = newLabel();
      let release!: () => void, inside!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const entered = new Promise<void>(resolve => { inside = resolve; });
      const ownerRun = executeIdempotent(direct, A, running, request, async (tx, context) => {
        const response = await effect(fxRunning)(tx, context); inside(); await gate; return response;
      }, { leaseSeconds: 1 });
      await entered;
      await delay(1_300); // Owner's lease has lapsed while its effect transaction still holds the row lock.
      let duplicateDone = false;
      const duplicate = executeIdempotent(direct, A, running, request, effect(fxRunning)).finally(() => { duplicateDone = true; });
      try {
        await waitFor(async () => (await lockWaiters()) > 0, 'takeover to wait on the running owner');
        assert.equal(duplicateDone, false);
      } finally { release(); }
      assert.equal((await ownerRun).kind, 'executed');
      assert.equal((await duplicate).kind, 'replayed');
      assert.equal(await effects(A, fxRunning), 1);
    });

    await t.test('failure semantics: thrown effect rolls back and releases; 4xx outcomes are stored; 5xx never stored', async () => {
      const scope = scopeFor(), fx = newLabel();
      await assert.rejects(executeIdempotent(direct, A, scope, request, async (tx, context) => {
        await effect(fx)(tx, context); throw new Error('synthetic dependency failure');
      }), /synthetic dependency failure/);
      assert.equal(await effects(A, fx), 0);
      const released = await record(A, scope);
      assert.equal(released.state, 'IN_PROGRESS');
      assert.equal(released.owner_token, null);
      const retry = await executeIdempotent(direct, A, scope, request, effect(fx));
      assert.equal(retry.kind, 'executed', 'released key retries immediately without waiting for the lease');
      assert.equal(retry.kind === 'executed' && retry.attempt, 2);
      assert.deepEqual(await executeIdempotent(direct, A, scope, { ...request, amount: '1.00' }, effect(fx)), { kind: 'conflict' });
      assert.equal(await effects(A, fx), 1);

      const domain = scopeFor();
      const rejected = { status: 422, body: { code: 'DOMAIN_VIOLATION', contractClauseCited: 'SYNTHETIC-CLAUSE-1' } };
      assert.deepEqual(await executeIdempotent(direct, A, domain, request, async () => rejected), { kind: 'executed', response: rejected, attempt: 1 });
      assert.deepEqual(await executeIdempotent(direct, A, domain, request, effect(newLabel())), { kind: 'replayed', response: rejected });

      const transient = scopeFor(), fxTransient = newLabel();
      await assert.rejects(executeIdempotent(direct, A, transient, request, async (tx, context) => {
        await effect(fxTransient)(tx, context); return { status: 503, body: { code: 'DEPENDENCY_UNAVAILABLE' } };
      }), /Invalid idempotency response/);
      assert.equal(await effects(A, fxTransient), 0);
      assert.equal((await executeIdempotent(direct, A, transient, request, effect(fxTransient))).kind, 'executed');
      assert.equal(await effects(A, fxTransient), 1);
    });

    await t.test('actor, operation and tenant namespaces are isolated; RLS and guards hold for the app role', async () => {
      const key = `pt22-${randomBytes(12).toString('hex')}`;
      const base = scopeFor({ key });
      const fxBase = newLabel();
      const original = await executeIdempotent(pooled, A, base, request, effect(fxBase));
      assert.equal(original.kind, 'executed');
      for (const [tenant, scope] of [
        [A, { ...base, actorId: randomUUID() }], [A, { ...base, actorType: 'SERVICE' as const }],
        [A, { ...base, operation: 'syntheticOtherOperation' }], [B, base],
      ] as const) {
        const fx = newLabel();
        const outcome = await executeIdempotent(pooled, tenant, scope, request, effect(fx));
        assert.equal(outcome.kind, 'executed', 'another actor/operation/tenant never receives the original response');
        assert.notDeepEqual(outcome.kind === 'executed' && outcome.response, original.kind === 'executed' && original.response);
        assert.equal(await effects(tenant, fx), 1);
      }
      assert.deepEqual(await executeIdempotent(pooled, A, base, request, effect(fxBase)),
        { kind: 'replayed', response: original.kind === 'executed' && original.response });
      await pooled.withTenantTransaction(B, async tx => {
        assert.equal((await tx.query('SELECT * FROM tpa.idempotency_records WHERE tenant_id=$1', [A])).rowCount, 0);
        assert.equal((await tx.query("UPDATE tpa.idempotency_records SET attempt=attempt+1 WHERE tenant_id=$1", [A])).rowCount, 0);
        assert.equal((await tx.query('SELECT * FROM tpa.idempotency_records WHERE idempotency_key=$1', [key])).rowCount, 1);
      });
      await assert.rejects(raw.query('SELECT * FROM tpa.idempotency_records'), sqlCode('42501'));
      const where = 'actor_type=$1 AND actor_id=$2 AND operation=$3 AND idempotency_key=$4';
      const params = [base.actorType, base.actorId, base.operation, base.key];
      for (const [statement, values, code] of [
        [`UPDATE tpa.idempotency_records SET request_hash=repeat('a',64) WHERE ${where}`, params, '42501'],
        [`UPDATE tpa.idempotency_records SET expires_at=expires_at+interval '1 day' WHERE ${where}`, params, '42501'],
        [`UPDATE tpa.idempotency_records SET tenant_id=$5 WHERE ${where}`, [...params, B], '42501'],
        [`UPDATE tpa.idempotency_records SET state='IN_PROGRESS', response_status=NULL, response_body=NULL,
          completed_at=NULL, owner_token=gen_random_uuid(), lease_expires_at=now() WHERE ${where}`, params, '42501'],
        [`UPDATE tpa.idempotency_records SET state='EXPIRED', response_status=NULL, response_body=NULL WHERE ${where}`, params, '42501'],
        [`UPDATE tpa.idempotency_records SET response_body='{"tampered":"yes"}' WHERE ${where}`, params, '42501'],
        [`DELETE FROM tpa.idempotency_records WHERE ${where}`, params, '42501'],
        ['TRUNCATE tpa.idempotency_records', [], '42501'],
        [`INSERT INTO tpa.idempotency_records(tenant_id,actor_type,actor_id,operation,idempotency_key,request_hash_version,
          request_hash,state,response_status,response_body,completed_at,expires_at) VALUES (tpa.current_tenant_id(),'USER',
          gen_random_uuid(),'syntheticCreate','pt22-precompleted-key','1',repeat('a',64),'COMPLETED',201,'{}',now(),now()+interval '1 day')`, [], '42501'],
        [`INSERT INTO tpa.idempotency_records(tenant_id,actor_type,actor_id,operation,idempotency_key,request_hash_version,
          request_hash,state,owner_token,lease_expires_at,created_at,expires_at) VALUES (tpa.current_tenant_id(),'USER',
          gen_random_uuid(),'syntheticCreate','pt22-backdated-key','1',repeat('a',64),'IN_PROGRESS',gen_random_uuid(),now(),
          now()-interval '3 days',now()-interval '1 day')`, [], '23514'],
        [`INSERT INTO tpa.idempotency_records(tenant_id,actor_type,actor_id,operation,idempotency_key,request_hash_version,
          request_hash,state,owner_token,lease_expires_at,expires_at) VALUES ($1,'USER',gen_random_uuid(),'syntheticCreate',
          'pt22-cross-tenant-key','1',repeat('a',64),'IN_PROGRESS',gen_random_uuid(),now(),now()+interval '1 day')`, [B], '42501'],
      ] as const) {
        await assert.rejects(pooled.withTenantTransaction(A, tx => tx.query(statement, [...values])), sqlCode(code), statement.slice(0, 60));
      }
      // Guard trigger applies to the table owner too, not only the app role.
      await admin.query('BEGIN');
      try {
        await admin.query("SELECT set_config('app.current_tenant_id',$1,true)", [A]);
        await admin.query('SET LOCAL ROLE tpa_migrator');
        await assert.rejects(admin.query(`DELETE FROM tpa.idempotency_records WHERE ${where}`, params), sqlCode('42501'));
      } finally { await admin.query('ROLLBACK'); }
      assert.deepEqual(await executeIdempotent(pooled, A, base, request, effect(fxBase)),
        { kind: 'replayed', response: original.kind === 'executed' && original.response });
      assert.equal(await effects(A, fxBase), 1);
    });

    await t.test('retention: expired keys never re-execute; expiry drops responses but keeps the tombstone', async () => {
      const completed = scopeFor(), leased = scopeFor(), fx = newLabel();
      assert.equal((await executeIdempotent(direct, C, completed, request, effect(fx))).kind, 'executed');
      assert.equal((await direct.withTenantTransaction(C, tx => beginIdempotent(tx, leased, requestHash(request), { leaseSeconds: 600 }))).kind, 'acquired');
      // Synthetic clock travel by the administrator only (bypasses triggers for test setup).
      await admin.query('BEGIN');
      try {
        await admin.query('SET LOCAL session_replication_role = replica');
        const moved = await admin.query(`UPDATE tpa.idempotency_records SET created_at=now()-interval '3 days',
          expires_at=now()-interval '2 days' WHERE tenant_id=$1`, [C]);
        assert.equal(moved.rowCount, 2);
        await admin.query('COMMIT');
      } catch (error) { await admin.query('ROLLBACK'); throw error; }
      assert.deepEqual(await executeIdempotent(direct, C, completed, request, effect(fx)), { kind: 'expired' });
      assert.deepEqual(await executeIdempotent(direct, C, completed, { ...request, amount: '9.00' }, effect(fx)), { kind: 'conflict' });
      assert.deepEqual(await executeIdempotent(direct, C, leased, request, effect(fx)), { kind: 'expired' });
      assert.equal(await direct.withTenantTransaction(A, tx => expireIdempotencyRecords(tx)), 0, 'expiry is tenant scoped');
      assert.equal(await direct.withTenantTransaction(C, tx => expireIdempotencyRecords(tx)), 1, 'live leased attempt is skipped');
      const tombstone = await record(C, completed);
      assert.equal(tombstone.state, 'EXPIRED');
      assert.equal(tombstone.response_body, null);
      assert.equal(tombstone.response_status, null);
      assert.equal(tombstone.request_hash, requestHash(request));
      assert.deepEqual(await executeIdempotent(direct, C, completed, request, effect(fx)), { kind: 'expired' });
      await assert.rejects(direct.withTenantTransaction(C, tx => tx.query(`UPDATE tpa.idempotency_records SET state='IN_PROGRESS',
        owner_token=gen_random_uuid(), lease_expires_at=now() WHERE idempotency_key=$1`, [completed.key])), sqlCode('42501'));
      assert.equal(await effects(C, fx), 1);
    });
  } finally {
    await Promise.allSettled(databases.map(db => db.close()));
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
