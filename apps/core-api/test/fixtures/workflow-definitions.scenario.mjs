// VWF-03 (#80) acceptance scenario on real PostgreSQL with the unprivileged tpa_app role, FORCE RLS,
// real migrations and the AUTH-01 identity store. Synthetic tenants/principals/claims only.
// Called by test/workflow-definitions.pg.test.mjs (Docker PG16 in CI).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { IdentityStore } from '../../src/identity-tenant/identity-store.ts';
import { OidcVerifier, identityHash } from '../../src/identity-tenant/oidc-verifier.ts';
import { WorkflowDefinitionStore } from '../../src/workflow-definition/workflow-definition.store.ts';
import { workflowRuntime } from '../../src/workflow-definition/workflow-runtime.ts';
import { bindClaimExecution } from '../../src/workflow-definition/workflow-execution-binding.ts';
import { syntheticIssuer } from './synthetic-issuer.ts';

const root = new URL('../../../../', import.meta.url);
const err = (status, code) => e => e?.status === status && e?.code === code;
const deniedOrStale = e => (e?.status === 403 && e.code === 'FORBIDDEN') || (e?.status === 409 && e.code === 'STALE_VERSION');
const sqlCode = code => e => e?.code === code;
const MARKER = 'VWF03-PII-079123456789';

