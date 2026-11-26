import pg from 'pg';
import {
  buildEventEnvelope, EventContractError, validateEventEnvelope, type BuiltEvent, type DomainEventDraft, type EventEnvelope,
} from '@tpa/event-contracts';
import { appendAudit, type AuditInput, type AuditRecord } from './audit.ts';
import { createTenantDatabase, type TenantDatabase, type TenantTransaction } from './tenant.ts';

export interface OutboxRecord {
  seq: string; eventId: string; eventType: string; schemaVersion: string;
  topic: string; partitionKey: string; envelope: Readonly<EventEnvelope>;
}

/**
 * Append one validated event to the outbox inside the caller's tenant
 * transaction. The tenant is read from the transaction context (SET LOCAL),
 * never from an argument, so an event can only belong to the transaction tenant.
 */
export async function appendOutboxEvent(tx: TenantTransaction, draft: DomainEventDraft): Promise<OutboxRecord> {
  const { rows: [context] } = await tx.query<{ tenant_id: string }>('SELECT tpa.current_tenant_id()::text AS tenant_id');
  return insertBuilt(tx, buildEventEnvelope(context.tenant_id, draft));
}

async function insertBuilt(tx: TenantTransaction, built: BuiltEvent): Promise<OutboxRecord> {
  const e = built.envelope;
  const { rows: [row] } = await tx.query<{ seq: string; partition_key: string }>(
    `INSERT INTO tpa.outbox_events (tenant_id, event_id, event_type, schema_version, aggregate_id, aggregate_version, topic, envelope)
     VALUES (tpa.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING seq::text, partition_key`,
    [e.eventId, e.eventType, e.schemaVersion, e.aggregateId, e.aggregateVersion, built.topic, JSON.stringify(e)]);
  if (row.partition_key !== built.partitionKey) throw new EventContractError('Outbox partition key mismatch');
  return { seq: row.seq, eventId: e.eventId, eventType: e.eventType, schemaVersion: e.schemaVersion,
    topic: built.topic, partitionKey: row.partition_key, envelope: e };
}

export interface DomainChange<T> {
  result: T;
  /** At least one audit entry: every committed state change is audited. */
  audit: readonly AuditInput[];
  /** At least one event: use plain withTenantTransaction for changes that emit none. */
  events: readonly DomainEventDraft[];
}
export interface CommittedDomainChange<T> { result: T; audit: AuditRecord[]; events: OutboxRecord[] }

/**
 * Atomic business state + audit + outbox (spec 06 §2.2). `mutate` performs the
 * business writes (lock aggregates, check versions) and returns the audit and
 * event drafts. Every event is validated before anything is appended; any
 * failure rolls back the business change, audit and outbox together. Success is
 * returned only after COMMIT. Nothing is published here: the relay does that.
 */
export async function commitDomainChange<T>(db: TenantDatabase, tenantId: string,
  mutate: (tx: TenantTransaction) => Promise<DomainChange<T>>): Promise<CommittedDomainChange<T>> {
  return db.withTenantTransaction(tenantId, async tx => {
    const change = await mutate(tx);
    if (!change || !Array.isArray(change.audit) || change.audit.length === 0) {
      throw new EventContractError('A domain change requires at least one audit entry');
    }
    if (!Array.isArray(change.events) || change.events.length === 0) {
      throw new EventContractError('A domain change requires at least one outbox event');
    }
    const { rows: [context] } = await tx.query<{ tenant_id: string }>('SELECT tpa.current_tenant_id()::text AS tenant_id');
    const built = change.events.map(draft => buildEventEnvelope(context.tenant_id, draft)); // validate all first
    const audit: AuditRecord[] = [];
    for (const entry of change.audit) audit.push(await appendAudit(tx, entry));
    const events: OutboxRecord[] = [];
    for (const event of built) events.push(await insertBuilt(tx, event));
    return { result: change.result, audit, events };
  });
}

