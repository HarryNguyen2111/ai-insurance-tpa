import { createTenantDatabase } from '@tpa/database/tenant';
import { createQuarantineSink } from '@tpa/database/inbox';
import { connectTemporalEngine } from '@tpa/workflow/engine';
import { createInboxConsumer } from './consumer.ts';
import { createWorkflowHandler } from './workflow.ts';

// Independent bridge process; URLs are server configuration, never event input.
const url = process.env.WORKFLOW_DATABASE_URL;
let parsed: URL | undefined;
try { parsed = url ? new URL(url) : undefined; } catch { /* fixed error below */ }
if (!parsed || !['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.username !== 'tpa_app') {
  throw new Error('WORKFLOW_DATABASE_URL must use PostgreSQL tpa_app');
}
const db = createTenantDatabase({ connectionString: url, max: 4 });
const quarantine = createQuarantineSink({ connectionString: url });
let temporal: Awaited<ReturnType<typeof connectTemporalEngine>> | undefined;
let consumer: ReturnType<typeof createInboxConsumer> | undefined;
try {
  temporal = await connectTemporalEngine({ address: process.env.TEMPORAL_ADDRESS ?? '', namespace: process.env.TEMPORAL_NAMESPACE });
  consumer = createInboxConsumer({ db, quarantine, handler: createWorkflowHandler(temporal.engine),
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','), clientId: 'claim-workflow-bridge',
    domains: ['claim'], topicPrefix: process.env.KAFKA_TOPIC_PREFIX ?? 'tpa.dev', maxAttempts: 5, retryBackoffMs: 250 });
  const stopped = new Promise<void>(resolve => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => resolve());
  });
  await consumer.start();
  await stopped;
} catch (error) {
  console.error(JSON.stringify({ level: 'error', message: 'workflow bridge failed', errorName: error instanceof Error ? error.name : 'Error' }));
  process.exitCode = 1;
} finally {
  await consumer?.stop();
  await Promise.allSettled([db.close(), quarantine.close(), temporal?.close()]);
}
