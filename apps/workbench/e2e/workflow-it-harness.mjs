// VWF-02 (#79) integrated-test harness. Test-only; never imported by application code.
// Runs the REAL compiled core-api identity (#21) + workflow-definition (#80) + health (liveness) controllers over
// real PostgreSQL (PG16 via Docker in CI; real migrations; non-privileged tpa_app role; FORCE RLS)
// with core-api's test-only synthetic OIDC issuer. Synthetic tenants/principals only.
// Production AppModule deliberately has no identity provider (503), so the composition below mirrors
// core-api's own PG scenario (#80) instead of changing backend code.
//
// Env: HARNESS_API_PORT, HARNESS_CONTROL_PORT, HARNESS_CONTAINER (docker name), AO_SESSION_ID,
//      HARNESS_EXTERNAL_ADMIN_URL + HARNESS_EXTERNAL_APP_URL (local feedback on a pre-migrated DB; not PG16 evidence).
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const coreApi = join(root, 'apps/core-api');
const coreRequire = createRequire(join(coreApi, 'package.json'));
const importCore = specifier => import(pathToFileURL(coreRequire.resolve(specifier)).href);
const IMAGE = 'pgvector/pgvector:0.8.7-pg16-trixie@sha256:c28c0b700f3f1b5eec14082b31ad6e7c8a566d14386323609c615315e7c0ffc8';
const container = process.env.HARNESS_CONTAINER ?? `tpa-vwf02-${randomBytes(6).toString('hex')}`;
const external = process.env.HARNESS_EXTERNAL_ADMIN_URL && process.env.HARNESS_EXTERNAL_APP_URL;

function docker(...args) {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 }).trim(); }
  catch { throw new Error(`Synthetic Docker ${args[0]} failed (output suppressed)`); }
}
const cleanup = [];
let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return; stopping = true;
  for (const fn of cleanup.reverse()) { try { await fn(); } catch { /* best effort */ } }
  process.exit(code);
}
process.on('SIGTERM', () => void shutdown(0));
process.on('SIGINT', () => void shutdown(0));

