import { byteLength, canonicalJson, graphIssues, isAssignmentPolicy, isWorkflowContent, isWorkflowEdge, isWorkflowNode, MAX_CONTENT_BYTES, type EditorDocument, type WorkflowContent, type WorkflowEdge, type WorkflowNode } from './workflow-definition.ts';
import { APPROVED_BENEFITS, OPS_FOR, VARIABLES, type BenefitType, type ConditionLeaf, type ConditionOp, type ConditionVariable, type Guard } from './workflow-labels.ts';

// Typed inspector support: field-level issues keyed to node/edge + field so the validation drawer can focus the exact
// control, and a condition-builder model that only produces contract-valid WorkflowCondition shapes. All of this is
// feedback; the server's validate/publish remains authoritative (spec 14 §3.5).

export type Severity = 'error' | 'warning';
export interface BuilderIssue {
  code: string; severity: Severity; message: string; source: 'local' | 'server';
  nodeId?: string; edgeId?: string; field?: string; path?: string;
}
export const issueKey = (i: Pick<BuilderIssue, 'nodeId' | 'edgeId'>) => i.nodeId ? `n_${i.nodeId}` : i.edgeId ? `e_${i.edgeId}` : 'workflow';

export const DETAIL_MESSAGES: Record<string, string> = {
  SCHEMA_INVALID: 'Có trường chưa đúng định dạng hoặc giới hạn của hợp đồng.',
  DUPLICATE_ID: 'Mã bước, nhánh hoặc quy tắc bị trùng.',
  EXACTLY_ONE_START_REQUIRED: 'Cần đúng một bước Bắt đầu.',
  END_REQUIRED: 'Cần ít nhất một bước Kết thúc.',
  START_HAS_INCOMING: 'Bước Bắt đầu không được có nhánh vào.',
  END_HAS_OUTGOING: 'Bước Kết thúc không được có nhánh ra.',
  DANGLING_EDGE: 'Nhánh trỏ tới bước không tồn tại.',
  SELF_LOOP: 'Nhánh không được nối một bước vào chính nó.',
  GUARD_NOT_ALLOWED_FOR_SOURCE: 'Loại nhánh không phù hợp với bước nguồn.',
  MISSING_ACTION_ROUTE: 'Mỗi hành động được phép cần đúng một nhánh ra.',
  DUPLICATE_ROUTE: 'Có hai nhánh cho cùng một hành động/kết quả.',
  MISSING_OUTCOME_ROUTE: 'Thiếu nhánh cho một kết quả bắt buộc.',
  MISSING_DEFAULT_BRANCH: 'Bước điều kiện cần đúng một nhánh Mặc định.',
  DUPLICATE_PRIORITY: 'Thứ tự ưu tiên của các nhánh điều kiện bị trùng.',
  CONDITION_TYPE_MISMATCH: 'Biến, phép so sánh và giá trị không cùng kiểu.',
  UNREACHABLE_NODE: 'Không đi tới được bước này từ Bắt đầu.',
  DEAD_END: 'Từ bước này không đi tới được bước Kết thúc nào.',
  UNBOUNDED_LOOP: 'Vòng lặp chưa có giới hạn số lần.',
  LOOP_WITHOUT_HUMAN_OR_WAIT: 'Mỗi vòng lặp phải đi qua bước người xử lý hoặc chờ bổ sung.',
  ACTION_NOT_ALLOWED_FOR_NODE: 'Hành động của nhánh chưa được bật ở bước nguồn.',
  UNKNOWN_ASSIGNMENT_RULE: 'Quy tắc phân công hoặc bước cần tách người xử lý không tồn tại.',
  INPUT_NOT_PRODUCED: 'Dữ liệu đầu vào chưa được bước nào phía trước tạo ra.',
  AI_FAILURE_NOT_ROUTED_TO_HUMAN: 'Nhánh AI lỗi phải đi thẳng tới bước người xử lý.',
  SCOPE_NOT_APPROVED: 'Loại quyền lợi ngoài phạm vi Phase 1.',
  AMBIGUOUS_BINDING: 'Loại quyền lợi đã có quy trình khác đang xuất bản.',
  REFERENCE_NOT_PUBLISHED: 'Tham chiếu chưa có phiên bản đã xuất bản của tổ chức.',
  CATALOG_VERSION_UNKNOWN: 'Phiên bản danh mục hành động không xác định.',
  GROUP_DIRECTORY_UNAVAILABLE: 'Danh bạ nhóm chưa sẵn sàng; chỉ dùng vai trò.',
  LIMIT_EXCEEDED: 'Định nghĩa vượt giới hạn 64 KiB.',
  UNSUPPORTED_BPMN_ELEMENT: 'Phần tử không được hỗ trợ.',
  PARALLEL_NOT_SUPPORTED: 'Không hỗ trợ nhánh song song.',
  REQUIRED: 'Bắt buộc nhập.',
  OUT_OF_RANGE: 'Giá trị ngoài giới hạn cho phép.',
  INVALID_FORMAT: 'Không đúng định dạng.',
  PLACEHOLDER_REFERENCE: 'Đang là chỗ trống của mẫu; nhập tham chiếu đã xuất bản.',
};
const LABEL = /^[^<>{}`\u0000-\u001F\u007F]{1,120}$/;
const REF_KEY = /^[a-z][a-z0-9_.-]{1,63}$/;
const HASH = /^[0-9a-f]{64}$/;
export const PLACEHOLDER_KEY = 'configure.required';
const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

function fieldChecks(node: WorkflowNode, content: WorkflowContent): { field: string; code: string; message: string }[] {
  const out: { field: string; code: string; message: string }[] = [];
  const add = (field: string, code: string, message: string) => out.push({ field, code, message });
  if (!LABEL.test(node.label)) add('label', 'INVALID_FORMAT', 'Tên bước 1–120 ký tự, không chứa < > { } ` hoặc ký tự điều khiển.');
  const evidence = (e: { documentTypes: unknown[]; sources: unknown[] }) => {
    if (!e.documentTypes.length) add('allowedEvidence.documentTypes', 'REQUIRED', 'Chọn ít nhất một loại chứng từ được dùng làm bằng chứng.');
    if (!e.sources.length) add('allowedEvidence.sources', 'REQUIRED', 'Chọn ít nhất một nguồn bằng chứng.');
  };
  const reminders = (field: string, values: number[] | undefined, min: number, max: number) => {
    if (values && (values.length > 3 || values.some(v => !int(v, min, max)) || new Set(values).size !== values.length)) add(field, 'OUT_OF_RANGE', `Tối đa 3 lần nhắc khác nhau, mỗi lần trong khoảng ${min}–${max} giây.`);
  };
  const ref = (field: string, value: { key: string; version: number; hash: string }, optional = false) => {
    if (value.key === PLACEHOLDER_KEY || /^0{64}$/.test(value.hash)) { if (!optional) add(field, 'PLACEHOLDER_REFERENCE', DETAIL_MESSAGES.PLACEHOLDER_REFERENCE); return; }
    if (!REF_KEY.test(value.key) || !int(value.version, 1, 2147483647) || !HASH.test(value.hash)) add(field, 'INVALID_FORMAT', 'Tham chiếu gồm mã (chữ thường), phiên bản ≥ 1 và mã băm SHA-256 64 ký tự hex.');
  };
  switch (node.type) {
    case 'TIMER': if (!int(node.delaySeconds, 60, 604800)) add('delaySeconds', 'OUT_OF_RANGE', 'Thời gian chờ từ 1 phút tới 7 ngày.'); break;
    case 'SUPPLEMENT_WAIT':
      if (!int(node.maxWaitSeconds, 86400, 2592000)) add('maxWaitSeconds', 'OUT_OF_RANGE', 'Hạn bổ sung từ 1 tới 30 ngày.');
      reminders('reminderOffsetsSeconds', node.reminderOffsetsSeconds, 3600, 2592000);
      break;
    case 'HUMAN_TASK':
      if (!node.allowedActionIds.length) add('allowedActionIds', 'REQUIRED', 'Bật ít nhất một hành động người xử lý được làm.');
      if (!content.assignmentPolicy.rules.some(r => r.ruleKey === node.assignmentRuleKey)) add('assignmentRuleKey', 'UNKNOWN_ASSIGNMENT_RULE', 'Chọn một quy tắc phân công đã khai báo.');
      if (!int(node.sla.dueSeconds, 3600, 1209600)) add('sla.dueSeconds', 'OUT_OF_RANGE', 'SLA từ 1 giờ tới 14 ngày; không có giá trị mặc định.');
      reminders('sla.reminderOffsetsSeconds', node.sla.reminderOffsetsSeconds, 600, 1209600);
      evidence(node.allowedEvidence);
      if (node.formRef) ref('formRef', node.formRef, true);
      break;
    case 'AI_ACTIVITY':
      if (!node.allowedActionIds.length) add('allowedActionIds', 'REQUIRED', 'Bật ít nhất một loại đề xuất AI được phép.');
      if (node.serviceActorScopeKey === PLACEHOLDER_KEY) add('serviceActorScopeKey', 'PLACEHOLDER_REFERENCE', 'Nhập phạm vi tác nhân AI đã được cấp cho tổ chức.');
      else if (!REF_KEY.test(node.serviceActorScopeKey)) add('serviceActorScopeKey', 'INVALID_FORMAT', 'Mã phạm vi: chữ thường, số, dấu chấm/gạch, 2–64 ký tự.');
      ref('modelRef', node.modelRef); ref('promptRef', node.promptRef); ref('policyRef', node.policyRef);
      evidence(node.allowedEvidence);
      if (!int(node.timeoutSeconds, 30, 600)) add('timeoutSeconds', 'OUT_OF_RANGE', 'Thời gian tối đa từ 30 giây tới 10 phút.');
      if (!int(node.retry.maxAttempts, 1, 5)) add('retry.maxAttempts', 'OUT_OF_RANGE', 'Số lần thử 1–5.');
      if (!int(node.retry.initialIntervalSeconds, 1, 60)) add('retry.initialIntervalSeconds', 'OUT_OF_RANGE', 'Khoảng chờ đầu 1–60 giây.');
      if (!int(node.retry.backoffCoefficient, 1, 4)) add('retry.backoffCoefficient', 'OUT_OF_RANGE', 'Hệ số giãn 1–4.');
      if (!int(node.retry.maxIntervalSeconds, 1, 600)) add('retry.maxIntervalSeconds', 'OUT_OF_RANGE', 'Khoảng chờ tối đa 1–600 giây.');
      break;
    default: break;
  }
  if (out.length === 0 && !isWorkflowNode(node)) add('node', 'SCHEMA_INVALID', DETAIL_MESSAGES.SCHEMA_INVALID);
  return out;
}

