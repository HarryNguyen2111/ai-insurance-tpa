import { validate, type components } from '@tpa/shared-contracts';

export type WorkflowContent = components['schemas']['WorkflowDefinitionContent'];
export type WorkflowNode = WorkflowContent['nodes'][number];
export type WorkflowEdge = WorkflowContent['edges'][number];
export type NodeType = WorkflowNode['type'];
export interface WorkflowIssue { detailCode: string; path: string; nodeId?: string; edgeId?: string }
export interface Point { x: number; y: number }
export interface WorkflowLayout {
  nodes: Record<string, Point & { width: number; height: number }>;
  edges: Record<string, Point[]>;
  labels?: Record<string, Point & { width: number; height: number }>;
}
export interface EditorDocument { content: WorkflowContent; layout: WorkflowLayout }
export const NODE_LABELS: Record<NodeType, string> = {
  START: 'Bắt đầu', END: 'Kết thúc', HUMAN_TASK: 'Người xử lý', AI_ACTIVITY: 'AI đề xuất',
  CONDITION: 'Điều kiện', SUPPLEMENT_WAIT: 'Chờ bổ sung', TIMER: 'Hẹn giờ',
};
export const NODE_TYPES = Object.keys(NODE_LABELS) as NodeType[];
export const HUMAN_ACTIONS = ['CONFIRM_EXTRACTION', 'REQUEST_SUPPLEMENT', 'ESCALATE_TO_MANUAL_REVIEW'] as const;
export const AI_ACTIONS = ['PROPOSE_EXTRACTION', 'PROPOSE_DOCUMENT_LABEL', 'PROPOSE_QUALITY_FLAG'] as const;
export const MAX_CONTENT_BYTES = 64 * 1024;
export const isWorkflowContent = (value: unknown): value is WorkflowContent => validate('WorkflowDefinitionContent', value);
export const isWorkflowNode = (value: unknown): value is WorkflowNode => validate('WorkflowNode', value);
export const isWorkflowEdge = (value: unknown): value is WorkflowEdge => validate('WorkflowEdge', value);
export const isAssignmentPolicy = (value: unknown): value is WorkflowContent['assignmentPolicy'] => validate('WorkflowAssignmentPolicy', value);
export const byteLength = (text: string) => new TextEncoder().encode(text).length;
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function newDocument(): EditorDocument {
  return {
    content: {
      schemaVersion: '1.0.0', workflowKey: 'local_review', title: 'Quy trình mẫu cục bộ',
      scope: { benefitTypes: ['OUTPATIENT'] }, actionCatalogVersion: 1,
      assignmentPolicy: { schemaVersion: '1.0.0', rules: [{
        ruleKey: 'reviewer_queue', candidateRoles: ['CLAIM_REVIEWER'], strategy: 'QUEUE_CLAIM',
        accountableOwner: 'CASE_OWNER', distinctFromNodeIds: [], maxActiveTasksPerAssignee: 1,
      }] },
      nodes: [{ nodeId: 'start', type: 'START', label: 'Bắt đầu' }, { nodeId: 'end', type: 'END', label: 'Kết thúc', outcome: 'ROUTED_TO_MANUAL_REVIEW' }],
      edges: [{ edgeId: 'start_end', source: 'start', target: 'end', guard: { kind: 'NEXT' } }],
    },
    layout: { nodes: { start: { x: 80, y: 180, width: 36, height: 36 }, end: { x: 680, y: 180, width: 36, height: 36 } }, edges: {} },
  };
}

