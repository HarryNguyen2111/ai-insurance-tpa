import { createHash, randomUUID } from 'node:crypto';

/**
 * PAY-01 (#44) internal port: balanced immutable double-entry journal and protected
 * float balances. No HTTP handler; callers (payment intents, reconciliation, Temporal
 * activities) supply the verified tenant and actor. Synthetic funds only, no payout.
 *
 * Invariants (migration 0014 enforces them even for raw SQL by tpa_app):
 *  - every entry has >= 2 lines and SUM(debit) = SUM(credit) per currency, checked at COMMIT;
 *  - posted entries/lines are append-only; corrections are a mirrored REVERSAL entry only;
 *  - account balances move only via journal-line triggers under the account row lock with
 *    CHECK (balance >= 0), so concurrent postings can never overdraw a float;
 *  - posted journal lines are the reconciliation source of truth (`reconcile`).
 * This service additionally locks accounts in a stable order (`ORDER BY id FOR UPDATE`),
 * returns INSUFFICIENT_FUNDS without posting, and writes journal + balances + chained
 * audit + outbox in one tenant transaction.
 * Money: NUMERIC(15,2) strings only. JS never does money arithmetic or comparison;
 * PostgreSQL NUMERIC does (Zero Float rule).
 */
export interface LedgerTransaction {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface LedgerDatabase {
  withTenantTransaction<T>(tenantId: string, work: (tx: LedgerTransaction) => Promise<T>): Promise<T>;
}
export type AccountPurpose = 'INSURER_FLOAT' | 'SETTLEMENT_BANK' | 'PAYOUT_CLEARING';
export type Side = 'DEBIT' | 'CREDIT';
export type PostableEntryType = 'FLOAT_TOPUP' | 'PAYOUT_COMMIT' | 'PAYOUT_SETTLE';
export type EntryType = PostableEntryType | 'REVERSAL';
export type LedgerChangeKind = 'ACCOUNT_OPENED' | 'JOURNAL_POSTED';

export interface LedgerEventDraft {
  eventType: 'ledger.account-changed'; aggregateId: string; aggregateVersion: number;
  correlationId: string; causationId: string;
  payload: { changeKind: LedgerChangeKind; entryId?: string; entryType?: EntryType; reversesEntryId?: string };
}
/** Composition supplies `@tpa/database` appendOutboxEvent (same transaction). */
export type LedgerOutboxAppender = (tx: LedgerTransaction, draft: LedgerEventDraft) => Promise<unknown>;

export interface Actor { type: 'USER' | 'SERVICE' | 'SYSTEM'; id: string }
export interface Trace { correlationId: string; causationId: string }
export const PURPOSES: readonly AccountPurpose[] = Object.freeze(['INSURER_FLOAT', 'SETTLEMENT_BANK', 'PAYOUT_CLEARING']);
export const POSTABLE_TYPES: readonly PostableEntryType[] = Object.freeze(['FLOAT_TOPUP', 'PAYOUT_COMMIT', 'PAYOUT_SETTLE']);
/** Phase 1 contracts are VND only; the schema itself checks balance per currency. */
export const SUPPORTED_CURRENCIES: readonly string[] = Object.freeze(['VND']);
export const MAX_LINES = 100;

export interface LedgerAccountView {
  accountId: string; purpose: AccountPurpose; currency: string; normalSide: Side;
  balance: string; debitTotal: string; creditTotal: string; version: number;
}
export interface JournalLineView {
  lineNo: number; accountId: string; currency: string; side: Side; amount: string; balanceAfter: string; accountVersion: number;
}
export interface JournalEntryView {
  entryId: string; entryType: EntryType; status: 'POSTED'; reversesEntryId: string | null; reasonCode: string | null;
  claimId: string | null; paymentId: string | null; postedAt: string; lines: JournalLineView[];
}
export interface FundsShortfall { accountId: string; purpose: AccountPurpose; currency: string; availableBalance: string; requestedAmount: string }
export type PostResult =
  | { kind: 'POSTED'; entry: JournalEntryView; replayed: boolean }
  /** Nothing posted and the key is not consumed: retry with the same key after funding. */
  | { kind: 'INSUFFICIENT_FUNDS'; shortfalls: FundsShortfall[]; replayed: false };

export interface LineInput { accountId: string; side: Side; amount: string }
export interface OpenAccountInput { purpose: AccountPurpose; currency: string; trace: Trace }
export interface PostInput {
  idempotencyKey: string; entryType: PostableEntryType; claimId?: string; paymentId?: string; trace: Trace; lines: LineInput[];
}
export interface ReverseInput { idempotencyKey: string; entryId: string; reasonCode: string; trace: Trace }

export interface AccountReconciliation {
  accountId: string; purpose: AccountPurpose; currency: string; balance: string; journalBalance: string;
  debitTotal: string; journalDebits: string; creditTotal: string; journalCredits: string;
  version: number; lineCount: number; matches: boolean;
}
export interface CurrencyTrialBalance { currency: string; debitTotal: string; creditTotal: string; balanced: boolean }
export interface ReconciliationReport {
  consistent: boolean; accounts: AccountReconciliation[]; currencies: CurrencyTrialBalance[]; unbalancedEntries: number;
}

export class LedgerInputError extends Error {
  constructor(field: string) { super(`Invalid ledger input: ${field}`); this.name = 'LedgerInputError'; }
}
/** Same idempotency key reused with a different request (maps to 409). */
export class LedgerIdempotencyConflict extends Error {
  constructor() { super('Idempotency key reused with a different request'); this.name = 'LedgerIdempotencyConflict'; }
}
/** Not found or not visible to this tenant (RLS); never reveals which. */
export class LedgerNotFound extends Error {
  constructor() { super('Ledger account or journal entry not found'); this.name = 'LedgerNotFound'; }
}
export class LedgerStateError extends Error {
  readonly code: 'ALREADY_REVERSED' | 'NOT_REVERSIBLE';
  constructor(code: LedgerStateError['code']) { super(`Ledger state conflict: ${code}`); this.name = 'LedgerStateError'; this.code = code; }
}
/** A database ledger constraint (balance, overdraw, immutability) tripped; everything rolled back. */
export class LedgerInvariantError extends Error {
  constructor(options?: { cause?: unknown }) { super('Ledger invariant violated; rolled back', options); this.name = 'LedgerInvariantError'; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONEY = /^(0|[1-9][0-9]{0,12})\.[0-9]{2}$/;
const KEY = /^[A-Za-z0-9._:-]{16,100}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,39}$/;

export function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value.toLowerCase())) throw new LedgerInputError(field);
  return value.toLowerCase();
}
/** Positive NUMERIC(15,2) string. Numbers, exponents, signs and other scales are rejected. */
export function positiveMoney(value: unknown, field: string): string {
  if (typeof value !== 'string' || !MONEY.test(value) || value === '0.00') throw new LedgerInputError(field);
  return value;
}
function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !KEY.test(value)) throw new LedgerInputError('idempotencyKey');
  return value;
}
function optionalUuid(value: unknown, field: string): string | null {
  return value === undefined || value === null ? null : uuid(value, field);
}
function actor(value: Actor): Actor {
  if (!value || !['USER', 'SERVICE', 'SYSTEM'].includes(value.type)) throw new LedgerInputError('actor');
  return { type: value.type, id: uuid(value.id, 'actor') };
}
function trace(value: Trace): Trace {
  if (!value) throw new LedgerInputError('trace');
  return { correlationId: uuid(value.correlationId, 'correlationId'), causationId: uuid(value.causationId, 'causationId') };
}

