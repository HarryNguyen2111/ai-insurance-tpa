// NOTIF-01 (#107) CI e2e: PG16 + Compose-pinned Kafka. Claim outbox events travel through the real relay
// and the real inbox consumer into recipient-scoped tenant notifications. Synthetic data only.
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createOutboxRelayStore } from '@tpa/database/outbox';
import { createQuarantineSink } from '@tpa/database/inbox';
import { createTenantDatabase } from '@tpa/database/tenant';
import { createInboxConsumer, type InboxConsumer } from '../src/consumers/consumer.ts';
import { createNotificationProjectionHandler } from '../src/consumers/notification-projection.ts';
import { createKafkaPublisher } from '../src/kafka-publisher.ts';
import { OutboxRelay } from '../src/relay.ts';
import { startHarness } from './fixtures/docker-harness.ts';
import { NOTIFICATION_CONSUMER, runNotificationProjectionScenario } from './fixtures/notification-scenario.ts';

test('NOTIF-01: claim events -> relay -> Kafka -> inbox consumer -> tenant notifications (dedup, atomicity, privacy)', async t => {
  const h = await startHarness([]);
  let consumer: InboxConsumer | undefined;
  const db = createTenantDatabase({ connectionString: h.url('tpa_app'), max: 4 });
  const quarantine = createQuarantineSink({ connectionString: h.url('tpa_app') });
  const relayStore = createOutboxRelayStore({ connectionString: h.url('tpa_app'), max: 2 });
  const publisher = createKafkaPublisher({ brokers: h.brokers, clientId: 'notif01-relay', topicPrefix: 'tpa.notif01', sendTimeoutMs: 30000 });
  try {
    t.diagnostic(h.versions);
    await h.createTopics(['tpa.notif01.claim']);
    await publisher.connect();
    const relay = new OutboxRelay({ store: relayStore, publisher, batchSize: 50, maxTenantsPerCycle: 50 });
    consumer = createInboxConsumer({ db, quarantine, handler: createNotificationProjectionHandler(), brokers: h.brokers, clientId: 'notif01-consumer',
      domains: ['claim'], topicPrefix: 'tpa.notif01', maxAttempts: 5, retryBackoffMs: 50, sessionTimeoutMs: 8000 });
    await consumer.start();
    await runNotificationProjectionScenario(t, { url: h.url, admin: h.pgAdmin, deliver: async expected => {
      await relay.runOnce();
      const deadline = Date.now() + 90_000;
      while ((await h.pgAdmin.query(`SELECT count(*)::int AS n FROM tpa.consumer_inbox WHERE consumer_name=$1`, [NOTIFICATION_CONSUMER])).rows[0].n < expected) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for the notification consumer');
        await delay(200);
      }
    } });
  } finally {
    await consumer?.stop();
    await Promise.allSettled([publisher.disconnect(), quarantine.close(), relayStore.close(), db.close()]);
    await h.cleanup();
  }
});
