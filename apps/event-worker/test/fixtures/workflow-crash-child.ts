// Test-only: die after durable Temporal acceptance while the inbox tx is open.
import { createTenantDatabase } from '@tpa/database/tenant';
import { createQuarantineSink } from '@tpa/database/inbox';
import { connectTemporalEngine } from '@tpa/workflow/engine';
import { createWorkflowHandler } from '../../src/consumers/workflow.ts';
import { createInboxConsumer } from '../../src/consumers/consumer.ts';
const db = createTenantDatabase({ connectionString: process.env.CRASH_DATABASE_URL });
const quarantine = createQuarantineSink({ connectionString: process.env.CRASH_DATABASE_URL });
const temporal = await connectTemporalEngine({ address: process.env.TEMPORAL_ADDRESS! });
const handler = createWorkflowHandler({ async submitClaimCommand(ref, command) {
  await temporal.engine.submitClaimCommand(ref, command);
  process.stdout.write('ACCEPTED\n');
  process.kill(process.pid, 'SIGKILL');
  return new Promise<never>(() => {});
} });
await createInboxConsumer({ db, quarantine, handler, brokers: process.env.CRASH_BROKERS!.split(','),
  clientId: 'workflow-crash', domains: ['claim'], topicPrefix: process.env.CRASH_PREFIX!,
  maxAttempts: 3, retryBackoffMs: 50, sessionTimeoutMs: 8000 }).start();
