import { randomInt, randomUUID } from 'node:crypto';
import {
  canonicalJson, LedgerIdempotencyConflict, LedgerInputError, LedgerInvariantError, LedgerService, normalizeLines, positiveMoney,
  requestHash, type LedgerDatabase, type LedgerEventDraft, type LedgerTransaction,
} from './ledger';

// Unit level only: PostgreSQL constraint/concurrency behaviour (PT14) runs in
// packages/database/test/ledger.integration.test.ts on real PG16.
type Handler = (sql: string, values: unknown[]) => Record<string, unknown>[] | undefined;
function fakeDb(handler: Handler, failure?: unknown) {
  const calls: { sql: string; values: unknown[] }[] = [];
  let transactions = 0;
  const tx: LedgerTransaction = {
    async query(sql, values = []) { calls.push({ sql, values }); return { rows: handler(sql, values) ?? [] }; },
  };
  const db: LedgerDatabase = {
    async withTenantTransaction(_tenant, work) { transactions++; const r = await work(tx); if (failure) throw failure; return r; },
  };
  return { db, calls, transactions: () => transactions };
}
const tenant = randomUUID(), who = { type: 'SERVICE' as const, id: randomUUID() };
const trace = { correlationId: randomUUID(), causationId: randomUUID() };
const noEvents = async () => undefined;
const validMoney = () => {
  const digits = randomInt(1, 14);
  let int = String(randomInt(1, 10));
  for (let i = 1; i < digits; i++) int += String(randomInt(0, 10));
  return `${int}.${String(randomInt(0, 100)).padStart(2, '0')}`;
};
const [float, bank] = [randomUUID(), randomUUID()].sort();
const topup = (amount = '1000000.00') => [{ accountId: bank, side: 'DEBIT' as const, amount }, { accountId: float, side: 'CREDIT' as const, amount }];
const accountRow = (id: string, purpose: string, normal: string, balance = '0.00', version = 1) => ({
  account_id: id, purpose, currency: 'VND', normal_side: normal, balance, debit_total: '0.00', credit_total: balance, version,
});

describe('PAY-01 money strings (Zero Float)', () => {
  test('property: 2000 random NUMERIC(15,2) strings are accepted unchanged', () => {
    for (let i = 0; i < 2000; i++) { const m = validMoney(); expect(positiveMoney(m, 'amount')).toBe(m); }
    expect(positiveMoney('9999999999999.99', 'amount')).toBe('9999999999999.99');
  });
  test.each([720000, 0.1, '720000', '720000.0', '720000.000', '-1.00', '+1.00', '1e6', '0.00', '00.10', ' 1.00',
    '10000000000000.00', '1,000.00', 'NaN', null, undefined, {}])('rejects %p', value => {
    expect(() => positiveMoney(value, 'amount')).toThrow(LedgerInputError);
  });
});

describe('PAY-01 line normalization and request fingerprint', () => {
  test('property: any permutation yields the same sorted lines and the same request hash', () => {
    for (let i = 0; i < 200; i++) {
      const lines = Array.from({ length: randomInt(2, 8) }, (_, k) => ({
        accountId: randomUUID(), side: (k % 2 ? 'CREDIT' : 'DEBIT') as 'DEBIT' | 'CREDIT', amount: validMoney() }));
      const shuffled = [...lines].sort(() => randomInt(0, 3) - 1);
      const a = normalizeLines(lines), b = normalizeLines(shuffled);
      expect(b).toEqual(a);
      expect(a.map(l => l.accountId)).toEqual([...a.map(l => l.accountId)].sort());
      expect(requestHash('POST', who, { lines: a.map(l => ({ ...l })) })).toBe(requestHash('POST', who, { lines: b.map(l => ({ ...l })) }));
    }
  });
  test('rejects single line, duplicate account, one-sided and oversized entries', () => {
    const id = randomUUID();
    expect(() => normalizeLines([{ accountId: id, side: 'DEBIT', amount: '1.00' }])).toThrow(LedgerInputError);
    expect(() => normalizeLines([{ accountId: id, side: 'DEBIT', amount: '1.00' }, { accountId: id, side: 'CREDIT', amount: '1.00' }])).toThrow(LedgerInputError);
    expect(() => normalizeLines([{ accountId: randomUUID(), side: 'DEBIT', amount: '1.00' }, { accountId: randomUUID(), side: 'DEBIT', amount: '1.00' }])).toThrow(LedgerInputError);
    expect(() => normalizeLines([{ accountId: randomUUID(), side: 'LEFT', amount: '1.00' }, { accountId: randomUUID(), side: 'CREDIT', amount: '1.00' }])).toThrow(LedgerInputError);
    expect(() => normalizeLines(Array.from({ length: 101 }, (_, k) => ({ accountId: randomUUID(), side: k % 2 ? 'CREDIT' : 'DEBIT', amount: '1.00' })))).toThrow(LedgerInputError);
  });
  test('hash differs by actor, operation and amount; canonical JSON rejects floats', () => {
    const body = { lines: [{ accountId: float, side: 'CREDIT', amount: '1.00' }] };
    const base = requestHash('POST', who, body);
    expect(requestHash('REVERSE', who, body)).not.toBe(base);
    expect(requestHash('POST', { type: 'SERVICE', id: randomUUID() }, body)).not.toBe(base);
    expect(requestHash('POST', who, { lines: [{ accountId: float, side: 'CREDIT', amount: '1.01' }] })).not.toBe(base);
    expect(() => canonicalJson({ amount: 0.1 })).toThrow(LedgerInputError);
  });
});

