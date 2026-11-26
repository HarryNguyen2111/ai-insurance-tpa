import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Connection } from '@temporalio/client';
import { root, waitFor, type Harness } from './docker-harness.ts';

/** CI Linux only, isolated Temporal persistence databases/role on test PG16.
 * Uses the exact Compose server pin; no SDK test-server download or fake engine.
 */
export async function startTemporal(h: Harness) {
  const compose = await readFile(`${root}infra/compose/compose.yaml`, 'utf8');
  const image = /image: (temporalio\/auto-setup:\S+@sha256:[a-f0-9]{64})/.exec(compose)?.[1];
  if (!image) throw new Error('Temporal image pin missing');
  const name = `wf01-temporal-${randomBytes(6).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const { rows: [role] } = await h.pgAdmin.query("SELECT format('CREATE ROLE temporal LOGIN CREATEDB PASSWORD %L', $1::text) AS sql", [password]);
  await h.pgAdmin.query(role.sql);
  // Temporal has its own role/databases and no access to business tables.
  const port = new URL(h.url('postgres')).port;
  const cleanup = () => { execFileSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore', timeout: 30_000 }); };
  try {
    execFileSync('docker', ['run', '-d', '--name', name, '--label', `ao.session=${process.env.AO_SESSION_ID ?? name}`,
      '--network', 'host', '--memory', '768m', '--cpus', '1',
      '-e', 'DB=postgres12', '-e', `DB_PORT=${port}`, '-e', 'POSTGRES_SEEDS=127.0.0.1',
      '-e', 'POSTGRES_USER=temporal', '-e', `POSTGRES_PWD=${password}`, '-e', 'BIND_ON_IP=127.0.0.1',
      '-e', 'TEMPORAL_ADDRESS=127.0.0.1:7233', '-e', 'SKIP_ADD_CUSTOM_SEARCH_ATTRIBUTES=true', image],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 });
    await waitFor('Compose Temporal namespace', async () => {
      const c = await Connection.connect({ address: '127.0.0.1:7233', connectTimeout: 2000 });
      try { await c.workflowService.describeNamespace({ namespace: 'default' }); return true; } finally { await c.close(); }
    }, 150_000);
    return { address: '127.0.0.1:7233', version: image.split('@')[0], cleanup };
  } catch { try { cleanup(); } catch { /* creation may have failed */ } throw new Error('Synthetic Temporal harness failed (output suppressed)'); }
}
