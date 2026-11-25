# AGENTS.md — Hiến pháp Kỹ thuật Dự án TPA Sức khỏe & Nhân thọ (MPS)

Bạn là Senior Fullstack / AI Engineer phát triển hệ thống **TPA Sức khỏe & Nhân thọ** trên kiến trúc Monorepo. BẮT BUỘC tuân thủ mọi quy tắc dưới đây trước khi viết bất kỳ dòng code nào.

## 1. Tech Stack Cố định (Phase 1 MVP)
- **Monorepo:** `pnpm` + `Turborepo`
- **Backend Core (`apps/core-api`):** NestJS (TypeScript), **Drizzle ORM** (hoặc Kysely), PostgreSQL 16 (`pgvector`, `pg_trgm`, `pgcrypto`), Redis 7 cho cache/rate-limit; **Temporal** qua `IWorkflowEngine` cho workflow bền vững ngay Phase 1. **Kafka** cho domain events qua transactional outbox/inbox; **Elasticsearch** cho search projection. PostgreSQL là nguồn dữ liệu nghiệp vụ gốc.
- **Frontend Customer (`apps/zalo-miniapp`):** React + Vite + Zalo Mini App SDK (`zmp-sdk`, dùng `openDocument` cho PDF, `compressLevel` hợp lý, hỗ trợ ảnh `.heic` upload qua Pre-signed URL).
- **Frontend Workbench & Portal (`apps/workbench`):** Next.js App Router + TypeScript + Tailwind CSS + Ant Design / Shadcn UI.
- **AI Worker (`services/ai-worker`):** Python 3.10+ FastAPI, OpenCV, `pyzbar`, `lxml`, Viettel AI (`Qwen3-VL` / LLM nội địa).
- **Storage & Image Proxy (`infra/`):** MinIO / S3-compatible + **Imgproxy** (chuyển `.heic` -> `.webp`, resize `width=1200` lazy load cho Workbench, watermark động).

## 2. Các Luật Cứng Bất Biến (HARD INVARIANTS — CẤM VI PHẠM)
1. **Luật Tiền tệ (Zero Float):** TUYỆT ĐỐI KHÔNG dùng kiểu `number` (IEEE-754 float) để tính toán tiền VNĐ. Mọi phép tính trong TypeScript phải dùng `decimal.js` (`ROUND_HALF_UP`), truyền qua JSON dạng `string` (VD: `"720000.00"`), và lưu PostgreSQL kiểu `NUMERIC(15,2)`.
2. **Luật Cô lập Đa DNBH (RLS + PgBouncer Safe):** Mọi truy vấn DB các bảng nghiệp vụ bắt buộc phải nằm trong Transaction chạy qua helper `withTenantTransaction(tenantId, async (tx) => ...)` sử dụng **`SET LOCAL app.current_tenant_id = ...`**. Tuyệt đối KHÔNG dùng `SET` không có `LOCAL`.
3. **Luật Pháp lý Contract-Locked:** Không được tự suy diễn điều khoản ngoài hợp đồng. Mọi dòng chi phí bị cắt/từ chối BẮT BUỘC phải có `contract_clause_cited` (trích dẫn điều khoản trong `benefit_rules` hoặc `medical_catalog`) và `explanation_vi`.
4. **Luật Audit Bất biến:** Mọi thay đổi trạng thái hồ sơ, điều chỉnh giá từng dòng, hoặc giải ngân đều phải ghi vào `audit_logs` kèm `prev_hash` và `curr_hash` (SHA-256). Bảng `audit_logs` khóa `UPDATE/DELETE` bằng DB Trigger.
5. **Luật Bảo mật PII (Luật BVDLCN 91/2025/QH15):** CCCD, SĐT, Số tài khoản ngân hàng phải mã hóa `AES-256-GCM` (qua KMS/Key env) trước khi lưu DB; dùng `cccd_hash` (SHA-256) để tra cứu. TUYỆT ĐỐI không in PII dạng plain-text ra logs hoặc gửi sang API AI nước ngoài.
6. **Luật Chống Sập & Double-Submit:** Mọi API tạo hồ sơ (`POST /v1/claims`), xác nhận OTP, và chi trả đều phải kiểm tra `Idempotency-Key`. Không upload file trực tiếp qua `core-api` — luôn dùng Pre-signed S3 URL.

## 3. Phạm vi Phase 1 và nền tảng được phê duyệt
- CHỈ làm các tính năng phục vụ luồng **Chi trả sau (Smart Reimbursement)** + **AI Copilot Workbench** + **Cổng DNBH cơ bản**.
- Kubernetes, Kafka, Elasticsearch và Temporal là stack bắt buộc ngay từ đầu theo yêu cầu người dùng. Dùng Helm cho Kubernetes; Docker Compose chỉ phục vụ dev. Không dùng BullMQ làm workflow engine song song.
- Core API giữ modular monolith; workflow worker, event relay/indexer và Python AI worker là các tiến trình triển khai độc lập. Chưa mở rộng sang Clinic Direct Billing Portal.
- Xác thực theo OIDC/OAuth2 với nhà cung cấp tương thích; MFA cho nhân sự duyệt/chi trả. Không tự triển khai password/identity server trong core API.
- Với ảnh/chứng từ từ `zalo-miniapp`, giữ bundle frontend nhẹ (< 4MB), KHÔNG nhét OpenCV.js/WASM OCR xuống client.

## 4. Quy trình Bắt buộc cho AI Coding Agent
1. Trước khi code một task, luôn đọc: `docs/ai-specs/01-database-schema.sql`, `02-openapi-contracts.yaml`, và `03-business-logic-and-edge-cases.md`.
2. Đề xuất danh sách file sẽ tạo/sửa trước khi viết code.
3. Đọc thêm `06-backend-platform-architecture.md`, `07-domain-data-and-api-requirements.md`, `08-delivery-and-acceptance.md` khi làm backend/hạ tầng.
4. Sau khi viết code, BẮT BUỘC chạy typecheck và kiểm tra pass toàn bộ test liên quan trong `docs/ai-specs/04-golden-test-cases.json`.

## 5. Các ràng buộc nền tảng bổ sung
- Ghi business state + audit + outbox trong cùng tenant transaction. Consumer có inbox/dedup; không giả định exactly-once qua PostgreSQL/Kafka/Temporal/ngân hàng.
- Hợp đồng, EOB và model/prompt/rule phải có phiên bản. OTP và phê duyệt gắn EOB version/hash; EOB thay đổi làm vô hiệu xác nhận cũ.
- Hạn mức, phân bổ hóa đơn, số dư và payment intent phải được bảo vệ khi xử lý đồng thời. Timeout ngân hàng chuyển UNKNOWN để đối soát, không chi trả lại mù.
- Kafka, Temporal history, Elasticsearch và telemetry chỉ chứa dữ liệu tối thiểu; không chứa PII/chứng từ thô. Backend kiểm soát tenant trên mọi đường truy cập.
- Lưu chứng từ gốc bất biến; AI chỉ đề xuất có bằng chứng. STP chạy shadow trước khi bật theo tenant/plan; sửa danh mục cần duyệt.
- Secrets production qua secret manager/KMS; TLS, NetworkPolicy, backup/PITR, restore drill, metrics/tracing và CI/CD là điều kiện nghiệm thu production.
