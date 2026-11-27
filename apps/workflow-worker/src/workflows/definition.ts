// VWF-03 (#80) deterministic interpreter for ONE pinned, published workflow definition.
// Runs in Temporal's sandbox: no DB, network, Node APIs, randomness or wall clock. The
// definition content never enters history; Activities load it by its exact pin and return
// only node ids, codes and counters. Bound executions never see later versions.
import {
  ActivityFailure, ApplicationFailure, condition, continueAsNew, defineSignal, proxyActivities, setHandler, sleep, workflowInfo,
} from '@temporalio/workflow';
import { TASK_QUEUES } from '@tpa/workflow/contracts';
import {
  assertDefinitionCommand, assertDefinitionExecutionRef, DEFINITION_COMMAND_SIGNAL,
  type DefinitionCommand, type DefinitionExecutionRef, type EndOutcome, type StepEvent, type StepState, type WaitPoint,
} from '@tpa/workflow/definition';
import type { AdvanceResult, DefinitionActivities } from '../activities/definition.ts';

const { advanceDefinitionExecution } = proxyActivities<DefinitionActivities>({
  taskQueue: TASK_QUEUES.io,
  startToCloseTimeout: '30 seconds',
  // DB step ledger makes repetition safe; contract violations are non-retryable.
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '1 minute' },
});

export const definitionCommandSignal = defineSignal<[DefinitionCommand]>(DEFINITION_COMMAND_SIGNAL);

/** Carried across Continue-As-New: ids/codes/counters only. */
export interface DefinitionCarry { seen: string[]; stepNo: number; wait: WaitPoint | null; state: StepState | null; suspended: boolean }
export interface DefinitionResult { outcome: EndOutcome; nodeId: string }
const MAX_CARRIED_IDS = 1000;

export async function definitionExecutionWorkflow(ref: DefinitionExecutionRef, carry?: DefinitionCarry): Promise<DefinitionResult> {
  assertDefinitionExecutionRef(ref);
  const seen = new Set<string>(carry?.seen ?? []);
  const pending: DefinitionCommand[] = [];
  let stepNo = carry?.stepNo ?? 0;
  let wait: WaitPoint | null = carry?.wait ?? null;
  let state: StepState | null = carry?.state ?? null;
  let suspended = carry?.suspended ?? false;

  setHandler(definitionCommandSignal, command => {
    try { assertDefinitionCommand(command); } catch { return; } // malformed commands never reach an Activity
    if (seen.has(command.commandId) || pending.some(p => p.commandId === command.commandId)) return; // duplicate resume
    pending.push(command);
  });
  const take = (): DefinitionCommand => { const c = pending.shift()!; seen.add(c.commandId); return c; };

  const advance = async (fromNodeId: string | null, event: StepEvent | { kind: 'ESCALATE' }): Promise<AdvanceResult> => {
    const result = await advanceDefinitionExecution({ ref, stepNo: stepNo + 1, fromNodeId, event, state });
    if (result.status === 'ADVANCED') {
      stepNo += 1; wait = result.wait; state = result.state;
      if (result.wait.kind === 'UNRESOLVED') suspended = true;
    } else if (result.status === 'SUSPENDED') suspended = true;
    return result;
  };

  // A version revoked between binding and start suspends at START (wait stays null): safe stop.
  if (!wait && !suspended) {
    const started = await advance(null, { kind: 'START' });
    if (started.status === 'REJECTED') throw ApplicationFailure.nonRetryable('Execution cannot start', 'DefinitionExecutionClosed');
  }
  while (true) {
    const current = wait as WaitPoint | null;
    if (current?.kind === 'END') return { outcome: current.outcome, nodeId: current.nodeId };
    if (pending.length === 0 && workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof definitionExecutionWorkflow>(ref, { seen: [...seen].slice(-MAX_CARRIED_IDS), stepNo, wait, state, suspended });
    }
    if (suspended || !current || current.kind === 'UNRESOLVED') {
      // Safe stop: only an (already authorized) supervisor escalation proceeds, to manual review.
      await condition(() => pending.length > 0);
      const command = take();
      if (command.kind === 'SUSPENDED_ESCALATION') await advance(null, { kind: 'ESCALATE' });
      continue;
    }
    const point = current;
    switch (point.kind) {
      case 'HUMAN': {
        await condition(() => pending.length > 0);
        const command = take();
        if (command.kind === 'TASK_ACTION' && command.nodeId === point.nodeId) await advance(point.nodeId, { kind: 'ACTION', actionId: command.actionId! });
        else if (command.kind === 'SUPPLEMENT_RECEIVED' || command.kind === 'SUSPENDED_ESCALATION') { /* not applicable here: ignored */ }
        break;
      }
      case 'SUPPLEMENT': {
        // Deadline from workflow time (deterministic); ignored commands never extend it.
        const deadline = Date.now() + point.maxWaitSeconds * 1000;
        let received = false;
        while (!received) {
          const remaining = deadline - Date.now();
          if (remaining <= 0 || !(await condition(() => pending.length > 0, remaining))) break;
          const command = take();
          received = command.kind === 'SUPPLEMENT_RECEIVED' && command.nodeId === point.nodeId;
        }
        await advance(point.nodeId, { kind: 'OUTCOME', outcome: received ? 'RECEIVED' : 'EXPIRED' });
        break;
      }
      case 'TIMER':
        await sleep(point.delaySeconds * 1000);
        await advance(point.nodeId, { kind: 'NEXT' });
        break;
      case 'AI': {
        // Bounded retry/timeout come from the pinned node (<=5 attempts, 30-600 s); exhaustion,
        // an unbound activity or a revoked pinned reference all take the FAILED -> human edge.
        const { runDefinitionAiActivity } = proxyActivities<DefinitionActivities>({
          taskQueue: TASK_QUEUES.io, startToCloseTimeout: point.timeoutSeconds * 1000,
          retry: { maximumAttempts: point.retry.maxAttempts, initialInterval: point.retry.initialIntervalSeconds * 1000,
            backoffCoefficient: point.retry.backoffCoefficient, maximumInterval: point.retry.maxIntervalSeconds * 1000 },
        });
        let outcome: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED';
        try { await runDefinitionAiActivity({ ref, nodeId: point.nodeId, activityKind: point.activityKind }); }
        catch (error) { if (error instanceof ActivityFailure) outcome = 'FAILED'; else throw error; }
        await advance(point.nodeId, { kind: 'OUTCOME', outcome });
        break;
      }
    }
  }
}
