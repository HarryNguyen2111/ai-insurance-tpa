// VWF-01 (#78): visual claims workflow contract. Schema/contract evidence only: no endpoint, DB, Temporal
// workflow, identity or authorization is implemented or executed here. VW01–VW25 remain NOT EXECUTED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { validate } from '../src/validate.cjs';
import { validateWorkflow, checkBpmnElements, canonicalJson, contentHash, MAX_CANONICAL_BYTES } from './workflow-graph-oracle.mjs';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const spec = YAML.parse(read('../../../docs/ai-specs/02-openapi-contracts.yaml'));
const S = spec.components.schemas;
const doc = read('../../../docs/ai-specs/14-visual-claims-workflow.md');
const catalogDoc = JSON.parse(read('../../../docs/ai-specs/14a-visual-workflow-catalog.json'));
const cases = JSON.parse(read('../../../docs/ai-specs/14b-visual-workflow-acceptance-cases.json'));
const example = JSON.parse(read('../../../docs/ai-specs/examples/visual-workflow-intake-review.example.json'));
const baseline = JSON.parse(read('./pre-vwf1-baseline.json'));
const catalog = catalogDoc.actionCatalog;
const clone = () => structuredClone(example);
const ctx = { catalog };
const codes = (content, extra = {}) => validateWorkflow(content, { ...ctx, ...extra }).map(i => i.detailCode);
const node = (c, id) => c.nodes.find(n => n.nodeId === id);
const edge = (c, id) => c.edges.find(e => e.edgeId === id);
const dropEdge = (c, id) => { c.edges = c.edges.filter(e => e.edgeId !== id); };
const workflowSchemas = Object.keys(S).filter(n => n.startsWith('Workflow') && !n.startsWith('Workspace'));

const EXPECTED_OPS = {
  'GET /v1/admin/workflow-definitions': 'listWorkflowDefinitions',
  'POST /v1/admin/workflow-definitions': 'createWorkflowDraft',
  'GET /v1/admin/workflow-definitions/{definitionId}/versions': 'listWorkflowDefinitionVersions',
  'GET /v1/admin/workflow-definitions/{definitionId}/versions/{versionNo}': 'getWorkflowDefinitionVersion',
  'PUT /v1/admin/workflow-definitions/{definitionId}/versions/{versionNo}': 'updateWorkflowDraft',
  'POST /v1/admin/workflow-definitions/{definitionId}/versions/{versionNo}/validate': 'validateWorkflowDraft',
  'POST /v1/admin/workflow-definitions/{definitionId}/versions/{versionNo}/publish': 'publishWorkflowVersion',
  'POST /v1/admin/workflow-definitions/{definitionId}/versions/{versionNo}/revoke': 'revokeWorkflowVersion',
  'GET /v1/workflow/action-catalogs/{catalogVersion}': 'getWorkflowActionCatalog',
  'GET /v1/workflow/actor-scope': 'getWorkflowActorScope',
  'GET /v1/workflow/tasks': 'listWorkflowTasks',
  'GET /v1/workflow/tasks/{taskId}': 'getWorkflowTask',
  'POST /v1/workflow/tasks/{taskId}/claim': 'claimWorkflowTask',
  'POST /v1/workflow/tasks/{taskId}/reassign': 'reassignWorkflowTask',
  'POST /v1/workflow/tasks/{taskId}/actions': 'submitWorkflowTaskAction',
  'GET /v1/workflow/tasks/{taskId}/annotations': 'listWorkflowTaskAnnotations',
  'POST /v1/workflow/tasks/{taskId}/annotations': 'createWorkflowTaskAnnotation',
};
const opsFound = () => {
  const found = {};
  for (const [path, methods] of Object.entries(spec.paths)) for (const [m, op] of Object.entries(methods)) {
    if (/\/workflow/.test(path)) found[`${m.toUpperCase()} ${path}`] = op;
  }
  return found;
};

