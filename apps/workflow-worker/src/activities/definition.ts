import { createHash } from 'node:crypto';
import { ApplicationFailure } from '@temporalio/activity';
import { appendAudit } from '@tpa/database/audit';
import { appendOutboxEvent } from '@tpa/database/outbox';
import type { TenantDatabase, TenantTransaction } from '@tpa/database/tenant';
import { WorkflowContractError } from '@tpa/workflow/contracts';
import {
  actionCatalog, assertDefinitionExecutionRef, stepDefinition,
  type DefinitionContent, type DefinitionExecutionRef, type EndOutcome, type StepEvent, type StepState, type WaitPoint,
} from '@tpa/workflow/definition';
import { contentHash } from '@tpa/workflow/definition-validator';
import { WORKFLOW_SYSTEM_ACTOR_ID } from './transitions.ts';

/** Activity input: exact pin + step index + codes. Never content, labels or PII. */
export interface AdvanceRequest {
  ref: DefinitionExecutionRef;
  /** 1-based step index owned by the workflow; the semantic idempotency key of this effect. */
  stepNo: number;
  /** Null only for the START event. */
  fromNodeId: string | null;
  event: StepEvent | { kind: 'ESCALATE' };
  state: StepState | null;
}
export type AdvanceResult =
  | { status: 'ADVANCED'; wait: WaitPoint; state: StepState }
  /** The pinned node does not accept this event: no effect, keep waiting. */
  | { status: 'REJECTED' }
  /** Version revoked or a variable is unavailable: safe stop, only escalation proceeds (VWF-OD-02). */
  | { status: 'SUSPENDED' };
export interface AiActivityRequest { ref: DefinitionExecutionRef; nodeId: string; activityKind: string }
/** Constrained binding: an AI node may call only a server-registered activity for its kind. */
export type AiActivityBinding = (request: AiActivityRequest) => Promise<void>;

export interface DefinitionActivities {
  advanceDefinitionExecution(request: AdvanceRequest): Promise<AdvanceResult>;
  runDefinitionAiActivity(request: AiActivityRequest): Promise<void>;
}

const sha = (...parts: (string | number)[]) => createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
const nonRetryable = (type: string) => ApplicationFailure.nonRetryable('Definition execution contract violated', type);
const REF_KIND = { modelRef: 'MODEL', promptRef: 'PROMPT', policyRef: 'POLICY', formRef: 'FORM' } as const;

interface ExecutionRow {
  claim_id: string; definition_id: string; version_no: number; content_hash: string; action_catalog_version: number;
  benefit_type: StepState['benefitType']; status: 'RUNNING' | 'SUSPENDED' | 'COMPLETED'; current_node_id: string | null; step_no: number;
}

