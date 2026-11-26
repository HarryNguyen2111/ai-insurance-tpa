import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type pg from 'pg';
import {
  canonicalJson, executeIdempotent, IdempotencyOwnershipLostError, normalizeIdempotencyOptions, requestHash,
  validateIdempotencyScope, validateIdempotentResponse, type IdempotencyScope,
} from '../src/idempotency.ts';
import type { TenantDatabase, TenantTransaction } from '../src/tenant.ts';

const scope: IdempotencyScope = { operation: 'syntheticCreate', actorType: 'USER', actorId: randomUUID(), key: 'synthetic-key-0000000001' };
const vector = { amount: '720000.00', lines: [{ code: 'B', qty: 2 }, { code: 'A', qty: 1 }], note: 'Việt\n"', flag: true, none: null };

test('canonical JSON v1 is key-order independent, array-order sensitive and byte exact', () => {
  assert.equal(canonicalJson(vector), '{"amount":"720000.00","flag":true,"lines":[{"code":"B","qty":2},{"code":"A","qty":1}],"none":null,"note":"Việt\\n\\""}');
  const reordered = { none: null, note: 'Việt\n"', flag: true, lines: [{ qty: 2, code: 'B' }, { qty: 1, code: 'A' }], amount: '720000.00' };
  assert.equal(requestHash(reordered), requestHash(vector));
  // Independently verified with sha256sum over the documented canonical bytes.
  assert.equal(requestHash(vector), '068287343a488b07ac3ea5d86b0d0965cc7fc78d3a13a811c713284d442ae51e');
  assert.notEqual(requestHash({ ...vector, lines: [...vector.lines].reverse() }), requestHash(vector));
  assert.notEqual(requestHash({ ...vector, amount: '720000.0' }), requestHash(vector), 'money strings are not numerically normalised');
  assert.notEqual(requestHash({ v: 'é' }), requestHash({ v: 'é' }), 'no Unicode normalisation');
  assert.equal(canonicalJson(Object.assign(Object.create(null), { b: 1, a: 2 })), '{"a":2,"b":1}');
  assert.equal(canonicalJson(-0), '0');
});

test('canonical JSON rejects floats, non-JSON values and hostile shapes without echoing input', () => {
  const marker = 'SYNTHETIC_PII_MARKER';
  for (const value of [1.5, Number.NaN, Infinity, 2 ** 53, undefined, () => marker, Symbol(marker), 10n,
    new Date(), new Map(), [1, , 3], { [Symbol(marker)]: 1 }, { nested: { amount: 0.1 } }, { marker: undefined }]) {
    assert.throws(() => canonicalJson(value), (error: Error) => error.message === 'Invalid idempotency request');
  }
  let deep: unknown = 'leaf';
  for (let i = 0; i < 70; i++) deep = [deep];
  assert.throws(() => canonicalJson(deep), /Invalid idempotency request/);
});

test('scope, options and stored response are validated at the boundary', () => {
  validateIdempotencyScope(scope);
  for (const bad of [
    { ...scope, key: 'short-key-15chr' }, { ...scope, key: 'k'.repeat(101) }, { ...scope, key: 'has space key 0001' },
    { ...scope, key: '0987654321/phone' }, { ...scope, operation: 'CreateClaim' }, { ...scope, operation: 'create-claim' },
    { ...scope, actorType: 'ADMIN' as IdempotencyScope['actorType'] }, { ...scope, actorId: 'not-a-uuid' },
    { ...scope, actorId: scope.actorId.toUpperCase() },
  ]) assert.throws(() => validateIdempotencyScope(bad), /^Error: Invalid idempotency (key|operation|actor)$/);
  validateIdempotencyScope({ ...scope, key: 'A'.repeat(16) });
  validateIdempotencyScope({ ...scope, key: 'a.b_c:d-e'.padEnd(100, '9') });
  assert.deepEqual(normalizeIdempotencyOptions(), { retentionSeconds: 86_400, leaseSeconds: 30 });
  for (const bad of [{ retentionSeconds: 86_399 }, { retentionSeconds: 7_776_001 }, { leaseSeconds: 0 },
    { leaseSeconds: 3_601 }, { leaseSeconds: 1.5 }]) assert.throws(() => normalizeIdempotencyOptions(bad));
  assert.equal(validateIdempotentResponse({ status: 201, body: { amount: '720000.00' } }), '{"amount":"720000.00"}');
  assert.equal(validateIdempotentResponse({ status: 422, body: { code: 'DOMAIN_VIOLATION' } }), '{"code":"DOMAIN_VIOLATION"}');
  for (const bad of [{ status: 500, body: {} }, { status: 199, body: {} }, { status: 201.5, body: {} },
    { status: 201, body: { amount: 720000.5 } }, { status: 201, body: 'x'.repeat(60_001) }]) {
    assert.throws(() => validateIdempotentResponse(bad as never), /Invalid idempotency response/);
  }
});

