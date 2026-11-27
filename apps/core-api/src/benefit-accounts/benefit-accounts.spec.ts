import { randomInt, randomUUID } from 'node:crypto';
import {
  BenefitAccountsService, BenefitIdempotencyConflict, BenefitInputError, canonicalJson, lockOrder, positiveMoney, requestHash,
  type BenefitDatabase, type BenefitTransaction,
} from './benefit-accounts';

// Unit level only: PostgreSQL concurrency/fault behaviour (PT03) runs in
// packages/database/test/benefit-accounts.integration.test.ts on real PG16.
type Handler = (sql: string, values: unknown[]) => Record<string, unknown>[] | undefined;
function fakeDb(handler: Handler) {
  const calls: { sql: string; values: unknown[] }[] = [];
  let transactions = 0;
  const tx: BenefitTransaction = {
    async query(sql, values = []) { calls.push({ sql, values }); return { rows: handler(sql, values) ?? [] }; },
  };
  const db: BenefitDatabase = { async withTenantTransaction(_tenant, work) { transactions++; return work(tx); } };
  return { db, calls, transactions: () => transactions };
}
const tenant = randomUUID(), who = { type: 'SERVICE' as const, id: randomUUID() };
const trace = { correlationId: randomUUID(), causationId: randomUUID() };
const noEvents = async () => undefined;
const validMoney = () => {
  const digits = randomInt(1, 14); // up to 13 integer digits = NUMERIC(15,2)
  let int = String(randomInt(1, 10));
  for (let i = 1; i < digits; i++) int += String(randomInt(0, 10));
  return `${int}.${String(randomInt(0, 100)).padStart(2, '0')}`;
};

describe('BEN-03 money strings (Zero Float)', () => {
  test('property: 2000 random NUMERIC(15,2) strings are accepted unchanged', () => {
    for (let i = 0; i < 2000; i++) { const m = validMoney(); expect(positiveMoney(m, 'amount')).toBe(m); }
    expect(positiveMoney('0.01', 'amount')).toBe('0.01');
    expect(positiveMoney('9999999999999.99', 'amount')).toBe('9999999999999.99');
  });
  test.each([800000, 800000.5, '800000', '800000.0', '800000.000', '-1.00', '+1.00', '1e6', '0.00', '00.10', ' 1.00',
    '1.00 ', '10000000000000.00', '1,000.00', 'NaN', null, undefined, {}])('rejects %p', value => {
    expect(() => positiveMoney(value, 'amount')).toThrow(BenefitInputError);
  });
  test('property: random corruption of valid strings never passes', () => {
    for (let i = 0; i < 500; i++) {
      const m = validMoney();
      for (const bad of [m.slice(0, -1), `${m}0`, `-${m}`, m.replace('.', ','), `0${m}`]) {
        expect(() => positiveMoney(bad, 'amount')).toThrow(BenefitInputError);
      }
    }
  });
});

describe('BEN-03 stable lock ordering and request fingerprint', () => {
  test('property: any permutation yields the same lock order; duplicates are rejected', () => {
    const ids = Array.from({ length: 12 }, () => randomUUID());
    const expected = lockOrder(ids, 'id');
    for (let i = 0; i < 200; i++) {
      const shuffled = [...ids].sort(() => randomInt(0, 3) - 1);
      expect(lockOrder(shuffled, 'id')).toEqual(expected);
    }
    expect(() => lockOrder([ids[0], ids[1], ids[0]], 'id')).toThrow(BenefitInputError);
  });
  test('canonical JSON sorts keys and rejects floats', () => {
    expect(canonicalJson({ b: '1', a: [2, { d: 'x', c: 'y' }] })).toBe('{"a":[2,{"c":"y","d":"x"}],"b":"1"}');
    expect(() => canonicalJson({ amount: 0.1 })).toThrow(BenefitInputError);
  });
  test('acquire fingerprint ignores hold order and trace, but not amounts or actor', async () => {
    const hashes: string[] = [];
    const { db } = fakeDb((sql, values) => {
      if (sql.includes('INSERT INTO tpa.benefit_operations')) { hashes.push(values[2] as string); throw new Error('stop'); }
      return undefined;
    });
    const service = new BenefitAccountsService(db, noEvents);
    const [a, b] = [randomUUID(), randomUUID()], claimId = randomUUID(), operationKey = `acq:${randomUUID()}`;
    const base = { operationKey, claimId, ttlSeconds: 60, trace };
    const run = (holds: { accountId: string; amount: string }[], t = trace, by = who) =>
      service.acquire(tenant, by, { ...base, trace: t, holds }).catch(() => undefined);
    await run([{ accountId: a, amount: '800000.00' }, { accountId: b, amount: '1.00' }]);
    await run([{ accountId: b, amount: '1.00' }, { accountId: a, amount: '800000.00' }], { correlationId: randomUUID(), causationId: randomUUID() });
    await run([{ accountId: a, amount: '800000.01' }, { accountId: b, amount: '1.00' }]);
    await run([{ accountId: a, amount: '800000.00' }, { accountId: b, amount: '1.00' }], trace, { type: 'SERVICE', id: randomUUID() });
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
    expect(hashes[3]).not.toBe(hashes[0]);
    expect(hashes[0]).toBe(requestHash('ACQUIRE', who, { claimId, ttlSeconds: 60,
      holds: [a, b].sort().map(id => ({ accountId: id, amount: id === a ? '800000.00' : '1.00' })) }));
  });
});

