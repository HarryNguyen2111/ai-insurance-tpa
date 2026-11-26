// TEST ONLY: synthetic crash subject for inbox-consumer.e2e.test.ts. The parent
// SIGKILLs this process after it prints CRASH_POINT. Never prints data/credentials.
import { createQuarantineSink, processInboxEvent } from '@tpa/database/inbox';
import { createTenantDatabase } from '@tpa/database/tenant';
import { syntheticHandler } from '../../../../packages/database/test/fixtures/synthetic-handler.ts';
import { createInboxConsumer } from '../../src/consumers/consumer.ts';

const { CRASH_DATABASE_URL: url, CRASH_BROKERS: brokers, CRASH_PREFIX: topicPrefix, CRASH_MODE: mode, CRASH_EVENT: target, CRASH_CONSUMER: consumerName } = process.env;
if (!url || !brokers || !topicPrefix || !mode || !target || !consumerName) process.exit(2);
const crashPoint = () => process.stdout.write('CRASH_POINT\n');
const hang = () => new Promise<never>(() => { setInterval(() => {}, 1 << 30); });

const db = createTenantDatabase({ connectionString: url, max: 2 });
const quarantine = createQuarantineSink({ connectionString: url });
const handler = syntheticHandler({ consumerName, afterApply: async e => {
  if (mode === 'mid-effect' && e.eventId === target) { crashPoint(); await hang(); } // effect written, tx still open
} });
const consumer = createInboxConsumer({
  brokers: brokers.split(','), clientId: 'evt02-crash-child', domains: ['claim'], topicPrefix, db, quarantine, handler,
  maxAttempts: 3, retryBackoffMs: 50, sessionTimeoutMs: 8000, alerts: { alert() {} },
  process: async (...args) => {
    const result = await processInboxEvent(...args);
    const envelope = args[2] as { eventId: string };
    if (mode === 'after-commit' && envelope.eventId === target) { crashPoint(); await hang(); } // committed, offset not committed
    return result;
  },
});
try { await consumer.start(); } catch { process.exit(3); }
