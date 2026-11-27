// VWF-03 (#80) interpreter scenario on real PostgreSQL (tpa_app, FORCE RLS) and a real Temporal server.
// Synthetic tenants/claims only. The caller supplies `deliver`, which moves committed BOUND outbox
// events to the start bridge (CI: relay -> Kafka -> inbox consumer with an injected crash).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import type pg from 'pg';
import { ApplicationFailure, Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { createTenantDatabase } from '@tpa/database/tenant';
import { connectTemporalEngine } from '@tpa/workflow/engine';
import { definitionWorkflowId, type DefinitionCommand, type DefinitionExecutionRef } from '@tpa/workflow/definition';
import { contentHash, pinnedRefs } from '@tpa/workflow/definition-validator';
import { createClaimWorkers, WORKFLOWS_PATH } from '../../../workflow-worker/src/worker.ts';
import { createTransitionActivities } from '../../../workflow-worker/src/activities/transitions.ts';
import { createDefinitionActivities, type DefinitionActivities } from '../../../workflow-worker/src/activities/definition.ts';
import { bindClaimExecution } from '../../../core-api/src/workflow-definition/workflow-execution-binding.ts';
import { workflowRuntime } from '../../../core-api/src/workflow-definition/workflow-runtime.ts';

export interface DefinitionScenarioEnv {
  url(user: 'tpa_app' | 'tpa_migrator' | 'postgres'): string;
  /** Superuser for trusted provisioning only (bypasses RLS; triggers still apply). */
  admin: pg.Client;
  temporalAddress: string;
  deliver(): Promise<void>;
}
const root = new URL('../../../../', import.meta.url);
const MARKER = 'VWF03-PII-079123456789';
export async function until<T>(what: string, probe: () => Promise<T | undefined | false>, ms = 90_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    try { const v = await probe(); if (v !== undefined && v !== false) return v; } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(200);
  }
}

