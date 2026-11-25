# Bổ sung mô hình dữ liệu và API

Trạng thái: yêu cầu thiết kế bắt buộc trước implementation. `01-database-schema.sql` là baseline chưa đủ production; các bảng dưới đây phải được cụ thể hóa bằng migration và integration tests, không được coi tài liệu này là migration đã chạy.

## 1. Dữ liệu phải bổ sung
| Nhóm | Bảng/thuộc tính dự kiến | Bất biến |
| --- | --- | --- |
| Danh tính | principals, tenant_memberships, roles, assignments | Tenant từ danh tính đã xác minh; quyền đối tượng được kiểm tra |
| Hợp đồng | policy_versions, benefit_rule_versions, member_coverages, endorsements, contract_clauses | Phiên bản đã dùng không sửa; khoảng hiệu lực rõ; phụ lục và thứ tự áp dụng xác định |
| Hạn mức | benefit_accounts, benefit_reservations, benefit_movements | Theo coverage/năm hợp đồng/nhóm hạn mức; used + reserved <= limit |
| EOB | eob_versions, eob_line_versions, calculation_runs | Input snapshot, rule/model/prompt version, clause ID + trích dẫn, rounding và output hash tái hiện được |
| Xác nhận | otp_challenges, eob_signatures, approval_decisions | OTP hash/expiry/attempt limit; gắn member + EOB version/hash; maker khác checker |
| Chi trả | payment_intents, payment_attempts, payment_batches, reconciliation_records | Một semantic payout key; amount/currency/payee snapshot khóa sau duyệt; UNKNOWN không retry mù |
| Sổ cái | ledger_accounts, journal_entries, journal_lines | Posted entry cân Nợ/Có theo currency; không sửa/xóa, reversal bằng bút toán mới |
| Sự kiện | outbox_events, consumer_inbox, idempotency_records | Request hash + response/status; unique tenant/actor/operation/key; cùng key khác payload trả 409 |
| AI | extraction_runs, extracted_field_evidence, catalog_change_proposals | Nguồn trang/vùng/field, confidence, model version; đề xuất danh mục phải được duyệt |
| Chứng từ | upload_sessions, document_versions, original_document_receipts | Object owner/type/size/checksum, scan state; mã tracking không đồng nghĩa đã nhận bản gốc |
| Quản trị | consent_records, retention_policies, audit_chain_heads, audit_anchors | Consent có purpose/version; chain head lock kể cả entity chưa có log; anchor độc lập |

Tiền PostgreSQL `NUMERIC(15,2)`, JSON string, TypeScript Decimal ROUND_HALF_UP; không dùng Elasticsearch làm sổ tiền. `float_ledger_entries` cũ chỉ là sổ biến động, không được tuyên bố là kế toán kép; nguồn số dư phải được quy định và đối soát với journal khi triển khai.

## 2. Transaction và tenant
- Tenant-owned tables có ENABLE + FORCE RLS, USING/WITH CHECK phù hợp. App role không OWNER/SUPERUSER/BYPASSRLS, không quyền DDL/TRUNCATE. Migration role tách riêng. Connection reuse không giữ tenant ngoài transaction.
- Composite unique `(tenant_id,id)` và composite foreign key trên các quan hệ claim/member/plan/line/document/EOB/payment để ngăn tham chiếu chéo tenant; UUID đơn lẻ chưa đủ.
- `audit_logs`, `tenant_provider_policies`, các bảng mới đều có chính sách tenant. Bảng global catalog/providers có quyền đọc/ghi riêng; không cho tenant sửa danh mục chung trực tiếp.
- `e_invoices` dùng chung chỉ được truy cập qua module chống trùng có quyền hạn giới hạn; response không tiết lộ hồ sơ/hãng khác. Cross-tenant allocation check cần privileged function/service được review, khóa hàng invoice và kiểm tra tổng toàn cục; RLS tenant không được che mất allocation của hãng khác khi tính tổng.
- Giữ chỗ hạn mức bằng lock account theo thứ tự ổn định hoặc conditional atomic update; mọi acquire/consume/release idempotent. Không chỉ đọc SUM rồi INSERT. Đồng bảo hiểm và số dư chi trả dùng nguyên tắc tương tự.
- Audit append canonical serialization có version, UTC timestamp cố định, tenant/entity/action/actor/payload trong hash; lock chain head tồn tại từ lần đầu, unique sequence. Business mutation và audit cùng commit. Không hứa chống DBA đặc quyền chỉ bằng trigger.

