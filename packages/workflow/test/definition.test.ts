// VWF-03 (#80): definition validator parity with the VWF-01 oracle, catalog parity with 14a,
// deterministic stepper semantics (bounded loops, fail-closed variables, pinned actions) and
// sandbox safety. Synthetic definitions only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  ACTION_CATALOG_V1, actionCatalog, assertDefinitionCommand, assertDefinitionExecutionRef, definitionWorkflowId,
  isDefinitionWorkflowId, stepDefinition, type DefinitionContent, type StepState,
} from '../src/definition.ts';
import { canonicalJson, contentHash, pinnedRefs, refKey, validateDefinitionContent, type ValidationContext } from '../src/definition-validator.ts';
import { WorkflowContractError } from '../src/contracts.ts';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const example = JSON.parse(read('../../../docs/ai-specs/examples/visual-workflow-intake-review.example.json')) as DefinitionContent;
const spec14a = JSON.parse(read('../../../docs/ai-specs/14a-visual-workflow-catalog.json'));
type Oracle = { validateWorkflow(c: unknown, ctx: unknown): unknown[]; contentHash(c: unknown): string; canonicalJson(c: unknown): string };
const oracle = await import(new URL('../../shared-contracts/test/workflow-graph-oracle.mjs', import.meta.url).href) as Oracle;

const catalog = ACTION_CATALOG_V1;
const clone = () => structuredClone(example) as DefinitionContent & Record<string, unknown>;
type C = ReturnType<typeof clone>;
const node = (c: C, id: string) => c.nodes.find(n => n.nodeId === id)! as Record<string, unknown>;
const edge = (c: C, id: string) => c.edges.find(e => e.edgeId === id)! as unknown as Record<string, unknown> & { guard: Record<string, unknown> };
const dropEdge = (c: C, id: string) => { c.edges = c.edges.filter(e => e.edgeId !== id); };

// Same vectors as packages/shared-contracts/test/workflow-contracts.test.mjs (#78) plus the valid variants.
const VECTORS: [string, (c: C) => void, Partial<ValidationContext>?][] = [
  ['VALID', () => {}],
  ['VALID_TIMER', c => { c.nodes.push({ nodeId: 'cool_off', type: 'TIMER', label: 'Chờ', delaySeconds: 3600 }); edge(c, 'e_supplement').target = 'cool_off';
    c.edges.push({ edgeId: 'e_cool_off', source: 'cool_off', target: 'wait_supplement', guard: { kind: 'NEXT' } }); }],
  ['VALID_GROUP', c => { edge(c, 'e_retry_ai').guard.condition = { all: [{ variable: 'SUPPLEMENT_ROUND', op: 'LTE', value: 3 }, { variable: 'CLAIM_BENEFIT_TYPE', op: 'IN', value: ['OUTPATIENT', 'DENTAL'] }] }; }],
  ['SCHEMA_INVALID', c => { c.tenantId = '00000000-0000-4000-8000-000000000099'; }],
  ['SCHEMA_INVALID', c => { node(c, 'ai_extract').allowedActionIds = ['CONFIRM_EXTRACTION']; }],
  ['SCHEMA_INVALID', c => { c.nodes.push({ nodeId: 'fork', type: 'PARALLEL_GATEWAY' as 'START', label: 'Fork' }); }],
  ['DUPLICATE_ID', c => { c.nodes.push(structuredClone(c.nodes.find(n => n.nodeId === 'end_manual')!)); }],
  ['DUPLICATE_ID', c => { c.edges.push(structuredClone(c.edges[0])); }],
  ['EXACTLY_ONE_START_REQUIRED', c => { c.nodes.push({ nodeId: 'start_two', type: 'START', label: 'B2' }); c.edges.push({ edgeId: 'e_start_two', source: 'start_two', target: 'ai_extract', guard: { kind: 'NEXT' } }); }],
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
  ['UNREACHABLE_NODE', c => { c.nodes.push({ nodeId: 'orphan', type: 'TIMER', label: 'M', delaySeconds: 60 }); c.edges.push({ edgeId: 'e_orphan', source: 'orphan', target: 'end_manual', guard: { kind: 'NEXT' } }); }],
  ['DEAD_END', c => { c.nodes.push({ nodeId: 'stuck', type: 'TIMER', label: 'K', delaySeconds: 60 }); edge(c, 'e_escalate').target = 'stuck'; }],
  ['UNBOUNDED_LOOP', c => { delete edge(c, 'e_retry_ai').loopBack; }],
  ['LOOP_WITHOUT_HUMAN_OR_WAIT', c => {
    c.nodes.push({ nodeId: 'retry_ai', type: 'CONDITION', label: 'R' });
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
    for (let i = 0; i < 40; i++) c.nodes.push({ ...structuredClone(c.nodes.find(n => n.nodeId === 'ai_extract')!), nodeId: `bulk_${i}`, label: long });
    for (let i = 0; i < 80; i++) c.edges.push({ edgeId: `e_bulk_${i}`, source: 'supplement_round', target: 'end_manual', guard: { kind: 'CONDITION', priority: 2, condition: { any: Array(5).fill({ variable: 'CLAIM_BENEFIT_TYPE', op: 'IN', value: ['OUTPATIENT', 'DENTAL', 'INPATIENT', 'MATERNITY', 'ACCIDENT', 'HOSPITAL_INCOME'] }) } } });
  }],
];

