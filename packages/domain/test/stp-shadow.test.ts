import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateWaterfallEOB as calc } from '../src/waterfall/index.ts';
import { base } from './fixtures/input.ts';

// PT23_STP_SHADOW (unit level): eligibility recorded separately from execution.
test('PT23: GREEN_STP-eligible case in SHADOW records eligibility but still requires a person', () => {
  const r = calc(base({}, { stpExecutionMode: 'SHADOW' }));
  assert.deepEqual([r.triageLane, r.stp.eligible, r.stp.executionMode, r.stp.humanApprovalRequired], ['GREEN_STP', true, 'SHADOW', true]);
});
test('only ENABLED + eligible removes the human approval requirement', () => {
  assert.equal(calc(base({}, { stpExecutionMode: 'ENABLED' })).stp.humanApprovalRequired, false);
  assert.equal(calc(base({}, { stpExecutionMode: 'DISABLED' })).stp.humanApprovalRequired, true);
  const ineligible = calc(base({ fraudRiskScore: 50 }, { stpExecutionMode: 'ENABLED' }));
  assert.deepEqual([ineligible.stp.eligible, ineligible.stp.humanApprovalRequired, ineligible.triageLane], [false, true, 'YELLOW_REVIEW']);
});
