import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateWaterfallEOB } from '../src/waterfall/index.ts';
import { golden, toWaterfallInput } from './fixtures/golden.ts';

const WATERFALL_CASES = ['TC01_OUTPATIENT_WITH_TPCN_COPAY_80', 'TC02_GREEN_STP_CLEAN_XML', 'TC03_ANNUAL_LIMIT_EXHAUSTED_CAP',
  'TC05_MERGED_XML_PUBLIC_HOSPITAL', 'TC06_WAITING_DAYS_CHRONIC_365'];
// TC04 is a preflight (ND70) case owned by the preflight task, not the waterfall.
const OWNED_ELSEWHERE = ['TC04_PREFLIGHT_ND70_COMPANY_ADDRESS'];
const TOTAL_KEYS: Record<string, string> = {
  total_requested: 'totalRequested', total_approved: 'totalApproved', total_rejected: 'totalRejected',
  remaining_annual_limit_after: 'remainingAnnualLimitAfter',
};

test('golden file case inventory is fully accounted for', () => {
  assert.deepEqual(golden().map(c => c.id).sort(), [...WATERFALL_CASES, ...OWNED_ELSEWHERE].sort());
});

for (const tc of golden().filter(c => WATERFALL_CASES.includes(c.id))) {
  test(`golden ${tc.id}`, () => {
    const result = calculateWaterfallEOB(toWaterfallInput(tc));
    const e = tc.expected;
    assert.equal(result.triageLane, e.triage_lane);
    for (const [key, field] of Object.entries(TOTAL_KEYS)) {
      if (e[key] !== undefined) assert.equal((result.calculation?.totals as any)?.[field], e[key], `${tc.id} ${key}`);
    }
    for (const [lineId, line] of Object.entries<Record<string, string>>(e.line_decisions ?? {})) {
      const actual = result.calculation!.lines.find(l => l.lineId === lineId)!;
      assert.equal(actual.approved, line.approved, `${tc.id} ${lineId} approved`);
      assert.equal(actual.status, line.status, `${tc.id} ${lineId} status`);
      if (line.ai_flag) assert.equal(actual.aiFlag, line.ai_flag, `${tc.id} ${lineId} ai_flag`);
    }
    // Contract-locked: every reduced/rejected line cites a clause and explains in Vietnamese.
    for (const l of result.calculation?.lines ?? []) {
      if (l.status !== 'APPROVED') { assert.ok(l.contractClauseCited, `${l.lineId} clause`); assert.ok(l.explanationVi.length > 0); }
    }
    // Golden asserts eligibility/routing; the production default SHADOW still needs a person.
    assert.equal(result.stp.executionMode, 'SHADOW');
    assert.equal(result.stp.humanApprovalRequired, true);
  });
}

test('TC03 limit cap routes review although approved > 0', () => {
  const r = calculateWaterfallEOB(toWaterfallInput(golden().find(c => c.id === 'TC03_ANNUAL_LIMIT_EXHAUSTED_CAP')!));
  assert.ok(r.stp.blockers.includes('LIMIT_CAPPED'));
  assert.deepEqual(r.calculation!.lines[0].reductions.map(x => [x.step, x.amount]), [['COPAY', '200000.00'], ['ANNUAL_LIMIT', '300000.00']]);
});

test('TC05 merged summary is routing only: amount approved, STP blocked', () => {
  const r = calculateWaterfallEOB(toWaterfallInput(golden().find(c => c.id === 'TC05_MERGED_XML_PUBLIC_HOSPITAL')!));
  assert.deepEqual(r.stp.blockers, ['MERGED_SUMMARY']);
});

test('TC06 is routing only: no rejection amount inferred', () => {
  const r = calculateWaterfallEOB(toWaterfallInput(golden().find(c => c.id === 'TC06_WAITING_DAYS_CHRONIC_365')!));
  assert.equal(r.calculation, null);
  assert.deepEqual(r.reviewReasons, ['WAITING_PERIOD_SPECIAL_NOT_MET']);
  assert.ok(r.stp.blockers.includes('CHRONIC_SPECIAL'));
});