test('API 1.4.0 adds exactly the 17 VWF-01 operations; all bearer + membership context, mutations keyed and MFA-gated', () => {
  // NOTIF-01 (#107) made the API 1.5.0 additively; pre-notif1-baseline.json pins every 1.4.0 path/component.
  assert.equal(spec.info.version, '1.5.0');
  const found = opsFound();
  assert.deepEqual(Object.fromEntries(Object.entries(found).map(([k, op]) => [k, op.operationId])), EXPECTED_OPS);
  for (const [key, op] of Object.entries(found)) {
    const [m, path] = key.split(' ');
    assert.ok(!path.startsWith('/internal/'), 'AI/service paths are owned by #39, not VWF-01');
    assert.deepEqual(op.security ?? spec.security, [{ bearerAuth: [] }], key);
    assert.ok(op.parameters.some(p => p.$ref === '#/components/parameters/MembershipContext'), key);
    assert.match(op.description, /^VWF-01/, key);
    if (m !== 'GET') {
      assert.ok(op.parameters.some(p => p.$ref === '#/components/parameters/IdempotencyKey'), key);
      assert.match(op.description, /verified MFA/, `${key} requires MFA`);
      assert.match(op.description, /audit_logs .*outbox in one withTenantTransaction \(SET LOCAL/, key);
    }
    for (const p of op.parameters) {
      const param = p.$ref ? spec.components.parameters[p.$ref.split('/').pop()] : p;
      assert.doesNotMatch(param.name, /tenant/i, `${key} must not accept a tenant selector`);
    }
  }
  assert.equal(Object.keys(found).length, 17);
  assert.equal(workflowSchemas.length, 65);
  assert.ok(doc.includes('17 operation và 65 schema `Workflow*`'));
});

test('pre-VWF-01 snapshot: every 1.3.0 path, component and top-level block is byte-for-byte unchanged (additive only)', () => {
  const h = v => createHash('sha256').update(canonicalJson(v)).digest('hex');
  assert.equal(baseline.apiVersion, '1.3.0');
  for (const [k, hash] of Object.entries(baseline.topLevel)) assert.equal(h(spec[k]), hash, k);
  for (const [p, hash] of Object.entries(baseline.paths)) assert.equal(h(spec.paths[p]), hash, p);
  for (const [g, entries] of Object.entries(baseline.components)) for (const [n, hash] of Object.entries(entries)) {
    assert.equal(h(spec.components[g][n]), hash, `${g}.${n}`);
  }
  // Notification* schemas were added after 1.4.0 and are pinned by notification-contracts.test.mjs.
  const added = Object.keys(S).filter(n => !(n in baseline.components.schemas) && !n.startsWith('Notification'));
  assert.deepEqual(added.sort(), [...workflowSchemas].sort(), 'only Workflow* schemas are new');
  assert.deepEqual(S.Membership.properties.roles.items.enum, ['MEMBER', 'GUARDIAN', 'CLAIM_REVIEWER', 'INSURER_REVIEWER', 'FINANCE', 'CURATOR'], 'C1 roles untouched');
});

test('tenant denial at the contract boundary: no Workflow schema carries or accepts a tenant identifier', () => {
  const walk = (node, path, seen = new Set()) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return [];
    seen.add(node);
    const hits = node.properties && Object.keys(node.properties).some(k => /tenant/i.test(k)) ? [path] : [];
    return hits.concat(...Object.entries(node).map(([k, v]) => walk(v, `${path}.${k}`, seen)));
  };
  for (const name of workflowSchemas) assert.deepEqual(walk(S[name], name), [], name);
  const requests = JSON.parse(read('./workflow-fixtures.json')).filter(f => f.valid && /Request$|Action$|Content$/.test(f.schema));
  assert.ok(requests.length >= 10);
  for (const f of requests) assert.equal(validate(f.schema, { ...f.value, tenantId: '00000000-0000-4000-8000-000000000099' }), false, f.name);
});

