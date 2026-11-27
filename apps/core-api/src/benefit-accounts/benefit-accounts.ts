import { createHash, randomUUID } from 'node:crypto';

/**
 * BEN-03 (#34) internal port: atomic benefit limit accounts, reservations and
 * immutable usage movements. No HTTP handler; callers (EOB publish, payment,
 * Temporal activities) supply the verified tenant and actor.
 *
 * Invariant: per account `used + reserved <= limit`, enforced by
 *  1. stable lock ordering (accounts `ORDER BY id FOR UPDATE`, always before reservations),
 *  2. conditional atomic UPDATE (`... WHERE used + reserved + amount <= limit`),
 *  3. a table CHECK constraint and a movement/account cross-check trigger.
 * Money: NUMERIC(15,2) strings only. JS never performs money arithmetic or
 * comparison; PostgreSQL NUMERIC does (Zero Float rule).
 */
export interface BenefitTransaction {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface BenefitDatabase {
  withTenantTransaction<T>(tenantId: string, work: (tx: BenefitTransaction) => Promise<T>): Promise<T>;
}
export type ChangeKind = 'ACCOUNT_OPENED' | 'RESERVED' | 'CONSUMED' | 'RELEASED' | 'EXPIRED';
export interface BenefitEventDraft {
  eventType: 'benefit.limit-changed'; aggregateId: string; aggregateVersion: number;
  correlationId: string; causationId: string; payload: { changeKind: ChangeKind; reservationId?: string };
}
/** Composition supplies `@tpa/database` appendOutboxEvent (same transaction). */
export type BenefitOutboxAppender = (tx: BenefitTransaction, draft: BenefitEventDraft) => Promise<unknown>;

export interface Actor { type: 'USER' | 'SERVICE' | 'SYSTEM'; id: string }
export interface Trace { correlationId: string; causationId: string }
/** Technical actor recorded for lazy/sweep expiry. Not a person. */
export const SYSTEM_EXPIRY_ACTOR: Actor = Object.freeze({ type: 'SYSTEM', id: '00000000-0000-4000-8000-00000000be03' });
export const MAX_TTL_SECONDS = 2_592_000;
export const MAX_ITEMS = 100;

export interface AccountView {
  accountId: string; memberId: string; planId: string; benefitType: string; limitGroup: 'ANNUAL';
  periodStart: string; periodEnd: string; clauseId: string; ruleVersionId: string;
  limitAmount: string; usedAmount: string; reservedAmount: string; availableAmount: string; version: number;
}
export type ReservationStatus = 'HELD' | 'CONSUMED' | 'RELEASED' | 'EXPIRED';
export interface ReservationView {
  reservationId: string; accountId: string; claimId: string; amount: string; consumedAmount: string;
  status: ReservationStatus; expiresAt: string; version: number;
}
export interface Shortfall { accountId: string; requestedAmount: string; availableAmount: string; clauseId: string }
export type AcquireResult =
  | { kind: 'RESERVED'; reservations: ReservationView[]; replayed: boolean }
  /** Not enough limit: nothing held. Caller routes review (PT03); never an inferred rejection. */
  | { kind: 'INSUFFICIENT_LIMIT'; shortfalls: Shortfall[]; replayed: boolean };
export type SettleResult =
  | { kind: 'APPLIED'; reservations: ReservationView[]; replayed: boolean }
  /** Some reservation is no longer HELD (expired/consumed/released): nothing changed for these items. */
  | { kind: 'NOT_ACTIVE'; reservations: { reservationId: string; status: ReservationStatus }[]; replayed: boolean };

export interface OpenAccountInput { coverageId: string; limitGroup: 'ANNUAL'; periodStart: string; periodEnd: string; trace: Trace }
export interface AcquireInput {
  operationKey: string; claimId: string; ttlSeconds: number; trace: Trace;
  holds: { accountId: string; amount: string }[];
}
export interface ConsumeInput { operationKey: string; trace: Trace; items: { reservationId: string; amount: string }[] }
export interface ReleaseInput { operationKey: string; trace: Trace; reservationIds: string[] }

export class BenefitInputError extends Error {
  constructor(field: string) { super(`Invalid benefit account input: ${field}`); this.name = 'BenefitInputError'; }
}
/** Same operation key reused with a different request (maps to 409). */
export class BenefitIdempotencyConflict extends Error {
  constructor() { super('Operation key reused with a different request'); this.name = 'BenefitIdempotencyConflict'; }
}
/** Not found or not visible to this tenant (RLS); never reveals which. */
export class BenefitNotFound extends Error {
  constructor() { super('Benefit account or reservation not found'); this.name = 'BenefitNotFound'; }
}
export class BenefitStateError extends Error {
  readonly code: 'CLAIM_ALREADY_RESERVED' | 'PERIOD_OVERLAP';
  constructor(code: BenefitStateError['code']) { super(`Benefit state conflict: ${code}`); this.name = 'BenefitStateError'; this.code = code; }
}
/** Defence-in-depth guard tripped; the transaction is rolled back. */
export class BenefitInvariantError extends Error {
  constructor() { super('Benefit limit invariant violated; rolled back'); this.name = 'BenefitInvariantError'; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONEY = /^(0|[1-9][0-9]{0,12})\.[0-9]{2}$/;
const KEY = /^[A-Za-z0-9._:-]{16,100}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value.toLowerCase())) throw new BenefitInputError(field);
  return value.toLowerCase();
}
/** Positive NUMERIC(15,2) string. Numbers, exponents, signs and other scales are rejected. */
export function positiveMoney(value: unknown, field: string): string {
  if (typeof value !== 'string' || !MONEY.test(value) || value === '0.00') throw new BenefitInputError(field);
  return value;
}
function operationKey(value: unknown): string {
  if (typeof value !== 'string' || !KEY.test(value)) throw new BenefitInputError('operationKey');
  return value;
}
function isoDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DATE.test(value)) throw new BenefitInputError(field);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new BenefitInputError(field);
  return value;
}
function actor(value: Actor): Actor {
  if (!value || !['USER', 'SERVICE', 'SYSTEM'].includes(value.type)) throw new BenefitInputError('actor');
  return { type: value.type, id: uuid(value.id, 'actor') };
}
function trace(value: Trace): Trace {
  if (!value) throw new BenefitInputError('trace');
  return { correlationId: uuid(value.correlationId, 'correlationId'), causationId: uuid(value.causationId, 'causationId') };
}
function items<T>(value: unknown, field: string): T[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ITEMS) throw new BenefitInputError(field);
  return value as T[];
}
/** Stable lock order: lowercase UUID text order equals PostgreSQL uuid order. */
export function lockOrder(ids: readonly string[], field: string): string[] {
  const sorted = [...ids].sort();
  if (sorted.some((id, i) => i > 0 && id === sorted[i - 1])) throw new BenefitInputError(`${field} duplicated`);
  return sorted;
}

