// TEST ONLY: synthetic crash subject for outbox-relay.e2e.test.ts (PT05). The parent
// SIGKILLs this process after it prints the fixed CRASH_POINT marker. It never
// prints connection data, events or payloads.
import { randomUUID } from 'node:crypto';
import { commitDomainChange, createOutboxRelayStore } from '@tpa/database/outbox';
import { createTenantDatabase } from '@tpa/database/tenant';
import { createKafkaPublisher } from '../../src/kafka-publisher.ts';
import { OutboxRelay } from '../../src/relay.ts';

const { PT05_DATABASE_URL: connectionString, PT05_BROKERS: brokers, PT05_TOPIC_PREFIX: topicPrefix, PT05_MODE: mode, PT05_INPUT: input } = process.env;
if (!connectionString || !brokers || !topicPrefix || !mode || !input) process.exit(2);
const { tenant, aggregate, label } = JSON.parse(input) as { tenant: string; aggregate: string; label: string };
const crashPoint = () => process.stdout.write('CRASH_POINT\n');
const hang = () => new Promise<never>(() => { setInterval(() => {}, 1 << 30); });

try {
  if (mode === 'after-commit') {
    // Business + audit + outbox committed; the process dies before any relay runs.
    const db = createTenantDatabase({ connectionString, max: 1 });
    await commitDomainChange(db, tenant, async tx => {
      await tx.query('INSERT INTO tpa.isolation_parent VALUES (tpa.current_tenant_id(), $1, $2)', [aggregate, label]);
      return { result: null, audit: [{ entityType: 'CLAIM', entityId: aggregate, actorType: 'SYSTEM', actorId: randomUUID(), action: 'SUBMIT', payload: {} }],
        events: [{ eventType: 'claim.submitted', aggregateId: aggregate, aggregateVersion: 1, correlationId: randomUUID(), causationId: randomUUID(), payload: {} }] };
    });
    crashPoint();
    await hang();
  } else if (mode === 'before-publish' || mode === 'after-ack') {
    const store = createOutboxRelayStore({ connectionString, max: 2 });
    const kafka = createKafkaPublisher({ brokers: brokers.split(','), clientId: 'pt05-crash-child', topicPrefix, sendTimeoutMs: 30_000 });
    await kafka.connect();
    const relay = new OutboxRelay({ store, batchSize: 50, maxTenantsPerCycle: 100, publisher: {
      async publish(events) {
        if (!events.some(e => e.partitionKey.startsWith(`${tenant}:`))) return kafka.publish(events);
        if (mode === 'after-ack') await kafka.publish(events); // resolves only after broker ack (acks=all)
        crashPoint(); // Rows locked, mark not yet written/committed.
        return hang();
      },
    } });
    await relay.runOnce();
    process.exit(4); // The crash point must have been reached.
  } else process.exit(2);
} catch {
  process.exit(3);
}
