import { Client, Connection, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import {
  assertDefinitionCommand, assertDefinitionExecutionRef, DEFINITION_COMMAND_SIGNAL, DEFINITION_WORKFLOW_TYPE, definitionWorkflowId,
  type DefinitionCommand, type DefinitionExecutionRef,
} from './definition.ts';
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

/** VWF-03 (#80) port for pinned definition executions; separate from the claim command port. */
export interface IDefinitionWorkflowEngine {
  /**
   * VWF-03: durably start the interpreter for one PostgreSQL execution binding on the
   * stable id `wfexec/{tenant}/{execution}`. Args are the exact pin (ids/version/hash).
   * Idempotent: an already started/closed execution resolves without a second run.
   */
  startDefinitionExecution(ref: DefinitionExecutionRef): Promise<WorkflowAcceptance>;
  /** VWF-03: deliver a resume command; the workflow dedups by `commandId`. Never starts a run. */
  submitDefinitionCommand(ref: DefinitionExecutionRef, command: DefinitionCommand): Promise<WorkflowAcceptance>;
}

export interface TemporalEngineOptions { address: string; namespace?: string; connectTimeoutMs?: number }

/** Temporal implementation: signal-with-start on the stable workflow id. */
export class TemporalWorkflowEngine implements IWorkflowEngine, IDefinitionWorkflowEngine {
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

  async startDefinitionExecution(ref: DefinitionExecutionRef): Promise<WorkflowAcceptance> {
    assertDefinitionExecutionRef(ref);
    const workflowId = definitionWorkflowId(ref);
    try {
      const handle = await this.#client.workflow.start(DEFINITION_WORKFLOW_TYPE, {
        workflowId, taskQueue: TASK_QUEUES.orchestration, args: [{ ...ref }],
        // One run per binding for its whole lifetime: duplicates/redeliveries never start another.
        workflowIdReusePolicy: 'REJECT_DUPLICATE', workflowIdConflictPolicy: 'FAIL',
      });
      return { workflowId, runId: handle.firstExecutionRunId, status: 'accepted' };
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) return { workflowId, runId: null, status: 'accepted' };
      throw error;
    }
  }

  async submitDefinitionCommand(ref: DefinitionExecutionRef, command: DefinitionCommand): Promise<WorkflowAcceptance> {
    assertDefinitionExecutionRef(ref);
    assertDefinitionCommand(command);
    const workflowId = definitionWorkflowId(ref);
    try {
      await this.#client.workflow.getHandle(workflowId).signal(DEFINITION_COMMAND_SIGNAL, command);
      return { workflowId, runId: null, status: 'accepted' };
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) return { workflowId, runId: null, status: 'closed' };
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
