# Task S1-02: Drizzle ORM, RLS (`SET LOCAL`), Mã hóa PII & Audit Hash Chain
- **Tham chiếu:** `AGENTS.md`, `01-database-schema.sql`
- **Mục tiêu:** Xây dựng module `identity-tenant` và `audit-security` trong `apps/core-api` đảm bảo cô lập tuyệt đối dữ liệu giữa các DNBH.
- **Yêu cầu chi tiết:**
  - Viết helper `withTenantTransaction(tenantId, fn)` bắt buộc chạy `SELECT set_config('app.current_tenant_id', $1, true)` (tương đương `SET LOCAL`, an toàn với PgBouncer).
  - Viết `PiiCryptoService` dùng `AES-256-GCM` mã hóa/giải mã `cccd`, `phone`, `bank_account` và sinh `cccd_hash` (SHA-256).
  - Viết `AuditLogService.append(...)` tính `curr_hash = SHA256(prev_hash + entity_id + action + payload_diff + timestamp)` dùng canonical serialization có version theo đặc tả 07; lock `audit_chain_heads` theo entity/tenant kể cả lần ghi đầu, không chỉ lock dòng log cuối.
- **Tiêu chí nghiệm thu (DoD):**
  - Integration Test chứng minh: Tenant A không thể đọc được claim của Tenant B khi dùng `withTenantTransaction`.
  - Test chứng minh chuỗi Audit Hash liên kết đúng và không thể sửa đổi bằng SQL.

## Yêu cầu kiến trúc bổ sung
Đọc và áp dụng `06-backend-platform-architecture.md`, `07-domain-data-and-api-requirements.md`, `08-delivery-and-acceptance.md` trong thư mục ai-specs. Các tài liệu này thay thế giả định cũ về BullMQ, tự động cập nhật danh mục và readiness production. Những kiểm tra liên quan trong `09-platform-acceptance-cases.json` là DoD bổ sung, không thay thế golden TC01–TC06.
