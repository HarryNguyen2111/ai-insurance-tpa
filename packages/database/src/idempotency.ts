import { createHash, randomUUID } from 'node:crypto';
import type { TenantDatabase, TenantTransaction } from './tenant.ts';

/** Canonical request hash format; stored with every record. */
export const IDEMPOTENCY_HASH_VERSION = '1';
export const MIN_RETENTION_SECONDS = 86_400;
export const MAX_RETENTION_SECONDS = 7_776_000;
export const DEFAULT_LEASE_SECONDS = 30;
export const MAX_LEASE_SECONDS = 3_600;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type IdempotencyActorType = 'USER' | 'SERVICE' | 'SYSTEM';
/** Every field MUST come from the verified principal/route, never from the request body. */
export interface IdempotencyScope {
  /** OpenAPI operationId style, e.g. `createClaim`. */
  operation: string;
  actorType: IdempotencyActorType;
  /** Opaque internal UUID, never a name, phone or external identity. */
  actorId: string;
  /** Client `Idempotency-Key` (OpenAPI IdempotencyKeyValue). Never log it. */
  key: string;
}
export interface IdempotencyOptions {
  /** Response replay window; >= 24h per contract, <= 90 days. */
  retentionSeconds?: number;
  /** Ownership lease. A crashed owner is taken over only after it lapses. */
  leaseSeconds?: number;
}
/** Only deterministic outcomes are stored; 5xx/transient failures are never replayed. */
export interface IdempotentResponse { status: number; body: JsonValue }
export type BeginResult =
  | { kind: 'acquired'; ownerToken: string; attempt: number }
  | { kind: 'replayed'; response: IdempotentResponse }
  | { kind: 'conflict' }
  | { kind: 'expired' }
  | { kind: 'in_progress'; retryAfterSeconds: number };
export type IdempotentOutcome =
  | { kind: 'executed'; response: IdempotentResponse; attempt: number }
  | Exclude<BeginResult, { kind: 'acquired' }>;
export type IdempotentEffect = (tx: TenantTransaction, context: { attempt: number }) => Promise<IdempotentResponse>;

/** The caller no longer owns the attempt (lease taken over or record completed). Nothing was committed. */
export class IdempotencyOwnershipLostError extends Error {
  constructor() { super('Idempotency ownership lost; effect rolled back'); this.name = 'IdempotencyOwnershipLostError'; }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const keyPattern = /^[A-Za-z0-9._:-]{16,100}$/;
const operationPattern = /^[a-z][A-Za-z0-9]{0,79}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const MAX_DEPTH = 64;
// Values are never echoed: keys and payloads are client-controlled and may be sensitive.
function invalid(what: string): never { throw new Error(`Invalid idempotency ${what}`); }

/**
 * Canonical JSON v1: object keys sorted by UTF-16 code unit, no whitespace,
 * standard JSON string escaping (no Unicode normalisation), arrays in order.
 * Numbers must be safe integers: money and decimals travel as strings.
 * Rejects undefined, functions, symbols, bigint, sparse arrays and non-plain objects.
 */
export function canonicalJson(value: unknown, what = 'request', depth = 0): string {
  if (depth > MAX_DEPTH) invalid(what);
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': return JSON.stringify(value);
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) invalid(what);
      return String(value);
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + Array.from(value, item => canonicalJson(item, what, depth + 1)).join(',') + ']';
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) invalid(what);
      const keys = Reflect.ownKeys(value);
      if (keys.some(key => typeof key !== 'string')) invalid(what);
      return '{' + (keys as string[]).sort().map(key =>
        JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key], what, depth + 1)).join(',') + '}';
    }
    default: return invalid(what);
  }
}

/** SHA-256 over the versioned canonical request (body + route parameters chosen by the operation). */
export function requestHash(request: unknown): string {
  const canonical = canonicalJson({ request, version: IDEMPOTENCY_HASH_VERSION });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function validateIdempotencyScope(scope: IdempotencyScope): void {
  if (!scope || typeof scope.operation !== 'string' || !operationPattern.test(scope.operation)) invalid('operation');
  if (!['USER', 'SERVICE', 'SYSTEM'].includes(scope.actorType)) invalid('actor');
  if (typeof scope.actorId !== 'string' || !uuid.test(scope.actorId)) invalid('actor');
  if (typeof scope.key !== 'string' || !keyPattern.test(scope.key)) invalid('key');
}

export function normalizeIdempotencyOptions(options: IdempotencyOptions = {}): Required<IdempotencyOptions> {
  const retentionSeconds = options.retentionSeconds ?? MIN_RETENTION_SECONDS;
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  if (!Number.isSafeInteger(retentionSeconds) || retentionSeconds < MIN_RETENTION_SECONDS ||
      retentionSeconds > MAX_RETENTION_SECONDS) invalid('retention');
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > MAX_LEASE_SECONDS) invalid('lease');
  return { retentionSeconds, leaseSeconds };
}

