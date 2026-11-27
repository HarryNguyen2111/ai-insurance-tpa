import type { NodeType, WorkflowContent, WorkflowEdge, WorkflowNode } from './workflow-definition.ts';

// Display names for the closed VWF-01 contract enums (spec 02/14). Codes stay visible as secondary text; the
// canonical payload always carries the code, never the label. Adding a value here does not add it to the contract.
type Human = Extract<WorkflowNode, { type: 'HUMAN_TASK' }>;
type Ai = Extract<WorkflowNode, { type: 'AI_ACTIVITY' }>;
type End = Extract<WorkflowNode, { type: 'END' }>;
type Rule = WorkflowContent['assignmentPolicy']['rules'][number];
export type Guard = WorkflowEdge['guard'];
export type ConditionLeaf = Extract<Extract<Guard, { kind: 'CONDITION' }>['condition'], { variable: string }>;
export type ConditionVariable = ConditionLeaf['variable'];
export type ConditionOp = ConditionLeaf['op'];
export type BenefitType = WorkflowContent['scope']['benefitTypes'][number];
export type DocumentType = Human['allowedEvidence']['documentTypes'][number];
export type EvidenceSource = Human['allowedEvidence']['sources'][number];
export type DataSchema = Human['inputSchemas'][number];

export const NODE_HELP: Record<NodeType, string> = {
  START: 'Điểm hồ sơ đi vào quy trình. Đúng một bước bắt đầu.',
  END: 'Kết thúc quy trình với một kết quả cố định.',
  HUMAN_TASK: 'Việc do con người xử lý, có SLA và người chịu trách nhiệm.',
  AI_ACTIVITY: 'AI chỉ đề xuất có bằng chứng; con người vẫn chịu trách nhiệm.',
  CONDITION: 'Rẽ nhánh theo biến do máy chủ tính; luôn có nhánh mặc định.',
  SUPPLEMENT_WAIT: 'Chờ khách hàng bổ sung chứng từ, có hạn chờ.',
  TIMER: 'Chờ một khoảng thời gian cố định rồi đi tiếp.',
};
export const NODE_GROUPS: { title: string; types: NodeType[] }[] = [
  { title: 'Bắt đầu và kết thúc', types: ['START', 'END'] },
  { title: 'Xử lý', types: ['HUMAN_TASK', 'AI_ACTIVITY'] },
  { title: 'Điều hướng và chờ', types: ['CONDITION', 'SUPPLEMENT_WAIT', 'TIMER'] },
];

export const ACTION_LABELS: Record<Human['allowedActionIds'][number] | Ai['allowedActionIds'][number], string> = {
  CONFIRM_EXTRACTION: 'Xác nhận dữ liệu', REQUEST_SUPPLEMENT: 'Yêu cầu bổ sung', ESCALATE_TO_MANUAL_REVIEW: 'Chuyển duyệt thủ công',
  PROPOSE_EXTRACTION: 'Đề xuất trích xuất', PROPOSE_DOCUMENT_LABEL: 'Đề xuất nhãn chứng từ', PROPOSE_QUALITY_FLAG: 'Đề xuất cờ chất lượng',
};
export const OUTCOME_LABELS = { SUCCEEDED: 'AI hoàn tất', FAILED: 'AI lỗi / không chắc', RECEIVED: 'Đã nhận bổ sung', EXPIRED: 'Hết hạn bổ sung' } as const;
export const END_OUTCOME_LABELS: Record<End['outcome'], string> = {
  REVIEW_COMPLETED: 'Hoàn tất xem xét', ROUTED_TO_MANUAL_REVIEW: 'Chuyển duyệt thủ công', SUPPLEMENT_EXPIRED: 'Hết hạn bổ sung',
};
export const TASK_KIND_LABELS: Record<Human['taskKind'], string> = { EXTRACTION_CONFIRMATION: 'Xác nhận dữ liệu trích xuất', DOCUMENT_REVIEW: 'Xem xét chứng từ' };
export const ACTIVITY_KIND_LABELS: Record<Ai['activityKind'], string> = { DOCUMENT_EXTRACTION: 'Trích xuất chứng từ', DOCUMENT_CLASSIFICATION: 'Phân loại chứng từ', QUALITY_CHECK: 'Kiểm tra chất lượng ảnh' };
export const CANDIDATE_ROLE_LABELS: Record<Rule['candidateRoles'][number], string> = { CLAIM_REVIEWER: 'Chuyên viên thẩm định', INSURER_REVIEWER: 'Người duyệt phía DNBH' };
export const OWNER_LABELS: Record<Rule['accountableOwner'], string> = { CASE_OWNER: 'Người phụ trách hồ sơ' };
export const ESCALATION_LABELS: Record<Human['sla']['escalateTo'], string> = { CASE_OWNER: 'Người phụ trách hồ sơ', SUPERVISOR_QUEUE: 'Hàng đợi giám sát' };
export const STRATEGY_LABELS: Record<Rule['strategy'], string> = { QUEUE_CLAIM: 'Nhận từ hàng đợi', CASE_OWNER_DIRECT: 'Giao người phụ trách hồ sơ' };
export const DOCUMENT_LABELS: Record<DocumentType, string> = {
  INVOICE_PHOTO: 'Ảnh hóa đơn', ITEMIZED_LIST: 'Bảng kê chi tiết', PRESCRIPTION: 'Đơn thuốc', LAB_ORDER: 'Chỉ định xét nghiệm',
  LAB_RESULT: 'Kết quả xét nghiệm', DISCHARGE_PAPER: 'Giấy ra viện', VNEID_HISTORY: 'Lịch sử VNeID',
};
export const SOURCE_LABELS: Record<EvidenceSource, string> = { XML: 'Hóa đơn XML', OCR: 'OCR', VLM: 'Mô hình thị giác', QR: 'Mã QR', IMAGE_ANALYSIS: 'Phân tích ảnh' };
export const SCHEMA_LABELS: Record<DataSchema, string> = {
  CLAIM_REF: 'Mã hồ sơ', DOCUMENT_SET: 'Bộ chứng từ', EXTRACTION_PROPOSAL: 'Đề xuất trích xuất', CONFIRMED_EXTRACTION: 'Dữ liệu đã xác nhận',
  DOCUMENT_LABELS: 'Nhãn chứng từ', QUALITY_FLAGS: 'Cờ chất lượng', SUPPLEMENT_REQUEST: 'Yêu cầu bổ sung', SUPPLEMENT_DOCUMENTS: 'Chứng từ bổ sung',
};
export const BENEFIT_LABELS: Record<BenefitType, string> = {
  OUTPATIENT: 'Ngoại trú', INPATIENT: 'Nội trú', DENTAL: 'Nha khoa', MATERNITY: 'Thai sản', ACCIDENT: 'Tai nạn', HOSPITAL_INCOME: 'Trợ cấp nằm viện',
};
export const BENEFIT_TYPES = Object.keys(BENEFIT_LABELS) as BenefitType[];
/** Phase 1 approved scope (spec 14 §3.5 SCOPE_NOT_APPROVED); others are shown but flagged. */
export const APPROVED_BENEFITS: BenefitType[] = ['OUTPATIENT', 'DENTAL', 'INPATIENT'];
export const DOCUMENT_TYPES = Object.keys(DOCUMENT_LABELS) as DocumentType[];
export const EVIDENCE_SOURCES = Object.keys(SOURCE_LABELS) as EvidenceSource[];
export const DATA_SCHEMAS = Object.keys(SCHEMA_LABELS) as DataSchema[];

