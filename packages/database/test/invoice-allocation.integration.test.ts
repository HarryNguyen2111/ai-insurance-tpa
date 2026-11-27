import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';
import { validateEventEnvelope } from '@tpa/event-contracts';
import { migrateDatabase } from '../src/migrate.ts';
import { appendOutboxEvent } from '../src/outbox.ts';
import { createTenantDatabase, type TenantDatabase, type TenantTransaction } from '../src/tenant.ts';

// BEN-04 (#35) PT04_GLOBAL_COINSURANCE on actual PostgreSQL 16 through tpa_app + withTenantTransaction
// (SET LOCAL). Distinct tenants race on one physical invoice. Synthetic invoices only (no PII, no real contracts).
const root = fileURLToPath(new URL('../../../', import.meta.url));
const image = 'pgvector/pgvector:0.8.7-pg16-trixie@sha256:c28c0b700f3f1b5eec14082b31ad6e7c8a566d14386323609c615315e7c0ffc8';
const MONEY = /^(0|[1-9][0-9]{0,12})\.[0-9]{2}$/;
const code = (expected: string) => (e: unknown) => e instanceof Error && 'code' in e && e.code === expected;
function docker(...args: string[]) {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 150000 }).trim(); }
  catch { throw new Error(`Synthetic Docker ${args[0]} failed (output suppressed)`); }
}
const randomMoney = (maxInt: number) => `${randomInt(1, maxInt)}.${String(randomInt(0, 100)).padStart(2, '0')}`;

