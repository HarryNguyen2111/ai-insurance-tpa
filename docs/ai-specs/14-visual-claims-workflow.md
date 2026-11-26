# Quy trình xử lý claims trực quan: catalog workflow/action, RACI và contract API có phiên bản (VWF-01)

Trạng thái: **ĐẶC TẢ + CONTRACT (API 1.4.0), CHƯA TRIỂN KHAI RUNTIME, CHƯA NGHIỆM THU.** Issue #78, con của epic #77; chỉ thực hiện VWF-01, không thực hiện epic. Tài liệu bổ sung specs 01–13 và không thay bất biến nào trong AGENTS.md. Nó không thêm migration/DDL, endpoint, worker hay UI. Mọi acceptance case trong `14b` có trạng thái `SPECIFICATION_ONLY_NOT_EXECUTED`.

Tệp kèm theo:
- `02-openapi-contracts.yaml` (API **1.4.0**): 17 operation và 65 schema `Workflow*`. Thay đổi chỉ là phép cộng; không component hay path nào của 1.3.0 bị sửa (snapshot `pre-vwf1-baseline.json`).
- `14a-visual-workflow-catalog.json`: action catalog v1, ma trận quyền theo operation và từ vựng bpmn-js được phép/bị từ chối.
- `14b-visual-workflow-acceptance-cases.json`: acceptance cases VW01–VW25.
- `examples/visual-workflow-intake-review.example.json`: định nghĩa tổng hợp cho lát cắt đầu tiên.
- `packages/shared-contracts/test/workflow-*`: fixtures dương/âm, oracle tham chiếu cho luật đồ thị (chỉ dùng trong test) và test nhất quán.

## 1. Phạm vi và ranh giới