/** Returns the canonical body text that will be stored (jsonb) and replayed. */
export function validateIdempotentResponse(response: IdempotentResponse): string {
  if (!response || typeof response !== 'object' || !Number.isInteger(response.status) ||
      response.status < 200 || response.status > 499) invalid('response');
  const body = canonicalJson(response.body, 'response');
  if (Buffer.byteLength(body, 'utf8') > 60_000) invalid('response');
  return body;
}

const where = `tenant_id = tpa.current_tenant_id() AND actor_type = $1 AND actor_id = $2
  AND operation = $3 AND idempotency_key = $4`;
const scopeValues = (scope: IdempotencyScope) => [scope.actorType, scope.actorId, scope.operation, scope.key];

interface RecordRow {
  request_hash_version: string; request_hash: string; state: 'IN_PROGRESS' | 'COMPLETED' | 'EXPIRED';
  response_status: number | null; response_body: JsonValue | null;
  lease_free: boolean; expired: boolean; retry_after: number | null;
}

/**
 * Claim, replay or reject inside the caller's tenant transaction. A concurrent
 * first insert of the same namespace waits on the uncommitted unique key.
 * Decision order: different hash -> conflict; expired -> expired;
 * completed -> replay; live lease -> in_progress; lapsed/released lease -> takeover.
 */
export async function beginIdempotent(tx: TenantTransaction, scope: IdempotencyScope, hash: string,
  options: IdempotencyOptions = {}): Promise<BeginResult> {
  validateIdempotencyScope(scope);
  if (typeof hash !== 'string' || !hashPattern.test(hash)) invalid('hash');
  const { retentionSeconds, leaseSeconds } = normalizeIdempotencyOptions(options);
  for (let round = 0; round < 3; round++) {
    const ownerToken = randomUUID();
    const inserted = await tx.query(`INSERT INTO tpa.idempotency_records (tenant_id, actor_type, actor_id,
        operation, idempotency_key, request_hash_version, request_hash, state, owner_token, lease_expires_at, expires_at)
      VALUES (tpa.current_tenant_id(), $1, $2, $3, $4, $5, $6, 'IN_PROGRESS', $7,
        now() + make_interval(secs => $8), now() + make_interval(secs => $9))
      ON CONFLICT ON CONSTRAINT idempotency_records_pkey DO NOTHING RETURNING attempt`,
    [...scopeValues(scope), IDEMPOTENCY_HASH_VERSION, hash, ownerToken, leaseSeconds, retentionSeconds]);
    if (inserted.rowCount === 1) return { kind: 'acquired', ownerToken, attempt: 1 };
    const { rows: [row] } = await tx.query<RecordRow>(`SELECT request_hash_version, request_hash, state,
        response_status, response_body,
        (owner_token IS NULL OR lease_expires_at <= now()) AS lease_free,
        (expires_at <= now()) AS expired,
        greatest(1, ceil(extract(epoch FROM lease_expires_at - now())))::int AS retry_after
      FROM tpa.idempotency_records WHERE ${where}`, scopeValues(scope));
    if (!row) continue;
    if (row.request_hash_version !== IDEMPOTENCY_HASH_VERSION || row.request_hash !== hash) return { kind: 'conflict' };
    if (row.state === 'EXPIRED' || row.expired) return { kind: 'expired' };
    if (row.state === 'COMPLETED') {
      return { kind: 'replayed', response: { status: row.response_status!, body: row.response_body! } };
    }
    if (!row.lease_free) return { kind: 'in_progress', retryAfterSeconds: row.retry_after ?? 1 };
    // Takeover waits for any owner still holding the row lock, then re-checks.
    const taken = await tx.query<{ attempt: number }>(`UPDATE tpa.idempotency_records
      SET owner_token = $5, lease_expires_at = now() + make_interval(secs => $6), attempt = attempt + 1
      WHERE ${where} AND state = 'IN_PROGRESS' AND request_hash = $7 AND expires_at > now()
        AND (owner_token IS NULL OR lease_expires_at <= now())
      RETURNING attempt`, [...scopeValues(scope), ownerToken, leaseSeconds, hash]);
    if (taken.rowCount === 1) return { kind: 'acquired', ownerToken, attempt: taken.rows[0].attempt };
  }
  throw new Error('Idempotency record changed concurrently; retry the request');
}

/**
 * Fenced effect: locks the caller's owned attempt, runs the effect in the SAME
 * transaction and stores the response. Commit makes effect + completion visible
 * atomically; any failure/crash before commit leaves neither.
 */