type Canonical = string | number | Canonical[] | { [key: string]: Canonical };
export function canonicalJson(value: Canonical): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new BenefitInputError('canonical number');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
/** Request fingerprint for semantic idempotency (trace ids excluded: retries may differ). */
export function requestHash(type: string, who: Actor, body: Canonical): string {
  return sha256(canonicalJson({ v: '1', type, actor: { type: who.type, id: who.id }, body }));
}

const ACCOUNT_COLS = `a.id::text AS account_id, a.member_id::text AS member_id, a.plan_id::text AS plan_id, a.benefit_type,
  a.limit_group, to_char(a.period_start,'YYYY-MM-DD') AS period_start, to_char(a.period_end,'YYYY-MM-DD') AS period_end,
  a.clause_id::text AS clause_id, a.rule_version_id::text AS rule_version_id, a.limit_amount::text AS limit_amount,
  a.used_amount::text AS used_amount, a.reserved_amount::text AS reserved_amount,
  (a.limit_amount - a.used_amount - a.reserved_amount)::text AS available_amount, a.version`;
const RES_COLS = `r.id::text AS reservation_id, r.account_id::text AS account_id, r.claim_id::text AS claim_id,
  r.amount::text AS amount, r.consumed_amount::text AS consumed_amount, r.status,
  to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at, r.version`;

