// Outbox relay process (apps/event-worker). Deployed separately from core-api.
import { createOutboxRelayStore } from '@tpa/database/outbox';
import { readRelayConfig } from './config.ts';
import { createKafkaPublisher } from './kafka-publisher.ts';
import { OutboxRelay, type RelayLogger } from './relay.ts';

const logger: RelayLogger = {
  info: (message, fields) => console.log(JSON.stringify({ level: 'info', message, ...fields })),
  error: (message, fields) => console.error(JSON.stringify({ level: 'error', message, ...fields })),
};

const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => controller.abort());

try {
  const config = readRelayConfig();
  const store = createOutboxRelayStore({ connectionString: config.databaseUrl, max: 2, connectionTimeoutMillis: 10_000 });
  const publisher = createKafkaPublisher(config);
  try {
    await publisher.connect();
    logger.info('outbox relay started');
    await new OutboxRelay({ store, publisher, ...config, logger }).run(controller.signal);
  } finally {
    // Graceful drain: an in-flight batch finishes (or rolls back) before exit.
    await Promise.allSettled([publisher.disconnect(), store.close()]);
    logger.info('outbox relay stopped');
  }
} catch (error) {
  logger.error('outbox relay failed to start', { errorName: error instanceof Error ? error.name : 'unknown' });
  process.exitCode = 1;
}
