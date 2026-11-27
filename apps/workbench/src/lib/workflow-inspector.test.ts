import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isWorkflowEdge, type EditorDocument, type WorkflowContent } from './workflow-definition.ts';
import { normalizeLayout, removeElements, replaceNode } from './workflow-graph.ts';
import { buildCondition, conditionParts, guardChoices, leafProblem, localIssues, locate, newLeaf, serverIssues, withOp, withVariable } from './workflow-inspector.ts';
import { TEMPLATES } from './workflow-templates.ts';

const example = (): WorkflowContent => JSON.parse(readFileSync(new URL('../../../../docs/ai-specs/examples/visual-workflow-intake-review.example.json', import.meta.url), 'utf8'));
const doc = (): EditorDocument => normalizeLayout({ content: example(), layout: { nodes: {}, edges: {} } });
const keyed = (d: EditorDocument) => localIssues(d).map(i => `${i.nodeId ?? i.edgeId ?? 'wf'}:${i.field ?? ''}:${i.code}`).sort();

test('approved example has no local issues (no blanket success is implied: this is feedback only)', () => {
  assert.deepEqual(localIssues(doc()), []);
});

test('typed inspector validations are keyed to node + field with a user-facing message', () => {
  const d = doc(), human = d.content.nodes.find(n => n.nodeId === 'confirm_extraction')!;
  assert.equal(human.type, 'HUMAN_TASK');
  if (human.type !== 'HUMAN_TASK') return;
  const broken = replaceNode(d, { ...human, label: '<b>x</b>', sla: { ...human.sla, dueSeconds: 60 }, allowedEvidence: { documentTypes: [], sources: ['OCR'] } });
  const issues = localIssues(broken);
  assert.deepEqual(issues.map(i => `${i.nodeId}:${i.field}:${i.code}`).sort(), [
    'confirm_extraction:allowedEvidence.documentTypes:REQUIRED', 'confirm_extraction:label:INVALID_FORMAT', 'confirm_extraction:sla.dueSeconds:OUT_OF_RANGE',
  ]);
  assert.ok(issues.every(i => i.message && i.severity === 'error' && i.source === 'local'));
});

test('incomplete drafts still get graph/routing feedback (not just SCHEMA_INVALID)', () => {
  const d = removeElements(doc(), [], ['e_escalate']);
  const human = d.content.nodes.find(n => n.nodeId === 'confirm_extraction')!;
  const incomplete = human.type === 'HUMAN_TASK' ? replaceNode(d, { ...human, sla: { ...human.sla, dueSeconds: 0 } }) : d;
  const codes = keyed(incomplete);
  assert.ok(codes.includes('confirm_extraction:sla.dueSeconds:OUT_OF_RANGE'));
  assert.ok(codes.includes('confirm_extraction::MISSING_ACTION_ROUTE'));
});

test('workflow-level and edge-level problems point at their fields', () => {
  const d = doc();
  d.content.title = ''; d.content.scope.benefitTypes = ['HOSPITAL_INCOME'];
  const e = d.content.edges.find(x => x.edgeId === 'e_retry_ai')!;
  if (e.guard.kind === 'CONDITION') e.guard = { ...e.guard, priority: 0, condition: { variable: 'CLAIM_BENEFIT_TYPE', op: 'GT', value: 3 } };
  assert.deepEqual(keyed(d), ['e_retry_ai:guard.condition.0:CONDITION_TYPE_MISMATCH', 'e_retry_ai:guard.priority:OUT_OF_RANGE', 'wf:scope.benefitTypes:SCOPE_NOT_APPROVED', 'wf:title:INVALID_FORMAT']);
});

test('server report paths map to node/edge + field of the validated revision', () => {
  const c = example();
  assert.deepEqual(locate('/nodes/2/sla/dueSeconds', c), { nodeId: 'confirm_extraction', field: 'sla.dueSeconds' });
  assert.deepEqual(locate('/edges/8/guard/condition', c), { edgeId: 'e_retry_ai', field: 'guard.condition' });
  assert.deepEqual(locate('/nodes/1/modelRef', c), { nodeId: 'ai_extract', field: 'modelRef' });
  assert.deepEqual(locate('/assignmentPolicy/rules/0/candidateRoles', c), { field: 'rule.reviewer_queue.candidateRoles' });
  assert.deepEqual(locate('/nodes/99', c), {});
  const [issue] = serverIssues({ issues: [{ detailCode: 'REFERENCE_NOT_PUBLISHED', path: '/nodes/1/promptRef', nodeId: 'ai_extract' }] }, c);
  assert.deepEqual({ ...issue, message: !!issue.message }, { code: 'REFERENCE_NOT_PUBLISHED', severity: 'error', source: 'server', path: '/nodes/1/promptRef', nodeId: 'ai_extract', field: 'promptRef', message: true });
});

