import { NonRetryableEventError, type InboxHandler } from '@tpa/database/inbox';
import type { DefinitionExecutionRef } from '@tpa/workflow/definition';
import type { IDefinitionWorkflowEngine } from '@tpa/workflow/engine';

/**
 * VWF-03 (#80) start bridge. The binding row, audit and `workflow.execution-changed BOUND`
 * outbox event commit together in core-api; this consumer starts the pinned interpreter.
 * Recovery: a crash before Temporal acceptance leaves the inbox uncommitted, so the event is
 * redelivered; a crash after acceptance redelivers too, and the stable workflow id makes the
 * second start a no-op. The pin is re-read from PostgreSQL truth in the inbox transaction:
 * an event can never start a version the database did not bind.
 */
export function createDefinitionExecutionHandler(engine: IDefinitionWorkflowEngine): InboxHandler {
  return {
    consumerName: 'workflow-definition-execution', owner: 'workflow-ops',
    eventTypes: ['workflow.execution-changed'], ordering: 'none',
    async apply(tx, envelope) {
      const payload = envelope.payload as { changeKind: string; claimId: string; definitionId: string; versionNo: number; contentHash: string };
      if (payload.changeKind !== 'BOUND') return; // SUSPENDED/COMPLETED are informational for this consumer
      const { rows: [row] } = await tx.query<{ claim_id: string; definition_id: string; version_no: number; content_hash: string }>(
        'SELECT claim_id::text, definition_id::text, version_no, content_hash FROM tpa.workflow_executions WHERE id = $1', [envelope.aggregateId]);
      if (!row || row.claim_id !== payload.claimId || row.definition_id !== payload.definitionId
        || row.version_no !== payload.versionNo || row.content_hash !== payload.contentHash) {
        throw new NonRetryableEventError('Execution binding does not match PostgreSQL truth');
      }
      const ref: DefinitionExecutionRef = { tenantId: envelope.tenantId, claimId: row.claim_id, executionId: envelope.aggregateId,
        definitionId: row.definition_id, versionNo: row.version_no, contentHash: row.content_hash };
      await engine.startDefinitionExecution(ref);
    },
  };
}
