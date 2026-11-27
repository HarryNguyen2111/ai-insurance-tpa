import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalInvoiceIdentity, InvoiceAllocationNotFound, InvoiceAllocationService, InvoiceIdempotencyConflict, InvoiceInputError,
  InvoiceInvariantError, invoiceIdentityHash, positiveMoney, requestHash, type InvoiceDatabase, type InvoiceTransaction,
} from './invoice-allocation';

// Unit level only: the cross-tenant race / duplicate behaviour (PT04) runs on real PG16 in
// packages/database/test/invoice-allocation.integration.test.ts.
type Handler = (sql: string, values: unknown[]) => Record<string, unknown>[] | undefined;
function fakeDb(handler: Handler) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx: InvoiceTransaction = { async query(sql, values = []) { calls.push({ sql, values }); return { rows: handler(sql, values) ?? [] }; } };
  const db: InvoiceDatabase = { async withTenantTransaction(_tenant, work) { return work(tx); } };
  return { db, calls };
}
const tenant = randomUUID(), who = { type: 'SERVICE' as const, id: randomUUID() };
const trace = { correlationId: randomUUID(), causationId: randomUUID() };
const invoice = { sellerTaxCode: '0101234567', invoiceSerial: '1C26TAA', invoiceNumber: '00001234', totalAmount: '1000000.00' };
const proof = { documentId: randomUUID(), documentSha256: 'a'.repeat(64), verifiedBy: randomUUID() };
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('BEN-04 invoice identity (SHA-256 of MST|Serial|Number)', () => {
  test('known vector and canonical normalisation', () => {
    expect(canonicalInvoiceIdentity(invoice)).toBe('0101234567|1C26TAA|1234');
    expect(invoiceIdentityHash(invoice)).toBe(sha('0101234567|1C26TAA|1234'));
    expect(invoiceIdentityHash(invoice)).toMatch(/^[0-9a-f]{64}$/);
  });
  test('formatting variants of one physical invoice collide (no dedup evasion)', () => {
    const base = invoiceIdentityHash(invoice);
    for (const v of [{ invoiceNumber: '1234' }, { invoiceNumber: ' 0001234 ' }, { invoiceSerial: '1c26taa' }, { sellerTaxCode: ' 0101234567 ' }]) {
      expect(invoiceIdentityHash({ ...invoice, ...v })).toBe(base);
    }
    expect(invoiceIdentityHash({ ...invoice, sellerTaxCode: '0101234567-001' })).not.toBe(base);
    expect(invoiceIdentityHash({ ...invoice, invoiceNumber: '1235' })).not.toBe(base);
    expect(invoiceIdentityHash({ ...invoice, invoiceSerial: 'AA/20E' })).not.toBe(base);
  });
  test.each([
    { sellerTaxCode: '123' }, { sellerTaxCode: '010123456A' }, { sellerTaxCode: '0101234567-1' }, { invoiceSerial: '' },
    { invoiceSerial: '1C26 TAA' }, { invoiceSerial: 'Ｃ26' }, { invoiceNumber: '0000' }, { invoiceNumber: '12a' }, { invoiceNumber: '' },
    { invoiceNumber: 1234 }, { sellerTaxCode: null },
  ])('rejects %p', bad => {
    expect(() => invoiceIdentityHash({ ...invoice, ...(bad as object) } as never)).toThrow(InvoiceInputError);
  });
});

describe('BEN-04 money strings (Zero Float)', () => {
  test.each([1000000, '1000000', '1000000.0', '-1.00', '1e6', '0.00', '01.00', '10000000000000.00', null])('rejects %p', v => {
    expect(() => positiveMoney(v, 'amount')).toThrow(InvoiceInputError);
  });
  test('accepts canonical NUMERIC(15,2) strings unchanged', () => {
    for (const m of ['0.01', '720000.00', '9999999999999.99']) expect(positiveMoney(m, 'amount')).toBe(m);
  });
});

