import { createHash } from 'node:crypto';
import pg from 'pg';
import { EventContractError, validateEventEnvelope, type EventEnvelope } from '@tpa/event-contracts';
import { appendAudit } from './audit.ts';
import type { TenantDatabase, TenantTransaction } from './tenant.ts';

/**
 * EVT-02 (#24) consumer inbox. Delivery is at-least-once: a consumer's effect and
 * its inbox row commit in ONE tenant transaction, and the Kafka offset is
 * committed only afterwards (see apps/event-worker consumers). A redelivered
 * event is detected and skipped — never re-applied. No exactly-once claim.
 */
export const CONSUMER_NAME = /^[a-z][a-z0-9-]{2,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface InboxHandler {
  /** Durable dedup namespace; also the Kafka consumer group. */
  consumerName: string;
  /** Team/rota that receives parking alerts for this consumer. */
  owner: string;
  eventTypes: readonly string[];
  /** `aggregate-version`: stale events are skipped, gaps reconciled or parked. */
  ordering: 'aggregate-version' | 'none';
  /** The effect. Runs inside the tenant transaction that also writes the inbox row. */
  apply(tx: TenantTransaction, envelope: Readonly<EventEnvelope>): Promise<void>;
  /**
   * Optional gap handling (spec 06 §2.6): reload the authorized snapshot from
   * PostgreSQL truth and return the aggregate version it reflects (>= event).
   */
  reconcile?(tx: TenantTransaction, envelope: Readonly<EventEnvelope>): Promise<number>;
}

/** Throw from a handler when retrying cannot help (event is parked immediately). */
export class NonRetryableEventError extends Error {
  constructor(message = 'Event cannot be applied') { super(message); this.name = 'NonRetryableEventError'; }
}
export class ReplayDeniedError extends Error {
  constructor() { super('Event replay/discard is not authorized'); this.name = 'ReplayDeniedError'; }
}

export type ParkReason = 'RETRY_EXHAUSTED' | 'HANDLER_REJECTED' | 'VERSION_GAP' | 'BLOCKED_BY_PARKED';
export type QuarantineReason = 'UNPARSEABLE' | 'SCHEMA_INVALID' | 'ROUTING_MISMATCH';
export interface RecordSource { topic: string; partition: number; offset: string }
export type InboxResult =
  | { kind: 'applied' | 'reconciled' | 'stale'; version: number }
  | { kind: 'duplicate' }
  | { kind: 'ignored' }
  | { kind: 'parked'; parkedId: string; reason: ParkReason; created: boolean };

export function assertInboxHandler(handler: InboxHandler): void {
  if (!handler || !CONSUMER_NAME.test(handler.consumerName) || !/^[a-z][a-z0-9-]{1,63}$/.test(handler.owner)
    || !Array.isArray(handler.eventTypes) || handler.eventTypes.length === 0 || typeof handler.apply !== 'function'
    || !['aggregate-version', 'none'].includes(handler.ordering)
    || (handler.reconcile !== undefined && typeof handler.reconcile !== 'function')) {
    throw new Error('Invalid inbox handler definition');
  }
}
/** Error class names only — never messages, which may echo data. */
export function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  return ERROR_NAME.test(name) ? name : 'Error';
}
const isInboxConflict = (error: unknown) => error instanceof Error && 'code' in error && error.code === '23505'
  && 'constraint' in error && error.constraint === 'consumer_inbox_pkey';

interface ReplayContext { parkedId: string; actorId: string }
type Decision = InboxResult | { kind: 'unresolved'; reason: ParkReason };

async function park(tx: TenantTransaction, handler: InboxHandler, envelope: Readonly<EventEnvelope>, reason: ParkReason,
  attempts: number, errorName: string | null, source?: RecordSource): Promise<InboxResult> {
  const { rows: [inserted] } = await tx.query<{ id: string }>(
    `INSERT INTO tpa.consumer_parked_events (tenant_id, consumer_name, event_id, event_type, aggregate_id, aggregate_version,
       envelope, reason_code, attempts, error_name, source_topic, source_partition, source_offset)
     VALUES (tpa.current_tenant_id(), $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (tenant_id, consumer_name, event_id) DO NOTHING RETURNING id::text`,
    [handler.consumerName, envelope.eventId, envelope.eventType, envelope.aggregateId, envelope.aggregateVersion,
      JSON.stringify(envelope), reason, attempts, errorName, source?.topic ?? null, source?.partition ?? null, source?.offset ?? null]);
  if (inserted) return { kind: 'parked', parkedId: inserted.id, reason, created: true };
  const { rows: [existing] } = await tx.query<{ id: string; reason_code: ParkReason }>(
    'SELECT id::text, reason_code FROM tpa.consumer_parked_events WHERE consumer_name=$1 AND event_id=$2',
    [handler.consumerName, envelope.eventId]);
  return { kind: 'parked', parkedId: existing.id, reason: existing.reason_code, created: false };
}

