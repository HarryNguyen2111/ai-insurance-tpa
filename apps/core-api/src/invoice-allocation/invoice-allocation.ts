import { createHash, randomUUID } from 'node:crypto';

/**
 * BEN-04 (#35) internal port: global invoice dedup and co-insurance allocation.
 * No HTTP handler (no OpenAPI change); callers (claim intake, Temporal activities)
 * supply the verified tenant and actor.
 *
 * Invariant: per physical invoice (SHA-256 of `MST|Serial|Number`), the sum of ACTIVE
 * allocations across ALL tenants is <= the invoice total. Enforced in PostgreSQL by the
 * reviewed SECURITY DEFINER functions of migration 0012 (`tpa.invoice_allocate` /
 * `tpa.invoice_release`): one global row lock per invoice, a conditional atomic update,
 * a CHECK constraint and commit-time pairing of tenant and global rows.
 *
 * Disclosure: blocked outcomes carry only a kind. Nothing about another insurer's
 * claim, tenant, allocated or remaining amount ever reaches this tenant.
 * Money: NUMERIC(15,2) strings only; PostgreSQL does all comparisons and sums.
 */
export interface InvoiceTransaction {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface InvoiceDatabase {
  withTenantTransaction<T>(tenantId: string, work: (tx: InvoiceTransaction) => Promise<T>): Promise<T>;
}
export type AllocationChangeKind = 'ALLOCATED' | 'RELEASED';
export interface InvoiceEventDraft {
  eventType: 'invoice.allocation-changed'; aggregateId: string; aggregateVersion: number;
  correlationId: string; causationId: string; payload: { changeKind: AllocationChangeKind };
}
/** Composition supplies `@tpa/database` appendOutboxEvent (same transaction). */
export type InvoiceOutboxAppender = (tx: InvoiceTransaction, draft: InvoiceEventDraft) => Promise<unknown>;

export interface Actor { type: 'USER' | 'SERVICE' | 'SYSTEM'; id: string }
export interface Trace { correlationId: string; causationId: string }

export interface InvoiceIdentity { sellerTaxCode: string; invoiceSerial: string; invoiceNumber: string }
/**
 * Second-insurer evidence for co-insurance. Synthetic/structural only: the production proof
 * policy (which documents qualify, who may verify) requires approved contracts.
 */
export interface CoInsuranceProof { documentId: string; documentSha256: string; verifiedBy: string }
export interface AllocateInput {
  operationKey: string; claimId: string; trace: Trace;
  invoice: InvoiceIdentity & { totalAmount: string };
  amount: string;
  coInsuranceProof?: CoInsuranceProof;
}
export interface ReleaseInput { operationKey: string; allocationId: string; trace: Trace }

export type AllocationStatus = 'ACTIVE' | 'RELEASED';
export interface AllocationView {
  allocationId: string; claimId: string; invoiceHash: string; invoiceTotal: string; allocatedAmount: string;
  coInsurance: boolean; status: AllocationStatus; version: number;
}
export type AllocateResult =
  | { kind: 'ALLOCATED'; allocation: AllocationView; replayed: boolean }
  /** Invoice already claimed (same insurer, or another insurer without co-insurance proof). Caller routes FRAUD_HOLD/review. */
  | { kind: 'DUPLICATE_INVOICE'; replayed: boolean }
  /** Would push the global allocation above the invoice total. Nothing allocated; caller routes review. */
  | { kind: 'EXCEEDS_INVOICE_TOTAL'; replayed: boolean }
  /** Extracted total disagrees with the registered total for this invoice identity. Caller routes review. */
  | { kind: 'INVOICE_TOTAL_MISMATCH'; replayed: boolean };
export type ReleaseResult =
  | { kind: 'RELEASED'; allocation: AllocationView; replayed: boolean }
  | { kind: 'NOT_ACTIVE'; allocation: AllocationView; replayed: boolean };

export class InvoiceInputError extends Error {
  constructor(field: string) { super(`Invalid invoice allocation input: ${field}`); this.name = 'InvoiceInputError'; }
}
/** Same operation key reused with a different request (maps to 409). */
export class InvoiceIdempotencyConflict extends Error {
  constructor() { super('Operation key reused with a different request'); this.name = 'InvoiceIdempotencyConflict'; }
}
/** Not found or not visible to this tenant; never reveals which. */
export class InvoiceAllocationNotFound extends Error {
  constructor() { super('Invoice allocation not found'); this.name = 'InvoiceAllocationNotFound'; }
}
/** Defence-in-depth guard tripped; the transaction is rolled back. */
export class InvoiceInvariantError extends Error {
  constructor() { super('Invoice allocation invariant violated; rolled back'); this.name = 'InvoiceInvariantError'; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONEY = /^(0|[1-9][0-9]{0,12})\.[0-9]{2}$/;
const KEY = /^[A-Za-z0-9._:-]{16,100}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** Vietnamese MST: 10 digits, or 10 digits + '-' + 3-digit branch suffix. */
const TAX_CODE = /^[0-9]{10}(-[0-9]{3})?$/;
/** Invoice symbol/serial (ND 123/2020 e.g. `1C24TAA`; legacy e.g. `AA/20E`). */
const SERIAL = /^[A-Z0-9][A-Z0-9/-]{0,29}$/;
const NUMBER = /^[0-9]{1,30}$/;

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value.toLowerCase())) throw new InvoiceInputError(field);
  return value.toLowerCase();
}
/** Positive NUMERIC(15,2) string. Numbers, exponents, signs and other scales are rejected. */
export function positiveMoney(value: unknown, field: string): string {
  if (typeof value !== 'string' || !MONEY.test(value) || value === '0.00') throw new InvoiceInputError(field);
  return value;
}
function operationKey(value: unknown): string {
  if (typeof value !== 'string' || !KEY.test(value)) throw new InvoiceInputError('operationKey');
  return value;
}
function actor(value: Actor): Actor {
  if (!value || !['USER', 'SERVICE', 'SYSTEM'].includes(value.type)) throw new InvoiceInputError('actor');
  return { type: value.type, id: uuid(value.id, 'actor') };
}
function trace(value: Trace): Trace {
  if (!value) throw new InvoiceInputError('trace');
  return { correlationId: uuid(value.correlationId, 'correlationId'), causationId: uuid(value.causationId, 'causationId') };
}
function proof(value: CoInsuranceProof | undefined): CoInsuranceProof | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') throw new InvoiceInputError('coInsuranceProof');
  if (typeof value.documentSha256 !== 'string' || !SHA256.test(value.documentSha256)) throw new InvoiceInputError('coInsuranceProof.documentSha256');
  return { documentId: uuid(value.documentId, 'coInsuranceProof.documentId'), documentSha256: value.documentSha256,
    verifiedBy: uuid(value.verifiedBy, 'coInsuranceProof.verifiedBy') };
}