export async function runWorkflowDefinitionScenario(t, { url, admin }) {
  const runtime = await workflowRuntime();
  const example = JSON.parse(await readFile(new URL('docs/ai-specs/examples/visual-workflow-intake-review.example.json', root), 'utf8'));
  const issuer = await syntheticIssuer();
  const identity = await IdentityStore.connect(url('tpa_app'), Buffer.alloc(32, 7));
  const store = new WorkflowDefinitionStore(identity, runtime);
  const db = runtime.createTenantDatabase({ connectionString: url('tpa_app'), max: 8 });
  const verifier = new OidcVerifier(issuer.profile);
  try {
    const T1 = randomUUID(), T2 = randomUUID();
    const people = {};
    const provision = async (name, tenant, workflowRoles) => {
      const principal = randomUUID(), membership = randomUUID();
      await admin.query('INSERT INTO tpa.identity_principals(id,identity_hash) VALUES($1,$2)', [principal, identityHash(issuer.profile.issuer, `${name}-sub`)]);
      await admin.query(`INSERT INTO tpa.identity_memberships(tenant_id,id,principal_id,roles,workflow_roles) VALUES($1,$2,$3,ARRAY['CLAIM_REVIEWER'],$4)`, [tenant, membership, principal, workflowRoles]);
      await admin.query('INSERT INTO tpa.identity_membership_directory(membership_id,tenant_id,principal_id) VALUES($1,$2,$3)', [membership, tenant, principal]);
      const login = async () => verifier.verifyAuthorization(`Bearer ${await issuer.token(`${name}-sub`)}`);
      const id = await login();
      people[name] = { principal, membership, tenant, call: async (key = randomUUID()) => {
        const fresh = await login();
        return { identity: fresh, membershipContext: (await identity.select(fresh, membership, randomUUID())).view.contextToken, idempotencyKey: key };
      }, id };
    };
    await provision('designer', T1, ['WORKFLOW_DESIGNER']);
    await provision('publisher', T1, ['WORKFLOW_PUBLISHER']);
    await provision('publisher2', T1, ['WORKFLOW_PUBLISHER']);
    await provision('editorPublisher', T1, ['WORKFLOW_DESIGNER', 'WORKFLOW_PUBLISHER']);
    await provision('observer', T1, ['WORKFLOW_OBSERVER']);
    await provision('designerB', T2, ['WORKFLOW_DESIGNER', 'WORKFLOW_OBSERVER']);
    // Trusted provisioner registers the PUBLISHED model/prompt/policy/form versions the example pins (tenant T1 only).
    const kinds = { modelRef: 'MODEL', promptRef: 'PROMPT', policyRef: 'POLICY', formRef: 'FORM' };
    for (const ref of runtime.pinnedRefs(example)) {
      await admin.query(`INSERT INTO tpa.workflow_reference_versions VALUES($1,$2,$3,$4,$5,'PUBLISHED')`, [T1, kinds[ref.kind], ref.key, ref.version, ref.hash]);
    }
    const rows = (tenant, sql, values = []) => db.withTenantTransaction(tenant, async tx => (await tx.query(sql, values)).rows);
    const count = async (tenant, sql, values) => Number((await rows(tenant, sql, values))[0].n);
    const hash = runtime.contentHash(example);

    let defId;
    await t.test('VW07/VW06: draft create, idempotent replay, revision conflict, role/maker-checker denials', async () => {
      const key = randomUUID(), call = await people.designer.call(key);
      const created = await store.create(call, { content: example });
      assert.equal(created.status, 201); assert.equal(created.replayed, false);
      defId = created.body.definitionId;
      assert.deepEqual([created.body.versionNo, created.body.status, created.body.revision, created.body.contentHash], [1, 'DRAFT', 1, hash]);
      assert.equal(created.body.publishableByCurrentActor, false);
      assert.doesNotMatch(JSON.stringify(created.body), /tenantId|created_by|editor/);
      const replay = await store.create(call, { content: example });
      assert.equal(replay.replayed, true); assert.equal(replay.body.definitionId, defId);
      await assert.rejects(store.create(call, { content: { ...example, title: 'Khác' } }), err(409, 'IDEMPOTENCY_CONFLICT'));
      await assert.rejects(store.create(await people.designer.call(), { content: example }), err(409, 'STALE_VERSION')); // one open DRAFT per key
      await assert.rejects(store.create(await people.designer.call(), { content: example, tenantId: T2 }), err(422, 'VALIDATION_FAILED'));
      await assert.rejects(store.create(await people.observer.call(), { content: example }), err(403, 'FORBIDDEN'));
      const edited = await store.update(await people.designer.call(), defId, 1, { expectedRevision: 1, content: { ...example, title: 'Tiếp nhận v1' } });
      assert.equal(edited.body.revision, 2);
      await assert.rejects(store.update(await people.designer.call(), defId, 1, { expectedRevision: 1, content: example }), err(409, 'STALE_VERSION'));
      await assert.rejects(store.update(await people.designer.call(), defId, 1, { expectedRevision: 2, content: { ...example, workflowKey: 'other_key' } }), err(422, 'VALIDATION_FAILED'));
      const back = await store.update(await people.designer.call(), defId, 1, { expectedRevision: 2, content: example });
      assert.equal(back.body.contentHash, hash);
      const report = await store.validate(await people.publisher.call(), defId, 1);
      assert.deepEqual(report.body, { valid: true, revision: 3, contentHash: hash, issues: [] });
      await assert.rejects(store.publish(await people.designer.call(), defId, 1, { expectedRevision: 3, contentHash: hash }), err(403, 'FORBIDDEN'));
      await assert.rejects(store.publish(await people.publisher.call(), defId, 1, { expectedRevision: 3, contentHash: 'f'.repeat(64) }), err(409, 'STALE_VERSION'));
      assert.equal(await count(T1, `SELECT count(*) AS n FROM tpa.workflow_definition_versions WHERE status <> 'DRAFT'`), 0);
    });

    await t.test('VW10: app-role RLS hides every workflow row and audit across tenants (404, no existence leak)', async () => {
      await assert.rejects(store.get(await people.designerB.call(), defId, 1), err(404, 'NOT_FOUND'));
      await assert.rejects(store.update(await people.designerB.call(), defId, 1, { expectedRevision: 3, content: example }), err(404, 'NOT_FOUND'));
      assert.deepEqual((await store.list(await people.designerB.call(), { limit: 50 })).items, []);
      for (const [table, where] of [['workflow_definitions', ''], ['workflow_definition_versions', ''], ['workflow_reference_versions', ''],
        ['audit_logs', " WHERE entity_type LIKE 'WORKFLOW%'"]]) {
        assert.equal(await count(T2, `SELECT count(*) AS n FROM tpa.${table}${where}`), 0, table);
        assert.ok(await count(T1, `SELECT count(*) AS n FROM tpa.${table}${where}`) > 0, table);
      }
      await assert.rejects(rows(T2, `INSERT INTO tpa.workflow_definitions(tenant_id,id,workflow_key) VALUES($1,$2,'forged_key')`, [T1, randomUUID()]), sqlCode('42501'));
      // T2 has no published pins: the same content validates with REFERENCE_NOT_PUBLISHED and cannot publish.
      const own = await store.create(await people.designerB.call(), { content: example });
      const report = await store.validate(await people.designerB.call(), own.body.definitionId, 1);
      assert.equal(report.body.valid, false);
      assert.deepEqual([...new Set(report.body.issues.map(i => i.detailCode))], ['REFERENCE_NOT_PUBLISHED']);
    });

    await t.test('VW06 maker-checker: a publisher who edited the draft is denied, in the service and in the database', async () => {
      const draft = await store.create(await people.editorPublisher.call(), { content: { ...example, workflowKey: 'self_published', scope: { benefitTypes: ['INPATIENT'] } } });
      await assert.rejects(store.publish(await people.editorPublisher.call(), draft.body.definitionId, 1, { expectedRevision: 1, contentHash: draft.body.contentHash }), err(403, 'FORBIDDEN'));
      await assert.rejects(rows(T1, `UPDATE tpa.workflow_definition_versions SET status='PUBLISHED', published_by=$2, published_at=now() WHERE definition_id=$1`,
        [draft.body.definitionId, people.editorPublisher.principal]), sqlCode('23514'));
    });

    await t.test('VW01: concurrent publish of the same version -> exactly one effective transition, audit and outbox event', async () => {
      const results = await Promise.allSettled([people.publisher, people.publisher2, people.publisher].map(async p =>
        store.publish(await p.call(), defId, 1, { expectedRevision: 3, contentHash: hash })));
      const ok = results.filter(r => r.status === 'fulfilled');
      assert.equal(ok.length, 1, JSON.stringify(results.map(r => r.status === 'rejected' ? r.reason?.code : 'ok')));
      for (const r of results.filter(r => r.status === 'rejected')) assert.ok(err(409, 'STALE_VERSION')(r.reason));
      assert.equal(ok[0].value.body.status, 'PUBLISHED');
      assert.equal(await count(T1, `SELECT count(*) AS n FROM tpa.outbox_events WHERE event_type='workflow.definition-published'`), 1);
      assert.equal(await count(T1, `SELECT count(*) AS n FROM tpa.audit_logs WHERE action='WORKFLOW_DEFINITION_PUBLISHED'`), 1);
      assert.deepEqual((await rows(T1, 'SELECT benefit_type FROM tpa.workflow_scope_bindings ORDER BY 1')).map(r => r.benefit_type), ['DENTAL', 'OUTPATIENT']);
      await assert.rejects(store.update(await people.designer.call(), defId, 1, { expectedRevision: 3, content: example }), err(409, 'STALE_VERSION'));
      await assert.rejects(rows(T1, `UPDATE tpa.workflow_definition_versions SET content='{}'::jsonb WHERE definition_id=$1 AND version_no=1`, [defId]), sqlCode('42501'));
      await assert.rejects(rows(T1, 'DELETE FROM tpa.workflow_definition_versions WHERE definition_id=$1', [defId]), sqlCode('42501'));
    });

    let bound;
    await t.test('start: duplicate concurrent binds of one claim -> one pinned execution, one audit, one BOUND event; fail closed', async () => {
      const claimId = randomUUID(), actor = { type: 'SERVICE', id: randomUUID() };
      const results = await Promise.all(Array.from({ length: 5 }, () => bindClaimExecution(db, runtime, T1, { claimId, benefitType: 'OUTPATIENT', actor })));
      assert.equal(new Set(results.map(r => r.executionId)).size, 1);
      assert.equal(results.filter(r => r.status === 'BOUND').length, 1);
      bound = { ...results[0], claimId };
      assert.deepEqual([bound.definitionId, bound.versionNo, bound.contentHash], [defId, 1, hash]);
      assert.equal(await count(T1, `SELECT count(*) AS n FROM tpa.outbox_events WHERE event_type='workflow.execution-changed'`), 1);
      assert.equal(await count(T1, `SELECT count(*) AS n FROM tpa.audit_logs WHERE action='WORKFLOW_EXECUTION_BOUND'`), 1);
      const [event] = await rows(T1, `SELECT envelope FROM tpa.outbox_events WHERE event_type='workflow.execution-changed'`);
      assert.deepEqual(Object.keys(event.envelope.payload).sort(), ['changeKind', 'claimId', 'contentHash', 'definitionId', 'versionNo']);
      assert.deepEqual(await bindClaimExecution(db, runtime, T1, { claimId: randomUUID(), benefitType: 'INPATIENT', actor }), { status: 'NO_PUBLISHED_WORKFLOW' });
      await assert.rejects(bindClaimExecution(db, runtime, T1, { claimId: randomUUID(), benefitType: 'OUTPATIENT', actor,
        expectedVersion: { definitionId: defId, versionNo: 2, contentHash: hash } }), err(409, 'STALE_VERSION'));
      assert.deepEqual(await bindClaimExecution(db, runtime, T2, { claimId, benefitType: 'OUTPATIENT', actor }), { status: 'NO_PUBLISHED_WORKFLOW' });
      await assert.rejects(rows(T1, `UPDATE tpa.workflow_executions SET version_no=2, aggregate_version=aggregate_version+1 WHERE id=$1`, [bound.executionId]), sqlCode('42501'));
    });

    await t.test('crash atomicity: an outbox/audit failure after the business write rolls everything back', async () => {
      const failing = { ...runtime, appendOutboxEvent: async () => { throw new Error('Synthetic crash before commit'); } };
      const claimId = randomUUID();
      await assert.rejects(bindClaimExecution(db, failing, T1, { claimId, benefitType: 'OUTPATIENT', actor: { type: 'SYSTEM', id: randomUUID() } }), /Synthetic crash/);
      assert.equal(await count(T1, 'SELECT count(*) AS n FROM tpa.workflow_executions WHERE claim_id=$1', [claimId]), 0);
      const draft = await store.create(await people.designer.call(), { content: example });
      const failingStore = new WorkflowDefinitionStore(identity, failing);
      await assert.rejects(failingStore.publish(await people.publisher.call(), defId, 2, { expectedRevision: 1, contentHash: draft.body.contentHash }));
      assert.equal((await store.get(await people.observer.call(), defId, 2)).status, 'DRAFT');
      assert.equal((await store.get(await people.observer.call(), defId, 1)).status, 'PUBLISHED');
      assert.equal(await count(T1, `SELECT count(*) AS n FROM tpa.idempotency_records WHERE operation='publishWorkflowVersion' AND state='COMPLETED'`), 1);
    });

    await t.test('revoked publisher privilege is denied at action time; state unchanged', async () => {
      const call = await people.publisher2.call();
      await admin.query(`UPDATE tpa.identity_memberships SET workflow_roles='{}' WHERE id=$1`, [people.publisher2.membership]);
      await assert.rejects(store.publish(call, defId, 2, { expectedRevision: 1, contentHash: hash }), deniedOrStale);
      await assert.rejects(store.publish(await people.publisher2.call(), defId, 2, { expectedRevision: 1, contentHash: hash }), err(403, 'FORBIDDEN'));
      assert.equal((await store.get(await people.observer.call(), defId, 2)).status, 'DRAFT');
    });

    await t.test('VW08: publishing v2 retires v1; the bound execution keeps v1; new claims bind v2', async () => {
      const v2 = await store.publish(await people.publisher.call(), defId, 2, { expectedRevision: 1, contentHash: hash });
      assert.equal(v2.body.status, 'PUBLISHED');
      assert.equal((await store.get(await people.observer.call(), defId, 1)).status, 'RETIRED');
      const [pinned] = await rows(T1, 'SELECT version_no, content_hash, status FROM tpa.workflow_executions WHERE id=$1', [bound.executionId]);
      assert.deepEqual(pinned, { version_no: 1, content_hash: hash, status: 'RUNNING' });
      const fresh = await bindClaimExecution(db, runtime, T1, { claimId: randomUUID(), benefitType: 'DENTAL', actor: { type: 'SERVICE', id: randomUUID() } });
      assert.deepEqual([fresh.status, fresh.versionNo], ['BOUND', 2]);
      const [event] = await rows(T1, `SELECT envelope FROM tpa.outbox_events WHERE event_type='workflow.definition-published' ORDER BY seq DESC LIMIT 1`);
      assert.deepEqual(event.envelope.payload, { changeKind: 'PUBLISHED', versionNo: 2, contentHash: hash, retiredVersionNo: 1 });
      bound.v2Execution = fresh.executionId;
    });

    await t.test('VW25/AMBIGUOUS_BINDING: a second key for an already-served benefit type fails closed; concurrent keys race to one', async () => {
      const other = await store.create(await people.designer.call(), { content: { ...example, workflowKey: 'dental_flow', scope: { benefitTypes: ['DENTAL'] } } });
      const report = await store.validate(await people.designer.call(), other.body.definitionId, 1);
      assert.ok(report.body.issues.some(i => i.detailCode === 'AMBIGUOUS_BINDING'));
      await assert.rejects(store.publish(await people.publisher.call(), other.body.definitionId, 1, { expectedRevision: 1, contentHash: other.body.contentHash }), err(422, 'DOMAIN_VIOLATION'));
      const keys = ['race_a_flow', 'race_b_flow'];
      const drafts = await Promise.all(keys.map(async k => store.create(await people.designer.call(), { content: { ...example, workflowKey: k, scope: { benefitTypes: ['INPATIENT'] } } })));
      const raced = await Promise.allSettled(drafts.map(async d => store.publish(await people.publisher.call(),
        d.body.definitionId, 1, { expectedRevision: 1, contentHash: d.body.contentHash })));
      assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1);
      assert.ok(raced.filter(r => r.status === 'rejected').every(r => err(422, 'DOMAIN_VIOLATION')(r.reason)));
      assert.equal(await count(T1, `SELECT count(*) AS n FROM tpa.workflow_scope_bindings WHERE benefit_type='INPATIENT'`), 1);
    });

    await t.test('VW09: revoke suspends in-flight executions of that version only, unbinds it and never migrates', async () => {
      const revoked = await store.revoke(await people.publisher.call(), defId, 2, { contentHash: hash, reasonCode: 'DEFECT' });
      assert.deepEqual([revoked.body.status, revoked.body.revokedReasonCode], ['REVOKED', 'DEFECT']);
      const status = async id => (await rows(T1, 'SELECT status, version_no FROM tpa.workflow_executions WHERE id=$1', [id]))[0];
      assert.deepEqual(await status(bound.v2Execution), { status: 'SUSPENDED', version_no: 2 });
      assert.deepEqual(await status(bound.executionId), { status: 'RUNNING', version_no: 1 }, 'RETIRED v1 execution unaffected');
      assert.deepEqual(await bindClaimExecution(db, runtime, T1, { claimId: randomUUID(), benefitType: 'OUTPATIENT', actor: { type: 'SERVICE', id: randomUUID() } }), { status: 'NO_PUBLISHED_WORKFLOW' });
      const [event] = await rows(T1, `SELECT envelope FROM tpa.outbox_events WHERE event_type='workflow.definition-revoked'`);
      assert.deepEqual(event.envelope.payload, { changeKind: 'REVOKED', versionNo: 2, contentHash: hash, reasonCode: 'DEFECT', suspendedExecutionCount: 1 });
      await assert.rejects(store.revoke(await people.publisher.call(), defId, 2, { contentHash: hash, reasonCode: 'DEFECT' }), err(409, 'STALE_VERSION'));
    });

    await t.test('VW22: events and audit carry ids/version/hash/codes only; catalog served read-only', async () => {
      await admin.query('CREATE TABLE IF NOT EXISTS public.vwf03_private_source (marker text)');
      await admin.query('INSERT INTO public.vwf03_private_source VALUES ($1)', [MARKER]);
      const events = await rows(T1, 'SELECT envelope::text AS e FROM tpa.outbox_events');
      const audit = await rows(T1, 'SELECT payload_diff::text AS p FROM tpa.audit_logs');
      for (const text of [...events.map(r => r.e), ...audit.map(r => r.p)]) {
        assert.doesNotMatch(text, new RegExp(`${MARKER}|Tiếp nhận|label|editor|${people.designer.principal}`));
      }
      const catalog = await store.catalog(await people.observer.call(), 1);
      assert.equal(catalog.catalogVersion, 1);
      await assert.rejects(store.catalog(await people.observer.call(), 2), err(404, 'NOT_FOUND'));
    });
  } finally {
    await Promise.allSettled([db.close(), identity.close(), issuer.close()]);
  }
}
