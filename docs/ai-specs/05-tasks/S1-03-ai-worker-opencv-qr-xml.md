# Task S1-03: Python AI Worker — Lọc mờ, Xóa dấu đỏ, Đọc QR/XML & Tiền kiểm NĐ 70
- **Tham chiếu:** `02-openapi-contracts.yaml`, `03-business-logic-and-edge-cases.md`
- **Mục tiêu:** Xây dựng `services/ai-worker` (FastAPI) xử lý ảnh hóa đơn/toa thuốc từ S3/MinIO.
- **Yêu cầu chi tiết:**
  - `check_image_quality()`: OpenCV Laplacian Variance < 65 trả lỗi ảnh mờ.
  - `suppress_red_stamp()`: Làm mờ kênh màu đỏ trên ảnh bảng kê trước khi gửi OCR.
  - `decode_qr_and_fetch_xml()`: `pyzbar` quét QR -> nếu là URL MISA/VNPT/Viettel thì tải & parse XML (`lxml`). Đánh dấu `is_merged_summary=True` nếu XML chỉ có 1 dòng tổng.
  - Adapter gọi VLM nội địa (Viettel AI `Qwen3-VL` qua HTTP, có Mock mode khi chưa có API key) để bóc tách 6 trường hóa đơn & các dòng thuốc.
  - Kiểm tra NĐ 70 (`buyer_name`/`buyer_mst` công ty) -> trả cảnh báo theo schema `/v1/claims/preflight-check`.
- **Tiêu chí nghiệm thu (DoD):**
  - `pytest` pass cho case ảnh mờ, QR hợp lệ, XML gộp, và `TC04_PREFLIGHT_ND70_COMPANY_ADDRESS` trong `04-golden-test-cases.json`.

## Yêu cầu kiến trúc bổ sung
Đọc và áp dụng `06-backend-platform-architecture.md`, `07-domain-data-and-api-requirements.md`, `08-delivery-and-acceptance.md` trong thư mục ai-specs. Các tài liệu này thay thế giả định cũ về BullMQ, tự động cập nhật danh mục và readiness production. Những kiểm tra liên quan trong `09-platform-acceptance-cases.json` là DoD bổ sung, không thay thế golden TC01–TC06.

- Bổ sung DoD: chống SSRF/XXE, giới hạn file/redirect, bản gốc không bị ghi đè; parse XML không đồng nghĩa verified tax; field evidence/model version và kiểm tra PII redaction.
