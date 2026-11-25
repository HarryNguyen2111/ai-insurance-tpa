# Task S4-01: Split-Screen Medical Workbench & Cổng DNBH Pilot
- **Tham chiếu:** `02-openapi-contracts.yaml`, `03-business-logic-and-edge-cases.md`
- **Mục tiêu:** Xây dựng `apps/workbench` (Next.js) cho Bác sĩ duyệt 45–60s/ca và Cổng DNBH theo dõi Pilot.
- **Yêu cầu chi tiết:**
  - Giao diện **Split-Screen 50/50**: Trái (Lazy load ảnh Imgproxy `width=1200` + Zoom full-res + Bảng XML tô màu Vàng/Đỏ); Phải (Cây quyền lợi + Dropdown Lý do Contract-Locked + Phím tắt `A`/`R`/`Space`).
  - Tính năng **Active Learning**: Khi Bác sĩ gắn lại nhãn TPCN ở `PATCH .../lines/:lineId` có `updateMedicalCatalogAs`, tạo `catalog_change_proposals` có provenance; chỉ cập nhật `medical_catalog` sau khi reviewer có quyền phê duyệt.
  - Màn hình Cổng DNBH: Dual Approval cho ca >15tr, Tracking bản gốc `WAITING_ORIGINAL_DOCS` cho ca >=20tr, và Export CSV/Excel bảng kê thanh toán `T+1`/`T+3`.
- **Tiêu chí nghiệm thu (DoD):**
  - Bác sĩ bấm phím tắt duyệt xong 1 hồ sơ -> EOB trên Zalo Mini App cập nhật ngay + Audit Hash Log được ghi nhận.

## Yêu cầu kiến trúc bổ sung
Đọc và áp dụng `06-backend-platform-architecture.md`, `07-domain-data-and-api-requirements.md`, `08-delivery-and-acceptance.md` trong thư mục ai-specs. Các tài liệu này thay thế giả định cũ về BullMQ, tự động cập nhật danh mục và readiness production. Những kiểm tra liên quan trong `09-platform-acceptance-cases.json` là DoD bổ sung, không thay thế golden TC01–TC06.