/** Incomplete templates deliberately require owner configuration, never SLA/AI policy defaults. */
export function newNode(type: NodeType, nodeId: string): WorkflowNode {
  const base = { type, nodeId, label: NODE_LABELS[type] };
  const io = { inputSchemas: [], outputSchemas: [] };
  switch (type) {
    case 'START': return { ...base, type };
    case 'END': return { ...base, type, outcome: 'ROUTED_TO_MANUAL_REVIEW' };
    case 'CONDITION': return { ...base, type };
    case 'TIMER': return { ...base, type, delaySeconds: 0 };
    case 'SUPPLEMENT_WAIT': return { ...base, ...io, type, maxWaitSeconds: 0, accountableOwner: 'CASE_OWNER' };
    case 'HUMAN_TASK': return { ...base, ...io, type, taskKind: 'DOCUMENT_REVIEW', allowedActionIds: [],
      assignmentRuleKey: 'reviewer_queue', accountableOwner: 'CASE_OWNER', sla: { dueSeconds: 0, escalateTo: 'CASE_OWNER' },
      allowedEvidence: { documentTypes: [], sources: [] } };
    case 'AI_ACTIVITY': {
      const ref = { key: 'configure.required', version: 1, hash: '0'.repeat(64) };
      return { ...base, ...io, type, activityKind: 'DOCUMENT_EXTRACTION', allowedActionIds: [], serviceActorScopeKey: 'configure.required',
        accountableOwner: 'CASE_OWNER', modelRef: { ...ref }, promptRef: { ...ref }, policyRef: { ...ref },
        allowedEvidence: { documentTypes: [], sources: [] }, timeoutSeconds: 0,
        retry: { maxAttempts: 1, initialIntervalSeconds: 1, backoffCoefficient: 1, maxIntervalSeconds: 1 } };
    }
  }
}

export function suggestedGuard(node: WorkflowNode, existing: WorkflowEdge[]): WorkflowEdge['guard'] {
  if (node.type === 'HUMAN_TASK') return { kind: 'ACTION', actionId: node.allowedActionIds.find(a => !existing.some(e => e.guard.kind === 'ACTION' && e.guard.actionId === a)) ?? 'ESCALATE_TO_MANUAL_REVIEW' };
  if (node.type === 'AI_ACTIVITY' || node.type === 'SUPPLEMENT_WAIT') {
    const outcomes = node.type === 'AI_ACTIVITY' ? ['SUCCEEDED', 'FAILED'] as const : ['RECEIVED', 'EXPIRED'] as const;
    return { kind: 'OUTCOME', outcome: outcomes.find(o => !existing.some(e => e.guard.kind === 'OUTCOME' && e.guard.outcome === o)) ?? outcomes[0] };
  }
  if (node.type === 'CONDITION') return existing.some(e => e.guard.kind === 'DEFAULT')
    ? { kind: 'CONDITION', priority: 1, condition: { variable: 'SUPPLEMENT_ROUND', op: 'LTE', value: 1 } } : { kind: 'DEFAULT' };
  return { kind: 'NEXT' };
}

