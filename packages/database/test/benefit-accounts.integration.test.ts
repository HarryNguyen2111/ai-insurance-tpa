import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';
import { validateEventEnvelope } from '@tpa/event-contracts';
import { migrateDatabase } from '../src/migrate.ts';
import { appendOutboxEvent } from '../src/outbox.ts';
import { createTenantDatabase, type TenantDatabase, type TenantTransaction } from '../src/tenant.ts';

// BEN-03 (#34) on actual PostgreSQL 16 through tpa_app + withTenantTransaction (SET LOCAL).
// Synthetic technical accounts only (no PII, no real policy terms).
const root = fileURLToPath(new URL('../../../', import.meta.url));
const image = 'pgvector/pgvector:0.8.7-pg16-trixie@sha256:c28c0b700f3f1b5eec14082b31ad6e7c8a566d14386323609c615315e7c0ffc8';
const crashChild = fileURLToPath(new URL('./fixtures/benefit-crash-child.ts', import.meta.url));
const MONEY = /^(0|[1-9][0-9]{0,12})\.[0-9]{2}$/;
const code = (expected: string) => (e: unknown) => e instanceof Error && 'code' in e && e.code === expected;
function docker(...args: string[]) {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 150000 }).trim(); }
  catch { throw new Error(`Synthetic Docker ${args[0]} failed (output suppressed)`); }
}
const randomMoney = (maxInt: number) => `${randomInt(0, maxInt)}.${String(randomInt(1, 100)).padStart(2, '0')}`;

