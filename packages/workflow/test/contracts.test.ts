import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readSchema } from '@tpa/event-contracts';
import {
  assertClaimCommand, assertClaimRef, assertTransitionRequest, CLAIM_STATUSES, claimWorkflowId, commandIdForEvent,
  isClaimWorkflowId, TERMINAL_STATUSES, WorkflowContractError,
} from '../src/contracts.ts';

const MARKER = 'PT17-MARKER-079123456789';

test('ClaimStatus codes equal the event registry (spec 03) and terminal codes are a subset', () => {
  const schema = readSchema('claim.state-changed', '1.0.0') as { properties: { payload: { properties: { toStatus: { enum: string[] } } } } };
  assert.deepEqual([...CLAIM_STATUSES], schema.properties.payload.properties.toStatus.enum);
  assert.ok(TERMINAL_STATUSES.every(s => CLAIM_STATUSES.includes(s)));
});

test('stable ids: claim/{tenant}/{claim} and evt-{eventId}', () => {
  const [tenantId, claimId, eventId] = [randomUUID(), randomUUID(), randomUUID()];
  assert.equal(claimWorkflowId({ tenantId, claimId }), `claim/${tenantId}/${claimId}`);
  assert.equal(claimWorkflowId({ tenantId, claimId }), claimWorkflowId({ tenantId, claimId }), 'deterministic');
  assert.ok(isClaimWorkflowId(claimWorkflowId({ tenantId, claimId })));
  assert.equal(commandIdForEvent(eventId), `evt-${eventId}`);
  for (const bad of [eventId.toUpperCase(), 'evt', MARKER]) assert.throws(() => commandIdForEvent(bad), WorkflowContractError);
  assert.throws(() => claimWorkflowId({ tenantId: tenantId.toUpperCase(), claimId }), WorkflowContractError);
});

test('validators accept references/codes only and never echo rejected values', () => {
  const [tenantId, claimId, eventId] = [randomUUID(), randomUUID(), randomUUID()];
  const command = { commandId: commandIdForEvent(eventId), transition: 'SUBMITTED', causationEventId: eventId, aggregateVersion: 1 };
  assertClaimRef({ tenantId, claimId });
  assertClaimCommand(command);
  assertTransitionRequest({ tenantId, claimId, workflowId: claimWorkflowId({ tenantId, claimId }), commandId: command.commandId, transition: 'PAID' });
  const rejects: [(v: unknown) => void, unknown][] = [
    [assertClaimRef, { tenantId, claimId, memberName: MARKER }],
    [assertClaimRef, { tenantId: MARKER, claimId }],
    [assertClaimCommand, { ...command, note: MARKER }],
    [assertClaimCommand, { ...command, transition: MARKER }],
    [assertClaimCommand, { ...command, aggregateVersion: 0 }],
    [assertClaimCommand, { ...command, aggregateVersion: 1.5 }],
    [assertTransitionRequest, { tenantId, claimId, workflowId: claimWorkflowId({ tenantId: randomUUID(), claimId }), commandId: command.commandId, transition: 'PAID' }],
    [assertTransitionRequest, { tenantId, claimId, workflowId: claimWorkflowId({ tenantId, claimId }), commandId: command.commandId, transition: 'PAID', phone: MARKER }],
  ];
  for (const [assertFn, value] of rejects) {
    assert.throws(() => assertFn(value), (e: unknown) => e instanceof WorkflowContractError && !e.message.includes(MARKER));
  }
});
