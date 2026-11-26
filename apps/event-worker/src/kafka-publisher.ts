import { createRequire } from 'node:module';
import type * as KafkaJs from 'kafkajs';
import { topicName } from '@tpa/event-contracts';
import type { PendingOutboxEvent } from '@tpa/database/outbox';

const kafkajs = createRequire(import.meta.url)('kafkajs') as typeof KafkaJs;

export interface EventPublisher {
  /** Resolves only after the broker acknowledged every record (acks=all). */
  publish(events: PendingOutboxEvent[]): Promise<void>;
}
export interface KafkaEventPublisher extends EventPublisher {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}
export interface KafkaPublisherOptions {
  brokers: string[]; clientId: string; topicPrefix: string; sendTimeoutMs: number;
}

/** Headers duplicate envelope routing fields so consumers can dedup/route without parsing. */
export function toKafkaMessage(event: PendingOutboxEvent): KafkaJs.Message {
  return {
    key: event.partitionKey,
    value: event.value,
    headers: {
      'tpa-event-id': event.eventId,
      'tpa-event-type': event.eventType,
      'tpa-schema-version': event.schemaVersion,
      'content-type': 'application/json',
    },
  };
}

/**
 * KafkaJS client logs carry broker/protocol diagnostics, never record values;
 * we still drop the free-form `extra` fields and keep only level/namespace/message.
 */
const quietLogCreator: KafkaJs.logCreator = () => ({ namespace, level, log }) => {
  if (level <= kafkajs.logLevel.ERROR) process.stderr.write(`kafkajs ${namespace}: ${String(log.message).slice(0, 200)}\n`);
};

export function createKafkaPublisher(options: KafkaPublisherOptions): KafkaEventPublisher {
  const kafka = new kafkajs.Kafka({
    clientId: options.clientId, brokers: options.brokers, logLevel: kafkajs.logLevel.ERROR, logCreator: quietLogCreator,
    retry: { retries: 5, initialRetryTime: 200, maxRetryTime: 5000 },
  });
  // Idempotent producer (acks=all, single in-flight) narrows broker-side duplicates
  // from producer retries. It is one layer only: relay crashes can still duplicate.
  const producer = kafka.producer({
    idempotent: true, maxInFlightRequests: 1, allowAutoTopicCreation: false,
    createPartitioner: kafkajs.Partitioners.DefaultPartitioner,
  });
  return {
    connect: () => producer.connect(),
    disconnect: () => producer.disconnect(),
    async publish(events) {
      if (events.length === 0) return;
      const byTopic = new Map<string, KafkaJs.Message[]>();
      for (const event of events) { // Preserve outbox order within each topic.
        const topic = topicName(options.topicPrefix, event.topic);
        byTopic.set(topic, [...(byTopic.get(topic) ?? []), toKafkaMessage(event)]);
      }
      await producer.sendBatch({
        acks: -1, timeout: options.sendTimeoutMs,
        topicMessages: [...byTopic].map(([topic, messages]) => ({ topic, messages })),
      });
    },
  };
}
