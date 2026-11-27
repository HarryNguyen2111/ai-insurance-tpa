/**
 * VWF-03 (#80) server-side publish validator for WorkflowDefinitionContent (spec 14 §3.5).
 * Reproduces the VWF-01 test oracle (packages/shared-contracts/test/workflow-graph-oracle.mjs)
 * code-for-code: a parity test runs both on the same vectors. Node-only (crypto/Ajv):
 * never import this module from Temporal workflow code.
 * Issues carry fixed detail codes and JSON pointers only; labels/values are never echoed.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { ActionCatalog, DefinitionContent, DefinitionEdge, DefinitionNode, NodeType } from './definition.ts';

// The OpenAPI-derived Ajv validator ships as CommonJS; load it with an explicit, narrow signature.
const { validate } = createRequire(import.meta.url)('@tpa/shared-contracts') as { validate(name: string, value: unknown): boolean };

export const PHASE1_BENEFIT_TYPES = Object.freeze(['OUTPATIENT', 'DENTAL', 'INPATIENT']);
export const START_PROVIDES = Object.freeze(['CLAIM_REF', 'DOCUMENT_SET']);
export const MAX_CANONICAL_BYTES = 64 * 1024;
export const REF_KINDS = Object.freeze(['modelRef', 'promptRef', 'policyRef', 'formRef'] as const);
const INT_VARS = ['EXTRACTION_LOW_CONFIDENCE_FIELD_COUNT', 'EXTRACTION_QUALITY_FLAG_COUNT', 'DOCUMENTS_MISSING_REQUIRED_SLOT_COUNT', 'SUPPLEMENT_ROUND'];
const GUARDS: Record<NodeType, string[]> = {
  START: ['NEXT'], TIMER: ['NEXT'], HUMAN_TASK: ['ACTION'], AI_ACTIVITY: ['OUTCOME'], SUPPLEMENT_WAIT: ['OUTCOME'], CONDITION: ['CONDITION', 'DEFAULT'], END: [],
};
const OUTCOMES: Partial<Record<NodeType, string[]>> = { AI_ACTIVITY: ['SUCCEEDED', 'FAILED'], SUPPLEMENT_WAIT: ['RECEIVED', 'EXPIRED'] };

export interface ValidationIssue { detailCode: string; path: string; nodeId?: string; edgeId?: string }
export interface ValidationContext {
  /** Pinned catalog for content.actionCatalogVersion (global v1 by default upstream). */
  catalog: ActionCatalog;
  /** "key@version#hash" PUBLISHED for this tenant. Undefined skips the check (validate-only preview). */
  publishedRefs?: ReadonlySet<string>;
  /** benefitType -> workflowKey of other PUBLISHED definitions of the same tenant. */
  otherPublishedScopes?: Readonly<Record<string, string>>;
}

/** Sorted keys, UTF-8, no whitespace (spec 11 §6.2 / spec 14 §3.1). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function contentHash(content: unknown): string {
  return createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex');
}
export const refKey = (ref: { key: string; version: number; hash: string }) => `${ref.key}@${ref.version}#${ref.hash}`;
/** Every pinned reference of a definition (deduplicated, deterministic order). */
export function pinnedRefs(content: DefinitionContent): { kind: typeof REF_KINDS[number]; key: string; version: number; hash: string }[] {
  const seen = new Map<string, { kind: typeof REF_KINDS[number]; key: string; version: number; hash: string }>();
  for (const n of content.nodes) for (const kind of REF_KINDS) {
    const r = n[kind];
    if (r) seen.set(`${kind}:${refKey(r)}`, { kind, key: r.key, version: r.version, hash: r.hash });
  }
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
}

/** Validate any OpenAPI component (no coercion, no echo). Business/authorization checks stay server-side. */
export function validateContract(name: string, value: unknown): boolean { return validate(name, value); }

export function isDefinitionContent(value: unknown): value is DefinitionContent {
  return validate('WorkflowDefinitionContent', value);
}