/**
 * Validates and canonicalizes lines: 2..MAX_LINES, each account at most once (so each posting
 * moves an account by exactly one version), sorted by account id (stable lock order).
 */
export function normalizeLines(value: unknown): LineInput[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_LINES) throw new LedgerInputError('lines');
  const lines = value.map((l: Partial<LineInput>) => {
    if (!l || (l.side !== 'DEBIT' && l.side !== 'CREDIT')) throw new LedgerInputError('side');
    return { accountId: uuid(l.accountId, 'accountId'), side: l.side, amount: positiveMoney(l.amount, 'amount') };
  }).sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
  if (lines.some((l, i) => i > 0 && l.accountId === lines[i - 1].accountId)) throw new LedgerInputError('accountId duplicated');
  if (!lines.some(l => l.side === 'DEBIT') || !lines.some(l => l.side === 'CREDIT')) throw new LedgerInputError('lines need both sides');
  return lines;
}

type Canonical = string | number | null | Canonical[] | { [key: string]: Canonical };
export function canonicalJson(value: Canonical): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new LedgerInputError('canonical number');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
/** Request fingerprint for semantic idempotency (trace ids excluded: retries may differ). */
export function requestHash(type: 'POST' | 'REVERSE', who: Actor, body: Canonical): string {
  return sha256(canonicalJson({ v: '1', type, actor: { type: who.type, id: who.id }, body }));
}