export function leafProblem(leaf: ConditionLeaf): string | null {
  const meta = VARIABLES[leaf.variable];
  if (!meta) return 'Chọn biến điều kiện.';
  if (!OPS_FOR[meta.type].includes(leaf.op)) return 'Phép so sánh không dùng được với biến này.';
  if (meta.type === 'count') return int(leaf.value, 0, 1000) ? null : 'Nhập số nguyên 0–1000.';
  if (leaf.op === 'IN') return Array.isArray(leaf.value) && leaf.value.length >= 1 && leaf.value.length <= 6 ? null : 'Chọn 1–6 loại quyền lợi.';
  return typeof leaf.value === 'string' ? null : 'Chọn một loại quyền lợi.';
}

function edgeChecks(edge: WorkflowEdge): { field: string; code: string; message: string }[] {
  const out: { field: string; code: string; message: string }[] = [];
  const g = edge.guard;
  if (g.kind === 'CONDITION') {
    if (!int(g.priority, 1, 10)) out.push({ field: 'guard.priority', code: 'OUT_OF_RANGE', message: 'Thứ tự ưu tiên 1–10.' });
    const { leaves } = conditionParts(g.condition);
    if (!leaves.length || leaves.length > 5) out.push({ field: 'guard.condition', code: 'OUT_OF_RANGE', message: 'Nhóm điều kiện có 1–5 điều kiện con.' });
    leaves.forEach((leaf, i) => { const p = leafProblem(leaf); if (p) out.push({ field: `guard.condition.${i}`, code: 'CONDITION_TYPE_MISMATCH', message: p }); });
  }
  if (edge.loopBack && !int(edge.loopBack.maxIterations, 1, 5)) out.push({ field: 'loopBack', code: 'OUT_OF_RANGE', message: 'Số lần lặp tối đa 1–5.' });
  if (!out.length && !isWorkflowEdge(edge)) out.push({ field: 'guard', code: 'SCHEMA_INVALID', message: DETAIL_MESSAGES.SCHEMA_INVALID });
  return out;
}

