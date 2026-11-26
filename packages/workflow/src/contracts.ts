/**
 * WF-01 (#25) workflow contracts shared by the event-worker bridge (client side)
 * and apps/workflow-worker (workflow + activities). This module is bundled into
 * the deterministic Temporal workflow sandbox: NO Node/IO imports, no clock, no
 * randomness. Everything that crosses into Temporal history is an id or a code —
 * never PII, documents, money or free text (spec 06 §3).
 */
export const CLAIM_WORKFLOW_TYPE = 'claimWorkflow';
export const CLAIM_COMMAND_SIGNAL = 'claimCommand';
/** Separate queues: deterministic orchestration vs. DB/IO activities (spec 06 §3). */
export const TASK_QUEUES = Object.freeze({ orchestration: 'tpa-claim-orchestration', io: 'tpa-claim-io' });

/** Spec 03 §1 ClaimStatus codes (kept equal to the event registry by a unit test). */
export const CLAIM_STATUSES = Object.freeze(['PREFLIGHT', 'SUBMITTED', 'AI_PROCESSING', 'GREEN_STP', 'DOCTOR_REVIEW', 'FRAUD_HOLD',
  'SUPPLEMENT_REQUIRED', 'WAITING_ORIGINAL_DOCS', 'EOB_READY', 'OTP_SIGNED', 'PAYOUT_PROCESSING', 'PAID', 'REJECTED', 'CLOSED_EXPIRED'] as const);
export type ClaimStatus = typeof CLAIM_STATUSES[number];
export const TERMINAL_STATUSES: readonly ClaimStatus[] = Object.freeze(['PAID', 'REJECTED', 'CLOSED_EXPIRED']);

export interface ClaimRef { tenantId: string; claimId: string }
/**
 * A command to the claim workflow. `commandId` is the semantic idempotency key:
 * derived from the source event, so every retry/redelivery carries the same id.
 */
export interface ClaimCommand {
  commandId: string;
  transition: ClaimStatus;
  causationEventId: string;
  aggregateVersion: number;
}
/** Activity input: references only. */
export interface TransitionRequest extends ClaimRef { workflowId: string; commandId: string; transition: ClaimStatus }
export interface TransitionResult { applied: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMAND_ID = /^evt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKFLOW_ID = /^claim\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Fixed messages only: never echo the rejected value. */
export class WorkflowContractError extends Error {
  constructor(message: string) { super(message); this.name = 'WorkflowContractError'; }
}
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(value, k));
}
export function assertClaimRef(value: unknown): asserts value is ClaimRef {
  if (!exactKeys(value, ['tenantId', 'claimId']) || typeof value.tenantId !== 'string' || !UUID.test(value.tenantId)
    || typeof value.claimId !== 'string' || !UUID.test(value.claimId)) {
    throw new WorkflowContractError('Invalid claim workflow reference');
  }
}
export function assertClaimCommand(value: unknown): asserts value is ClaimCommand {
  if (!exactKeys(value, ['commandId', 'transition', 'causationEventId', 'aggregateVersion'])
    || typeof value.commandId !== 'string' || !COMMAND_ID.test(value.commandId)
    || typeof value.transition !== 'string' || !(CLAIM_STATUSES as readonly string[]).includes(value.transition)
    || typeof value.causationEventId !== 'string' || !UUID.test(value.causationEventId)
    || !Number.isSafeInteger(value.aggregateVersion) || (value.aggregateVersion as number) < 1) {
    throw new WorkflowContractError('Invalid claim workflow command');
  }
}
export function assertTransitionRequest(value: unknown): asserts value is TransitionRequest {
  if (!exactKeys(value, ['tenantId', 'claimId', 'workflowId', 'commandId', 'transition'])) throw new WorkflowContractError('Invalid transition request');
  assertClaimRef({ tenantId: value.tenantId, claimId: value.claimId });
  if (value.workflowId !== claimWorkflowId(value as unknown as ClaimRef) || typeof value.commandId !== 'string'
    || !COMMAND_ID.test(value.commandId) || !(CLAIM_STATUSES as readonly string[]).includes(value.transition as string)) {
    throw new WorkflowContractError('Invalid transition request');
  }
}

/** Stable workflow id `claim/{tenantId}/{claimId}` (spec 06 §2.4). */
export function claimWorkflowId(ref: ClaimRef): string {
  assertClaimRef({ tenantId: ref.tenantId, claimId: ref.claimId });
  return `claim/${ref.tenantId}/${ref.claimId}`;
}
export function isClaimWorkflowId(value: string): boolean { return WORKFLOW_ID.test(value); }
/** Stable command id for an event: identical on every retry and redelivery. */
export function commandIdForEvent(eventId: string): string {
  if (!UUID.test(eventId)) throw new WorkflowContractError('Invalid source event id');
  return `evt-${eventId}`;
}