test('BEN-03 PG16: atomic reservations, PT03 concurrency, idempotency, rollback and expiry', async t => {
  const name = `tpa-ben03-${randomBytes(6).toString('hex')}`, password = randomBytes(24).toString('hex');
  let started = false; const clients: pg.Client[] = []; let db: TenantDatabase | undefined;
  try {
    docker('run', '-d', '--name', name, '--label', `ao.session=${process.env.AO_SESSION_ID ?? name}`,
      '--memory', '384m', '--cpus', '1', '--tmpfs', '/var/lib/postgresql/data:rw,size=512m', '-p', '127.0.0.1::5432',
      '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=tpa', image); started = true;
    const port = docker('port', name, '5432/tcp').split(':').at(-1)!;
    const url = (user: string) => `postgresql://${user}:${password}@127.0.0.1:${port}/tpa`;
    const deadline = Date.now() + 40000;
    let admin: pg.Client | undefined;
    while (!admin) {
      const c = new pg.Client({ connectionString: url('postgres'), connectionTimeoutMillis: 2000 });
      try { await c.connect(); admin = c; clients.push(c); }
      catch { await c.end().catch(() => {}); if (Date.now() > deadline) throw new Error('Synthetic PG16 readiness timed out'); await delay(250); }
    }
    assert.match((await admin.query('SHOW server_version')).rows[0].server_version, /^16\./);
    await admin.query(await readFile(`${root}infra/migrations/bootstrap.sql`, 'utf8'));
    for (const role of ['tpa_app', 'tpa_migrator']) {
      const { rows: [command] } = await admin.query("SELECT format('ALTER ROLE %I PASSWORD %L',$1::text,$2::text) AS sql", [role, password]);
      await admin.query(command.sql);
    }
    await migrateDatabase(url('tpa_migrator'));
    db = createTenantDatabase({ connectionString: url('tpa_app'), max: 12 }); const database = db;
    // Dynamic file URLs run the actual core modules without adding a package dependency.
    const policy = await import(new URL('../../../apps/core-api/src/policy-benefit/policy-benefit.ts', import.meta.url).href);
    const ben = await import(new URL('../../../apps/core-api/src/benefit-accounts/benefit-accounts.ts', import.meta.url).href);
    const outbox = (tx: TenantTransaction, draft: Parameters<typeof appendOutboxEvent>[1]) => appendOutboxEvent(tx, draft);
    const service = new ben.BenefitAccountsService(database, outbox);
    const fixtureText = await readFile(new URL('./fixtures/policy-benefit.json', import.meta.url), 'utf8');
    const approved = new Set<string>();
    const repository = new policy.PolicyBenefitRepository(database, async (r: { contentHash: string }) => approved.has(r.contentHash));
    const authorize = (value: unknown) => approved.add(policy.configurationHash(value));
    const actor = { type: 'SERVICE', id: randomUUID() };
    const trace = () => ({ correlationId: randomUUID(), causationId: randomUUID() });
    const opKey = () => `ben03:${randomUUID()}`;
    const rows = (tenant: string, sql: string, values: unknown[] = []) =>
      database.withTenantTransaction(tenant, async tx => (await tx.query(sql, values)).rows);
    /** Synthetic approved coverage with the given annual limit, plus its contract-year account. */
    const setup = async (limit = '1000000.00', tenantId: string = randomUUID()) => {
      const f = JSON.parse(fixtureText); f.tenantId = tenantId;
      f.rule.annualLimit = limit; f.rule.perVisitLimit = limit;
      authorize(f.policy);
      const policyRef = await repository.createPolicy(tenantId, f.actorId, f.policy);
      f.rule.policyVersion = policyRef; authorize(f.rule); const ruleRef = await repository.createRule(tenantId, f.actorId, f.rule);
      f.coverage.policyVersion = policyRef; f.coverage.ruleVersion = ruleRef; authorize(f.coverage);
      await repository.createCoverage(tenantId, f.actorId, f.coverage);
      const account = await service.openAccount(tenantId, actor, { coverageId: f.coverage.id, limitGroup: 'ANNUAL',
        periodStart: '2026-01-01', periodEnd: '2026-12-31', trace: trace() });
      return { tenantId, f, account };
    };
    const acquire = (tenantId: string, holds: { accountId: string; amount: string }[], extra: Record<string, unknown> = {}) =>
      service.acquire(tenantId, actor, { operationKey: opKey(), claimId: randomUUID(), ttlSeconds: 600, trace: trace(), holds, ...extra });
    /** Ledger reconciliation computed by PostgreSQL from three independent tables. */
    const reconcile = async (tenantId: string, accountId: string) => {
      const [r] = await rows(tenantId, `SELECT a.limit_amount::text AS limit_amount, a.used_amount::text AS used, a.reserved_amount::text AS reserved,
          a.version, (a.used_amount + a.reserved_amount <= a.limit_amount) AS within_limit,
          (SELECT coalesce(sum(reserved_delta),0) FROM tpa.benefit_movements m WHERE m.account_id=a.id) = a.reserved_amount AS journal_reserved,
          (SELECT coalesce(sum(used_delta),0) FROM tpa.benefit_movements m WHERE m.account_id=a.id) = a.used_amount AS journal_used,
          (SELECT coalesce(sum(amount),0) FROM tpa.benefit_reservations r WHERE r.account_id=a.id AND r.status='HELD') = a.reserved_amount AS held_matches,
          (SELECT coalesce(sum(consumed_amount),0) FROM tpa.benefit_reservations r WHERE r.account_id=a.id) = a.used_amount AS consumed_matches,
          (SELECT count(*)::int FROM tpa.benefit_movements m WHERE m.account_id=a.id) + 1 = a.version AS versions_match,
          (SELECT count(*)::int FROM tpa.audit_logs l WHERE l.entity_type='BENEFIT_ACCOUNT' AND l.entity_id=a.id) AS audits,
          (SELECT array_agg(o.aggregate_version ORDER BY o.aggregate_version) FROM tpa.outbox_events o WHERE o.aggregate_id=a.id) AS event_versions
        FROM tpa.benefit_accounts a WHERE a.id=$1`, [accountId]);
      for (const key of ['within_limit', 'journal_reserved', 'journal_used', 'held_matches', 'consumed_matches', 'versions_match']) {
        assert.equal(r[key], true, `ledger invariant ${key}`);
      }
      assert.equal(r.audits, r.version, 'one audit per committed change');
      assert.deepEqual(r.event_versions, Array.from({ length: r.version as number }, (_, i) => i + 1), 'one outbox event per account version');
      for (const m of [r.limit_amount, r.used, r.reserved]) assert.match(m as string, MONEY);
      return r;
    };
    t.diagnostic(`Actual PostgreSQL ${(await admin.query('SHOW server_version')).rows[0].server_version}; tpa_app via withTenantTransaction SET LOCAL`);

    await t.test('contract-year account derives limit/clause from approved rule; open is idempotent; overlap rejected', async () => {
      const { tenantId, f, account } = await setup('1000000.00');
      assert.equal(account.limitAmount, '1000000.00'); assert.equal(account.availableAmount, '1000000.00');
      assert.equal(account.clauseId, f.rule.clauseId); assert.equal(account.version, 1);
      const again = await service.openAccount(tenantId, actor, { coverageId: f.coverage.id, limitGroup: 'ANNUAL',
        periodStart: '2026-01-01', periodEnd: '2026-12-31', trace: trace() });
      assert.equal(again.accountId, account.accountId);
      await assert.rejects(service.openAccount(tenantId, actor, { coverageId: f.coverage.id, limitGroup: 'ANNUAL',
        periodStart: '2026-06-01', periodEnd: '2026-12-31', trace: trace() }), (e: Error) => e instanceof ben.BenefitStateError && /PERIOD_OVERLAP/.test(e.message));
      await assert.rejects(service.openAccount(tenantId, actor, { coverageId: f.coverage.id, limitGroup: 'ANNUAL',
        periodStart: '2027-01-01', periodEnd: '2027-12-31', trace: trace() }), ben.BenefitInputError);
      await assert.rejects(service.openAccount(tenantId, actor, { coverageId: randomUUID(), limitGroup: 'ANNUAL',
        periodStart: '2026-01-01', periodEnd: '2026-12-31', trace: trace() }), ben.BenefitNotFound);
      await reconcile(tenantId, account.accountId);
    });

    await t.test('PT03: two concurrent 800000.00 holds against 1000000.00 never overspend (20 rounds)', async () => {
      for (let round = 0; round < 20; round++) {
        const { tenantId, account } = await setup('1000000.00');
        const hold = [{ accountId: account.accountId, amount: '800000.00' }];
        const results = await Promise.all([acquire(tenantId, hold), acquire(tenantId, hold)]);
        const kinds = results.map(r => r.kind).sort();
        assert.deepEqual(kinds, ['INSUFFICIENT_LIMIT', 'RESERVED']);
        const denied = results.find(r => r.kind === 'INSUFFICIENT_LIMIT');
        assert.deepEqual(denied.shortfalls, [{ accountId: account.accountId, requestedAmount: '800000.00', availableAmount: '200000.00', clauseId: account.clauseId }]);
        const r = await reconcile(tenantId, account.accountId);
        assert.equal(r.reserved, '800000.00'); assert.equal(r.used, '0.00');
      }
    });

    await t.test('PT03 storm: 40 concurrent random-cent holds; granted sum <= limit and ledger reconciles', async () => {
      const { tenantId, account } = await setup('1000000.00');
      const amounts = Array.from({ length: 40 }, () => randomMoney(150000));
      const results = await Promise.all(amounts.map(amount => acquire(tenantId, [{ accountId: account.accountId, amount }])));
      const granted = amounts.filter((_, i) => results[i].kind === 'RESERVED');
      assert.ok(granted.length > 0);
      const [sum] = await rows(tenantId, `SELECT sum(x)::text AS granted, sum(x) <= 1000000.00 AS ok FROM unnest($1::numeric[]) x`, [granted]);
      assert.equal(sum.ok, true);
      const r = await reconcile(tenantId, account.accountId);
      assert.equal(r.reserved, sum.granted);
      for (const [i, result] of results.entries()) {
        if (result.kind === 'INSUFFICIENT_LIMIT') {
          const [check] = await rows(tenantId, 'SELECT $1::numeric > $2::numeric AS ok', [amounts[i], result.shortfalls[0].availableAmount]);
          assert.equal(check.ok, true, 'denied only when the request exceeded the then-available amount');
        } else assert.equal(result.reservations[0].amount, amounts[i]);
      }
    });

    await t.test('multi-account holds in opposite orders cannot deadlock (stable lock ordering)', async () => {
      const tenantId = randomUUID();
      const { account: a } = await setup('1000000.00', tenantId);
      // Second account: same tenant, different synthetic member/plan configuration.
      const f = JSON.parse(fixtureText);
      f.policy.id = randomUUID(); f.policy.policyId = randomUUID(); f.policy.clauses[0].clauseId = randomUUID(); f.rule.clauseId = f.policy.clauses[0].clauseId;
      f.rule.id = randomUUID(); f.rule.planId = randomUUID(); f.coverage.id = randomUUID(); f.coverage.planId = f.rule.planId;
      f.rule.annualLimit = '1000000.00'; f.rule.perVisitLimit = '1000000.00';
      for (const term of Object.values(f.rule.edgeTerms) as { clauseId: string }[]) term.clauseId = f.rule.clauseId;
      authorize(f.policy); f.rule.policyVersion = await repository.createPolicy(tenantId, f.actorId, f.policy);
      authorize(f.rule); f.coverage.ruleVersion = await repository.createRule(tenantId, f.actorId, f.rule);
      f.coverage.policyVersion = f.rule.policyVersion; authorize(f.coverage); await repository.createCoverage(tenantId, f.actorId, f.coverage);
      const b = await service.openAccount(tenantId, actor, { coverageId: f.coverage.id, limitGroup: 'ANNUAL', periodStart: '2026-01-01', periodEnd: '2026-12-31', trace: trace() });
      const results = await Promise.allSettled(Array.from({ length: 24 }, (_, i) => acquire(tenantId, i % 2
        ? [{ accountId: a.accountId, amount: '50000.00' }, { accountId: b.accountId, amount: '70000.00' }]
        : [{ accountId: b.accountId, amount: '70000.00' }, { accountId: a.accountId, amount: '50000.00' }])));
      assert.ok(results.every(r => r.status === 'fulfilled'), 'no deadlock (40P01) or serialization failure');
      const reserved = results.filter(r => r.status === 'fulfilled' && r.value.kind === 'RESERVED').length;
      assert.equal(reserved, 14); // b: 14 x 70000.00 = 980000.00 <= 1000000.00; the 15th would overspend
      assert.equal((await reconcile(tenantId, a.accountId)).reserved, '700000.00');
      assert.equal((await reconcile(tenantId, b.accountId)).reserved, '980000.00');
    });

    await t.test('acquire/consume/release idempotency: concurrent retries, replay, conflicts and terminal states', async () => {
      const { tenantId, account } = await setup('1000000.00');
      const input = { operationKey: opKey(), claimId: randomUUID(), ttlSeconds: 600, holds: [{ accountId: account.accountId, amount: '800000.00' }] };
      const retries = await Promise.all(Array.from({ length: 5 }, () => service.acquire(tenantId, actor, { ...input, trace: trace() })));
      const ids = new Set(retries.map(r => r.reservations[0].reservationId));
      assert.equal(ids.size, 1); assert.equal(retries.filter(r => !r.replayed).length, 1);
      assert.equal((await reconcile(tenantId, account.accountId)).reserved, '800000.00');
      await assert.rejects(service.acquire(tenantId, actor, { ...input, trace: trace(), holds: [{ accountId: account.accountId, amount: '800000.01' }] }),
        ben.BenefitIdempotencyConflict);
      await assert.rejects(service.acquire(tenantId, { type: 'SERVICE', id: randomUUID() }, { ...input, trace: trace() }), ben.BenefitIdempotencyConflict);
      await assert.rejects(acquire(tenantId, input.holds, { claimId: input.claimId }), (e: Error) => /CLAIM_ALREADY_RESERVED/.test(e.message));
      const reservationId = [...ids][0];
      // Partial consumption: 600000.00 used, the 200000.00 remainder returns to the limit.
      const consumeInput = { operationKey: opKey(), items: [{ reservationId, amount: '600000.00' }] };
      const consumed = await Promise.all([1, 2, 3].map(() => service.consume(tenantId, actor, { ...consumeInput, trace: trace() })));
      assert.ok(consumed.every(c => c.kind === 'APPLIED' && c.reservations[0].status === 'CONSUMED' && c.reservations[0].consumedAmount === '600000.00'));
      assert.equal(consumed.filter(c => !c.replayed).length, 1);
      let r = await reconcile(tenantId, account.accountId);
      assert.equal(r.used, '600000.00'); assert.equal(r.reserved, '0.00');
      await assert.rejects(service.consume(tenantId, actor, { ...consumeInput, trace: trace(), items: [{ reservationId, amount: '600000.01' }] }),
        ben.BenefitIdempotencyConflict);
      assert.deepEqual(await service.release(tenantId, actor, { operationKey: opKey(), trace: trace(), reservationIds: [reservationId] }),
        { kind: 'NOT_ACTIVE', reservations: [{ reservationId, status: 'CONSUMED' }], replayed: false });
      assert.equal((await service.consume(tenantId, actor, { operationKey: opKey(), trace: trace(), items: [{ reservationId, amount: '1.00' }] })).kind, 'NOT_ACTIVE');
      // Remaining capacity is exact to the cent.
      assert.equal((await acquire(tenantId, [{ accountId: account.accountId, amount: '400000.01' }])).kind, 'INSUFFICIENT_LIMIT');
      const last = await acquire(tenantId, [{ accountId: account.accountId, amount: '400000.00' }]);
      assert.equal(last.kind, 'RESERVED');
      await assert.rejects(service.consume(tenantId, actor, { operationKey: opKey(), trace: trace(),
        items: [{ reservationId: last.reservations[0].reservationId, amount: '400000.01' }] }), ben.BenefitInputError);
      const id2 = last.reservations[0].reservationId;
      const rel = await service.release(tenantId, actor, { operationKey: opKey(), trace: trace(), reservationIds: [id2] });
      assert.equal(rel.reservations[0].status, 'RELEASED');
      const rel2 = await service.release(tenantId, actor, { operationKey: opKey(), trace: trace(), reservationIds: [id2] });
      assert.equal(rel2.kind, 'APPLIED'); // already released: no-op, no new movement
      r = await reconcile(tenantId, account.accountId);
      assert.equal(r.used, '600000.00'); assert.equal(r.reserved, '0.00');
      await assert.rejects(service.release(tenantId, actor, { operationKey: opKey(), trace: trace(), reservationIds: [randomUUID()] }), ben.BenefitNotFound);
    });

    await t.test('fault: outbox failure and backend crash mid-transaction roll back everything; retry succeeds once', async () => {
      const { tenantId, account } = await setup('1000000.00');
      const snapshot = async () => (await rows(tenantId, `SELECT (SELECT version FROM tpa.benefit_accounts) AS v,
        (SELECT count(*)::int FROM tpa.benefit_operations) AS ops, (SELECT count(*)::int FROM tpa.benefit_reservations) AS res,
        (SELECT count(*)::int FROM tpa.benefit_movements) AS mov, (SELECT count(*)::int FROM tpa.audit_logs) AS audits,
        (SELECT count(*)::int FROM tpa.outbox_events) AS events`))[0];
      const before = await snapshot();
      const input = { operationKey: opKey(), claimId: randomUUID(), ttlSeconds: 600, trace: trace(), holds: [{ accountId: account.accountId, amount: '800000.00' }] };
      const failing = new ben.BenefitAccountsService(database, async () => { throw new Error('Synthetic outbox failure'); });
      await assert.rejects(failing.acquire(tenantId, actor, input), /Synthetic outbox failure/);
      assert.deepEqual(await snapshot(), before);
      // Server-side interruption of the transaction's own statement (57014) mid-write.
      const cancelled = new ben.BenefitAccountsService(database, async (tx: TenantTransaction) => {
        await tx.query('SELECT pg_cancel_backend(pg_backend_pid()), pg_sleep(5)');
      });
      await assert.rejects(cancelled.acquire(tenantId, actor, input), code('57014'));
      assert.deepEqual(await snapshot(), before);
      // A waiter blocked behind a transaction that later rolls back sees the full limit.
      const slow = new ben.BenefitAccountsService(database, async () => { await delay(400); throw new Error('Synthetic late failure'); });
      const blocked = slow.acquire(tenantId, actor, { ...input, operationKey: opKey() });
      await delay(100);
      const waiter = await acquire(tenantId, [{ accountId: account.accountId, amount: '800000.00' }]);
      await assert.rejects(blocked, /Synthetic late failure/);
      assert.equal(waiter.kind, 'RESERVED');
      const retried = await service.acquire(tenantId, actor, input);
      assert.equal(retried.kind, 'INSUFFICIENT_LIMIT'); // original key was never committed, so it is evaluated afresh
      assert.equal((await reconcile(tenantId, account.accountId)).reserved, '800000.00');
    });

    await t.test('fault: SIGKILLed process holding an uncommitted reservation; retry of its key commits exactly once', async () => {
      const { tenantId, account } = await setup('1000000.00');
      const request = { operationKey: opKey(), claimId: randomUUID(), ttlSeconds: 600, trace: trace(), holds: [{ accountId: account.accountId, amount: '800000.00' }] };
      const child = spawn(process.execPath, [crashChild], { stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH ?? '', TPA_CRASH_DATABASE_URL: url('tpa_app'), TPA_CRASH_INPUT: JSON.stringify({ tenantId, actor, request }) } });
      const exited = once(child, 'exit');
      try {
        await new Promise<void>((resolve, reject) => {
          let output = '';
          const timer = setTimeout(() => reject(new Error('crash child did not reach its crash point')), 30_000);
          child.stdout!.on('data', chunk => { output += chunk; if (output.includes('CRASH_POINT')) { clearTimeout(timer); resolve(); } });
          child.once('exit', () => { clearTimeout(timer); reject(new Error('crash child exited before its crash point')); });
        });
        // While the dead-to-be transaction holds the lock, a competing hold waits (cannot overspend).
        const competitor = acquire(tenantId, [{ accountId: account.accountId, amount: '300000.00' }]);
        await delay(200);
        child.kill('SIGKILL'); await exited;
        assert.equal((await competitor).kind, 'RESERVED');
      } finally { child.kill('SIGKILL'); }
      // Same key: the uncommitted key row vanished with the crash, so it executes once now.
      const retried = await service.acquire(tenantId, actor, request);
      assert.equal(retried.kind, 'INSUFFICIENT_LIMIT');
      const replay = await service.acquire(tenantId, actor, request);
      assert.deepEqual(replay, { ...retried, replayed: true });
      const r = await reconcile(tenantId, account.accountId);
      assert.equal(r.reserved, '300000.00');
      assert.equal((await rows(tenantId, 'SELECT count(*)::int AS n FROM tpa.benefit_reservations'))[0].n, 1);
    });

    await t.test('expiry: due holds free capacity lazily and via sweep; expired holds cannot be consumed; sweeps are idempotent', async () => {
      const { tenantId, account } = await setup('1000000.00');
      const short = await acquire(tenantId, [{ accountId: account.accountId, amount: '800000.00' }], { ttlSeconds: 1 });
      assert.equal(short.kind, 'RESERVED');
      assert.equal((await acquire(tenantId, [{ accountId: account.accountId, amount: '800000.00' }])).kind, 'INSUFFICIENT_LIMIT');
      await delay(1500);
      const next = await acquire(tenantId, [{ accountId: account.accountId, amount: '800000.00' }]);
      assert.equal(next.kind, 'RESERVED');
      const expiredId = short.reservations[0].reservationId;
      const [expired] = await rows(tenantId, 'SELECT status FROM tpa.benefit_reservations WHERE id=$1', [expiredId]);
      assert.equal(expired.status, 'EXPIRED');
      const [system] = await rows(tenantId, `SELECT actor_type, actor_id FROM tpa.audit_logs WHERE action='BENEFIT_EXPIRED'`);
      assert.deepEqual(system, { actor_type: 'SYSTEM', actor_id: ben.SYSTEM_EXPIRY_ACTOR.id });
      assert.deepEqual(await service.consume(tenantId, actor, { operationKey: opKey(), trace: trace(), items: [{ reservationId: expiredId, amount: '1.00' }] }),
        { kind: 'NOT_ACTIVE', reservations: [{ reservationId: expiredId, status: 'EXPIRED' }], replayed: false });
      assert.equal((await service.release(tenantId, actor, { operationKey: opKey(), trace: trace(), reservationIds: [expiredId] })).kind, 'APPLIED');
      // Sweep path, run concurrently: exactly one expiry movement per due hold.
      await service.release(tenantId, actor, { operationKey: opKey(), trace: trace(), reservationIds: [next.reservations[0].reservationId] });
      const due = await Promise.all([1, 2, 3].map(() => acquire(tenantId, [{ accountId: account.accountId, amount: '300000.00' }], { ttlSeconds: 1 })));
      assert.ok(due.every(d => d.kind === 'RESERVED'));
      await delay(1500);
      const swept = await Promise.all([1, 2, 3].map(() => service.expireDue(tenantId, { limit: 100, trace: trace() })));
      assert.equal(swept.reduce((s, n) => s + n, 0), 3);
      assert.equal(await service.expireDue(tenantId, { limit: 100, trace: trace() }), 0);
      const r = await reconcile(tenantId, account.accountId);
      assert.equal(r.reserved, '0.00');
      assert.equal((await rows(tenantId, "SELECT count(*)::int AS n FROM tpa.benefit_movements WHERE movement_type='EXPIRE'"))[0].n, 4);
    });

    await t.test('money property: 150 random acquire/consume/release steps keep exact NUMERIC ledger invariants', async () => {
      const { tenantId, account } = await setup('2500000.00');
      const held: string[] = [];
      for (let step = 0; step < 150; step++) {
        const op = held.length === 0 ? 0 : randomInt(0, 3);
        if (op === 0) {
          const result = await acquire(tenantId, [{ accountId: account.accountId, amount: randomMoney(400000) }]);
          if (result.kind === 'RESERVED') held.push(result.reservations[0].reservationId);
        } else {
          const id = held.splice(randomInt(0, held.length), 1)[0];
          if (op === 1) {
            const [res] = await rows(tenantId, 'SELECT amount::text AS amount FROM tpa.benefit_reservations WHERE id=$1', [id]);
            // A random cent amount in (0, held] chosen by PostgreSQL NUMERIC, not JS floats.
            const [pick] = await rows(tenantId, `SELECT greatest(0.01, round($1::numeric * $2::numeric / 1000, 2))::text AS amount`, [res.amount, randomInt(1, 1001)]);
            const c = await service.consume(tenantId, actor, { operationKey: opKey(), trace: trace(), items: [{ reservationId: id, amount: pick.amount }] });
            assert.equal(c.kind, 'APPLIED'); assert.equal(c.reservations[0].consumedAmount, pick.amount);
          } else {
            assert.equal((await service.release(tenantId, actor, { operationKey: opKey(), trace: trace(), reservationIds: [id] })).kind, 'APPLIED');
          }
        }
        if (step % 10 === 0) await reconcile(tenantId, account.accountId);
      }
      const r = await reconcile(tenantId, account.accountId);
      const [check] = await rows(tenantId, `SELECT (SELECT sum(consumed_amount) FROM tpa.benefit_reservations)::text AS consumed,
        (SELECT sum(amount) FROM tpa.benefit_reservations WHERE status='HELD')::text AS held,
        (SELECT bool_and(scale(reserved_delta) = 2 AND scale(used_delta) = 2) FROM tpa.benefit_movements) AS scales`);
      assert.equal(check.scales, true);
      assert.equal(r.used, check.consumed ?? '0.00');
      assert.equal(r.reserved, check.held ?? '0.00');
    });

    await t.test('outbox envelopes validate; RLS isolates tenants; ledger is immutable and CHECK blocks overspend', async () => {
      const { tenantId, account } = await setup('1000000.00');
      const held = await acquire(tenantId, [{ accountId: account.accountId, amount: '800000.00' }]);
      const events = await rows(tenantId, 'SELECT envelope FROM tpa.outbox_events WHERE aggregate_id=$1 ORDER BY aggregate_version', [account.accountId]);
      assert.deepEqual(events.map(e => (e.envelope as { payload: { changeKind: string } }).payload.changeKind), ['ACCOUNT_OPENED', 'RESERVED']);
      for (const e of events) validateEventEnvelope(e.envelope);
      const other = randomUUID();
      for (const table of ['benefit_accounts', 'benefit_reservations', 'benefit_movements', 'benefit_operations']) {
        assert.equal((await rows(other, `SELECT * FROM tpa.${table}`)).length, 0);
        await assert.rejects(rows(tenantId, `DELETE FROM tpa.${table}`), code('42501'));
        await assert.rejects(rows(tenantId, `TRUNCATE tpa.${table}`), code('42501'));
        await assert.rejects(admin!.query(`TRUNCATE tpa.${table} CASCADE`), code('42501'));
      }
      await assert.rejects(acquire(other, [{ accountId: account.accountId, amount: '1.00' }]), ben.BenefitNotFound);
      await assert.rejects(service.release(other, actor, { operationKey: opKey(), trace: trace(), reservationIds: [held.reservations[0].reservationId] }), ben.BenefitNotFound);
      await assert.rejects(rows(tenantId, 'UPDATE tpa.benefit_accounts SET limit_amount = 1.00'), code('42501'));
      await assert.rejects(rows(tenantId, 'UPDATE tpa.benefit_accounts SET reserved_amount = 1000000.01, version = version + 1'), code('23514'));
      await assert.rejects(rows(tenantId, 'UPDATE tpa.benefit_movements SET used_delta = 0'), code('42501'));
      await assert.rejects(rows(tenantId, "UPDATE tpa.benefit_operations SET result = '{}'::jsonb"), code('42501'));
      await assert.rejects(rows(tenantId, "UPDATE tpa.benefit_reservations SET status='EXPIRED', version = version + 1"), code('23514'));
      // A forged movement that disagrees with the account is rejected.
      await assert.rejects(rows(tenantId, `INSERT INTO tpa.benefit_movements (tenant_id,id,account_id,reservation_id,movement_type,
          reserved_delta,used_delta,reserved_after,used_after,account_version)
        VALUES (tpa.current_tenant_id(),$1,$2,$3,'RELEASE',-800000.00,0,0,0,99)`, [randomUUID(), account.accountId, held.reservations[0].reservationId]), code('23514'));
      await reconcile(tenantId, account.accountId);
    });
  } finally {
    await db?.close(); await Promise.allSettled(clients.map(c => c.end()));
    if (started) docker('rm', '-f', '-v', name);
  }
});