/** Scripted fake: proves executor control flow only. Real SQL/locking is covered by the PG16 integration suite. */
function fakeDatabase(script: { lockRows?: number; completeRows?: number; failRelease?: boolean }) {
  const calls: string[] = [];
  const db: TenantDatabase = {
    async withTenantTransaction<T>(_tenant: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      calls.push('BEGIN');
      const tx: TenantTransaction = {
        async query<R extends pg.QueryResultRow>(text: string): Promise<pg.QueryResult<R>> {
          const kind = text.trimStart().startsWith('INSERT') ? 'insert' : text.includes('FOR UPDATE') ? 'lock'
            : text.includes("state = 'COMPLETED'") ? 'complete' : text.includes('owner_token = NULL, lease_expires_at = now()') ? 'release' : 'other';
          calls.push(kind);
          if (kind === 'release' && script.failRelease) throw new Error('synthetic release failure');
          const rowCount = kind === 'insert' ? 1 : kind === 'lock' ? script.lockRows ?? 1 : kind === 'complete' ? script.completeRows ?? 1 : 1;
          const rows = kind === 'insert' ? [{ attempt: 1 }] : kind === 'complete' ? [{ response_status: 201, response_body: { ok: 'yes' } }] : [];
          return { rows, rowCount } as unknown as pg.QueryResult<R>;
        },
      };
      try { const value = await fn(tx); calls.push('COMMIT'); return value; }
      catch (error) { calls.push('ROLLBACK'); throw error; }
    },
    close: async () => {},
  };
  return { db, calls };
}
const tenant = randomUUID();

test('executor: success commits effect and completion together in one owned transaction', async () => {
  const { db, calls } = fakeDatabase({});
  const outcome = await executeIdempotent(db, tenant, scope, vector, async () => ({ status: 201, body: { ok: 'yes' } }));
  assert.deepEqual(outcome, { kind: 'executed', response: { status: 201, body: { ok: 'yes' } }, attempt: 1 });
  assert.deepEqual(calls, ['BEGIN', 'insert', 'COMMIT', 'BEGIN', 'lock', 'complete', 'COMMIT']);
});

test('executor: thrown effect rolls back, releases ownership and rethrows the original error', async () => {
  const { db, calls } = fakeDatabase({});
  await assert.rejects(executeIdempotent(db, tenant, scope, vector, async () => { throw new Error('synthetic effect failure'); }),
    /synthetic effect failure/);
  assert.deepEqual(calls, ['BEGIN', 'insert', 'COMMIT', 'BEGIN', 'lock', 'ROLLBACK', 'BEGIN', 'release', 'COMMIT']);
  const failing = fakeDatabase({ failRelease: true });
  await assert.rejects(executeIdempotent(failing.db, tenant, scope, vector, async () => { throw new Error('synthetic effect failure'); }),
    /synthetic effect failure/, 'release failure must not mask the original error');
});

test('executor: invalid response (5xx/float) is never stored and releases ownership', async () => {
  const { db, calls } = fakeDatabase({});
  await assert.rejects(executeIdempotent(db, tenant, scope, vector, async () => ({ status: 503, body: {} })), /Invalid idempotency response/);
  assert.deepEqual(calls.slice(-5), ['lock', 'ROLLBACK', 'BEGIN', 'release', 'COMMIT']);
  assert.ok(!calls.includes('complete'));
});

test('executor: lost ownership runs no effect, does not release a new owner, and rolls back', async () => {
  for (const script of [{ lockRows: 0 }, { completeRows: 0 }]) {
    const { db, calls } = fakeDatabase(script);
    let effects = 0;
    await assert.rejects(executeIdempotent(db, tenant, scope, vector, async () => { effects++; return { status: 201, body: {} }; }),
      (error: unknown) => error instanceof IdempotencyOwnershipLostError);
    assert.equal(effects, script.lockRows === 0 ? 0 : 1);
    assert.equal(calls.at(-1), 'ROLLBACK');
    assert.ok(!calls.includes('release'));
  }
});

test('executor validates scope and payload before touching the database', async () => {
  const { db, calls } = fakeDatabase({});
  await assert.rejects(executeIdempotent(db, tenant, { ...scope, key: 'short' }, vector, async () => ({ status: 201, body: {} })), /Invalid idempotency key/);
  await assert.rejects(executeIdempotent(db, tenant, scope, { amount: 1.1 }, async () => ({ status: 201, body: {} })), /Invalid idempotency request/);
  assert.deepEqual(calls, []);
});
