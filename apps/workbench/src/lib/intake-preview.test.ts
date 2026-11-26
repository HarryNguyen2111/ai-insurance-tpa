import assert from 'node:assert/strict';
import test from 'node:test';
import example from '../../../../docs/ai-specs/examples/intake-form-health-outpatient.example.json' with { type: 'json' };
import { availabilityOf, buildIntakePreview, evaluateCondition, UnsupportedPreviewError, type IntakeFormConfig } from './intake-preview.ts';

const config = example as unknown as IntakeFormConfig;

test('preview mirrors the approved spec example: 3 steps, every field placed once', () => {
  const preview = buildIntakePreview(config);
  assert.equal(preview.formKey, 'health_outpatient_v1');
  assert.deepEqual(preview.steps.map(s => s.stepKey), ['evidence', 'visit', 'extra']);
  const placed = preview.steps.flatMap(s => s.fields.map(f => f.key));
  assert.deepEqual([...placed].sort(), config.fields.map(f => f.key).sort());
  assert.equal(preview.eventLabel, 'Khám ngoại trú');
  assert.deepEqual(preview.benefitLabels, ['Ngoại trú', 'Nha khoa']);
});

test('with an empty local draft the accident step is hidden and submit-required fields are listed', () => {
  const preview = buildIntakePreview(config);
  const extra = preview.steps.find(s => s.stepKey === 'extra')!;
  assert.equal(extra.visible, false);
  assert.deepEqual(preview.missingAtSubmit, ['insured_person', 'invoice_docs', 'visit_date', 'total_requested', 'visit_reason']);
});

test('choosing ACCIDENT reveals the step, the referral note and makes accident_date required', () => {
  const preview = buildIntakePreview(config, { visit_reason: 'ACCIDENT' });
  const extra = preview.steps.find(s => s.stepKey === 'extra')!;
  assert.equal(extra.visible, true);
  const field = (k: string) => preview.steps.flatMap(s => s.fields).find(f => f.key === k)!;
  assert.equal(field('referral_note').visible, true);
  assert.equal(field('accident_date').requiredAtSubmit, true);
  assert.equal(field('has_police_report').visible, false, 'needs accident_date IS_SET');
  assert.ok(preview.missingAtSubmit.includes('accident_date'));
  const withDate = buildIntakePreview(config, { visit_reason: 'ACCIDENT', accident_date: '2026-11-20' });
  assert.equal(withDate.steps.flatMap(s => s.fields).find(f => f.key === 'has_police_report')!.visible, true);
});

test('FOLLOW_UP shows the extra step but hides accident-only fields (hidden is not required)', () => {
  const preview = buildIntakePreview(config, { visit_reason: 'FOLLOW_UP' });
  const extra = preview.steps.find(s => s.stepKey === 'extra')!;
  assert.equal(extra.visible, true);
  assert.ok(extra.fields.every(f => !f.visible && !f.requiredAtSubmit));
});

test('only structured extension fields are editable locally; canonical/PII/document fields wait for backend', () => {
  const byKey = new Map(config.fields.map(f => [f.key, availabilityOf(f).kind]));
  assert.equal(byKey.get('visit_reason'), 'LOCAL_DRAFT');
  assert.equal(byKey.get('accident_date'), 'LOCAL_DRAFT');
  assert.equal(byKey.get('has_police_report'), 'LOCAL_DRAFT');
  assert.equal(byKey.get('referral_note'), 'INFO');
  for (const k of ['insured_person', 'invoice_docs', 'prescription_docs', 'narrative', 'visit_date', 'provider', 'diagnosis', 'total_requested']) {
    assert.equal(byKey.get(k), 'NEEDS_BACKEND', k);
  }
  const docs = availabilityOf(config.fields.find(f => f.key === 'invoice_docs')!);
  assert.ok(docs.kind === 'NEEDS_BACKEND' && docs.dependency.includes('#26'));
});

test('condition evaluator handles combinators and fails closed on ops owned by intake-rules', () => {
  assert.equal(evaluateCondition({ any: [{ field: 'a', op: 'EQ', value: 'X' }, { not: { field: 'b', op: 'IS_SET' } }] }, { a: 'Y' }), true);
  assert.equal(evaluateCondition({ field: 'a', op: 'NOT_IN', value: ['X'] }, {}), false);
  assert.equal(evaluateCondition({ field: 'a', op: 'NEQ', value: 'X' }, { a: 'Y' }), true);
  assert.throws(() => evaluateCondition({ field: 'm', op: 'GT', value: '1.00' }, { m: '2.00' }), UnsupportedPreviewError);
  const deep = { not: { not: { not: { not: { field: 'a', op: 'IS_SET' } } } } };
  assert.throws(() => evaluateCondition(deep, {}), UnsupportedPreviewError);
});

test('unknown components or dangling field references are rejected instead of rendered', () => {
  const bad = structuredClone(config);
  bad.fields[0]!.component = 'HTML_EMBED';
  assert.throws(() => buildIntakePreview(bad), UnsupportedPreviewError);
  const dangling = structuredClone(config);
  dangling.steps[0]!.fieldKeys.push('ghost');
  assert.throws(() => buildIntakePreview(dangling), UnsupportedPreviewError);
});
