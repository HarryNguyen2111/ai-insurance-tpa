# Thiết kế tiếp nhận claims động theo tenant — đề xuất cho issue #65

Trạng thái: **ĐỀ XUẤT THIẾT KẾ, CHƯA TRIỂN KHAI, CHƯA NGHIỆM THU.** Đây là thiết kế chi tiết cho phạm vi đã được owner duyệt trong `10-tenant-workspaces-and-dynamic-intake.md`. Nó bổ sung specs 01–09 và không thay bất biến nào trong AGENTS.md hay 01–09. API, bảng và role nêu ở đây là *đề xuất*. `02-openapi-contracts.yaml` và migrations **không** bị sửa trong PR này; chúng chỉ được sửa ở task F1/F3 (§13) sau khi các quyết định mở (§12) được chốt. Tài liệu/contract hiện có chỉ là bằng chứng thiết kế, không chứng minh đã implement.

Tệp kèm theo:
- `11a-intake-form-config.schema.json`: JSON Schema (2020-12) đề xuất cho nội dung một form version. Đây chỉ là kiểm tra cấu trúc; các luật ngữ nghĩa nằm ở §6.3.
- `examples/intake-form-health-outpatient.example.json`: cấu hình ví dụ tổng hợp.
- `12-dynamic-intake-acceptance-cases.json`: acceptance cases DI01–DI28 (`SPECIFICATION_ONLY_NOT_EXECUTED`).

## 1. Phạm vi

| Nhóm | Phase 1 (được implement sau khi spec duyệt) | OPEN (owner quyết, OD-03) | Tương lai (cần owner phê duyệt, publish bị chặn) |
| --- | --- | --- | --- |
| Event | `OUTPATIENT_VISIT`, `HOSPITALIZATION` | `ACCIDENT_TREATMENT`, `MATERNITY` | `CRITICAL_ILLNESS_DIAGNOSIS`, `DEATH`, `DISABILITY` |
| BenefitType (02) | `OUTPATIENT`, `DENTAL`, `INPATIENT` | `ACCIDENT`, `MATERNITY` | `HOSPITAL_INCOME` (nhân thọ); CI/tử vong/thương tật chưa có BenefitType |
| Kênh | Web Next.js + Zalo Mini App, cùng contract | Custom domain | Clinic Direct Billing (ngoài Phase 1) |

Ma trận event → benefit cho phép: `OUTPATIENT_VISIT → {OUTPATIENT, DENTAL}`, `HOSPITALIZATION → {INPATIENT}`, `ACCIDENT_TREATMENT → {ACCIDENT}` (OPEN), `MATERNITY → {MATERNITY}` (OPEN). Nhân thọ/tử vong/bệnh hiểm nghèo cần người thụ hưởng, giấy chứng tử, thẩm định và nghĩa vụ pháp lý khác. Spec này **không** thiết kế các nghiệp vụ đó. Publish binding cho phạm vi tương lai trả `SCOPE_NOT_APPROVED` (DI25).

## 2. Mô hình khái niệm và cardinality

Năm khái niệm được tách riêng, không hardcode hai form monolithic "health/life":

