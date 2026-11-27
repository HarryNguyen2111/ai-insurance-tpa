/**
 * VWF-03 (#80) constrained workflow definitions (spec 14). Deterministic and IO-free:
 * NO Node imports, clock or randomness, so it is safe for the Temporal workflow
 * sandbox and for Activities alike. Definitions are DATA interpreted by a fixed
 * stepper; there is no expression language, script, URL or dynamic code path.
 * Only ids/codes/counters derived here may enter Temporal history (spec 06 §3).
 */
import { WorkflowContractError } from './contracts.ts';

export const DEFINITION_WORKFLOW_TYPE = 'definitionExecutionWorkflow';
export const DEFINITION_COMMAND_SIGNAL = 'definitionCommand';

export type NodeType = 'START' | 'END' | 'HUMAN_TASK' | 'AI_ACTIVITY' | 'CONDITION' | 'SUPPLEMENT_WAIT' | 'TIMER';
export type EndOutcome = 'REVIEW_COMPLETED' | 'ROUTED_TO_MANUAL_REVIEW' | 'SUPPLEMENT_EXPIRED';
export type BenefitType = 'OUTPATIENT' | 'INPATIENT' | 'DENTAL' | 'MATERNITY' | 'ACCIDENT' | 'HOSPITAL_INCOME';
export interface PinnedRef { key: string; version: number; hash: string }
export interface RetryPolicy { maxAttempts: number; initialIntervalSeconds: number; backoffCoefficient: number; maxIntervalSeconds: number }
export interface ConditionLeaf { variable: string; op: 'EQ' | 'NEQ' | 'GT' | 'GTE' | 'LT' | 'LTE' | 'IN'; value: number | string | string[] }
export type Condition = ConditionLeaf | { all: ConditionLeaf[] } | { any: ConditionLeaf[] };
export type EdgeGuard =
  | { kind: 'NEXT' } | { kind: 'DEFAULT' } | { kind: 'ACTION'; actionId: string }
  | { kind: 'OUTCOME'; outcome: 'SUCCEEDED' | 'FAILED' | 'RECEIVED' | 'EXPIRED' }
  | { kind: 'CONDITION'; priority: number; condition: Condition };
export interface DefinitionEdge { edgeId: string; source: string; target: string; guard: EdgeGuard; loopBack?: { maxIterations: number } }
/** Structural view of the OpenAPI WorkflowNode union; JSON Schema validation is authoritative. */
export interface DefinitionNode {
  nodeId: string; type: NodeType; label: string; outcome?: EndOutcome;
  allowedActionIds?: string[]; assignmentRuleKey?: string; inputSchemas?: string[]; outputSchemas?: string[];
  activityKind?: string; timeoutSeconds?: number; retry?: RetryPolicy; maxWaitSeconds?: number; delaySeconds?: number;
  modelRef?: PinnedRef; promptRef?: PinnedRef; policyRef?: PinnedRef; formRef?: PinnedRef;
  [extra: string]: unknown;
}
export interface AssignmentRule { ruleKey: string; distinctFromNodeIds: string[]; candidateGroupKeys?: string[]; [extra: string]: unknown }
export interface DefinitionContent {
  schemaVersion: '1.0.0'; workflowKey: string; title: string; scope: { benefitTypes: BenefitType[] };
  actionCatalogVersion: number; assignmentPolicy: { schemaVersion: '1.0.0'; rules: AssignmentRule[] };
  nodes: DefinitionNode[]; edges: DefinitionEdge[];
}

export interface CatalogAction {
  actionId: string; nodeTypes: NodeType[]; actorKind: 'HUMAN' | 'AI_SERVICE'; allowedRelationships: string[];
  requiresMfa: boolean; completesTask: boolean; requiresEvidence: boolean; requiresIdempotencyKey: true;
  businessEffect: 'TASK_LIFECYCLE' | 'EVIDENCE_ONLY' | 'ROUTE_WORKFLOW'; auditAction: string;
}
export interface ActionCatalog { schemaVersion: '1.0.0'; catalogVersion: number; actions: CatalogAction[] }

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { for (const v of Object.values(value)) deepFreeze(v); Object.freeze(value); }
  return value;
};
const human = (actionId: string, rel: string[], completesTask: boolean, requiresEvidence: boolean, effect: CatalogAction['businessEffect'], auditAction: string): CatalogAction =>
  ({ actionId, nodeTypes: ['HUMAN_TASK'], actorKind: 'HUMAN', allowedRelationships: rel, requiresMfa: true, completesTask, requiresEvidence, requiresIdempotencyKey: true, businessEffect: effect, auditAction });