test('server validator reproduces the VWF-01 oracle issue-for-issue on every vector (VW03/VW04/VW05/VW25)', () => {
  for (const [code, mutate, extra] of VECTORS) {
    const c = clone(); mutate(c);
    const ctx = { catalog, ...extra };
    const ours = validateDefinitionContent(c, ctx);
    assert.deepEqual(ours, oracle.validateWorkflow(c, ctx), code);
    if (code.startsWith('VALID')) assert.deepEqual(ours, [], code);
    else assert.ok(ours.some(i => i.detailCode === code), `${code}: ${ours.map(i => i.detailCode)}`);
    assert.doesNotMatch(JSON.stringify(ours), /Đ|Chờ|Xác|00000000-0000-4000/, 'issues never echo labels/values');
  }
});

test('canonical JSON and content hash equal the spec 11/14 algorithm', () => {
  const c = clone();
  assert.equal(canonicalJson(c), oracle.canonicalJson(c));
  assert.equal(contentHash(c), oracle.contentHash(c));
  const reordered = Object.fromEntries(Object.entries(c).reverse());
  assert.equal(contentHash(reordered), contentHash(c), 'key order independent');
  assert.match(contentHash(c), /^[0-9a-f]{64}$/);
  const refs = pinnedRefs(c);
  assert.deepEqual(refs.map(r => r.kind).sort(), ['formRef', 'modelRef', 'policyRef', 'promptRef']);
  const ctx = { catalog, publishedRefs: new Set(refs.map(refKey)) };
  assert.deepEqual(validateDefinitionContent(c, ctx), [], 'resolvable pins publish');
});

test('catalog v1 is byte-equal to 14a and has no money/claim-decision effects', () => {
  assert.equal(canonicalJson(ACTION_CATALOG_V1), canonicalJson(spec14a.actionCatalog));
  assert.equal(actionCatalog(1), ACTION_CATALOG_V1);
  assert.equal(actionCatalog(2), undefined, 'unknown catalogs fail closed');
  assert.ok(Object.isFrozen(ACTION_CATALOG_V1.actions[0]));
  assert.ok(ACTION_CATALOG_V1.actions.every(a => !/APPROVE|REJECT|EOB|OTP|PAY/.test(a.actionId)));
});

const s0: StepState = { loopCounts: {}, supplementRound: 0, benefitType: 'OUTPATIENT' };
test('stepper: START -> AI wait carries bounded timeout/retry; FAILED and SUCCEEDED route to the human task', () => {
  const r = stepDefinition(example, 'start', { kind: 'START' }, s0);
  assert.ok(r.accepted && r.wait.kind === 'AI');
  assert.equal(r.wait.nodeId, 'ai_extract');
  assert.ok(r.wait.timeoutSeconds >= 30 && r.wait.timeoutSeconds <= 600 && r.wait.retry.maxAttempts <= 5);
  for (const outcome of ['FAILED', 'SUCCEEDED'] as const) {
    const h = stepDefinition(example, 'ai_extract', { kind: 'OUTCOME', outcome }, s0);
    assert.deepEqual(h.accepted && h.wait, { kind: 'HUMAN', nodeId: 'confirm_extraction' });
  }
});

test('stepper: only pinned routing actions are accepted; lifecycle/AI/unknown actions are rejected without effect', () => {
  for (const actionId of ['CLAIM_TASK', 'ADD_ANNOTATION', 'PROPOSE_EXTRACTION', 'APPROVE_CLAIM']) {
    assert.deepEqual(stepDefinition(example, 'confirm_extraction', { kind: 'ACTION', actionId }, s0), { accepted: false }, actionId);
  }
  assert.deepEqual(stepDefinition(example, 'wait_supplement', { kind: 'ACTION', actionId: 'CONFIRM_EXTRACTION' }, s0), { accepted: false });
  assert.deepEqual(stepDefinition(example, 'confirm_extraction', { kind: 'OUTCOME', outcome: 'RECEIVED' }, s0), { accepted: false });
  const done = stepDefinition(example, 'confirm_extraction', { kind: 'ACTION', actionId: 'CONFIRM_EXTRACTION' }, s0);
  assert.deepEqual(done.accepted && done.wait, { kind: 'END', nodeId: 'end_completed', outcome: 'REVIEW_COMPLETED' });
  const escalated = stepDefinition(example, 'confirm_extraction', { kind: 'ACTION', actionId: 'ESCALATE_TO_MANUAL_REVIEW' }, s0);
  assert.deepEqual(escalated.accepted && escalated.wait, { kind: 'END', nodeId: 'end_manual', outcome: 'ROUTED_TO_MANUAL_REVIEW' });
});

