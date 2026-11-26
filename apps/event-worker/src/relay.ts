import { setTimeout as sleep } from 'node:timers/promises';
import type { OutboxRelayStore } from '@tpa/database/outbox';
import type { EventPublisher } from './kafka-publisher.ts';

/** Fixed messages + counters only: never event values, tenant data or error text. */
export interface RelayLogger { info(message: string, fields?: Record<string, number>): void; error(message: string, fields?: Record<string, number | string>): void }
export const silentLogger: RelayLogger = { info() {}, error() {} };

export interface RelayCycle { tenants: number; published: number; busyTenants: number; failedTenants: number }
export interface OutboxRelayOptions {
  store: Pick<OutboxRelayStore, 'relayTenants' | 'relayTenantBatch'>;
  publisher: EventPublisher;
  batchSize: number;
  maxTenantsPerCycle: number;
  pollIntervalMs?: number;
  maxBackoffMs?: number;
  logger?: RelayLogger;
}

/**
 * Transactional outbox relay (at-least-once). For each tenant with pending rows
 * it publishes the oldest batch and marks it published only after the broker
 * acknowledged it, inside the same tenant transaction (see relayTenantBatch).
 *
 * Duplicate delivery is explicit, not hidden: if the process dies after the
 * broker ack but before COMMIT of the mark, the same eventIds are published
 * again on recovery. Consumers MUST dedup by eventId (inbox, EVT-02 #24).
 */
export class OutboxRelay {
  private readonly options: Required<OutboxRelayOptions>;
  constructor(options: OutboxRelayOptions) {
    this.options = { pollIntervalMs: 500, maxBackoffMs: 30_000, logger: silentLogger, ...options };
  }

  /**
   * One pass over every registered tenant (keyset pages of `maxTenantsPerCycle`,
   * so no tenant is starved). Per-tenant failures are isolated and counted.
   */
  async runOnce(): Promise<RelayCycle> {
    const { store, batchSize, maxTenantsPerCycle } = this.options;
    const cycle: RelayCycle = { tenants: 0, published: 0, busyTenants: 0, failedTenants: 0 };
    let after: string | null = null;
    while (true) {
      const page = await store.relayTenants(after, maxTenantsPerCycle);
      for (const tenant of page) await this.drainTenant(tenant, batchSize, cycle);
      cycle.tenants += page.length;
      if (page.length < maxTenantsPerCycle) break;
      after = page[page.length - 1];
    }
    if (cycle.published > 0 || cycle.failedTenants > 0) this.options.logger.info('outbox relay cycle', { ...cycle });
    return cycle;
  }

  private async drainTenant(tenant: string, batchSize: number, cycle: RelayCycle): Promise<void> {
    const { store, publisher, logger } = this.options;
    try {
      while (true) {
        const result = await store.relayTenantBatch(tenant, batchSize, events => publisher.publish(events));
        if (!result.locked) { cycle.busyTenants++; break; } // another replica owns this tenant now
        cycle.published += result.published;
        if (result.published < batchSize) break;
      }
    } catch (error) {
      cycle.failedTenants++;
      logger.error('outbox relay tenant batch failed; rows stay pending', { errorName: error instanceof Error ? error.name : 'unknown' });
    }
  }

  /** Poll until `signal` aborts. Backs off exponentially while failures persist. */
  async run(signal: AbortSignal): Promise<void> {
    const { pollIntervalMs, maxBackoffMs, logger } = this.options;
    let backoff = pollIntervalMs;
    while (!signal.aborted) {
      let wait = pollIntervalMs;
      try {
        const cycle = await this.runOnce();
        if (cycle.failedTenants > 0) { backoff = Math.min(backoff * 2, maxBackoffMs); wait = backoff; }
        else { backoff = pollIntervalMs; if (cycle.published > 0) wait = 0; }
      } catch (error) {
        backoff = Math.min(backoff * 2, maxBackoffMs);
        wait = backoff;
        logger.error('outbox relay discovery failed', { errorName: error instanceof Error ? error.name : 'unknown' });
      }
      if (wait > 0) await sleep(wait, undefined, { signal }).catch(() => {});
    }
  }
}