const ai = (actionId: string, auditAction: string): CatalogAction =>
  ({ actionId, nodeTypes: ['AI_ACTIVITY'], actorKind: 'AI_SERVICE', allowedRelationships: ['AI_SCOPE_BINDING'], requiresMfa: false, completesTask: false, requiresEvidence: true, requiresIdempotencyKey: true, businessEffect: 'EVIDENCE_ONLY', auditAction });
/** Immutable global catalog v1 (14a). A unit test keeps it byte-equal to the spec. */
export const ACTION_CATALOG_V1: ActionCatalog = deepFreeze({ schemaVersion: '1.0.0', catalogVersion: 1, actions: [
  human('CLAIM_TASK', ['CANDIDATE'], false, false, 'TASK_LIFECYCLE', 'WORKFLOW_TASK_CLAIMED'),
  human('UNCLAIM_TASK', ['ASSIGNEE', 'SUPERVISOR'], false, false, 'TASK_LIFECYCLE', 'WORKFLOW_TASK_RELEASED'),
  human('REASSIGN_TASK', ['SUPERVISOR', 'CASE_OWNER'], false, false, 'TASK_LIFECYCLE', 'WORKFLOW_TASK_REASSIGNED'),
  human('ADD_ANNOTATION', ['ASSIGNEE', 'SUPERVISOR'], false, true, 'EVIDENCE_ONLY', 'WORKFLOW_ANNOTATION_ADDED'),
  human('CONFIRM_EXTRACTION', ['ASSIGNEE'], true, true, 'ROUTE_WORKFLOW', 'WORKFLOW_EXTRACTION_CONFIRMED'),
  human('REQUEST_SUPPLEMENT', ['ASSIGNEE'], true, false, 'ROUTE_WORKFLOW', 'WORKFLOW_SUPPLEMENT_REQUESTED'),
  human('ESCALATE_TO_MANUAL_REVIEW', ['ASSIGNEE', 'SUPERVISOR'], true, false, 'ROUTE_WORKFLOW', 'WORKFLOW_ESCALATED_TO_MANUAL'),
  ai('PROPOSE_EXTRACTION', 'WORKFLOW_AI_EXTRACTION_PROPOSED'),
  ai('PROPOSE_DOCUMENT_LABEL', 'WORKFLOW_AI_LABEL_PROPOSED'),
  ai('PROPOSE_QUALITY_FLAG', 'WORKFLOW_AI_QUALITY_FLAG_PROPOSED'),
] });
/** Known global catalogs. Unknown versions fail closed (CATALOG_VERSION_UNKNOWN). */
export function actionCatalog(version: number): ActionCatalog | undefined {
  return version === ACTION_CATALOG_V1.catalogVersion ? ACTION_CATALOG_V1 : undefined;
}

// ---------------------------------------------------------------- execution contracts
const UUID_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID = new RegExp(`^${UUID_SRC}$`);
const HASH = /^[0-9a-f]{64}$/;
const NODE_ID = /^[a-z][a-z0-9_]{1,39}$/;
const DEF_COMMAND_ID = new RegExp(`^(evt|cmd)-${UUID_SRC}$`);
const EXECUTION_WORKFLOW_ID = new RegExp(`^wfexec/${UUID_SRC}/${UUID_SRC}$`);

/** Exact pin carried into Temporal: ids, version and hash only (never content). */
export interface DefinitionExecutionRef {
  tenantId: string; claimId: string; executionId: string; definitionId: string; versionNo: number; contentHash: string;
}
export type DefinitionCommandKind = 'TASK_ACTION' | 'SUPPLEMENT_RECEIVED' | 'SUSPENDED_ESCALATION';
/** Resume command. `commandId` is the semantic idempotency key across retries/redelivery. */
export interface DefinitionCommand { commandId: string; kind: DefinitionCommandKind; nodeId: string; actionId: string | null }

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(value, k));
}
export function assertDefinitionExecutionRef(value: unknown): asserts value is DefinitionExecutionRef {
  if (!exactKeys(value, ['tenantId', 'claimId', 'executionId', 'definitionId', 'versionNo', 'contentHash'])
    || !['tenantId', 'claimId', 'executionId', 'definitionId'].every(k => typeof value[k] === 'string' && UUID.test(value[k] as string))
    || !Number.isSafeInteger(value.versionNo) || (value.versionNo as number) < 1 || (value.versionNo as number) > 2147483647
    || typeof value.contentHash !== 'string' || !HASH.test(value.contentHash)) {
    throw new WorkflowContractError('Invalid definition execution reference');
  }
}
export function assertDefinitionCommand(value: unknown): asserts value is DefinitionCommand {
  if (!exactKeys(value, ['commandId', 'kind', 'nodeId', 'actionId'])
    || typeof value.commandId !== 'string' || !DEF_COMMAND_ID.test(value.commandId)
    || !['TASK_ACTION', 'SUPPLEMENT_RECEIVED', 'SUSPENDED_ESCALATION'].includes(value.kind as string)
    || typeof value.nodeId !== 'string' || !NODE_ID.test(value.nodeId)
    || (value.kind === 'TASK_ACTION' ? typeof value.actionId !== 'string' || !/^[A-Z][A-Z_]{2,39}$/.test(value.actionId) : value.actionId !== null)) {
    throw new WorkflowContractError('Invalid definition command');
  }
}
/** Stable workflow id `wfexec/{tenantId}/{executionId}`; one execution per claim is enforced in PostgreSQL. */
export function definitionWorkflowId(ref: Pick<DefinitionExecutionRef, 'tenantId' | 'executionId'>): string {
  if (!UUID.test(ref.tenantId) || !UUID.test(ref.executionId)) throw new WorkflowContractError('Invalid definition execution reference');
  return `wfexec/${ref.tenantId}/${ref.executionId}`;
}
export function isDefinitionWorkflowId(value: string): boolean { return EXECUTION_WORKFLOW_ID.test(value); }

