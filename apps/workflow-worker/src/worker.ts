import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import { TASK_QUEUES } from '@tpa/workflow/contracts';
import type { TransitionActivities } from './activities/transitions.ts';

export const WORKFLOWS_PATH = fileURLToPath(new URL('./workflows/index.ts', import.meta.url));

export interface ClaimWorkers { run(): Promise<void>; shutdown(): void }

/**
 * Two Temporal workers in one deployable: deterministic orchestration (workflows
 * only) and IO (activities only), on separate task queues (spec 06 §3). Workflow
 * code is bundled from WORKFLOWS_PATH, so non-deterministic imports fail at startup.
 */
export async function createClaimWorkers(options: {
  connection: NativeConnection; namespace?: string; activities: TransitionActivities; identity?: string;
}): Promise<ClaimWorkers> {
  const namespace = options.namespace ?? 'default';
  const orchestration = await Worker.create({ connection: options.connection, namespace, taskQueue: TASK_QUEUES.orchestration,
    workflowsPath: WORKFLOWS_PATH, ...(options.identity ? { identity: options.identity } : {}), shutdownGraceTime: '10 seconds' });
  const io = await Worker.create({ connection: options.connection, namespace, taskQueue: TASK_QUEUES.io,
    activities: { ...options.activities }, ...(options.identity ? { identity: options.identity } : {}), maxConcurrentActivityTaskExecutions: 16, shutdownGraceTime: '10 seconds' });
  return {
    run: async () => { await Promise.all([orchestration.run(), io.run()]); },
    shutdown: () => { orchestration.shutdown(); io.shutdown(); },
  };
}