/** Shared by live processing and replay so both obey identical dedup/order rules. */
async function decide(tx: TenantTransaction, handler: InboxHandler, envelope: Readonly<EventEnvelope>,
  source: RecordSource | undefined, replay: ReplayContext | undefined): Promise<Decision> {
  const { consumerName } = handler;
  const { rows: seen } = await tx.query('SELECT 1 FROM tpa.consumer_inbox WHERE consumer_name=$1 AND event_id=$2',
    [consumerName, envelope.eventId]);
  if (seen.length > 0) return { kind: 'duplicate' };
  if (!replay) {
    const { rows: parked } = await tx.query('SELECT 1 FROM tpa.consumer_parked_events WHERE consumer_name=$1 AND event_id=$2',
      [consumerName, envelope.eventId]);
    if (parked.length > 0) return { kind: 'duplicate' }; // redelivery of an already-parked event
  }
  let outcome: 'APPLIED' | 'RECONCILED' | 'STALE' = 'APPLIED';
  let version = envelope.aggregateVersion;
  if (handler.ordering === 'aggregate-version') {
    // Lock the aggregate position (created on first sight) so concurrent members serialize.
    await tx.query(`INSERT INTO tpa.consumer_aggregate_positions (tenant_id, consumer_name, aggregate_id)
      VALUES (tpa.current_tenant_id(), $1, $2) ON CONFLICT DO NOTHING`, [consumerName, envelope.aggregateId]);
    const { rows: [position] } = await tx.query<{ last_version: number }>(
      'SELECT last_version FROM tpa.consumer_aggregate_positions WHERE consumer_name=$1 AND aggregate_id=$2 FOR UPDATE',
      [consumerName, envelope.aggregateId]);
    const last = position.last_version;
    const { rows: [blocking] } = await tx.query<{ min: number | null }>(
      `SELECT min(aggregate_version) AS min FROM tpa.consumer_parked_events
       WHERE consumer_name=$1 AND aggregate_id=$2 AND status='PARKED' AND ($3::uuid IS NULL OR id <> $3::uuid)`,
      [consumerName, envelope.aggregateId, replay?.parkedId ?? null]);
    if (envelope.aggregateVersion <= last) {
      outcome = 'STALE'; // old or already-covered version: never roll the projection back
      version = last;
    } else if (blocking.min !== null && envelope.aggregateVersion > blocking.min) {
      // An earlier version of this aggregate is parked: keep order by parking behind it.
      return replay ? { kind: 'unresolved', reason: 'BLOCKED_BY_PARKED' }
        : park(tx, handler, envelope, 'BLOCKED_BY_PARKED', 0, null, source);
    } else if (envelope.aggregateVersion === last + 1) {
      await handler.apply(tx, envelope);
    } else if (handler.reconcile) {
      const current = await handler.reconcile(tx, envelope);
      if (!Number.isSafeInteger(current) || current < envelope.aggregateVersion) {
        throw new NonRetryableEventError('Reconciled snapshot is behind the event version');
      }
      outcome = 'RECONCILED';
      version = current;
    } else {
      return replay ? { kind: 'unresolved', reason: 'VERSION_GAP' }
        : park(tx, handler, envelope, 'VERSION_GAP', 0, null, source);
    }
    if (version > last) {
      await tx.query('UPDATE tpa.consumer_aggregate_positions SET last_version=$3 WHERE consumer_name=$1 AND aggregate_id=$2',
        [consumerName, envelope.aggregateId, version]);
    }
  } else {
    await handler.apply(tx, envelope);
  }
  await tx.query(`INSERT INTO tpa.consumer_inbox (tenant_id, consumer_name, event_id, event_type, aggregate_id,
      aggregate_version, outcome, replayed_from) VALUES (tpa.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7)`,
    [consumerName, envelope.eventId, envelope.eventType, envelope.aggregateId, envelope.aggregateVersion, outcome, replay?.parkedId ?? null]);
  const kind = outcome === 'APPLIED' ? 'applied' : outcome === 'RECONCILED' ? 'reconciled' : 'stale';
  return { kind, version };
}

/**
 * Live path: one tenant transaction = dedup check + ordering + effect + inbox row.
 * Throws on handler/database failure (nothing committed; caller retries or parks).
 * A concurrent duplicate that loses the inbox primary-key race rolls back its
 * effect and is reported as `duplicate`.
 */
export async function processInboxEvent(db: TenantDatabase, handler: InboxHandler, envelope: unknown,
  source?: RecordSource): Promise<InboxResult> {
  assertInboxHandler(handler);
  validateEventEnvelope(envelope);
  if (!handler.eventTypes.includes(envelope.eventType)) return { kind: 'ignored' };
  try {
    const decision = await db.withTenantTransaction(envelope.tenantId, tx => decide(tx, handler, envelope, source, undefined));
    if (decision.kind === 'unresolved') throw new Error('unreachable');
    return decision;
  } catch (error) {
    if (isInboxConflict(error)) return { kind: 'duplicate' };
    throw error;
  }
}