// ---------------------------------------------------------------- deterministic stepper
/** Execution state that crosses Temporal history: counters and codes only. */
export interface StepState { loopCounts: Record<string, number>; supplementRound: number; benefitType: BenefitType }
export type StepEvent =
  | { kind: 'START' } | { kind: 'NEXT' } | { kind: 'ACTION'; actionId: string }
  | { kind: 'OUTCOME'; outcome: 'SUCCEEDED' | 'FAILED' | 'RECEIVED' | 'EXPIRED' };
export type WaitPoint =
  | { kind: 'HUMAN'; nodeId: string }
  | { kind: 'SUPPLEMENT'; nodeId: string; maxWaitSeconds: number }
  | { kind: 'TIMER'; nodeId: string; delaySeconds: number }
  | { kind: 'AI'; nodeId: string; activityKind: string; timeoutSeconds: number; retry: RetryPolicy }
  | { kind: 'END'; nodeId: string; outcome: EndOutcome }
  /** A closed variable has no server value yet: stop in a safe state (spec 14 §3.4 fail closed). */
  | { kind: 'UNRESOLVED'; nodeId: string };
export type StepResult = { accepted: true; wait: WaitPoint; state: StepState } | { accepted: false };

const INT_VARIABLES = new Set(['EXTRACTION_LOW_CONFIDENCE_FIELD_COUNT', 'EXTRACTION_QUALITY_FLAG_COUNT', 'DOCUMENTS_MISSING_REQUIRED_SLOT_COUNT', 'SUPPLEMENT_ROUND']);
const MAX_AUTO_STEPS = 256;

/** Server-computed variables only. Values not yet produced by an owning module are `undefined`. */
function variable(name: string, state: StepState): number | string | undefined {
  if (name === 'SUPPLEMENT_ROUND') return state.supplementRound;
  if (name === 'CLAIM_BENEFIT_TYPE') return state.benefitType;
  return undefined; // extraction/document counters arrive with #83/#26 providers
}
function leafHolds(leaf: ConditionLeaf, state: StepState): boolean | undefined {
  const v = variable(leaf.variable, state);
  if (v === undefined) return undefined;
  if (INT_VARIABLES.has(leaf.variable)) {
    if (typeof v !== 'number' || typeof leaf.value !== 'number') return undefined;
    const x = leaf.value;
    switch (leaf.op) { case 'EQ': return v === x; case 'NEQ': return v !== x; case 'GT': return v > x; case 'GTE': return v >= x;
      case 'LT': return v < x; case 'LTE': return v <= x; default: return undefined; }
  }
  if (leaf.op === 'IN') return Array.isArray(leaf.value) ? leaf.value.includes(v as string) : undefined;
  if (leaf.op === 'EQ') return v === leaf.value;
  if (leaf.op === 'NEQ') return v !== leaf.value;
  return undefined;
}
function conditionHolds(condition: Condition, state: StepState): boolean | undefined {
  const group = 'all' in condition ? { all: true, leaves: condition.all } : 'any' in condition ? { all: false, leaves: condition.any } : null;
  if (!group) return leafHolds(condition as ConditionLeaf, state);
  const results = group.leaves.map(l => leafHolds(l, state));
  if (results.some(r => r === undefined)) return undefined;
  return group.all ? results.every(Boolean) : results.some(Boolean);
}

/**
 * Advance a PUBLISHED (already validated) definition from `nodeId` by one external
 * event, then through START/CONDITION nodes until the next wait point or END.
 * Pure: the same pinned content, node, event and state always give the same result,
 * so Activity retries and Temporal replay cannot diverge. Events that the pinned node
 * does not accept (wrong action/outcome, non-routing action) return accepted=false.
 */