## 3. Quy tắc quyền lợi và chứng cứ
- Quy tắc hợp đồng phải nêu thứ tự: eligibility, loại trừ, deductible, copay, hạn mức lượt/nhóm/năm; thứ tự dòng ổn định. Thiếu clause/version hoặc thông tin quyền lợi thì review, không tự suy diễn từ chối.
- TC03 chạm hạn mức dẫn YELLOW_REVIEW dù phần duyệt >0; TC06 chỉ khẳng định routing, chưa xác lập số tiền. Bệnh đặc biệt hết chờ vẫn không STP theo bộ cổng hiện tại; thay đổi phải có version và nghiệm thu.
- Daycare, pre/post admission, dấu đỏ, hạn mua thuốc và bản gốc phải gắn cấu hình hợp đồng/nguồn quy định đã được xác minh; không lấy mô tả ví dụ làm điều khoản áp cho mọi DNBH.
- Tách `stp_eligible` và `stp_execution_mode=SHADOW|ENABLED|DISABLED`. Golden tests kiểm tra eligibility/routing; production mặc định SHADOW, vẫn cần người duyệt.
- QR/XML đọc được không đồng nghĩa xác minh thuế; lưu parse status, source verification và timestamp riêng. Tương đồng ảnh là tín hiệu, không là bằng chứng đủ để tự từ chối.
- Bản gốc giữ nguyên; mọi biến đổi ảnh lưu bản dẫn xuất có provenance. Regex/header crop không đủ bảo đảm che PII: phải đánh giá redaction trên dữ liệu thật.

## 4. API cần hoàn thiện trước các task phụ thuộc
OpenAPI hiện tại là contract nền đang chuyển đổi. Không triển khai endpoint chỉ dựa vào bảng dưới đây: task API phải bổ sung request/response, security, errors và tests vào `02-openapi-contracts.yaml` trước code.

| API dự kiến | Quyền và điều kiện |
| --- | --- |
| POST /v1/auth/zalo/exchange; GET /v1/me | Server xác minh danh tính; chọn membership đã cấp, không tự khai tenant |
| POST /v1/consents | Gắn subject, purpose, policy version, thời gian và bằng chứng |
| POST /v1/uploads/{uploadId}/complete | Kiểm object owner/checksum/size/type, quarantine rồi scan |
| GET /v1/claims; GET /v1/claims/{claimId} | Owner/guardian hoặc nhân sự được cấp quyền; cursor/filter allowlist |
| POST /v1/claims/{claimId}/documents | Chỉ trạng thái cho bổ sung, idempotency, audit |
| POST /v1/claims/{claimId}/eob/publish | Expected version, điều khoản hợp lệ, giữ hạn mức; tạo EOB version mới |
| POST /v1/claims/{claimId}/otp/challenges; POST /v1/claims/{claimId}/otp/verify | Idempotency; EOB version/hash; giới hạn gửi/thử; OTP không xuất hiện trong log/event |
| POST /v1/insurer/claims/{claimId}/approvals | Maker-checker, EOB version/hash; ngưỡng theo rule version |
| POST /v1/claims/{claimId}/original-documents/receive | Staff được cấp quyền; receipt evidence + audit |
| POST /v1/payments; GET /v1/payments/{paymentId} | Idempotency, chữ ký EOB còn hiệu lực, approval/original/reservation/funds gates |
| POST /internal/v1/payments/callbacks; POST /v1/payment-reconciliations | Xác thực provider, replay protection, dedup và quyền finance |
| GET /v1/search/claims; POST /v1/insurer/payment-exports | Tenant/object authorization cả search/export; export async, signed download, chống CSV formula injection |
| POST /v1/catalog-proposals/{proposalId}/review | Reviewer khác proposer; tenant scope hoặc curator toàn cục riêng |

Mọi mutation nhạy cảm dùng idempotency; lỗi chung gồm 401/403/404 theo chính sách không lộ đối tượng, 409 stale version/idempotency mismatch, 422 domain violation, 429 rate limit, 503 dependency unavailable. Error body có code/messageVi/correlationId, không echo PII. Webhook dùng service auth riêng, không bearer của người dùng. Preflight sâu có 202/PENDING và status resource; 200 chỉ cho kết quả hoàn tất.

## 5. Điều kiện chi trả
Luồng payment: CREATED -> SUBMITTED -> SUCCEEDED | FAILED | UNKNOWN; UNKNOWN chỉ được xác nhận bằng callback/tra cứu/đối soát có chứng cứ. Claim PAID chỉ sau xác nhận thành công; bút toán, audit, reservation consumption và outbox cùng transaction. Chuyển FAILED sang lần thử mới phải biết chắc lần trước không thành công; dùng semantic payout key và cơ chế idempotency ngân hàng đã kiểm chứng.

EOB sửa sau OTP phải tạo version mới, hủy hiệu lực chữ ký/phê duyệt cũ và tính lại reservation. Nếu payout đã submit, khóa sửa và chuyển quy trình xử lý điều chỉnh; không âm thầm đổi beneficiary/amount.