/** Park after retries are exhausted or a handler rejected the event. Idempotent. */
export async function parkInboxEvent(db: TenantDatabase, handler: InboxHandler, envelope: unknown, reason: ParkReason,
  attempts: number, error: unknown, source?: RecordSource): Promise<InboxResult> {
  assertInboxHandler(handler);
  validateEventEnvelope(envelope);
  return db.withTenantTransaction(envelope.tenantId, async tx => {
    const { rows } = await tx.query('SELECT 1 FROM tpa.consumer_inbox WHERE consumer_name=$1 AND event_id=$2',
      [handler.consumerName, envelope.eventId]);
    if (rows.length > 0) return { kind: 'duplicate' } as const; // another member applied it meanwhile
    return park(tx, handler, envelope, reason, attempts, safeErrorName(error), source);
  });
}

export interface QuarantineSink {
  /** Records coordinates + sha256 only; returns false if already quarantined. */
  quarantine(consumerName: string, source: RecordSource, raw: Buffer | null, reason: QuarantineReason): Promise<boolean>;
  close(): Promise<void>;
}
/** Poison records have no trustworthy tenant; this is the only tenant-less write path. */
export function createQuarantineSink(config: pg.PoolConfig): QuarantineSink {
  const pool = new pg.Pool({ ...config, max: 1 });
  return Object.freeze({
    async quarantine(consumerName: string, source: RecordSource, raw: Buffer | null, reason: QuarantineReason) {
      if (!CONSUMER_NAME.test(consumerName) || !/^\d{1,19}$/.test(source.offset)) throw new Error('Invalid quarantine coordinates');
      const sha = createHash('sha256').update(raw ?? Buffer.alloc(0)).digest('hex');
      const { rows: [row] } = await pool.query<{ role: string; inserted: boolean }>(
        'SELECT current_user AS role, tpa.quarantine_consumer_record($1, $2, $3, $4, $5, $6) AS inserted',
        [consumerName, source.topic, source.partition, source.offset, sha, reason]);
      if (row.role !== 'tpa_app') throw new Error('Quarantine requires the unprivileged tpa_app role');
      return row.inserted;
    },
    close: () => pool.end(),
  });
}

export interface OperatorAction { action: 'event.replay' | 'event.discard'; tenantId: string; consumerName: string; actorId: string }
/** Must resolve exactly `true` to allow. Supplied by the identity layer (AUTH-01) or ops tooling. */
export type ReplayAuthorizer = (request: Readonly<OperatorAction>) => Promise<boolean>;
export interface ParkedEventSummary {
  id: string; eventType: string; aggregateId: string; aggregateVersion: number; reasonCode: ParkReason;
  attempts: number; replayAttempts: number; errorName: string | null; parkedAt: string;
}
export interface ReplaySummary {
  applied: number; reconciled: number; stale: number; stillParked: number; failed: number; alreadyResolved: number;
}

async function authorizeOperator(authorize: ReplayAuthorizer, request: OperatorAction): Promise<void> {
  if (!UUID.test(request.tenantId) || !UUID.test(request.actorId) || !CONSUMER_NAME.test(request.consumerName)) {
    throw new ReplayDeniedError();
  }
  let allowed = false;
  try { allowed = typeof authorize === 'function' && (await authorize(Object.freeze({ ...request }))) === true; } catch { allowed = false; }
  if (!allowed) throw new ReplayDeniedError();
}
const resolutionHash = (id: string, status: string, resolution: string) =>
  createHash('sha256').update(`${id}|${status}|${resolution}`, 'utf8').digest('hex');

export async function listParkedEvents(db: TenantDatabase, tenantId: string, consumerName: string): Promise<ParkedEventSummary[]> {
  if (!CONSUMER_NAME.test(consumerName)) throw new Error('Invalid consumer name');
  return db.withTenantTransaction(tenantId, async tx => (await tx.query<ParkedEventSummary>(
    `SELECT id::text AS "id", event_type AS "eventType", aggregate_id::text AS "aggregateId", aggregate_version AS "aggregateVersion",
       reason_code AS "reasonCode", attempts, replay_attempts AS "replayAttempts", error_name AS "errorName",
       to_char(parked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "parkedAt"
     FROM tpa.consumer_parked_events WHERE consumer_name=$1 AND status='PARKED'
     ORDER BY aggregate_id, aggregate_version, parked_at`, [consumerName])).rows);
}