export async function runOwnedEffect(tx: TenantTransaction, scope: IdempotencyScope, ownerToken: string,
  attempt: number, effect: IdempotentEffect): Promise<IdempotentResponse> {
  validateIdempotencyScope(scope);
  if (typeof ownerToken !== 'string' || !uuid.test(ownerToken)) invalid('owner');
  const locked = await tx.query(`SELECT 1 FROM tpa.idempotency_records
    WHERE ${where} AND state = 'IN_PROGRESS' AND owner_token = $5 FOR UPDATE`, [...scopeValues(scope), ownerToken]);
  if (locked.rowCount !== 1) throw new IdempotencyOwnershipLostError();
  const response = await effect(tx, { attempt });
  const body = validateIdempotentResponse(response);
  const completed = await tx.query<{ response_status: number; response_body: JsonValue }>(`UPDATE tpa.idempotency_records
    SET state = 'COMPLETED', response_status = $6, response_body = $7::jsonb, completed_at = now(),
      owner_token = NULL, lease_expires_at = NULL
    WHERE ${where} AND state = 'IN_PROGRESS' AND owner_token = $5
    RETURNING response_status, response_body`, [...scopeValues(scope), ownerToken, response.status, body]);
  if (completed.rowCount !== 1) throw new IdempotencyOwnershipLostError();
  return { status: completed.rows[0].response_status, body: completed.rows[0].response_body };
}

/** Give up an owned attempt after a failure so a retry with the same payload may run at once. */
export async function releaseIdempotent(tx: TenantTransaction, scope: IdempotencyScope, ownerToken: string): Promise<boolean> {
  validateIdempotencyScope(scope);
  const released = await tx.query(`UPDATE tpa.idempotency_records SET owner_token = NULL, lease_expires_at = now()
    WHERE ${where} AND state = 'IN_PROGRESS' AND owner_token = $5`, [...scopeValues(scope), ownerToken]);
  return released.rowCount === 1;
}

/**
 * Retention: drop stored responses whose window ended. The namespace + hash stay
 * as a tombstone so the key keeps answering 409 instead of re-executing.
 * Live (leased) attempts are skipped; locked rows are left for the next batch.
 */
export async function expireIdempotencyRecords(tx: TenantTransaction, limit = 500): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) invalid('limit');
  const result = await tx.query(`WITH due AS (
      SELECT actor_type, actor_id, operation, idempotency_key FROM tpa.idempotency_records
      WHERE tenant_id = tpa.current_tenant_id() AND state <> 'EXPIRED' AND expires_at <= now()
        AND NOT (state = 'IN_PROGRESS' AND owner_token IS NOT NULL AND lease_expires_at > now())
      ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED)
    UPDATE tpa.idempotency_records r SET state = 'EXPIRED', response_status = NULL, response_body = NULL,
      owner_token = NULL, lease_expires_at = NULL
    FROM due WHERE r.tenant_id = tpa.current_tenant_id() AND r.actor_type = due.actor_type
      AND r.actor_id = due.actor_id AND r.operation = due.operation AND r.idempotency_key = due.idempotency_key`, [limit]);
  return result.rowCount ?? 0;
}

/**
 * Run a synthetic/domain effect at most once per namespace:
 * 1. short transaction claims ownership (or replays/rejects);
 * 2. second transaction locks ownership, runs effect, stores response, commits.
 * A thrown effect error rolls back and releases ownership, then rethrows.
 * The effect MUST only write through the provided transaction. Callers MUST
 * authenticate/authorize the request (including on replay) before calling.
 */
export async function executeIdempotent(db: TenantDatabase, tenantId: string, scope: IdempotencyScope,
  request: unknown, effect: IdempotentEffect, options: IdempotencyOptions = {}): Promise<IdempotentOutcome> {
  validateIdempotencyScope(scope);
  const normalized = normalizeIdempotencyOptions(options);
  const hash = requestHash(request);
  const begun = await db.withTenantTransaction(tenantId, tx => beginIdempotent(tx, scope, hash, normalized));
  if (begun.kind !== 'acquired') return begun;
  try {
    const response = await db.withTenantTransaction(tenantId,
      tx => runOwnedEffect(tx, scope, begun.ownerToken, begun.attempt, effect));
    return { kind: 'executed', response, attempt: begun.attempt };
  } catch (error) {
    if (!(error instanceof IdempotencyOwnershipLostError)) {
      // Best effort only: if this also fails (crash), lease expiry is the recovery path.
      try { await db.withTenantTransaction(tenantId, tx => releaseIdempotent(tx, scope, begun.ownerToken)); }
      catch { /* keep the original failure */ }
    }
    throw error;
  }
}
