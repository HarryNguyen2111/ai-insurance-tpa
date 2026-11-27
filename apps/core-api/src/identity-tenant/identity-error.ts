export type IdentityCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'VALIDATION_FAILED'
  | 'IDEMPOTENCY_CONFLICT' | 'OPERATION_IN_PROGRESS' | 'STALE_VERSION' | 'DEPENDENCY_UNAVAILABLE' | 'PROVIDER_NOT_CONFIGURED';
const messages: Record<IdentityCode, string> = {
  UNAUTHENTICATED: 'Danh tính không hợp lệ hoặc đã hết hạn.', FORBIDDEN: 'Bạn không có quyền hoặc mức xác thực cần thiết.',
  NOT_FOUND: 'Không tìm thấy đối tượng được phép truy cập.', VALIDATION_FAILED: 'Yêu cầu không hợp lệ.',
  IDEMPOTENCY_CONFLICT: 'Khóa yêu cầu đã được sử dụng; vui lòng dùng khóa mới.', OPERATION_IN_PROGRESS: 'Yêu cầu đang được xử lý.',
  STALE_VERSION: 'Quyền hoặc ngữ cảnh đã thay đổi; vui lòng chọn lại.', DEPENDENCY_UNAVAILABLE: 'Dịch vụ xác thực tạm thời không sẵn sàng.',
  PROVIDER_NOT_CONFIGURED: 'Nhà cung cấp danh tính chưa được cấu hình và nghiệm thu.',
};
export class IdentityError extends Error {
  readonly status: number;
  readonly code: IdentityCode;
  constructor(status: number, code: IdentityCode) { super(messages[code]); this.status = status; this.code = code; }
}
export const denied = () => new IdentityError(403, 'FORBIDDEN');
export const unavailable = () => new IdentityError(503, 'DEPENDENCY_UNAVAILABLE');