test('14a action catalog: validates, matches the closed enums and grants no claim/EOB/payment authority', () => {
  assert.equal(validate('WorkflowActionCatalog', catalog), true);
  const ids = catalog.actions.map(a => a.actionId);
  assert.deepEqual([...ids].sort(), [...S.WorkflowActionId.enum].sort());
  const human = catalog.actions.filter(a => a.actorKind === 'HUMAN');
  const ai = catalog.actions.filter(a => a.actorKind === 'AI_SERVICE');
  assert.deepEqual(human.filter(a => a.completesTask).map(a => a.actionId).sort(), [...S.WorkflowTaskActionId.enum].sort());
  assert.deepEqual(ai.map(a => a.actionId).sort(), [...S.WorkflowAiActionId.enum].sort());
  for (const a of human) { assert.equal(a.requiresMfa, true, a.actionId); assert.deepEqual(a.nodeTypes, ['HUMAN_TASK']); }
  for (const a of ai) {
    assert.deepEqual(a.allowedRelationships, ['AI_SCOPE_BINDING'], a.actionId);
    assert.equal(a.businessEffect, 'EVIDENCE_ONLY', a.actionId);
    assert.equal(a.completesTask, false, a.actionId);
    assert.equal(a.requiresEvidence, true, a.actionId);
  }
  const enums = JSON.stringify(workflowSchemas.map(n => S[n]));
  for (const forbidden of ['APPROVE', 'REJECT_CLAIM', 'PAYMENT', 'PAYOUT', 'PUBLISH_EOB', 'OTP']) {
    assert.doesNotMatch(enums.replace(/APPROVED_?/g, ''), new RegExp(`"[A-Z_]*${forbidden}[A-Z_]*"`), forbidden);
  }
});

test('14a operation authorization matrix covers every operation; AI denied on all bearer APIs; mutations need MFA', () => {
  const matrix = catalogDoc.operationAuthorization;
  assert.deepEqual(matrix.map(m => m.operationId).sort(), Object.values(EXPECTED_OPS).sort());
  const roles = new Set(S.WorkflowStaffRole.enum);
  const ops = Object.fromEntries(Object.entries(opsFound()).map(([k, op]) => [op.operationId, k.split(' ')[0]]));
  for (const m of matrix) {
    assert.equal(m.aiServiceActor, 'DENIED', m.operationId);
    for (const r of m.workflowRoles) assert.ok(roles.has(r), `${m.operationId} ${r}`);
    assert.ok(m.workflowRoles.length > 0, m.operationId);
    assert.equal(m.requiresMfa, ops[m.operationId] !== 'GET', `${m.operationId} MFA iff mutation`);
    if (m.catalogActionId) {
      const entry = catalog.actions.find(a => a.actionId === m.catalogActionId);
      assert.ok(entry && entry.actorKind === 'HUMAN', m.operationId);
      for (const r of entry.allowedRelationships) assert.ok(m.relationships.includes(r), `${m.operationId} ${r}`);
    }
    assert.ok(doc.includes(`\`${m.operationId}\``), `spec 14 documents ${m.operationId}`);
  }
  const publish = matrix.find(m => m.operationId === 'publishWorkflowVersion');
  assert.deepEqual(publish.workflowRoles, ['WORKFLOW_PUBLISHER']);
  assert.deepEqual(publish.separationOfDuties, ['PUBLISHER_NOT_DRAFT_CREATOR_OR_EDITOR']);
  assert.ok(!matrix.find(m => m.operationId === 'createWorkflowDraft').workflowRoles.includes('WORKFLOW_PUBLISHER'), 'designer and publisher are separate');
  assert.deepEqual(matrix.find(m => m.operationId === 'submitWorkflowTaskAction').relationships, ['ASSIGNEE']);
});

test('example first slice is schema-valid, passes every semantic rule and has a key-order-independent contentHash', () => {
  assert.equal(validate('WorkflowDefinitionContent', example), true);
  assert.deepEqual(validateWorkflow(example, { ...ctx, publishedRefs: allRefs(example), otherPublishedScopes: { INPATIENT: 'inpatient_flow' } }), []);
  const reverseKeys = v => Array.isArray(v) ? v.map(reverseKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).reverse().map(k => [k, reverseKeys(v[k])])) : v;
  const reordered = reverseKeys(example);
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(example));
  assert.equal(contentHash(reordered), contentHash(example));
  assert.match(contentHash(example), /^[a-f0-9]{64}$/);
  assert.deepEqual(new Set(example.nodes.map(n => n.type)), new Set(['START', 'AI_ACTIVITY', 'HUMAN_TASK', 'SUPPLEMENT_WAIT', 'CONDITION', 'END']));
  assert.ok(Buffer.byteLength(canonicalJson(example)) < MAX_CANONICAL_BYTES);
});