const ACCOUNT_COLS = `a.id::text AS account_id, a.purpose, a.currency::text AS currency, a.normal_side, a.balance::text AS balance,
  a.debit_total::text AS debit_total, a.credit_total::text AS credit_total, a.version`;
const ENTRY_COLS = `e.id::text AS entry_id, e.entry_type, e.status, e.reverses_entry_id::text AS reverses_entry_id, e.reason_code,
  e.claim_id::text AS claim_id, e.payment_id::text AS payment_id, e.request_hash,
  to_char(e.posted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS posted_at`;
const LINE_COLS = `l.line_no, l.account_id::text AS account_id, l.currency::text AS currency, l.side, l.amount::text AS amount,
  l.balance_after::text AS balance_after, l.account_version`;

type Row = Record<string, unknown>;
const accountView = (r: Row): LedgerAccountView => ({
  accountId: r.account_id as string, purpose: r.purpose as AccountPurpose, currency: r.currency as string,
  normalSide: r.normal_side as Side, balance: r.balance as string, debitTotal: r.debit_total as string,
  creditTotal: r.credit_total as string, version: r.version as number,
});
const lineView = (r: Row): JournalLineView => ({
  lineNo: r.line_no as number, accountId: r.account_id as string, currency: r.currency as string, side: r.side as Side,
  amount: r.amount as string, balanceAfter: r.balance_after as string, accountVersion: r.account_version as number,
});
const accountState = (a: LedgerAccountView): Canonical => ({
  accountId: a.accountId, purpose: a.purpose, currency: a.currency, balance: a.balance,
  debitTotal: a.debitTotal, creditTotal: a.creditTotal, version: a.version,
});
const entryState = (e: JournalEntryView): Canonical => ({
  entryId: e.entryId, entryType: e.entryType, status: e.status, reversesEntryId: e.reversesEntryId, reasonCode: e.reasonCode,
  claimId: e.claimId, paymentId: e.paymentId, postedAt: e.postedAt,
  lines: e.lines.map(l => ({ lineNo: l.lineNo, accountId: l.accountId, currency: l.currency, side: l.side, amount: l.amount,
    balanceAfter: l.balanceAfter, accountVersion: l.accountVersion })),
});

interface EntryDraft {
  entryType: EntryType; reversesEntryId: string | null; reasonCode: string | null; claimId: string | null;
  paymentId: string | null; key: string; hash: string; lines: LineInput[];
}

export class LedgerService {
  private readonly db: LedgerDatabase;
  private readonly appendEvent: LedgerOutboxAppender;
  constructor(db: LedgerDatabase, appendEvent: LedgerOutboxAppender) { this.db = db; this.appendEvent = appendEvent; }

  /** Opens (idempotently) the tenant's account for a purpose and currency, at zero balance. */
  async openAccount(tenantId: string, who: Actor, input: OpenAccountInput): Promise<LedgerAccountView> {
    const by = actor(who), t = trace(input?.trace);
    if (!PURPOSES.includes(input.purpose)) throw new LedgerInputError('purpose');
    if (!SUPPORTED_CURRENCIES.includes(input.currency)) throw new LedgerInputError('currency');
    return this.run(tenantId, async tx => {
      const { rows: [row] } = await tx.query(`INSERT INTO tpa.ledger_accounts AS a (tenant_id,id,purpose,currency,normal_side)
        VALUES (tpa.current_tenant_id(),$1,$2,$3,'-') ON CONFLICT (tenant_id,purpose,currency) DO NOTHING RETURNING ${ACCOUNT_COLS}`,
      [randomUUID(), input.purpose, input.currency]);
      if (!row) {
        const { rows: [existing] } = await tx.query(`SELECT ${ACCOUNT_COLS} FROM tpa.ledger_accounts a WHERE a.purpose=$1 AND a.currency=$2`,
          [input.purpose, input.currency]);
        return accountView(existing);
      }
      const account = accountView(row);
      await this.audit(tx, by, 'LEDGER_ACCOUNT', account.accountId, 'LEDGER_ACCOUNT_OPENED', undefined, sha256(canonicalJson(accountState(account))));
      await this.event(tx, account, t, { changeKind: 'ACCOUNT_OPENED' });
      return account;
    });
  }

