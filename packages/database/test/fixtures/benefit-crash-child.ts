// TEST ONLY: synthetic crash subject for benefit-accounts.integration.test.ts. It
// writes a reservation (account update, movement, audit, outbox) inside an open
// tenant transaction, prints the fixed CRASH_POINT marker and hangs holding the
// account lock until the parent SIGKILLs it. Never prints connection data or input.
import { appendOutboxEvent } from '../../src/outbox.ts';
import { createTenantDatabase, type TenantTransaction } from '../../src/tenant.ts';

const { TPA_CRASH_DATABASE_URL: connectionString, TPA_CRASH_INPUT: input } = process.env;
if (!connectionString || !input) process.exit(2);
const { tenantId, actor, request } = JSON.parse(input);
const ben = await import(new URL('../../../../apps/core-api/src/benefit-accounts/benefit-accounts.ts', import.meta.url).href);
const db = createTenantDatabase({ connectionString, max: 2, connectionTimeoutMillis: 5000 });
const hang = () => new Promise<never>(() => { setInterval(() => {}, 1 << 30); });
const service = new ben.BenefitAccountsService(db, async (tx: TenantTransaction, draft: Parameters<typeof appendOutboxEvent>[1]) => {
  await appendOutboxEvent(tx, draft);
  process.stdout.write('CRASH_POINT\n'); // Everything written, nothing committed.
  return hang();
});
try { await service.acquire(tenantId, actor, request); } catch { process.exit(3); }
process.exit(4);
