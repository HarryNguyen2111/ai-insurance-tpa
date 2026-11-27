import assert from 'node:assert/strict';
import test from 'node:test';
import { PERSONAL, contextRing, nextInRing, quickSwitchEnabled, stableMemberships } from './context-ring.ts';
import { SYNTHETIC_MEMBERSHIPS, WS } from '../fixtures/workspaces.ts';

const { A, B, C } = SYNTHETIC_MEMBERSHIPS;

test('ring = PERSONAL first, then memberships by Vietnamese display name; input order is irrelevant', () => {
  assert.deepEqual(contextRing([C, A, B]), [PERSONAL, WS.A, WS.B, WS.C]);
  assert.deepEqual(contextRing([B, C, A]), [PERSONAL, WS.A, WS.B, WS.C]);
});

test('ties on display name fall back to the immutable membershipId (deterministic)', () => {
  const twin = { ...B, membershipId: '00000000-0000-4000-8000-000000000001', workspace: { ...B.workspace, displayName: A.workspace.displayName } };
  assert.deepEqual(stableMemberships([A, twin]).map((m) => m.membershipId), [twin.membershipId, A.membershipId]);
  assert.deepEqual(stableMemberships([twin, A]).map((m) => m.membershipId), [twin.membershipId, A.membershipId]);
});

test('round robin wraps through the personal entry: P → A → B → C → P', () => {
  const ring = contextRing([A, B, C]);
  let cur: string = PERSONAL;
  const seen = [];
  for (let i = 0; i < 5; i++) {
    cur = nextInRing(ring, cur);
    seen.push(cur);
  }
  assert.deepEqual(seen, [WS.A, WS.B, WS.C, PERSONAL, WS.A]);
});

test('0 memberships: only personal, no gesture; 1 membership: personal ⇄ tenant', () => {
  assert.deepEqual(contextRing([]), [PERSONAL]);
  assert.equal(quickSwitchEnabled(contextRing([])), false);
  const one = contextRing([A]);
  assert.equal(quickSwitchEnabled(one), true);
  assert.equal(nextInRing(one, PERSONAL), WS.A);
  assert.equal(nextInRing(one, WS.A), PERSONAL);
});

test('an entry removed by an authoritative refresh is not in the ring; unknown current restarts at personal', () => {
  const after = contextRing([A, C]);
  assert.ok(!after.includes(WS.B));
  assert.equal(nextInRing(after, WS.A), WS.C);
  assert.equal(nextInRing(after, WS.B), PERSONAL);
});
