import assert from 'node:assert/strict';
import test from 'node:test';
import { admissionOverlaps, daycareBenefit, hospitalIncomeDays, prePostAdmissionSuggestion } from '../src/waterfall/index.ts';

// Synthetic example terms only; real values come from approved BEN-01 contract versions.
const C = '00000000-0000-4000-8000-000000000001';
const VN = 7 * 60;
const nights = { clauseId: C, dayBasis: 'NIGHTS' as const }, full = { clauseId: C, dayBasis: 'FULL_24H' as const };
const daycare = { clauseId: C, maxHours: 24, withoutSurgery: 'OUTPATIENT' as const };
const prePost = { clauseId: C, beforeDays: 30, afterDays: 30, icdGroupingVersion: { id: 'icd-group-v1', version: 1, hash: 'c'.repeat(64) } };
const days = (r: ReturnType<typeof hospitalIncomeDays>) => (r.kind === 'DAYS' ? r.days : r.reason);

test('HOSPITAL_INCOME: configurable nights vs floor(hours/24)', () => {
  assert.equal(days(hospitalIncomeDays('2026-11-01T22:00+07:00', '2026-11-02T08:00+07:00', nights, VN)), 1);
  assert.equal(days(hospitalIncomeDays('2026-11-01T22:00+07:00', '2026-11-02T08:00+07:00', full, VN)), 0);
  assert.equal(days(hospitalIncomeDays('2026-11-01T08:00+07:00', '2026-11-04T07:59+07:00', full, VN)), 2);
  assert.equal(days(hospitalIncomeDays('2026-11-01T08:00+07:00', '2026-11-04T07:59+07:00', nights, VN)), 3);
  // Same instants written in UTC give the same local-night count.
  assert.equal(days(hospitalIncomeDays('2026-11-01T15:00Z', '2026-11-02T01:00Z', nights, VN)), 1);
  assert.equal(days(hospitalIncomeDays('2026-11-01T08:00+07:00', '2026-11-04T07:59+07:00', undefined, VN)), 'MISSING_TERM_hospitalIncome');
  assert.throws(() => hospitalIncomeDays('2026-11-02T08:00+07:00', '2026-11-01T08:00+07:00', full, VN), { name: 'WaterfallInputError' });
  assert.throws(() => hospitalIncomeDays('2026-11-01T08:00', '2026-11-02T08:00+07:00', full, VN), { name: 'WaterfallInputError' });
});

test('approved admission intervals cannot overlap (closed interval) -> review list', () => {
  const approved = [
    { claimId: 'c-1', admit: '2026-10-01T08:00+07:00', discharge: '2026-10-05T08:00+07:00' },
    { claimId: 'c-2', admit: '2026-10-10T08:00+07:00', discharge: '2026-10-12T08:00+07:00' },
  ];
  assert.deepEqual(admissionOverlaps({ claimId: 'new', admit: '2026-10-04T08:00+07:00', discharge: '2026-10-11T08:00+07:00' }, approved), ['c-1', 'c-2']);
  assert.deepEqual(admissionOverlaps({ claimId: 'new', admit: '2026-10-05T08:00+07:00', discharge: '2026-10-06T08:00+07:00' }, approved), ['c-1']);
  assert.deepEqual(admissionOverlaps({ claimId: 'new', admit: '2026-10-06T08:00+07:00', discharge: '2026-10-09T08:00+07:00' }, approved), []);
  assert.deepEqual(admissionOverlaps({ claimId: 'c-1', admit: '2026-10-01T08:00+07:00', discharge: '2026-10-05T08:00+07:00' }, approved), []);
});

test('daycare < maxHours without surgery certificate becomes OUTPATIENT', () => {
  assert.deepEqual(daycareBenefit('2026-11-01T08:00+07:00', '2026-11-01T18:00+07:00', false, daycare), { kind: 'OUTPATIENT', clauseId: C });
  assert.deepEqual(daycareBenefit('2026-11-01T08:00+07:00', '2026-11-01T18:00+07:00', true, daycare), { kind: 'UNCHANGED' });
  assert.deepEqual(daycareBenefit('2026-11-01T08:00+07:00', '2026-11-02T08:00+07:00', false, daycare), { kind: 'UNCHANGED' });
  assert.deepEqual(daycareBenefit('2026-11-01T08:00+07:00', '2026-11-01T18:00+07:00', false, { ...daycare, withoutSurgery: 'REVIEW' }), { kind: 'REVIEW', reason: 'DAYCARE_WITHOUT_SURGERY' });
  assert.deepEqual(daycareBenefit('2026-11-01T08:00+07:00', '2026-11-01T18:00+07:00', false, undefined), { kind: 'REVIEW', reason: 'MISSING_TERM_daycare' });
});

test('pre/post admission window with same versioned ICD group suggests merge only', () => {
  const s = (visitDate: string, extra = {}) => prePostAdmissionSuggestion({ visitDate, admitDate: '2026-11-10', dischargeDate: '2026-11-15',
    visitIcdGroup: 'J18', admissionIcdGroup: 'J18', groupingVersionId: 'icd-group-v1', ...extra }, prePost).kind;
  assert.equal(s('2026-10-11'), 'SUGGEST_MERGE_INPATIENT');
  assert.equal(s('2026-10-10'), 'NONE');
  assert.equal(s('2026-12-15'), 'SUGGEST_MERGE_INPATIENT');
  assert.equal(s('2026-12-16'), 'NONE');
  assert.equal(s('2026-11-20', { visitIcdGroup: 'K35' }), 'NONE');
  assert.equal(s('2026-11-20', { visitIcdGroup: undefined }), 'REVIEW');
  assert.equal(s('2026-11-20', { groupingVersionId: 'icd-group-v0' }), 'REVIEW');
  assert.equal(prePostAdmissionSuggestion({ visitDate: '2026-11-20', admitDate: '2026-11-10', dischargeDate: '2026-11-15' }, undefined).kind, 'REVIEW');
  assert.throws(() => s('2026-02-30'), { name: 'WaterfallInputError' });
});