type Row = Record<string, unknown>;
const accountView = (r: Row): AccountView => ({
  accountId: r.account_id as string, memberId: r.member_id as string, planId: r.plan_id as string,
  benefitType: r.benefit_type as string, limitGroup: r.limit_group as 'ANNUAL', periodStart: r.period_start as string,
  periodEnd: r.period_end as string, clauseId: r.clause_id as string, ruleVersionId: r.rule_version_id as string,
  limitAmount: r.limit_amount as string, usedAmount: r.used_amount as string, reservedAmount: r.reserved_amount as string,
  availableAmount: r.available_amount as string, version: r.version as number,
});
const reservationView = (r: Row): ReservationView => ({
  reservationId: r.reservation_id as string, accountId: r.account_id as string, claimId: r.claim_id as string,
  amount: r.amount as string, consumedAmount: r.consumed_amount as string, status: r.status as ReservationStatus,
  expiresAt: r.expires_at as string, version: r.version as number,
});
const accountState = (a: AccountView): Canonical => ({
  accountId: a.accountId, limitAmount: a.limitAmount, usedAmount: a.usedAmount, reservedAmount: a.reservedAmount, version: a.version,
});

type Movement = 'RESERVE' | 'CONSUME' | 'RELEASE' | 'EXPIRE';
const KIND: Record<Movement, { change: ChangeKind; action: string; status: ReservationStatus }> = {
  RESERVE: { change: 'RESERVED', action: 'BENEFIT_RESERVED', status: 'HELD' },
  CONSUME: { change: 'CONSUMED', action: 'BENEFIT_CONSUMED', status: 'CONSUMED' },
  RELEASE: { change: 'RELEASED', action: 'BENEFIT_RELEASED', status: 'RELEASED' },
  EXPIRE: { change: 'EXPIRED', action: 'BENEFIT_EXPIRED', status: 'EXPIRED' },
};

export class BenefitAccountsService {
  private readonly db: BenefitDatabase;
  private readonly appendEvent: BenefitOutboxAppender;
  constructor(db: BenefitDatabase, appendEvent: BenefitOutboxAppender) { this.db = db; this.appendEvent = appendEvent; }

