import assert from 'node:assert/strict';
import test from 'node:test';
import { Decimal } from 'decimal.js';
import { calculateWaterfallEOB as calc, type WaterfallInput } from '../src/waterfall/index.ts';
import { base, line } from './fixtures/input.ts';

const lines = (r: ReturnType<typeof calc>) => r.calculation!.lines.map(l => [l.lineId, l.approved, l.status]);
const invalid = (input: unknown) => assert.throws(() => calc(input as WaterfallInput), { name: 'WaterfallInputError' });

test('copay rounds ROUND_HALF_UP to whole VND (not banker/float)', () => {
  assert.deepEqual(lines(calc(base({ lines: [line('L1', '100001.00')] }, { copayInsurerPct: '50.00' }))), [['L1', '50001.00', 'PARTIAL']]);
  assert.deepEqual(lines(calc(base({ lines: [line('L1', '1.00')] }, { copayInsurerPct: '50.00' }))), [['L1', '1.00', 'APPROVED']]);
  assert.deepEqual(lines(calc(base({ lines: [line('L1', '0.99')] }, { copayInsurerPct: '50.00' }))), [['L1', '0.00', 'REJECTED']]);
  // Regression: rounding up at 100% must not approve more than requested.
  assert.deepEqual(lines(calc(base({ lines: [line('L1', '12345.56')] }))), [['L1', '12345.56', 'APPROVED']]);
  assert.deepEqual(lines(calc(base({ lines: [line('L1', '12345.56')] }, { copayInsurerPct: '99.99' }))), [['L1', '12344.00', 'PARTIAL']]);
  // 0.1 + 0.2 style float traps stay exact.
  const r = calc(base({ lines: [line('A', '0.10'), line('B', '0.20')] }));
  assert.equal(r.calculation!.totals.totalRequested, '0.30');
});

test('deductible is consumed across lines in invoice order, clause cited', () => {
  const r = calc(base({ lines: [line('L1', '500000.00'), line('L2', '400000.00')] }, { deductiblePerClaim: '600000.00' }));
  assert.deepEqual(lines(r), [['L1', '0.00', 'REJECTED'], ['L2', '300000.00', 'PARTIAL']]);
  assert.deepEqual(r.calculation!.lines[0].reductions, [{ step: 'DEDUCTIBLE', amount: '500000.00', contractClauseCited: 'Synthetic clause 2.1' }]);
  assert.match(r.calculation!.lines[1].explanationVi, /Mức khấu trừ: giảm 100000.00 VNĐ.*Căn cứ: Synthetic clause 2.1/);
  assert.ok(r.stp.blockers.includes('LINE_REJECTED'));
});

test('per-visit cap applies before annual cap and blocks STP', () => {
  const r = calc(base({ lines: [line('L1', '400000.00'), line('L2', '400000.00')] }, { perVisitLimit: '500000.00' }));
  assert.deepEqual(lines(r), [['L1', '400000.00', 'APPROVED'], ['L2', '100000.00', 'PARTIAL']]);
  assert.equal(r.calculation!.lines[1].reductions[0].step, 'VISIT_LIMIT');
  assert.equal(r.triageLane, 'YELLOW_REVIEW');
  assert.deepEqual(r.stp.blockers, ['LIMIT_CAPPED']);
});

test('explicit null per-visit limit means only the annual cap applies', () => {
  const r = calc(base({ lines: [line('L1', '3000000.00')] }, { perVisitLimit: null, stpAutoApproveLimit: '5000000.00' }));
  assert.deepEqual(lines(r), [['L1', '3000000.00', 'APPROVED']]);
  assert.equal(r.triageLane, 'GREEN_STP');
});

