# Task S1-01: Khởi tạo Monorepo & Docker Infrastructure
- **Tham chiếu:** `AGENTS.md`, `docs/ai-specs/01-database-schema.sql`
- **Mục tiêu:** Dựng cấu trúc `pnpm` + `Turborepo` và môi trường full-stack dev trong 1 lệnh; Kubernetes/Helm staging là deliverable ngay từ nền tảng, cùng task P1-01.
- **Files cần tạo:**
  - `package.json`, `pnpm-workspace.yaml`, `turbo.json`
  - `infra/docker-compose.yml` (PostgreSQL `pgvector/pgvector:pg16`, `redis:7-alpine`, `minio/minio`, `darthsim/imgproxy`, Temporal, Kafka KRaft + Schema Registry, Elasticsearch; pin version sau compatibility spike)
  - `infra/migrations/001_init_schema.sql` (baseline từ `01-database-schema.sql`, bổ sung migration theo 07; không coi copy baseline là đủ production)
  - Khung rỗng cho `apps/core-api` (NestJS), `apps/workbench` (Next.js), `apps/zalo-miniapp`, `services/ai-worker` (FastAPI), `packages/shared-contracts`.
- **Tiêu chí nghiệm thu (DoD):**
  - Chạy `docker compose up -d` thành công, không lỗi migration SQL.
  - Xác nhận PostgreSQL đã bật `pgvector`, `pg_trgm`, `pgcrypto` và trigger `trg_audit_immutable` hoạt động (thử `UPDATE audit_logs` phải báo lỗi).

## Yêu cầu kiến trúc bổ sung
Đọc và áp dụng `06-backend-platform-architecture.md`, `07-domain-data-and-api-requirements.md`, `08-delivery-and-acceptance.md` trong thư mục ai-specs. Các tài liệu này thay thế giả định cũ về BullMQ, tự động cập nhật danh mục và readiness production. Những kiểm tra liên quan trong `09-platform-acceptance-cases.json` là DoD bổ sung, không thay thế golden TC01–TC06.