function allRefs(c) {
  return new Set(c.nodes.flatMap(n => ['modelRef', 'promptRef', 'policyRef', 'formRef'].filter(k => n[k]).map(k => `${n[k].key}@${n[k].version}#${n[k].hash}`)));
}

test('valid variants per node type: TIMER, grouped CONDITION, second HUMAN_TASK with separation of duties', () => {
  let c = clone();
  c.nodes.push({ nodeId: 'cool_off', type: 'TIMER', label: 'Chờ trước khi gửi yêu cầu', delaySeconds: 3600 });
  edge(c, 'e_supplement').target = 'cool_off';
  c.edges.push({ edgeId: 'e_cool_off', source: 'cool_off', target: 'wait_supplement', guard: { kind: 'NEXT' } });
  assert.deepEqual(codes(c), []);

  c = clone();
  edge(c, 'e_retry_ai').guard.condition = { all: [{ variable: 'SUPPLEMENT_ROUND', op: 'LTE', value: 3 }, { variable: 'CLAIM_BENEFIT_TYPE', op: 'IN', value: ['OUTPATIENT', 'DENTAL'] }] };
  assert.deepEqual(codes(c), []);

  c = clone();
  c.assignmentPolicy.rules.push({ ruleKey: 'second_opinion', candidateRoles: ['CLAIM_REVIEWER', 'INSURER_REVIEWER'], strategy: 'CASE_OWNER_DIRECT', accountableOwner: 'CASE_OWNER', distinctFromNodeIds: ['confirm_extraction'], maxActiveTasksPerAssignee: 20 });
  c.nodes.push({ ...structuredClone(node(c, 'confirm_extraction')), nodeId: 'second_review', label: 'Duyệt lần hai', taskKind: 'DOCUMENT_REVIEW', assignmentRuleKey: 'second_opinion', allowedActionIds: ['CONFIRM_EXTRACTION', 'ESCALATE_TO_MANUAL_REVIEW'], inputSchemas: ['CONFIRMED_EXTRACTION'] });
  edge(c, 'e_confirm').target = 'second_review';
  c.edges.push({ edgeId: 'e_second_ok', source: 'second_review', target: 'end_completed', guard: { kind: 'ACTION', actionId: 'CONFIRM_EXTRACTION' } },
    { edgeId: 'e_second_esc', source: 'second_review', target: 'end_manual', guard: { kind: 'ACTION', actionId: 'ESCALATE_TO_MANUAL_REVIEW' } });
  assert.deepEqual(codes(c), []);
});