describe('BEN-04 allocate flow (fake transaction)', () => {
  const allocatedRow = (values: unknown[]) => [{ allocation_id: values[0], claim_id: values[1], invoice_hash: values[3], invoice_total: values[4],
    allocated_amount: values[5], co_insurance: values[6], status: 'ACTIVE', version: 1 }];
  const handler = (code: string, opInserted = true): Handler => (sql, values) => {
    if (sql.includes('INSERT INTO tpa.invoice_allocation_operations')) return opInserted ? [{ operation_key: values[0] }] : [];
    if (sql.includes('AS fits')) return [{ fits: true }];
    if (sql.includes('tpa.invoice_allocate')) return [{ result_code: code, registry_id: code === 'ALLOCATED' ? randomUUID() : null }];
    if (sql.includes('INSERT INTO tpa.invoice_allocations')) return allocatedRow(values);
    return undefined;
  };

  test('ALLOCATED: global check, tenant row, audit, outbox and stored result in one transaction, in order', async () => {
    const events: unknown[] = [];
    const { db, calls } = fakeDb(handler('ALLOCATED'));
    const service = new InvoiceAllocationService(db, async (_tx, d) => { events.push(d); });
    const claimId = randomUUID();
    const r = await service.allocate(tenant, who, { operationKey: `ben04:${randomUUID()}`, claimId, invoice, amount: '600000.00', trace });
    expect(r.kind).toBe('ALLOCATED');
    if (r.kind !== 'ALLOCATED') return;
    expect(r.allocation).toMatchObject({ claimId, invoiceHash: invoiceIdentityHash(invoice), allocatedAmount: '600000.00', coInsurance: false });
    const order = ['invoice_allocation_operations', 'tpa.invoice_allocate', 'INSERT INTO tpa.invoice_allocations', 'append_audit', 'SET result'];
    const idx = order.map(s => calls.findIndex(c => c.sql.includes(s)));
    expect(idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1]))).toBe(true);
    const global = calls.find(c => c.sql.includes('tpa.invoice_allocate'))!;
    expect(global.values).toEqual([invoiceIdentityHash(invoice), '1000000.00', r.allocation.allocationId, '600000.00', false]);
    expect(events).toEqual([{ eventType: 'invoice.allocation-changed', aggregateId: r.allocation.allocationId, aggregateVersion: 1,
      correlationId: trace.correlationId, causationId: trace.causationId, payload: { changeKind: 'ALLOCATED' } }]);
  });

  test.each([['DUPLICATE', 'DUPLICATE_INVOICE'], ['EXCEEDS_TOTAL', 'EXCEEDS_INVOICE_TOTAL'], ['TOTAL_MISMATCH', 'INVOICE_TOTAL_MISMATCH']])(
    '%s: blocked result discloses only a kind; audited, no tenant row, no event', async (code, kind) => {
      const events: unknown[] = [];
      const { db, calls } = fakeDb(handler(code));
      const service = new InvoiceAllocationService(db, async (_tx, d) => { events.push(d); });
      const r = await service.allocate(tenant, who, { operationKey: `ben04:${randomUUID()}`, claimId: randomUUID(), invoice, amount: '1.00', trace });
      expect(r).toEqual({ kind, replayed: false });
      expect(calls.some(c => c.sql.includes('INSERT INTO tpa.invoice_allocations'))).toBe(false);
      expect(calls.filter(c => c.sql.includes('append_audit'))).toHaveLength(1);
      expect(events).toHaveLength(0);
    });

  test('co-insurance proof is validated and passed as a boolean to the global check (proof stays tenant-side)', async () => {
    const { db, calls } = fakeDb(handler('ALLOCATED'));
    const service = new InvoiceAllocationService(db, async () => undefined);
    await service.allocate(tenant, who, { operationKey: `ben04:${randomUUID()}`, claimId: randomUUID(), invoice, amount: '1.00', trace, coInsuranceProof: proof });
    expect(calls.find(c => c.sql.includes('tpa.invoice_allocate'))!.values[4]).toBe(true);
    const insert = calls.find(c => c.sql.includes('INSERT INTO tpa.invoice_allocations'))!;
    expect(insert.values.slice(6)).toEqual([true, proof.documentId, proof.documentSha256, proof.verifiedBy]);
    for (const bad of [{ ...proof, documentSha256: 'A'.repeat(64) }, { ...proof, documentId: 'x' }, { ...proof, verifiedBy: undefined }, 'proof']) {
      await expect(service.allocate(tenant, who, { operationKey: `ben04:${randomUUID()}`, claimId: randomUUID(), invoice, amount: '1.00', trace,
        coInsuranceProof: bad as never })).rejects.toThrow(InvoiceInputError);
    }
  });

  test('unknown global outcome is an invariant failure (rolled back)', async () => {
    const service = new InvoiceAllocationService(fakeDb(handler('SURPRISE')).db, async () => undefined);
    await expect(service.allocate(tenant, who, { operationKey: `ben04:${randomUUID()}`, claimId: randomUUID(), invoice, amount: '1.00', trace }))
      .rejects.toThrow(InvoiceInvariantError);
  });

  test('replay returns stored result; different request with same key conflicts', async () => {
    const key = `ben04:${randomUUID()}`, claimId = randomUUID();
    const body = { claimId, invoiceHash: invoiceIdentityHash(invoice), total: '1000000.00', amount: '1.00', proof: null };
    const stored = requestHash('ALLOCATE', who, body);
    const db = (hash: string) => fakeDb((sql) => {
      if (sql.includes('INSERT INTO tpa.invoice_allocation_operations')) return [];
      if (sql.includes('SELECT operation_type')) return [{ operation_type: 'ALLOCATE', request_hash: hash, result: { kind: 'DUPLICATE_INVOICE' } }];
      return undefined;
    });
    const replayed = await new InvoiceAllocationService(db(stored).db, async () => undefined)
      .allocate(tenant, who, { operationKey: key, claimId, invoice, amount: '1.00', trace: { correlationId: randomUUID(), causationId: randomUUID() } });
    expect(replayed).toEqual({ kind: 'DUPLICATE_INVOICE', replayed: true });
    await expect(new InvoiceAllocationService(db(stored).db, async () => undefined)
      .allocate(tenant, who, { operationKey: key, claimId, invoice, amount: '2.00', trace })).rejects.toThrow(InvoiceIdempotencyConflict);
  });

  test('input validation happens before any database access', async () => {
    const { db, calls } = fakeDb(() => undefined);
    const service = new InvoiceAllocationService(db, async () => undefined);
    const ok = { operationKey: `ben04:${randomUUID()}`, claimId: randomUUID(), invoice, amount: '1.00', trace };
    for (const bad of [{ amount: 1 }, { amount: '0.00' }, { claimId: 'claim' }, { operationKey: 'short' }, { invoice: { ...invoice, totalAmount: 1e6 } },
      { invoice: { ...invoice, invoiceNumber: 'x' } }, { trace: undefined }]) {
      await expect(service.allocate(tenant, who, { ...ok, ...bad } as never)).rejects.toThrow(InvoiceInputError);
    }
    await expect(service.allocate('tenant', who, ok)).rejects.toThrow(InvoiceInputError);
    expect(calls).toHaveLength(0);
  });
});