/** Wire-ready record handed to the publisher. `value` is the compact JSON envelope. */
export interface PendingOutboxEvent {
  seq: string; eventId: string; eventType: string; schemaVersion: string;
  topic: string; partitionKey: string; value: string;
}
export interface RelayBatchResult { locked: boolean; published: number }
export interface OutboxRelayStore {
  /**
   * Keyset page (ascending UUID) of tenants that have ever emitted outbox events.
   * Returns tenant UUIDs only, never envelopes or pending counts.
   */
  relayTenants(after: string | null, limit: number): Promise<string[]>;
  /**
   * In ONE tenant transaction: take the tenant's relay slot (advisory xact lock,
   * so per-aggregate order holds across relay replicas), lock its oldest
   * unpublished rows, await `publish` (must resolve only after broker ack), then
   * mark them published and commit. A crash or error anywhere before COMMIT
   * leaves the rows unpublished; a crash after ack re-publishes the same eventIds.
   */
  relayTenantBatch(tenantId: string, limit: number, publish: (events: PendingOutboxEvent[]) => Promise<void>): Promise<RelayBatchResult>;
  close(): Promise<void>;
}

const RELAY_LOCK_CLASS = 151502;
export function createOutboxRelayStore(config: pg.PoolConfig): OutboxRelayStore {
  const db = createTenantDatabase(config);
  const discovery = new pg.Pool({ ...config, max: 1 });
  const store: OutboxRelayStore = {
    async relayTenants(after: string | null, limit: number): Promise<string[]> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Tenant discovery limit must be 1..1000');
      const { rows: [row] } = await discovery.query<{ role: string; tenants: string[] }>(
        'SELECT current_user AS role, ARRAY(SELECT tenant_id::text FROM tpa.outbox_relay_tenant_ids($1::uuid, $2)) AS tenants',
        [after, limit]);
      if (row.role !== 'tpa_app') throw new Error('Outbox relay requires the unprivileged tpa_app role');
      return row.tenants;
    },
    relayTenantBatch(tenantId, limit, publish) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) return Promise.reject(new Error('Relay batch limit must be 1..500'));
      return db.withTenantTransaction(tenantId, async tx => {
        const { rows: [slot] } = await tx.query<{ locked: boolean }>(
          'SELECT pg_catalog.pg_try_advisory_xact_lock($1, pg_catalog.hashtext(tpa.current_tenant_id()::text)) AS locked',
          [RELAY_LOCK_CLASS]);
        if (!slot.locked) return { locked: false, published: 0 };
        const { rows } = await tx.query<{ seq: string; event_id: string; event_type: string; schema_version: string;
          topic: string; partition_key: string; envelope: string }>(
          // ORDER BY the table column: a bare `seq` would bind to the text output alias.
          `SELECT o.seq::text AS seq, o.event_id::text AS event_id, o.event_type, o.schema_version, o.topic, o.partition_key,
                  o.envelope::text AS envelope
           FROM tpa.outbox_events o WHERE o.published_at IS NULL ORDER BY o.seq LIMIT $1 FOR UPDATE`, [limit]);
        if (rows.length === 0) return { locked: true, published: 0 };
        const events = rows.map(row => {
          const envelope = JSON.parse(row.envelope) as unknown;
          // Re-validate: rows written around the helper must not reach Kafka. Fails
          // closed (tenant stalls, ordering kept); parking/DLQ ownership is EVT-02.
          try { validateEventEnvelope(envelope); } catch { throw new EventContractError(`Outbox row ${row.seq} failed contract validation`); }
          return { seq: row.seq, eventId: row.event_id, eventType: row.event_type, schemaVersion: row.schema_version,
            topic: row.topic, partitionKey: row.partition_key, value: JSON.stringify(envelope) };
        });
        await publish(events); // Broker acknowledgement happens-before the mark below.
        const { rowCount } = await tx.query(
          'UPDATE tpa.outbox_events SET published_at = now() WHERE event_id = ANY($1::uuid[]) AND published_at IS NULL',
          [events.map(e => e.eventId)]);
        if (rowCount !== events.length) throw new Error('Outbox mark count mismatch; batch will be re-published');
        return { locked: true, published: events.length };
      });
    },
    async close() { await Promise.allSettled([db.close(), discovery.end()]); },
  };
  return Object.freeze(store);
}