test('BEN-04 PG16: PT04 global co-insurance races, duplicate blocking and no cross-tenant disclosure', async t => {
  const name = `tpa-ben04-${randomBytes(6).toString('hex')}`, password = randomBytes(24).toString('hex');
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
    const su = admin;
    assert.match((await su.query('SHOW server_version')).rows[0].server_version, /^16\./);
    await su.query(await readFile(`${root}infra/migrations/bootstrap.sql`, 'utf8'));
    for (const role of ['tpa_app', 'tpa_migrator']) {
      const { rows: [command] } = await su.query("SELECT format('ALTER ROLE %I PASSWORD %L',$1::text,$2::text) AS sql", [role, password]);
      await su.query(command.sql);
    }
    await migrateDatabase(url('tpa_migrator'));
    const raw = new pg.Client({ connectionString: url('tpa_app') }); await raw.connect(); clients.push(raw);
    db = createTenantDatabase({ connectionString: url('tpa_app'), max: 16 }); const database = db;
    // Dynamic file URL runs the actual core module without adding a package dependency.
    const inv = await import(new URL('../../../apps/core-api/src/invoice-allocation/invoice-allocation.ts', import.meta.url).href);
    let failOutbox = false;
    const outbox = (tx: TenantTransaction, draft: Parameters<typeof appendOutboxEvent>[1]) => {
      if (failOutbox) throw new Error('synthetic outbox failure');
      return appendOutboxEvent(tx, draft);
    };
    const service = new inv.InvoiceAllocationService(database, outbox);
    const actor = { type: 'SERVICE', id: randomUUID() };
    const trace = () => ({ correlationId: randomUUID(), causationId: randomUUID() });
    const opKey = () => `ben04:${randomUUID()}`;
    const proof = () => ({ documentId: randomUUID(), documentSha256: randomBytes(32).toString('hex'), verifiedBy: randomUUID() });
    const newInvoice = (totalAmount = '1000000.00') => ({ sellerTaxCode: '0101234567', invoiceSerial: '1C26TAA',
      invoiceNumber: String(randomInt(1, 2 ** 47)), totalAmount });
    type Invoice = ReturnType<typeof newInvoice>;
    const allocate = (tenantId: string, invoice: Invoice, amount: string, extra: Record<string, unknown> = {}) =>
      service.allocate(tenantId, actor, { operationKey: opKey(), claimId: randomUUID(), invoice, amount, trace: trace(), ...extra });
    const rows = (tenant: string, sql: string, values: unknown[] = []) =>
      database.withTenantTransaction(tenant, async tx => (await tx.query(sql, values)).rows);
    /** Global truth, read by the superuser only (never reachable by tpa_app). */
    const global = async (invoice: Invoice) => {
      const { rows: [r] } = await su.query(`SELECT r.total_amount::text AS total, r.allocated_amount::text AS allocated,
          (SELECT coalesce(sum(a.amount),0)::numeric(15,2) FROM tpa.invoice_registry_allocations a WHERE a.registry_id=r.id AND a.status='ACTIVE')::text AS ledger,
          (SELECT count(*)::int FROM tpa.invoice_registry_allocations a WHERE a.registry_id=r.id AND a.status='ACTIVE') AS active,
          r.allocated_amount <= r.total_amount AS within_total
        FROM tpa.invoice_registry r WHERE r.invoice_hash=$1`, [inv.invoiceIdentityHash(invoice)]);
      if (r) { assert.equal(r.within_total, true); assert.equal(r.allocated, r.ledger, 'registry sum equals global ledger'); assert.match(r.allocated, MONEY); }
      return r as { total: string; allocated: string; ledger: string; active: number } | undefined;
    };
    /** Odd race rounds start on an already-registered invoice (a third tenant allocated then released), so the
     * global row lock -- not the first-registration unique-index wait -- is what serializes the racers. */
    const prepare = async (round: number, total: string) => {
      const invoice = newInvoice(total);
      if (round % 2 === 1) {
        const x = randomUUID(), warm = await allocate(x, invoice, '0.01');
        assert.equal(warm.kind, 'ALLOCATED');
        assert.equal((await service.release(x, actor, { operationKey: opKey(), allocationId: warm.allocation.allocationId, trace: trace() })).kind, 'RELEASED');
      }
      return invoice;
    };
    t.diagnostic(`Actual PostgreSQL ${(await su.query('SHOW server_version')).rows[0].server_version}; tpa_app via withTenantTransaction SET LOCAL`);

    await t.test('reviewed privileged surface: no app access to global tables; SECURITY DEFINER functions pinned and least-privilege', async () => {
      const tenantId = randomUUID();
      for (const table of ['invoice_registry', 'invoice_registry_allocations']) {
        for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES']) {
          assert.equal((await su.query('SELECT has_table_privilege($1,$2,$3) AS ok', ['tpa_app', `tpa.${table}`, priv])).rows[0].ok, false, `${table} ${priv}`);
        }
        await assert.rejects(rows(tenantId, `SELECT * FROM tpa.${table}`), code('42501'));
        await assert.rejects(raw.query(`SELECT count(*) FROM tpa.${table}`), code('42501'));
      }
      const { rows: tables } = await su.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, r.rolname AS owner,
          (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname='tpa' AND p.tablename=c.relname) AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
        WHERE n.nspname='tpa' AND c.relname LIKE 'invoice_%' AND c.relkind='r' ORDER BY c.relname`);
      assert.deepEqual(tables, [
        { relname: 'invoice_allocation_operations', relrowsecurity: true, relforcerowsecurity: true, owner: 'tpa_migrator', policies: 1 },
        { relname: 'invoice_allocations', relrowsecurity: true, relforcerowsecurity: true, owner: 'tpa_migrator', policies: 1 },
        { relname: 'invoice_registry', relrowsecurity: true, relforcerowsecurity: false, owner: 'tpa_migrator', policies: 0 },
        { relname: 'invoice_registry_allocations', relrowsecurity: true, relforcerowsecurity: false, owner: 'tpa_migrator', policies: 0 },
      ]);
      const { rows: fns } = await su.query(`SELECT p.proname, p.prosecdef, p.proconfig, r.rolname AS owner,
          has_function_privilege('tpa_app', p.oid, 'EXECUTE') AS app,
          EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0) AS public_execute
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
        WHERE n.nspname='tpa' AND p.proname IN ('invoice_allocate','invoice_release','check_invoice_allocation_pair','guard_invoice_allocation') ORDER BY p.proname`);
      assert.deepEqual(fns, [
        { proname: 'check_invoice_allocation_pair', prosecdef: true, proconfig: ['search_path=pg_catalog'], owner: 'tpa_migrator', app: false, public_execute: false },
        { proname: 'guard_invoice_allocation', prosecdef: false, proconfig: ['search_path=pg_catalog'], owner: 'tpa_migrator', app: false, public_execute: false },
        { proname: 'invoice_allocate', prosecdef: true, proconfig: ['search_path=pg_catalog'], owner: 'tpa_migrator', app: true, public_execute: false },
        { proname: 'invoice_release', prosecdef: true, proconfig: ['search_path=pg_catalog'], owner: 'tpa_migrator', app: true, public_execute: false },
      ]);
      // Without a SET LOCAL tenant the privileged functions fail closed.
      await assert.rejects(raw.query("SELECT * FROM tpa.invoice_allocate(repeat('a',64),1000.00,gen_random_uuid(),1.00,false)"), code('42501'));
      await assert.rejects(raw.query('SELECT tpa.invoice_release(gen_random_uuid())'), code('42501'));
      assert.equal((await su.query("SELECT count(*)::int AS n FROM tpa.invoice_registry WHERE invoice_hash=repeat('a',64)")).rows[0].n, 0);
    });

    await t.test('PT04 race: two tenants co-insure 700000.00 each on a 1000000.00 invoice; never exceeds total (30 rounds, fresh and pre-registered)', async () => {
      for (let round = 0; round < 30; round++) {
        const invoice = await prepare(round, '1000000.00'), a = randomUUID(), b = randomUUID();
        const results = await Promise.all([a, b].map(tenant => allocate(tenant, invoice, '700000.00', { coInsuranceProof: proof() })));
        assert.deepEqual(results.map(r => r.kind).sort(), ['ALLOCATED', 'EXCEEDS_INVOICE_TOTAL']);
        const loser = results[0].kind === 'ALLOCATED' ? b : a;
        assert.deepEqual(results.find(r => r.kind !== 'ALLOCATED'), { kind: 'EXCEEDS_INVOICE_TOTAL', replayed: false });
        assert.equal((await rows(loser, 'SELECT * FROM tpa.invoice_allocations')).length, 0, 'loser has no allocation row');
        const g = await global(invoice);
        assert.equal(g!.allocated, '700000.00'); assert.equal(g!.active, 1);
      }
    });

    await t.test('PT04 storm: 12 tenants with proof on a pre-registered invoice and random-cent amounts; global sum <= total and equals per-tenant rows', async () => {
      const invoice = await prepare(1, '1000000.00');
      const tenants = Array.from({ length: 12 }, () => randomUUID());
      const amounts = tenants.map(() => randomMoney(250000));
      const results = await Promise.all(tenants.map((tenant, i) => allocate(tenant, invoice, amounts[i], { coInsuranceProof: proof() })));
      const granted = amounts.filter((_, i) => results[i].kind === 'ALLOCATED');
      assert.ok(granted.length >= 4, 'at least 4 x <=250000 always fit');
      assert.ok(results.every(r => r.kind === 'ALLOCATED' || r.kind === 'EXCEEDS_INVOICE_TOTAL'));
      const g = await global(invoice);
      const { rows: [sum] } = await su.query('SELECT sum(x)::text AS s, sum(x) <= 1000000.00 AS ok FROM unnest($1::numeric[]) x', [granted]);
      assert.equal(sum.ok, true); assert.equal(g!.allocated, sum.s); assert.equal(g!.active, granted.length);
      // Each tenant sees exactly its own row; the per-tenant views add up to the global truth.
      const own: string[] = [];
      for (const [i, tenant] of tenants.entries()) {
        const mine = await rows(tenant, 'SELECT allocated_amount::text AS amount, tenant_id::text AS tenant FROM tpa.invoice_allocations');
        assert.equal(mine.length, results[i].kind === 'ALLOCATED' ? 1 : 0);
        for (const m of mine) { assert.equal(m.tenant, tenant); assert.equal(m.amount, amounts[i]); own.push(m.amount as string); }
        if (results[i].kind === 'EXCEEDS_INVOICE_TOTAL') {
          // Denied only when the request truly exceeded what was left at that moment; never because of a race.
          const { rows: [chk] } = await su.query('SELECT $1::numeric + $2::numeric > 1000000.00 AS ok', [sum.s, amounts[i]]);
          assert.equal(chk.ok, true);
        }
      }
      assert.equal((await su.query('SELECT sum(x)::text AS s FROM unnest($1::numeric[]) x', [own])).rows[0].s, g!.allocated);
    });

    await t.test('PT04 duplicate race: two tenants without co-insurance proof; exactly one wins (30 rounds, fresh and pre-registered)', async () => {
      for (let round = 0; round < 30; round++) {
        const invoice = await prepare(round, '500000.00');
        const results = await Promise.all([randomUUID(), randomUUID()].map(tenant => allocate(tenant, invoice, '100000.00')));
        assert.deepEqual(results.map(r => r.kind).sort(), ['ALLOCATED', 'DUPLICATE_INVOICE']);
        const g = await global(invoice);
        assert.equal(g!.allocated, '100000.00'); assert.equal(g!.active, 1);
      }
    });

    await t.test('duplicate rules: proof needed for a second insurer; same insurer never twice; variants and total mismatch blocked', async () => {
      const invoice = newInvoice('1000000.00'), a = randomUUID(), b = randomUUID(), c = randomUUID();
      const first = await allocate(a, invoice, '600000.00');
      assert.equal(first.kind, 'ALLOCATED'); assert.equal(first.allocation.coInsurance, false);
      assert.equal(first.allocation.invoiceHash, inv.invoiceIdentityHash(invoice));
      assert.deepEqual(await allocate(b, invoice, '400000.00'), { kind: 'DUPLICATE_INVOICE', replayed: false });
      // Formatting variants of the same physical invoice hash identically.
      const variant = { ...invoice, invoiceSerial: invoice.invoiceSerial.toLowerCase(), invoiceNumber: `000${invoice.invoiceNumber}` };
      assert.deepEqual(await allocate(c, variant, '1.00'), { kind: 'DUPLICATE_INVOICE', replayed: false });
      // Same insurer cannot co-insure with itself, even with proof or for another claim.
      assert.deepEqual(await allocate(a, invoice, '1.00', { coInsuranceProof: proof() }), { kind: 'DUPLICATE_INVOICE', replayed: false });
      assert.deepEqual(await allocate(a, invoice, '1.00', { claimId: first.allocation.claimId }), { kind: 'DUPLICATE_INVOICE', replayed: false });
      // A different extracted total is a mismatch (review), never silently re-registered.
      assert.deepEqual(await allocate(b, { ...invoice, totalAmount: '1000000.01' }, '1.00', { coInsuranceProof: proof() }),
        { kind: 'INVOICE_TOTAL_MISMATCH', replayed: false });
      assert.deepEqual(await allocate(b, invoice, '400000.01', { coInsuranceProof: proof() }), { kind: 'EXCEEDS_INVOICE_TOTAL', replayed: false });
      const second = await allocate(b, invoice, '400000.00', { coInsuranceProof: proof() });
      assert.equal(second.kind, 'ALLOCATED'); assert.equal(second.allocation.coInsurance, true);
      assert.deepEqual(await allocate(c, invoice, '0.01', { coInsuranceProof: proof() }), { kind: 'EXCEEDS_INVOICE_TOTAL', replayed: false });
      const g = await global(invoice);
      assert.equal(g!.allocated, '1000000.00'); assert.equal(g!.active, 2);
      // Blocked attempts are audited on the claim, with only the tenant's own request fingerprint.
      const audits = await rows(c, "SELECT action, payload_diff FROM tpa.audit_logs WHERE entity_type='INVOICE_CHECK' ORDER BY sequence");
      assert.deepEqual(audits.map(x => x.action).sort(), ['INVOICE_DUPLICATE_BLOCKED', 'INVOICE_OVERALLOCATION_BLOCKED']);
      for (const x of audits) assert.deepEqual(Object.keys(x.payload_diff as object), ['after_hash']);
    });

    await t.test('no cross-tenant disclosure: results, rows, errors, audit and events of tenant B carry nothing of tenant A', async () => {
      const invoice = newInvoice('2000000.00'), a = randomUUID(), b = randomUUID();
      const mine = await allocate(a, invoice, '1234567.89');
      assert.equal(mine.kind, 'ALLOCATED');
      const secrets = [a, mine.allocation.allocationId, mine.allocation.claimId, '1234567.89', '765432.11'];
      const seen: unknown[] = [];
      seen.push(await allocate(b, invoice, '1.00'));
      seen.push(await allocate(b, invoice, '765432.12', { coInsuranceProof: proof() }));
      seen.push(await allocate(b, { ...invoice, totalAmount: '1.00' }, '1.00', { coInsuranceProof: proof() }));
      assert.deepEqual(seen.map(r => Object.keys(r as object).sort()), [['kind', 'replayed'], ['kind', 'replayed'], ['kind', 'replayed']]);
      for (const attempt of [service.getAllocation(b, mine.allocation.allocationId),
        service.release(b, actor, { operationKey: opKey(), allocationId: mine.allocation.allocationId, trace: trace() })]) {
        const error = await attempt.then(() => assert.fail('must not be visible'), (e: Error) => e);
        assert.ok(error instanceof inv.InvoiceAllocationNotFound);
        seen.push(error.message);
      }
      assert.deepEqual(await service.listForClaim(b, mine.allocation.claimId), []);
      for (const table of ['invoice_allocations', 'invoice_allocation_operations']) {
        const visible = await rows(b, `SELECT * FROM tpa.${table}`);
        assert.ok(visible.every(r => r.tenant_id === b)); seen.push(visible);
      }
      seen.push(await rows(b, 'SELECT * FROM tpa.audit_logs'), await rows(b, 'SELECT envelope FROM tpa.outbox_events'));
      const text = JSON.stringify(seen);
      for (const s of secrets) assert.ok(!text.includes(s), 'tenant B output never contains tenant A facts');
      assert.equal((await global(invoice))!.allocated, '1234567.89', 'failed release by B changed nothing');
    });

    await t.test('release frees capacity once; concurrent releases are idempotent; events/audits per version', async () => {
      const invoice = newInvoice('300000.00'), a = randomUUID(), b = randomUUID();
      const held = await allocate(a, invoice, '300000.00');
      assert.equal(held.kind, 'ALLOCATED');
      const id = held.allocation.allocationId;
      const releases = await Promise.all([0, 1, 2].map(() => service.release(a, actor, { operationKey: opKey(), allocationId: id, trace: trace() })));
      assert.deepEqual(releases.map(r => r.kind).sort(), ['NOT_ACTIVE', 'NOT_ACTIVE', 'RELEASED']);
      assert.equal((await global(invoice))!.allocated, '0.00');
      // Released invoice is free again: a new insurer needs no co-insurance proof now.
      const next = await allocate(b, invoice, '300000.00');
      assert.equal(next.kind, 'ALLOCATED');
      const events = await rows(a, 'SELECT envelope FROM tpa.outbox_events WHERE aggregate_id=$1 ORDER BY aggregate_version', [id]);
      assert.deepEqual(events.map(e => [(e.envelope as { aggregateVersion: number }).aggregateVersion, (e.envelope as { payload: object }).payload]),
        [[1, { changeKind: 'ALLOCATED' }], [2, { changeKind: 'RELEASED' }]]);
      for (const e of events) validateEventEnvelope(e.envelope);
      const audits = await rows(a, "SELECT action FROM tpa.audit_logs WHERE entity_type='INVOICE_ALLOCATION' AND entity_id=$1 ORDER BY sequence", [id]);
      assert.deepEqual(audits.map(x => x.action), ['INVOICE_ALLOCATED', 'INVOICE_RELEASED']);
    });

    await t.test('idempotency: concurrent same-key retries allocate once; key reuse with another request conflicts', async () => {
      const invoice = newInvoice('100000.00'), tenantId = randomUUID();
      const input = { operationKey: opKey(), claimId: randomUUID(), invoice, amount: '100000.00' };
      const results = await Promise.all(Array.from({ length: 6 }, () => service.allocate(tenantId, actor, { ...input, trace: trace() })));
      assert.ok(results.every(r => r.kind === 'ALLOCATED'));
      assert.equal(new Set(results.map(r => r.allocation.allocationId)).size, 1);
      assert.equal(results.filter(r => !r.replayed).length, 1);
      await assert.rejects(service.allocate(tenantId, actor, { ...input, amount: '1.00', trace: trace() }), inv.InvoiceIdempotencyConflict);
      assert.equal((await global(invoice))!.active, 1);
    });

    await t.test('atomicity: outbox failure rolls back the global allocation too; retry commits once', async () => {
      const invoice = newInvoice('50000.00'), tenantId = randomUUID();
      const input = { operationKey: opKey(), claimId: randomUUID(), invoice, amount: '50000.00' };
      failOutbox = true;
      try { await assert.rejects(service.allocate(tenantId, actor, { ...input, trace: trace() }), /synthetic outbox failure/); }
      finally { failOutbox = false; }
      assert.equal(await global(invoice), undefined, 'no registry row, no ledger row survived');
      assert.equal((await rows(tenantId, 'SELECT * FROM tpa.invoice_allocation_operations')).length, 0);
      const ok = await service.allocate(tenantId, actor, { ...input, trace: trace() });
      assert.equal(ok.kind, 'ALLOCATED'); assert.equal(ok.replayed, false);
      assert.equal((await global(invoice))!.allocated, '50000.00');
    });

    await t.test('bypass attempts by tpa_app fail: forged tenant rows, orphan global allocations, direct status/amount edits, delete/truncate', async () => {
      const tenantId = randomUUID(), invoice = newInvoice('10000.00');
      const hash = inv.invoiceIdentityHash(invoice);
      // Tenant row without the global check -> commit-time pairing rejects it.
      await assert.rejects(rows(tenantId, `INSERT INTO tpa.invoice_allocations (tenant_id,id,claim_id,invoice_registry_id,invoice_hash,invoice_total,
          allocated_amount,co_insurance,status) VALUES (tpa.current_tenant_id(),$1,$2,$3,$4,10000.00,10000.00,false,'ACTIVE')`,
      [randomUUID(), randomUUID(), randomUUID(), hash]), code('23514'));
      // Global allocation without the paired tenant row -> rejected at commit; nothing persists.
      await assert.rejects(rows(tenantId, 'SELECT * FROM tpa.invoice_allocate($1,10000.00,$2,10000.00,false)', [hash, randomUUID()]), code('23514'));
      assert.equal(await global(invoice), undefined);
      // Tenant row disagreeing with the global ledger (amount) -> rejected.
      await assert.rejects(database.withTenantTransaction(tenantId, async tx => {
        const id = randomUUID();
        const { rows: [g] } = await tx.query('SELECT * FROM tpa.invoice_allocate($1,10000.00,$2,1.00,false)', [hash, id]);
        await tx.query(`INSERT INTO tpa.invoice_allocations (tenant_id,id,claim_id,invoice_registry_id,invoice_hash,invoice_total,allocated_amount,
          co_insurance,status) VALUES (tpa.current_tenant_id(),$1,$2,$3,$4,10000.00,10000.00,false,'ACTIVE')`, [id, randomUUID(), g.result_registry_id, hash]);
      }), code('23514'));
      const real = await allocate(tenantId, invoice, '10000.00');
      assert.equal(real.kind, 'ALLOCATED');
      // Releasing only the tenant row (no global release) -> rejected; amount edits have no grant.
      await assert.rejects(rows(tenantId, "UPDATE tpa.invoice_allocations SET status='RELEASED', version=version+1"), code('23514'));
      await assert.rejects(rows(tenantId, 'UPDATE tpa.invoice_allocations SET allocated_amount=1.00'), code('42501'));
      await assert.rejects(rows(tenantId, "UPDATE tpa.invoice_allocation_operations SET result='{}'::jsonb"), code('42501'));
      for (const table of ['invoice_allocations', 'invoice_allocation_operations']) {
        await assert.rejects(rows(tenantId, `DELETE FROM tpa.${table}`), code('42501'));
        await assert.rejects(rows(tenantId, `TRUNCATE tpa.${table}`), code('42501'));
      }
      for (const table of ['invoice_registry', 'invoice_registry_allocations', 'invoice_allocations', 'invoice_allocation_operations']) {
        await assert.rejects(su.query(`TRUNCATE tpa.${table} CASCADE`), code('42501'));
      }
      await assert.rejects(su.query('UPDATE tpa.invoice_registry SET total_amount = total_amount + 1, version = version + 1 WHERE invoice_hash=$1', [hash]), code('42501'));
      await assert.rejects(su.query('UPDATE tpa.invoice_registry SET allocated_amount = total_amount + 1, version = version + 1 WHERE invoice_hash=$1', [hash]), code('23514'));
      assert.equal((await global(invoice))!.allocated, '10000.00');
    });
  } finally {
    await db?.close(); await Promise.allSettled(clients.map(c => c.end()));
    if (started) docker('rm', '-f', '-v', name);
  }
});
