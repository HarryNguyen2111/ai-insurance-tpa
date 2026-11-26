import { createHash } from 'node:crypto';
import { appendAudit } from '@tpa/database/audit';
import type { TenantDatabase } from '@tpa/database/tenant';
import { assertTransitionRequest, type TransitionRequest, type TransitionResult } from '@tpa/workflow/contracts';

/**
 * Opaque internal actor for workflow-driven system changes (audit actor_id must
 * be a UUID, never a name). Fixed so audit entries are attributable to WF-01.
 */
export const WORKFLOW_SYSTEM_ACTOR_ID = '6f1c2b0e-3d4a-4c5b-8e9f-0a1b2c3d4e5f';

export interface TransitionActivities {
  applyClaimTransition(request: TransitionRequest): Promise<TransitionResult>;
}

/**
 * Activities run outside the workflow sandbox and own every side effect. Each
 * writes its semantic key (workflow_id, command_id, activity) in the SAME tenant
 * transaction as the change, so Temporal retries or a crash after COMMIT but
 * before completion is reported can never apply a transition twice.
 * Synthetic scope (WF-01): the transition is recorded as ledger + audit only;
 * real claim state changes arrive with CLM-02/WF-02 and reuse this pattern.
 */
export function createTransitionActivities(db: TenantDatabase): TransitionActivities {
  return {
    async applyClaimTransition(request) {
      assertTransitionRequest(request); // WorkflowContractError is non-retryable in the workflow
      return db.withTenantTransaction(request.tenantId, async tx => {
        const { rows } = await tx.query(
          `INSERT INTO tpa.workflow_command_ledger (tenant_id, workflow_id, command_id, activity, transition)
           VALUES (tpa.current_tenant_id(), $1, $2, 'applyClaimTransition', $3) ON CONFLICT DO NOTHING RETURNING 1`,
          [request.workflowId, request.commandId, request.transition]);
        if (rows.length === 0) return { applied: false };
        await appendAudit(tx, { entityType: 'CLAIM', entityId: request.claimId, actorType: 'SYSTEM', actorId: WORKFLOW_SYSTEM_ACTOR_ID,
          action: 'WORKFLOW_TRANSITION', payload: { after_hash: createHash('sha256')
            .update(`${request.workflowId}|${request.commandId}|${request.transition}`, 'utf8').digest('hex') } });
        return { applied: true };
      });
    },
  };
}