| Khái niệm | Ý nghĩa | Nguồn sự thật |
| --- | --- | --- |
| **Event** (`eventType`) | Sự kiện y tế làm phát sinh yêu cầu (một lần khám, một đợt nằm viện) | Người dùng chọn khi tạo intake; cố định sau khi tạo |
| **Benefit request** | Quyền lợi người dùng yêu cầu cho event, gắn coverage/plan và clause | Backend tạo candidate từ hợp đồng; người dùng chọn |
| **Form schema + layout** | Trường thu thập, ràng buộc, điều kiện (schema), cùng bước/nhãn/thứ tự/độ rộng (layout) | `intake_form_versions` bất biến, theo tenant |
| **Evidence** | Chứng từ gốc (#26) và trích xuất có provenance (02 `Evidence`, #30) | Object storage + `extracted_field_evidence` |
| **Answers** | Giá trị người dùng xác nhận: canonical (cột có kiểu) + extension (catalog) | `claim_intakes` + `claim_intake_answers` |

Quyết định cardinality đề xuất (CD). Owner xác nhận qua OD-04:
- **CD-1:** 1 intake ↔ 1 event ↔ 1 insured member. Muốn đổi event hoặc member thì tạo intake mới.
- **CD-2:** Phase 1: 1 intake submit tạo **đúng 1 claim** qua domain service của #37.
- **CD-3:** Phase 1: mỗi intake có **đúng 1** benefit request `SELECTED`, vì `claims.benefit_type` là đơn trị và waterfall (03 §2) chạy theo benefit_type. Bảng `claim_intake_benefit_requests` cho phép tối đa 5 dòng (CANDIDATE/DECLINED) để mở rộng. Multi-benefit trong một claim (vd. INPATIENT + HOSPITAL_INCOME) là OD-04. Phase 1 xử lý bằng cách nộp intake riêng; dùng chung hóa đơn phải qua allocation #35.
- **CD-4:** Một tenant có N form definition. Mỗi binding `(planId|null, eventType, channel)` tại một thời điểm chỉ resolve ra **đúng 1** form version.
- **CD-5:** Một intake có 1..50 document (khớp `maxItems` của 02), 0..80 answer.

## 3. Luồng AI-assisted, ưu tiên evidence

```
[Tạo intake] -> [Upload chứng từ (#26 presign) + mô tả tùy chọn] -> [Extraction 202/pending (#28–#31)]
   -> [Đề xuất trường kèm provenance] + [Candidate quyền lợi theo hợp đồng (backend, #32)]
   -> [Câu hỏi thiếu/xung đột (catalog cố định)] -> [User chấp nhận/sửa/từ chối]
   -> [Review: bản submission chuẩn hóa + reviewHash] -> [Xác nhận + consent] -> [Submit -> claim (#37)]
Fallback thủ công: bỏ qua AI ở mọi bước, cùng form version; AI lỗi/timeout không chặn nộp (DI23).
```

Luật cứng:
1. **AI chỉ đề xuất.** Đề xuất có `evidenceIds` trỏ tới bản gốc bất biến, `confidence`, `modelVersion`, `promptVersion`. Đề xuất không có evidence bị loại (DI21). Giá trị chỉ vào answers khi user `ACCEPT`/`EDIT`; `valueSource ∈ {USER, AI_ACCEPTED, AI_EDITED}`.
2. AI chỉ prefill những field có `aiPrefill=true` *và* map được về canonical path/extension key đã biết. AI không tạo field, option, câu hỏi hay yêu cầu chứng từ mới.
3. **Candidate quyền lợi do backend tính**: `form.scope.benefitTypes ∩ coverage còn hiệu lực của member (policy/benefit_rule version, #32) ∩ ma trận event`. Mỗi candidate mang `contractClauseRef` từ benefit rule version đã publish. Không có clause thì không hiển thị là quyền lợi (Luật 3 AGENTS). AI có thể xếp hạng nhưng không thêm candidate. **Intake không ước tính số tiền chi trả** (OD-07 đề xuất: không hiển thị).
4. **Câu hỏi được sinh bằng luật deterministic, không phải văn bản LLM tự do.** Mã câu hỏi lấy từ catalog cố định: `MISSING_REQUIRED`, `CONFLICT` (hai evidence khác giá trị cho cùng target), `LOW_CONFIDENCE` (< ngưỡng OD-08), `DOC_SUGGESTED` (form khai báo docTypes nhưng chưa có). Không tự suy diễn yêu cầu hồ sơ từ hợp đồng nếu chưa có cấu hình đã duyệt.
5. Mô tả tự do (`narrative`): tùy chọn, tối đa 1000 ký tự (trần schema 2000), xếp loại PII P3. Phase 1 **không gửi cho AI** cho tới khi OD-09 được duyệt; khi được duyệt thì chỉ gửi AI nội địa sau redaction. Lưu mã hóa (cần mở rộng field allowlist của `@tpa/security`, F3).

## 4. Workspace, membership và quyền

- Đề xuất **D-WS**: 1 workspace khách hàng = 1 tenant (theo 10 §1). Slug chỉ dùng để định tuyến và lấy branding public. Tenant luôn lấy từ membership đã xác minh (#21, `X-Membership-Context` của 02).
- Role đề xuất thêm vào `Membership.roles` (contract change F1): `WORKSPACE_ADMIN`, `FORM_AUTHOR`, `FORM_PUBLISHER`. Role hiện có giữ nguyên nghĩa.

| Hành động | MEMBER/GUARDIAN | CLAIM_REVIEWER/INSURER_REVIEWER | FORM_AUTHOR | FORM_PUBLISHER | WORKSPACE_ADMIN | CURATOR (global) |
| --- | --- | --- | --- | --- | --- | --- |
| Xem branding public | ✓ (không cần auth) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Resolve/đọc form version để nộp | ✓ cho member được gán | đọc (xem claim) | đọc | đọc | đọc | – |
| Tạo/sửa/submit intake | ✓ owner/guardian | – | – | – | – | – |
| Tạo/sửa draft form, validate, preview | – | – | ✓ (MFA) | ✓ (MFA) | – | – |
| Publish/revoke version, sửa binding | – | – | – | ✓ (MFA, khác author: OD-06) | – | – |
| Xem staff membership; yêu cầu cấp/thu role | – | – | – | – | ✓ (MFA; cấp role thực tế qua #21, OD-05) | – |
| Thêm extension key vào catalog | – | – | đề xuất | đề xuất | – | duyệt (khác người đề xuất) |

Mọi đọc/ghi qua `withTenantTransaction`. Đối tượng của tenant khác trả 404 (không lộ tồn tại). Đổi workspace phải gọi `POST /v1/me/membership` (02), xóa query cache/IndexedDB/state của tenant cũ (DI03). Membership MEMBER/GUARDIAN đến từ enrollment; Phase 1 không có self-signup.

## 5. Từ điển trường (field dictionary)

Lớp PII: **P0** cấu hình/mã danh mục; **P1** định danh nội bộ (UUID); **P2** thông tin cá nhân thường (ngày khám, cơ sở y tế, số tiền); **P3** dữ liệu sức khỏe nhạy cảm (ICD-10, chẩn đoán, narrative, chứng từ); **P4** định danh bí mật (CCCD/SĐT/STK). **P4 không được thu trong intake**: bank/payee thuộc luồng chi trả. Phân loại pháp lý cuối cùng là OD-10.

Ngữ nghĩa chung cho PATCH draft: **absent** = giữ nguyên; **`null`** = xóa giá trị (cho phép ở draft, kể cả field bắt buộc khi submit); **chuỗi rỗng `""`** = 422 `INVALID_FORMAT` cho mọi field không phải text. Với `narrative`, `""` cũng bị từ chối (dùng `null`). Chuỗi được trim hai đầu, NFC-normalize; ký tự điều khiển (trừ `\n` trong narrative) bị từ chối. Default luôn là *không có giá trị*, trừ khi ghi khác.

### 5.1 Canonical fields (allowlist đóng, khớp `canonicalPath` trong 11a)

| UI (vi) | API (`canonical.*`) | Lưu trữ (đề xuất) | Kiểu / độ dài | Bắt buộc draft / submit | Nguồn danh mục | PII | Validation BE (FE dùng lại cùng package) | Lỗi (messageVi) | Hợp lệ / Không hợp lệ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Người được BH | `memberId` | `claim_intakes.member_id` UUID, FK composite `(tenant_id,member_id)` | uuid | ✓ khi tạo / ✓ | member trong `Membership.memberIds` | P1 | thuộc membership, coverage còn hiệu lực hôm nay | "Bạn không có quyền nộp cho người này." | `"7b1e…"` / UUID của tenant khác → 404 |
| Ngày khám / nhập viện | `visitDate` | `claim_intakes.visit_date DATE` | date `YYYY-MM-DD` | – / ✓ | – | P2 | không ở tương lai (giờ Asia/Ho_Chi_Minh), trong `maxAgeDays`, rule `dateRule` | "Ngày khám không hợp lệ." | `"2026-11-20"` / `"2026-13-01"`, `"2027-01-01"` |
| Cơ sở y tế | `providerId` | `claim_intakes.provider_id` UUID FK `providers` | uuid | – / theo config | `providers` (global, đọc) | P2 | tồn tại; không tiết lộ `tenant_provider_policies` | "Không tìm thấy cơ sở y tế." | UUID có thật / UUID ngẫu nhiên |
| Chẩn đoán | `icd10Code` | `claim_intakes.icd10_code` FK `icd10_codes` | string 1–20, `^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$` | – / theo config | `icd10_codes` | P3 | tồn tại trong danh mục | "Mã chẩn đoán không có trong danh mục." | `"J06.9"` / `"j06"`, `"XYZ"` |
| Nhập viện lúc | `admitDatetime` | `claim_intakes.admit_at TIMESTAMPTZ` | date-time có offset | – / ✓ khi event `HOSPITALIZATION` | – | P2 | ≤ now; ≤ discharge | "Thời gian nhập viện không hợp lệ." | `"2026-11-01T08:00:00+07:00"` / không có offset |
| Ra viện lúc | `dischargeDatetime` | `claim_intakes.discharge_at TIMESTAMPTZ` | date-time | – / ✓ khi `HOSPITALIZATION` | – | P2 | ≥ admit; ≤ now | "Thời gian ra viện phải sau nhập viện." | sau admit / trước admit |
| Có giấy phẫu thuật | `hasSurgeryCert` | `claim_intakes.has_surgery_cert BOOLEAN NULL` | boolean | – / – (null = chưa trả lời; claim nhận `false`) | – | P3 | boolean thật | "Giá trị không hợp lệ." | `true` / `"true"` |
| Tổng tiền yêu cầu | `totalRequested` | `claim_intakes.total_requested NUMERIC(15,2)` | Money string (02) | – / ✓ | – | P2 | regex Money; `minMoney ≤ v ≤ maxMoney`; Decimal ROUND_HALF_UP, không float | "Số tiền phải có dạng 720000.00." | `"720000.00"` / `720000`, `"720000.5"`, `"-1.00"` |
| Mô tả sự kiện | `narrative` | `claim_intakes.narrative_encrypted TEXT` (AES-256-GCM, field `intake_narrative`) | text 1–`maxLength` (≤ 2000) | – / theo config | – | P3 | độ dài; không echo trong lỗi/log | "Mô tả quá dài (tối đa {n} ký tự)." | "Sốt 3 ngày" / 2001 ký tự |
| Chứng từ | `documents` (slot theo field key) | `claim_intake_documents(tenant_id,intake_id,document_id,slot_key)` | uuid[] 1–50 tổng | – / ≥ `minFiles` mỗi slot | Document CLEAN (#26) | P3 | owner/member khớp, CLEAN, docType ∈ `docTypes` slot, không trùng | "Chứng từ chưa sẵn sàng hoặc không thuộc hồ sơ này." | doc CLEAN / doc QUARANTINED, doc của member khác |
| Loại sự kiện | `eventType` (tạo intake) | `claim_intakes.event_type` | enum §1 | ✓ khi tạo | ma trận §1 | P0 | Phase 1 enum; có binding | "Loại yêu cầu chưa được hỗ trợ." | `"OUTPATIENT_VISIT"` / `"DEATH"` |
| Quyền lợi yêu cầu | `benefitRequests[].benefitType` | `claim_intake_benefit_requests` | BenefitType | – / đúng 1 SELECTED (CD-3) | candidate do backend tạo | P0 | chỉ chọn candidate có clause | "Vui lòng chọn một quyền lợi." | candidate id / benefitType tự khai |

Các trường hệ thống chỉ đọc (`status`, `version`, `formVersionId`, `contentHash`, `reviewHash`, `valueSource`, `evidenceIds`, `createdAt`): ghi vào sẽ bị 422 `READONLY_FIELD` (DI11).

### 5.2 Extension fields (dynamic field allowlist)

- Tenant **không** tự tạo key. Field extension phải tham chiếu `intake_field_catalog` (global, có version), do CURATOR duyệt theo maker-checker. Không tự sinh cột SQL hay index theo cấu hình tenant.
- Phase 1 chỉ cho phép kiểu có cấu trúc: `BOOLEAN`, `SINGLE_SELECT`, `MULTI_SELECT`, `DATE`, `NUMBER_INT`, `MONEY`. **Không có free text extension**: free text chỉ qua canonical `narrative` đã mã hóa. Schema 11a buộc `TEXTAREA → narrative`.
- Catalog entry: `extensionKey` (`^x_[a-z0-9_]{1,46}$`), `valueType`, giới hạn, `piiClass ∈ {P0,P2,P3}` (P4 bị cấm), `searchable`, `exportable` (chỉ được true khi P0/P2), `retentionClass`, `catalogVersion`. Search/export dùng allowlist này (DI28). Kafka/Temporal/log không bao giờ chứa answers.
- Lưu trong `claim_intake_answers.value JSONB` dạng có kiểu: `{"t":"MONEY","v":"720000.00"}`, `{"t":"DATE","v":"2026-11-20"}`, `{"t":"CODE","v":"ILLNESS"}`, `{"t":"CODES","v":["ILLNESS"]}`, `{"t":"BOOL","v":true}`, `{"t":"INT","v":3}`. Client gửi cùng dạng này; `t` phải khớp `valueType` của catalog. RLS và composite FK giữ nguyên. Mỗi value ≤ 2 KiB.

| Ví dụ catalog | Kiểu | PII | searchable/exportable |
| --- | --- | --- | --- |
| `x_visit_reason` | SINGLE_SELECT (ILLNESS/ACCIDENT/FOLLOW_UP) | P2 | false/true |
| `x_accident_date` | DATE | P2 | false/false |
| `x_has_police_report` | BOOLEAN | P2 | false/false |

### 5.3 Trường cấu hình form (admin)

Được định nghĩa đầy đủ trong 11a. Tóm tắt: `formKey` (`^[a-z][a-z0-9_]{1,47}$`), `title`/`label` (text thuần 1–120, cấm `< > { } \``, ký tự điều khiển), `help` (≤500), `scope{eventType,benefitTypes,channels}`, `steps` 1–10 (mỗi step ≤30 field), `fields` 1–80, `options` 1–50 (`value` dạng `^[A-Z][A-Z0-9_]{0,39}$`), `requiredAt ∈ {NEVER, SUBMIT}`, `requiredWhen`/`visibleWhen` (condition), `constraints` (chỉ khóa đã liệt kê; **không có regex**), `docTypes`, `aiPrefill`, `layout.webWidth ∈ {FULL,HALF}`. Không có URL, HTML, script, CSS hay biểu thức. Cấu hình không chứa PII hay tenantId.

## 6. Contract form và vòng đời version

### 6.1 Condition an toàn, deterministic, có giới hạn
- Leaf: `{field, op, value?}` với `op ∈ EQ, NEQ, IN, NOT_IN, GT, GTE, LT, LTE, IS_SET, IS_NOT_SET`. Combinator: `all`/`any`/`not`. Độ sâu ≤ 3; ≤ 5 phần tử mỗi combinator; ≤ 10 leaf mỗi condition; ≤ 200 leaf mỗi form.
- So sánh có kiểu: Money qua Decimal, date theo chuỗi ISO, codes theo bằng nhau chính xác. Field ẩn hoặc chưa có giá trị thì được coi là *unset*. Không có số học, regex, gọi hàm hay thời gian hệ thống. Ngoại lệ duy nhất là `dateRule` có `today` do server cấp và được ghi trong review.
- Thứ tự đánh giá: topological theo phụ thuộc; chu trình bị chặn khi publish (DI07). Một package TS thuần (`packages/intake-rules`, F2) dùng chung cho web, Zalo và core-api. Parity được kiểm bằng ≥ 200 vector chung (DI09). FE chỉ dùng để phản hồi sớm; **BE là nguồn quyết định**.
- Field ẩn không phải bí mật: toàn bộ config được gửi tới client. Không đặt logic/nhãn nhạy cảm trong config.

### 6.2 Trạng thái version
`DRAFT → (validate/preview) → PUBLISHED → RETIRED` (khi version mới được publish cho cùng binding) hoặc `→ REVOKED` (lỗi/pháp lý, kèm `reasonCode`). Rollback = publish một version mới có nội dung cũ, **không** sửa version cũ. Nội dung của PUBLISHED/RETIRED/REVOKED bất biến: trigger chặn UPDATE `content`/`content_hash`. `contentHash = SHA-256(canonical JSON, khóa sắp xếp, UTF-8)`.

| Trạng thái version | Tạo draft mới | Draft đang có | Claim đã submit |
| --- | --- | --- | --- |
| PUBLISHED | ✓ | review/submit | giữ pin |
| RETIRED | ✗ | review/submit tới `draftExpiresAt` (DI14) | giữ pin, render theo version đó |
| REVOKED | ✗ | `MIGRATION_REQUIRED`; submit → 409 `FORM_VERSION_REVOKED` (DI15) | giữ pin; không re-validate (DI13) |

Migration draft (do user khởi động, idempotent): tạo draft mới trên version hiện hành của binding. Answer được giữ khi trùng `key` + cùng binding + cùng kiểu + qua validation mới. Các answer còn lại được trả về `droppedFields[]` để nhập lại. Documents được giữ; benefit request được tính lại; bắt buộc review lại; ghi audit cho cả draft cũ và mới. Thời hạn draft đề xuất 30 ngày (OD-12).

### 6.3 Publish validator (ngữ nghĩa, ngoài JSON Schema)
Phải qua 11a; field/step key duy nhất; `fieldKeys` của step tham chiếu field tồn tại, mỗi field xuất hiện ở đúng 1 step; tham chiếu condition tồn tại, không chu trình; giới hạn §6.1; nội dung serialize ≤ 64 KiB; extension key có trong `catalogVersion` và cùng kiểu; component phù hợp kiểu catalog; canonical chỉ được siết chặt (không hạ `requiredAt` của field mà backend bắt buộc, không nới min/max, không đổi component) (DI08); `scope.benefitTypes ⊆` ma trận event; event/benefit thuộc phạm vi được phép (DI25); mọi component được hỗ trợ trên mọi kênh trong `scope.channels` (DI24); binding không mơ hồ (DI02). Lỗi trả 422 `CONFIG_INVALID` kèm danh sách `{path, detailCode}`.

### 6.4 Binding resolution
`intake_form_bindings(tenant_id, plan_id NULL, event_type, channel, form_version_id, effective_from, effective_to)`. Resolve cho `(member → plan còn hiệu lực hôm nay, eventType, channel)`: ưu tiên binding có `plan_id` khớp, sau đó tới `plan_id IS NULL`; điều kiện `effective_from ≤ now < effective_to`. Không có binding → 422 `NO_FORM_BOUND`, UI hiện hướng dẫn liên hệ thay vì form rỗng. Thay đổi binding là thao tác publish: có audit + outbox.

## 7. Draft / review / submit

- `claim_intakes.status`: `DRAFT → SUBMITTED`, ngoài ra có `ABANDONED` (user hủy), `EXPIRED` (quá hạn), `MIGRATION_REQUIRED`. Mỗi PATCH tăng `version`; client gửi `expectedVersion`, sai → 409 `STALE_VERSION` (DI17).
- PATCH draft không kiểm tra required, chỉ kiểm tra kiểu/giới hạn/quyền. Response có `validation.state ∈ {INCOMPLETE, READY}` cùng danh sách thiếu (DI10).
- **Review** (`POST …/review`) chạy toàn bộ validation BE, loại answer của field ẩn (liệt kê trong `excludedHiddenFields`, không bỏ âm thầm), rồi trả `submission` chuẩn hóa và `reviewHash = SHA-256(canonical submission + formVersionId + contentHash + draft version)`.
- **Submit** (`POST …/submit`) cần `Idempotency-Key`, `expectedVersion`, `reviewHash`, `consentId`, `consentAccepted: true`. Trong một `withTenantTransaction`, submit khóa intake, tính lại reviewHash, gọi claim submit domain service của #37, ghi claim (pin `form_version_id`, `form_content_hash`, `submission_hash`), audit và outbox `claim.submitted`. Cùng key + cùng payload → trả response cũ. Cùng key + khác payload → 409 `IDEMPOTENCY_CONFLICT`. Key khác trên draft đã SUBMITTED → 409 `STALE_VERSION` (DI16).
- Offline/retry: client giữ draft cục bộ (không lưu narrative, không có P3 ngoài phiên) và retry với cùng `Idempotency-Key`. Nếu không chắc submit đã thành công, gọi `GET /v1/claim-intakes/{id}` trước khi tạo key mới.

## 8. Từ điển màn hình

| ID | Màn hình | Kênh | Actor | API (đề xuất trừ khi ghi "02") | Trạng thái UI bắt buộc | Test |
| --- | --- | --- | --- | --- | --- | --- |
| S-W1 | Chọn workspace + branding | Web, Zalo | Mọi principal | 02 `GET /v1/me/memberships`, `POST /v1/me/membership`; `GET /v1/public/workspaces/{slug}/branding` | loading, empty (không có membership), forbidden, error | DI03, DI19 |
| S-W2 | Staff membership | Web | WORKSPACE_ADMIN | `GET /v1/admin/memberships` (phụ thuộc #21) | loading, empty, forbidden, MFA-required | DI04 |
| S-A1 | Danh sách form + binding | Web | FORM_AUTHOR/PUBLISHER | `GET /v1/admin/intake-forms` (cursor, ≤50/trang) | loading, empty, error, forbidden | DI02 |
| S-A2 | Soạn draft form | Web | FORM_AUTHOR | `POST /v1/admin/intake-forms/{formKey}/versions`, `PUT …/versions/{v}` (`expectedRevision`) | conflict (409), invalid (422 path) | DI05–DI08 |
| S-A3 | Validate + preview web/Zalo | Web | FORM_AUTHOR/PUBLISHER | `POST …/versions/{v}/validate`, `POST …/versions/{v}/preview?channel=` | lỗi theo path, CHANNEL_UNSUPPORTED | DI05, DI24 |
| S-A4 | Publish / revoke / binding | Web | FORM_PUBLISHER | `POST …/versions/{v}/publish`, `POST …/versions/{v}/revoke`, `PUT /v1/admin/intake-bindings` | confirm dialog, forbidden, maker-checker | DI04, DI15, DI25 |
| S-C1 | Bắt đầu yêu cầu | Web, Zalo | MEMBER/GUARDIAN | `GET /v1/intake-forms/resolve`, `POST /v1/claim-intakes` | NO_FORM_BOUND, forbidden | DI01, DI02 |
| S-C2 | Chứng từ + mô tả | Web, Zalo | MEMBER/GUARDIAN | 02 `POST /v1/claims/upload-url`, `POST /v1/uploads/{id}/complete`; `POST /v1/claim-intakes/{id}/documents` | quarantine pending, scan fail, offline retry | DI26 |
| S-C3 | Đề xuất AI + quyền lợi | Web, Zalo | MEMBER/GUARDIAN | `POST …/extractions` (202), `GET …/extractions/{runId}`, `POST …/suggestions/{sid}/decision` | pending, timeout → fallback, empty | DI21, DI23 |
| S-C4 | Câu hỏi thiếu/xung đột | Web, Zalo | MEMBER/GUARDIAN | lấy từ `GET /v1/claim-intakes/{id}` (`questions[]`) | không còn câu hỏi | DI22 |
| S-C5 | Form động (thủ công/sửa) | Web, Zalo | MEMBER/GUARDIAN | `GET /v1/intake-forms/versions/{id}?channel=`, `PATCH /v1/claim-intakes/{id}` | 409 conflict, 422 field errors | DI10–DI12, DI17 |
| S-C6 | Xem lại + xác nhận + consent | Web, Zalo | MEMBER/GUARDIAN | `POST …/review`, 02 `POST /v1/consents`, `POST …/submit` | duplicate submit, revoked, review hash mismatch | DI15, DI16 |
| S-C7 | Đã nộp → tracker | Web, Zalo | MEMBER/GUARDIAN | 02 `GET /v1/claims/{claimId}` | – | DI13 |

Tracker/EOB/OTP sau khi nộp thuộc #50 (Zalo); màn hình nhân sự thuộc #51/#52. Spec này không thiết kế lại các phần đó.

## 9. Mapping UI → API → lưu trữ → validation → test và ví dụ

| Hành động UI | API | Lưu trữ | Validation (FE sớm / BE quyết định) | Lỗi chính | Test |
| --- | --- | --- | --- | --- | --- |
| Chọn member + event | `POST /v1/claim-intakes` + Idempotency-Key | `claim_intakes` (pin `form_version_id`, `form_content_hash`), audit | FE: picker; BE: membership, coverage, binding, phạm vi | 403/404, 422 `NO_FORM_BOUND`, 409 idem | DI01, DI02, DI25 |
| Gắn chứng từ | `POST …/documents {expectedVersion, items:[{documentId, slotKey}]}` | `claim_intake_documents` | BE: CLEAN, owner, docType ∈ slot, ≤50 | 422 `DOCUMENT_NOT_READY` | DI26 |
| Chạy trích xuất | `POST …/extractions` → 202 `{extractionRunId}` | `extraction_runs`, `claim_intake_suggestions` | BE: chỉ field `aiPrefill`, evidence bắt buộc | 503 → fallback | DI21, DI23 |
| Chấp nhận/sửa/từ chối đề xuất | `POST …/suggestions/{sid}/decision` | answers (`value_source`), suggestion status | như PATCH | 409, 422 | DI21 |
| Sửa field | `PATCH /v1/claim-intakes/{id}` | cột canonical / `claim_intake_answers` | FE+BE: package `intake-rules` | 409, 422 | DI10–DI12, DI17 |
| Xem lại | `POST …/review` | không ghi (trả hash) | BE: toàn bộ, required, hidden | 422 fieldErrors | DI10, DI11 |
| Nộp | `POST …/submit` + Idempotency-Key | `claims` qua #37, audit, outbox | BE: reviewHash, consent, version | 409 revoked/stale/idem | DI13, DI15, DI16 |
| Publish form | `POST /v1/admin/…/publish` + Idempotency-Key | `intake_form_versions`, bindings, audit, outbox `intake.form-published` | BE: §6.3, role, MFA, maker-checker | 403, 422 `CONFIG_INVALID` | DI04–DI08 |

Ví dụ (dữ liệu tổng hợp):

```http
POST /v1/claim-intakes
Idempotency-Key: 5f0c2c1e-0d7a-4c1b-9b7e-3c2a1d4e5f60
X-Membership-Context: <membershipId>
{"memberId":"7b1e2d3c-1111-4aaa-8bbb-000000000001","eventType":"OUTPATIENT_VISIT","channel":"ZALO"}

201 Cache-Control: no-store
{"intakeId":"c0ffee00-2222-4ccc-8ddd-000000000002","status":"DRAFT","version":1,
 "formVersionId":"f0f0f0f0-3333-4eee-8fff-000000000003","formContentHash":"<64 hex>",
 "draftExpiresAt":"2026-12-26T00:00:00Z","validation":{"state":"INCOMPLETE","missing":["insured_person","invoice_docs","visit_date","total_requested","visit_reason"]}}
```

```http
PATCH /v1/claim-intakes/c0ffee00-2222-4ccc-8ddd-000000000002
{"expectedVersion":3,"canonical":{"visitDate":"2026-11-20","totalRequested":"720000.00","icd10Code":null},
 "answers":{"visit_reason":{"t":"CODE","v":"ILLNESS"}}}

200 {"version":4,"validation":{"state":"READY","missing":[]}}
```

```json
422 {"code":"VALIDATION_FAILED","messageVi":"Thông tin chưa hợp lệ.","correlationId":"9d1c…",
     "fieldErrors":[{"fieldKey":"total_requested","detailCode":"INVALID_FORMAT","messageVi":"Số tiền phải có dạng 720000.00."},
                    {"fieldKey":"x_unlisted","detailCode":"UNKNOWN_FIELD","messageVi":"Trường không thuộc biểu mẫu."}]}
```

```json
POST …/review → 200 {"reviewHash":"<64 hex>","submission":{"benefitType":"OUTPATIENT","visitDate":"2026-11-20",
  "totalRequested":"720000.00","documentIds":["…"],"answers":{"visit_reason":"ILLNESS"}},
  "excludedHiddenFields":["accident_date"],"today":"2026-11-26"}
POST …/submit {"expectedVersion":4,"reviewHash":"<64 hex>","consentId":"…","consentAccepted":true}
  → 201 {"claimId":"…","claimCode":"…","status":"SUBMITTED"}
  → 409 {"code":"STALE_VERSION","detailCode":"FORM_VERSION_REVOKED","messageVi":"Biểu mẫu đã được cập nhật, vui lòng xem lại hồ sơ.","correlationId":"…"}
```

Error mapping vào `ApiError.code` hiện có: `VALIDATION_FAILED` (422, `fieldErrors`), `STALE_VERSION` (409; `detailCode` ∈ `DRAFT_VERSION`, `FORM_VERSION_REVOKED`, `FORM_VERSION_RETIRED`, `REVIEW_HASH_MISMATCH`), `IDEMPOTENCY_CONFLICT`, `DOMAIN_VIOLATION` (422; `NO_FORM_BOUND`, `SCOPE_NOT_APPROVED`, `CONFIG_INVALID`, `CHANNEL_UNSUPPORTED`, `DOCUMENT_NOT_READY`), `FORBIDDEN`/`NOT_FOUND`, `DEPENDENCY_UNAVAILABLE`. Payload vượt giới hạn → 413/422 `LIMIT_EXCEEDED`. Các trường `fieldErrors`/`detailCode` là phần mở rộng có kiểm soát của `ApiError` (F1). `messageVi` không echo giá trị người dùng.

## 10. Cache, hiệu năng và nghiệm thu bảo mật

**Cache.** Nội dung version bất biến nên key là `intake:cfg:{tenantId}:{formVersionId}:{channel}`, ETag = `contentHash`, không cần invalidation. Resolve binding đọc PostgreSQL (index `(tenant_id, event_type, channel, plan_id)`) nên sau commit publish luôn thấy version mới (DI18). Redis lỗi chỉ làm chậm, không sai. Response có xác thực dùng `Cache-Control: private, no-store` theo 02. Chỉ branding public được `public, max-age ≤ 300` và không chứa ID nội bộ (DI19). Client cache theo `(principal, tenant, formVersionId, channel)` và xóa khi đổi workspace hoặc logout.

**Bundle/render.** Renderer form và các component được lazy-load. Zalo bundle < 4MB đo trong CI (#49/#50), không có OCR/WASM. Mục tiêu đề xuất: chunk renderer ≤ 150 KB gzip.

**Workload tham chiếu đề xuất (OD-11 phải chốt trước khi đo):** 10 tenant; 30 version published mỗi tenant; form lớn nhất 80 field/200 leaf; 300 phiên intake đồng thời; 3.000 submit/ngày, burst 5 submit/s; 10 file/claim, trung bình 2 MB, tối đa 20 MiB. Đo bằng k6 (hoặc công cụ tương đương) trên staging đã chốt, cả cache nóng và lạnh, và khi Redis down. Upload và AI được tách khỏi latency API.

| Chỉ số | Mục tiêu đề xuất để đo (không phải SLA) |
| --- | --- |
| Fetch config (cache hit) p95 / p99 server | ≤ 150 ms / ≤ 300 ms |
| Resolve + tạo intake p95 | ≤ 400 ms |
| PATCH draft p95 | ≤ 300 ms |
| Review p95 (form lớn nhất) | ≤ 500 ms |
| Submit p95 (không gồm AI/upload) | ≤ 800 ms |
| Lỗi 5xx | < 0,1% |
| Đánh giá condition client (form lớn nhất, thiết bị Android tham chiếu OD-11) | ≤ 16 ms/lần |

Kết quả DI27 ghi p50/p95/p99, throughput, error rate, CPU/RAM. Chưa đo thì không tuyên bố đạt.

**Nghiệm thu bảo mật:** cô lập tenant A/B (DI01, DI03, DI18), quyền publish (DI04), injection và giới hạn (DI05, DI06, DI26), unknown/readonly field (DI11), version cũ/bị thu hồi (DI13–DI15), duplicate/concurrent (DI16, DI17), PII trong answers/cache/log/export (DI20, DI28), parity (DI09, DI24).

## 11. Lưu trữ đề xuất (F3, chưa phải migration)

Mọi bảng tenant-owned dưới đây có ENABLE + FORCE RLS, `UNIQUE(tenant_id,id)` và composite FK. Ghi qua `withTenantTransaction` cùng audit/outbox.
- `tenant_workspace_profiles(tenant_id PK, slug UNIQUE, display_name, logo_asset_id, primary_color CHAR(7), version)`. Thay thế dần `tenants.branding_config` JSONB tự do.
- `intake_field_catalog(extension_key, catalog_version, value_type, limits JSONB, pii_class, searchable, exportable, retention_class, status, approved_by)`. Bảng global; ghi chỉ qua CURATOR.
- `intake_form_definitions(tenant_id, id, form_key, UNIQUE(tenant_id, form_key))`.
- `intake_form_versions(tenant_id, id, definition_id, version_no, status, content JSONB, content_hash CHAR(64), created_by, published_by, published_at, revoked_reason_code, UNIQUE(tenant_id, definition_id, version_no))`. Có trigger bất biến khi status ≠ DRAFT.
- `intake_form_bindings(tenant_id, id, plan_id NULL, event_type, channel, form_version_id, effective_from, effective_to)`. Có exclusion constraint chống chồng lấn cùng `(tenant, coalesce(plan), event, channel)`.
- `claim_intakes(tenant_id, id, subject_principal_id, member_id, event_type, channel, form_version_id, form_content_hash, status, version, các cột canonical §5.1, narrative_encrypted, draft_expires_at, submitted_claim_id NULL)`.
- `claim_intake_answers(tenant_id, intake_id, field_key, extension_key, catalog_version, value JSONB CHECK size, value_source, evidence_ids UUID[], PRIMARY KEY(tenant_id,intake_id,field_key))`.
- `claim_intake_documents`, `claim_intake_benefit_requests(…, contract_clause_ref, rule_version_id, status)`, `claim_intake_suggestions(…, target, proposed_value JSONB, evidence_ids, confidence, model_version, prompt_version, status)`, `claim_intake_questions(…, question_code, target, reason, resolved_at)`.
- `claims` thêm `form_version_id`, `form_content_hash`, `submission_hash`, `intake_id` (expand-only).

## 12. Quyết định mở (chặn implementation liên quan)

| ID | Câu hỏi | Đề xuất mặc định | Chặn |
| --- | --- | --- | --- |
| OD-01 | Có cần nhiều workspace trong một tenant không? | Không (1 workspace = 1 tenant) | F3 profile |
| OD-02 | Ai sở hữu custom domain/slug, quy tắc đặt slug? | Slug do TPA ops cấp; không custom domain Phase 1 | F5 branding |
| OD-03 | Bật `ACCIDENT_TREATMENT`/`MATERNITY` Phase 1? Lộ trình life/CI/death | Tắt cho tới khi có hợp đồng/clause đã duyệt; life/CI/death cần owner + spec riêng | F4 scope validator |
| OD-04 | Multi-benefit trong một claim; event dùng cho nhiều claim (pre/post 30 ngày) | Phase 1: 1 claim/1 benefit; intake riêng | F6, #37 |
| OD-05 | Ai cấp staff role trong workspace (TPA ops hay DNBH)? | TPA ops cấp qua #21; WORKSPACE_ADMIN chỉ yêu cầu | S-W2, F4 |
| OD-06 | Publish có maker-checker không? | Có: publisher ≠ author, MFA | F4 |
| OD-07 | Có hiển thị ước tính chi trả trong intake? | Không | F7 |
| OD-08 | Ngưỡng confidence cho `LOW_CONFIDENCE` | Chưa chốt: cần eval trên dữ liệu được phép (#30) | F7 |
| OD-09 | Narrative có được gửi tới AI nội địa? Retention? | Không gửi Phase 1; mã hóa; retention theo policy pháp lý | F3, F7 |
| OD-10 | Phân loại pháp lý dữ liệu sức khỏe (91/2025/QH15) cho cột canonical/extension | Theo bảng P0–P4 tới khi pháp chế xác nhận | F3 production |
| OD-11 | Workload pilot thật, thiết bị Android tham chiếu, môi trường đo | §10 là giả định | DI27 |
| OD-12 | Thời hạn draft và retention draft bị bỏ | 30 ngày, sau đó xóa answers/narrative, giữ audit | F6 |

Không giao builder tự đoán các mục trên. Thông tin pháp lý/nhà cung cấp còn thiếu vẫn OPEN.

## 13. Công việc tiếp theo (draft, chưa tạo issue)

Thứ tự phụ thuộc. Mỗi task nhỏ, liên kết thay vì làm lại #21/#26/#37/#49–#52.

| ID | Task | Phụ thuộc | Đầu ra |
| --- | --- | --- | --- |
| F1 | CONTRACT: thêm API §8/§9, role mới, `fieldErrors`/`detailCode` vào 02 + fixtures shared-contracts | spec duyệt, OD-04/05/06 | OpenAPI + test contract |
| F2 | PKG `packages/intake-rules`: validator config §6.3, condition evaluator, normalizer, ≥200 parity vectors | F1 (schema 11a chốt) | Jest tests DI05–DI09, DI12 |
| F3 | DB: migrations §11, RLS/FK/trigger bất biến, field `intake_narrative` trong `@tpa/security` | F1, #18, OD-09/10 | integration tests DI01, DI13, DI20 |
| F4 | API admin: draft/validate/preview/publish/revoke/binding, audit/outbox | F2, F3, #21, #23 | DI02, DI04–DI08, DI25 |
| F5 | API runtime: resolve/fetch config, cache, branding public | F3, F4, OD-02 | DI18, DI19 |
| F6 | API intake: create/patch/documents/review/submit → domain service #37 | F2, F5, #22, #26, #37, OD-12 | DI10–DI17, DI26 |
| F7 | AI suggestions/questions/benefit candidates (core + contract ai-worker) | F6, #30, #31, #32, OD-07/08 | DI21–DI23 |
| F8 | Migration draft khi version bị revoke | F6 | DI15 |
| F9 | UI web intake (Next.js) S-C1–S-C7 | F6, F7 (fallback thủ công không cần F7) | browser E2E DI03, DI23, DI24 |
| F10 | UI Zalo: gắn renderer động vào FNOL của #50 (mở rộng #50, không tạo luồng song song) | F6, #49, #50 | DI24, bundle |
| F11 | UI admin S-A1–S-A4, S-W2 | F4, OD-05 | browser E2E DI04 |
| F12 | Đo hiệu năng + kiểm thử bảo mật DI27/DI28 | F5–F10, #56, OD-11 | báo cáo đo |

## 14. Kiểm chứng của PR tài liệu này

Behavior runtime không áp dụng vì chưa có code. Test `packages/shared-contracts/test/intake-spec-docs.test.mjs` kiểm tra:
- example hợp lệ với 11a;
- các mutation injection/giới hạn/độ sâu bị từ chối;
- tham chiếu trong example đóng kín, không có chu trình;
- canonical allowlist khớp §5.1;
- mọi DI trong 12 được tham chiếu trong tài liệu này và ngược lại;
- mọi OD dùng trong 12 được định nghĩa trong §12.

Golden cases 04 và PT 09 không đổi, và không case nào được báo PASS.
