// VWF-03 (#80) CI e2e: PG16 + Compose-pinned Temporal + Kafka. BOUND outbox events travel through
// the real relay and inbox consumer; the start handler crashes once AFTER Temporal acceptance and
// BEFORE the inbox commit, so recovery relies on redelivery + the stable workflow id.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DefaultLogger, Runtime } from '@temporalio/worker';
import { createOutboxRelayStore } from '@tpa/database/outbox';
import { createQuarantineSink, type InboxHandler } from '@tpa/database/inbox';
import { createTenantDatabase } from '@tpa/database/tenant';
import { connectTemporalEngine } from '@tpa/workflow/engine';
import { createDefinitionExecutionHandler } from '../src/consumers/definition-execution.ts';
import { createInboxConsumer, type InboxConsumer } from '../src/consumers/consumer.ts';
import { createKafkaPublisher } from '../src/kafka-publisher.ts';
import { OutboxRelay } from '../src/relay.ts';
import { startHarness } from './fixtures/docker-harness.ts';
import { startTemporal } from './fixtures/temporal-harness.ts';
import { runDefinitionExecutionScenario, until } from './fixtures/definition-scenario.ts';

test('VWF-03: pinned definition execution, crash recovery, restart/replay, revoke suspension (VW08/VW09/VW22/VW23 synthetic)', async t => {
  const h = await startHarness([]);
  let server: Awaited<ReturnType<typeof startTemporal>> | undefined;
  let consumer: InboxConsumer | undefined;
  let engine: Awaited<ReturnType<typeof connectTemporalEngine>> | undefined;
  const db = createTenantDatabase({ connectionString: h.url('tpa_app'), max: 4 });
  const quarantine = createQuarantineSink({ connectionString: h.url('tpa_app') });
  const relayStore = createOutboxRelayStore({ connectionString: h.url('tpa_app'), max: 2 });
  const publisher = createKafkaPublisher({ brokers: h.brokers, clientId: 'vwf03-relay', topicPrefix: 'tpa.vwf03', sendTimeoutMs: 30000 });
  try {
    server = await startTemporal(h);
    t.diagnostic(`${h.versions}; ${server.version}; TS SDK 1.27.0`);
    Runtime.install({ logger: new DefaultLogger('WARN') });
    engine = await connectTemporalEngine({ address: server.address });
    await h.createTopics(['tpa.vwf03.workflow']);
    await publisher.connect();
    const relay = new OutboxRelay({ store: relayStore, publisher, batchSize: 50, maxTenantsPerCycle: 50 });
    const real = createDefinitionExecutionHandler(engine.engine);
    let crashes = 0, applied = 0;
    const handler: InboxHandler = { ...real, async apply(tx, envelope) {
      await real.apply(tx, envelope);
      if ((envelope.payload as { changeKind?: string }).changeKind === 'BOUND') applied++;
      if (crashes === 0 && applied === 1) { crashes++; throw new Error('Synthetic crash after Temporal acceptance'); }
    } };
    consumer = createInboxConsumer({ db, quarantine, handler, brokers: h.brokers, clientId: 'vwf03-bridge', domains: ['workflow'],
      topicPrefix: 'tpa.vwf03', maxAttempts: 5, retryBackoffMs: 50, sessionTimeoutMs: 8000 });
    await consumer.start();
    await runDefinitionExecutionScenario(t, { url: h.url, admin: h.pgAdmin, temporalAddress: server.address, deliver: async () => { await relay.runOnce(); } });
    assert.equal(crashes, 1);
    assert.ok(applied >= 3, 'crashed BOUND delivery was redelivered and applied again');
    const parked = await h.pgAdmin.query(`SELECT count(*)::int AS n FROM tpa.consumer_parked_events`);
    assert.equal(parked.rows[0].n, 0);
    await until('inbox recorded', async () => (await h.pgAdmin.query(`SELECT count(*)::int AS n FROM tpa.consumer_inbox WHERE consumer_name='workflow-definition-execution'`)).rows[0].n >= 2);
  } finally {
    await consumer?.stop();
    await Promise.allSettled([publisher.disconnect(), quarantine.close(), relayStore.close(), db.close(), engine?.close()]);
    server?.cleanup();
    await h.cleanup();
  }
});