  getAccount(tenantId: string, accountId: string): Promise<LedgerAccountView> {
    const id = uuid(accountId, 'accountId');
    return this.run(tenantId, async tx => {
      const { rows: [row] } = await tx.query(`SELECT ${ACCOUNT_COLS} FROM tpa.ledger_accounts a WHERE a.id=$1`, [id]);
      if (!row) throw new LedgerNotFound();
      return accountView(row);
    });
  }

  getEntry(tenantId: string, entryId: string): Promise<JournalEntryView> {
    const id = uuid(entryId, 'entryId');
    return this.run(tenantId, async tx => {
      const entry = await this.entry(tx, id);
      if (!entry) throw new LedgerNotFound();
      return entry.view;
    });
  }

  /** Posts one balanced entry. All-or-nothing; replays by idempotency key. */
  async post(tenantId: string, who: Actor, input: PostInput): Promise<PostResult> {
    const by = actor(who), t = trace(input?.trace), key = idempotencyKey(input?.idempotencyKey);
    if (!POSTABLE_TYPES.includes(input.entryType)) throw new LedgerInputError('entryType');
    const claimId = optionalUuid(input.claimId, 'claimId'), paymentId = optionalUuid(input.paymentId, 'paymentId');
    const lines = normalizeLines(input.lines);
    const hash = requestHash('POST', by, { entryType: input.entryType, claimId, paymentId,
      lines: lines.map(l => ({ accountId: l.accountId, side: l.side, amount: l.amount })) });
    return this.run(tenantId, async tx => {
      const replay = await this.replay(tx, key, hash);
      if (replay) return { kind: 'POSTED', entry: replay, replayed: true };
      const before = await this.lockAccounts(tx, lines.map(l => l.accountId));
      // Pre-check the per-currency balance for a clean input error (the commit-time trigger is authoritative).
      const { rows: [check] } = await tx.query(`SELECT bool_and(ok) AS balanced FROM (
          SELECT sum(x.amt) FILTER (WHERE x.side='DEBIT') IS NOT DISTINCT FROM sum(x.amt) FILTER (WHERE x.side='CREDIT') AS ok
          FROM unnest($1::uuid[], $2::text[], $3::numeric[]) AS x(id, side, amt) JOIN tpa.ledger_accounts a ON a.id = x.id
          GROUP BY a.currency) s`, [lines.map(l => l.accountId), lines.map(l => l.side), lines.map(l => l.amount)]);
      if (check.balanced !== true) throw new LedgerInputError('lines not balanced per currency');
      return this.postLocked(tx, by, t, before, { entryType: input.entryType, reversesEntryId: null, reasonCode: null,
        claimId, paymentId, key, hash, lines });
    });
  }