describe('BEN-03 idempotency and validation before I/O', () => {
  test('invalid input never opens a tenant transaction', async () => {
    const { db, transactions } = fakeDb(() => undefined);
    const service = new BenefitAccountsService(db, noEvents);
    const holds = [{ accountId: randomUUID(), amount: '800000.00' }];
    const ok = { operationKey: `acq:${randomUUID()}`, claimId: randomUUID(), ttlSeconds: 60, trace, holds };
    const bad: unknown[] = [
      { ...ok, holds: [{ ...holds[0], amount: 800000 }] }, { ...ok, holds: [] }, { ...ok, holds: [holds[0], holds[0]] },
      { ...ok, operationKey: 'short' }, { ...ok, ttlSeconds: 0 }, { ...ok, ttlSeconds: 2_592_001 }, { ...ok, claimId: 'x' },
      { ...ok, trace: { correlationId: 'x', causationId: randomUUID() } },
    ];
    for (const input of bad) await expect(service.acquire(tenant, who, input as never)).rejects.toThrow(BenefitInputError);
    await expect(service.acquire('not-a-tenant', who, ok)).rejects.toThrow(BenefitInputError);
    await expect(service.consume(tenant, who, { operationKey: ok.operationKey, trace, items: [{ reservationId: randomUUID(), amount: '0.00' }] }))
      .rejects.toThrow(BenefitInputError);
    await expect(service.release(tenant, who, { operationKey: ok.operationKey, trace, reservationIds: [] })).rejects.toThrow(BenefitInputError);
    await expect(service.openAccount(tenant, who, { coverageId: randomUUID(), limitGroup: 'FAMILY' as never,
      periodStart: '2026-01-01', periodEnd: '2026-12-31', trace })).rejects.toThrow(BenefitInputError);
    await expect(service.openAccount(tenant, who, { coverageId: randomUUID(), limitGroup: 'ANNUAL',
      periodStart: '2026-02-30', periodEnd: '2026-12-31', trace })).rejects.toThrow(BenefitInputError);
    expect(transactions()).toBe(0);
  });
  test('same key + same request replays the stored result without touching accounts', async () => {
    const stored = { kind: 'INSUFFICIENT_LIMIT', shortfalls: [{ accountId: randomUUID(), requestedAmount: '800000.00',
      availableAmount: '200000.00', clauseId: randomUUID() }] };
    let hash = '';
    const { db, calls } = fakeDb((sql, values) => {
      if (sql.includes('INSERT INTO tpa.benefit_operations')) { hash = values[2] as string; return []; }
      if (sql.includes('FROM tpa.benefit_operations')) return [{ operation_type: 'ACQUIRE', request_hash: hash, result: stored }];
      throw new Error(`unexpected SQL ${sql}`);
    });
    const service = new BenefitAccountsService(db, noEvents);
    const result = await service.acquire(tenant, who, { operationKey: `acq:${randomUUID()}`, claimId: randomUUID(), ttlSeconds: 60,
      trace, holds: [{ accountId: stored.shortfalls[0].accountId, amount: '800000.00' }] });
    expect(result).toEqual({ ...stored, replayed: true });
    expect(calls.some(c => c.sql.includes('benefit_accounts'))).toBe(false);
  });
  test('same key with a different request or operation type is a conflict', async () => {
    for (const row of [{ operation_type: 'ACQUIRE', request_hash: 'f'.repeat(64) }, { operation_type: 'RELEASE', request_hash: null }]) {
      let hash = '';
      const { db } = fakeDb((sql, values) => {
        if (sql.includes('INSERT INTO tpa.benefit_operations')) { hash = values[2] as string; return []; }
        if (sql.includes('FROM tpa.benefit_operations')) return [{ ...row, request_hash: row.request_hash ?? hash, result: { kind: 'RESERVED' } }];
        return undefined;
      });
      const service = new BenefitAccountsService(db, noEvents);
      await expect(service.acquire(tenant, who, { operationKey: `acq:${randomUUID()}`, claimId: randomUUID(), ttlSeconds: 60, trace,
        holds: [{ accountId: randomUUID(), amount: '1.00' }] })).rejects.toThrow(BenefitIdempotencyConflict);
    }
  });
});
