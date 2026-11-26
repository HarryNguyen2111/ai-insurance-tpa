// TEST ONLY: synthetic crash subject for idempotency.integration.test.ts. The parent
// SIGKILLs this process after it prints the fixed CRASH_POINT marker. It never
// prints connection data, keys or payloads.
import { beginIdempotent, executeIdempotent, requestHash, type IdempotentEffect } from '../../src/idempotency.ts';
import { createTenantDatabase } from '../../src/tenant.ts';

const { TPA_CRASH_DATABASE_URL: connectionString, TPA_CRASH_MODE: mode, TPA_CRASH_INPUT: input } = process.env;
if (!connectionString || !mode || !input) process.exit(2);
const { tenant, scope, request, label, leaseSeconds } = JSON.parse(input);
const db = createTenantDatabase({ connectionString, max: 2, connectionTimeoutMillis: 5000 });
const crashPoint = () => process.stdout.write('CRASH_POINT\n');
const hang = () => new Promise<never>(() => { setInterval(() => {}, 1 << 30); });
const insert: IdempotentEffect = async tx => {
  await tx.query('INSERT INTO tpa.isolation_parent VALUES (tpa.current_tenant_id(), gen_random_uuid(), $1)', [label]);
  return { status: 201, body: { label, phase: 'child' } };
};

try {
  if (mode === 'after-begin') {
    await db.withTenantTransaction(tenant, tx => beginIdempotent(tx, scope, requestHash(request), { leaseSeconds }));
    crashPoint();
    await hang();
  } else if (mode === 'during-effect') {
    await executeIdempotent(db, tenant, scope, request, async (tx, context) => {
      await insert(tx, context);
      crashPoint(); // Effect row written but uncommitted; the row lock is held.
      return hang();
    }, { leaseSeconds });
  } else if (mode === 'after-commit') {
    await executeIdempotent(db, tenant, scope, request, insert, { leaseSeconds });
    crashPoint(); // Committed; the client never received the response.
    await hang();
  } else process.exit(2);
} catch {
  process.exit(3);
}
