import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { NODE_TYPES, canonicalJson, newDocument, newNode, validateLocal, type WorkflowContent } from './workflow-definition.ts';
import { checkXmlEnvelope, MAX_XML_BYTES, toBpmnXml } from './workflow-bpmn.ts';

const example = (): WorkflowContent => JSON.parse(readFileSync(new URL('../../../../docs/ai-specs/examples/visual-workflow-intake-review.example.json', import.meta.url), 'utf8'));
const codes = (content: unknown) => validateLocal(content).map(i => i.detailCode);

test('minimal graph and the approved synthetic supplement loop satisfy local validation', () => {
  assert.deepEqual(validateLocal(newDocument().content), []);
  assert.deepEqual(validateLocal(example()), []);
});
test('palette has exactly seven VWF node types; fresh human/AI/timer/wait require explicit configuration', () => {
  assert.deepEqual([...NODE_TYPES].sort(), ['AI_ACTIVITY', 'CONDITION', 'END', 'HUMAN_TASK', 'START', 'SUPPLEMENT_WAIT', 'TIMER']);
  for (const type of ['AI_ACTIVITY', 'HUMAN_TASK', 'TIMER', 'SUPPLEMENT_WAIT'] as const) {
    const c = newDocument().content; c.nodes.push(newNode(type, 'new_step'));
    assert.ok(codes(c).includes('SCHEMA_INVALID'), type);
  }
});
test('missing accountable owner, unknown fields, tenantId, and AI actions on human tasks fail closed', () => {
  for (const mutation of ['owner', 'tenant', 'script', 'ai-action']) {
    const c = example(), n = c.nodes.find(n => n.type === 'HUMAN_TASK')! as unknown as Record<string, unknown>;
    if (mutation === 'owner') delete n.accountableOwner;
    if (mutation === 'tenant') Object.assign(c, { tenantId: 'synthetic' });
    if (mutation === 'script') n.script = 'execute()';
    if (mutation === 'ai-action') n.allowedActionIds = ['PROPOSE_EXTRACTION'];
    assert.ok(codes(c).includes('SCHEMA_INVALID'), mutation);
  }
});
test('duplicate IDs, dangling edges, unreachable nodes and dead ends produce bounded path-only diagnostics', () => {
  const c = newDocument().content;
  c.nodes.push({ nodeId: 'orphan', type: 'CONDITION', label: 'Cô lập' }, { ...c.nodes[0] });
  c.edges[0].target = 'missing';
  const result = validateLocal(c);
  for (const code of ['DUPLICATE_ID', 'DANGLING_EDGE', 'UNREACHABLE_NODE', 'DEAD_END']) assert.ok(result.some(i => i.detailCode === code), code);
  assert.ok(!JSON.stringify(result).includes('Cô lập'));
});
test('human actions and both AI outcomes require unique valid routes', () => {
  const c = example();
  c.edges = c.edges.filter(e => e.edgeId !== 'e_confirm');
  c.edges.find(e => e.edgeId === 'e_ai_fail')!.target = 'start';
  c.edges.push({ ...c.edges[0], edgeId: 'duplicate_next' });
  for (const code of ['MISSING_ACTION_ROUTE', 'AI_FAILURE_NOT_ROUTED_TO_HUMAN', 'START_HAS_INCOMING', 'DUPLICATE_ROUTE']) assert.ok(codes(c).includes(code), code);
});
test('exclusive conditions require default branch, unique priority and typed operands', () => {
  const c = example(); c.edges = c.edges.filter(e => e.edgeId !== 'e_rounds_exhausted');
  const conditional = c.edges.find(e => e.edgeId === 'e_retry_ai')!;
  c.edges.push({ ...structuredClone(conditional), edgeId: 'duplicate_priority' });
  if (conditional.guard.kind === 'CONDITION') conditional.guard.condition = { variable: 'SUPPLEMENT_ROUND', op: 'EQ', value: 'OUTPATIENT' };
  for (const code of ['MISSING_DEFAULT_BRANCH', 'DUPLICATE_PRIORITY', 'CONDITION_TYPE_MISMATCH']) assert.ok(codes(c).includes(code), code);
});
test('removing loop bounds is rejected; bounds on non-condition sources are rejected', () => {
  const c = example(); delete c.edges.find(e => e.edgeId === 'e_retry_ai')!.loopBack;
  assert.ok(codes(c).includes('UNBOUNDED_LOOP'));
  c.edges[0].loopBack = { maxIterations: 1 };
  assert.ok(codes(c).includes('GUARD_NOT_ALLOWED_FOR_SOURCE'));
  c.edges[0].loopBack.maxIterations = 6;
  assert.ok(codes(c).includes('SCHEMA_INVALID'));
});
test('AI-only inner cycle is rejected even when outer cycle crosses a human and has a bound', () => {
  const c = example();
  c.nodes.push({ nodeId: 'auto_gate', type: 'CONDITION', label: 'Điều kiện tự động' });
  c.edges.find(e => e.edgeId === 'e_ai_fail')!.target = 'auto_gate';
  c.edges.push({ edgeId: 'auto_default', source: 'auto_gate', target: 'confirm_extraction', guard: { kind: 'DEFAULT' } },
    { edgeId: 'auto_retry', source: 'auto_gate', target: 'ai_extract', guard: { kind: 'CONDITION', priority: 1, condition: { variable: 'SUPPLEMENT_ROUND', op: 'LTE', value: 2 } }, loopBack: { maxIterations: 2 } });
  assert.ok(codes(c).includes('LOOP_WITHOUT_HUMAN_OR_WAIT'));
});
test('unknown assignment/group directories, non-human SoD targets, data dependencies and future scope fail closed', () => {
  const c = example(), human = c.nodes.find(n => n.type === 'HUMAN_TASK')!;
  for (const n of c.nodes) if ('outputSchemas' in n) n.outputSchemas = n.outputSchemas.filter(s => s !== 'DOCUMENT_LABELS');
  if (human.type === 'HUMAN_TASK') { human.assignmentRuleKey = 'missing'; human.inputSchemas.push('DOCUMENT_LABELS'); }
  c.assignmentPolicy.rules[0].candidateGroupKeys = ['unknown.group'];
  c.assignmentPolicy.rules[0].distinctFromNodeIds = ['ai_extract'];
  c.scope.benefitTypes = ['HOSPITAL_INCOME']; c.actionCatalogVersion = 99;
  for (const code of ['UNKNOWN_ASSIGNMENT_RULE', 'GROUP_DIRECTORY_UNAVAILABLE', 'INPUT_NOT_PRODUCED', 'SCOPE_NOT_APPROVED', 'CATALOG_VERSION_UNKNOWN']) assert.ok(codes(c).includes(code), code);
});
test('canonical serialization orders object keys, retains array order and measures UTF-8 content limits', () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');
  assert.equal(canonicalJson([2, 1]), '[2,1]');
  const c = newDocument().content; c.title = 'ă'.repeat(32769);
  assert.ok(codes(c).includes('LIMIT_EXCEEDED'));
});
test('XML envelope rejects entities, comments, processing instructions and byte bombs before parsing', () => {
  for (const input of ['<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x/>', '<x><!--hidden--></x>', '<?attack x?><x/>', '<x>\0</x>']) assert.throws(() => checkXmlEnvelope(input), /UNSAFE_XML/);
  assert.throws(() => checkXmlEnvelope('ă'.repeat(MAX_XML_BYTES / 2 + 1)), /LIMIT_EXCEEDED/);
  assert.doesNotThrow(() => checkXmlEnvelope(toBpmnXml(newDocument())));
});
test('BPMN projection escapes names and carries canonical tpa payloads separately from geometry', () => {
  const doc = newDocument(); doc.content.nodes[0].label = 'Nhãn & "tổng hợp"';
  const xml = toBpmnXml(doc);
  assert.ok(xml.includes('Nhãn &amp; &quot;tổng hợp&quot;'));
  assert.ok(xml.includes('tpa:metadata=') && xml.includes('tpa:node=') && xml.includes('tpa:edge='));
  assert.ok(!xml.includes('conditionExpression'));
});
