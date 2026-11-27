import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/migrate.ts';
import { createTenantDatabase, type TenantDatabase } from '../src/tenant.ts';
import { ledgerScenarios } from './fixtures/ledger-scenarios.ts';

// PAY-01 (#44) / PT14 on actual PostgreSQL 16 through tpa_app + withTenantTransaction (SET LOCAL).
// Synthetic funds only (no PII, no real bank, no payout).
const root = fileURLToPath(new URL('../../../', import.meta.url));
const image = 'pgvector/pgvector:0.8.7-pg16-trixie@sha256:c28c0b700f3f1b5eec14082b31ad6e7c8a566d14386323609c615315e7c0ffc8';
function docker(...args: string[]) {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 150000 }).trim(); }
  catch { throw new Error(`Synthetic Docker ${args[0]} failed (output suppressed)`); }
}

test('PAY-01 PG16: balanced immutable journal, protected float balances, races and reconciliation', async t => {
  const name = `tpa-pay01-${randomBytes(6).toString('hex')}`, password = randomBytes(24).toString('hex');
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
    db = createTenantDatabase({ connectionString: url('tpa_app'), max: 12 });
    const owner = new pg.Client({ connectionString: url('tpa_migrator') }); await owner.connect(); clients.push(owner);
    t.diagnostic(`Actual PostgreSQL ${(await admin.query('SHOW server_version')).rows[0].server_version}; tpa_app via withTenantTransaction SET LOCAL`);
    await ledgerScenarios(t, { db, owner });
  } finally {
    await db?.close(); await Promise.allSettled(clients.map(c => c.end()));
    if (started) docker('rm', '-f', '-v', name);
  }
});
