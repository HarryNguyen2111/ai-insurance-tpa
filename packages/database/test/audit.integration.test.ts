import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/migrate.ts';

import { createTenantDatabase, type TenantDatabase } from '../src/tenant.ts';
import { appendAudit, verifyAuditChain, type AuditInput, type AuditRecord } from '../src/audit.ts';
// Same verified PG16/pgvector pin as #3; no Compose stack or shared DB needed.
const image = 'pgvector/pgvector:0.8.7-pg16-trixie@sha256:c28c0b700f3f1b5eec14082b31ad6e7c8a566d14386323609c615315e7c0ffc8';
const migrations = fileURLToPath(new URL('../../../infra/migrations/', import.meta.url));
function docker(...args: string[]): string {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 150_000 }).trim(); }
  catch { throw new Error(`Synthetic Docker ${args[0]} failed (arguments/output suppressed)`); }
}

async function denied(client: pg.Client, sql: string): Promise<void> {
  await assert.rejects(client.query(sql), (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === '42501');
}

test('PT02/PT17 audit: real PG first append, rollback, immutable and tenant boundaries', async (t) => {
  const name = `tpa-db18-${randomBytes(6).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const scratch = await mkdtemp(join(tmpdir(), 'tpa-db18-'));
  const clients: pg.Client[] = [];
  let started = false;
  let db: TenantDatabase | undefined;
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
    await migrateDatabase(url('tpa_migrator'));
    db = createTenantDatabase({ connectionString: url('tpa_app'), max: 8 });
    const database = db;
    await migrator.query(await readFile(fileURLToPath(new URL('./fixtures/tenant.sql', import.meta.url)), 'utf8'));
    const tenant = randomUUID(), other = randomUUID(), entity = randomUUID();
    const input: AuditInput = { entityType: 'SYNTHETIC', entityId: entity, actorType: 'SYSTEM', actorId: randomUUID(), action: 'CHANGE', payload: { after_hash: 'a'.repeat(64) } };
    const run = (fn: Parameters<TenantDatabase['withTenantTransaction']>[1]) => database.withTenantTransaction(tenant, fn);
    const read = () => database.withTenantTransaction(tenant, async tx => (await tx.query<AuditRecord>(
      `SELECT tenant_id,entity_type,entity_id,actor_type,actor_id,action,payload_diff,sequence::text,version,occurred_at,prev_hash,curr_hash FROM tpa.audit_logs WHERE entity_id=$1 ORDER BY sequence`, [entity])).rows);
    await t.test('SQL canonical bytes match fixed Unicode and escaping vector', async () => {
      const value = { z: 'Việt\n"', a: { b: '720000.00' } };
      const result = await admin.query('SELECT tpa.audit_canonical($1::jsonb) AS canonical', [JSON.stringify(value)]);
      assert.equal(result.rows[0].canonical, '{"a":{"b":"720000.00"},"z":"Việt\\n\\\""}');
    });
    await t.test('first insert contends on an uncommitted head and creates exactly one chain', async () => {
      let release!: () => void, appended!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { appended = resolve; });
      const first = run(async tx => { await appendAudit(tx, input); appended(); await gate; });
      await Promise.race([ready, first.then(() => { throw new Error('First append ended before lock gate'); })]);
      let complete = false;
      const second = run(async tx => { await appendAudit(tx, input); complete = true; });
      try {
        const deadline = Date.now() + 5000;
        let waiting = false;
        while (Date.now() < deadline) {
          waiting = (await admin.query("SELECT EXISTS(SELECT FROM pg_stat_activity WHERE usename='tpa_app' AND wait_event_type='Lock') AS waiting")).rows[0].waiting;
          if (waiting) break;
          await delay(20);
        }
        assert.equal(waiting, true, 'second real backend must wait for first head');
        assert.equal(complete, false);
      } finally { release(); await Promise.all([first, second]); }
      await Promise.all(Array.from({ length: 12 }, () => run(tx => appendAudit(tx, input))));
      const rows = await read();
      assert.equal(rows.length, 14);
      assert.equal(verifyAuditChain(rows, { sequence: '14', curr_hash: rows.at(-1)!.curr_hash }), true);
      await run(async tx => {
        const head = (await tx.query('SELECT sequence::text,curr_hash FROM tpa.audit_chain_heads WHERE entity_id=$1',[entity])).rows[0];
        assert.equal(head.sequence, '14'); assert.equal(head.curr_hash, rows.at(-1)!.curr_hash);
      });
    });
    await t.test('real mutation and audit rollback together, including a new head, without sequence gaps', async () => {
      for (const target of [entity, randomUUID()]) {
        await assert.rejects(run(async tx => {
          await tx.query('INSERT INTO tpa.isolation_parent VALUES($1,$2,$3)',[tenant,target,'synthetic']);
          await appendAudit(tx, { ...input, entityId: target });
          throw new Error('synthetic rollback');
        }), /synthetic rollback/);
        await run(async tx => {
          assert.equal((await tx.query('SELECT * FROM tpa.isolation_parent WHERE id=$1',[target])).rowCount,0);
          if (target !== entity) assert.equal((await tx.query('SELECT * FROM tpa.audit_chain_heads WHERE entity_id=$1',[target])).rowCount,0);
        });
      }
      await run(async tx => {
        await tx.query('INSERT INTO tpa.isolation_parent VALUES($1,$2,$3)',[tenant,entity,'committed']);
        const record = await appendAudit(tx,input); assert.equal(record.sequence,'15');
      });
      const rows = await read();
      assert.equal(verifyAuditChain(rows,{sequence:'15',curr_hash:rows.at(-1)!.curr_hash}),true);
      await assert.rejects(run(async tx => {
        await tx.query("UPDATE tpa.isolation_parent SET label='must_rollback' WHERE id=$1",[entity]);
        await tx.query('SELECT * FROM tpa.append_audit($1,$2,$3,$4,$5,$6)',[input.entityType,entity,input.actorType,input.actorId,input.action,{phone:'SYNTHETIC_PII_MARKER'}]);
      }));
      await run(async tx => assert.equal((await tx.query('SELECT label FROM tpa.isolation_parent WHERE id=$1',[entity])).rows[0].label,'committed'));
    });
    await t.test('missing tenant, cross-tenant access, direct tampering, privileges and trigger enforcement', async () => {
      await denied(app,'SELECT * FROM tpa.audit_logs');
      await assert.rejects(app.query('SELECT * FROM tpa.append_audit($1,$2,$3,$4,$5,$6)',[input.entityType,entity,input.actorType,input.actorId,input.action,{}]));
      await database.withTenantTransaction(other,async tx => {
        for (const table of ['audit_logs','audit_chain_heads','audit_anchors']) {
          assert.equal((await tx.query(`SELECT * FROM tpa.${table} WHERE tenant_id=$1`,[tenant])).rowCount,0);
        }
        const record=await appendAudit(tx,input); assert.equal(record.sequence,'1'); assert.equal(record.tenant_id,other);
      });
      for (const sql of ["UPDATE tpa.audit_logs SET action='TAMPER'",'DELETE FROM tpa.audit_logs',
        'TRUNCATE tpa.audit_logs',"UPDATE tpa.audit_chain_heads SET sequence=99",'DELETE FROM tpa.audit_chain_heads',
        'INSERT INTO tpa.audit_logs DEFAULT VALUES','INSERT INTO tpa.audit_anchors DEFAULT VALUES',
        'ALTER TABLE tpa.audit_logs DISABLE TRIGGER ALL','SET ROLE tpa_migrator']) {
        await assert.rejects(run(tx=>tx.query(sql)));
      }
      await admin.query('BEGIN');
      try {
        await admin.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]);
        await admin.query('SET LOCAL ROLE tpa_migrator');
        await denied(admin,"UPDATE tpa.audit_logs SET action='TAMPER'");
      } finally { await admin.query('ROLLBACK'); }
      await admin.query('BEGIN');
      try {
        await admin.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]);
        await admin.query('SET LOCAL ROLE tpa_migrator');
        await denied(admin,'DELETE FROM tpa.audit_logs');
      } finally { await admin.query('ROLLBACK'); }
      await admin.query('BEGIN');
      try {
        await admin.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]);
        await admin.query('SET LOCAL ROLE tpa_migrator');
        await assert.rejects(admin.query(`INSERT INTO tpa.audit_anchors(tenant_id,entity_type,entity_id,sequence,curr_hash)
          VALUES($1,$2,$3,1,$4)`,[tenant,input.entityType,entity,'0'.repeat(64)]),
          (error: unknown) => (error as {code:string}).code === '23503');
      } finally { await admin.query('ROLLBACK'); }
      await admin.query('BEGIN');
      try {
        await admin.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]);
        await admin.query('SET LOCAL ROLE tpa_migrator');
        await admin.query(`INSERT INTO tpa.audit_anchors(tenant_id,entity_type,entity_id,sequence,curr_hash)
          SELECT tenant_id,entity_type,entity_id,sequence,curr_hash FROM tpa.audit_logs WHERE sequence=1`);
        await denied(admin,'DELETE FROM tpa.audit_anchors');
      } finally { await admin.query('ROLLBACK'); }
      const rows=await read(), head={sequence:'15',curr_hash:rows.at(-1)!.curr_hash};
      assert.equal(verifyAuditChain(rows.slice(1),head),false);
      assert.equal(verifyAuditChain(rows.slice(0,-1),head),false);
      assert.equal(verifyAuditChain(rows.map((r,i)=>i===1?{...r,action:'TAMPER'}:r),head),false);
    });
  } finally {
    await db?.close();
    await Promise.allSettled(clients.map(client => client.end()));
    if (started) docker('rm', '--force', name);
    await rm(scratch, { recursive: true, force: true });
  }
});
