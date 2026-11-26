import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildEventEnvelope, EventContractError } from '@tpa/event-contracts';
import {
  assertInboxHandler, discardParkedEvent, processInboxEvent, replayParkedEvents, ReplayDeniedError, safeErrorName,
  type InboxHandler, type ReplayAuthorizer,
} from '../src/inbox.ts';
import type { TenantDatabase } from '../src/tenant.ts';

// Real transactional behaviour is in inbox.integration.test.ts (PG16) and the event-worker e2e.
const untouchable: TenantDatabase = {
  withTenantTransaction() { throw new Error('database must not be touched'); },
  async close() {},
};
const handler: InboxHandler = { consumerName: 'synthetic-projection', owner: 'platform-events', eventTypes: ['claim.state-changed'],
  ordering: 'aggregate-version', async apply() {} };
const tenant = randomUUID();
const envelope = (eventType = 'claim.state-changed') => buildEventEnvelope(tenant, { eventType, aggregateId: randomUUID(), aggregateVersion: 1,
  correlationId: randomUUID(), causationId: randomUUID(), payload: eventType === 'claim.submitted' ? {} : { fromStatus: 'SUBMITTED', toStatus: 'PAID' } }).envelope;

test('handler definitions are validated', () => {
  assertInboxHandler(handler);
  for (const bad of [{ ...handler, consumerName: 'X' }, { ...handler, owner: '' }, { ...handler, eventTypes: [] },
    { ...handler, ordering: 'random' }, { ...handler, apply: undefined }, { ...handler, reconcile: 'nope' }]) {
    assert.throws(() => assertInboxHandler(bad as never), /Invalid inbox handler/);
  }
});

test('error names are sanitized; messages are never kept', () => {
  assert.equal(safeErrorName(new TypeError('0912345678 leaked')), 'TypeError');
  const custom = new Error('x'); custom.name = 'Name with PII 079123456789';
  assert.equal(safeErrorName(custom), 'Error');
  assert.equal(safeErrorName('string thrown'), 'Error');
});

test('unhandled event types are ignored without a transaction; invalid envelopes are rejected', async () => {
  assert.deepEqual(await processInboxEvent(untouchable, handler, envelope('claim.submitted')), { kind: 'ignored' });
  await assert.rejects(processInboxEvent(untouchable, handler, { ...envelope(), payload: { note: 'free text' } }), EventContractError);
});

test('replay/discard authorization fails closed before any database access', async () => {
  const actorId = randomUUID();
  const denials: (ReplayAuthorizer | undefined)[] = [
    async () => false, async () => 'yes' as never, async () => { throw new Error('idp down'); }, undefined,
  ];
  for (const authorize of denials) {
    await assert.rejects(replayParkedEvents(untouchable, handler, tenant, { actorId }, authorize as ReplayAuthorizer), ReplayDeniedError);
    await assert.rejects(discardParkedEvent(untouchable, tenant, handler.consumerName, randomUUID(), actorId, authorize as ReplayAuthorizer), ReplayDeniedError);
  }
  const allow: ReplayAuthorizer = async () => true;
  await assert.rejects(replayParkedEvents(untouchable, handler, tenant, { actorId: 'not-a-uuid' }, allow), ReplayDeniedError);
  await assert.rejects(replayParkedEvents(untouchable, handler, 'tenant', { actorId }, allow), ReplayDeniedError);
  const seen: unknown[] = [];
  await assert.rejects(replayParkedEvents(untouchable, handler, tenant, { actorId }, async r => { seen.push(r); return true; }), /must not be touched/);
  assert.deepEqual(seen, [{ action: 'event.replay', tenantId: tenant, consumerName: 'synthetic-projection', actorId }],
    'authorizer receives the exact action scope');
});