  /** Corrects a posted entry with a new, exactly mirrored REVERSAL entry. The original is never changed. */
  async reverse(tenantId: string, who: Actor, input: ReverseInput): Promise<PostResult> {
    const by = actor(who), t = trace(input?.trace), key = idempotencyKey(input?.idempotencyKey);
    const entryId = uuid(input.entryId, 'entryId');
    if (typeof input.reasonCode !== 'string' || !REASON.test(input.reasonCode)) throw new LedgerInputError('reasonCode');
    const hash = requestHash('REVERSE', by, { entryId, reasonCode: input.reasonCode });
    return this.run(tenantId, async tx => {
      const replay = await this.replay(tx, key, hash);
      if (replay) return { kind: 'POSTED', entry: replay, replayed: true };
      // Serialize reversals of the same entry (journal rows cannot be row-locked by tpa_app).
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('ledger-reversal/' || tpa.current_tenant_id()::text || '/' || $1, 0))`, [entryId]);
      const original = await this.entry(tx, entryId);
      if (!original) throw new LedgerNotFound();
      if (original.view.entryType === 'REVERSAL') throw new LedgerStateError('NOT_REVERSIBLE');
      const { rows: [done] } = await tx.query('SELECT 1 AS x FROM tpa.journal_entries e WHERE e.reverses_entry_id=$1', [entryId]);
      if (done) throw new LedgerStateError('ALREADY_REVERSED');
      const lines = normalizeLines(original.view.lines.map(l => ({
        accountId: l.accountId, side: l.side === 'DEBIT' ? 'CREDIT' : 'DEBIT', amount: l.amount })));
      const before = await this.lockAccounts(tx, lines.map(l => l.accountId));
      const result = await this.postLocked(tx, by, t, before, { entryType: 'REVERSAL', reversesEntryId: entryId,
        reasonCode: input.reasonCode, claimId: original.view.claimId, paymentId: original.view.paymentId, key, hash, lines });
      if (result.kind === 'POSTED') {
        await this.audit(tx, by, 'JOURNAL_ENTRY', entryId, 'JOURNAL_REVERSED', sha256(canonicalJson(entryState(original.view))),
          sha256(canonicalJson({ original: entryState(original.view), reversedBy: result.entry.entryId })));
      }
      return result;
    });
  }

  /**
   * Recomputes every account from posted journal lines (the source of truth) and compares it
   * with the locked balance projection; also checks the per-currency trial balance.
   */
  reconcile(tenantId: string): Promise<ReconciliationReport> {
    return this.run(tenantId, async tx => {
      const { rows: accounts } = await tx.query(`WITH j AS (
          SELECT l.account_id, coalesce(sum(l.amount) FILTER (WHERE l.side='DEBIT'),0) AS debits,
            coalesce(sum(l.amount) FILTER (WHERE l.side='CREDIT'),0) AS credits, count(*)::int AS n,
            (array_agg(l.balance_after ORDER BY l.account_version DESC))[1] AS last_balance
          FROM tpa.journal_lines l GROUP BY l.account_id),
        steps AS (
          SELECT s.account_id, count(*) FILTER (WHERE s.balance_after <> coalesce(s.prev_balance,0) + s.delta
              OR s.account_version <> coalesce(s.prev_version,1) + 1)::int AS bad
          FROM (SELECT l.account_id, l.balance_after, l.account_version,
              lag(l.balance_after) OVER w AS prev_balance, lag(l.account_version) OVER w AS prev_version,
              CASE WHEN l.side = a.normal_side THEN l.amount ELSE -l.amount END AS delta
            FROM tpa.journal_lines l JOIN tpa.ledger_accounts a ON a.id = l.account_id
            WINDOW w AS (PARTITION BY l.account_id ORDER BY l.account_version)) s GROUP BY s.account_id)
        SELECT a.id::text AS account_id, a.purpose, a.currency::text AS currency, a.balance::text AS balance,
          a.debit_total::text AS debit_total, a.credit_total::text AS credit_total, a.version,
          coalesce(j.debits,0)::numeric(15,2)::text AS journal_debits, coalesce(j.credits,0)::numeric(15,2)::text AS journal_credits,
          (CASE a.normal_side WHEN 'DEBIT' THEN coalesce(j.debits,0) - coalesce(j.credits,0)
            ELSE coalesce(j.credits,0) - coalesce(j.debits,0) END)::numeric(15,2)::text AS journal_balance,
          coalesce(j.n,0) AS line_count,
          (a.debit_total = coalesce(j.debits,0) AND a.credit_total = coalesce(j.credits,0) AND a.version = 1 + coalesce(j.n,0)
            AND a.balance >= 0 AND a.balance = CASE a.normal_side WHEN 'DEBIT' THEN coalesce(j.debits,0) - coalesce(j.credits,0)
              ELSE coalesce(j.credits,0) - coalesce(j.debits,0) END
            AND (j.last_balance IS NULL OR j.last_balance = a.balance) AND coalesce(steps.bad,0) = 0) AS matches
        FROM tpa.ledger_accounts a LEFT JOIN j ON j.account_id = a.id LEFT JOIN steps ON steps.account_id = a.id
        ORDER BY a.id`);
      const { rows: currencies } = await tx.query(`SELECT l.currency::text AS currency,
          coalesce(sum(l.amount) FILTER (WHERE l.side='DEBIT'),0)::numeric(15,2)::text AS debit_total,
          coalesce(sum(l.amount) FILTER (WHERE l.side='CREDIT'),0)::numeric(15,2)::text AS credit_total,
          coalesce(sum(l.amount) FILTER (WHERE l.side='DEBIT'),0) = coalesce(sum(l.amount) FILTER (WHERE l.side='CREDIT'),0) AS balanced
        FROM tpa.journal_lines l GROUP BY l.currency ORDER BY l.currency`);
      const { rows: [unbalanced] } = await tx.query(`SELECT count(*)::int AS n FROM (SELECT e.id FROM tpa.journal_entries e
          LEFT JOIN tpa.journal_lines l ON l.entry_id = e.id GROUP BY e.id, l.currency
          HAVING count(l.line_no) < 1 OR sum(l.amount) FILTER (WHERE l.side='DEBIT') IS DISTINCT FROM sum(l.amount) FILTER (WHERE l.side='CREDIT')) u`);
      const report: ReconciliationReport = {
        accounts: accounts.map(r => ({ accountId: r.account_id as string, purpose: r.purpose as AccountPurpose, currency: r.currency as string,
          balance: r.balance as string, journalBalance: r.journal_balance as string, debitTotal: r.debit_total as string,
          journalDebits: r.journal_debits as string, creditTotal: r.credit_total as string, journalCredits: r.journal_credits as string,
          version: r.version as number, lineCount: r.line_count as number, matches: r.matches === true })),
        currencies: currencies.map(r => ({ currency: r.currency as string, debitTotal: r.debit_total as string,
          creditTotal: r.credit_total as string, balanced: r.balanced === true })),
        unbalancedEntries: unbalanced.n as number,
        consistent: false,
      };
      report.consistent = report.unbalancedEntries === 0 && report.accounts.every(a => a.matches) && report.currencies.every(c => c.balanced);
      return report;
    });
  }

  /** Maps commit-time/constraint failures (23514) to a typed error; the transaction is already rolled back. */
  private async run<T>(tenantId: string, work: (tx: LedgerTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.db.withTenantTransaction(uuid(tenantId, 'tenantId'), work);
    } catch (error) {
      if (error && typeof error === 'object' && (error as { code?: unknown }).code === '23514') throw new LedgerInvariantError({ cause: error });
      throw error;
    }
  }

  /** Serializes same-key requests, then replays the stored entry or rejects a different request. */
  private async replay(tx: LedgerTransaction, key: string, hash: string): Promise<JournalEntryView | null> {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('ledger-op/' || tpa.current_tenant_id()::text || '/' || $1, 0))`, [key]);
    const { rows: [row] } = await tx.query('SELECT e.id::text AS entry_id FROM tpa.journal_entries e WHERE e.idempotency_key=$1', [key]);
    if (!row) return null;
    const existing = await this.entry(tx, row.entry_id as string);
    if (!existing || existing.requestHash !== hash) throw new LedgerIdempotencyConflict();
    return existing.view;
  }