test('excluded line without approved clause routes review instead of rejecting', () => {
  const r = calc(base({ lines: [line('L1', '500000.00'), line('L2', '600000.00', { category: 'SUPPLEMENT_TPCN' })] }));
  const l2 = r.calculation!.lines[1];
  assert.deepEqual([l2.status, l2.approved, l2.rejected, l2.pendingReview, l2.aiFlag, l2.contractClauseCited],
    ['PENDING_REVIEW', '0.00', '0.00', '600000.00', 'TPCN_EXCLUDED', null]);
  assert.deepEqual(r.reviewReasons, ['MISSING_EXCLUSION_CLAUSE']);
  assert.equal(r.calculation!.totals.totalPendingReview, '600000.00');
  assert.equal(r.calculation!.lines[0].approved, '500000.00');
  assert.equal(r.triageLane, 'YELLOW_REVIEW');
});

test('COSMETIC is excluded with its clause and flagged TPCN_EXCLUDED', () => {
  const r = calc(base({ lines: [line('L1', '700000.00', { category: 'COSMETIC', exclusionClauseCited: 'Synthetic 5.4' })] }));
  const l = r.calculation!.lines[0];
  assert.deepEqual([l.status, l.rejected, l.aiFlag, l.contractClauseCited], ['REJECTED', '700000.00', 'TPCN_EXCLUDED', 'Synthetic 5.4']);
});

test('missing rule clause routes review with no amounts', () => {
  const r = calc(base({}, { contractClauseCited: '  ' }));
  assert.equal(r.calculation, null);
  assert.deepEqual(r.reviewReasons, ['MISSING_RULE_CLAUSE']);
  assert.equal(r.triageLane, 'YELLOW_REVIEW');
});

test('PRICE_ANOMALY boundary is strictly > 1.30x reference and never cuts money', () => {
  const at = calc(base({ lines: [line('L1', '130000.00', { referenceUnitPrice: '100000.00' })] }));
  assert.equal(at.calculation!.lines[0].aiFlag, 'NONE');
  assert.equal(at.triageLane, 'GREEN_STP');
  const above = calc(base({ lines: [line('L1', '130001.00', { referenceUnitPrice: '100000.00' })] }));
  assert.deepEqual([above.calculation!.lines[0].aiFlag, above.calculation!.lines[0].approved], ['PRICE_ANOMALY', '130001.00']);
  assert.deepEqual(above.stp.blockers, ['LINE_FLAGGED']);
});

test('ICD mismatch signal blocks STP only', () => {
  const r = calc(base({ lines: [line('L1', '500000.00', { icdMismatch: true })] }));
  assert.deepEqual([r.calculation!.lines[0].aiFlag, r.calculation!.lines[0].status, r.stp.blockers], ['ICD_MISMATCH', 'APPROVED', ['LINE_FLAGGED']]);
});

test('each of the five STP gates is individually enforced at its boundary', () => {
  const lane = (o: Partial<WaterfallInput>, rule = {}) => calc(base(o, rule)).stp.blockers;
  assert.deepEqual(lane({ benefitType: 'DENTAL' }), []);
  assert.deepEqual(lane({ benefitType: 'INPATIENT' }), ['BENEFIT_TYPE']);
  assert.deepEqual(lane({ lines: [line('L1', '2000000.00')] }), []);
  assert.deepEqual(lane({ lines: [line('L1', '2000000.01')] }, { perVisitLimit: null }), ['OVER_AUTO_APPROVE_LIMIT']);
  assert.deepEqual(lane({ taxVerifiedValid: false }), ['TAX_NOT_VERIFIED']);
  assert.deepEqual(lane({ isMergedSummary: true }), ['MERGED_SUMMARY']);
  assert.deepEqual(lane({ fraudRiskScore: 19 }), []);
  assert.deepEqual(lane({ fraudRiskScore: 20 }), ['FRAUD_SCORE']);
  assert.deepEqual(lane({ isChronicSpecial: true, daysActive: 365 }), ['CHRONIC_SPECIAL']);
  assert.deepEqual(lane({ daysActive: 30 }), []);
});