// Each vector: [expected detailCode, mutation of the valid example, extra oracle context]. #80 must reproduce these.
const VECTORS = [
  ['SCHEMA_INVALID', c => { c.tenantId = '00000000-0000-4000-8000-000000000099'; }],
  ['SCHEMA_INVALID', c => { node(c, 'ai_extract').allowedActionIds = ['CONFIRM_EXTRACTION']; }],
  ['SCHEMA_INVALID', c => { c.nodes.push({ nodeId: 'fork', type: 'PARALLEL_GATEWAY', label: 'Fork' }); }],
  ['DUPLICATE_ID', c => { c.nodes.push(structuredClone(node(c, 'end_manual'))); }],
  ['DUPLICATE_ID', c => { c.edges.push({ ...structuredClone(edge(c, 'e_start')) }); }],
  ['EXACTLY_ONE_START_REQUIRED', c => { c.nodes.push({ nodeId: 'start_two', type: 'START', label: 'Bắt đầu 2' }); c.edges.push({ edgeId: 'e_start_two', source: 'start_two', target: 'ai_extract', guard: { kind: 'NEXT' } }); }],
  ['END_REQUIRED', c => { c.nodes = c.nodes.filter(n => n.type !== 'END'); c.edges = c.edges.filter(e => !e.target.startsWith('end_')); }],
  ['START_HAS_INCOMING', c => { c.edges.push({ edgeId: 'e_back_start', source: 'supplement_round', target: 'start', guard: { kind: 'CONDITION', priority: 2, condition: { variable: 'SUPPLEMENT_ROUND', op: 'GT', value: 9 } } }); }],
  ['END_HAS_OUTGOING', c => { c.edges.push({ edgeId: 'e_end_out', source: 'end_manual', target: 'ai_extract', guard: { kind: 'NEXT' } }); }],
  ['DANGLING_EDGE', c => { edge(c, 'e_escalate').target = 'ghost_node'; }],
  ['SELF_LOOP', c => { c.edges.push({ edgeId: 'e_self', source: 'supplement_round', target: 'supplement_round', guard: { kind: 'CONDITION', priority: 2, condition: { variable: 'SUPPLEMENT_ROUND', op: 'EQ', value: 0 } }, loopBack: { maxIterations: 1 } }); }],
  ['GUARD_NOT_ALLOWED_FOR_SOURCE', c => { edge(c, 'e_start').guard = { kind: 'DEFAULT' }; }],
  ['GUARD_NOT_ALLOWED_FOR_SOURCE', c => { edge(c, 'e_ai_ok').guard = { kind: 'OUTCOME', outcome: 'RECEIVED' }; }],
  ['GUARD_NOT_ALLOWED_FOR_SOURCE', c => { edge(c, 'e_received').loopBack = { maxIterations: 2 }; }],
  ['MISSING_ACTION_ROUTE', c => dropEdge(c, 'e_escalate')],
  ['DUPLICATE_ROUTE', c => { c.edges.push({ edgeId: 'e_confirm_two', source: 'confirm_extraction', target: 'end_manual', guard: { kind: 'ACTION', actionId: 'CONFIRM_EXTRACTION' } }); }],
  ['DUPLICATE_ROUTE', c => { c.edges.push({ edgeId: 'e_start_two', source: 'start', target: 'confirm_extraction', guard: { kind: 'NEXT' } }); }],
  ['MISSING_OUTCOME_ROUTE', c => dropEdge(c, 'e_expired')],
  ['MISSING_OUTCOME_ROUTE', c => dropEdge(c, 'e_ai_fail')],
  ['MISSING_DEFAULT_BRANCH', c => dropEdge(c, 'e_rounds_exhausted')],
  ['DUPLICATE_PRIORITY', c => { c.edges.push({ edgeId: 'e_dup_prio', source: 'supplement_round', target: 'end_manual', guard: { kind: 'CONDITION', priority: 1, condition: { variable: 'SUPPLEMENT_ROUND', op: 'GT', value: 3 } } }); }],
  ['CONDITION_TYPE_MISMATCH', c => { edge(c, 'e_retry_ai').guard.condition = { variable: 'CLAIM_BENEFIT_TYPE', op: 'GT', value: 3 }; }],
  ['CONDITION_TYPE_MISMATCH', c => { edge(c, 'e_retry_ai').guard.condition = { variable: 'SUPPLEMENT_ROUND', op: 'IN', value: ['OUTPATIENT'] }; }],
  ['UNREACHABLE_NODE', c => { c.nodes.push({ nodeId: 'orphan', type: 'TIMER', label: 'Mồ côi', delaySeconds: 60 }); c.edges.push({ edgeId: 'e_orphan', source: 'orphan', target: 'end_manual', guard: { kind: 'NEXT' } }); }],
  ['DEAD_END', c => { c.nodes.push({ nodeId: 'stuck', type: 'TIMER', label: 'Kẹt', delaySeconds: 60 }); edge(c, 'e_escalate').target = 'stuck'; }],
  ['UNBOUNDED_LOOP', c => { delete edge(c, 'e_retry_ai').loopBack; }],
  ['LOOP_WITHOUT_HUMAN_OR_WAIT', c => {
    c.nodes.push({ nodeId: 'retry_ai', type: 'CONDITION', label: 'Chạy lại AI?' });
    edge(c, 'e_ai_ok').target = 'retry_ai';
    c.edges.push({ edgeId: 'e_retry_loop', source: 'retry_ai', target: 'ai_extract', guard: { kind: 'CONDITION', priority: 1, condition: { variable: 'EXTRACTION_QUALITY_FLAG_COUNT', op: 'GT', value: 0 } }, loopBack: { maxIterations: 2 } },
      { edgeId: 'e_retry_done', source: 'retry_ai', target: 'confirm_extraction', guard: { kind: 'DEFAULT' } });
  }],
  ['ACTION_NOT_ALLOWED_FOR_NODE', c => { node(c, 'confirm_extraction').allowedActionIds = ['CONFIRM_EXTRACTION', 'REQUEST_SUPPLEMENT']; }],
  ['ACTION_NOT_ALLOWED_FOR_NODE', () => {}, { catalog: { ...catalog, actions: catalog.actions.filter(a => a.actionId !== 'PROPOSE_QUALITY_FLAG') } }],
  ['UNKNOWN_ASSIGNMENT_RULE', c => { node(c, 'confirm_extraction').assignmentRuleKey = 'ghost_rule'; }],
  ['UNKNOWN_ASSIGNMENT_RULE', c => { c.assignmentPolicy.rules[0].distinctFromNodeIds = ['ai_extract']; }],
  ['INPUT_NOT_PRODUCED', c => { node(c, 'ai_extract').outputSchemas = ['QUALITY_FLAGS']; }],
  ['AI_FAILURE_NOT_ROUTED_TO_HUMAN', c => { edge(c, 'e_ai_fail').target = 'end_manual'; }],
  ['SCOPE_NOT_APPROVED', c => { c.scope.benefitTypes = ['OUTPATIENT', 'MATERNITY']; }],
  ['AMBIGUOUS_BINDING', () => {}, { otherPublishedScopes: { DENTAL: 'dental_flow' } }],
  ['REFERENCE_NOT_PUBLISHED', () => {}, { publishedRefs: new Set() }],
  ['GROUP_DIRECTORY_UNAVAILABLE', c => { c.assignmentPolicy.rules[0].candidateGroupKeys = ['team.reviewers']; }],
  ['CATALOG_VERSION_UNKNOWN', c => { c.actionCatalogVersion = 2; }],
  ['LIMIT_EXCEEDED', c => {
    const long = 'Đ'.repeat(120);
    for (let i = 0; i < 40; i++) c.nodes.push({ ...structuredClone(node(c, 'ai_extract')), nodeId: `bulk_${i}`, label: long });
    for (let i = 0; i < 80; i++) c.edges.push({ edgeId: `e_bulk_${i}`, source: 'supplement_round', target: 'end_manual', guard: { kind: 'CONDITION', priority: 2, condition: { any: Array(5).fill({ variable: 'CLAIM_BENEFIT_TYPE', op: 'IN', value: ['OUTPATIENT', 'DENTAL', 'INPATIENT', 'MATERNITY', 'ACCIDENT', 'HOSPITAL_INCOME'] }) } } });
  }],
];

