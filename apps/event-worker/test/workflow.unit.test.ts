import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { buildEventEnvelope } from '@tpa/event-contracts';
import { createWorkflowHandler } from '../src/consumers/workflow.ts';
import type { TenantTransaction } from '@tpa/database/tenant';

test('bridge waits for durable acceptance and maps only reference/code fields with stable IDs', async () => {
  const event = buildEventEnvelope(randomUUID(), { eventType: 'claim.submitted', aggregateId: randomUUID(),
    aggregateVersion: 1, correlationId: randomUUID(), causationId: randomUUID(), payload: {} }).envelope;
  let accept!: () => void;
  const accepted = new Promise<void>(resolve => { accept = resolve; });
  const calls: unknown[] = [];
  const handler = createWorkflowHandler({ async submitClaimCommand(ref, command) {
    calls.push([ref, command]); await accepted; return { status: 'accepted', workflowId: 'synthetic', runId: 'synthetic' };
  } });
  let done = false;
  const run = handler.apply({} as TenantTransaction, event).then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false);
  accept(); await run;
  await handler.apply({} as TenantTransaction, event);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[0], [{ tenantId: event.tenantId, claimId: event.aggregateId }, {
    commandId: `evt-${event.eventId}`, causationEventId: event.eventId, aggregateVersion: 1, transition: 'SUBMITTED',
  }]);
});

test('Temporal failure propagates so the inbox transaction cannot commit', async () => {
  const handler = createWorkflowHandler({ async submitClaimCommand() { throw new Error('Unavailable'); } });
  const event = buildEventEnvelope(randomUUID(), { eventType: 'claim.state-changed', aggregateId: randomUUID(),
    aggregateVersion: 2, correlationId: randomUUID(), causationId: randomUUID(), payload: { fromStatus: 'SUBMITTED', toStatus: 'DOCTOR_REVIEW' } }).envelope;
  await assert.rejects(handler.apply({} as TenantTransaction, event), /Unavailable/);
});
