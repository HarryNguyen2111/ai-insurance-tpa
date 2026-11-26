// VWF-01 (#78) TEST-ONLY reference oracle for the semantic publish rules of spec 14 §4.
// It is executable documentation of the expected detail codes, not runtime code: #80 implements the
// server validator in core-api and must reproduce these codes for the vectors in workflow-contracts.test.mjs.
import { createHash } from 'node:crypto';
import { validate } from '../src/validate.cjs';

export const PHASE1_BENEFIT_TYPES = ['OUTPATIENT', 'DENTAL', 'INPATIENT'];
export const START_PROVIDES = ['CLAIM_REF', 'DOCUMENT_SET'];
export const MAX_CANONICAL_BYTES = 64 * 1024;
const INT_VARS = ['EXTRACTION_LOW_CONFIDENCE_FIELD_COUNT', 'EXTRACTION_QUALITY_FLAG_COUNT', 'DOCUMENTS_MISSING_REQUIRED_SLOT_COUNT', 'SUPPLEMENT_ROUND'];
const GUARDS = {
  START: ['NEXT'], TIMER: ['NEXT'], HUMAN_TASK: ['ACTION'], AI_ACTIVITY: ['OUTCOME'], SUPPLEMENT_WAIT: ['OUTCOME'], CONDITION: ['CONDITION', 'DEFAULT'], END: [],
};
const OUTCOMES = { AI_ACTIVITY: ['SUCCEEDED', 'FAILED'], SUPPLEMENT_WAIT: ['RECEIVED', 'EXPIRED'] };

export const canonicalJson = v => Array.isArray(v) ? `[${v.map(canonicalJson).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}` : JSON.stringify(v);
export const contentHash = content => createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex');

/** Map a list of bpmn-js element types (as seen on import) to rejection issues using the 14a vocabulary. */
export function checkBpmnElements(elements, vocabulary) {
  const allowed = new Set([...vocabulary.allowed.map(a => a.eventDefinition ?? a.element), ...vocabulary.allowed.map(a => a.element), ...vocabulary.structural]);
  const rejected = new Map(vocabulary.rejected.map(r => [r.element, r.detailCode]));
  return elements.flatMap((el, i) => allowed.has(el) && !rejected.has(el) ? []
    : [{ detailCode: rejected.get(el) ?? 'UNSUPPORTED_BPMN_ELEMENT', path: `/bpmn/${i}` }]);
}

/**
 * @param {unknown} content WorkflowDefinitionContent
 * @param {{catalog: any, publishedRefs?: Set<string>, otherPublishedScopes?: Record<string, string>}} ctx catalog = 14a actionCatalog;
 *   publishedRefs = "key@version#hash" resolvable for the tenant; otherPublishedScopes = benefitType -> workflowKey already published
 * @returns {{detailCode: string, path: string, nodeId?: string, edgeId?: string}[]}
 */