/**
 * Authorized, audited replay of parked events through the same pipeline, in
 * aggregate-version order. Each success resolves the parked row, writes the
 * inbox row and an audit entry in the same transaction as the effect, so
 * replaying again never repeats an effect. Failures stay parked (audited).
 */
export async function replayParkedEvents(db: TenantDatabase, handler: InboxHandler, tenantId: string,
  request: { actorId: string; parkedIds?: readonly string[]; limit?: number }, authorize: ReplayAuthorizer): Promise<ReplaySummary> {
  assertInboxHandler(handler);
  await authorizeOperator(authorize, { action: 'event.replay', tenantId, consumerName: handler.consumerName, actorId: request.actorId });
  const limit = request.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Replay limit must be 1..500');
  if (request.parkedIds && !request.parkedIds.every(id => UUID.test(id))) throw new Error('Invalid parked event id');
  const wanted = request.parkedIds ? new Set(request.parkedIds) : null;
  const ids = (await listParkedEvents(db, tenantId, handler.consumerName)).map(p => p.id).filter(id => !wanted || wanted.has(id)).slice(0, limit);
  const summary: ReplaySummary = { applied: 0, reconciled: 0, stale: 0, stillParked: 0, failed: 0, alreadyResolved: 0 };
  for (const parkedId of ids) {
    try {
      const decision = await db.withTenantTransaction(tenantId, async tx => {
        const { rows: [row] } = await tx.query<{ status: string; envelope: unknown }>(
          'SELECT status, envelope FROM tpa.consumer_parked_events WHERE id=$1 AND consumer_name=$2 FOR UPDATE',
          [parkedId, handler.consumerName]);
        if (!row || row.status !== 'PARKED') return { kind: 'resolved' } as const;
        validateEventEnvelope(row.envelope);
        const result = await decide(tx, handler, row.envelope, undefined, { parkedId, actorId: request.actorId });
        if (result.kind === 'unresolved' || result.kind === 'ignored' || result.kind === 'parked') return result;
        const resolution = result.kind === 'applied' ? 'APPLIED' : result.kind === 'reconciled' ? 'RECONCILED' : 'STALE';
        await tx.query(`UPDATE tpa.consumer_parked_events SET status='REPLAYED', resolved_by=$2, resolution=$3 WHERE id=$1`,
          [parkedId, request.actorId, resolution]);
        await appendAudit(tx, { entityType: 'PARKED_EVENT', entityId: parkedId, actorType: 'USER', actorId: request.actorId,
          action: 'EVENT_REPLAY', payload: { after_hash: resolutionHash(parkedId, 'REPLAYED', resolution) } });
        return result;
      });
      if (decision.kind === 'resolved') summary.alreadyResolved++;
      else if (decision.kind === 'applied') summary.applied++;
      else if (decision.kind === 'reconciled') summary.reconciled++;
      else if (decision.kind === 'stale' || decision.kind === 'duplicate') summary.stale++;
      else summary.stillParked++;
    } catch (error) {
      summary.failed++;
      if (error instanceof EventContractError) throw error; // stored envelope invalid: stop, operator must inspect
      await db.withTenantTransaction(tenantId, async tx => {
        const { rowCount } = await tx.query(`UPDATE tpa.consumer_parked_events SET replay_attempts = replay_attempts + 1, error_name=$2
          WHERE id=$1 AND status='PARKED'`, [parkedId, safeErrorName(error)]);
        if (rowCount === 1) {
          await appendAudit(tx, { entityType: 'PARKED_EVENT', entityId: parkedId, actorType: 'USER', actorId: request.actorId,
            action: 'EVENT_REPLAY_FAILED', payload: { after_hash: resolutionHash(parkedId, 'PARKED', safeErrorName(error)) } });
        }
      });
    }
  }
  return summary;
}

/** Authorized, audited decision not to apply a parked event (it is never retried). */
export async function discardParkedEvent(db: TenantDatabase, tenantId: string, consumerName: string, parkedId: string,
  actorId: string, authorize: ReplayAuthorizer): Promise<boolean> {
  await authorizeOperator(authorize, { action: 'event.discard', tenantId, consumerName, actorId });
  if (!UUID.test(parkedId)) throw new Error('Invalid parked event id');
  return db.withTenantTransaction(tenantId, async tx => {
    const { rowCount } = await tx.query(`UPDATE tpa.consumer_parked_events SET status='DISCARDED', resolved_by=$3, resolution='DISCARDED'
      WHERE id=$1 AND consumer_name=$2 AND status='PARKED'`, [parkedId, consumerName, actorId]);
    if (rowCount !== 1) return false;
    await appendAudit(tx, { entityType: 'PARKED_EVENT', entityId: parkedId, actorType: 'USER', actorId,
      action: 'EVENT_DISCARD', payload: { after_hash: resolutionHash(parkedId, 'DISCARDED', 'DISCARDED') } });
    return true;
  });
}
