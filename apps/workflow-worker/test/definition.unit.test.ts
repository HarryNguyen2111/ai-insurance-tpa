// VWF-03 (#80): the interpreter bundles under Temporal's deterministic sandbox rules and its
// activity contract rejects malformed pins before any database access (no PII echo).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { bundleWorkflowCode } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/activity';
import { WORKFLOWS_PATH } from '../src/worker.ts';
import { createDefinitionActivities } from '../src/activities/definition.ts';

test('workflow bundle contains the claim and definition interpreters and no Node/IO modules', async () => {
  const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH, logger: { info() {}, warn() {}, error() {}, debug() {}, trace() {}, log() {} } as never });
  assert.match(code, /definitionExecutionWorkflow/);
  assert.match(code, /claimWorkflow/);
  assert.doesNotMatch(code, /definition-validator|shared-contracts|node:crypto|\bpg\b\/lib/);
});

test('activities reject malformed pins/steps as non-retryable without touching the database or echoing values', async () => {
  const MARKER = 'PII-079123456789';
  let touched = false;
  const activities = createDefinitionActivities({ withTenantTransaction: async () => { touched = true; throw new Error('unexpected'); }, close: async () => {} });
  const ref = { tenantId: randomUUID(), claimId: randomUUID(), executionId: randomUUID(), definitionId: randomUUID(), versionNo: 1, contentHash: 'a'.repeat(64) };
  for (const request of [
    { ref: { ...ref, contentHash: MARKER }, stepNo: 1, fromNodeId: null, event: { kind: 'START' }, state: null },
    { ref, stepNo: 0, fromNodeId: null, event: { kind: 'START' }, state: null },
    { ref: { ...ref, extra: MARKER }, stepNo: 1, fromNodeId: null, event: { kind: 'START' }, state: null },
  ]) {
    await assert.rejects(activities.advanceDefinitionExecution(request as never),
      (e: unknown) => e instanceof ApplicationFailure && e.nonRetryable && !String(e.message).includes(MARKER));
  }
  await assert.rejects(activities.runDefinitionAiActivity({ ref: { ...ref, versionNo: 0 }, nodeId: 'ai_extract', activityKind: 'X' }),
    (e: unknown) => e instanceof ApplicationFailure && e.nonRetryable);
  assert.equal(touched, false);
});