export function validateWorkflow(content, { catalog, publishedRefs, otherPublishedScopes }) {
  if (!validate('WorkflowDefinitionContent', content)) return [{ detailCode: 'SCHEMA_INVALID', path: '/' }];
  const issues = [];
  const add = (detailCode, path, extra = {}) => issues.push({ detailCode, path, ...extra });
  if (Buffer.byteLength(canonicalJson(content), 'utf8') > MAX_CANONICAL_BYTES) add('LIMIT_EXCEEDED', '/');
  const { nodes, edges } = content;
  const byId = new Map();
  nodes.forEach((n, i) => { if (byId.has(n.nodeId)) add('DUPLICATE_ID', `/nodes/${i}/nodeId`, { nodeId: n.nodeId }); else byId.set(n.nodeId, n); });
  const edgeIds = new Set();
  edges.forEach((e, i) => { if (edgeIds.has(e.edgeId)) add('DUPLICATE_ID', `/edges/${i}/edgeId`, { edgeId: e.edgeId }); edgeIds.add(e.edgeId); });
  const ruleKeys = new Set();
  content.assignmentPolicy.rules.forEach((r, i) => { if (ruleKeys.has(r.ruleKey)) add('DUPLICATE_ID', `/assignmentPolicy/rules/${i}/ruleKey`); ruleKeys.add(r.ruleKey); });

  const starts = nodes.filter(n => n.type === 'START');
  if (starts.length !== 1) add('EXACTLY_ONE_START_REQUIRED', '/nodes');
  if (!nodes.some(n => n.type === 'END')) add('END_REQUIRED', '/nodes');
  if (!content.scope.benefitTypes.every(b => PHASE1_BENEFIT_TYPES.includes(b))) add('SCOPE_NOT_APPROVED', '/scope/benefitTypes');
  if (content.actionCatalogVersion !== catalog.catalogVersion) add('CATALOG_VERSION_UNKNOWN', '/actionCatalogVersion');
  // otherPublishedScopes: benefitType -> workflowKey of other PUBLISHED definitions of the same tenant.
  if (otherPublishedScopes && content.scope.benefitTypes.some(b => otherPublishedScopes[b] && otherPublishedScopes[b] !== content.workflowKey)) add('AMBIGUOUS_BINDING', '/scope/benefitTypes');

  const valid = [];
  edges.forEach((e, i) => {
    const s = byId.get(e.source), t = byId.get(e.target);
    if (!s || !t) return add('DANGLING_EDGE', `/edges/${i}`, { edgeId: e.edgeId });
    if (e.source === e.target) return add('SELF_LOOP', `/edges/${i}`, { edgeId: e.edgeId });
    if (t.type === 'START') add('START_HAS_INCOMING', `/edges/${i}/target`, { edgeId: e.edgeId });
    if (s.type === 'END') return add('END_HAS_OUTGOING', `/edges/${i}/source`, { edgeId: e.edgeId });
    if (!GUARDS[s.type].includes(e.guard.kind) || (e.loopBack && s.type !== 'CONDITION')) return add('GUARD_NOT_ALLOWED_FOR_SOURCE', `/edges/${i}/guard`, { edgeId: e.edgeId });
    if (e.guard.kind === 'OUTCOME' && !OUTCOMES[s.type].includes(e.guard.outcome)) return add('GUARD_NOT_ALLOWED_FOR_SOURCE', `/edges/${i}/guard`, { edgeId: e.edgeId });
    valid.push({ ...e, index: i });
  });
  const out = id => valid.filter(e => e.source === id);
  const catalogById = new Map(catalog.actions.map(a => [a.actionId, a]));

  nodes.forEach((n, i) => {
    const path = `/nodes/${i}`; const es = out(n.nodeId); const at = { nodeId: n.nodeId };
    const once = (pred, missing, label) => {
      const hits = es.filter(pred);
      if (hits.length === 0) add(missing, `${path}/${label}`, at);
      if (hits.length > 1) add('DUPLICATE_ROUTE', `${path}/${label}`, at);
    };
    if (n.type === 'START' || n.type === 'TIMER') once(() => true, 'DEAD_END', 'next');
    if (n.type === 'HUMAN_TASK' || n.type === 'AI_ACTIVITY') {
      for (const a of n.allowedActionIds) {
        const entry = catalogById.get(a);
        const actor = n.type === 'HUMAN_TASK' ? 'HUMAN' : 'AI_SERVICE';
        if (!entry || !entry.nodeTypes.includes(n.type) || entry.actorKind !== actor) add('ACTION_NOT_ALLOWED_FOR_NODE', `${path}/allowedActionIds`, at);
      }
    }
    if (n.type === 'HUMAN_TASK') {
      for (const a of n.allowedActionIds) once(e => e.guard.actionId === a, 'MISSING_ACTION_ROUTE', `allowedActionIds/${a}`);
      for (const e of es) if (!n.allowedActionIds.includes(e.guard.actionId)) add('ACTION_NOT_ALLOWED_FOR_NODE', `/edges/${e.index}/guard`, { edgeId: e.edgeId });
      if (!ruleKeys.has(n.assignmentRuleKey)) add('UNKNOWN_ASSIGNMENT_RULE', `${path}/assignmentRuleKey`, at);
    }
    if (OUTCOMES[n.type]) for (const o of OUTCOMES[n.type]) once(e => e.guard.outcome === o, 'MISSING_OUTCOME_ROUTE', `outcome/${o}`);
    if (n.type === 'AI_ACTIVITY') {
      const fail = es.find(e => e.guard.outcome === 'FAILED');
      if (fail && byId.get(fail.target)?.type !== 'HUMAN_TASK') add('AI_FAILURE_NOT_ROUTED_TO_HUMAN', `/edges/${fail.index}/target`, { edgeId: fail.edgeId });
    }
    if (n.type === 'CONDITION') {
      const defaults = es.filter(e => e.guard.kind === 'DEFAULT');
      if (defaults.length !== 1) add('MISSING_DEFAULT_BRANCH', `${path}`, at);
      const conds = es.filter(e => e.guard.kind === 'CONDITION');
      if (conds.length === 0) add('MISSING_OUTCOME_ROUTE', `${path}`, at);
      if (new Set(conds.map(e => e.guard.priority)).size !== conds.length) add('DUPLICATE_PRIORITY', `${path}`, at);
      for (const e of conds) {
        const leaves = e.guard.condition.all ?? e.guard.condition.any ?? [e.guard.condition];
        for (const l of leaves) {
          const isInt = Number.isInteger(l.value);
          const okType = INT_VARS.includes(l.variable)
            ? isInt && l.op !== 'IN'
            : l.op === 'IN' ? Array.isArray(l.value) : ['EQ', 'NEQ'].includes(l.op) && typeof l.value === 'string';
          if (!okType) add('CONDITION_TYPE_MISMATCH', `/edges/${e.index}/guard/condition`, { edgeId: e.edgeId });
        }
      }
    }
    if (publishedRefs) for (const k of ['modelRef', 'promptRef', 'policyRef', 'formRef']) {
      const r = n[k];
      if (r && !publishedRefs.has(`${r.key}@${r.version}#${r.hash}`)) add('REFERENCE_NOT_PUBLISHED', `${path}/${k}`, at);
    }
  });

  content.assignmentPolicy.rules.forEach((r, i) => {
    if (r.candidateGroupKeys) add('GROUP_DIRECTORY_UNAVAILABLE', `/assignmentPolicy/rules/${i}/candidateGroupKeys`);
    for (const d of r.distinctFromNodeIds) if (byId.get(d)?.type !== 'HUMAN_TASK') add('UNKNOWN_ASSIGNMENT_RULE', `/assignmentPolicy/rules/${i}/distinctFromNodeIds`);
  });

  // Reachability (forward from START) and dead ends (backward from END).
  const reach = (seeds, next) => { const seen = new Set(seeds); const q = [...seeds]; while (q.length) for (const x of next(q.shift())) if (!seen.has(x)) { seen.add(x); q.push(x); } return seen; };
  const fwd = reach(starts.map(s => s.nodeId), id => out(id).map(e => e.target));
  const back = reach(nodes.filter(n => n.type === 'END').map(n => n.nodeId), id => valid.filter(e => e.target === id).map(e => e.source));
  nodes.forEach((n, i) => {
    if (!fwd.has(n.nodeId)) add('UNREACHABLE_NODE', `/nodes/${i}`, { nodeId: n.nodeId });
    else if (!back.has(n.nodeId)) add('DEAD_END', `/nodes/${i}`, { nodeId: n.nodeId });
  });

  // Inputs must be produced by START or by some node that can precede this node.
  nodes.forEach((n, i) => {
    if (!n.inputSchemas) return;
    const preds = id => valid.filter(e => e.target === id).map(e => e.source);
    const ancestors = reach(preds(n.nodeId), preds);
    const produced = new Set([...START_PROVIDES, ...[...ancestors].flatMap(a => byId.get(a)?.outputSchemas ?? [])]);
    for (const s of n.inputSchemas) if (!produced.has(s)) add('INPUT_NOT_PRODUCED', `/nodes/${i}/inputSchemas`, { nodeId: n.nodeId });
  });

  // Loops: (1) removing loopBack edges must leave a DAG; (2) EVERY cycle must pass through a HUMAN_TASK or
  // SUPPLEMENT_WAIT, i.e. the graph without those nodes is acyclic (checked per cycle, not per SCC).
  const ids = nodes.map(n => n.nodeId);
  for (const c of tarjan(ids, id => out(id).filter(e => !e.loopBack).map(e => e.target)).filter(c => c.length > 1)) {
    add('UNBOUNDED_LOOP', '/edges', { nodeId: c[0] });
  }
  const gate = id => ['HUMAN_TASK', 'SUPPLEMENT_WAIT'].includes(byId.get(id)?.type);
  const ungated = ids.filter(id => !gate(id));
  for (const c of tarjan(ungated, id => out(id).map(e => e.target).filter(t => !gate(t))).filter(c => c.length > 1)) {
    add('LOOP_WITHOUT_HUMAN_OR_WAIT', '/edges', { nodeId: c[0] });
  }
  return issues;
}

function tarjan(ids, next) {
  let index = 0; const idx = new Map(), low = new Map(), stack = [], on = new Set(), out = [];
  const visit = v => {
    idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
    for (const w of next(v)) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) { const c = []; let w; do { w = stack.pop(); on.delete(w); c.push(w); } while (w !== v); out.push(c); }
  };
  for (const v of ids) if (!idx.has(v)) visit(v);
  return out;
}