describe('BEN-04 release flow (fake transaction)', () => {
  const row = (status: string, version: number) => ({ allocation_id: id, claim_id: randomUUID(), invoice_hash: 'b'.repeat(64),
    invoice_total: '1000000.00', allocated_amount: '1.00', co_insurance: false, status, version });
  const id = randomUUID();
  const handler = (code: string, released = true): Handler => sql => {
    if (sql.includes('INSERT INTO tpa.invoice_allocation_operations')) return [{ operation_key: 'k' }];
    if (sql.includes('tpa.invoice_release')) return [{ code }];
    if (sql.includes('UPDATE tpa.invoice_allocations')) return released ? [row('RELEASED', 2)] : [];
    if (sql.includes('FROM tpa.invoice_allocations')) return code === 'NOT_ACTIVE' ? [row('RELEASED', 2)] : [row('ACTIVE', 1)];
    return undefined;
  };
  test('RELEASED: global release before tenant update; audit + RELEASED event', async () => {
    const events: { payload: unknown }[] = [];
    const { db, calls } = fakeDb(handler('RELEASED'));
    const r = await new InvoiceAllocationService(db, async (_tx, d) => { events.push(d); })
      .release(tenant, who, { operationKey: `ben04:${randomUUID()}`, allocationId: id, trace });
    expect(r.kind).toBe('RELEASED');
    expect(calls.findIndex(c => c.sql.includes('tpa.invoice_release'))).toBeLessThan(calls.findIndex(c => c.sql.includes('UPDATE tpa.invoice_allocations')));
    expect(events.map(e => e.payload)).toEqual([{ changeKind: 'RELEASED' }]);
  });
  test('NOT_ACTIVE is an idempotent no-op; NOT_FOUND hides existence; mismatch is an invariant failure', async () => {
    const svc = (h: Handler) => new InvoiceAllocationService(fakeDb(h).db, async () => { throw new Error('no event expected'); });
    const input = { operationKey: `ben04:${randomUUID()}`, allocationId: id, trace };
    expect((await svc(handler('NOT_ACTIVE')).release(tenant, who, input)).kind).toBe('NOT_ACTIVE');
    await expect(svc(handler('NOT_FOUND')).release(tenant, who, input)).rejects.toThrow(InvoiceAllocationNotFound);
    await expect(svc(handler('RELEASED', false)).release(tenant, who, input)).rejects.toThrow(InvoiceInvariantError);
  });
});
