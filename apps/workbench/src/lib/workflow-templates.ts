import { newDocument, type EditorDocument, type WorkflowContent } from './workflow-definition.ts';
import { normalizeLayout } from './workflow-graph.ts';
import { PLACEHOLDER_KEY } from './workflow-inspector.ts';

// Starting points offered in the empty state. Templates only produce canonical content through the same contract;
// they never bypass validation. Policy values (SLA, AI references, wait limits, evidence) in the skeleton are visible
// placeholders that the validation drawer reports until configured; the spec example is synthetic test data.

/** Verbatim copy of docs/ai-specs/examples/visual-workflow-intake-review.example.json (unit test enforces equality). */
const SPEC_EXAMPLE: WorkflowContent = {
  schemaVersion: "1.0.0",
  workflowKey: "intake_ai_review",
  title: "Tiếp nhận: AI trích xuất, người xác nhận hoặc yêu cầu bổ sung",
  scope: {"benefitTypes": ["OUTPATIENT", "DENTAL"]},
  actionCatalogVersion: 1,
  assignmentPolicy: {"schemaVersion": "1.0.0", "rules": [{"ruleKey": "reviewer_queue", "candidateRoles": ["CLAIM_REVIEWER"], "strategy": "QUEUE_CLAIM", "accountableOwner": "CASE_OWNER", "distinctFromNodeIds": [], "maxActiveTasksPerAssignee": 50}]},
  nodes: [
    {"nodeId": "start", "type": "START", "label": "Hồ sơ đã nộp"},
    {"nodeId": "ai_extract", "type": "AI_ACTIVITY", "label": "AI trích xuất chứng từ", "activityKind": "DOCUMENT_EXTRACTION", "inputSchemas": ["CLAIM_REF", "DOCUMENT_SET"], "outputSchemas": ["EXTRACTION_PROPOSAL", "QUALITY_FLAGS"], "allowedActionIds": ["PROPOSE_EXTRACTION", "PROPOSE_QUALITY_FLAG"], "serviceActorScopeKey": "ai.extraction.synthetic", "accountableOwner": "CASE_OWNER", "modelRef": {"key": "synthetic.vlm", "version": 1, "hash": "1111111111111111111111111111111111111111111111111111111111111111"}, "promptRef": {"key": "synthetic.invoice-prompt", "version": 1, "hash": "2222222222222222222222222222222222222222222222222222222222222222"}, "policyRef": {"key": "synthetic.ai-use-policy", "version": 1, "hash": "3333333333333333333333333333333333333333333333333333333333333333"}, "allowedEvidence": {"documentTypes": ["INVOICE_PHOTO", "ITEMIZED_LIST", "PRESCRIPTION"], "sources": ["XML", "OCR", "VLM", "QR"]}, "timeoutSeconds": 120, "retry": {"maxAttempts": 3, "initialIntervalSeconds": 5, "backoffCoefficient": 2, "maxIntervalSeconds": 60}},
    {"nodeId": "confirm_extraction", "type": "HUMAN_TASK", "label": "Xác nhận dữ liệu trích xuất", "taskKind": "EXTRACTION_CONFIRMATION", "inputSchemas": ["CLAIM_REF", "DOCUMENT_SET", "EXTRACTION_PROPOSAL"], "outputSchemas": ["CONFIRMED_EXTRACTION", "SUPPLEMENT_REQUEST", "DOCUMENT_LABELS"], "allowedActionIds": ["CONFIRM_EXTRACTION", "REQUEST_SUPPLEMENT", "ESCALATE_TO_MANUAL_REVIEW"], "assignmentRuleKey": "reviewer_queue", "accountableOwner": "CASE_OWNER", "sla": {"dueSeconds": 86400, "reminderOffsetsSeconds": [43200], "escalateTo": "SUPERVISOR_QUEUE"}, "allowedEvidence": {"documentTypes": ["INVOICE_PHOTO", "ITEMIZED_LIST", "PRESCRIPTION"], "sources": ["XML", "OCR", "VLM", "QR"]}, "formRef": {"key": "synthetic.confirm-form", "version": 1, "hash": "4444444444444444444444444444444444444444444444444444444444444444"}},
    {"nodeId": "wait_supplement", "type": "SUPPLEMENT_WAIT", "label": "Chờ khách bổ sung chứng từ", "maxWaitSeconds": 1296000, "reminderOffsetsSeconds": [259200, 864000], "accountableOwner": "CASE_OWNER", "inputSchemas": ["SUPPLEMENT_REQUEST"], "outputSchemas": ["SUPPLEMENT_DOCUMENTS"]},
    {"nodeId": "supplement_round", "type": "CONDITION", "label": "Còn lượt bổ sung?"},
    {"nodeId": "end_completed", "type": "END", "label": "Đã xác nhận, chuyển thẩm định", "outcome": "REVIEW_COMPLETED"},
    {"nodeId": "end_manual", "type": "END", "label": "Chuyển duyệt thủ công", "outcome": "ROUTED_TO_MANUAL_REVIEW"},
    {"nodeId": "end_expired", "type": "END", "label": "Quá hạn bổ sung", "outcome": "SUPPLEMENT_EXPIRED"},
  ],
  edges: [
    {"edgeId": "e_start", "source": "start", "target": "ai_extract", "guard": {"kind": "NEXT"}},
    {"edgeId": "e_ai_ok", "source": "ai_extract", "target": "confirm_extraction", "guard": {"kind": "OUTCOME", "outcome": "SUCCEEDED"}},
    {"edgeId": "e_ai_fail", "source": "ai_extract", "target": "confirm_extraction", "guard": {"kind": "OUTCOME", "outcome": "FAILED"}},
    {"edgeId": "e_confirm", "source": "confirm_extraction", "target": "end_completed", "guard": {"kind": "ACTION", "actionId": "CONFIRM_EXTRACTION"}},
    {"edgeId": "e_supplement", "source": "confirm_extraction", "target": "wait_supplement", "guard": {"kind": "ACTION", "actionId": "REQUEST_SUPPLEMENT"}},
    {"edgeId": "e_escalate", "source": "confirm_extraction", "target": "end_manual", "guard": {"kind": "ACTION", "actionId": "ESCALATE_TO_MANUAL_REVIEW"}},
    {"edgeId": "e_received", "source": "wait_supplement", "target": "supplement_round", "guard": {"kind": "OUTCOME", "outcome": "RECEIVED"}},
    {"edgeId": "e_expired", "source": "wait_supplement", "target": "end_expired", "guard": {"kind": "OUTCOME", "outcome": "EXPIRED"}},
    {"edgeId": "e_retry_ai", "source": "supplement_round", "target": "ai_extract", "guard": {"kind": "CONDITION", "priority": 1, "condition": {"variable": "SUPPLEMENT_ROUND", "op": "LTE", "value": 3}}, "loopBack": {"maxIterations": 3}},
    {"edgeId": "e_rounds_exhausted", "source": "supplement_round", "target": "end_manual", "guard": {"kind": "DEFAULT"}},
  ],
};