for (const [code, mutate, extra] of VECTORS) test(`semantic vector ${code}: ${mutate.toString().slice(0, 90).replace(/\s+/g, ' ')}`, () => {
  const c = clone(); mutate(c);
  const issues = validateWorkflow(c, { ...ctx, ...extra });
  assert.ok(issues.some(i => i.detailCode === code), `${code} expected, got ${JSON.stringify(issues.map(i => i.detailCode))}`);
  for (const i of issues) {
    assert.equal(validate('WorkflowValidationIssue', i), true, JSON.stringify(i));
    assert.doesNotMatch(JSON.stringify(i), /Đ|Xác|Chờ|Kẹt|Mồ/, 'issues never echo labels');
  }
  if (code !== 'SCHEMA_INVALID') assert.equal(validate('WorkflowDefinitionContent', c), true, 'semantic vectors are schema-valid');
});

test('bpmn-js vocabulary: only the bounded elements are accepted; parallel and executable elements are rejected', () => {
  const v = catalogDoc.bpmnVocabulary;
  const nodeTypes = S.WorkflowNode.oneOf.map(r => S[r.$ref.split('/').pop()].properties.type.enum[0]);
  assert.deepEqual([...new Set(v.allowed.map(a => a.nodeType).filter(t => t !== 'EDGE'))].sort(), [...nodeTypes].sort());
  const allowedElements = [...new Set(v.allowed.flatMap(a => [a.element, a.eventDefinition].filter(Boolean))), ...v.structural];
  assert.deepEqual(checkBpmnElements(allowedElements, v), []);
  for (const el of ['bpmn:ParallelGateway', 'bpmn:InclusiveGateway', 'bpmn:ComplexGateway', 'bpmn:MultiInstanceLoopCharacteristics']) {
    assert.deepEqual(checkBpmnElements([el], v).map(i => i.detailCode), ['PARALLEL_NOT_SUPPORTED'], el);
  }
  for (const el of ['bpmn:ScriptTask', 'bpmn:BoundaryEvent', 'bpmn:CallActivity', 'bpmn:FormalExpression', 'camunda:Connector', 'flowable:Script']) {
    assert.deepEqual(checkBpmnElements([el], v).map(i => i.detailCode), ['UNSUPPORTED_BPMN_ELEMENT'], el);
  }
  assert.match(doc, /Song song: TỪ CHỐI ở Phase 1/);
});