/**
 * Canonical invoice identity. Trims, upper-cases the serial and strips leading zeros from the
 * number so formatting variants of one physical invoice collide (dedup evasion), then
 * SHA-256 over `MST|Serial|Number` (spec 01/03).
 */
export function canonicalInvoiceIdentity(value: InvoiceIdentity): string {
  if (!value || typeof value !== 'object') throw new InvoiceInputError('invoice');
  const tax = typeof value.sellerTaxCode === 'string' ? value.sellerTaxCode.trim() : '';
  const serial = typeof value.invoiceSerial === 'string' ? value.invoiceSerial.trim().toUpperCase() : '';
  const raw = typeof value.invoiceNumber === 'string' ? value.invoiceNumber.trim() : '';
  if (!TAX_CODE.test(tax)) throw new InvoiceInputError('invoice.sellerTaxCode');
  if (!SERIAL.test(serial)) throw new InvoiceInputError('invoice.invoiceSerial');
  if (!NUMBER.test(raw)) throw new InvoiceInputError('invoice.invoiceNumber');
  const number = raw.replace(/^0+/, '');
  if (number === '') throw new InvoiceInputError('invoice.invoiceNumber');
  return `${tax}|${serial}|${number}`;
}
export function invoiceIdentityHash(value: InvoiceIdentity): string {
  return sha256(canonicalInvoiceIdentity(value));
}

type Canonical = string | number | boolean | null | Canonical[] | { [key: string]: Canonical };
export function canonicalJson(value: Canonical): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new InvoiceInputError('canonical number');
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

const COLS = `x.id::text AS allocation_id, x.claim_id::text AS claim_id, x.invoice_hash, x.invoice_total::text AS invoice_total,
  x.allocated_amount::text AS allocated_amount, x.co_insurance, x.status, x.version`;
type Row = Record<string, unknown>;
const view = (r: Row): AllocationView => ({
  allocationId: r.allocation_id as string, claimId: r.claim_id as string, invoiceHash: r.invoice_hash as string,
  invoiceTotal: r.invoice_total as string, allocatedAmount: r.allocated_amount as string, coInsurance: r.co_insurance as boolean,
  status: r.status as AllocationStatus, version: r.version as number,
});
const state = (a: AllocationView): Canonical => ({
  allocationId: a.allocationId, claimId: a.claimId, invoiceHash: a.invoiceHash, invoiceTotal: a.invoiceTotal,
  allocatedAmount: a.allocatedAmount, coInsurance: a.coInsurance, status: a.status, version: a.version,
});
const BLOCKED: Record<string, Exclude<AllocateResult['kind'], 'ALLOCATED'>> = {
  DUPLICATE: 'DUPLICATE_INVOICE', EXCEEDS_TOTAL: 'EXCEEDS_INVOICE_TOTAL', TOTAL_MISMATCH: 'INVOICE_TOTAL_MISMATCH',
};
const BLOCKED_ACTION: Record<string, string> = {
  DUPLICATE_INVOICE: 'INVOICE_DUPLICATE_BLOCKED', EXCEEDS_INVOICE_TOTAL: 'INVOICE_OVERALLOCATION_BLOCKED',
  INVOICE_TOTAL_MISMATCH: 'INVOICE_TOTAL_MISMATCH',
};

