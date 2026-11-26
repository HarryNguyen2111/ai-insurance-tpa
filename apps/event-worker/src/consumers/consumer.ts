import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import type * as KafkaJs from 'kafkajs';
import { domainTopic, partitionKey, topicName, validateEventEnvelope, type EventEnvelope } from '@tpa/event-contracts';
import {
  assertInboxHandler, NonRetryableEventError, parkInboxEvent, processInboxEvent,
  type InboxHandler, type InboxResult, type QuarantineReason, type QuarantineSink, type RecordSource,
} from '@tpa/database/inbox';
import type { TenantDatabase } from '@tpa/database/tenant';
import { silentLogger, type RelayLogger } from '../relay.ts';
import { stderrAlertSink, type AlertSink } from './alerts.ts';

const kafkajs = createRequire(import.meta.url)('kafkajs') as typeof KafkaJs;

export interface IncomingRecord {
  topic: string; partition: number; offset: string;
  key: Buffer | null; value: Buffer | null; headers?: KafkaJs.IHeaders;
}
export type RecordOutcome = InboxResult | { kind: 'quarantined'; reason: QuarantineReason; created: boolean };

export interface ConsumerDeps {
  db: TenantDatabase;
  quarantine: QuarantineSink;
  handler: InboxHandler;
  /** Environment prefix used by the relay, e.g. `tpa.dev`. Records on other topics are misrouted. */
  topicPrefix: string;
  /** Total attempts per record before parking (bounded retry). */
  maxAttempts: number;
  retryBackoffMs: number;
  alerts?: AlertSink;
  logger?: RelayLogger;
  /** Injection points for tests; default to the durable implementations. */
  process?: typeof processInboxEvent;
  park?: typeof parkInboxEvent;
}

const header = (headers: KafkaJs.IHeaders | undefined, name: string) => {
  const value = headers?.[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined ? undefined : first.toString();
};

/** Decide whether a record is a trustworthy envelope for this topic, without echoing its content. */
export function parseRecord(record: IncomingRecord, topicPrefix: string): { envelope: EventEnvelope } | { poison: QuarantineReason } {
  if (!record.value) return { poison: 'UNPARSEABLE' };
  let candidate: unknown;
  try { candidate = JSON.parse(record.value.toString('utf8')); } catch { return { poison: 'UNPARSEABLE' }; }
  try { validateEventEnvelope(candidate); } catch { return { poison: 'SCHEMA_INVALID' }; }
  const envelope = candidate as EventEnvelope;
  if (header(record.headers, 'tpa-event-id') !== envelope.eventId
    || record.key?.toString('utf8') !== partitionKey(envelope.tenantId, envelope.aggregateId)
    || record.topic !== topicName(topicPrefix, domainTopic(envelope.eventType))) {
    return { poison: 'ROUTING_MISMATCH' };
  }
  return { envelope };
}

/**
 * Durable outcome for one record. Returns only after the outcome is committed in
 * PostgreSQL (effect+inbox, park, or quarantine); the caller may then commit the
 * Kafka offset. Throws only if even parking/quarantine could not be persisted —
 * the offset must then NOT be committed (Kafka redelivers; the inbox dedups).
 */
export async function handleRecord(deps: ConsumerDeps, record: IncomingRecord, heartbeat?: () => Promise<void>): Promise<RecordOutcome> {
  const { handler, alerts = stderrAlertSink, logger = silentLogger } = deps;
  const processEvent = deps.process ?? processInboxEvent;
  const park = deps.park ?? parkInboxEvent;
  const source: RecordSource = { topic: record.topic, partition: record.partition, offset: record.offset };
  const parsed = parseRecord(record, deps.topicPrefix);
  if ('poison' in parsed) {
    const created = await deps.quarantine.quarantine(handler.consumerName, source, record.value, parsed.poison);
    if (created) alerts.alert({ kind: 'RECORD_QUARANTINED', owner: handler.owner, consumerName: handler.consumerName, reasonCode: parsed.poison, source });
    return { kind: 'quarantined', reason: parsed.poison, created };
  }
  const { envelope } = parsed;
  const parked = (result: RecordOutcome, attempts: number) => {
    if (result.kind === 'parked' && result.created) {
      alerts.alert({ kind: 'EVENT_PARKED', owner: handler.owner, consumerName: handler.consumerName, reasonCode: result.reason, source,
        tenantId: envelope.tenantId, eventType: envelope.eventType, parkedId: result.parkedId, attempts });
    }
    return result;
  };
  for (let attempt = 1; ; attempt++) {
    try {
      return parked(await processEvent(deps.db, handler, envelope, source), 0);
    } catch (error) {
      if (error instanceof NonRetryableEventError) {
        return parked(await park(deps.db, handler, envelope, 'HANDLER_REJECTED', attempt, error, source), attempt);
      }
      if (attempt >= deps.maxAttempts) {
        return parked(await park(deps.db, handler, envelope, 'RETRY_EXHAUSTED', attempt, error, source), attempt);
      }
      logger.error('inbox consumer attempt failed; retrying', { attempt, errorName: error instanceof Error ? error.name : 'unknown' });
      await sleep(deps.retryBackoffMs * 2 ** (attempt - 1));
      await heartbeat?.();
    }
  }
}

export interface InboxConsumerOptions extends ConsumerDeps {
  brokers: string[];
  clientId: string;
  /** Domain topics to subscribe, e.g. ['claim']; prefixed with `topicPrefix`. */
  domains: string[];
  sessionTimeoutMs?: number;
}
export interface InboxConsumer { start(): Promise<void>; stop(): Promise<void> }

/**
 * Kafka runner: consumer group = handler.consumerName, auto-commit OFF. Each
 * partition is processed in order; an offset is committed only after
 * handleRecord returned a durable outcome. Crash before the commit means
 * redelivery, which the inbox turns into a no-op duplicate.
 */
export function createInboxConsumer(options: InboxConsumerOptions): InboxConsumer {
  assertInboxHandler(options.handler);
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 20) throw new Error('maxAttempts must be 1..20');
  const topics = options.domains.map(domain => topicName(options.topicPrefix, domain));
  const kafka = new kafkajs.Kafka({ clientId: options.clientId, brokers: options.brokers, logLevel: kafkajs.logLevel.NOTHING,
    retry: { retries: 8, initialRetryTime: 200, maxRetryTime: 5000 } });
  const consumer = kafka.consumer({ groupId: options.handler.consumerName, allowAutoTopicCreation: false,
    sessionTimeout: options.sessionTimeoutMs ?? 30_000, heartbeatInterval: 1_000, rebalanceTimeout: 30_000 });
  return {
    async start() {
      await consumer.connect();
      await consumer.subscribe({ topics, fromBeginning: true });
      await consumer.run({
        autoCommit: false,
        partitionsConsumedConcurrently: 1,
        eachMessage: async ({ topic, partition, message, heartbeat }) => {
          await handleRecord(options, { topic, partition, offset: message.offset, key: message.key, value: message.value,
            headers: message.headers }, heartbeat);
          await consumer.commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + 1n).toString() }]);
        },
      });
    },
    stop: () => consumer.disconnect(),
  };
}