export async function runDefinitionExecutionScenario(t: TestContext, env: DefinitionScenarioEnv): Promise<void> {
  const example = JSON.parse(await readFile(new URL('docs/ai-specs/examples/visual-workflow-intake-review.example.json', root), 'utf8'));
  const runtime = await workflowRuntime();
  const db = createTenantDatabase({ connectionString: env.url('tpa_app'), max: 8 });
  const connection = await NativeConnection.connect({ address: env.temporalAddress });
  const clientConnection = await Connection.connect({ address: env.temporalAddress });
  const client = new Client({ connection: clientConnection });
  const engine = await connectTemporalEngine({ address: env.temporalAddress });
  let workers: Awaited<ReturnType<typeof createClaimWorkers>> | undefined;
  let running: Promise<void> | undefined;
  const stopWorkers = async () => { workers?.shutdown(); await running; workers = undefined; running = undefined; };
  try {
    const T1 = randomUUID(), T2 = randomUUID(), defId = randomUUID(), designer = randomUUID(), publisher = randomUUID();
    const v1 = { ...example }, v2 = { ...example, title: `${example.title} v2` };
    const [h1, h2] = [contentHash(v1), contentHash(v2)];
    const { admin } = env;
    // Trusted provisioning of a PUBLISHED v1 (the API path is covered by core-api's PG test).
    await admin.query('INSERT INTO tpa.workflow_definitions(tenant_id,id,workflow_key) VALUES($1,$2,$3)', [T1, defId, example.workflowKey]);
    const draft = (no: number, content: unknown, hash: string) => admin.query(`INSERT INTO tpa.workflow_definition_versions(tenant_id,definition_id,version_no,status,revision,content,content_hash,
      action_catalog_version,benefit_types,created_by,editor_ids) VALUES($1,$2,$3,'DRAFT',1,$4,$5,1,$6,$7,ARRAY[$7::uuid])`,
    [T1, defId, no, JSON.stringify(content), hash, example.scope.benefitTypes, designer]);
    const publish = (no: number) => admin.query(`UPDATE tpa.workflow_definition_versions SET status='PUBLISHED', published_by=$3, published_at=now()
      WHERE tenant_id=$1 AND definition_id=$2 AND version_no=$4`, [T1, defId, publisher, no]);
    await draft(1, v1, h1); await publish(1);
    for (const b of example.scope.benefitTypes) await admin.query('INSERT INTO tpa.workflow_scope_bindings VALUES($1,$2,$3,1)', [T1, b, defId]);
    const kinds: Record<string, string> = { modelRef: 'MODEL', promptRef: 'PROMPT', policyRef: 'POLICY', formRef: 'FORM' };
    for (const r of pinnedRefs(example)) await admin.query(`INSERT INTO tpa.workflow_reference_versions VALUES($1,$2,$3,$4,$5,'PUBLISHED')`, [T1, kinds[r.kind], r.key, r.version, r.hash]);
    await admin.query('CREATE TABLE IF NOT EXISTS public.vwf03_private_source (marker text)');
    await admin.query('INSERT INTO public.vwf03_private_source VALUES ($1)', [MARKER]);

    // Activities with injected faults: one crash AFTER the step-2 commit (Temporal retries; the ledger dedups).
    let aiCalls = 0, crashed = false;
    const real = createDefinitionActivities(db, { aiBindings: { DOCUMENT_EXTRACTION: async () => { aiCalls++; } } });
    const activities: DefinitionActivities = {
      ...real,
      async advanceDefinitionExecution(request) {
        const result = await real.advanceDefinitionExecution(request);
        if (request.stepNo === 2 && !crashed) { crashed = true; throw new Error('Synthetic crash after step commit'); }
        return result;
      },
    };
    const startWorkers = async () => { workers = await createClaimWorkers({ connection, activities: { ...createTransitionActivities(db), ...activities } }); running = workers.run(); };
    await startWorkers();

    const q = async <R extends pg.QueryResultRow>(sql: string, values: unknown[] = []) => db.withTenantTransaction(T1, async tx => (await tx.query<R>(sql, values)).rows);
    const execution = async (id: string) => (await q<{ status: string; current_node_id: string; step_no: number; version_no: number; content_hash: string; outcome: string | null }>(
      'SELECT status, current_node_id, step_no, version_no, content_hash, outcome FROM tpa.workflow_executions WHERE id=$1', [id]))[0];
    const at = (id: string, node: string, step: number) => until(`${node}@${step}`, async () => { const e = await execution(id); return e.current_node_id === node && e.step_no === step; });
    const cmd = (kind: DefinitionCommand['kind'], nodeId: string, actionId: string | null = null): DefinitionCommand => ({ commandId: `cmd-${randomUUID()}`, kind, nodeId, actionId });
    const actor = { type: 'SERVICE' as const, id: randomUUID() };

    const claimA = randomUUID();
    const boundA = await bindClaimExecution(db, runtime, T1, { claimId: claimA, benefitType: 'OUTPATIENT', actor });
    assert.equal(boundA.status, 'BOUND');
    const refA: DefinitionExecutionRef = { tenantId: T1, claimId: claimA, executionId: (boundA as { executionId: string }).executionId, definitionId: defId, versionNo: 1, contentHash: h1 };
    const handleA = client.workflow.getHandle(definitionWorkflowId(refA));

    await t.test('crash between DB commit and Temporal start: nothing runs until delivery; duplicate delivery starts one run', async () => {
      await assert.rejects(handleA.describe(), 'committed binding alone does not start Temporal');
      await env.deliver();
      const first = await until('started', async () => (await handleA.describe()).runId);
      await env.deliver();
      const again = await engine.engine.startDefinitionExecution(refA);
      assert.deepEqual([again.status, again.runId], ['accepted', null], 'duplicate start is a no-op');
      assert.equal((await handleA.describe()).runId, first);
      await at(refA.executionId, 'confirm_extraction', 2);
      assert.equal(crashed, true); assert.equal(aiCalls, 1);
      assert.equal((await q('SELECT step_no FROM tpa.workflow_execution_steps WHERE execution_id=$1 ORDER BY 1', [refA.executionId])).length, 2, 'retry after commit applied once');
    });

    await t.test('VW08: a later published version never changes the bound execution; restart while waiting for a human', async () => {
      await admin.query(`UPDATE tpa.workflow_definition_versions SET status='RETIRED', retired_at=now() WHERE tenant_id=$1 AND definition_id=$2 AND version_no=1`, [T1, defId]);
      await draft(2, v2, h2); await publish(2);
      await admin.query('UPDATE tpa.workflow_scope_bindings SET version_no=2 WHERE tenant_id=$1', [T1]);
      await stopWorkers(); await startWorkers();
      const supplement = cmd('TASK_ACTION', 'confirm_extraction', 'REQUEST_SUPPLEMENT');
      for (const c of [supplement, supplement, cmd('TASK_ACTION', 'confirm_extraction', 'CLAIM_TASK'), cmd('TASK_ACTION', 'confirm_extraction', 'REQUEST_SUPPLEMENT')]) {
        await engine.engine.submitDefinitionCommand(refA, c);
      }
      await at(refA.executionId, 'wait_supplement', 3);
      await delay(1500);
      const e = await execution(refA.executionId);
      assert.deepEqual([e.step_no, e.version_no, e.content_hash], [3, 1, h1], 'duplicate/late/invalid resumes produced one transition on the pinned v1');
    });

    await t.test('revoked AI reference is denied at action time (FAILED -> human) without calling the AI binding', async () => {
      const model = pinnedRefs(example).find(r => r.kind === 'modelRef')!;
      await admin.query(`UPDATE tpa.workflow_reference_versions SET status='REVOKED' WHERE tenant_id=$1 AND ref_kind='MODEL' AND ref_key=$2`, [T1, model.key]);
      await engine.engine.submitDefinitionCommand(refA, cmd('SUPPLEMENT_RECEIVED', 'wait_supplement'));
      await at(refA.executionId, 'confirm_extraction', 5);
      assert.equal(aiCalls, 1, 'binding not invoked after revocation');
      await engine.engine.submitDefinitionCommand(refA, cmd('TASK_ACTION', 'confirm_extraction', 'CONFIRM_EXTRACTION'));
      assert.deepEqual(await handleA.result(), { outcome: 'REVIEW_COMPLETED', nodeId: 'end_completed' });
      const e = await execution(refA.executionId);
      assert.deepEqual([e.status, e.outcome, e.step_no, e.version_no], ['COMPLETED', 'REVIEW_COMPLETED', 6, 1]);
      assert.equal((await engine.engine.submitDefinitionCommand(refA, cmd('TASK_ACTION', 'confirm_extraction', 'CONFIRM_EXTRACTION'))).status, 'closed');
      const events = await q<{ payload: Record<string, unknown> }>(`SELECT envelope->'payload' AS payload FROM tpa.outbox_events
        WHERE event_type='workflow.execution-changed' AND aggregate_id=$1 ORDER BY seq`, [refA.executionId]);
      assert.deepEqual(events.map(r => r.payload.changeKind), ['BOUND', 'COMPLETED']);
      assert.equal(events[1].payload.outcome, 'REVIEW_COMPLETED');
    });

    await t.test('replay of the full history is deterministic, has no effects and carries no content/PII', async () => {
      const history = await handleA.fetchHistory();
      const text = JSON.stringify(history, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      for (const e of history.events ?? []) {
        for (const payload of [e.workflowExecutionStartedEventAttributes?.input, e.workflowExecutionSignaledEventAttributes?.input,
          e.activityTaskScheduledEventAttributes?.input, e.activityTaskCompletedEventAttributes?.result]) {
          for (const p of payload?.payloads ?? []) {
            const data = Buffer.from(p.data ?? []).toString();
            assert.doesNotMatch(data, new RegExp(`${MARKER}|Tiếp nhận|Xác nhận|synthetic\\.vlm|"content"`));
          }
        }
      }
      assert.ok(!text.includes(MARKER));
      const steps = (await q('SELECT 1 FROM tpa.workflow_execution_steps WHERE execution_id=$1', [refA.executionId])).length;
      await Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history);
      assert.equal((await q('SELECT 1 FROM tpa.workflow_execution_steps WHERE execution_id=$1', [refA.executionId])).length, steps);
    });

    await t.test('VW09: revoking the bound version suspends at the next action; only escalation ends it (manual review)', async () => {
      const claimB = randomUUID();
      const boundB = await bindClaimExecution(db, runtime, T1, { claimId: claimB, benefitType: 'DENTAL', actor }) as { executionId: string; versionNo: number };
      assert.equal(boundB.versionNo, 2);
      const refB: DefinitionExecutionRef = { tenantId: T1, claimId: claimB, executionId: boundB.executionId, definitionId: defId, versionNo: 2, contentHash: h2 };
      await env.deliver();
      await at(refB.executionId, 'confirm_extraction', 2);
      // Claim C is bound (committed) but its BOUND event is not yet delivered when v2 is revoked.
      const claimC = randomUUID();
      const boundC = await bindClaimExecution(db, runtime, T1, { claimId: claimC, benefitType: 'DENTAL', actor }) as { executionId: string; versionNo: number };
      const refC: DefinitionExecutionRef = { tenantId: T1, claimId: claimC, executionId: boundC.executionId, definitionId: defId, versionNo: 2, contentHash: h2 };
      await admin.query(`UPDATE tpa.workflow_definition_versions SET status='REVOKED', revoked_by=$3, revoked_at=now(), revoked_reason='SECURITY'
        WHERE tenant_id=$1 AND definition_id=$2 AND version_no=2`, [T1, defId, publisher]);
      await engine.engine.submitDefinitionCommand(refB, cmd('TASK_ACTION', 'confirm_extraction', 'CONFIRM_EXTRACTION'));
      await until('suspended', async () => (await execution(refB.executionId)).status === 'SUSPENDED');
      await delay(1000);
      assert.equal((await execution(refB.executionId)).step_no, 2, 'no transition on a revoked version');
      await engine.engine.submitDefinitionCommand(refB, cmd('SUSPENDED_ESCALATION', 'confirm_extraction'));
      assert.deepEqual(await client.workflow.getHandle(definitionWorkflowId(refB)).result(), { outcome: 'ROUTED_TO_MANUAL_REVIEW', nodeId: 'confirm_extraction' });
      assert.deepEqual((await execution(refB.executionId)).outcome, 'ROUTED_TO_MANUAL_REVIEW');
      await env.deliver(); // late start of C on a revoked version: suspended at START, never runs a node
      await until('C suspended', async () => (await execution(refC.executionId)).status === 'SUSPENDED');
      assert.equal((await execution(refC.executionId)).step_no, 0);
      await engine.engine.submitDefinitionCommand(refC, cmd('SUSPENDED_ESCALATION', 'start'));
      assert.deepEqual(await client.workflow.getHandle(definitionWorkflowId(refC)).result(), { outcome: 'ROUTED_TO_MANUAL_REVIEW', nodeId: 'start' });
    });

    await t.test('cross-tenant pins are invisible to activities (RLS) and fail non-retryably', async () => {
      await assert.rejects(real.advanceDefinitionExecution({ ref: { ...refA, tenantId: T2 }, stepNo: 7, fromNodeId: null, event: { kind: 'START' }, state: null }),
        (e: unknown) => e instanceof ApplicationFailure && (e as ApplicationFailure).nonRetryable && (e as ApplicationFailure).type === 'DefinitionPinMismatch');
    });
  } finally {
    await stopWorkers().catch(() => {});
    await Promise.allSettled([db.close(), engine.close(), clientConnection.close()]);
    await connection.close().catch(() => {});
  }
}