  /** Stable lock order (lowercase UUID text order equals PostgreSQL uuid order). */
  private async lockAccounts(tx: LedgerTransaction, ids: string[]): Promise<Map<string, LedgerAccountView>> {
    const { rows } = await tx.query(`SELECT ${ACCOUNT_COLS} FROM tpa.ledger_accounts a WHERE a.id = ANY($1::uuid[]) ORDER BY a.id FOR UPDATE`, [ids]);
    if (rows.length !== ids.length) throw new LedgerNotFound();
    const views = rows.map(accountView);
    if (views.some(a => !SUPPORTED_CURRENCIES.includes(a.currency))) throw new LedgerInputError('currency');
    return new Map(views.map(a => [a.accountId, a]));
  }

  private async postLocked(tx: LedgerTransaction, by: Actor, t: Trace, before: Map<string, LedgerAccountView>, draft: EntryDraft): Promise<PostResult> {
    const ids = draft.lines.map(l => l.accountId), sides = draft.lines.map(l => l.side), amounts = draft.lines.map(l => l.amount);
    // Funds check on the locked rows, computed by PostgreSQL NUMERIC.
    const { rows: short } = await tx.query(`SELECT a.id::text AS account_id, a.purpose, a.currency::text AS currency,
        a.balance::text AS available_balance, x.amt::text AS requested_amount
      FROM unnest($1::uuid[], $2::text[], $3::numeric[]) AS x(id, side, amt) JOIN tpa.ledger_accounts a ON a.id = x.id
      WHERE x.side <> a.normal_side AND a.balance - x.amt < 0 ORDER BY a.id`, [ids, sides, amounts]);
    if (short.length) {
      return { kind: 'INSUFFICIENT_FUNDS', replayed: false, shortfalls: short.map(r => ({ accountId: r.account_id as string,
        purpose: r.purpose as AccountPurpose, currency: r.currency as string, availableBalance: r.available_balance as string,
        requestedAmount: r.requested_amount as string })) };
    }
    const entryId = randomUUID();
    await tx.query(`INSERT INTO tpa.journal_entries (tenant_id,id,entry_type,reverses_entry_id,reason_code,claim_id,payment_id,
        idempotency_key,request_hash,posted_by_type,posted_by_id)
      VALUES (tpa.current_tenant_id(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [entryId, draft.entryType, draft.reversesEntryId, draft.reasonCode, draft.claimId, draft.paymentId, draft.key, draft.hash, by.type, by.id]);
    // Balance-increasing lines first so a valid entry never dips below zero mid-statement; accounts are already locked.
    const ordered = [...draft.lines.filter(l => l.side === before.get(l.accountId)!.normalSide),
      ...draft.lines.filter(l => l.side !== before.get(l.accountId)!.normalSide)];
    for (const [index, line] of ordered.entries()) {
      await tx.query(`INSERT INTO tpa.journal_lines (tenant_id,entry_id,line_no,account_id,currency,side,amount,balance_after,account_version)
        SELECT tpa.current_tenant_id(),$1,$2,a.id,a.currency,$4,$5::numeric,0,0 FROM tpa.ledger_accounts a WHERE a.id=$3`,
      [entryId, index + 1, line.accountId, line.side, line.amount]);
    }
    const entry = (await this.entry(tx, entryId))!.view;
    for (const id of [...ids].sort()) {
      const { rows: [row] } = await tx.query(`SELECT ${ACCOUNT_COLS} FROM tpa.ledger_accounts a WHERE a.id=$1`, [id]);
      const after = accountView(row);
      await this.audit(tx, by, 'LEDGER_ACCOUNT', id, 'LEDGER_JOURNAL_POSTED', sha256(canonicalJson(accountState(before.get(id)!))),
        sha256(canonicalJson({ account: accountState(after), entryId })));
      await this.event(tx, after, t, draft.reversesEntryId
        ? { changeKind: 'JOURNAL_POSTED', entryId, entryType: draft.entryType, reversesEntryId: draft.reversesEntryId }
        : { changeKind: 'JOURNAL_POSTED', entryId, entryType: draft.entryType });
    }
    await this.audit(tx, by, 'JOURNAL_ENTRY', entryId, draft.reversesEntryId ? 'JOURNAL_REVERSAL_POSTED' : 'JOURNAL_POSTED',
      undefined, sha256(canonicalJson(entryState(entry))));
    return { kind: 'POSTED', entry, replayed: false };
  }

  private async entry(tx: LedgerTransaction, id: string): Promise<{ view: JournalEntryView; requestHash: string } | null> {
    const { rows: [e] } = await tx.query(`SELECT ${ENTRY_COLS} FROM tpa.journal_entries e WHERE e.id=$1`, [id]);
    if (!e) return null;
    const { rows: lines } = await tx.query(`SELECT ${LINE_COLS} FROM tpa.journal_lines l WHERE l.entry_id=$1 ORDER BY l.line_no`, [id]);
    return { requestHash: e.request_hash as string, view: {
      entryId: e.entry_id as string, entryType: e.entry_type as EntryType, status: 'POSTED', reversesEntryId: (e.reverses_entry_id as string) ?? null,
      reasonCode: (e.reason_code as string) ?? null, claimId: (e.claim_id as string) ?? null, paymentId: (e.payment_id as string) ?? null,
      postedAt: e.posted_at as string, lines: lines.map(lineView) } };
  }

  private async audit(tx: LedgerTransaction, by: Actor, entityType: 'LEDGER_ACCOUNT' | 'JOURNAL_ENTRY', entityId: string, action: string,
    beforeHash: string | undefined, afterHash: string): Promise<void> {
    const payload: Record<string, string> = { after_hash: afterHash };
    if (beforeHash) payload.before_hash = beforeHash;
    await tx.query('SELECT * FROM tpa.append_audit($1,$2,$3,$4,$5,$6)', [entityType, entityId, by.type, by.id, action, JSON.stringify(payload)]);
  }

  private async event(tx: LedgerTransaction, account: LedgerAccountView, t: Trace, payload: LedgerEventDraft['payload']): Promise<void> {
    await this.appendEvent(tx, { eventType: 'ledger.account-changed', aggregateId: account.accountId, aggregateVersion: account.version,
      correlationId: t.correlationId, causationId: t.causationId, payload });
  }
}