test('every WorkflowValidationDetailCode is produced by at least one vector and documented in spec 14', () => {
  const produced = new Set(VECTORS.map(([c]) => c));
  produced.add('PARALLEL_NOT_SUPPORTED'); produced.add('UNSUPPORTED_BPMN_ELEMENT'); // via checkBpmnElements above
  assert.deepEqual([...produced].sort(), [...S.WorkflowValidationDetailCode.enum].sort());
  for (const code of S.WorkflowValidationDetailCode.enum) assert.ok(doc.includes(`\`${code}\``), code);
});

test('version conflict: drafts, publish, revoke and every task mutation are bound to an expected version/hash', () => {
  const fx = JSON.parse(read('./workflow-fixtures.json'));
  const v = name => structuredClone(fx.find(f => f.schema === name && f.valid).value);
  for (const [schema, field] of [['WorkflowDraftUpdateRequest', 'expectedRevision'], ['WorkflowPublishRequest', 'expectedRevision'], ['WorkflowPublishRequest', 'contentHash'],
    ['WorkflowRevokeRequest', 'contentHash'], ['WorkflowTaskClaimRequest', 'expectedTaskVersion'], ['WorkflowConfirmExtractionAction', 'expectedTaskVersion'],
    ['WorkflowRequestSupplementAction', 'expectedTaskVersion'], ['WorkflowEscalateAction', 'expectedTaskVersion']]) {
    const value = v(schema); delete value[field];
    assert.equal(validate(schema, value), false, `${schema}.${field}`);
  }
  const reassign = { expectedTaskVersion: 2, assigneePrincipalId: '00000000-0000-4000-8000-000000000024', reasonCode: 'WORKLOAD' };
  assert.equal(validate('WorkflowTaskReassignRequest', reassign), true);
  delete reassign.expectedTaskVersion;
  assert.equal(validate('WorkflowTaskReassignRequest', reassign), false);
  for (const ref of ['WorkflowPinnedRef', 'WorkflowVersionRef']) assert.ok(S[ref].required.some(r => /hash/i.test(r)), ref);
  assert.match(spec.paths['/v1/admin/workflow-definitions/{definitionId}/versions/{versionNo}'].put.description, /409 STALE_VERSION/);
  assert.match(spec.paths['/v1/workflow/tasks/{taskId}/claim'].post.description, /exactly one success/);
});