/** Feedback only. Tenant binding, published references, MFA and authorization require #80/#21. */
export function validateLocal(content: unknown): WorkflowIssue[] {
  if (byteLength(canonicalJson(content)) > MAX_CONTENT_BYTES) return [{ detailCode: 'LIMIT_EXCEEDED', path: '/' }];
  if (!validate('WorkflowDefinitionContent', content)) return [{ detailCode: 'SCHEMA_INVALID', path: '/' }];
  const c = content as WorkflowContent;
  const issues: WorkflowIssue[] = [];
  const add = (detailCode: string, path: string, nodeId?: string) => issues.push({ detailCode, path, ...(nodeId ? { nodeId } : {}) });
  const nodes = new Map(c.nodes.map(n => [n.nodeId, n]));
  for (const [items, field, path] of [[c.nodes, 'nodeId', '/nodes'], [c.edges, 'edgeId', '/edges'], [c.assignmentPolicy.rules, 'ruleKey', '/assignmentPolicy/rules']] as const) {
    const ids = items.map(item => (item as unknown as Record<string, string>)[field]);
    if (new Set(ids).size !== ids.length) add('DUPLICATE_ID', path);
  }
  if (c.nodes.filter(n => n.type === 'START').length !== 1) add('EXACTLY_ONE_START_REQUIRED', '/nodes');
  if (!c.nodes.some(n => n.type === 'END')) add('END_REQUIRED', '/nodes');
  if (c.scope.benefitTypes.some(b => !['OUTPATIENT', 'DENTAL', 'INPATIENT'].includes(b))) add('SCOPE_NOT_APPROVED', '/scope/benefitTypes');
  if (c.actionCatalogVersion !== 1) add('CATALOG_VERSION_UNKNOWN', '/actionCatalogVersion');
  const kinds = { START: ['NEXT'], END: [], HUMAN_TASK: ['ACTION'], AI_ACTIVITY: ['OUTCOME'], SUPPLEMENT_WAIT: ['OUTCOME'], TIMER: ['NEXT'], CONDITION: ['CONDITION', 'DEFAULT'] };
  const edges = c.edges.filter((e, i) => {
    const s = nodes.get(e.source), t = nodes.get(e.target), path = `/edges/${i}`;
    if (!s || !t) { add('DANGLING_EDGE', path); return false; }
    if (e.source === e.target) add('SELF_LOOP', path);
    if (t.type === 'START') add('START_HAS_INCOMING', path);
    if (s.type === 'END') add('END_HAS_OUTGOING', path);
    if (!(kinds[s.type] as string[]).includes(e.guard.kind) || (e.loopBack && s.type !== 'CONDITION')) add('GUARD_NOT_ALLOWED_FOR_SOURCE', path);
    if (e.guard.kind === 'OUTCOME' && !(s.type === 'AI_ACTIVITY' ? ['SUCCEEDED', 'FAILED'] : s.type === 'SUPPLEMENT_WAIT' ? ['RECEIVED', 'EXPIRED'] : []).includes(e.guard.outcome)) add('GUARD_NOT_ALLOWED_FOR_SOURCE', path);
    if (s.type === 'AI_ACTIVITY' && e.guard.kind === 'OUTCOME' && e.guard.outcome === 'FAILED' && t.type !== 'HUMAN_TASK') add('AI_FAILURE_NOT_ROUTED_TO_HUMAN', path);
    if (e.guard.kind === 'ACTION' && s.type === 'HUMAN_TASK' && !s.allowedActionIds.includes(e.guard.actionId)) add('ACTION_NOT_ALLOWED_FOR_NODE', path);
    if (e.guard.kind === 'CONDITION') {
      const cond = e.guard.condition;
      const leaves = 'all' in cond ? cond.all : 'any' in cond ? cond.any : [cond];
      for (const leaf of leaves) {
        const valid = leaf.variable === 'CLAIM_BENEFIT_TYPE'
          ? leaf.op === 'IN' ? Array.isArray(leaf.value) : ['EQ', 'NEQ'].includes(leaf.op) && typeof leaf.value === 'string'
          : leaf.op !== 'IN' && Number.isInteger(leaf.value);
        if (!valid) add('CONDITION_TYPE_MISMATCH', `${path}/guard/condition`);
      }
    }
    return true;
  });
  const outgoing = (id: string) => edges.filter(e => e.source === id);
  const incoming = (id: string) => edges.filter(e => e.target === id);
  const reach = (seeds: string[], next: (id: string) => string[]) => {
    const seen = new Set(seeds), queue = [...seeds];
    for (let i = 0; i < queue.length; i++) for (const id of next(queue[i])) if (!seen.has(id)) { seen.add(id); queue.push(id); }
    return seen;
  };
  const fromStart = reach(c.nodes.filter(n => n.type === 'START').map(n => n.nodeId), id => outgoing(id).map(e => e.target));
  const toEnd = reach(c.nodes.filter(n => n.type === 'END').map(n => n.nodeId), id => incoming(id).map(e => e.source));
  c.nodes.forEach((n, i) => {
    const path = `/nodes/${i}`, out = outgoing(n.nodeId);
    if (!fromStart.has(n.nodeId)) add('UNREACHABLE_NODE', path, n.nodeId);
    if (n.type !== 'END' && !toEnd.has(n.nodeId)) add('DEAD_END', path, n.nodeId);
    const required = n.type === 'HUMAN_TASK' ? n.allowedActionIds : n.type === 'AI_ACTIVITY' ? ['SUCCEEDED', 'FAILED'] : n.type === 'SUPPLEMENT_WAIT' ? ['RECEIVED', 'EXPIRED'] : n.type === 'START' || n.type === 'TIMER' ? ['NEXT'] : [];
    for (const route of required) {
      const count = out.filter(e => e.guard.kind === 'ACTION' ? e.guard.actionId === route : e.guard.kind === 'OUTCOME' ? e.guard.outcome === route : e.guard.kind === route).length;
      if (!count) add(n.type === 'HUMAN_TASK' ? 'MISSING_ACTION_ROUTE' : n.type === 'START' || n.type === 'TIMER' ? 'DEAD_END' : 'MISSING_OUTCOME_ROUTE', path, n.nodeId);
      if (count > 1) add('DUPLICATE_ROUTE', path, n.nodeId);
    }
    if (n.type === 'CONDITION') {
      if (out.filter(e => e.guard.kind === 'DEFAULT').length !== 1) add('MISSING_DEFAULT_BRANCH', path, n.nodeId);
      const conditions = out.flatMap(e => e.guard.kind === 'CONDITION' ? [e.guard] : []);
      if (!conditions.length) add('MISSING_OUTCOME_ROUTE', path, n.nodeId);
      if (new Set(conditions.map(g => g.priority)).size !== conditions.length) add('DUPLICATE_PRIORITY', path, n.nodeId);
    }
    if (n.type === 'HUMAN_TASK' && !c.assignmentPolicy.rules.some(r => r.ruleKey === n.assignmentRuleKey)) add('UNKNOWN_ASSIGNMENT_RULE', `${path}/assignmentRuleKey`, n.nodeId);
    if ('inputSchemas' in n) {
      const ancestors = reach(incoming(n.nodeId).map(e => e.source), id => incoming(id).map(e => e.source));
      const produced = new Set(['CLAIM_REF', 'DOCUMENT_SET', ...[...ancestors].flatMap(id => { const node = nodes.get(id); return node && 'outputSchemas' in node ? node.outputSchemas : []; })]);
      if (n.inputSchemas.some(s => !produced.has(s))) add('INPUT_NOT_PRODUCED', `${path}/inputSchemas`, n.nodeId);
    }
  });
  c.assignmentPolicy.rules.forEach((r, i) => {
    if (r.candidateGroupKeys) add('GROUP_DIRECTORY_UNAVAILABLE', `/assignmentPolicy/rules/${i}/candidateGroupKeys`);
    if (r.distinctFromNodeIds.some(id => nodes.get(id)?.type !== 'HUMAN_TASK')) add('UNKNOWN_ASSIGNMENT_RULE', `/assignmentPolicy/rules/${i}/distinctFromNodeIds`);
  });
  // A cycle after deleting loopBack edges is unbounded. Every cycle must also cross a human/wait.
  const hasCycle = (selected: WorkflowEdge[], ids: string[]) => {
    const active = new Set<string>(), done = new Set<string>(), allowed = new Set(ids);
    const visit = (id: string): boolean => {
      if (active.has(id)) return true;
      if (done.has(id)) return false;
      active.add(id);
      if (selected.some(e => e.source === id && allowed.has(e.target) && visit(e.target))) return true;
      active.delete(id); done.add(id); return false;
    };
    return ids.some(visit);
  };
  if (hasCycle(edges.filter(e => !e.loopBack), [...nodes.keys()])) add('UNBOUNDED_LOOP', '/edges');
  if (hasCycle(edges, c.nodes.filter(n => !['HUMAN_TASK', 'SUPPLEMENT_WAIT'].includes(n.type)).map(n => n.nodeId))) add('LOOP_WITHOUT_HUMAN_OR_WAIT', '/edges');
  return issues;
}
