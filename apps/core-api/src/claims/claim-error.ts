import { IdentityError, type IdentityCode } from '../identity-tenant/identity-error.ts';

/** Fixed Vietnamese messages; never echo submitted values, documents or identities. */
const MESSAGES = {
  STALE_VERSION: 'Hồ sơ đã thay đổi, vui lòng tải lại và thử lại.',
  STALE_PREFLIGHT: 'Kết quả kiểm tra sơ bộ đã thay đổi, vui lòng kiểm tra lại.',
  CONSENT_REQUIRED: 'Cần đồng ý xử lý dữ liệu hiện hành trước khi nộp hồ sơ.',
  MEMBER_NOT_INSURED: 'Người được bảo hiểm chưa có quyền lợi được cấu hình.',
  PREFLIGHT_NOT_FOUND: 'Không tìm thấy kết quả kiểm tra sơ bộ hợp lệ.',
  DOCUMENT_NOT_ATTACHABLE: 'Chứng từ chưa sẵn sàng hoặc đã gắn với hồ sơ khác.',
  STATUS_NOT_ALLOWED: 'Trạng thái hồ sơ không cho phép thao tác này.',
  SUPPLEMENT_EXPIRED: 'Đã quá hạn bổ sung chứng từ.',
  TRANSITION_NOT_ALLOWED: 'Chuyển trạng thái hồ sơ không hợp lệ.',
  GATE_REQUIRED: 'Chuyển trạng thái cần bằng chứng từ phân hệ chuyên trách.',
  INVALID_AMOUNT: 'Số tiền yêu cầu không hợp lệ.',
  INVALID_CURSOR: 'Con trỏ phân trang không hợp lệ.',
  VALIDATION_FAILED: 'Yêu cầu không hợp lệ.',
  PREFLIGHT_NOT_CONFIGURED: 'Dịch vụ kiểm tra sơ bộ chưa được cấu hình.',
  DEPENDENCY_UNAVAILABLE: 'Dịch vụ hồ sơ tạm thời không sẵn sàng.',
} as const;
export type ClaimErrorReason = keyof typeof MESSAGES;

/** Subclass of the shared C1 error: rolls back the tenant transaction and is rendered by IdentityExceptionFilter. */
export class ClaimApiError extends IdentityError {
  readonly reason?: ClaimErrorReason;
  constructor(status: 403 | 404 | 409 | 422 | 503, code: IdentityCode, reason?: ClaimErrorReason) {
    super(status, code);
    if (reason) { this.message = MESSAGES[reason]; this.reason = reason; }
  }
}
export const hidden = () => new ClaimApiError(404, 'NOT_FOUND');
export const stale = (reason: ClaimErrorReason = 'STALE_VERSION') => new ClaimApiError(409, 'STALE_VERSION', reason);
export const domain = (reason: ClaimErrorReason) => new ClaimApiError(422, 'DOMAIN_VIOLATION', reason);
export const invalid = (reason: ClaimErrorReason = 'VALIDATION_FAILED') => new ClaimApiError(422, 'VALIDATION_FAILED', reason);
export const conflict = () => new ClaimApiError(409, 'IDEMPOTENCY_CONFLICT');
export const inProgress = () => new ClaimApiError(409, 'OPERATION_IN_PROGRESS');
export const notConfigured = () => new ClaimApiError(503, 'PROVIDER_NOT_CONFIGURED', 'PREFLIGHT_NOT_CONFIGURED');
export const unavailable = () => new ClaimApiError(503, 'DEPENDENCY_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE');
