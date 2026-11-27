import { createHash } from 'node:crypto';
import { UUID } from '../identity-tenant/identity-context.ts';
import { IdentityError } from '../identity-tenant/identity-error.ts';
import type { IdentityStore } from '../identity-tenant/identity-store.ts';
import type { AuthorizedActor, IdentityTransaction } from '../identity-tenant/identity.types.ts';
import type { VerifiedIdentity } from '../identity-tenant/oidc-verifier.ts';
import type { JsonValue, WorkflowRuntime } from '../workflow-definition/workflow-runtime.ts';

/**
 * NOTIF-01 (#107) inbox reads and read-state. One explicit scope per call; never a mixed or all-tenant inbox.
 *  - TENANT: IdentityStore.withMembership re-authorizes the current membership on every call (revoked 403,
 *    stale 409) inside withTenantTransaction (SET LOCAL, FORCE RLS). RLS additionally requires the recipient
 *    principal and an ACTIVE recipient membership. First read transitions are audited.
 *  - PERSONAL: IdentityStore.withPrincipal, principal-scoped RLS, no tenant context. Read-state is recipient
 *    UI state (controller D2), not a tenant audit event. No producer exists yet (Loyalty360 gap).
 * Reading never signs OTP, approves an EOB, accepts consent or advances a claim.
 */
export type NotificationScope = 'PERSONAL' | 'TENANT';
export interface NotificationCall { identity: VerifiedIdentity; membershipContext?: string }
export interface NotificationsApi {
  list(call: NotificationCall, query: unknown): Promise<JsonValue>;
  unreadCount(call: NotificationCall, query: unknown): Promise<JsonValue>;
  markRead(call: NotificationCall, notificationId: string, body: unknown): Promise<JsonValue>;
  markAllRead(call: NotificationCall, body: unknown): Promise<JsonValue>;
}

const SERVICES = ['TPA_INSURANCE', 'LOYALTY360'] as const;
type Service = typeof SERVICES[number];
const SCOPES: readonly NotificationScope[] = ['PERSONAL', 'TENANT'];
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const UNREAD_CAP = 999;
const invalid = () => new IdentityError(422, 'VALIDATION_FAILED');
const hidden = () => new IdentityError(404, 'NOT_FOUND');

/** Microsecond UTC ISO-8601: stable cursor positions and an exact read-all cutoff. */
const ts = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const COLUMNS = `n.id::text AS id, n.service, n.category, n.priority, n.template_key, n.template_version, n.title_vi, n.body_vi,
  n.target_kind, n.target_id::text AS target_id, ${ts('n.occurred_at')} AS occurred_at, ${ts('n.created_at')} AS created_at,
  ${ts('n.expires_at')} AS expires_at, ${ts('n.read_at')} AS read_at, n.version`;
interface Row {
  id: string; service: Service; category: string; priority: string; template_key: string; template_version: number;
  title_vi: string; body_vi: string; target_kind: string | null; target_id: string | null;
  occurred_at: string; created_at: string; expires_at: string; read_at: string | null; version: number;
}
function view(scope: NotificationScope, r: Row): JsonValue {
  return { notificationId: r.id, scope, service: r.service, category: r.category, priority: r.priority,
    templateKey: r.template_key, templateVersion: r.template_version, titleVi: r.title_vi, bodyVi: r.body_vi,
    ...(r.target_kind && r.target_id ? { target: { kind: r.target_kind, id: r.target_id } } : {}),
    occurredAt: r.occurred_at, createdAt: r.created_at, expiresAt: r.expires_at,
    ...(r.read_at ? { readAt: r.read_at } : {}), version: r.version };
}

interface Filter { scope: NotificationScope; service?: Service }
interface ListQuery extends Filter { status: 'UNREAD' | 'ALL'; limit: number; cursor?: string }
/** OpenAPI allowlist: unknown/repeated keys and invalid values are 422; nothing is echoed. */
function parseQuery(raw: unknown, allowed: readonly string[]): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.some(([k, v]) => !allowed.includes(k) || typeof v !== 'string')) throw invalid();
  return raw as Record<string, string>;
}
function parseFilter(q: Record<string, string | undefined>): Filter {
  if (!SCOPES.includes(q.scope as NotificationScope)) throw invalid();
  if (q.service !== undefined && !SERVICES.includes(q.service as Service)) throw invalid();
  return { scope: q.scope as NotificationScope, ...(q.service ? { service: q.service as Service } : {}) };
}
export function parseListQuery(raw: unknown): ListQuery {
  const q = parseQuery(raw, ['scope', 'service', 'status', 'cursor', 'limit']);
  const query: ListQuery = { ...parseFilter(q), status: 'ALL', limit: 20 };
  if (q.status !== undefined) { if (q.status !== 'UNREAD' && q.status !== 'ALL') throw invalid(); query.status = q.status; }
  if (q.limit !== undefined) {
    if (!/^[1-9][0-9]?$/.test(q.limit) || Number(q.limit) > 50) throw invalid();
    query.limit = Number(q.limit);
  }
  if (q.cursor !== undefined) { if (q.cursor.length < 1 || q.cursor.length > 2048) throw invalid(); query.cursor = q.cursor; }
  return query;
}
export function parseCountQuery(raw: unknown): Filter { return parseFilter(parseQuery(raw, ['scope', 'service'])); }