Lát cắt thực thi đầu tiên (epic #77): **hồ sơ đã nộp → AI trích xuất có thẩm quyền → người xác nhận/sửa HOẶC yêu cầu bổ sung → khách nộp bổ sung có thẩm quyền → tiếp tục**.

| Thuộc phạm vi VWF | Không thuộc phạm vi (giữ chủ sở hữu hiện có) |
| --- | --- |
| Định nghĩa workflow có phiên bản, catalog action, chính sách phân công, task, chú thích chứng cứ, actor scope | Duyệt/từ chối claim, EOB, OTP, duyệt kép, chi trả (#40–#46); tính tiền (#32–#34) |
| Biên dịch BPMN giới hạn sang Temporal qua `IWorkflowEngine` (#80) | Engine thứ hai: không Flowable/Camunda/Zeebe, không BullMQ, không label-studio, không thực thi mã tùy ý |
| Task con người, SLA/escalation, tách nhiệm vụ (#81) | Identity/OIDC/MFA/membership (#21); idempotency (#22); inbox (#24); bridge Temporal (#25) |
| AI service actor có phạm vi, chỉ đề xuất có bằng chứng (#83) | Callback AI và dedup (#39); trích xuất AI (#28–#31) |
| Designer bpmn-js (#79), inbox/annotation Workbench (#82) | Copilot split-screen/EOB review (#51); form intake (#65, spec 11) |

Luật cứng của VWF:
1. **Temporal là engine duy nhất.** BPMN chỉ là ngôn ngữ thiết kế; server biên dịch sang cấu trúc `WorkflowDefinitionContent` đã kiểm tra. Workflow Temporal là một interpreter deterministic, phiên bản hóa, đọc định nghĩa đã pin (#80). Không có script, expression language, URL, CSS hay tool do model sinh.
2. **PostgreSQL là nguồn sự thật.** Task, assignment, annotation và trạng thái định nghĩa được ghi trong `withTenantTransaction` (`SET LOCAL`, FORCE RLS), cùng `audit_logs` (prev/curr hash) và outbox. Temporal history chỉ chứa ID/version/hash, không chứa PII hay chứng từ.
3. **Workflow không quyết định tiền hoặc trạng thái claim tùy ý.** Mỗi END outcome ánh xạ tới đúng một lệnh claim cố định do #38 sở hữu (§3.3). Label/annotation không bao giờ thay trạng thái nghiệp vụ.
4. **AI chỉ đề xuất.** Confidence là tín hiệu chứng cứ, không phải quyền. AI không thể claim task, xác nhận, yêu cầu bổ sung, duyệt, từ chối hay chi trả. Mọi node AI có một người chịu trách nhiệm (`accountableOwner = CASE_OWNER`).
5. **Fail closed.** Thiếu cấu hình, tham chiếu không resolve được, version bị thu hồi, actor không đủ quyền hoặc quyết định owner còn mở: từ chối hoặc chuyển người duyệt thủ công. Không bao giờ tự hoàn tất.

## 2. Từ vựng BPMN giới hạn

| Node (`type`) | Phần tử bpmn-js | Cạnh ra bắt buộc | Thuộc tính bắt buộc |
| --- | --- | --- | --- |
| `START` | `bpmn:StartEvent` (không event definition) | đúng 1 `NEXT` | đúng 1 START/định nghĩa; không có cạnh vào |
| `END` | `bpmn:EndEvent` | không có | `outcome` ∈ `REVIEW_COMPLETED`, `ROUTED_TO_MANUAL_REVIEW`, `SUPPLEMENT_EXPIRED` |
| `HUMAN_TASK` | `bpmn:UserTask` | đúng 1 `ACTION` cho mỗi `allowedActionIds` | `taskKind`, `inputSchemas`/`outputSchemas`, `allowedActionIds`, `assignmentRuleKey`, `accountableOwner`, `sla`, `allowedEvidence`, `formRef` (tùy chọn, pin) |
| `AI_ACTIVITY` | `bpmn:ServiceTask` | đúng 1 `OUTCOME SUCCEEDED` + đúng 1 `OUTCOME FAILED` (FAILED → `HUMAN_TASK`) | `activityKind`, I/O, `allowedActionIds` (chỉ `PROPOSE_*`), `serviceActorScopeKey`, `accountableOwner`, `modelRef`/`promptRef`/`policyRef` (pin), `allowedEvidence`, `timeoutSeconds` 30–600, `retry` (≤ 5 lần) |
| `CONDITION` | `bpmn:ExclusiveGateway` | ≥ 1 `CONDITION` (priority duy nhất 1–10) + đúng 1 `DEFAULT` | — |
| `SUPPLEMENT_WAIT` | `bpmn:IntermediateCatchEvent` + `MessageEventDefinition` | đúng 1 `OUTCOME RECEIVED` + đúng 1 `OUTCOME EXPIRED` | `maxWaitSeconds` 1–30 ngày, ≤ 3 nhắc, `accountableOwner`, I/O |
| `TIMER` | `bpmn:IntermediateCatchEvent` + `TimerEventDefinition` | đúng 1 `NEXT` | `delaySeconds` 60 giây–7 ngày |

Thuộc tính nghiệp vụ nằm trong extension `tpa:*` có kiểu. Không dùng `conditionExpression`/`FormalExpression`/script. Phần tử bpmn-js không nằm trong danh sách được phép thì bị từ chối (không bỏ qua âm thầm). Danh sách đầy đủ nằm ở `14a.bpmnVocabulary`.

**Song song: TỪ CHỐI ở Phase 1.** `bpmn:ParallelGateway`, `InclusiveGateway`, `ComplexGateway` và multi-instance trả `PARALLEL_NOT_SUPPORTED`. Mỗi execution chỉ có **một token**, nên mỗi claim có tối đa một task con người đang mở trong một execution. Lý do: không cần ngữ nghĩa join/hủy nhánh, replay Temporal đơn giản và không có hai quyết định đồng thời trên cùng chứng cứ. Mở rộng song song cần owner quyết định (VWF-OD-08) và một contract mới. `EventBasedGateway`, boundary event, sub-process, call activity, script/business-rule/send/receive/manual task, lane/collaboration, data object/store, text annotation và các event definition signal/error/escalation/conditional/compensate/link/terminate trả `UNSUPPORTED_BPMN_ELEMENT`. SLA được khai báo bằng thuộc tính `sla` của node, không bằng boundary timer.

Điều kiện (`WorkflowCondition`): một leaf `{variable, op, value}` hoặc một nhóm `all`/`any` gồm ≤ 5 leaf (độ sâu ≤ 2). Biến thuộc danh sách đóng, do server tính: `EXTRACTION_LOW_CONFIDENCE_FIELD_COUNT`, `EXTRACTION_QUALITY_FLAG_COUNT`, `DOCUMENTS_MISSING_REQUIRED_SLOT_COUNT`, `SUPPLEMENT_ROUND` (số nguyên; `EQ/NEQ/GT/GTE/LT/LTE`) và `CLAIM_BENEFIT_TYPE` (`EQ/NEQ` với BenefitType, `IN` với mảng). Không có số học, regex, hàm hay đồng hồ. Ngưỡng "low confidence" là OD-08 của spec 11. Định tuyến theo tín hiệu AI chỉ chọn nhánh **người duyệt** nào; không có biến nào cấp quyền.

## 3. Mô hình dữ liệu có phiên bản

### 3.1 `WorkflowDefinitionContent` (schemaVersion `1.0.0`)
`{schemaVersion, workflowKey, title, scope{benefitTypes}, actionCatalogVersion, assignmentPolicy, nodes[2..50], edges[1..100]}`. Canonical JSON ≤ 64 KiB (cùng giới hạn form intake spec 11). `contentHash = SHA-256(canonical JSON: khóa sắp xếp, UTF-8)`, cùng thuật toán với spec 11 §6.2. Không chứa `tenantId`, PII, URL hay mã. Cạnh: `{edgeId, source, target, guard, loopBack?}`, với guard thuộc một trong `NEXT`, `ACTION{actionId}`, `OUTCOME{outcome}`, `CONDITION{priority, condition}`, `DEFAULT`.

### 3.2 `WorkflowActionCatalog` (global, schemaVersion `1.0.0`, `catalogVersion` 1 trong 14a)
Mỗi entry gồm: `actionId`, `nodeTypes`, `actorKind` (`HUMAN` | `AI_SERVICE`), `allowedRelationships`, `requiresMfa`, `completesTask`, `requiresEvidence`, `requiresIdempotencyKey` (luôn `true`), `businessEffect` (`TASK_LIFECYCLE` | `EVIDENCE_ONLY` | `ROUTE_WORKFLOW`) và `auditAction`. Catalog không có `businessEffect` nào tác động tới tiền/claim decision. Không có action approve/reject/EOB/OTP/payment (test kiểm tra). Catalog version bất biến. Execution pin `catalogVersion`; catalog mới không đổi execution đang chạy.

### 3.3 `WorkflowAssignmentPolicy` (schemaVersion `1.0.0`, nhúng và pin cùng định nghĩa)
Rule: `ruleKey`, `candidateRoles` (`CLAIM_REVIEWER`, `INSURER_REVIEWER`; không bao giờ AI), `candidateGroupKeys` (OPEN VWF-OD-03 → `GROUP_DIRECTORY_UNAVAILABLE`), `strategy` (`QUEUE_CLAIM` | `CASE_OWNER_DIRECT`), `accountableOwner = CASE_OWNER`, `distinctFromNodeIds` (tách nhiệm vụ) và `maxActiveTasksPerAssignee`. Policy nằm trong `contentHash` của định nghĩa nên có cùng phiên bản và cùng pin. Policy dùng chung giữa nhiều định nghĩa là việc tương lai.

END outcome → lệnh claim cố định (#38 sở hữu lệnh, VWF không đặt status trực tiếp):

| END `outcome` | Lệnh/ý nghĩa | Trạng thái claim (03 §1) dự kiến |
| --- | --- | --- |
| `REVIEW_COMPLETED` | Chứng cứ đã được người xác nhận; claim tiếp tục luồng thẩm định/EOB hiện có | do ClaimWorkflow #38 quyết định (vd. `DOCTOR_REVIEW`/`EOB_READY` theo luật 03, STP mặc định SHADOW) |
| `ROUTED_TO_MANUAL_REVIEW` | Chuyển hàng đợi duyệt thủ công chuẩn | `DOCTOR_REVIEW` |
| `SUPPLEMENT_EXPIRED` | Hết hạn bổ sung theo cấu hình hợp đồng đã duyệt | `CLOSED_EXPIRED` (qua lệnh #38) |

`REQUEST_SUPPLEMENT` phát lệnh #38 để chuyển claim sang `SUPPLEMENT_REQUIRED`. Khách nộp bổ sung qua `POST /v1/claims/{claimId}/documents` hiện có (02), và lệnh đó tạo tín hiệu `RECEIVED` cho `SUPPLEMENT_WAIT`.

### 3.4 Vòng đời version, pin và migration
`DRAFT → PUBLISHED → RETIRED` (khi version mới của cùng `workflowKey` được publish) hoặc `→ REVOKED` (`reasonCode` ∈ `DEFECT`, `POLICY_CHANGE`, `SECURITY`). Rollback là publish một version mới với nội dung cũ. Nội dung của PUBLISHED/RETIRED/REVOKED bất biến. Mỗi khóa có tối đa một DRAFT đang mở. `revision` tăng ở mỗi `updateWorkflowDraft`, và report validate cũ mất hiệu lực khi revision đổi.

Mỗi execution (#80) pin khi bắt đầu: `{definitionId, versionNo, contentHash}`, `actionCatalogVersion`, assignment policy (cùng hash), và `formRef`/`modelRef`/`promptRef`/`policyRef` của mọi node (`{key, version, hash}`), cùng form version của intake (spec 11). Không có `latest`.

| Version | Claim mới | Execution đang chạy | Task đang mở |
| --- | --- | --- | --- |
| PUBLISHED | resolve tới version này | chạy theo pin | bình thường |
| RETIRED | không resolve | **tiếp tục theo version đã pin** | bình thường |
| REVOKED | không resolve | **không tự migrate** (VWF-OD-02) | `SUSPENDED`; chỉ supervisor được `ESCALATE_TO_MANUAL_REVIEW` → `ROUTED_TO_MANUAL_REVIEW` |

Mặc định fail-closed:
- Không có version PUBLISHED khớp scope: claim đi luồng duyệt thủ công chuẩn, không chạy workflow rỗng.
- Tham chiếu pin không resolve (`REFERENCE_NOT_PUBLISHED`) hoặc catalog lạ (`CATALOG_VERSION_UNKNOWN`): publish bị từ chối.
- Lỗi binding lúc chạy: execution dừng ở trạng thái an toàn và task chuyển `SUSPENDED`.
- AI lỗi/timeout/hết retry: luôn đi cạnh `FAILED` tới task con người.
- Không xác định được case owner: execution không bắt đầu (VWF-OD-07).

### 3.5 Luật publish ngữ nghĩa (detail code cố định)
Ngoài JSON Schema, `validateWorkflowDraft`/`publishWorkflowVersion` kiểm tra các luật dưới đây. `WorkflowValidationReport.issues[]` chỉ chứa `detailCode` + JSON pointer `path` (+ `nodeId`/`edgeId`), không echo nhãn hay giá trị. Publish không hợp lệ trả 422 `DOMAIN_VIOLATION`. Oracle tham chiếu trong test (`workflow-graph-oracle.mjs`) sinh đúng các mã này. #80 phải tái hiện cùng kết quả cho cùng vector.

| detailCode | Luật |
| --- | --- |
| `SCHEMA_INVALID` | Không qua schema `WorkflowDefinitionContent` (kiểu, giới hạn, khóa lạ, `tenantId`, action AI trên node người…) |
| `DUPLICATE_ID` | Trùng `nodeId`, `edgeId` hoặc `ruleKey` |
| `EXACTLY_ONE_START_REQUIRED` / `END_REQUIRED` | Đúng 1 START; ≥ 1 END |
| `START_HAS_INCOMING` / `END_HAS_OUTGOING` | START không có cạnh vào; END không có cạnh ra |
| `DANGLING_EDGE` / `SELF_LOOP` | Cạnh trỏ tới node không tồn tại; cạnh tự vòng |
| `GUARD_NOT_ALLOWED_FOR_SOURCE` | Guard không hợp với loại node nguồn (bảng §2); `loopBack` chỉ được đặt trên cạnh ra từ CONDITION |
| `MISSING_ACTION_ROUTE` / `DUPLICATE_ROUTE` | Mỗi action của HUMAN_TASK cần đúng 1 cạnh; START/TIMER đúng 1 `NEXT` |
| `MISSING_OUTCOME_ROUTE` | AI thiếu SUCCEEDED/FAILED; WAIT thiếu RECEIVED/EXPIRED; CONDITION không có nhánh điều kiện |
| `MISSING_DEFAULT_BRANCH` / `DUPLICATE_PRIORITY` | CONDITION cần đúng 1 DEFAULT; priority duy nhất |
| `CONDITION_TYPE_MISMATCH` | Kiểu biến/op/giá trị không khớp |
| `UNREACHABLE_NODE` | Node không đi tới được từ START |
| `DEAD_END` | Node không phải END mà không đi tới được END nào |
| `UNBOUNDED_LOOP` | Bỏ mọi cạnh `loopBack` (`maxIterations` 1–5) mà đồ thị vẫn còn chu trình |
| `LOOP_WITHOUT_HUMAN_OR_WAIT` | Có một chu trình bất kỳ không đi qua HUMAN_TASK hoặc SUPPLEMENT_WAIT (kiểm tra từng chu trình; cấm vòng AI/timer/điều kiện tự chạy) |
| `ACTION_NOT_ALLOWED_FOR_NODE` | Action không có trong catalog đã pin cho loại node/actor, hoặc cạnh ACTION không thuộc `allowedActionIds` |
| `UNKNOWN_ASSIGNMENT_RULE` | `assignmentRuleKey` không tồn tại; `distinctFromNodeIds` không trỏ tới HUMAN_TASK |
| `INPUT_NOT_PRODUCED` | `inputSchemas` không do START (`CLAIM_REF`, `DOCUMENT_SET`) hoặc node đứng trước tạo ra |
| `AI_FAILURE_NOT_ROUTED_TO_HUMAN` | Cạnh FAILED của AI không đi thẳng tới HUMAN_TASK |
| `SCOPE_NOT_APPROVED` | `scope.benefitTypes` ngoài Phase 1 (`OUTPATIENT`, `DENTAL`, `INPATIENT`; OD-03 spec 11) |
| `AMBIGUOUS_BINDING` | Một benefitType đã được một `workflowKey` PUBLISHED khác của tenant phục vụ |
| `UNSUPPORTED_BPMN_ELEMENT` / `PARALLEL_NOT_SUPPORTED` | Phần tử bpmn-js ngoài từ vựng §2 |
| `REFERENCE_NOT_PUBLISHED` / `CATALOG_VERSION_UNKNOWN` | Pin không resolve tới version PUBLISHED của tenant / catalog global |
| `GROUP_DIRECTORY_UNAVAILABLE` | Có `candidateGroupKeys` khi VWF-OD-03 còn mở |
| `LIMIT_EXCEEDED` | Canonical JSON > 64 KiB (giới hạn số node/cạnh nằm trong schema) |

Vòng lặp có giới hạn: sau khi đạt `maxIterations`, cạnh `loopBack` được coi là false và gateway đi nhánh DEFAULT. Bộ đếm nằm trong state deterministic của workflow, được ghi trong history (#80).

## 4. Vai trò, RACI và tách nhiệm vụ

Vai trò workflow được cấp qua identity #21. Chúng **không** được thêm vào enum `Membership.roles` C1 đã khóa (giống WSC1). `CASE_OWNER` và `ASSIGNEE` là **quan hệ đối tượng** (theo execution/task), không phải role. AI service actor là **loại principal** riêng, dùng service identity (#39/#83), không dùng bearer người dùng.

| Vai trò / actor | Làm được | Không bao giờ |
| --- | --- | --- |
| `WORKFLOW_DESIGNER` | Tạo/sửa draft, validate (MFA) | Publish/revoke; xử lý task |
| `WORKFLOW_PUBLISHER` | Validate, publish, revoke (MFA); không phải người tạo/sửa draft đó (VWF-OD-01) | Sửa draft; xử lý task |
| Case owner (`CASE_OWNER`) | Người chịu trách nhiệm cuối của execution, kể cả node AI; nhận escalation; reassign | Bị thay bằng AI |
| Assignee (`ASSIGNEE`) | Thực hiện action của task đang giữ, annotation, nhả task | Hành động trên task không giữ; tự gán khi bị loại bởi SoD |
| `WORKFLOW_SUPERVISOR` | Xem hàng đợi TEAM, reassign, nhả task, escalate task SUSPENDED | Xác nhận trích xuất thay assignee khi chưa reassign cho chính mình |
| `WORKFLOW_OBSERVER` | Chỉ đọc (OBSERVED queue, annotation) | Mọi mutation |
| AI service actor | `PROPOSE_*` trong phạm vi `serviceActorScopeKey` của node AI đã pin, qua đường kết quả nội bộ (#39) | Mọi bearer API VWF; claim/xác nhận/bổ sung/escalate; duyệt/từ chối/chi trả |

RACI cho lát cắt đầu tiên (R = thực hiện, A = chịu trách nhiệm, C = tham vấn, I = được thông báo):

| Bước | Designer | Publisher | Case owner | Assignee | Supervisor | Observer | AI actor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Thiết kế + validate | R | C | – | – | – | I | – |
| Publish/revoke | C | R/A | I | – | I | I | – |
| AI trích xuất | – | – | A | I | – | I | R |
| Xác nhận/sửa hoặc yêu cầu bổ sung | – | – | A | R | C | I | – |
| Chờ bổ sung, nhắc, hết hạn | – | – | A | – | I | I | – |
| SLA escalation, reassign | – | – | A | I | R | I | – |

Tách nhiệm vụ (kiểm tra phía server, không dựa vào UI):
- Publisher khác người tạo/sửa draft.
- Assignee không phải claimant/guardian của claim.
- `distinctFromNodeIds`: người hoàn thành các node đó trong cùng execution không được nhận task này.
- `maxActiveTasksPerAssignee`.
- AI không bao giờ là candidate, assignee hay case owner.
- Maker-checker của workflow **không** thay maker-checker EOB/chi trả (#40–#46).

Ma trận action (catalog v1; chi tiết trong `14a.actionCatalog`):

| actionId | Node | Actor | Quan hệ được phép | MFA | Hoàn tất task | Bằng chứng | Hiệu ứng |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `CLAIM_TASK` | HUMAN_TASK | HUMAN | CANDIDATE | ✓ | – | – | TASK_LIFECYCLE |
| `UNCLAIM_TASK` | HUMAN_TASK | HUMAN | ASSIGNEE, SUPERVISOR | ✓ | – | – | TASK_LIFECYCLE |
| `REASSIGN_TASK` | HUMAN_TASK | HUMAN | SUPERVISOR, CASE_OWNER | ✓ | – | – | TASK_LIFECYCLE |
| `ADD_ANNOTATION` | HUMAN_TASK | HUMAN | ASSIGNEE, SUPERVISOR | ✓ | – | ✓ | EVIDENCE_ONLY |
| `CONFIRM_EXTRACTION` | HUMAN_TASK | HUMAN | ASSIGNEE | ✓ | ✓ | ✓ | ROUTE_WORKFLOW |
| `REQUEST_SUPPLEMENT` | HUMAN_TASK | HUMAN | ASSIGNEE | ✓ | ✓ | – | ROUTE_WORKFLOW |
| `ESCALATE_TO_MANUAL_REVIEW` | HUMAN_TASK | HUMAN | ASSIGNEE, SUPERVISOR | ✓ | ✓ | – | ROUTE_WORKFLOW |
| `PROPOSE_EXTRACTION` | AI_ACTIVITY | AI_SERVICE | AI_SCOPE_BINDING | – | – | ✓ | EVIDENCE_ONLY |
| `PROPOSE_DOCUMENT_LABEL` | AI_ACTIVITY | AI_SERVICE | AI_SCOPE_BINDING | – | – | ✓ | EVIDENCE_ONLY |
| `PROPOSE_QUALITY_FLAG` | AI_ACTIVITY | AI_SERVICE | AI_SCOPE_BINDING | – | – | ✓ | EVIDENCE_ONLY |

Server đánh giá quyền mỗi lần gọi theo thứ tự: principal và MFA đã xác minh → membership context còn hiệu lực (tenant chỉ lấy từ đây) → role → quan hệ đối tượng (assignee/candidate/case owner/supervisor/observer) → node đã pin cho phép action → catalog entry đã pin → SoD → `expectedTaskVersion`. Đối tượng tenant khác trả 404; thiếu quyền trên đối tượng thấy được trả 403. `allowedActions`/`capabilities` trong response chỉ là gợi ý cho UI.

## 5. Contract API (02, API 1.4.0)

Mọi operation dùng bearer + `X-Membership-Context`, phản hồi `Cache-Control: no-store` và dùng nguyên lỗi C1 (`Error401…Error503`). Không request/response nào nhận hay trả `tenantId`. Mọi mutation (POST/PUT) cần `Idempotency-Key`. Không thêm mã lỗi hay role vào component C1. Detail code chỉ nằm trong `WorkflowValidationReport`; lỗi 422/409 của operation khác trả `messageVi` (`fieldErrors` chờ F1 của spec 11).

| operationId | Method + path | Actor | Ghi chú |
| --- | --- | --- | --- |
| `listWorkflowDefinitions` | `GET /v1/admin/workflow-definitions` | designer/publisher/observer | cursor ≤ 50 |
| `createWorkflowDraft` | `POST /v1/admin/workflow-definitions` | designer + MFA | key mới hoặc version DRAFT kế tiếp; một DRAFT mở/khóa |
| `listWorkflowDefinitionVersions` | `GET …/{definitionId}/versions` | như list | tra cứu version |
| `getWorkflowDefinitionVersion` | `GET …/{definitionId}/versions/{versionNo}` | như list | gồm RETIRED/REVOKED còn được pin |
| `updateWorkflowDraft` | `PUT …/versions/{versionNo}` | designer + MFA | `expectedRevision`; chỉ DRAFT |
| `validateWorkflowDraft` | `POST …/versions/{versionNo}/validate` | designer/publisher + MFA | 200 report có detail code |
| `publishWorkflowVersion` | `POST …/versions/{versionNo}/publish` | publisher + MFA, khác người sửa | `expectedRevision` + `contentHash`; RETIRE version trước |
| `revokeWorkflowVersion` | `POST …/versions/{versionNo}/revoke` | publisher + MFA | `contentHash` + `reasonCode`; task mở → SUSPENDED |
| `getWorkflowActionCatalog` | `GET /v1/workflow/action-catalogs/{catalogVersion}` | mọi role workflow | catalog global bất biến |
| `getWorkflowActorScope` | `GET /v1/workflow/actor-scope` | mọi role workflow | role/capability cho UI; `actorKind` chỉ `HUMAN` |
| `listWorkflowTasks` | `GET /v1/workflow/tasks?queue=` | reviewer/supervisor/observer | `MINE`, `CANDIDATE`, `TEAM`, `OBSERVED` |
| `getWorkflowTask` | `GET /v1/workflow/tasks/{taskId}` | quan hệ với task | pin, `allowedActions`, đề xuất AI có evidence |
| `claimWorkflowTask` | `POST …/{taskId}/claim` | candidate + MFA | race: đúng 1 thành công, còn lại 409 |
| `reassignWorkflowTask` | `POST …/{taskId}/reassign` | supervisor/case owner; assignee tự nhả | `reasonCode` cố định |
| `submitWorkflowTaskAction` | `POST …/{taskId}/actions` | assignee + MFA | `oneOf` theo action; 200 `workflowAdvance=PENDING` |
| `listWorkflowTaskAnnotations` | `GET …/{taskId}/annotations` | quan hệ với task | gồm đề xuất AI (`authorKind=AI_SERVICE`) |
| `createWorkflowTaskAnnotation` | `POST …/{taskId}/annotations` | assignee/supervisor + MFA | append-only, nhãn đóng, không free text |

Ví dụ (dữ liệu tổng hợp):

```http
POST /v1/workflow/tasks/5a0c…/actions
Idempotency-Key: 6f1d2c3b-0d7a-4c1b-9b7e-3c2a1d4e5f61
X-Membership-Context: <opaque>
{"expectedTaskVersion":2,"actionId":"REQUEST_SUPPLEMENT","requestedDocumentTypes":["ITEMIZED_LIST"],"reasonCodes":["MISSING_DOCUMENT"]}

200 Cache-Control: no-store
{"taskId":"5a0c…","taskVersion":3,"status":"COMPLETED","actionId":"REQUEST_SUPPLEMENT","commandId":"9e8d…","workflowAdvance":"PENDING"}
409 {"code":"STALE_VERSION","messageVi":"Nhiệm vụ đã được cập nhật, vui lòng tải lại.","correlationId":"…"}
```

```json
POST …/versions/3/validate → 200 {"valid":false,"revision":4,"contentHash":"<64 hex>",
  "issues":[{"detailCode":"UNBOUNDED_LOOP","path":"/edges","nodeId":"ai_extract"},
            {"detailCode":"AI_FAILURE_NOT_ROUTED_TO_HUMAN","path":"/edges/2/target","edgeId":"e_ai_fail"}]}
```

Sự kiện outbox dự kiến (chưa thêm ở VWF-01; #80/#81 đăng ký trong `packages/event-contracts` theo EVT-01): `workflow.definition-published`, `workflow.definition-revoked`, `workflow.task-changed`. Payload chỉ có ID/version/`changeKind`, không có nhãn, giá trị trích xuất hay PII.

## 6. Từ điển màn hình

| ID | Màn hình | Actor | API | Trạng thái UI bắt buộc | Issue | Test |
| --- | --- | --- | --- | --- | --- | --- |
| S-V1 | Danh sách workflow + version | designer/publisher/observer | `listWorkflowDefinitions`, `listWorkflowDefinitionVersions` | loading, empty, forbidden, error | #79 | VW10 |
| S-V2 | Designer bpmn-js (palette giới hạn §2) | designer | `createWorkflowDraft`, `getWorkflowDefinitionVersion`, `updateWorkflowDraft` | 409 revision, phần tử bị từ chối, read-only khi không phải DRAFT | #79 | VW02, VW07 |
| S-V3 | Panel thuộc tính node/cạnh | designer | (cùng draft), `getWorkflowActionCatalog` | lỗi theo `path` | #79 | VW03–VW05 |
| S-V4 | Validate + publish/revoke | designer/publisher | `validateWorkflowDraft`, `publishWorkflowVersion`, `revokeWorkflowVersion` | danh sách detail code, maker-checker, MFA, xác nhận số execution đang chạy | #79 | VW06, VW09 |
| S-T1 | Inbox task (MINE/CANDIDATE/TEAM/OBSERVED) | reviewer/supervisor/observer | `getWorkflowActorScope`, `listWorkflowTasks` | loading, empty, forbidden, SLA DUE_SOON/BREACHED | #82 | VW10, VW20 |
| S-T2 | Chi tiết task + chứng cứ + đề xuất AI | quan hệ với task | `getWorkflowTask`; chứng từ qua 02 `GET /v1/documents/{documentId}` | SUSPENDED, nút theo `allowedActions` | #82 | VW13, VW17, VW24 |
| S-T3 | Claim/nhả/reassign | candidate/assignee/supervisor | `claimWorkflowTask`, `reassignWorkflowTask` | 409 race, SoD 403 | #82 | VW11, VW12 |
| S-T4 | Xác nhận/sửa, yêu cầu bổ sung, escalate | assignee | `submitWorkflowTaskAction` | 409, 422, retry cùng key | #82 | VW13, VW14, VW18 |
| S-T5 | Annotation trên vùng chứng từ | assignee/supervisor | `listWorkflowTaskAnnotations`, `createWorkflowTaskAnnotation` | append-only, nhãn đóng | #82 | VW21 |

Copilot split-screen/EOB vẫn thuộc #51. S-T2 tái sử dụng document viewer của #51/#82, không tạo viewer thứ hai.

## 7. Từ điển trường

Lớp PII theo spec 11 §5: **P0** cấu hình, **P1** UUID nội bộ, **P2/P3** dữ liệu cá nhân/sức khỏe. Định nghĩa workflow, catalog và policy là P0 và **không được chứa PII**. Giá trị đề xuất/sửa (`WorkflowProposal.value`, `editedValue`) là P2/P3: chỉ có trong response xác thực no-store, mã hóa theo quy định khi lưu, không vào log/event/history/search.

| UI (vi) | API | Lưu trữ đề xuất (#80/#81, chưa là migration) | Kiểu / giới hạn | Bắt buộc | PII | Lỗi | Hợp lệ / Không hợp lệ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Mã workflow | `workflowKey` | `workflow_definitions.workflow_key` UNIQUE(tenant_id, key) | `^[a-z][a-z0-9_]{2,47}$` | ✓ | P0 | 422 | `intake_ai_review` / `Intake-Review` |
| Tên workflow/nhãn node | `title`, `label` | trong `content` JSONB | 1–120, cấm `< > { } \`` và ký tự điều khiển | ✓ | P0 | 422 | "Xác nhận dữ liệu" / `<b>x</b>` |
| Phạm vi quyền lợi | `scope.benefitTypes` | `content` + bảng binding | BenefitType 1–6 | ✓ | P0 | `SCOPE_NOT_APPROVED`, `AMBIGUOUS_BINDING` | `["OUTPATIENT"]` / `["HOSPITAL_INCOME"]` |
| Mã node/cạnh | `nodeId`, `edgeId` | `content` | `^[a-z][a-z0-9_]{1,39}$`, duy nhất | ✓ | P0 | `DUPLICATE_ID` | `confirm_extraction` / `Node 1` |
| Loại node | `type` | `content` | §2 | ✓ | P0 | `SCHEMA_INVALID` | `HUMAN_TASK` / `SCRIPT` |
| SLA | `sla.dueSeconds`, `reminderOffsetsSeconds`, `escalateTo` | `content`; `workflow_tasks.due_at` | 3600–1209600 giây; ≤ 3 nhắc | ✓ (HUMAN_TASK) | P0 | 422 | `86400` / `60` |
| Thời gian chờ bổ sung | `maxWaitSeconds` | `content` | 86400–2592000 | ✓ | P0 | 422 | `1296000` / `0` |
| Timeout/retry AI | `timeoutSeconds`, `retry.*` | `content` | 30–600; ≤ 5 lần | ✓ | P0 | 422 | `120` / `3600` |
| Tham chiếu pin | `modelRef`/`promptRef`/`policyRef`/`formRef` | `content`; pin trong `workflow_executions` | `{key, version ≥ 1, hash 64 hex}` | ✓ (AI); tùy chọn form | P0 | `REFERENCE_NOT_PUBLISHED` | `{"key":"synthetic.vlm","version":1,"hash":"…"}` / `{"key":"x","version":"latest"}` |
| Revision draft | `expectedRevision` | `workflow_definition_versions.revision` | int ≥ 1 | ✓ | P0 | 409 `STALE_VERSION` | `4` / thiếu |
| Hash nội dung | `contentHash` | `content_hash CHAR(64)` | Hash | ✓ (publish/revoke) | P0 | 409 | 64 hex / `"abc"` |
| Version task | `expectedTaskVersion` | `workflow_tasks.version` | int ≥ 1 | ✓ | P0 | 409 | `2` / `0` |
| Người được gán | `assigneePrincipalId` | `workflow_tasks.assignee_principal_id` | uuid | ✓ (reassign) | P1 | 403/404/422 | UUID staff / UUID claimant |
| Lý do reassign | `reasonCode` | `workflow_task_assignments` | enum đóng | ✓ | P0 | 422 | `WORKLOAD` / `"vì bận"` |
| Quyết định đề xuất | `decisions[].decision`, `editedValue`, `evidenceIds` | `workflow_task_decisions` (#81) | ACCEPT/REJECT hoặc EDIT + giá trị ≤ 200; 1–10 evidence | ✓ | P2/P3 | 422 | EDIT + evidence / EDIT thiếu `editedValue` |
| Yêu cầu bổ sung | `requestedDocumentTypes`, `reasonCodes` | `workflow_supplement_requests` | DocumentType 1–7; mã 1–5 | ✓ | P0 | 422 | `["ITEMIZED_LIST"]` / free text |
| Nhãn annotation | `labelKey`, `region`, `page`, `documentVersion` | `workflow_annotations` append-only | enum đóng; Region chuẩn hóa 0–1 | ✓ | P1 | 422 | `MISSING_STAMP` / `"ghi chú tự do"` |

Trường hệ thống chỉ đọc (`status`, `revision`, `contentHash` trong response, `publishedAt`, `inFlightExecutionCount`, `publishableByCurrentActor`, `slaState`, `dueAt`) không có trong request schema. Request chứa chúng bị từ chối do `additionalProperties: false`.

## 8. Mapping UI → API → DB → quyền → test

| Hành động UI | API | Lưu trữ (đề xuất) | Quyền phía server | Lỗi chính | Test (contract đã chạy / runtime dự kiến) |
| --- | --- | --- | --- | --- | --- |
| Lưu draft | `createWorkflowDraft`/`updateWorkflowDraft` | `workflow_definitions`, `workflow_definition_versions` (DRAFT), audit, outbox | DESIGNER + MFA | 409 revision, 422 schema | fixtures schema / VW07 |
| Validate | `validateWorkflowDraft` | report hash theo revision | DESIGNER/PUBLISHER + MFA | report `valid=false` | oracle vectors / VW03–VW05 |
| Publish | `publishWorkflowVersion` | version PUBLISHED, version cũ RETIRED, binding, audit, outbox | PUBLISHER + MFA + maker-checker | 422 `DOMAIN_VIOLATION`, 409 hash | VW01, VW06 |
| Revoke | `revokeWorkflowVersion` | REVOKED, task → SUSPENDED, audit, outbox | PUBLISHER + MFA | 409 hash | VW09 |
| Mở inbox | `listWorkflowTasks` | `workflow_tasks` index (tenant, status, assignee/role) | role + queue | 403 queue TEAM/OBSERVED | VW10 |
| Claim task | `claimWorkflowTask` | `UPDATE … WHERE version = expected` | candidate, SoD, MFA, giới hạn task | 409 race | VW11 |
| Reassign | `reassignWorkflowTask` | `workflow_task_assignments` | supervisor/case owner/tự nhả | 403 SoD | VW12 |
| Xác nhận / bổ sung / escalate | `submitWorkflowTaskAction` | decision + task COMPLETED + audit + outbox → lệnh Temporal (commandId) | assignee + MFA + action đã pin | 409, 422 evidence ngoài scope | VW13, VW14, VW18 |
| Annotation | `createWorkflowTaskAnnotation` | `workflow_annotations` | assignee/supervisor + MFA | 422 tài liệu ngoài claim | VW21 |
| AI đề xuất | đường nội bộ #39 (không phải bearer) | `extraction_runs`, đề xuất, annotation AI | service identity + scope node đã pin | 403/401 | VW15–VW17 |

Mọi bảng tenant-owned dự kiến có ENABLE + FORCE RLS, `UNIQUE(tenant_id,id)`, FK composite và trigger bất biến cho version không phải DRAFT. Thiết kế migration cụ thể thuộc #80/#81, không thuộc PR này.

## 9. Quyết định mở (owner chưa chốt; chặn phần runtime liên quan, không chặn contract)

| ID | Câu hỏi | Mặc định fail-closed trong contract | Chặn |
| --- | --- | --- | --- |
| VWF-OD-01 | Publish workflow có bắt buộc maker-checker (publisher ≠ người tạo/sửa) không? (song song OD-06 của spec 11) | Bắt buộc | #80 publish |
| VWF-OD-02 | Có hỗ trợ migrate execution đang chạy sang version mới khi revoke không? | Không; task SUSPENDED, chỉ supervisor escalate thủ công | #80 |
| VWF-OD-03 | Có danh bạ nhóm/đội cho `candidateGroupKeys` không, nguồn nào (#21)? | Chỉ role; có group thì `GROUP_DIRECTORY_UNAVAILABLE` | #81 |
| VWF-OD-04 | Có cho phép ghi chú tự do trong annotation/yêu cầu bổ sung không (PII, mã hóa, retention)? | Không; chỉ mã cố định | #82 |
| VWF-OD-05 | Lịch làm việc/ngày lễ cho SLA, giá trị SLA mặc định | Thời gian thực (giây); không có giá trị mặc định | #81 |
| VWF-OD-06 | Thời hạn bổ sung (03 nêu 15 ngày) lấy từ hợp đồng/cấu hình nào? | Bắt buộc khai báo; giới hạn 1–30 ngày; không suy diễn | #38, #80 |
| VWF-OD-07 | Ai là case owner (người chịu trách nhiệm) khi bắt đầu execution? | Không xác định được thì không bắt đầu | #81 |
| VWF-OD-08 | Có cần nhánh song song (parallel gateway) không? | Từ chối `PARALLEL_NOT_SUPPORTED` | tương lai |
| VWF-OD-09 | Cấp danh tính/phạm vi AI service actor; đề xuất nhãn AI có hiển thị cho khách không? | Chỉ nội bộ; scope bắt buộc theo node đã pin | #83, #39 |
| VWF-OD-10 | `INSURER_REVIEWER` (DNBH) có được làm candidate task ở Phase 1 không? | Contract cho phép; tenant phải bật rõ trong rule | #81 |

Quyết định liên quan từ spec 11: OD-03 (phạm vi quyền lợi) và OD-08 (ngưỡng confidence). Chưa có quyết định nào trong bảng trên được owner chốt.

## 10. Bàn giao cho các issue con

| Issue | Dùng contract này để | Không được |
| --- | --- | --- |
| #79 designer | Palette bpmn-js theo `14a.bpmnVocabulary`, gọi validate/publish, hiển thị detail code | Tự thực thi workflow; thêm phần tử ngoài danh sách |
| #80 definitions + Temporal | Validator server tái hiện oracle; interpreter deterministic; pin; retire/revoke | Engine khác; đổi version execution đang chạy |
| #81 tasks/SLA/inbox API | Endpoint task/claim/reassign/action; SoD; SLA timer qua #38 | Quyết định claim/tiền |
| #82 Workbench inbox/annotation | Màn hình S-T1–S-T5 | Viewer thứ hai; dùng label làm trạng thái |
| #83 AI actors | Scope `serviceActorScopeKey`, `PROPOSE_*`, fallback người | Bearer API cho AI; AI approve/reject/pay |
| #84 tích hợp | Chạy VW01–VW25 với hai tenant tổng hợp, restart worker | Báo PASS khi chưa có bằng chứng thật |

## 11. Kiểm chứng của PR này

Behavior runtime chưa có, nên chưa thể kiểm thử. `packages/shared-contracts` (`pnpm --filter @tpa/shared-contracts test`) đã chạy các kiểm tra sau:
- Redocly lint và Swagger Parser resolve tham chiếu.
- Generated drift (`generate --check`).
- Fixtures dương/âm cho mọi schema mới.
- Snapshot C1 và snapshot toàn bộ 1.3.0 không đổi.
- Luật C2 chung cho 17 operation mới.
- `workflow-contracts.test.mjs`: inventory operation; không tenant selector; vector hợp lệ/không hợp lệ cho từng loại node và action; chu trình; xung đột version; phạm vi AI; nhất quán 02 ↔ 14/14a/14b; ví dụ đi qua oracle không lỗi; mọi detail code có vector sinh ra nó.

Golden TC01–TC06, PT và DI không đổi và không áp dụng. VW01–VW25 **chưa chạy**.