describe('PAY-01 service flow (fake transaction)', () => {
  test('invalid input is rejected before any transaction opens', async () => {
    const fake = fakeDb(() => undefined);
    const service = new LedgerService(fake.db, noEvents);
    const base = { idempotencyKey: `pay01:${randomUUID()}`, entryType: 'FLOAT_TOPUP' as const, trace, lines: topup() };
    await expect(service.post(tenant, who, { ...base, idempotencyKey: 'short' })).rejects.toThrow(LedgerInputError);
    await expect(service.post(tenant, who, { ...base, entryType: 'REVERSAL' as never })).rejects.toThrow(LedgerInputError);
    await expect(service.post(tenant, who, { ...base, lines: topup('720000') })).rejects.toThrow(LedgerInputError);
    await expect(service.post(tenant, who, { ...base, claimId: 'claim-1' })).rejects.toThrow(LedgerInputError);
    await expect(service.post(tenant, { type: 'ROOT' as never, id: randomUUID() }, base)).rejects.toThrow(LedgerInputError);
    await expect(service.reverse(tenant, who, { idempotencyKey: base.idempotencyKey, entryId: randomUUID(), reasonCode: 'free text', trace })).rejects.toThrow(LedgerInputError);
    await expect(service.openAccount(tenant, who, { purpose: 'INSURER_FLOAT', currency: 'USD', trace })).rejects.toThrow(LedgerInputError);
    expect(fake.transactions()).toBe(0);
  });

  test('replay with the same request returns the stored entry; a different request conflicts', async () => {
    const key = `pay01:${randomUUID()}`, entryId = randomUUID();
    const hash = requestHash('POST', who, { entryType: 'FLOAT_TOPUP', claimId: null, paymentId: null,
      lines: normalizeLines(topup()).map(l => ({ accountId: l.accountId, side: l.side, amount: l.amount })) });
    const fake = fakeDb(sql => {
      if (sql.includes('WHERE e.idempotency_key')) return [{ entry_id: entryId }];
      if (sql.includes('FROM tpa.journal_entries e WHERE e.id')) return [{ entry_id: entryId, entry_type: 'FLOAT_TOPUP', status: 'POSTED',
        reverses_entry_id: null, reason_code: null, claim_id: null, payment_id: null, request_hash: hash, posted_at: '2026-11-27T00:00:00.000Z' }];
      return undefined;
    });
    const service = new LedgerService(fake.db, noEvents);
    const replay = await service.post(tenant, who, { idempotencyKey: key, entryType: 'FLOAT_TOPUP', trace: { correlationId: randomUUID(), causationId: randomUUID() }, lines: [...topup()].reverse() });
    expect(replay).toMatchObject({ kind: 'POSTED', replayed: true, entry: { entryId } });
    expect(fake.calls.some(c => /INSERT INTO tpa\.journal/.test(c.sql))).toBe(false);
    await expect(service.post(tenant, who, { idempotencyKey: key, entryType: 'FLOAT_TOPUP', trace, lines: topup('999999.99') }))
      .rejects.toThrow(LedgerIdempotencyConflict);
  });

  test('insufficient funds posts nothing, audits nothing and emits nothing', async () => {
    const events: LedgerEventDraft[] = [];
    const fake = fakeDb(sql => {
      if (sql.includes('FOR UPDATE')) return [accountRow(float, 'INSURER_FLOAT', 'CREDIT', '100.00'), accountRow(bank, 'SETTLEMENT_BANK', 'DEBIT', '100.00')];
      if (sql.includes('bool_and(ok)')) return [{ balanced: true }];
      if (sql.includes('a.balance - x.amt < 0')) return [{ account_id: float, purpose: 'INSURER_FLOAT', currency: 'VND', available_balance: '100.00', requested_amount: '720000.00' }];
      return undefined;
    });
    const service = new LedgerService(fake.db, async (_tx, e) => { events.push(e); });
    const result = await service.post(tenant, who, { idempotencyKey: `pay01:${randomUUID()}`, entryType: 'PAYOUT_SETTLE', trace,
      lines: [{ accountId: float, side: 'DEBIT', amount: '720000.00' }, { accountId: bank, side: 'CREDIT', amount: '720000.00' }] });
    expect(result).toEqual({ kind: 'INSUFFICIENT_FUNDS', replayed: false, shortfalls: [{ accountId: float, purpose: 'INSURER_FLOAT',
      currency: 'VND', availableBalance: '100.00', requestedAmount: '720000.00' }] });
    expect(fake.calls.some(c => /INSERT INTO tpa\.journal|append_audit/.test(c.sql))).toBe(false);
    expect(events).toEqual([]);
    // Locks are taken by the advisory key lock first, then accounts in stable id order.
    const lockIndex = fake.calls.findIndex(c => c.sql.includes('FOR UPDATE'));
    expect(fake.calls.findIndex(c => c.sql.includes('pg_advisory_xact_lock'))).toBeLessThan(lockIndex);
    expect(fake.calls[lockIndex].values[0]).toEqual([float, bank].sort());
  });

  test('a commit-time ledger constraint failure (23514) surfaces as LedgerInvariantError', async () => {
    const dbError = Object.assign(new Error('Journal entry is not balanced per currency'), { code: '23514' });
    const fake = fakeDb(() => [{ id: randomUUID() }], dbError);
    const service = new LedgerService(fake.db, noEvents);
    await expect(service.getAccount(tenant, randomUUID())).rejects.toThrow(LedgerInvariantError);
  });
});
