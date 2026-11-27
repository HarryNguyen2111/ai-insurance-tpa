// CLM-02 (#37) PG16 integration: real migrations, non-privileged tpa_app role, FORCE RLS, AUTH-01 identity store,
// DOC-01 document gates, synthetic OIDC issuer. Synthetic tenants/principals/claims only. Scenario: fixtures/claims.scenario.mjs.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '@tpa/database/migrate';
import { runClaimsScenario } from './fixtures/claims.scenario.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const image = 'pgvector/pgvector:0.8.7-pg16-trixie@sha256:c28c0b700f3f1b5eec14082b31ad6e7c8a566d14386323609c615315e7c0ffc8';
function docker(...args) {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 150000 }).trim(); }
  catch { throw new Error(`Synthetic Docker ${args[0]} failed (output suppressed)`); }
}

test('CLM-02 PG16: claim submit/list/detail/supplement + expected-version transitions (PT01/PT17/PT22 scoped)', async t => {
  const name = `tpa-clm02-${randomBytes(6).toString('hex')}`, password = randomBytes(24).toString('hex');
  let started = false, admin;
  try {
    docker('run', '-d', '--name', name, '--label', `ao.session=${process.env.AO_SESSION_ID ?? name}`,
      '--memory', '384m', '--cpus', '1', '--tmpfs', '/var/lib/postgresql/data:rw,size=512m', '-p', '127.0.0.1::5432',
      '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=tpa', image); started = true;
    const port = docker('port', name, '5432/tcp').split(':').at(-1);
    const url = user => `postgresql://${user}:${password}@127.0.0.1:${port}/tpa`;
    const deadline = Date.now() + 40000;
    while (!admin) {
      const c = new pg.Client({ connectionString: url('postgres'), connectionTimeoutMillis: 2000 });
      try { await c.connect(); admin = c; }
      catch { await c.end().catch(() => {}); if (Date.now() > deadline) throw new Error('Synthetic PG16 readiness timed out'); await delay(250); }
    }
    assert.match((await admin.query('SHOW server_version')).rows[0].server_version, /^16\./);
    await admin.query(await readFile(`${root}infra/migrations/bootstrap.sql`, 'utf8'));
    for (const role of ['tpa_app', 'tpa_migrator']) {
      const { rows: [command] } = await admin.query("SELECT format('ALTER ROLE %I PASSWORD %L',$1::text,$2::text) AS sql", [role, password]);
      await admin.query(command.sql);
    }
    await migrateDatabase(url('tpa_migrator'));
    await runClaimsScenario(t, { url, admin });
  } finally {
    await admin?.end().catch(() => {});
    if (started) docker('rm', '-f', '-v', name);
  }
});
