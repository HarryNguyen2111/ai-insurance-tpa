# Task S2-02: Phân loại Thuốc vs Thực phẩm chức năng & Chống trùng Hóa đơn
- **Tham chiếu:** `01-database-schema.sql`, `03-business-logic-and-edge-cases.md`
- **Mục tiêu:** Hoàn thiện `svc-medical-antifraud` tách Thuốc điều trị khỏi TPCN/Mỹ phẩm và chặn nộp trùng hóa đơn.
- **Yêu cầu chi tiết:**
  - Seed script nạp bảng `icd10_codes` mẫu (gồm cả nhóm `is_chronic_special=true`) và `medical_catalog` mẫu.
  - Fuzzy matching bằng PostgreSQL `pg_trgm` (`similarity(item_name_norm, ...)`) kết hợp LLM fallback cho tên thuốc biến thể.
  - Tính `invoice_unique_hash = SHA256(MST|Serial|Number)` và kiểm tra qua bảng `invoice_claim_allocations` (chặn nộp trùng, chỉ cho phép nếu hợp lệ Đồng bảo hiểm <= 100%).
- **Tiêu chí nghiệm thu (DoD):**
  - Test chứng minh nhận diện đúng `TPCN` và chặn được 1 hóa đơn nộp 2 lần khi không có chứng từ đồng bảo hiểm.

## Yêu cầu kiến trúc bổ sung
Đọc và áp dụng `06-backend-platform-architecture.md`, `07-domain-data-and-api-requirements.md`, `08-delivery-and-acceptance.md` trong thư mục ai-specs. Các tài liệu này thay thế giả định cũ về BullMQ, tự động cập nhật danh mục và readiness production. Những kiểm tra liên quan trong `09-platform-acceptance-cases.json` là DoD bổ sung, không thay thế golden TC01–TC06.