function workflowChecks(c: WorkflowContent): BuilderIssue[] {
  const out: BuilderIssue[] = [];
  const add = (field: string, code: string, message: string) => out.push({ code, field, message, severity: 'error', source: 'local' });
  if (!/^[a-z][a-z0-9_]{2,47}$/.test(c.workflowKey)) add('workflowKey', 'INVALID_FORMAT', 'Mã quy trình: chữ thường, số, gạch dưới; 3–48 ký tự, bắt đầu bằng chữ.');
  if (!LABEL.test(c.title)) add('title', 'INVALID_FORMAT', 'Tên quy trình 1–120 ký tự, không chứa < > { } `.');
  if (!c.scope.benefitTypes.length) add('scope.benefitTypes', 'REQUIRED', 'Chọn ít nhất một loại quyền lợi áp dụng.');
  if (c.scope.benefitTypes.some(b => !APPROVED_BENEFITS.includes(b as BenefitType))) add('scope.benefitTypes', 'SCOPE_NOT_APPROVED', DETAIL_MESSAGES.SCOPE_NOT_APPROVED);
  c.assignmentPolicy.rules.forEach(r => {
    if (!r.candidateRoles.length) add(`rule.${r.ruleKey}.candidateRoles`, 'REQUIRED', `Quy tắc ${r.ruleKey}: chọn ít nhất một vai trò ứng viên.`);
    if (!int(r.maxActiveTasksPerAssignee, 1, 200)) add(`rule.${r.ruleKey}.maxActiveTasksPerAssignee`, 'OUT_OF_RANGE', `Quy tắc ${r.ruleKey}: số việc tối đa mỗi người 1–200.`);
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(r.ruleKey)) add(`rule.${r.ruleKey}.ruleKey`, 'INVALID_FORMAT', 'Mã quy tắc: chữ thường, số, gạch dưới.');
  });
  if (!out.length && !isAssignmentPolicy(c.assignmentPolicy)) add('assignmentPolicy', 'SCHEMA_INVALID', DETAIL_MESSAGES.SCHEMA_INVALID);
  return out;
}

