import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTenantDatabase } from '../src/tenant.ts';

test('reject invalid tenant identifiers before connecting; expose no raw pool', async () => {
  const db = createTenantDatabase({ host: '127.0.0.1', port: 1, connectionTimeoutMillis: 100 });
  assert.deepEqual(Object.keys(db).sort(), ['close', 'withTenantTransaction']);
  try {
    for (const value of ['', 'tenant-a', "'; COMMIT; --", '00000000-0000-0000-0000-00000000000Z']) {
      await assert.rejects(db.withTenantTransaction(value, async () => assert.fail('callback must not run')), /verified tenant UUID/);
    }
  } finally { await db.close(); }
});