  /** Opens (idempotently) the contract-year account; limit and clause come from the approved rule version. */
  async openAccount(tenantId: string, who: Actor, input: OpenAccountInput): Promise<AccountView> {
    const by = actor(who), t = trace(input?.trace), coverageId = uuid(input.coverageId, 'coverageId');
    if (input.limitGroup !== 'ANNUAL') throw new BenefitInputError('limitGroup');
    const start = isoDate(input.periodStart, 'periodStart'), end = isoDate(input.periodEnd, 'periodEnd');
    if (end < start) throw new BenefitInputError('period');
    return this.db.withTenantTransaction(uuid(tenantId, 'tenantId'), async tx => {
      const { rows: [cov] } = await tx.query(`SELECT c.member_id::text AS member_id, c.plan_id::text AS plan_id, r.benefit_type
        FROM tpa.member_coverages c JOIN tpa.benefit_rule_versions r ON (r.tenant_id,r.id)=(c.tenant_id,c.rule_version_id)
        WHERE c.id=$1`, [coverageId]);
      if (!cov) throw new BenefitNotFound();
      // Serialize opening per account identity so overlap checks cannot race.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('benefit-account/' || tpa.current_tenant_id()::text
        || '/' || $1 || '/' || $2 || '/' || $3 || '/ANNUAL', 0))`, [cov.member_id, cov.plan_id, cov.benefit_type]);
      const { rows: existing } = await tx.query(`SELECT ${ACCOUNT_COLS} FROM tpa.benefit_accounts a
        WHERE a.member_id=$1 AND a.plan_id=$2 AND a.benefit_type=$3 AND a.limit_group='ANNUAL'
          AND a.period_start <= $5::date AND a.period_end >= $4::date`, [cov.member_id, cov.plan_id, cov.benefit_type, start, end]);
      if (existing.length) {
        const same = existing.length === 1 ? accountView(existing[0]) : undefined;
        if (same && same.periodStart === start && same.periodEnd === end) return same;
        throw new BenefitStateError('PERIOD_OVERLAP');
      }
      const { rows: [row] } = await tx.query(`INSERT INTO tpa.benefit_accounts AS a (tenant_id,id,member_id,plan_id,benefit_type,
          limit_group,period_start,period_end,coverage_id,rule_version_id,policy_version_id,clause_id,limit_amount)
        SELECT tpa.current_tenant_id(),$1,c.member_id,c.plan_id,r.benefit_type,'ANNUAL',$3::date,$4::date,c.id,r.id,
          c.policy_version_id,r.clause_id,r.annual_limit
        FROM tpa.member_coverages c JOIN tpa.benefit_rule_versions r ON (r.tenant_id,r.id)=(c.tenant_id,c.rule_version_id)
        WHERE c.id=$2 AND $3::date >= r.effective_from AND $4::date <= r.effective_to
          AND $4::date < $3::date + interval '1 year'
        RETURNING ${ACCOUNT_COLS}`, [randomUUID(), coverageId, start, end]);
      if (!row) throw new BenefitInputError('period');
      const account = accountView(row);
      await this.audit(tx, by, account.accountId, 'BENEFIT_ACCOUNT_OPENED', undefined, sha256(canonicalJson(accountState(account))));
      await this.event(tx, account, t, 'ACCOUNT_OPENED');
      return account;
    });
  }

  getAccount(tenantId: string, accountId: string): Promise<AccountView> {
    const id = uuid(accountId, 'accountId');
    return this.db.withTenantTransaction(uuid(tenantId, 'tenantId'), async tx => {
      const { rows: [row] } = await tx.query(`SELECT ${ACCOUNT_COLS} FROM tpa.benefit_accounts a WHERE a.id=$1`, [id]);
      if (!row) throw new BenefitNotFound();
      return accountView(row);
    });
  }

  /** All-or-nothing hold across one or more accounts for a claim. */
  async acquire(tenantId: string, who: Actor, input: AcquireInput): Promise<AcquireResult> {
    const by = actor(who), t = trace(input?.trace), key = operationKey(input.operationKey), claimId = uuid(input.claimId, 'claimId');
    if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > MAX_TTL_SECONDS) throw new BenefitInputError('ttlSeconds');
    const raw = items<{ accountId: string; amount: string }>(input.holds, 'holds')
      .map(h => ({ accountId: uuid(h?.accountId, 'accountId'), amount: positiveMoney(h?.amount, 'amount') }));
    const order = lockOrder(raw.map(h => h.accountId), 'accountId');
    const holds = order.map(id => raw.find(h => h.accountId === id)!);
    const hash = requestHash('ACQUIRE', by, { claimId, ttlSeconds: input.ttlSeconds, holds });
    return this.db.withTenantTransaction(uuid(tenantId, 'tenantId'), async tx => {
      const replay = await this.begin(tx, 'ACQUIRE', key, hash);
      if (replay) return { ...(replay as Omit<AcquireResult, 'replayed'>), replayed: true } as AcquireResult;
      await this.lockAccounts(tx, order);
      await this.expireOn(tx, order, t);
      const { rows: [dup] } = await tx.query(`SELECT count(*)::int AS n FROM tpa.benefit_reservations
        WHERE claim_id=$1 AND account_id = ANY($2::uuid[]) AND status='HELD'`, [claimId, order]);
      if ((dup.n as number) > 0) throw new BenefitStateError('CLAIM_ALREADY_RESERVED');
      const { rows: capacity } = await tx.query(`SELECT a.id::text AS account_id, x.amt::text AS requested_amount,
          (a.limit_amount - a.used_amount - a.reserved_amount)::text AS available_amount,
          (a.limit_amount - a.used_amount - a.reserved_amount) >= x.amt AS fits, a.clause_id::text AS clause_id
        FROM unnest($1::uuid[], $2::numeric[]) AS x(id, amt) JOIN tpa.benefit_accounts a ON a.id = x.id ORDER BY a.id`,
      [order, holds.map(h => h.amount)]);
      const short = capacity.filter(c => c.fits !== true);
      if (short.length) {
        const result = { kind: 'INSUFFICIENT_LIMIT' as const, shortfalls: short.map(c => ({ accountId: c.account_id as string,
          requestedAmount: c.requested_amount as string, availableAmount: c.available_amount as string, clauseId: c.clause_id as string })) };
        await this.finish(tx, key, result);
        return { ...result, replayed: false };
      }
      const reservations: ReservationView[] = [];
      for (const hold of holds) {
        const before = await this.account(tx, hold.accountId);
        // Conditional atomic update: a concurrent overspend can never commit, even without the lock.
        const { rows: [updated] } = await tx.query(`UPDATE tpa.benefit_accounts a SET reserved_amount = a.reserved_amount + $2::numeric,
            version = a.version + 1
          WHERE a.id=$1 AND a.used_amount + a.reserved_amount + $2::numeric <= a.limit_amount RETURNING ${ACCOUNT_COLS}`,
        [hold.accountId, hold.amount]);
        if (!updated) throw new BenefitInvariantError();
        const { rows: [res] } = await tx.query(`INSERT INTO tpa.benefit_reservations AS r
            (tenant_id,id,account_id,claim_id,amount,status,expires_at)
          VALUES (tpa.current_tenant_id(),$1,$2,$3,$4::numeric,'HELD',now() + make_interval(secs => $5))
          RETURNING ${RES_COLS}`, [randomUUID(), hold.accountId, claimId, hold.amount, input.ttlSeconds]);
        const reservation = reservationView(res);
        await this.record(tx, by, t, key, 'RESERVE', before, accountView(updated), reservation);
        reservations.push(reservation);
      }
      const result = { kind: 'RESERVED' as const, reservations };
      await this.finish(tx, key, result);
      return { ...result, replayed: false };
    });
  }

  /** Converts HELD reservations to usage; any unconsumed remainder is released in the same step. */
  async consume(tenantId: string, who: Actor, input: ConsumeInput): Promise<SettleResult> {
    const by = actor(who), t = trace(input?.trace), key = operationKey(input.operationKey);
    const raw = items<{ reservationId: string; amount: string }>(input.items, 'items')
      .map(i => ({ reservationId: uuid(i?.reservationId, 'reservationId'), amount: positiveMoney(i?.amount, 'amount') }));
    const ids = lockOrder(raw.map(i => i.reservationId), 'reservationId');
    const list = ids.map(id => raw.find(i => i.reservationId === id)!);
    const hash = requestHash('CONSUME', by, { items: list });
    return this.settle(tenantId, key, 'CONSUME', hash, ids, t, async (tx, held) => {
      const { rows: [over] } = await tx.query(`SELECT count(*)::int AS n FROM unnest($1::uuid[], $2::numeric[]) AS x(id, amt)
        JOIN tpa.benefit_reservations r ON r.id = x.id WHERE x.amt > r.amount`, [ids, list.map(i => i.amount)]);
      if ((over.n as number) > 0) throw new BenefitInputError('amount exceeds reservation');
      for (const item of list) await this.transition(tx, by, t, key, 'CONSUME', held.get(item.reservationId)!, item.amount);
    }, statuses => statuses.some(s => s !== 'HELD'));
  }

  /** Releases HELD reservations; already RELEASED/EXPIRED items are an idempotent no-op. */
  async release(tenantId: string, who: Actor, input: ReleaseInput): Promise<SettleResult> {
    const by = actor(who), t = trace(input?.trace), key = operationKey(input.operationKey);
    const ids = lockOrder(items<string>(input.reservationIds, 'reservationIds').map(id => uuid(id, 'reservationId')), 'reservationId');
    const hash = requestHash('RELEASE', by, { reservationIds: ids });
    return this.settle(tenantId, key, 'RELEASE', hash, ids, t, async (tx, held) => {
      for (const id of ids) {
        const r = held.get(id)!;
        if (r.status === 'HELD') await this.transition(tx, by, t, key, 'RELEASE', r, '0.00');
      }
    }, statuses => statuses.includes('CONSUMED'));
  }

  /** Sweeps due holds (Temporal timer / scheduled activity). Safe to repeat or run concurrently. */
  async expireDue(tenantId: string, input: { limit: number; trace: Trace }): Promise<number> {
    const t = trace(input?.trace);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) throw new BenefitInputError('limit');
    return this.db.withTenantTransaction(uuid(tenantId, 'tenantId'), async tx => {
      const { rows } = await tx.query(`SELECT DISTINCT d.account_id::text AS account_id FROM (SELECT account_id FROM tpa.benefit_reservations
        WHERE status='HELD' AND expires_at <= now() ORDER BY expires_at LIMIT $1) d`, [input.limit]);
      const order = lockOrder(rows.map(r => r.account_id as string), 'accountId');
      if (!order.length) return 0;
      await this.lockAccounts(tx, order);
      return this.expireOn(tx, order, t);
    });
  }

  private async settle(tenantId: string, key: string, type: 'CONSUME' | 'RELEASE', hash: string, ids: string[], t: Trace,
    apply: (tx: BenefitTransaction, held: Map<string, ReservationView>) => Promise<void>,
    blocked: (statuses: ReservationStatus[]) => boolean): Promise<SettleResult> {
    return this.db.withTenantTransaction(uuid(tenantId, 'tenantId'), async tx => {
      const replay = await this.begin(tx, type, key, hash);
      if (replay) return { ...(replay as Omit<SettleResult, 'replayed'>), replayed: true } as SettleResult;
      const { rows: found } = await tx.query('SELECT account_id::text AS account_id FROM tpa.benefit_reservations WHERE id = ANY($1::uuid[])', [ids]);
      if (found.length !== ids.length) throw new BenefitNotFound();
      const accounts = [...new Set(found.map(r => r.account_id as string))].sort();
      await this.lockAccounts(tx, accounts); // accounts first, always
      await this.expireOn(tx, accounts, t);
      const { rows } = await tx.query(`SELECT ${RES_COLS} FROM tpa.benefit_reservations r WHERE r.id = ANY($1::uuid[]) ORDER BY r.id FOR UPDATE`, [ids]);
      const held = new Map(rows.map(r => [r.reservation_id as string, reservationView(r)]));
      if (blocked([...held.values()].map(r => r.status))) {
        const result = { kind: 'NOT_ACTIVE' as const, reservations: ids.map(id => ({ reservationId: id, status: held.get(id)!.status })) };
        await this.finish(tx, key, result);
        return { ...result, replayed: false };
      }
      await apply(tx, held);
      const { rows: after } = await tx.query(`SELECT ${RES_COLS} FROM tpa.benefit_reservations r WHERE r.id = ANY($1::uuid[]) ORDER BY r.id`, [ids]);
      const result = { kind: 'APPLIED' as const, reservations: after.map(reservationView) };
      await this.finish(tx, key, result);
      return { ...result, replayed: false };
    });
  }

  /** Returns the stored result for a replay; throws on key reuse with a different request. */
  private async begin(tx: BenefitTransaction, type: string, key: string, hash: string): Promise<Row | null> {
    // A concurrent same-key request blocks here until the first commits/rolls back.
    const { rows: inserted } = await tx.query(`INSERT INTO tpa.benefit_operations (tenant_id,operation_key,operation_type,request_hash)
      VALUES (tpa.current_tenant_id(),$1,$2,$3) ON CONFLICT DO NOTHING RETURNING operation_key`, [key, type, hash]);
    if (inserted.length) return null;
    const { rows: [row] } = await tx.query('SELECT operation_type,request_hash,result FROM tpa.benefit_operations WHERE operation_key=$1', [key]);
    if (!row || row.operation_type !== type || row.request_hash !== hash || !row.result) throw new BenefitIdempotencyConflict();
    return row.result as Row;
  }
  private async finish(tx: BenefitTransaction, key: string, result: object): Promise<void> {
    await tx.query('UPDATE tpa.benefit_operations SET result=$2::jsonb WHERE operation_key=$1', [key, JSON.stringify(result)]);
  }
  private async lockAccounts(tx: BenefitTransaction, order: string[]): Promise<void> {
    const { rows } = await tx.query('SELECT a.id FROM tpa.benefit_accounts a WHERE a.id = ANY($1::uuid[]) ORDER BY a.id FOR UPDATE', [order]);
    if (rows.length !== order.length) throw new BenefitNotFound();
  }
  private async account(tx: BenefitTransaction, id: string): Promise<AccountView> {
    const { rows: [row] } = await tx.query(`SELECT ${ACCOUNT_COLS} FROM tpa.benefit_accounts a WHERE a.id=$1`, [id]);
    if (!row) throw new BenefitNotFound();
    return accountView(row);
  }
  /** Expires due HELD reservations on already-locked accounts. */
  private async expireOn(tx: BenefitTransaction, accounts: string[], t: Trace): Promise<number> {
    const { rows } = await tx.query(`SELECT ${RES_COLS} FROM tpa.benefit_reservations r WHERE r.account_id = ANY($1::uuid[])
      AND r.status='HELD' AND r.expires_at <= now() ORDER BY r.account_id, r.id FOR UPDATE`, [accounts]);
    for (const r of rows) await this.transition(tx, SYSTEM_EXPIRY_ACTOR, t, null, 'EXPIRE', reservationView(r), '0.00');
    return rows.length;
  }
  private async transition(tx: BenefitTransaction, by: Actor, t: Trace, key: string | null, type: Exclude<Movement, 'RESERVE'>,
    reservation: ReservationView, consumed: string): Promise<void> {
    const before = await this.account(tx, reservation.accountId);
    const { rows: [updated] } = await tx.query(`UPDATE tpa.benefit_accounts a SET reserved_amount = a.reserved_amount - $2::numeric,
        used_amount = a.used_amount + $3::numeric, version = a.version + 1
      WHERE a.id=$1 AND a.reserved_amount >= $2::numeric RETURNING ${ACCOUNT_COLS}`, [reservation.accountId, reservation.amount, consumed]);
    if (!updated) throw new BenefitInvariantError();
    const { rows: [res] } = await tx.query(`UPDATE tpa.benefit_reservations r SET status=$2, consumed_amount=$3::numeric, version = r.version + 1
      WHERE r.id=$1 AND r.status='HELD' RETURNING ${RES_COLS}`, [reservation.reservationId, KIND[type].status, consumed]);
    if (!res) throw new BenefitInvariantError();
    await this.record(tx, by, t, key, type, before, accountView(updated), reservationView(res));
  }
  /** Immutable movement + chained audit + outbox event, in the caller's transaction. */
  private async record(tx: BenefitTransaction, by: Actor, t: Trace, key: string | null, type: Movement,
    before: AccountView, after: AccountView, reservation: ReservationView): Promise<void> {
    // Deltas computed by PostgreSQL from the before/after rows (no JS money arithmetic).
    await tx.query(`INSERT INTO tpa.benefit_movements (tenant_id,id,account_id,reservation_id,operation_key,movement_type,
        reserved_delta,used_delta,reserved_after,used_after,account_version)
      VALUES (tpa.current_tenant_id(),$1,$2,$3,$4,$5,$7::numeric - $6::numeric,$9::numeric - $8::numeric,$7::numeric,$9::numeric,$10)`,
    [randomUUID(), after.accountId, reservation.reservationId, key, type, before.reservedAmount, after.reservedAmount,
      before.usedAmount, after.usedAmount, after.version]);
    const afterHash = sha256(canonicalJson({ account: accountState(after), movement: type,
      reservation: { reservationId: reservation.reservationId, claimId: reservation.claimId, amount: reservation.amount,
        consumedAmount: reservation.consumedAmount, status: reservation.status, version: reservation.version } }));
    await this.audit(tx, by, after.accountId, KIND[type].action, sha256(canonicalJson(accountState(before))), afterHash);
    await this.event(tx, after, t, KIND[type].change, reservation.reservationId);
  }
  private async audit(tx: BenefitTransaction, by: Actor, accountId: string, action: string, beforeHash: string | undefined, afterHash: string): Promise<void> {
    const payload: Record<string, string> = { after_hash: afterHash };
    if (beforeHash) payload.before_hash = beforeHash;
    await tx.query('SELECT * FROM tpa.append_audit($1,$2,$3,$4,$5,$6)',
      ['BENEFIT_ACCOUNT', accountId, by.type, by.id, action, JSON.stringify(payload)]);
  }
  private async event(tx: BenefitTransaction, account: AccountView, t: Trace, changeKind: ChangeKind, reservationId?: string): Promise<void> {
    await this.appendEvent(tx, { eventType: 'benefit.limit-changed', aggregateId: account.accountId, aggregateVersion: account.version,
      correlationId: t.correlationId, causationId: t.causationId, payload: reservationId ? { changeKind, reservationId } : { changeKind } });
  }
}
