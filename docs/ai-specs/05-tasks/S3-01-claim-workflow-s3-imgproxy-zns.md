# Task S3-01: Claim Workflow API, Pre-signed S3, Imgproxy HEIC & Webhook HMAC
- **Tham chiếu:** `02-openapi-contracts.yaml`, `03-business-logic-and-edge-cases.md`
- **Mục tiêu:** Nối hoàn chỉnh `claim-workflow` giữa Frontend, S3/Imgproxy, Temporal Workflow + Kafka domain events và Python AI Worker.
- **Yêu cầu chi tiết:**
  - Implement các endpoint `/v1/claims/upload-url`, `/v1/claims/preflight-check`, `/v1/claims` (kiểm tra `Idempotency-Key`), `/v1/claims/:id/eob`, và `/internal/v1/webhooks/ai-result` (xác thực `X-Signature-HMAC`).
  - Sinh URL Imgproxy tự động convert `.heic` -> `.webp` với `width=1200` cho màn hình xem trước Workbench và gắn watermark động.
  - Viết `INotificationService` mock gửi Zalo ZBS/ZNS và `IWorkflowEngine` chạy trên Temporal (SLA durable timers); transaction ghi outbox, Kafka consumer dedup và Elasticsearch projection theo đặc tả 06–08.
- **Tiêu chí nghiệm thu (DoD):**
  - Test E2E API: Gọi upload-url -> preflight -> submit claim 2 lần cùng `Idempotency-Key` chỉ tạo 1 claim -> nhận webhook AI -> lấy `/eob` khớp chuẩn OpenAPI.

## Yêu cầu kiến trúc bổ sung
Đọc và áp dụng `06-backend-platform-architecture.md`, `07-domain-data-and-api-requirements.md`, `08-delivery-and-acceptance.md` trong thư mục ai-specs. Các tài liệu này thay thế giả định cũ về BullMQ, tự động cập nhật danh mục và readiness production. Những kiểm tra liên quan trong `09-platform-acceptance-cases.json` là DoD bổ sung, không thay thế golden TC01–TC06.
