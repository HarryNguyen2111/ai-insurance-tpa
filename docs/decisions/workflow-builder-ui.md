# Quyết định UI: trình thiết kế quy trình dùng React Flow (#102)

Ngày: 2026-11-27 · Phạm vi: `apps/workbench` (`/quy-trinh`) · Thay thế phần **hiển thị/biên tập** của quyết định bpmn-js ở #79/PR98.

## Quyết định
- Canvas dùng upstream **`@xyflow/react` 13.0.3 (MIT)** cùng shadcn/Tailwind sẵn có. Chỉ dùng phần lõi miễn phí (canvas, `Background`, `Controls`, `MiniMap`, `Handle`); không dùng React Flow Pro/template trả phí, không ẩn attribution.
- `bpmn-js` bị gỡ khỏi workbench. **BPMN XML vẫn là định dạng trao đổi** (Nâng cao → Nhập/Xuất BPMN) qua bộ chuyển đổi DOM thuần `src/lib/workflow-bpmn.ts` (không phụ thuộc bpmn-js), có kiểm thử vòng canonical → BPMN → canonical và từ chối phần tử không hỗ trợ với mã lỗi rõ ràng.
- **Nguồn sự thật không đổi:** `WorkflowDefinitionContent` (spec 02/14) qua API #80 hiện có; bố cục chỉ lưu trên trình duyệt, gắn với định nghĩa + `contentHash`. Trạng thái React Flow không được lưu hay gửi đi. Temporal vẫn là runtime duy nhất; quyền, maker-checker, MFA, revision/hash, idempotency do máy chủ kiểm tra.

## Bố cục
Thanh công cụ gọn (tên, trạng thái/phiên bản, hoàn tác/làm lại, Kiểm tra, Xem trước, Lưu, Xuất bản + giải thích khi bị tắt) · thư viện bước có tìm kiếm theo nhóm (7 loại bước hợp đồng) + danh sách bước/nhánh có tìm kiếm (thay thế bằng bàn phím) · canvas chấm, pan/zoom/fit/minimap · bảng thuộc tính có kiểu (Responsible/Accountable/tác nhân AI tách biệt; trình tạo điều kiện biến/phép so sánh/giá trị) · ngăn dưới: Kiểm tra (lỗi theo bước + ô, bấm để tới đúng ô), Xem trước cấu trúc (không chạy), Nâng cao JSON/BPMN.

## Giới hạn đã biết
- Danh mục vai trò ứng viên là enum tĩnh của hợp đồng VWF-01; danh bạ nhóm (#21) chưa có. Mô hình/prompt/chính sách AI nhập mã thủ công (chưa có API danh mục); máy chủ kiểm tra `REFERENCE_NOT_PUBLISHED` khi xuất bản.
- Mẫu "Tiếp nhận → AI → người duyệt → bổ sung" cố ý để trống SLA, hạn bổ sung, bằng chứng và tham chiếu AI (đánh dấu lỗi) — không tự đặt mặc định chính sách.
- Bản nháp chưa hợp lệ theo schema có thể sửa trong trình duyệt nhưng không lưu được (cục bộ hoặc máy chủ trả 422) và không xuất bản được.
- Xem trước chỉ liệt kê đường đi theo cấu trúc; không mô phỏng Temporal, AI, hồ sơ hay chi trả.
