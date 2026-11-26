// Deterministic workflow code (runs in Temporal's sandbox). No DB, network,
// clock, randomness or Node APIs here: all side effects are Activities (spec 06 §2.5).
import { condition, continueAsNew, defineSignal, proxyActivities, setHandler, workflowInfo } from '@temporalio/workflow';
import {
  assertClaimCommand, assertClaimRef, CLAIM_COMMAND_SIGNAL, claimWorkflowId, TASK_QUEUES, TERMINAL_STATUSES,
  type ClaimCommand, type ClaimRef, type ClaimStatus,
} from '@tpa/workflow/contracts';
import type { TransitionActivities } from '../activities/transitions.ts';

const { applyClaimTransition } = proxyActivities<TransitionActivities>({
  taskQueue: TASK_QUEUES.io,
  startToCloseTimeout: '30 seconds',
  // Unbounded retry with backoff: the Activity is idempotent by its ledger key, so
  // repetition is safe; invalid references are not retried.
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '1 minute', nonRetryableErrorTypes: ['WorkflowContractError'] },
});

export const claimCommandSignal = defineSignal<[ClaimCommand]>(CLAIM_COMMAND_SIGNAL);

/** Carried across Continue-As-New; ids/codes only. */
export interface ClaimWorkflowCarry { seen: string[]; status: ClaimStatus | null }
export interface ClaimWorkflowResult { status: ClaimStatus }
const MAX_CARRIED_IDS = 1000;

/**
 * Synthetic claim orchestration foundation (WF-01): applies each command once,
 * in arrival order, through an idempotent Activity. Duplicate deliveries of the
 * same commandId (bridge retry/redelivery) are ignored by workflow state; a
 * repeated Activity execution is ignored by the DB ledger. Completes on a
 * terminal status. Real claim logic (AI, doctor review, OTP, payout) is WF-02.
 */
export async function claimWorkflow(ref: ClaimRef, carry?: ClaimWorkflowCarry): Promise<ClaimWorkflowResult> {
  assertClaimRef(ref);
  const workflowId = claimWorkflowId(ref);
  const seen = new Set<string>(carry?.seen ?? []);
  const pending: ClaimCommand[] = [];
  let status: ClaimStatus | null = carry?.status ?? null;
  setHandler(claimCommandSignal, command => {
    try { assertClaimCommand(command); } catch { return; } // malformed commands never reach an Activity
    if (seen.has(command.commandId) || pending.some(p => p.commandId === command.commandId)) return;
    seen.add(command.commandId);
    pending.push(command);
  });
  while (true) {
    await condition(() => pending.length > 0);
    const command = pending.shift()!;
    await applyClaimTransition({ tenantId: ref.tenantId, claimId: ref.claimId, workflowId, commandId: command.commandId, transition: command.transition });
    seen.add(command.commandId);
    status = command.transition;
    if (TERMINAL_STATUSES.includes(status)) return { status };
    if (pending.length === 0 && workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof claimWorkflow>(ref, { seen: [...seen].slice(-MAX_CARRIED_IDS), status });
    }
  }
}
