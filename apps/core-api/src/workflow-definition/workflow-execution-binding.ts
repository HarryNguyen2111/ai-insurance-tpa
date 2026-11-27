import { randomUUID } from 'node:crypto';
import { UUID } from '../identity-tenant/identity-context.ts';
import { invalidRequest, stale } from './workflow-error.ts';
import type { DefinitionLike, TenantDatabaseLike, WorkflowRuntime } from './workflow-runtime.ts';

export interface ExpectedVersion { definitionId: string; versionNo: number; contentHash: string }
/**
 * Internal start request from a trusted caller (claim submission #37 / its consumer), never a
 * bearer API: `tenantId` must come from that caller's verified context, `claimId` is an existing claim.
 */
export interface BindClaimRequest {
  claimId: string;
  benefitType: 'OUTPATIENT' | 'INPATIENT' | 'DENTAL';
  /** Optional optimistic pin: a different resolvable version is 409, never silently substituted. */
  expectedVersion?: ExpectedVersion;
  actor: { type: 'SERVICE' | 'SYSTEM'; id: string };
}
export type BindClaimResult =
  | { status: 'BOUND' | 'EXISTING'; executionId: string; definitionId: string; versionNo: number; contentHash: string }
  /** Fail closed (spec 14 §3.4): no PUBLISHED workflow -> standard manual review, no empty execution. */
  | { status: 'NO_PUBLISHED_WORKFLOW' };

interface ExecutionRow { id: string; definition_id: string; version_no: number; content_hash: string }
const matches = (row: ExecutionRow, expected?: ExpectedVersion) => !expected
  || (row.definition_id === expected.definitionId && row.version_no === expected.versionNo && row.content_hash === expected.contentHash);

/**
 * Bind one claim to the exact PUBLISHED version for its benefit type and emit
 * `workflow.execution-changed BOUND` in the same tenant transaction as the pinned row and audit.
 * The Temporal start happens in the inbox bridge (event-worker), so a crash anywhere between
 * COMMIT, Kafka and Temporal is recovered by redelivery + the stable workflow id. Duplicate
 * starts for the same claim return the existing binding (one effective transition).
 */
export async function bindClaimExecution(db: TenantDatabaseLike, runtime: WorkflowRuntime, tenantId: string, request: BindClaimRequest): Promise<BindClaimResult> {
  const expected = request.expectedVersion;
  if (!request || !UUID.test(request.claimId) || !['OUTPATIENT', 'INPATIENT', 'DENTAL'].includes(request.benefitType)
    || !['SERVICE', 'SYSTEM'].includes(request.actor?.type) || !UUID.test(request.actor?.id)
    || (expected && (!UUID.test(expected.definitionId) || !Number.isSafeInteger(expected.versionNo) || expected.versionNo < 1 || !/^[0-9a-f]{64}$/.test(expected.contentHash)))) {
    throw invalidRequest();
  }
  return db.withTenantTransaction(tenantId, async tx => {
    const existing = async (): Promise<BindClaimResult | null> => {
      const { rows: [row] } = await tx.query<ExecutionRow>(
        'SELECT id::text, definition_id::text, version_no, content_hash FROM tpa.workflow_executions WHERE claim_id = $1', [request.claimId]);
      if (!row) return null;
      if (!matches(row, expected)) throw stale();
      return { status: 'EXISTING', executionId: row.id, definitionId: row.definition_id, versionNo: row.version_no, contentHash: row.content_hash };
    };
    const found = await existing();
    if (found) return found;
    const { rows: [binding] } = await tx.query<{ definition_id: string; version_no: number }>(
      'SELECT definition_id::text, version_no FROM tpa.workflow_scope_bindings WHERE benefit_type = $1', [request.benefitType]);
    // FOR SHARE orders this bind against a concurrent revoke of the same version.
    const { rows: [version] } = binding ? await tx.query<{ status: string; content: DefinitionLike; content_hash: string; action_catalog_version: number }>(
      `SELECT status, content, content_hash, action_catalog_version FROM tpa.workflow_definition_versions
       WHERE definition_id = $1 AND version_no = $2 FOR SHARE`, [binding.definition_id, binding.version_no]) : { rows: [] };
    if (!binding || !version || version.status !== 'PUBLISHED') {
      if (expected) throw stale();
      return { status: 'NO_PUBLISHED_WORKFLOW' };
    }
    const pinned = { id: '', definition_id: binding.definition_id, version_no: binding.version_no, content_hash: version.content_hash };
    if (!matches(pinned, expected) || runtime.contentHash(version.content) !== version.content_hash) throw stale();
    const executionId = randomUUID();
    const pins = runtime.pinnedRefs(version.content).map(r => ({ kind: r.kind, key: r.key, version: r.version, hash: r.hash }));
    const { rows: inserted } = await tx.query(`INSERT INTO tpa.workflow_executions (tenant_id, id, claim_id, definition_id, version_no, content_hash,
        action_catalog_version, benefit_type, pins)
      VALUES (tpa.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb) ON CONFLICT (tenant_id, claim_id) DO NOTHING RETURNING 1`,
    [executionId, request.claimId, binding.definition_id, binding.version_no, version.content_hash, version.action_catalog_version, request.benefitType, JSON.stringify(pins)]);
    if (!inserted.length) return (await existing())!; // concurrent duplicate start committed first
    await runtime.appendAudit(tx, { entityType: 'WORKFLOW_EXECUTION', entityId: executionId, actorType: request.actor.type, actorId: request.actor.id,
      action: 'WORKFLOW_EXECUTION_BOUND', payload: { after_hash: runtime.requestHash({ claimId: request.claimId, definitionId: binding.definition_id,
        versionNo: binding.version_no, contentHash: version.content_hash }) } });
    await runtime.appendOutboxEvent(tx, { eventType: 'workflow.execution-changed', aggregateId: executionId, aggregateVersion: 1,
      correlationId: executionId, causationId: executionId,
      payload: { changeKind: 'BOUND', claimId: request.claimId, definitionId: binding.definition_id, versionNo: binding.version_no, contentHash: version.content_hash } });
    return { status: 'BOUND', executionId, definitionId: binding.definition_id, versionNo: binding.version_no, contentHash: version.content_hash };
  });
}