/** Binds the opaque cursor to principal, scope, membership and filters (not page size). Not a capability. */
function binding(principalId: string, membershipId: string | null, q: ListQuery): string {
  return createHash('sha256').update(JSON.stringify(['notifications-list-v1', principalId, q.scope, membershipId, q.service ?? null, q.status])).digest('hex');
}
export function encodeCursor(principalId: string, membershipId: string | null, q: ListQuery, createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([1, binding(principalId, membershipId, q), createdAt, id])).toString('base64url');
}
export function decodeCursor(principalId: string, membershipId: string | null, q: ListQuery): { createdAt: string; id: string } | undefined {
  if (q.cursor === undefined) return undefined;
  let data: unknown;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(q.cursor)) throw new Error('format');
    data = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8'));
  } catch { throw invalid(); }
  if (!Array.isArray(data) || data.length !== 4 || data[0] !== 1 || data[1] !== binding(principalId, membershipId, q)
    || typeof data[2] !== 'string' || !TIMESTAMP.test(data[2]) || typeof data[3] !== 'string' || !UUID.test(data[3])) throw invalid();
  return { createdAt: data[2], id: data[3] };
}

/** Scope selection: TENANT needs the membership context, PERSONAL must not carry one (contract 1.5.0). */
interface Scoped { tx: IdentityTransaction; principalId: string; actor?: AuthorizedActor; table: string; owner: string; ownerValue: string }
export class NotificationsStore implements NotificationsApi {
  private readonly identity: IdentityStore; private readonly runtime: WorkflowRuntime;
  constructor(identity: IdentityStore, runtime: WorkflowRuntime) { this.identity = identity; this.runtime = runtime; }

  private inScope<T>(call: NotificationCall, scope: NotificationScope, fn: (s: Scoped) => Promise<T>): Promise<T> {
    if (scope === 'TENANT') {
      if (!call.membershipContext) return Promise.reject(invalid());
      return this.identity.withMembership(call.identity, call.membershipContext, (tx, actor) => fn({ tx, principalId: actor.principalId, actor,
        // Recipient membership AND principal are both bound; RLS repeats the principal/active-membership checks.
        table: 'tpa.tenant_notifications', owner: 'n.recipient_membership_id=$1 AND n.recipient_principal_id=$2', ownerValue: actor.membershipId }));
    }
    if (call.membershipContext !== undefined) return Promise.reject(invalid());
    return this.identity.withPrincipal(call.identity, (tx, principalId) => fn({ tx, principalId,
      table: 'tpa.personal_notifications', owner: '$1::uuid IS NULL AND n.recipient_principal_id=$2', ownerValue: null as unknown as string }));
  }

  list(call: NotificationCall, raw: unknown): Promise<JsonValue> {
    const query = parseListQuery(raw);
    return this.inScope(call, query.scope, async s => {
      const membershipId = s.actor?.membershipId ?? null;
      const position = decodeCursor(s.principalId, membershipId, query);
      const { rows } = await s.tx.query<Row & { as_of: string }>(`SELECT ${COLUMNS}, ${ts('statement_timestamp()')} AS as_of
        FROM ${s.table} n WHERE ${s.owner} AND n.expires_at > statement_timestamp()
          AND ($3::text IS NULL OR n.service=$3) AND (NOT $4::boolean OR n.read_at IS NULL)
          AND ($5::timestamptz IS NULL OR (n.created_at,n.id) < ($5::timestamptz,$6::uuid))
        ORDER BY n.created_at DESC, n.id DESC LIMIT $7`,
      [s.ownerValue, s.principalId, query.service ?? null, query.status === 'UNREAD', position?.createdAt ?? null, position?.id ?? null, query.limit + 1]);
      const { rows: [clock] } = rows.length ? { rows: [{ as_of: rows[0].as_of }] } : await s.tx.query<{ as_of: string }>(`SELECT ${ts('statement_timestamp()')} AS as_of`);
      const items = rows.slice(0, query.limit), last = items.at(-1);
      return { scope: query.scope, items: items.map(r => view(query.scope, r)), asOf: clock.as_of,
        ...(rows.length > query.limit && last ? { nextCursor: encodeCursor(s.principalId, membershipId, query, last.created_at, last.id) } : {}) };
    });
  }

