import { IdentityError, type IdentityCode } from '../identity-tenant/identity-error.ts';

/** Fixed Vietnamese messages; never echo submitted labels, values or identities. */
const MESSAGES = {
  STALE_VERSION: 'Phiên bản quy trình đã thay đổi, vui lòng tải lại.',
  DRAFT_EXISTS: 'Quy trình này đã có một bản nháp đang mở.',
  NOT_DRAFT: 'Chỉ bản nháp mới được chỉnh sửa hoặc phát hành.',
  INVALID_DEFINITION: 'Định nghĩa quy trình không hợp lệ; xem báo cáo kiểm tra.',
  AMBIGUOUS_BINDING: 'Loại quyền lợi đã được một quy trình khác phục vụ.',
  MAKER_CHECKER: 'Người phát hành phải khác người tạo hoặc sửa bản nháp.',
  VALIDATION_FAILED: 'Yêu cầu không hợp lệ.',
  NO_PUBLISHED_WORKFLOW: 'Không có quy trình đã phát hành cho phạm vi này.',
} as const;
export type WorkflowErrorReason = keyof typeof MESSAGES;

/** Subclass of the shared identity error so the tenant transaction rolls back and the C1 filter renders it. */
export class WorkflowApiError extends IdentityError {
  constructor(status: 403 | 404 | 409 | 422, code: IdentityCode, reason?: WorkflowErrorReason) {
    super(status, code);
    if (reason) this.message = MESSAGES[reason];
  }
}
export const stale = (reason: WorkflowErrorReason = 'STALE_VERSION') => new WorkflowApiError(409, 'STALE_VERSION', reason);
export const domain = (reason: WorkflowErrorReason) => new WorkflowApiError(422, 'DOMAIN_VIOLATION', reason);
export const invalidRequest = () => new WorkflowApiError(422, 'VALIDATION_FAILED', 'VALIDATION_FAILED');
export const hidden = () => new WorkflowApiError(404, 'NOT_FOUND');
export const forbidden = (reason?: WorkflowErrorReason) => new WorkflowApiError(403, 'FORBIDDEN', reason);