test('chronic special past waiting period is calculated but never STP', () => {
  const r = calc(base({ isChronicSpecial: true, daysActive: 400 }));
  assert.equal(r.calculation!.totals.totalApproved, '500000.00');
  assert.equal(r.triageLane, 'YELLOW_REVIEW');
});

test('eligibility gate gaps route review with no inferred amount', () => {
  const reasons = (o: Partial<WaterfallInput>, rule = {}) => { const r = calc(base(o, rule)); assert.equal(r.calculation, null); return r.reviewReasons; };
  assert.deepEqual(reasons({ daysActive: 29 }), ['WAITING_PERIOD_NORMAL_NOT_MET']);
  assert.deepEqual(reasons({ isChronicSpecial: true }, { waitingDaysSpecial: undefined }), ['MISSING_WAITING_DAYS_SPECIAL']);
  assert.deepEqual(reasons({ usedAnnualAmount: '10000000.01' }), ['USED_ANNUAL_EXCEEDS_LIMIT']);
  assert.deepEqual(reasons({ benefitType: 'HOSPITAL_INCOME' }), ['UNSUPPORTED_BENEFIT_CALCULATION']);
  assert.deepEqual(reasons({ provider: { policyStatus: 'BLACKLISTED' } }), ['MISSING_PROVIDER_EXCLUSION_CLAUSE']);
});

test('blacklisted provider with clause proposes full rejection for human review', () => {
  const r = calc(base({ provider: { policyStatus: 'BLACKLISTED', exclusionClauseRef: 'Synthetic 6.1' }, lines: [line('L1', '100.00'), line('L2', '200.00')] }));
  assert.deepEqual(lines(r), [['L1', '0.00', 'REJECTED'], ['L2', '0.00', 'REJECTED']]);
  assert.ok(r.calculation!.lines.every(l => l.contractClauseCited === 'Synthetic 6.1'));
  assert.deepEqual(r.reviewReasons, ['PROVIDER_BLACKLISTED']);
  assert.equal(r.calculation!.totals.totalRejected, '300.00');
  assert.equal(r.stp.humanApprovalRequired, true);
});

test('Zero Float: numbers, unscaled strings and malformed inputs are rejected', () => {
  invalid(base({ lines: [{ ...line('L1', '1.00'), requestedAmount: 720000 as unknown as string }] }));
  invalid(base({ lines: [line('L1', '720000')] }));
  invalid(base({ lines: [line('L1', '-1.00')] }));
  invalid(base({}, { copayInsurerPct: '100.01' }));
  invalid(base({}, { copayInsurerPct: 80 as unknown as string }));
  invalid(base({ lines: [line('L1', '1.00'), line('L1', '2.00')] }));
  invalid(base({ lines: [] }));
  invalid(base({ fraudRiskScore: 1.5 }));
  invalid(base({}, { ruleVersion: { id: 'x', version: 1, hash: 'nothex' } }));
  invalid(base({}, { stpExecutionMode: 'AUTO' as 'SHADOW' }));
});

test('pure and deterministic: no input mutation, stable hashes, global Decimal untouched', () => {
  const input = base({ lines: [line('L1', '500000.00'), line('L2', '1.00')] }, { copayInsurerPct: '80.00' });
  const before = structuredClone(input);
  const a = calc(input), b = calc(structuredClone(input));
  assert.deepEqual(input, before);
  assert.equal(a.outputHash, b.outputHash);
  assert.match(a.inputHash, /^[0-9a-f]{64}$/);
  const reordered = Object.fromEntries(Object.entries(input).reverse()) as unknown as WaterfallInput;
  assert.equal(calc(reordered).inputHash, a.inputHash);
  const other = calc({ ...input, rule: { ...input.rule, ruleVersion: { id: 'synthetic-rule', version: 2, hash: 'b'.repeat(64) } } });
  assert.notEqual(other.outputHash, a.outputHash);
  // Engine uses an isolated clone (precision 40); library defaults stay untouched.
  assert.deepEqual([Decimal.precision, Decimal.rounding], [20, Decimal.ROUND_HALF_UP]);
});
