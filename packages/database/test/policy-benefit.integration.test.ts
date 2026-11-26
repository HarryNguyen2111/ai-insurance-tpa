import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/migrate.ts';
import { createTenantDatabase, type TenantDatabase } from '../src/tenant.ts';

const root = fileURLToPath(new URL('../../../',import.meta.url));
const image = 'pgvector/pgvector:0.8.7-pg16-trixie@sha256:c28c0b700f3f1b5eec14082b31ad6e7c8a566d14386323609c615315e7c0ffc8';
const code = (expected: string) => (e: unknown) => e instanceof Error && 'code' in e && e.code === expected;
function docker(...args: string[]) {
  try { return execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:150000}).trim(); }
  catch { throw new Error(`Synthetic Docker ${args[0]} failed (output suppressed)`); }
}

test('BEN-01 PG16: immutable effective-dated versions, exact references, review and atomic pinning', async t => {
  const name = `tpa-ben01-${randomBytes(6).toString('hex')}`, password = randomBytes(24).toString('hex');
  let started = false; const clients: pg.Client[] = []; let db: TenantDatabase | undefined;
  try {
    docker('run','-d','--name',name,'--label',`ao.session=${process.env.AO_SESSION_ID ?? name}`,
      '--memory','384m','--cpus','1','--tmpfs','/var/lib/postgresql/data:rw,size=512m','-p','127.0.0.1::5432',
      '-e',`POSTGRES_PASSWORD=${password}`,'-e','POSTGRES_DB=tpa',image); started = true;
    const port = docker('port',name,'5432/tcp').split(':').at(-1)!;
    const url = (user: string) => `postgresql://${user}:${password}@127.0.0.1:${port}/tpa`;
    const deadline = Date.now()+40000;
    let admin: pg.Client | undefined;
    while (!admin) {
      const c = new pg.Client({connectionString:url('postgres'),connectionTimeoutMillis:2000});
      try { await c.connect(); admin=c; clients.push(c); }
      catch { await c.end().catch(() => {}); if (Date.now() > deadline) throw new Error('Synthetic PG16 readiness timed out'); await delay(250); }
    }
    assert.match((await admin.query('SHOW server_version')).rows[0].server_version,/^16\./);
    await admin.query(await readFile(`${root}infra/migrations/bootstrap.sql`,'utf8'));
    for (const role of ['tpa_app','tpa_migrator']) {
      const { rows:[command] } = await admin.query("SELECT format('ALTER ROLE %I PASSWORD %L',$1::text,$2::text) AS sql",[role,password]);
      await admin.query(command.sql);
    }
    await migrateDatabase(url('tpa_migrator'));
    db = createTenantDatabase({connectionString:url('tpa_app'),max:8}); const database = db;
    // Dynamic file URL runs the actual core module without adding a dependency or
    // weakening package rootDir. Core module is separately typechecked/Jest tested.
    const moduleUrl = new URL('../../../apps/core-api/src/policy-benefit/policy-benefit.ts',import.meta.url).href;
    const domain = await import(moduleUrl);
    const fixtureText = await readFile(new URL('./fixtures/policy-benefit.json',import.meta.url),'utf8');
    const approved = new Set<string>();
    const repository = new domain.PolicyBenefitRepository(database,async (request: {contentHash:string}) => approved.has(request.contentHash));
    const authorize = (value: unknown) => approved.add(domain.configurationHash(value));
    const setup = async (tenantId = randomUUID()) => {
      const f = JSON.parse(fixtureText); f.tenantId=tenantId;
      authorize(f.policy); const policyRef=await repository.createPolicy(tenantId,f.actorId,f.policy);
      f.rule.policyVersion=policyRef; authorize(f.rule); const ruleRef=await repository.createRule(tenantId,f.actorId,f.rule);
      f.coverage.policyVersion=policyRef; f.coverage.ruleVersion=ruleRef; authorize(f.coverage);
      const coverageRef=await repository.createCoverage(tenantId,f.actorId,f.coverage);
      return { f,policyRef,ruleRef,coverageRef };
    };
    const rows = (tenant: string,sql: string,values: unknown[] = []) => database.withTenantTransaction(tenant,async tx => (await tx.query(sql,values)).rows);
    t.diagnostic(`Actual PostgreSQL ${(await admin.query('SHOW server_version')).rows[0].server_version}; tpa_app via withTenantTransaction SET LOCAL`);

    await t.test('approved immutable snapshots retain NUMERIC strings; pin races commit one usage/audit',async () => {
      const {f,policyRef}=await setup();
      const [stored]=await rows(f.tenantId,'SELECT annual_limit,per_visit_limit,copay_insurer_pct FROM tpa.benefit_rule_versions');
      assert.equal(stored.annual_limit,'10000000.00'); assert.equal(stored.copay_insurer_pct,'80.00');
      const results=await Promise.all([1,2].map(() => repository.resolveAndPin(f.tenantId,f.actorId,f.claimId,f.request)));
      assert.ok(results.every(r => r.kind==='CONFIGURED'));
      assert.equal(results[0].snapshot.policyRef.hash,policyRef.hash);
      assert.equal((await rows(f.tenantId,'SELECT * FROM tpa.policy_version_usages')).length,1);
      assert.equal((await rows(f.tenantId,'SELECT * FROM tpa.audit_logs')).length,4);
      assert.deepEqual(await repository.resolveAndPin(f.tenantId,f.actorId,f.claimId,{...f.request,visitDate:'2026-06-16'}),
        {kind:'REVIEW',reasons:['ALREADY_PINNED_DIFFERENT_SNAPSHOT']});
      // Correction is a new version; it never edits the used version.
      const future=structuredClone(f.policy); future.id=randomUUID(); future.version=2;
      future.effectiveFrom='2027-01-01';future.effectiveTo='2027-12-31';future.clauses[0].clauseId=randomUUID();authorize(future);
      await repository.createPolicy(f.tenantId,f.actorId,future);
      assert.equal((await repository.resolve(f.tenantId,f.request)).snapshot.policyRef.hash,policyRef.hash);
      for (const table of ['policy_versions','contract_clauses','endorsements','benefit_rule_versions','member_coverages','policy_version_usages']) {
        await assert.rejects(rows(f.tenantId,`DELETE FROM tpa.${table}`),code('42501'));
        await assert.rejects(rows(f.tenantId,`UPDATE tpa.${table} SET tenant_id=tenant_id`),code('42501'));
        await assert.rejects(rows(f.tenantId,`TRUNCATE tpa.${table}`),code('42501'));
        // Even owner privileges cannot bypass append-only triggers.
        await assert.rejects(admin!.query(`TRUNCATE tpa.${table} CASCADE`),code('42501'));
      }
      await assert.rejects(rows(f.tenantId,`INSERT INTO tpa.contract_clauses(tenant_id,id,policy_version_id,source_version,contract_clause_cited,explanation_vi)
        VALUES(tpa.current_tenant_id(),$1,$2,$3::jsonb,'synthetic','giả lập')`,[randomUUID(),f.policy.id,JSON.stringify(f.policy.sourceDocument)]),code('42501'));
    });
    await t.test('source approval and exact hash/version consistency fail closed; audit failure rolls back config',async () => {
      const {f}=await setup();
      const bad=structuredClone(f.coverage);bad.id=randomUUID();bad.memberId=randomUUID();bad.ruleVersion.hash='b'.repeat(64);authorize(bad);
      await assert.rejects(repository.createCoverage(f.tenantId,f.actorId,bad),domain.PolicyConfigurationError);
      const denied=structuredClone(f.policy);denied.id=randomUUID();denied.version=2;
      await assert.rejects(repository.createPolicy(f.tenantId,f.actorId,denied),domain.PolicyApprovalRequired);
      const next=structuredClone(f.coverage);next.id=randomUUID();next.memberId=randomUUID();authorize(next);
      const broken=new domain.PolicyBenefitRepository({
        withTenantTransaction: <T>(tenant: string,work: (tx: {query(sql:string,values?:unknown[]):Promise<{rows:Record<string,unknown>[]}>}) => Promise<T>) =>
          database.withTenantTransaction(tenant,tx => work({query:(sql,values) => sql.includes('append_audit') ? Promise.reject(new Error('Synthetic audit failure')) : tx.query(sql,values)})),
      },async () => true);
      await assert.rejects(broken.createCoverage(f.tenantId,f.actorId,next),/Synthetic audit failure/);
      assert.equal((await rows(f.tenantId,'SELECT * FROM tpa.member_coverages')).length,1);
      assert.equal((await rows(f.tenantId,'SELECT * FROM tpa.audit_logs')).length,3);
    });
    await t.test('overlapping coverages, rules or policies route review rather than latest wins',async () => {
      for (const kind of ['COVERAGE','RULE','POLICY']) {
        const {f}=await setup();
        const next=structuredClone(kind==='COVERAGE'?f.coverage:kind==='RULE'?f.rule:f.policy);
        next.id=randomUUID();next.version=2;
        if (kind==='POLICY') next.clauses[0].clauseId=randomUUID();
        authorize(next);
        if (kind==='COVERAGE') await repository.createCoverage(f.tenantId,f.actorId,next);
        else if (kind==='RULE') await repository.createRule(f.tenantId,f.actorId,next);
        else await repository.createPolicy(f.tenantId,f.actorId,next);
        assert.deepEqual(await repository.resolveAndPin(f.tenantId,f.actorId,f.claimId,f.request),{kind:'REVIEW',reasons:['AMBIGUOUS_EFFECTIVE_VERSIONS']});
        assert.equal((await rows(f.tenantId,'SELECT * FROM tpa.policy_version_usages')).length,0);
      }
    });
    await t.test('all original edge term omissions route review with no usage or inferred rejection',async () => {
      for (const term of domain.EDGE_TERMS as string[]) {
        const f=JSON.parse(fixtureText);f.tenantId=randomUUID();
        authorize(f.policy);f.rule.policyVersion=await repository.createPolicy(f.tenantId,f.actorId,f.policy);
        delete f.rule.edgeTerms[term];authorize(f.rule);f.coverage.ruleVersion=await repository.createRule(f.tenantId,f.actorId,f.rule);
        f.coverage.policyVersion=f.rule.policyVersion;authorize(f.coverage);await repository.createCoverage(f.tenantId,f.actorId,f.coverage);
        assert.deepEqual(await repository.resolveAndPin(f.tenantId,f.actorId,f.claimId,f.request),{kind:'REVIEW',reasons:[`MISSING_TERM_${term}`]});
        assert.equal((await rows(f.tenantId,'SELECT * FROM tpa.policy_version_usages')).length,0);
      }
    });
    await t.test('RLS, cross-tenant/plan/clause references and invalid effective intervals are rejected',async () => {
      const {f}=await setup(), other=randomUUID();
      assert.equal((await rows(other,'SELECT * FROM tpa.policy_versions')).length,0);
      assert.deepEqual(await repository.resolve(other,f.request),{kind:'REVIEW',reasons:['NO_APPROVED_CONFIGURATION']});
      const outside=structuredClone(f.coverage);outside.id=randomUUID();outside.memberId=randomUUID();outside.effectiveFrom='2025-12-31';authorize(outside);
      await assert.rejects(repository.createCoverage(f.tenantId,f.actorId,outside),code('23514'));
      const wrongPlan=structuredClone(f.coverage);wrongPlan.id=randomUUID();wrongPlan.planId=randomUUID();authorize(wrongPlan);
      await assert.rejects(repository.createCoverage(f.tenantId,f.actorId,wrongPlan),code('23503'));
      await assert.rejects(rows(other,`INSERT INTO tpa.member_coverages(tenant_id,id,member_id,plan_id,policy_version_id,rule_version_id,version_no,
        effective_from,effective_to,premium_paid,content_hash,approval_reference)
        VALUES(tpa.current_tenant_id(),$1,$2,$3,$4,$5,1,'2026-01-01','2026-12-31',true,$6,$7)`,
      [randomUUID(),f.coverage.memberId,f.coverage.planId,f.policy.id,f.rule.id,'a'.repeat(64),randomUUID()]),code('23503'));
      const invalid=structuredClone(f.rule);invalid.id=randomUUID();invalid.version=2;invalid.clauseId=randomUUID();authorize(invalid);
      await assert.rejects(repository.createRule(f.tenantId,f.actorId,invalid),domain.PolicyConfigurationError);
    });
  } finally {
    await db?.close();await Promise.allSettled(clients.map(c => c.end()));
    if (started) docker('rm','-f','-v',name);
  }
});
