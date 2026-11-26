import type { InboxHandler } from '@tpa/database/inbox';
import { commandIdForEvent, type ClaimStatus } from '@tpa/workflow/contracts';
import type { IWorkflowEngine } from '@tpa/workflow/engine';

/** Temporal acceptance precedes inbox commit. A crash between them redelivers
 * the same workflow/command IDs; workflow and Activity ledger dedup both retries.
 * Aggregate gaps park for audited operator recovery; no missing commands invented.
 */
export function createWorkflowHandler(engine: IWorkflowEngine): InboxHandler {
  return {
    consumerName: 'claim-workflow', owner: 'workflow-ops',
    eventTypes: ['claim.submitted', 'claim.state-changed'], ordering: 'aggregate-version',
    async apply(_tx, envelope) {
      await engine.submitClaimCommand({ tenantId: envelope.tenantId, claimId: envelope.aggregateId }, {
        commandId: commandIdForEvent(envelope.eventId), causationEventId: envelope.eventId,
        aggregateVersion: envelope.aggregateVersion,
        transition: envelope.eventType === 'claim.submitted' ? 'SUBMITTED' : envelope.payload.toStatus as ClaimStatus,
      });
    },
  };
}
