import { Client, Connection, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import {
  assertClaimCommand, assertClaimRef, CLAIM_COMMAND_SIGNAL, CLAIM_WORKFLOW_TYPE, claimWorkflowId, TASK_QUEUES,
  type ClaimCommand, type ClaimRef,
} from './contracts.ts';

/**
 * Port for durable workflow orchestration (AGENTS §1: Temporal via IWorkflowEngine).
 * Domain code and consumers depend on this interface, never on the SDK directly.
 */
export interface WorkflowAcceptance {
  workflowId: string;
  /** Run that durably recorded the command; null when the workflow was already closed. */
  runId: string | null;
  /** `accepted`: durably recorded by the engine. `closed`: workflow finished earlier; nothing to do. */
  status: 'accepted' | 'closed';
}
export interface IWorkflowEngine {
  /**
   * Durably deliver `command` to the claim workflow `claim/{tenant}/{claim}`,
   * starting it if needed. Resolves only after the engine accepted it. Safe to
   * retry with the same command: the workflow dedups by `commandId`.
   */
  submitClaimCommand(ref: ClaimRef, command: ClaimCommand): Promise<WorkflowAcceptance>;
}

export interface TemporalEngineOptions { address: string; namespace?: string; connectTimeoutMs?: number }

/** Temporal implementation: signal-with-start on the stable workflow id. */
export class TemporalWorkflowEngine implements IWorkflowEngine {
  readonly #client: Client;
  constructor(client: Client) { this.#client = client; }

  async submitClaimCommand(ref: ClaimRef, command: ClaimCommand): Promise<WorkflowAcceptance> {
    assertClaimRef(ref);
    assertClaimCommand(command);
    const workflowId = claimWorkflowId(ref);
    try {
      const handle = await this.#client.workflow.signalWithStart(CLAIM_WORKFLOW_TYPE, {
        workflowId,
        taskQueue: TASK_QUEUES.orchestration,
        args: [{ tenantId: ref.tenantId, claimId: ref.claimId }],
        signal: CLAIM_COMMAND_SIGNAL,
        signalArgs: [command],
        // A closed claim workflow is never silently restarted by a late/duplicate event.
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
      });
      return { workflowId, runId: handle.signaledRunId, status: 'accepted' };
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) return { workflowId, runId: null, status: 'closed' };
      throw error;
    }
  }
}

/** Composition-root helper. Address comes from server config, never from requests. */
export async function connectTemporalEngine(options: TemporalEngineOptions): Promise<{ engine: TemporalWorkflowEngine; close(): Promise<void> }> {
  if (!/^[A-Za-z0-9.-]+:\d{1,5}$/.test(options.address)) throw new Error('Invalid Temporal address');
  const connection = await Connection.connect({ address: options.address, connectTimeout: options.connectTimeoutMs ?? 10_000 });
  const client = new Client({ connection, namespace: options.namespace ?? 'default' });
  return { engine: new TemporalWorkflowEngine(client), close: () => connection.close() };
}