const FIELD_ROOTS = ['sla', 'allowedEvidence', 'retry', 'guard', 'loopBack'];
/** `/nodes/3/sla/dueSeconds` → { nodeId, field: 'sla.dueSeconds' } using the content the report was computed for. */
export function locate(path: string, content: WorkflowContent): Pick<BuilderIssue, 'nodeId' | 'edgeId' | 'field'> {
  const parts = path.split('/').slice(1);
  const [collection, index, ...rest] = parts;
  const tail = rest.filter(p => !/^\d+$/.test(p));
  const field = tail.length ? (FIELD_ROOTS.includes(tail[0]) ? tail.slice(0, 2).join('.') : tail[0]) : undefined;
  if (collection === 'nodes' && /^\d+$/.test(index ?? '')) { const n = content.nodes[Number(index)]; return n ? { nodeId: n.nodeId, ...(field ? { field } : {}) } : {}; }
  if (collection === 'edges' && /^\d+$/.test(index ?? '')) { const e = content.edges[Number(index)]; return e ? { edgeId: e.edgeId, ...(field ? { field } : {}) } : {}; }
  if (collection === 'assignmentPolicy' && parts[1] === 'rules' && /^\d+$/.test(parts[2] ?? '')) {
    const r = content.assignmentPolicy.rules[Number(parts[2])];
    return r ? { field: `rule.${r.ruleKey}.${parts[3] ?? 'ruleKey'}` } : {};
  }
  if (collection === 'scope') return { field: 'scope.benefitTypes' };
  if (collection === 'title' || collection === 'workflowKey') return { field: collection };
  return {};
}

/** Live local feedback: field rules first, then graph rules (which tolerate incomplete values). */
export function localIssues(doc: EditorDocument): BuilderIssue[] {
  const c = doc.content, issues: BuilderIssue[] = [...workflowChecks(c)];
  for (const n of c.nodes) for (const f of fieldChecks(n, c)) issues.push({ ...f, severity: 'error', source: 'local', nodeId: n.nodeId });
  for (const e of c.edges) for (const f of edgeChecks(e)) issues.push({ ...f, severity: 'error', source: 'local', edgeId: e.edgeId });
  if (byteLength(canonicalJson(c)) > MAX_CONTENT_BYTES) issues.push({ code: 'LIMIT_EXCEEDED', severity: 'error', source: 'local', message: DETAIL_MESSAGES.LIMIT_EXCEEDED });
  for (const g of graphIssues(c)) {
    if (g.detailCode === 'UNKNOWN_ASSIGNMENT_RULE' && g.path.endsWith('/assignmentRuleKey')) continue; // reported on the field above
    if (g.detailCode === 'CONDITION_TYPE_MISMATCH' || g.detailCode === 'SCOPE_NOT_APPROVED') continue; // reported per leaf / scope field
    const at = locate(g.path, c);
    issues.push({ code: g.detailCode, severity: 'error', source: 'local', path: g.path, message: DETAIL_MESSAGES[g.detailCode] ?? g.detailCode,
      ...at, ...(g.nodeId ? { nodeId: g.nodeId } : {}), ...(g.edgeId ? { edgeId: g.edgeId } : {}) });
  }
  if (!issues.length && !isWorkflowContent(c)) issues.push({ code: 'SCHEMA_INVALID', severity: 'error', source: 'local', path: '/', message: DETAIL_MESSAGES.SCHEMA_INVALID });
  return issues;
}