type IndexedEdge = DefinitionEdge & { index: number };
export function validateDefinitionContent(content: unknown, ctx: ValidationContext): ValidationIssue[] {
  if (!isDefinitionContent(content)) return [{ detailCode: 'SCHEMA_INVALID', path: '/' }];
  const { catalog, publishedRefs, otherPublishedScopes } = ctx;
  const issues: ValidationIssue[] = [];
  const add = (detailCode: string, path: string, extra: { nodeId?: string; edgeId?: string } = {}) => { issues.push({ detailCode, path, ...extra }); };
  if (Buffer.byteLength(canonicalJson(content), 'utf8') > MAX_CANONICAL_BYTES) add('LIMIT_EXCEEDED', '/');
  const { nodes, edges } = content;
  const byId = new Map<string, DefinitionNode>();
  nodes.forEach((n, i) => { if (byId.has(n.nodeId)) add('DUPLICATE_ID', `/nodes/${i}/nodeId`, { nodeId: n.nodeId }); else byId.set(n.nodeId, n); });
  const edgeIds = new Set<string>();
  edges.forEach((e, i) => { if (edgeIds.has(e.edgeId)) add('DUPLICATE_ID', `/edges/${i}/edgeId`, { edgeId: e.edgeId }); edgeIds.add(e.edgeId); });
  const ruleKeys = new Set<string>();
  content.assignmentPolicy.rules.forEach((r, i) => { if (ruleKeys.has(r.ruleKey)) add('DUPLICATE_ID', `/assignmentPolicy/rules/${i}/ruleKey`); ruleKeys.add(r.ruleKey); });

  const starts = nodes.filter(n => n.type === 'START');
  if (starts.length !== 1) add('EXACTLY_ONE_START_REQUIRED', '/nodes');
  if (!nodes.some(n => n.type === 'END')) add('END_REQUIRED', '/nodes');
  if (!content.scope.benefitTypes.every(b => PHASE1_BENEFIT_TYPES.includes(b))) add('SCOPE_NOT_APPROVED', '/scope/benefitTypes');
  if (content.actionCatalogVersion !== catalog.catalogVersion) add('CATALOG_VERSION_UNKNOWN', '/actionCatalogVersion');
  if (otherPublishedScopes && content.scope.benefitTypes.some(b => otherPublishedScopes[b] && otherPublishedScopes[b] !== content.workflowKey)) {
    add('AMBIGUOUS_BINDING', '/scope/benefitTypes');
  }

  const valid: IndexedEdge[] = [];
  edges.forEach((e, i) => {
    const s = byId.get(e.source), t = byId.get(e.target);
    if (!s || !t) { add('DANGLING_EDGE', `/edges/${i}`, { edgeId: e.edgeId }); return; }
    if (e.source === e.target) { add('SELF_LOOP', `/edges/${i}`, { edgeId: e.edgeId }); return; }
    if (t.type === 'START') add('START_HAS_INCOMING', `/edges/${i}/target`, { edgeId: e.edgeId });
    if (s.type === 'END') { add('END_HAS_OUTGOING', `/edges/${i}/source`, { edgeId: e.edgeId }); return; }
    if (!GUARDS[s.type].includes(e.guard.kind) || (e.loopBack && s.type !== 'CONDITION')) { add('GUARD_NOT_ALLOWED_FOR_SOURCE', `/edges/${i}/guard`, { edgeId: e.edgeId }); return; }
    if (e.guard.kind === 'OUTCOME' && !OUTCOMES[s.type]!.includes(e.guard.outcome)) { add('GUARD_NOT_ALLOWED_FOR_SOURCE', `/edges/${i}/guard`, { edgeId: e.edgeId }); return; }
    valid.push({ ...e, index: i });
  });
  const out = (id: string) => valid.filter(e => e.source === id);
  const catalogById = new Map(catalog.actions.map(a => [a.actionId, a]));
  const actionOf = (e: IndexedEdge) => (e.guard.kind === 'ACTION' ? e.guard.actionId : undefined);
  const outcomeOf = (e: IndexedEdge) => (e.guard.kind === 'OUTCOME' ? e.guard.outcome : undefined);

  nodes.forEach((n, i) => {
    const path = `/nodes/${i}`; const es = out(n.nodeId); const at = { nodeId: n.nodeId };
    const once = (pred: (e: IndexedEdge) => boolean, missing: string, label: string) => {
      const hits = es.filter(pred);
      if (hits.length === 0) add(missing, `${path}/${label}`, at);
      if (hits.length > 1) add('DUPLICATE_ROUTE', `${path}/${label}`, at);
    };
    if (n.type === 'START' || n.type === 'TIMER') once(() => true, 'DEAD_END', 'next');
    if (n.type === 'HUMAN_TASK' || n.type === 'AI_ACTIVITY') {
      for (const a of n.allowedActionIds ?? []) {
        const entry = catalogById.get(a);
        const actor = n.type === 'HUMAN_TASK' ? 'HUMAN' : 'AI_SERVICE';
        if (!entry || !entry.nodeTypes.includes(n.type) || entry.actorKind !== actor) add('ACTION_NOT_ALLOWED_FOR_NODE', `${path}/allowedActionIds`, at);
      }
    }
    if (n.type === 'HUMAN_TASK') {
      const allowed = n.allowedActionIds ?? [];
      for (const a of allowed) once(e => actionOf(e) === a, 'MISSING_ACTION_ROUTE', `allowedActionIds/${a}`);
      for (const e of es) if (!allowed.includes(actionOf(e) as string)) add('ACTION_NOT_ALLOWED_FOR_NODE', `/edges/${e.index}/guard`, { edgeId: e.edgeId });
      if (!ruleKeys.has(n.assignmentRuleKey as string)) add('UNKNOWN_ASSIGNMENT_RULE', `${path}/assignmentRuleKey`, at);
    }
    const outcomes = OUTCOMES[n.type];
    if (outcomes) for (const o of outcomes) once(e => outcomeOf(e) === o, 'MISSING_OUTCOME_ROUTE', `outcome/${o}`);
    if (n.type === 'AI_ACTIVITY') {
      const fail = es.find(e => outcomeOf(e) === 'FAILED');
      if (fail && byId.get(fail.target)?.type !== 'HUMAN_TASK') add('AI_FAILURE_NOT_ROUTED_TO_HUMAN', `/edges/${fail.index}/target`, { edgeId: fail.edgeId });
    }
    if (n.type === 'CONDITION') {
      const defaults = es.filter(e => e.guard.kind === 'DEFAULT');
      if (defaults.length !== 1) add('MISSING_DEFAULT_BRANCH', `${path}`, at);
      const conds = es.filter(e => e.guard.kind === 'CONDITION');
      if (conds.length === 0) add('MISSING_OUTCOME_ROUTE', `${path}`, at);
      if (new Set(conds.map(e => (e.guard as { priority: number }).priority)).size !== conds.length) add('DUPLICATE_PRIORITY', `${path}`, at);
      for (const e of conds) {
        const c = (e.guard as { condition: Record<string, unknown> }).condition;
        const leaves = (c.all ?? c.any ?? [c]) as { variable: string; op: string; value: unknown }[];
        for (const l of leaves) {
          const okType = INT_VARS.includes(l.variable)
            ? Number.isInteger(l.value) && l.op !== 'IN'
            : l.op === 'IN' ? Array.isArray(l.value) : ['EQ', 'NEQ'].includes(l.op) && typeof l.value === 'string';
          if (!okType) add('CONDITION_TYPE_MISMATCH', `/edges/${e.index}/guard/condition`, { edgeId: e.edgeId });
        }
      }
    }
    if (publishedRefs) for (const k of REF_KINDS) {
      const r = n[k];
      if (r && !publishedRefs.has(refKey(r))) add('REFERENCE_NOT_PUBLISHED', `${path}/${k}`, at);
    }
  });

  content.assignmentPolicy.rules.forEach((r, i) => {
    if (r.candidateGroupKeys) add('GROUP_DIRECTORY_UNAVAILABLE', `/assignmentPolicy/rules/${i}/candidateGroupKeys`);
    for (const d of r.distinctFromNodeIds) if (byId.get(d)?.type !== 'HUMAN_TASK') add('UNKNOWN_ASSIGNMENT_RULE', `/assignmentPolicy/rules/${i}/distinctFromNodeIds`);
  });

  const reach = (seeds: string[], next: (id: string) => string[]) => {
    const seen = new Set(seeds); const q = [...seeds];
    while (q.length) for (const x of next(q.shift()!)) if (!seen.has(x)) { seen.add(x); q.push(x); }
    return seen;
  };
  const fwd = reach(starts.map(s => s.nodeId), id => out(id).map(e => e.target));
  const back = reach(nodes.filter(n => n.type === 'END').map(n => n.nodeId), id => valid.filter(e => e.target === id).map(e => e.source));
  nodes.forEach((n, i) => {
    if (!fwd.has(n.nodeId)) add('UNREACHABLE_NODE', `/nodes/${i}`, { nodeId: n.nodeId });
    else if (!back.has(n.nodeId)) add('DEAD_END', `/nodes/${i}`, { nodeId: n.nodeId });
  });

  nodes.forEach((n, i) => {
    if (!n.inputSchemas) return;
    const preds = (id: string) => valid.filter(e => e.target === id).map(e => e.source);
    const ancestors = reach(preds(n.nodeId), preds);
    const produced = new Set([...START_PROVIDES, ...[...ancestors].flatMap(a => byId.get(a)?.outputSchemas ?? [])]);
    for (const s of n.inputSchemas) if (!produced.has(s)) add('INPUT_NOT_PRODUCED', `/nodes/${i}/inputSchemas`, { nodeId: n.nodeId });
  });

  const ids = nodes.map(n => n.nodeId);
  for (const c of tarjan(ids, id => out(id).filter(e => !e.loopBack).map(e => e.target)).filter(c => c.length > 1)) {
    add('UNBOUNDED_LOOP', '/edges', { nodeId: c[0] });
  }
  const gate = (id: string) => ['HUMAN_TASK', 'SUPPLEMENT_WAIT'].includes(byId.get(id)?.type as string);
  const ungated = ids.filter(id => !gate(id));
  for (const c of tarjan(ungated, id => out(id).map(e => e.target).filter(t => !gate(t))).filter(c => c.length > 1)) {
    add('LOOP_WITHOUT_HUMAN_OR_WAIT', '/edges', { nodeId: c[0] });
  }
  return issues;
}

function tarjan(ids: string[], next: (id: string) => string[]): string[][] {
  let index = 0; const idx = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>(), out: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
    for (const w of next(v)) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) { const c: string[] = []; let w: string; do { w = stack.pop()!; on.delete(w); c.push(w); } while (w !== v); out.push(c); }
  };
  for (const v of ids) if (!idx.has(v)) visit(v);
  return out;
}