test('condition builder only produces contract-valid guards and type-checks variable/op/value', () => {
  const leaf = newLeaf('CLAIM_BENEFIT_TYPE');
  assert.deepEqual(leaf, { variable: 'CLAIM_BENEFIT_TYPE', op: 'EQ', value: 'OUTPATIENT' });
  const inLeaf = withOp(leaf, 'IN');
  assert.deepEqual(inLeaf.value, ['OUTPATIENT']);
  assert.deepEqual(withOp(inLeaf, 'NEQ').value, 'OUTPATIENT');
  const count = withVariable(inLeaf, 'EXTRACTION_QUALITY_FLAG_COUNT');
  assert.deepEqual(count, { variable: 'EXTRACTION_QUALITY_FLAG_COUNT', op: 'LTE', value: 0 });
  assert.deepEqual(withVariable(count, 'SUPPLEMENT_ROUND'), { ...count, variable: 'SUPPLEMENT_ROUND' });
  assert.equal(leafProblem({ variable: 'SUPPLEMENT_ROUND', op: 'IN', value: 1 } as never), 'Phép so sánh không dùng được với biến này.');
  assert.equal(leafProblem({ variable: 'SUPPLEMENT_ROUND', op: 'LT', value: 1001 }), 'Nhập số nguyên 0–1000.');
  assert.equal(leafProblem(inLeaf), null);
  for (const mode of ['single', 'all', 'any'] as const) {
    const condition = buildCondition(mode, [count, inLeaf]);
    assert.ok(isWorkflowEdge({ edgeId: 'x1', source: 'a1', target: 'b1', guard: { kind: 'CONDITION', priority: 1, condition } }), mode);
    assert.equal(conditionParts(condition).mode, mode);
  }
  assert.equal((buildCondition('all', Array(7).fill(count)) as { all: unknown[] }).all.length, 5);
  assert.throws(() => buildCondition('any', []), /CONDITION_REQUIRED/);
});

test('guard choices follow the source step type (no free-form guards)', () => {
  const c = example(), by = (id: string) => guardChoices(c.nodes.find(n => n.nodeId === id)).map(g => g.value);
  assert.deepEqual(by('start'), ['NEXT']);
  assert.deepEqual(by('ai_extract'), ['OUTCOME:SUCCEEDED', 'OUTCOME:FAILED']);
  assert.deepEqual(by('wait_supplement'), ['OUTCOME:RECEIVED', 'OUTCOME:EXPIRED']);
  assert.deepEqual(by('supplement_round'), ['CONDITION', 'DEFAULT']);
  assert.deepEqual(by('confirm_extraction'), ['ACTION:CONFIRM_EXTRACTION', 'ACTION:REQUEST_SUPPLEMENT', 'ACTION:ESCALATE_TO_MANUAL_REVIEW']);
  assert.deepEqual(by('end_manual'), []);
});

test('templates: spec example is verbatim; skeleton routes are complete and only policy placeholders are reported', () => {
  const [skeleton, spec, blank] = TEMPLATES.map(t => t.build());
  assert.deepEqual(spec.content, example());
  assert.deepEqual(localIssues(spec), []);
  assert.deepEqual(localIssues(blank), []);
  assert.deepEqual(keyed(skeleton), [
    'ai_extract:allowedEvidence.documentTypes:REQUIRED', 'ai_extract:allowedEvidence.sources:REQUIRED', 'ai_extract:modelRef:PLACEHOLDER_REFERENCE',
    'ai_extract:policyRef:PLACEHOLDER_REFERENCE', 'ai_extract:promptRef:PLACEHOLDER_REFERENCE', 'ai_extract:serviceActorScopeKey:PLACEHOLDER_REFERENCE',
    'ai_extract:timeoutSeconds:OUT_OF_RANGE', 'confirm_extraction:allowedEvidence.documentTypes:REQUIRED', 'confirm_extraction:allowedEvidence.sources:REQUIRED',
    'confirm_extraction:sla.dueSeconds:OUT_OF_RANGE', 'wait_supplement:maxWaitSeconds:OUT_OF_RANGE',
  ]);
  assert.notEqual(skeleton.content.workflowKey, spec.content.workflowKey);
});