test('VW04 stepper: supplement loop stops after exactly maxIterations=3 through DEFAULT; input state is not mutated', () => {
  let state = s0, rounds = 0;
  for (;;) {
    const ask = stepDefinition(example, 'confirm_extraction', { kind: 'ACTION', actionId: 'REQUEST_SUPPLEMENT' }, state);
    assert.ok(ask.accepted && ask.wait.kind === 'SUPPLEMENT' && ask.wait.maxWaitSeconds === 1296000);
    const before = structuredClone(state);
    const got = stepDefinition(example, 'wait_supplement', { kind: 'OUTCOME', outcome: 'RECEIVED' }, ask.state);
    assert.deepEqual(state, before, 'pure');
    assert.ok(got.accepted);
    state = got.state; rounds++;
    if (got.wait.kind === 'END') { assert.equal(got.wait.outcome, 'ROUTED_TO_MANUAL_REVIEW'); break; }
    assert.equal(got.wait.kind, 'AI');
    assert.ok(rounds <= 3);
  }
  assert.equal(rounds, 4);
  assert.deepEqual(state.loopCounts, { e_retry_ai: 3 });
  const expired = stepDefinition(example, 'wait_supplement', { kind: 'OUTCOME', outcome: 'EXPIRED' }, s0);
  assert.deepEqual(expired.accepted && expired.wait, { kind: 'END', nodeId: 'end_expired', outcome: 'SUPPLEMENT_EXPIRED' });
});

test('stepper fails closed when a condition needs a variable no owning module provides yet', () => {
  const c = clone();
  edge(c, 'e_retry_ai').guard.condition = { variable: 'EXTRACTION_QUALITY_FLAG_COUNT', op: 'GT', value: 0 };
  const r = stepDefinition(c, 'wait_supplement', { kind: 'OUTCOME', outcome: 'RECEIVED' }, s0);
  assert.deepEqual(r.accepted && r.wait, { kind: 'UNRESOLVED', nodeId: 'supplement_round' });
  assert.throws(() => stepDefinition({ ...c, actionCatalogVersion: 9 }, 'start', { kind: 'START' }, s0), WorkflowContractError);
});

test('execution refs/commands: ids, version and hash only; fixed errors never echo values', () => {
  const ref = { tenantId: randomUUID(), claimId: randomUUID(), executionId: randomUUID(), definitionId: randomUUID(), versionNo: 2, contentHash: contentHash(example) };
  assertDefinitionExecutionRef(ref);
  assert.equal(definitionWorkflowId(ref), `wfexec/${ref.tenantId}/${ref.executionId}`);
  assert.ok(isDefinitionWorkflowId(definitionWorkflowId(ref)));
  const MARKER = 'PII-079123456789';
  for (const bad of [{ ...ref, versionNo: 0 }, { ...ref, contentHash: 'latest' }, { ...ref, extra: MARKER }, { ...ref, claimId: MARKER }]) {
    assert.throws(() => assertDefinitionExecutionRef(bad), (e: Error) => e instanceof WorkflowContractError && !e.message.includes(MARKER));
  }
  assertDefinitionCommand({ commandId: `cmd-${randomUUID()}`, kind: 'TASK_ACTION', nodeId: 'confirm_extraction', actionId: 'CONFIRM_EXTRACTION' });
  assertDefinitionCommand({ commandId: `evt-${randomUUID()}`, kind: 'SUPPLEMENT_RECEIVED', nodeId: 'wait_supplement', actionId: null });
  for (const bad of [{ commandId: 'x', kind: 'TASK_ACTION', nodeId: 'a1', actionId: 'CONFIRM_EXTRACTION' },
    { commandId: `cmd-${randomUUID()}`, kind: 'TASK_ACTION', nodeId: 'a1', actionId: null },
    { commandId: `cmd-${randomUUID()}`, kind: 'SUPPLEMENT_RECEIVED', nodeId: 'a1', actionId: 'X_Y' },
    { commandId: `cmd-${randomUUID()}`, kind: 'TASK_ACTION', nodeId: 'a1', actionId: 'CONFIRM_EXTRACTION', note: MARKER }]) {
    assert.throws(() => assertDefinitionCommand(bad), WorkflowContractError);
  }
});

test('definition.ts is Temporal-sandbox safe: no Node/IO imports, clock or randomness', () => {
  const src = read('../src/definition.ts');
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1]);
  assert.deepEqual(imports, ['./contracts.ts']);
  assert.doesNotMatch(src, /Date\.now|new Date|Math\.random|process\.|require\(/);
});