export class InvoiceAllocationService {
  private readonly db: InvoiceDatabase;
  private readonly appendEvent: InvoiceOutboxAppender;
  constructor(db: InvoiceDatabase, appendEvent: InvoiceOutboxAppender) { this.db = db; this.appendEvent = appendEvent; }

  /** Global dedup check + allocation of part of a physical invoice to one claim of this tenant. */
  async allocate(tenantId: string, who: Actor, input: AllocateInput): Promise<AllocateResult> {
    const by = actor(who), t = trace(input?.trace), key = operationKey(input.operationKey), claimId = uuid(input.claimId, 'claimId');
    const invoiceHash = invoiceIdentityHash(input.invoice);
    const total = positiveMoney(input.invoice.totalAmount, 'invoice.totalAmount'), amount = positiveMoney(input.amount, 'amount');
    const evidence = proof(input.coInsuranceProof);
    const hash = requestHash('ALLOCATE', by, { claimId, invoiceHash, total, amount,
      proof: evidence ? { documentId: evidence.documentId, documentSha256: evidence.documentSha256, verifiedBy: evidence.verifiedBy } : null });
    return this.db.withTenantTransaction(uuid(tenantId, 'tenantId'), async tx => {
      const replay = await this.begin(tx, 'ALLOCATE', key, hash);
      if (replay) return { ...(replay as Omit<AllocateResult, 'replayed'>), replayed: true } as AllocateResult;
      const { rows: [check] } = await tx.query(`SELECT $1::numeric <= $2::numeric AS fits`, [amount, total]);
      if (check?.fits !== true) throw new InvoiceInputError('amount exceeds invoice total');
      const allocationId = randomUUID();
      // Global lock + duplicate/total check; returns only an outcome code.
      const { rows: [global] } = await tx.query('SELECT result_code, result_registry_id::text AS registry_id FROM tpa.invoice_allocate($1,$2::numeric,$3,$4::numeric,$5)',
        [invoiceHash, total, allocationId, amount, evidence !== null]);
      const code = global?.result_code as string | undefined;
      if (code !== 'ALLOCATED') {
        const kind = code ? BLOCKED[code] : undefined;
        if (!kind) throw new InvoiceInvariantError();
        // Evidence for FRAUD_HOLD/review on this tenant's claim; holds only this tenant's own request facts.
        await this.audit(tx, by, 'INVOICE_CHECK', claimId, BLOCKED_ACTION[kind], undefined,
          sha256(canonicalJson({ claimId, invoiceHash, total, amount, coInsurance: evidence !== null, outcome: kind })));
        const result = { kind };
        await this.finish(tx, key, result);
        return { ...result, replayed: false } as AllocateResult;
      }
      const { rows: [row] } = await tx.query(`INSERT INTO tpa.invoice_allocations AS x (tenant_id,id,claim_id,invoice_registry_id,invoice_hash,
          invoice_total,allocated_amount,co_insurance,proof_document_id,proof_document_sha256,proof_verified_by,status)
        VALUES (tpa.current_tenant_id(),$1,$2,$3,$4,$5::numeric,$6::numeric,$7,$8,$9,$10,'ACTIVE') RETURNING ${COLS}`,
      [allocationId, claimId, global.registry_id, invoiceHash, total, amount, evidence !== null,
        evidence?.documentId ?? null, evidence?.documentSha256 ?? null, evidence?.verifiedBy ?? null]);
      if (!row) throw new InvoiceInvariantError();
      const allocation = view(row);
      await this.audit(tx, by, 'INVOICE_ALLOCATION', allocation.allocationId, 'INVOICE_ALLOCATED', undefined, sha256(canonicalJson(state(allocation))));
      await this.event(tx, allocation, t, 'ALLOCATED');
      const result = { kind: 'ALLOCATED' as const, allocation };
      await this.finish(tx, key, result);
      return { ...result, replayed: false };
    });
  }