export function stepDefinition(content: DefinitionContent, nodeId: string, event: StepEvent, input: StepState,
  catalog: ActionCatalog | undefined = actionCatalog(content.actionCatalogVersion)): StepResult {
  if (!catalog) throw new WorkflowContractError('Pinned action catalog is unknown');
  const byId = new Map(content.nodes.map(n => [n.nodeId, n]));
  const state: StepState = { loopCounts: { ...input.loopCounts }, supplementRound: input.supplementRound, benefitType: input.benefitType };
  const node = byId.get(nodeId);
  if (!node) throw new WorkflowContractError('Pinned node is missing');
  const out = (id: string) => content.edges.filter(e => e.source === id);
  let edge: DefinitionEdge | undefined;
  switch (event.kind) {
    case 'START': if (node.type !== 'START') return { accepted: false }; edge = out(node.nodeId)[0]; break;
    case 'NEXT': if (node.type !== 'TIMER') return { accepted: false }; edge = out(node.nodeId)[0]; break;
    case 'ACTION': {
      const entry = catalog.actions.find(a => a.actionId === event.actionId);
      if (node.type !== 'HUMAN_TASK' || !node.allowedActionIds?.includes(event.actionId) || !entry
        || entry.actorKind !== 'HUMAN' || !entry.nodeTypes.includes('HUMAN_TASK') || entry.businessEffect !== 'ROUTE_WORKFLOW' || !entry.completesTask) {
        return { accepted: false };
      }
      edge = out(node.nodeId).find(e => e.guard.kind === 'ACTION' && e.guard.actionId === event.actionId);
      break;
    }
    case 'OUTCOME': {
      const allowed = node.type === 'AI_ACTIVITY' ? ['SUCCEEDED', 'FAILED'] : node.type === 'SUPPLEMENT_WAIT' ? ['RECEIVED', 'EXPIRED'] : [];
      if (!allowed.includes(event.outcome)) return { accepted: false };
      edge = out(node.nodeId).find(e => e.guard.kind === 'OUTCOME' && e.guard.outcome === event.outcome);
      if (event.outcome === 'RECEIVED') state.supplementRound += 1;
      break;
    }
  }
  if (!edge) throw new WorkflowContractError('Pinned definition has no route for an accepted event');
  for (let steps = 0; steps < MAX_AUTO_STEPS; steps++) {
    const next = byId.get(edge.target);
    if (!next) throw new WorkflowContractError('Pinned edge target is missing');
    switch (next.type) {
      case 'END': return { accepted: true, state, wait: { kind: 'END', nodeId: next.nodeId, outcome: next.outcome! } };
      case 'HUMAN_TASK': return { accepted: true, state, wait: { kind: 'HUMAN', nodeId: next.nodeId } };
      case 'SUPPLEMENT_WAIT': return { accepted: true, state, wait: { kind: 'SUPPLEMENT', nodeId: next.nodeId, maxWaitSeconds: next.maxWaitSeconds! } };
      case 'TIMER': return { accepted: true, state, wait: { kind: 'TIMER', nodeId: next.nodeId, delaySeconds: next.delaySeconds! } };
      case 'AI_ACTIVITY': return { accepted: true, state, wait: { kind: 'AI', nodeId: next.nodeId, activityKind: next.activityKind!, timeoutSeconds: next.timeoutSeconds!, retry: { ...next.retry! } } };
      case 'START': throw new WorkflowContractError('Pinned definition routes into START');
      case 'CONDITION': {
        const branches = out(next.nodeId).filter(e => e.guard.kind === 'CONDITION')
          .sort((a, b) => (a.guard as { priority: number }).priority - (b.guard as { priority: number }).priority);
        let chosen: DefinitionEdge | undefined;
        for (const branch of branches) {
          // Bounded loop: once maxIterations is reached the loopBack edge counts as false (spec 14 §3.5).
          if (branch.loopBack && (state.loopCounts[branch.edgeId] ?? 0) >= branch.loopBack.maxIterations) continue;
          const holds = conditionHolds((branch.guard as { condition: Condition }).condition, state);
          if (holds === undefined) return { accepted: true, state, wait: { kind: 'UNRESOLVED', nodeId: next.nodeId } };
          if (holds) { chosen = branch; break; }
        }
        chosen ??= out(next.nodeId).find(e => e.guard.kind === 'DEFAULT');
        if (!chosen) throw new WorkflowContractError('Pinned condition has no default route');
        if (chosen.loopBack) state.loopCounts[chosen.edgeId] = (state.loopCounts[chosen.edgeId] ?? 0) + 1;
        edge = chosen;
        break;
      }
    }
  }
  throw new WorkflowContractError('Pinned definition exceeded the automatic step bound');
}
