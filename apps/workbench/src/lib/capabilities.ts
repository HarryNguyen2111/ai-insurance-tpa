// Truthful progress statement shown to the owner. Update only with merged, tested work.
export const LIVE_CAPABILITIES = [
  { title: 'Kết nối Web → Core API', detail: 'Route cùng origin gọi GET /health của NestJS core-api đã build (liveness tiến trình).' },
  { title: 'Khung workspace tiếng Việt', detail: 'Next.js App Router, điều hướng responsive, trạng thái lỗi/ngoại tuyến rõ ràng.' },
  { title: 'Xem trước biểu mẫu tiếp nhận', detail: 'Hiển thị cấu hình ví dụ tổng hợp từ spec 11; nháp chỉ trong bộ nhớ trang, không gửi đi.' },
] as const;

export const PENDING_CAPABILITIES = [
  { title: 'Đăng nhập OIDC & membership workspace', ref: '#21', detail: 'Chưa có danh tính; trang này không xác thực ai và không chọn tenant.' },
  { title: 'Tải chứng từ qua Pre-signed URL', ref: '#26', detail: 'Nút tải lên bị khóa cho tới khi có backend upload có phân quyền và quét file.' },
  { title: 'Tạo / nộp hồ sơ', ref: '#37 · F6', detail: 'Core API hiện trả 404 cho POST /v1/claims; giao diện không giả lập nộp thành công.' },
  { title: 'Trích xuất AI có bằng chứng', ref: '#30 · #31 · F7', detail: 'Chưa chạy AI; nhãn "AI có thể đề xuất" chỉ mô tả cấu hình.' },
  { title: 'Tính quyền lợi, EOB, OTP, chi trả', ref: '#32 · P2-01', detail: 'Không có số tiền duyệt hay ước tính chi trả trong bản xem trước.' },
  { title: 'Workbench duyệt & Cổng DNBH', ref: '#51 · #52', detail: 'Mục điều hướng đang khóa.' },
  { title: 'Nền tảng phụ thuộc', ref: 'compose dependency-smoke', detail: 'PostgreSQL, Redis, Kafka, Temporal, Elasticsearch, S3 được kiểm tra riêng; trang này không chứng minh chúng sẵn sàng.' },
] as const;