  /** Releases this tenant's allocation (claim rejected/withdrawn); frees global capacity. Idempotent. */
  async release(tenantId: string, who: Actor, input: ReleaseInput): Promise<ReleaseResult> {
    const by = actor(who), t = trace(input?.trace), key = operationKey(input.operationKey), allocationId = uuid(input.allocationId, 'allocationId');
    const hash = requestHash('RELEASE', by, { allocationId });
    return this.db.withTenantTransaction(uuid(tenantId, 'tenantId'), async tx => {
      const replay = await this.begin(tx, 'RELEASE', key, hash);
      if (replay) return { ...(replay as Omit<ReleaseResult, 'replayed'>), replayed: true } as ReleaseResult;
      const before = await this.read(tx, allocationId);
      // Global registry lock first (same order as allocate), then the tenant row.
      const { rows: [global] } = await tx.query('SELECT tpa.invoice_release($1) AS code', [allocationId]);
      const code = global?.code as string | undefined;
      if (code === 'NOT_FOUND') throw new InvoiceAllocationNotFound();
      if (code === 'NOT_ACTIVE') {
        const result = { kind: 'NOT_ACTIVE' as const, allocation: await this.read(tx, allocationId) };
        await this.finish(tx, key, result);
        return { ...result, replayed: false };
      }
      if (code !== 'RELEASED') throw new InvoiceInvariantError();
      const { rows: [row] } = await tx.query(`UPDATE tpa.invoice_allocations x SET status='RELEASED', version = x.version + 1
        WHERE x.id=$1 AND x.status='ACTIVE' RETURNING ${COLS}`, [allocationId]);
      if (!row) throw new InvoiceInvariantError();
      const allocation = view(row);
      await this.audit(tx, by, 'INVOICE_ALLOCATION', allocationId, 'INVOICE_RELEASED',
        sha256(canonicalJson(state(before))), sha256(canonicalJson(state(allocation))));
      await this.event(tx, allocation, t, 'RELEASED');
      const result = { kind: 'RELEASED' as const, allocation };
      await this.finish(tx, key, result);
      return { ...result, replayed: false };
    });
  }

  getAllocation(tenantId: string, allocationId: string): Promise<AllocationView> {
    const id = uuid(allocationId, 'allocationId');
    return this.db.withTenantTransaction(uuid(tenantId, 'tenantId'), tx => this.read(tx, id));
  }

  /** This tenant's allocations for a claim (RLS-scoped; never other insurers'). */
  listForClaim(tenantId: string, claimId: string): Promise<AllocationView[]> {
    const id = uuid(claimId, 'claimId');
    return this.db.withTenantTransaction(uuid(tenantId, 'tenantId'), async tx =>
      (await tx.query(`SELECT ${COLS} FROM tpa.invoice_allocations x WHERE x.claim_id=$1 ORDER BY x.created_at, x.id`, [id])).rows.map(view));
  }

  private async read(tx: InvoiceTransaction, id: string): Promise<AllocationView> {
    const { rows: [row] } = await tx.query(`SELECT ${COLS} FROM tpa.invoice_allocations x WHERE x.id=$1`, [id]);
    if (!row) throw new InvoiceAllocationNotFound();
    return view(row);
  }
  /** Returns the stored result for a replay; throws on key reuse with a different request. */
  private async begin(tx: InvoiceTransaction, type: string, key: string, hash: string): Promise<Row | null> {
    const { rows: inserted } = await tx.query(`INSERT INTO tpa.invoice_allocation_operations (tenant_id,operation_key,operation_type,request_hash)
      VALUES (tpa.current_tenant_id(),$1,$2,$3) ON CONFLICT DO NOTHING RETURNING operation_key`, [key, type, hash]);
    if (inserted.length) return null;
    const { rows: [row] } = await tx.query('SELECT operation_type,request_hash,result FROM tpa.invoice_allocation_operations WHERE operation_key=$1', [key]);
    if (!row || row.operation_type !== type || row.request_hash !== hash || !row.result) throw new InvoiceIdempotencyConflict();
    return row.result as Row;
  }
  private async finish(tx: InvoiceTransaction, key: string, result: object): Promise<void> {
    await tx.query('UPDATE tpa.invoice_allocation_operations SET result=$2::jsonb WHERE operation_key=$1', [key, JSON.stringify(result)]);
  }
  private async audit(tx: InvoiceTransaction, by: Actor, entityType: string, entityId: string, action: string,
    beforeHash: string | undefined, afterHash: string): Promise<void> {
    const payload: Record<string, string> = { after_hash: afterHash };
    if (beforeHash) payload.before_hash = beforeHash;
    await tx.query('SELECT * FROM tpa.append_audit($1,$2,$3,$4,$5,$6)', [entityType, entityId, by.type, by.id, action, JSON.stringify(payload)]);
  }
  private async event(tx: InvoiceTransaction, a: AllocationView, t: Trace, changeKind: AllocationChangeKind): Promise<void> {
    await this.appendEvent(tx, { eventType: 'invoice.allocation-changed', aggregateId: a.allocationId, aggregateVersion: a.version,
      correlationId: t.correlationId, causationId: t.causationId, payload: { changeKind } });
  }
}
