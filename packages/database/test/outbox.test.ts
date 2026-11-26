import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { EventContractError } from '@tpa/event-contracts';
import { commitDomainChange } from '../src/outbox.ts';
import type { TenantDatabase, TenantTransaction } from '../src/tenant.ts';

// Recording fake: the real transactional behaviour is covered by outbox.integration.test.ts.
function fakeDatabase(tenant: string) {
  const statements: string[] = [];
  let committed = false;
  const tx: TenantTransaction = {
    async query(text: string) {
      statements.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
      if (text.includes('current_tenant_id()::text AS tenant_id')) return { rows: [{ tenant_id: tenant }] } as never;
      if (text.includes('append_audit')) return { rows: [{ curr_hash: 'h' }] } as never;
      if (text.includes('INSERT INTO tpa.outbox_events')) return { rows: [{ seq: '1', partition_key: `${tenant}:${aggregate}` }] } as never;
      return { rows: [], rowCount: 1 } as never;
    },
  };
  const db: TenantDatabase = {
    async withTenantTransaction(_t, fn) { const value = await fn(tx); committed = true; return value; },
    async close() {},
  };
  return { db, statements, committed: () => committed };
}
const tenant = randomUUID();
const aggregate = randomUUID();
const audit = [{ entityType: 'CLAIM', entityId: aggregate, actorType: 'SYSTEM' as const, actorId: randomUUID(), action: 'SUBMIT', payload: {} }];
const event = { eventType: 'claim.submitted', aggregateId: aggregate, aggregateVersion: 1, correlationId: randomUUID(), causationId: randomUUID(), payload: {} };

test('commitDomainChange writes business, then audit, then outbox in one transaction', async () => {
  const { db, statements, committed } = fakeDatabase(tenant);
  const out = await commitDomainChange(db, tenant, async tx => {
    await tx.query('UPDATE tpa.business SET x=1');
    return { result: 'ok', audit, events: [event] };
  });
  assert.equal(out.result, 'ok');
  assert.equal(out.events[0].partitionKey, `${tenant}:${aggregate}`);
  assert.equal(out.events[0].envelope.tenantId, tenant);
  assert.deepEqual(statements.filter(s => !s.startsWith('SELECT tpa.current_tenant_id()::text')),
    ['UPDATE tpa.business SET', 'SELECT * FROM', 'INSERT INTO tpa.outbox_events']);
  assert.ok(committed());
});

test('commitDomainChange fails closed before any audit/outbox write', async () => {
  const cases: [string, unknown, RegExp][] = [
    ['no audit', { result: 1, audit: [], events: [event] }, /audit entry/],
    ['no events', { result: 1, audit, events: [] }, /outbox event/],
    ['invalid event', { result: 1, audit, events: [event, { ...event, payload: { note: 'free text' } }] }, /violates/],
  ];
  for (const [name, change, message] of cases) {
    const { db, statements } = fakeDatabase(tenant);
    await assert.rejects(commitDomainChange(db, tenant, async () => change as never),
      (e: unknown) => e instanceof EventContractError && message.test(e.message), name);
    assert.ok(!statements.some(s => /append_audit|INSERT INTO/.test(s) || s === 'SELECT * FROM'), `${name}: nothing appended`);
  }
});
