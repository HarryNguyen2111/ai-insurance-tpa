// apps/workflow-worker: independent deployable (spec 06 §1). Runs the claim
// workflow + its Activities; never consumes Kafka and never serves HTTP.
import { DefaultLogger, NativeConnection, Runtime } from '@temporalio/worker';
import { createTenantDatabase } from '@tpa/database/tenant';
import { createTransitionActivities } from './activities/transitions.ts';
import { readWorkflowWorkerConfig } from './config.ts';
import { createClaimWorkers } from './worker.ts';

const log = (level: 'info' | 'error', message: string, fields: Record<string, string> = {}) =>
  (level === 'error' ? console.error : console.log)(JSON.stringify({ level, message, ...fields }));

// SDK logs carry ids/types only; keep them at WARN to avoid noisy per-task output.
Runtime.install({ logger: new DefaultLogger('WARN') });

let exitCode = 0;
try {
  const config = readWorkflowWorkerConfig();
  const db = createTenantDatabase({ connectionString: config.databaseUrl, max: 8, connectionTimeoutMillis: 10_000 });
  const connection = await NativeConnection.connect({ address: config.temporalAddress });
  try {
    const workers = await createClaimWorkers({ connection, namespace: config.namespace, activities: createTransitionActivities(db) });
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { log('info', 'workflow worker draining'); workers.shutdown(); });
    log('info', 'workflow worker started');
    await workers.run(); // resolves after graceful shutdown drained in-flight tasks
  } finally {
    await Promise.allSettled([connection.close(), db.close()]);
  }
  log('info', 'workflow worker stopped');
} catch (error) {
  log('error', 'workflow worker failed', { errorName: error instanceof Error ? error.name : 'unknown' });
  exitCode = 1;
}
process.exit(exitCode);
