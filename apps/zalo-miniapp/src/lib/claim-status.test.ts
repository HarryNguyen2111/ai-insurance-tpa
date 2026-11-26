import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAIM_STATUSES, TRACKER_STEPS, statusView } from './claim-status.ts';

test('every OpenAPI ClaimStatus has a Vietnamese customer view inside the tracker range', () => {
  assert.equal(CLAIM_STATUSES.length, 14);
  for (const s of CLAIM_STATUSES) {
    const v = statusView(s);
    assert.ok(v.labelVi.length > 0, s);
    assert.ok(v.step >= 0 && v.step < TRACKER_STEPS.length, s);
  }
});

test('internal triage lanes are not disclosed to the customer', () => {
  const neutral = statusView('AI_PROCESSING').labelVi;
  assert.equal(statusView('FRAUD_HOLD').labelVi, neutral);
  assert.equal(statusView('DOCTOR_REVIEW').labelVi, neutral);
  assert.equal(statusView('GREEN_STP').labelVi, neutral);
  assert.doesNotMatch(statusView('FRAUD_HOLD').labelVi, /gian lận|trục lợi|fraud/i);
});

test('EOB_READY and SUPPLEMENT_REQUIRED call for customer action; PAID completes the tracker', () => {
  assert.equal(statusView('EOB_READY').tone, 'action');
  assert.equal(statusView('SUPPLEMENT_REQUIRED').tone, 'action');
  assert.equal(statusView('PAID').step, TRACKER_STEPS.length - 1);
});