test('AI scope: AI only proposes evidence on AI nodes, is never a candidate/owner/bearer actor and confidence is not permission', () => {
  const human = clone().nodes.find(n => n.type === 'HUMAN_TASK');
  for (const a of S.WorkflowAiActionId.enum) assert.equal(validate('WorkflowHumanTaskNode', { ...human, allowedActionIds: [a] }), false, a);
  const ai = clone().nodes.find(n => n.type === 'AI_ACTIVITY');
  for (const a of S.WorkflowTaskActionId.enum) assert.equal(validate('WorkflowAiActivityNode', { ...ai, allowedActionIds: [a] }), false, a);
  for (const a of S.WorkflowAiActionId.enum) assert.equal(validate('WorkflowTaskActionRequest', { expectedTaskVersion: 1, actionId: a }), false, a);
  assert.deepEqual(S.WorkflowCandidateRole.enum, ['CLAIM_REVIEWER', 'INSURER_REVIEWER']);
  assert.deepEqual(S.WorkflowActorScope.properties.actorKind.enum, ['HUMAN']);
  for (const n of ['WorkflowHumanTaskNode', 'WorkflowAiActivityNode', 'WorkflowSupplementWaitNode']) assert.deepEqual(S[n].properties.accountableOwner.enum, ['CASE_OWNER'], n);
  assert.match(S.WorkflowProposal.properties.confidence.description, /never permission/);
  assert.equal(S.WorkflowCondition.oneOf.length, 2);
  assert.ok(!S.WorkflowConditionVariable.enum.some(v => /CONFIDENCE$|AMOUNT|TOTAL/.test(v)), 'no raw confidence/amount routing variable');
  assert.ok(S.WorkflowProposal.required.includes('evidenceIds') && S.WorkflowProposal.properties.evidenceIds.minItems === 1, 'no proposal without evidence');
  assert.match(spec.paths['/v1/workflow/tasks/{taskId}/actions'].post.description, /AI service actors and labels cannot call this/);
});

test('labels/annotations never carry business state, free text or PII-bearing fields', () => {
  assert.match(S.WorkflowAnnotationLabel.description, /never changes claim, task, EOB or payment state/);
  for (const name of ['WorkflowAnnotationCreateRequest', 'WorkflowRequestSupplementAction', 'WorkflowTaskReassignRequest']) {
    const props = JSON.stringify(S[name]);
    assert.doesNotMatch(props, /"(comment|note|text|message|freeText)"/, name);
  }
  assert.deepEqual(S.WorkflowTaskActionResult.properties.workflowAdvance.enum, ['PENDING']);
  assert.ok(!('claimStatus' in S.WorkflowTaskActionResult.properties));
  for (const o of S.WorkflowEndNode.properties.outcome.enum) assert.ok(doc.includes(`\`${o}\``), o);
});

test('14b acceptance cases are spec-only, unique and cross-referenced with spec 14; open decisions are defined, none claimed decided', () => {
  assert.equal(cases.status, 'SPECIFICATION_ONLY_NOT_EXECUTED');
  const ids = cases.test_cases.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length);
  const defined = new Set([...doc.matchAll(/^\| (VWF-OD-\d{2}) \|/gm)].map(m => m[1]));
  assert.equal(defined.size, 10);
  for (const c of cases.test_cases) {
    assert.match(c.id, /^VW\d{2}_[A-Z0-9_]+$/);
    for (const k of ['layer', 'given', 'expected']) assert.ok(c[k]?.length > 0, `${c.id}.${k}`);
    assert.ok(['SCHEMA_ONLY', 'SCHEMA_AND_ORACLE', 'CONTRACT_ONLY'].includes(c.contractCoverage), c.id);
    assert.ok(!('result' in c) && !/\bPASS(ED)?\b/.test(JSON.stringify(c)), `${c.id} must not claim execution`);
    for (const b of c.blockedBy) {
      if (b.startsWith('VWF-OD-')) assert.ok(defined.has(b), `${c.id} blockedBy ${b}`);
      else if (b.startsWith('OD-')) assert.match(read('../../../docs/ai-specs/11-dynamic-intake-design.md'), new RegExp(`\\| ${b} \\|`));
      else assert.match(b, /^#\d+$/);
    }
  }
  const short = new Set(ids.map(id => id.slice(0, 4)));
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => `VW${String(a + i).padStart(2, '0')}`);
  const referenced = new Set([...doc.matchAll(/VW(\d{2})(?:–VW(\d{2}))?/g)].flatMap(m => m[2] ? range(+m[1], +m[2]) : [`VW${m[1]}`]));
  for (const id of short) assert.ok(referenced.has(id), `${id} not referenced in spec 14`);
  for (const id of referenced) assert.ok(short.has(id), `${id} referenced but missing from 14b`);
  assert.doesNotMatch(doc, /VWF-OD-\d{2}[^|\n]*ĐÃ CHỐT/, 'no open workflow decision is presented as decided');
  assert.match(doc, /Chưa có quyết định nào trong bảng trên được owner chốt/);
});