/** Load and verify the exact pin. A mismatch is a non-retryable contract violation, never a silent re-pin. */
async function loadPinned(tx: TenantTransaction, ref: DefinitionExecutionRef, lock: boolean) {
  const { rows: [execution] } = await tx.query<ExecutionRow>(
    `SELECT claim_id::text, definition_id::text, version_no, content_hash, action_catalog_version, benefit_type, status, current_node_id, step_no
       FROM tpa.workflow_executions WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [ref.executionId]);
  if (!execution || execution.claim_id !== ref.claimId || execution.definition_id !== ref.definitionId
    || execution.version_no !== ref.versionNo || execution.content_hash !== ref.contentHash) throw nonRetryable('DefinitionPinMismatch');
  const { rows: [version] } = await tx.query<{ content: DefinitionContent; status: string }>(
    'SELECT content, status FROM tpa.workflow_definition_versions WHERE definition_id = $1 AND version_no = $2',
    [ref.definitionId, ref.versionNo]);
  // Recompute: restart/replay must run exactly the bytes that were published and pinned.
  if (!version || contentHash(version.content) !== ref.contentHash || version.content.actionCatalogVersion !== execution.action_catalog_version
    || !actionCatalog(execution.action_catalog_version)) throw nonRetryable('DefinitionPinMismatch');
  return { execution, content: version.content, versionStatus: version.status };
}

export function createDefinitionActivities(db: TenantDatabase, options: { aiBindings?: Readonly<Record<string, AiActivityBinding>> } = {}): DefinitionActivities {
  const aiBindings = options.aiBindings ?? {};
  return {
    async advanceDefinitionExecution(request) {
      try { assertDefinitionExecutionRef(request?.ref); } catch { throw nonRetryable('WorkflowContractError'); }
      if (!Number.isSafeInteger(request.stepNo) || request.stepNo < 1) throw nonRetryable('WorkflowContractError');
      const { ref, stepNo } = request;
      return db.withTenantTransaction(ref.tenantId, async tx => {
        const { execution, content, versionStatus } = await loadPinned(tx, ref, true);
        const start = content.nodes.find(n => n.type === 'START')!;
        const state: StepState = request.state ?? { loopCounts: {}, supplementRound: 0, benefitType: execution.benefit_type };
        const escalate = request.event.kind === 'ESCALATE';
        const compute = (): AdvanceResult => {
          if (escalate) {
            return { status: 'ADVANCED', state, wait: { kind: 'END', nodeId: execution.current_node_id ?? start.nodeId, outcome: 'ROUTED_TO_MANUAL_REVIEW' } };
          }
          const from = request.event.kind === 'START' ? start.nodeId : request.fromNodeId;
          if (!from) throw nonRetryable('WorkflowContractError');
          try {
            const r = stepDefinition(content, from, request.event as StepEvent, state);
            return r.accepted ? { status: 'ADVANCED', wait: r.wait, state: r.state } : { status: 'REJECTED' };
          } catch (error) { if (error instanceof WorkflowContractError) throw nonRetryable('WorkflowContractError'); throw error; }
        };
        // Replayed effect (Activity retry / crash after COMMIT): same pure result, no second write.
        const { rows: done } = await tx.query('SELECT 1 FROM tpa.workflow_execution_steps WHERE execution_id = $1 AND step_no = $2', [ref.executionId, stepNo]);
        if (done.length) return compute();
        if (stepNo !== execution.step_no + 1) throw nonRetryable('DefinitionStepOutOfOrder');
        if (execution.status === 'COMPLETED') return { status: 'REJECTED' };
        const suspended = execution.status === 'SUSPENDED' || versionStatus === 'REVOKED';
        if (escalate !== suspended) {
          if (!suspended) return { status: 'REJECTED' }; // escalation of a suspended execution only
          if (execution.status !== 'SUSPENDED') await suspend(tx, ref, execution, stepNo, 'REVOKED_VERSION');
          return { status: 'SUSPENDED' };
        }
        const result = compute();
        if (result.status !== 'ADVANCED') return result;
        const { wait } = result;
        const eventKind = escalate ? 'ESCALATION' : request.event.kind;
        await tx.query(`INSERT INTO tpa.workflow_execution_steps (tenant_id, execution_id, step_no, node_id, event_kind)
          VALUES (tpa.current_tenant_id(), $1, $2, $3, $4)`, [ref.executionId, stepNo, wait.nodeId, eventKind]);
        const nextStatus = wait.kind === 'END' ? 'COMPLETED' : wait.kind === 'UNRESOLVED' ? 'SUSPENDED' : 'RUNNING';
        const outcome: EndOutcome | null = wait.kind === 'END' ? wait.outcome : null;
        const { rows: [{ aggregate_version: aggregateVersion }] } = await tx.query<{ aggregate_version: number }>(
          `UPDATE tpa.workflow_executions SET step_no = $2, current_node_id = $3, status = $4, outcome = $5, aggregate_version = aggregate_version + 1
           WHERE id = $1 RETURNING aggregate_version`, [ref.executionId, stepNo, wait.nodeId, nextStatus, outcome]);
        await appendAudit(tx, { entityType: 'WORKFLOW_EXECUTION', entityId: ref.executionId, actorType: 'SYSTEM', actorId: WORKFLOW_SYSTEM_ACTOR_ID,
          action: nextStatus === 'COMPLETED' ? 'WORKFLOW_EXECUTION_COMPLETED' : nextStatus === 'SUSPENDED' ? 'WORKFLOW_EXECUTION_SUSPENDED' : 'WORKFLOW_EXECUTION_ADVANCED',
          payload: { after_hash: sha(ref.executionId, stepNo, wait.nodeId, eventKind, nextStatus, outcome ?? '') } });
        if (nextStatus !== 'RUNNING') {
          await appendOutboxEvent(tx, { eventType: 'workflow.execution-changed', aggregateId: ref.executionId, aggregateVersion,
            correlationId: ref.executionId, causationId: ref.executionId,
            payload: { changeKind: nextStatus, claimId: ref.claimId, definitionId: ref.definitionId, versionNo: ref.versionNo,
              contentHash: ref.contentHash, ...(outcome ? { outcome } : {}) } });
        }
        return nextStatus === 'SUSPENDED' ? { status: 'SUSPENDED' } : result;
      });
    },

    async runDefinitionAiActivity(request) {
      try { assertDefinitionExecutionRef(request?.ref); } catch { throw nonRetryable('WorkflowContractError'); }
      const { ref } = request;
      // Re-check the pinned node and its model/prompt/AI-policy refs at action time: a revoked
      // reference denies the call (FAILED -> human), it never falls back to another version.
      await db.withTenantTransaction(ref.tenantId, async tx => {
        const { content } = await loadPinned(tx, ref, false);
        const node = content.nodes.find(n => n.nodeId === request.nodeId);
        if (!node || node.type !== 'AI_ACTIVITY' || node.activityKind !== request.activityKind) throw nonRetryable('DefinitionPinMismatch');
        for (const [field, kind] of Object.entries(REF_KIND)) {
          const pin = node[field as keyof typeof REF_KIND];
          if (!pin) continue;
          const { rows } = await tx.query(`SELECT 1 FROM tpa.workflow_reference_versions
            WHERE ref_kind = $1 AND ref_key = $2 AND version = $3 AND content_hash = $4 AND status = 'PUBLISHED'`, [kind, pin.key, pin.version, pin.hash]);
          if (!rows.length) throw nonRetryable('AiReferenceRevoked');
        }
      });
      const binding = Object.prototype.hasOwnProperty.call(aiBindings, request.activityKind) ? aiBindings[request.activityKind] : undefined;
      // Phase 1: no AI service actor is bound yet (#83); fail closed to the human FAILED route.
      if (!binding) throw nonRetryable('AiActivityUnbound');
      await binding(request);
    },
  };
}

async function suspend(tx: TenantTransaction, ref: DefinitionExecutionRef, execution: ExecutionRow, stepNo: number, reason: string): Promise<void> {
  const { rows: [{ aggregate_version: aggregateVersion }] } = await tx.query<{ aggregate_version: number }>(
    `UPDATE tpa.workflow_executions SET status = 'SUSPENDED', aggregate_version = aggregate_version + 1 WHERE id = $1 RETURNING aggregate_version`, [ref.executionId]);
  await appendAudit(tx, { entityType: 'WORKFLOW_EXECUTION', entityId: ref.executionId, actorType: 'SYSTEM', actorId: WORKFLOW_SYSTEM_ACTOR_ID,
    action: 'WORKFLOW_EXECUTION_SUSPENDED', payload: { after_hash: sha(ref.executionId, stepNo, execution.current_node_id ?? '', reason) } });
  await appendOutboxEvent(tx, { eventType: 'workflow.execution-changed', aggregateId: ref.executionId, aggregateVersion,
    correlationId: ref.executionId, causationId: ref.executionId,
    payload: { changeKind: 'SUSPENDED', claimId: ref.claimId, definitionId: ref.definitionId, versionNo: ref.versionNo, contentHash: ref.contentHash } });
}