export const VARIABLES: Record<ConditionVariable, { label: string; type: 'count' | 'benefit' }> = {
  EXTRACTION_LOW_CONFIDENCE_FIELD_COUNT: { label: 'Số trường AI trích xuất độ tin cậy thấp', type: 'count' },
  EXTRACTION_QUALITY_FLAG_COUNT: { label: 'Số cờ chất lượng ảnh', type: 'count' },
  DOCUMENTS_MISSING_REQUIRED_SLOT_COUNT: { label: 'Số loại chứng từ bắt buộc còn thiếu', type: 'count' },
  SUPPLEMENT_ROUND: { label: 'Lượt bổ sung hiện tại', type: 'count' },
  CLAIM_BENEFIT_TYPE: { label: 'Loại quyền lợi của hồ sơ', type: 'benefit' },
};
export const OP_LABELS: Record<ConditionOp, string> = { EQ: '=', NEQ: '≠', GT: '>', GTE: '≥', LT: '<', LTE: '≤', IN: 'thuộc' };
export const OPS_FOR: Record<'count' | 'benefit', ConditionOp[]> = { count: ['EQ', 'NEQ', 'GT', 'GTE', 'LT', 'LTE'], benefit: ['EQ', 'NEQ', 'IN'] };

/** Human-readable duration for P0 configuration seconds. */
export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'chưa đặt';
  if (seconds % 86400 === 0) return `${seconds / 86400} ngày`;
  if (seconds % 3600 === 0) return `${seconds / 3600} giờ`;
  if (seconds % 60 === 0) return `${seconds / 60} phút`;
  return `${seconds} giây`;
}
export function leafText(leaf: ConditionLeaf): string {
  const v = VARIABLES[leaf.variable]?.label ?? leaf.variable;
  const value = Array.isArray(leaf.value) ? leaf.value.map(b => BENEFIT_LABELS[b] ?? b).join(', ')
    : typeof leaf.value === 'string' ? BENEFIT_LABELS[leaf.value as BenefitType] ?? leaf.value : String(leaf.value);
  return `${v} ${OP_LABELS[leaf.op] ?? leaf.op} ${value}`;
}
export function conditionText(condition: Extract<Guard, { kind: 'CONDITION' }>['condition']): string {
  if ('all' in condition) return condition.all.map(leafText).join(' VÀ ');
  if ('any' in condition) return condition.any.map(leafText).join(' HOẶC ');
  return leafText(condition);
}
/** Branch label on the canvas. NEXT is unlabelled; every other route names its action/outcome/condition. */
export function guardLabel(edge: WorkflowEdge): string {
  const g = edge.guard;
  const loop = edge.loopBack ? ` · lặp tối đa ${edge.loopBack.maxIterations}` : '';
  switch (g.kind) {
    case 'NEXT': return loop.slice(3);
    case 'ACTION': return (ACTION_LABELS[g.actionId] ?? g.actionId) + loop;
    case 'OUTCOME': return (OUTCOME_LABELS[g.outcome] ?? g.outcome) + loop;
    case 'DEFAULT': return 'Mặc định' + loop;
    case 'CONDITION': return `Nếu ${conditionText(g.condition)}${loop}`;
  }
}
