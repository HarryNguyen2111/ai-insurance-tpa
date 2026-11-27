import assert from 'node:assert/strict';
import test from 'node:test';
import { draftHasPendingWork, draftKey, keyBelongsTo, scopeKey } from './scope.ts';
import { SYNTHETIC_PROFILE, WS } from '../fixtures/workspaces.ts';
import { PERSONAL } from './context-ring.ts';

const P = SYNTHETIC_PROFILE.principalId;

test('scope key = principal + context + service + entity + version', () => {
  assert.equal(scopeKey({ principalId: P, contextId: WS.A, service: 'TPA_INSURANCE' }, 'claims', 3), `v1|${P}|${WS.A}|TPA_INSURANCE|claims|3`);
});

test('keys never collide across tenants, services or the personal context', () => {
  const keys = new Set([
    scopeKey({ principalId: P, contextId: WS.A, service: 'TPA_INSURANCE' }, 'home', 1),
    scopeKey({ principalId: P, contextId: WS.B, service: 'TPA_INSURANCE' }, 'home', 1),
    scopeKey({ principalId: P, contextId: WS.A, service: 'LOYALTY360' }, 'home', 1),
    scopeKey({ principalId: P, contextId: PERSONAL, service: 'PERSONAL_LOYALTY' }, 'home', 1),
  ]);
  assert.equal(keys.size, 4);
});

test('draft stays bound to the tenant where it was started', () => {
  const k = draftKey(P, WS.A);
  assert.ok(keyBelongsTo(k, P, WS.A));
  assert.ok(!keyBelongsTo(k, P, WS.B));
  assert.ok(!keyBelongsTo(k, P, PERSONAL));
});

test('pending work = files picked or draft saved', () => {
  assert.equal(draftHasPendingWork(undefined), false);
  assert.equal(draftHasPendingWork({ docType: 'X', files: [], saved: false }), false);
  assert.equal(draftHasPendingWork({ docType: 'X', files: [], saved: true }), true);
  assert.equal(draftHasPendingWork({ docType: 'X', files: [{ key: 'k', name: 'a.heic', sizeKb: '1 KB', ok: true, isHeic: true, reasonVi: '' }], saved: false }), true);
});