/** Server WorkflowValidationReport issues keyed to the content of the validated revision. */
export function serverIssues(report: { issues: { detailCode: string; path: string; nodeId?: string; edgeId?: string }[] }, content: WorkflowContent): BuilderIssue[] {
  return report.issues.map(i => ({
    code: i.detailCode, severity: 'error' as const, source: 'server' as const, path: i.path, message: DETAIL_MESSAGES[i.detailCode] ?? i.detailCode,
    ...locate(i.path, content), ...(i.nodeId ? { nodeId: i.nodeId } : {}), ...(i.edgeId ? { edgeId: i.edgeId } : {}),
  }));
}

export function issueCounts(issues: BuilderIssue[]) {
  const counts = { nodes: {} as Record<string, number>, edges: {} as Record<string, number> };
  for (const i of issues) {
    if (i.nodeId) counts.nodes[i.nodeId] = (counts.nodes[i.nodeId] ?? 0) + 1;
    if (i.edgeId) counts.edges[i.edgeId] = (counts.edges[i.edgeId] ?? 0) + 1;
  }
  return counts;
}

// ---- Condition builder model --------------------------------------------------------------------------------------
type Condition = Extract<Guard, { kind: 'CONDITION' }>['condition'];
export type ConditionMode = 'single' | 'all' | 'any';
export function conditionParts(condition: Condition): { mode: ConditionMode; leaves: ConditionLeaf[] } {
  if ('all' in condition) return { mode: 'all', leaves: condition.all };
  if ('any' in condition) return { mode: 'any', leaves: condition.any };
  return { mode: 'single', leaves: [condition] };
}
export function buildCondition(mode: ConditionMode, leaves: ConditionLeaf[]): Condition {
  if (!leaves.length) throw new Error('CONDITION_REQUIRED');
  if (mode === 'single') return leaves[0];
  return (mode === 'all' ? { all: leaves.slice(0, 5) } : { any: leaves.slice(0, 5) }) as Condition;
}
/** A new comparison starts visibly at 0 / Ngoại trú; the designer must set the value deliberately. */
export function newLeaf(variable: ConditionVariable = 'SUPPLEMENT_ROUND'): ConditionLeaf {
  return VARIABLES[variable].type === 'count' ? { variable, op: 'LTE', value: 0 } : { variable, op: 'EQ', value: 'OUTPATIENT' };
}
export function withVariable(leaf: ConditionLeaf, variable: ConditionVariable): ConditionLeaf {
  if (VARIABLES[variable].type === VARIABLES[leaf.variable].type) return { ...leaf, variable };
  return newLeaf(variable);
}
export function withOp(leaf: ConditionLeaf, op: ConditionOp): ConditionLeaf {
  if (VARIABLES[leaf.variable].type === 'count') return { ...leaf, op };
  if (op === 'IN') return { ...leaf, op, value: Array.isArray(leaf.value) ? leaf.value : [typeof leaf.value === 'string' ? leaf.value : 'OUTPATIENT'] } as ConditionLeaf;
  return { ...leaf, op, value: Array.isArray(leaf.value) ? leaf.value[0] ?? 'OUTPATIENT' : leaf.value } as ConditionLeaf;
}

/** Guards a route may carry, by source step type (spec 14 §2). */
export function guardChoices(source: WorkflowNode | undefined): { value: string; guard: Guard }[] {
  switch (source?.type) {
    case 'START': case 'TIMER': return [{ value: 'NEXT', guard: { kind: 'NEXT' } }];
    case 'HUMAN_TASK': return (['CONFIRM_EXTRACTION', 'REQUEST_SUPPLEMENT', 'ESCALATE_TO_MANUAL_REVIEW'] as const).map(actionId => ({ value: `ACTION:${actionId}`, guard: { kind: 'ACTION', actionId } }));
    case 'AI_ACTIVITY': return (['SUCCEEDED', 'FAILED'] as const).map(outcome => ({ value: `OUTCOME:${outcome}`, guard: { kind: 'OUTCOME', outcome } }));
    case 'SUPPLEMENT_WAIT': return (['RECEIVED', 'EXPIRED'] as const).map(outcome => ({ value: `OUTCOME:${outcome}`, guard: { kind: 'OUTCOME', outcome } }));
    case 'CONDITION': return [{ value: 'CONDITION', guard: { kind: 'CONDITION', priority: 1, condition: newLeaf() } }, { value: 'DEFAULT', guard: { kind: 'DEFAULT' } }];
    default: return [];
  }
}
export const guardValue = (g: Guard) => g.kind === 'ACTION' ? `ACTION:${g.actionId}` : g.kind === 'OUTCOME' ? `OUTCOME:${g.outcome}` : g.kind;