const placeholderRef = () => ({ key: PLACEHOLDER_KEY, version: 1, hash: '0'.repeat(64) });
function skeleton(): WorkflowContent {
  const c = structuredClone(SPEC_EXAMPLE);
  c.workflowKey = 'intake_review_draft';
  c.title = 'Tiếp nhận, AI đề xuất, người duyệt, bổ sung';
  c.scope = { benefitTypes: ['OUTPATIENT'] };
  c.nodes = c.nodes.map(n => {
    switch (n.type) {
      case 'AI_ACTIVITY': return { ...n, serviceActorScopeKey: PLACEHOLDER_KEY, modelRef: placeholderRef(), promptRef: placeholderRef(), policyRef: placeholderRef(),
        allowedEvidence: { documentTypes: [], sources: [] }, timeoutSeconds: 0 };
      case 'HUMAN_TASK': { const { formRef: _form, ...rest } = n; return { ...rest, sla: { dueSeconds: 0, escalateTo: 'CASE_OWNER' }, allowedEvidence: { documentTypes: [], sources: [] } }; }
      case 'SUPPLEMENT_WAIT': { const { reminderOffsetsSeconds: _r, ...rest } = n; return { ...rest, maxWaitSeconds: 0 }; }
      default: return n;
    }
  });
  return c;
}

export interface WorkflowTemplate { id: string; title: string; description: string; badge: string; build(): EditorDocument }
export const TEMPLATES: WorkflowTemplate[] = [
  { id: 'intake-review', title: 'Tiếp nhận → AI đề xuất → người duyệt → bổ sung', badge: 'Cần cấu hình',
    description: 'Đủ các bước và nhánh. SLA, hạn bổ sung, bằng chứng và tham chiếu AI để trống có đánh dấu; bảng kiểm tra chỉ ra từng ô cần nhập.',
    build: () => normalizeLayout({ content: skeleton(), layout: { nodes: {}, edges: {} } }) },
  { id: 'spec-example', title: 'Ví dụ đặc tả 14 (dữ liệu tổng hợp)', badge: 'Dữ liệu mẫu',
    description: 'Ví dụ đầy đủ từ đặc tả, dùng tham chiếu tổng hợp. Máy chủ vẫn kiểm tra quyền, phạm vi và tham chiếu khi xuất bản.',
    build: () => normalizeLayout({ content: structuredClone(SPEC_EXAMPLE), layout: { nodes: {}, edges: {} } }) },
  { id: 'blank', title: 'Bản trống', badge: 'Tối thiểu', description: 'Chỉ có Bắt đầu và Kết thúc; thêm bước từ thư viện bên trái.',
    build: () => normalizeLayout(newDocument()) },
];
export const specExample = () => structuredClone(SPEC_EXAMPLE);