  unreadCount(call: NotificationCall, raw: unknown): Promise<JsonValue> {
    const filter = parseCountQuery(raw);
    return this.inScope(call, filter.scope, async s => {
      // Bounded, index-backed count of exactly the rows list(status=UNREAD) returns.
      const { rows: [r] } = await s.tx.query<{ n: number; as_of: string }>(`SELECT (SELECT count(*)::int FROM (SELECT 1 FROM ${s.table} n
          WHERE ${s.owner} AND n.read_at IS NULL AND n.expires_at > statement_timestamp() AND ($3::text IS NULL OR n.service=$3) LIMIT ${UNREAD_CAP}) c) AS n,
        ${ts('statement_timestamp()')} AS as_of`, [s.ownerValue, s.principalId, filter.service ?? null]);
      return { scope: filter.scope, ...(filter.service ? { service: filter.service } : {}), unreadCount: r.n, capped: r.n >= UNREAD_CAP, asOf: r.as_of };
    });
  }

  markRead(call: NotificationCall, notificationId: string, body: unknown): Promise<JsonValue> {
    if (!this.runtime.validateContract('NotificationReadRequest', body)) return Promise.reject(invalid());
    if (!UUID.test(notificationId)) return Promise.reject(hidden());
    const scope = (body as { scope: NotificationScope }).scope;
    return this.inScope(call, scope, async s => {
      // Conditional transition: concurrent/cross-device repeats block on the row lock, re-check read_at and update nothing.
      const { rowCount } = await s.tx.query(`UPDATE ${s.table} n SET read_at=clock_timestamp(), version=n.version+1
        WHERE n.id=$3 AND ${s.owner} AND n.read_at IS NULL AND n.expires_at > clock_timestamp()`, [s.ownerValue, s.principalId, notificationId]);
      const { rows: [row] } = await s.tx.query<Row>(`SELECT ${COLUMNS} FROM ${s.table} n
        WHERE n.id=$3 AND ${s.owner} AND n.expires_at > clock_timestamp()`, [s.ownerValue, s.principalId, notificationId]);
      if (!row) throw hidden();
      if (rowCount === 1 && s.actor) {
        await this.runtime.appendAudit(s.tx, { entityType: 'NOTIFICATION', entityId: row.id, actorType: 'USER', actorId: s.principalId,
          action: 'NOTIFICATION_READ', payload: { after_hash: this.runtime.requestHash({ notificationId: row.id, version: row.version, readAt: row.read_at }) } });
      }
      return view(scope, row);
    });
  }

  markAllRead(call: NotificationCall, body: unknown): Promise<JsonValue> {
    if (!this.runtime.validateContract('NotificationReadAllRequest', body)) return Promise.reject(invalid());
    const b = body as { scope: NotificationScope; service?: Service; cutoff: string };
    return this.inScope(call, b.scope, async s => {
      const { rows: [check] } = await s.tx.query<{ ok: boolean }>('SELECT $1::timestamptz <= clock_timestamp() AS ok', [b.cutoff]);
      if (!check.ok) throw invalid(); // a future cutoff could clear notifications the user has not seen
      // Only this scope/membership/service, only rows created at or before the cutoff: concurrent new events stay unread.
      const { rows } = await s.tx.query<{ id: string }>(`UPDATE ${s.table} n SET read_at=clock_timestamp(), version=n.version+1
        WHERE ${s.owner} AND n.read_at IS NULL AND n.expires_at > clock_timestamp() AND n.created_at <= $3::timestamptz
          AND ($4::text IS NULL OR n.service=$4) RETURNING n.id::text AS id`, [s.ownerValue, s.principalId, b.cutoff, b.service ?? null]);
      if (rows.length > 0 && s.actor) {
        await this.runtime.appendAudit(s.tx, { entityType: 'NOTIFICATION_INBOX', entityId: s.actor.membershipId, actorType: 'USER', actorId: s.principalId,
          action: 'NOTIFICATION_READ_ALL', payload: { after_hash: this.runtime.requestHash({ cutoff: b.cutoff, service: b.service ?? null,
            notificationIds: rows.map(r => r.id).sort() }) } });
      }
      return { scope: b.scope, ...(b.service ? { service: b.service } : {}), cutoff: b.cutoff, markedCount: rows.length };
    });
  }
}
