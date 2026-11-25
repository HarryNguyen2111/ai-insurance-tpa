# Task S2-01: Waterfall EOB Calculator (`Decimal.js`) & Contract-Locked Rule Engine
- **Tham chiếu:** `AGENTS.md`, `03-business-logic-and-edge-cases.md`, `04-golden-test-cases.json`
- **Mục tiêu:** Code module `policy-benefit` trong `apps/core-api` tính toán quyền lợi chính xác 100% và chạy xanh toàn bộ Golden Test Cases.
- **Yêu cầu chi tiết:**
  - Implement pure function `calculateWaterfallEOB(...)` dùng `decimal.js` (cấm float).
  - Bắt buộc gắn `contract_clause_cited` cho mọi dòng từ chối/đồng chi trả.
  - Implement 5 điều kiện cổng `GREEN_STP` (bao gồm khóa STP nếu `is_merged_summary === true` hoặc `is_chronic_special && days_active < 365`).
- **Tiêu chí nghiệm thu (DoD):**
  - Viết Vitest/Jest runner đọc trực tiếp `docs/ai-specs/04-golden-test-cases.json` và PASS 100% các cases `TC01`, `TC02`, `TC03`, `TC05`, `TC06`.

## Yêu cầu kiến trúc bổ sung
Đọc và áp dụng `06-backend-platform-architecture.md`, `07-domain-data-and-api-requirements.md`, `08-delivery-and-acceptance.md` trong thư mục ai-specs. Các tài liệu này thay thế giả định cũ về BullMQ, tự động cập nhật danh mục và readiness production. Những kiểm tra liên quan trong `09-platform-acceptance-cases.json` là DoD bổ sung, không thay thế golden TC01–TC06.

- Bổ sung DoD: EOB/contract version và snapshot tái hiện được; hạn mức có reservation transaction chống race. TC03 cap bắt buộc review; TC06 không tự suy diễn số tiền. STP mặc định SHADOW.
