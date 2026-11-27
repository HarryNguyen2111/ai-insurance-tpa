// NOTIF-01 (#107): independent consumer process projecting claim events into the tenant notification inbox.
// Run: node src/consumers/notification-main.ts (NOTIFICATION_DATABASE_URL must use tpa_app). No provider/push calls.
import { createTenantDatabase } from '@tpa/database/tenant';
import { createQuarantineSink } from '@tpa/database/inbox';
import { createInboxConsumer } from './consumer.ts';
import { createNotificationProjectionHandler } from './notification-projection.ts';

// URLs are server configuration, never event input.
const url = process.env.NOTIFICATION_DATABASE_URL;
let parsed: URL | undefined;
try { parsed = url ? new URL(url) : undefined; } catch { /* fixed error below */ }
if (!parsed || !['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.username !== 'tpa_app') {
  throw new Error('NOTIFICATION_DATABASE_URL must use PostgreSQL tpa_app');
}
const db = createTenantDatabase({ connectionString: url, max: 4 });
const quarantine = createQuarantineSink({ connectionString: url });
let consumer: ReturnType<typeof createInboxConsumer> | undefined;
try {
  consumer = createInboxConsumer({ db, quarantine, handler: createNotificationProjectionHandler(),
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','), clientId: 'notification-projection',
    domains: ['claim'], topicPrefix: process.env.KAFKA_TOPIC_PREFIX ?? 'tpa.dev', maxAttempts: 5, retryBackoffMs: 250 });
  const stopped = new Promise<void>(resolve => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => resolve());
  });
  await consumer.start();
  await stopped;
} catch (error) {
  console.error(JSON.stringify({ level: 'error', message: 'notification projection failed', errorName: error instanceof Error ? error.name : 'Error' }));
  process.exitCode = 1;
} finally {
  await consumer?.stop();
  await Promise.allSettled([db.close(), quarantine.close()]);
}