async function main() {
  const pg = coreRequire('pg');
  let adminUrl, appUrl, pgVersion;
  if (external) {
    adminUrl = process.env.HARNESS_EXTERNAL_ADMIN_URL; appUrl = process.env.HARNESS_EXTERNAL_APP_URL;
  } else {
    const password = randomBytes(24).toString('hex');
    docker('run', '-d', '--name', container, '--label', `ao.session=${process.env.AO_SESSION_ID ?? container}`, '--memory', '384m', '--cpus', '1',
      '--tmpfs', '/var/lib/postgresql/data:rw,size=512m', '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=tpa', IMAGE);
    cleanup.push(async () => docker('rm', '-f', '-v', container));
    const port = docker('port', container, '5432/tcp').split(':').at(-1);
    const url = user => `postgresql://${user}:${password}@127.0.0.1:${port}/tpa`;
    adminUrl = url('postgres'); appUrl = url('tpa_app');
    const deadline = Date.now() + 60000;
    for (;;) {
      const c = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 2000 });
      try { await c.connect(); await c.end(); break; }
      catch { await c.end().catch(() => {}); if (Date.now() > deadline) throw new Error('Synthetic PG16 readiness timed out'); await delay(250); }
    }
    const boot = new pg.Client({ connectionString: adminUrl });
    await boot.connect();
    await boot.query(await readFile(join(root, 'infra/migrations/bootstrap.sql'), 'utf8'));
    for (const role of ['tpa_app', 'tpa_migrator']) {
      const { rows: [command] } = await boot.query("SELECT format('ALTER ROLE %I PASSWORD %L',$1::text,$2::text) AS sql", [role, password]);
      await boot.query(command.sql);
    }
    await boot.end();
    const { migrateDatabase } = await importCore('@tpa/database/migrate');
    await migrateDatabase(url('tpa_migrator'));
  }
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  cleanup.push(() => admin.end());
  pgVersion = (await admin.query('SHOW server_version')).rows[0].server_version;

  // Test-only issuer from core-api (Node 24 type stripping), same as the #80 PG scenario.
  const { syntheticIssuer } = await import(pathToFileURL(join(coreApi, 'test/fixtures/synthetic-issuer.ts')).href);
  const issuer = await syntheticIssuer();
  cleanup.push(() => issuer.close());
  const { OidcVerifier, identityHash } = coreRequire('./dist/identity-tenant/oidc-verifier.js');
  const { IdentityStore } = coreRequire('./dist/identity-tenant/identity-store.js');
  const { IdentityTenantModule } = coreRequire('./dist/identity-tenant/identity.module.js');
  const { WorkflowDefinitionModule } = coreRequire('./dist/workflow-definition/workflow-definition.module.js');
  const { workflowRuntime } = coreRequire('./dist/workflow-definition/workflow-runtime.js');
  // The real compiled liveness controller, exactly as AppModule registers it (process liveness only).
  const { HealthController } = coreRequire('./dist/health.controller.js');
  coreRequire('reflect-metadata');
  const { Module } = coreRequire('@nestjs/common');
  const { NestFactory } = coreRequire('@nestjs/core');

  // Synthetic tenants and principals. Workflow roles are granted through #21 memberships.
  const T1 = randomUUID(), T2 = randomUUID(), people = {};
  const provision = async (name, tenant, workflowRoles) => {
    const principal = randomUUID(), membership = randomUUID();
    await admin.query('INSERT INTO tpa.identity_principals(id,identity_hash) VALUES($1,$2)', [principal, identityHash(issuer.profile.issuer, `vwf02-${name}`)]);
    await admin.query(`INSERT INTO tpa.identity_memberships(tenant_id,id,principal_id,roles,workflow_roles) VALUES($1,$2,$3,ARRAY['CLAIM_REVIEWER'],$4)`, [tenant, membership, principal, workflowRoles]);
    await admin.query('INSERT INTO tpa.identity_membership_directory(membership_id,tenant_id,principal_id) VALUES($1,$2,$3)', [membership, tenant, principal]);
    people[name] = { membershipId: membership, principalId: principal, tenant };
  };
  await provision('designer', T1, ['WORKFLOW_DESIGNER']);
  await provision('designer2', T1, ['WORKFLOW_DESIGNER']);
  await provision('editorPublisher', T1, ['WORKFLOW_DESIGNER', 'WORKFLOW_PUBLISHER']);
  await provision('publisher', T1, ['WORKFLOW_PUBLISHER']);
  await provision('observer', T1, ['WORKFLOW_OBSERVER']);
  await provision('designerB', T2, ['WORKFLOW_DESIGNER', 'WORKFLOW_OBSERVER']);
  // Trusted provisioner publishes the model/prompt/policy/form pins the synthetic example uses (T1 only).
  const runtime = await workflowRuntime();
  const example = JSON.parse(await readFile(join(root, 'docs/ai-specs/examples/visual-workflow-intake-review.example.json'), 'utf8'));
  const kinds = { modelRef: 'MODEL', promptRef: 'PROMPT', policyRef: 'POLICY', formRef: 'FORM' };
  for (const ref of runtime.pinnedRefs(example)) {
    await admin.query(`INSERT INTO tpa.workflow_reference_versions VALUES($1,$2,$3,$4,$5,'PUBLISHED')`, [T1, kinds[ref.kind], ref.key, ref.version, ref.hash]);
  }

  const verifier = new OidcVerifier(issuer.profile);
  const store = await IdentityStore.connect(appUrl, Buffer.alloc(32, 7));
  cleanup.push(() => store.close());
  const identity = IdentityTenantModule.register({ verifier, store });
  class HarnessModule {}
  Module({ imports: [identity, WorkflowDefinitionModule.register({ identity })], controllers: [HealthController] })(HarnessModule);
  const app = await NestFactory.create(HarnessModule, { logger: false });
  await app.listen(Number(process.env.HARNESS_API_PORT ?? 0), '127.0.0.1');
  cleanup.push(() => app.close());
  const apiUrl = await app.getUrl();

  // Loopback-only control channel for the spec: fresh tokens (MFA window 300 s) and DB evidence (superuser read).
  const control = createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const [, kind, arg] = new URL(req.url, 'http://x').pathname.split('/');
      if (kind === 'token' && people[arg]) return send(200, { token: await issuer.token(`vwf02-${arg}`), membershipId: people[arg].membershipId });
      if (kind === 'state' && /^[0-9a-f-]{36}$/.test(arg ?? '')) {
        const q = async (sql, values) => (await admin.query(sql, values)).rows;
        return send(200, {
          versions: await q(`SELECT version_no, status, revision, content_hash, cardinality(editor_ids) AS editors, published_by IS NOT NULL AS has_publisher
            FROM tpa.workflow_definition_versions WHERE definition_id=$1 ORDER BY version_no`, [arg]),
          audit: await q(`SELECT action, count(*)::int AS n FROM tpa.audit_logs WHERE entity_type='WORKFLOW_DEFINITION' AND entity_id=$1::uuid GROUP BY action ORDER BY action`, [arg]),
          outbox: await q(`SELECT event_type, count(*)::int AS n FROM tpa.outbox_events WHERE aggregate_id=$1::uuid GROUP BY event_type`, [arg]),
          bindings: await q('SELECT benefit_type, version_no FROM tpa.workflow_scope_bindings WHERE definition_id=$1 ORDER BY 1', [arg]),
          tenantOfDefinition: (await q('SELECT tenant_id = $2 AS t1 FROM tpa.workflow_definitions WHERE id=$1', [arg, T1]))[0]?.t1 ?? null,
          otherTenantRows: (await q('SELECT count(*)::int AS n FROM tpa.workflow_definitions WHERE tenant_id=$1', [T2]))[0].n,
        });
      }
      send(404, {});
    } catch { send(500, { error: 'STATE_QUERY_FAILED' }); }
  });
  await new Promise(r => control.listen(Number(process.env.HARNESS_CONTROL_PORT ?? 0), '127.0.0.1', r));
  cleanup.push(() => new Promise(r => { control.closeAllConnections(); control.close(() => r()); }));
  process.stdout.write(`HARNESS_READY ${JSON.stringify({ apiUrl: apiUrl.replace('[::1]', '127.0.0.1'), controlUrl: `http://127.0.0.1:${control.address().port}`, pgVersion, external: !!external })}\n`);
}

main().catch(error => { process.stderr.write(`HARNESS_FAILED ${error?.message ?? 'unknown'}\n`); void shutdown(1); });
