# Task S3-02: Zalo Mini App — Smart FNOL, AI Tiền kiểm 3s, Tracker & Explainable EOB
- **Tham chiếu:** `02-openapi-contracts.yaml`, `AGENTS.md`
- **Mục tiêu:** Build giao diện `apps/zalo-miniapp` gọn nhẹ (<4MB) chạy mượt luồng khách hàng.
- **Yêu cầu chi tiết:**
  - Màn hình Onboarding Consent (Luật 91/2025) & Dynamic E-card (QR đổi mỗi 60s).
  - Màn hình Smart FNOL: Chọn camera/quét QR, xử lý fallback khi user từ chối quyền Camera (hiện hướng dẫn 3 bước), hỗ trợ upload `.heic` iOS & ảnh VNeID.
  - Popup AI Tiền kiểm (3s) hiển thị cảnh báo NĐ 70 / thiếu dấu / quá 5 ngày.
  - Màn hình Claim Tracker mở (cho bổ sung chứng từ trước khi khóa) & Bảng Explainable EOB (Xanh/Vàng/Đỏ) + Ký OTP.
- **Tiêu chí nghiệm thu (DoD):**
  - Bundle size build `< 4MB`. Chạy trơn tru toàn bộ luồng Demo 60s với Backend local.

## Yêu cầu kiến trúc bổ sung
Đọc và áp dụng `06-backend-platform-architecture.md`, `07-domain-data-and-api-requirements.md`, `08-delivery-and-acceptance.md` trong thư mục ai-specs. Các tài liệu này thay thế giả định cũ về BullMQ, tự động cập nhật danh mục và readiness production. Những kiểm tra liên quan trong `09-platform-acceptance-cases.json` là DoD bổ sung, không thay thế golden TC01–TC06.
