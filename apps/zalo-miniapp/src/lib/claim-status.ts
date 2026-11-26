/** Customer-facing view of OpenAPI `ClaimStatus` (docs/ai-specs/03 §1). */
export const CLAIM_STATUSES = [
  'PREFLIGHT', 'SUBMITTED', 'AI_PROCESSING', 'GREEN_STP', 'DOCTOR_REVIEW', 'FRAUD_HOLD',
  'SUPPLEMENT_REQUIRED', 'WAITING_ORIGINAL_DOCS', 'EOB_READY', 'OTP_SIGNED', 'PAYOUT_PROCESSING',
  'PAID', 'REJECTED', 'CLOSED_EXPIRED',
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const TRACKER_STEPS = [
  'Đã nộp hồ sơ',
  'Đang thẩm định',
  'Có bảng giải trình',
  'Đã xác nhận',
  'Đã chi trả',
] as const;

type View = { labelVi: string; step: number; tone: 'info' | 'action' | 'success' | 'danger' | 'muted' };

/**
 * Internal triage states (GREEN_STP / DOCTOR_REVIEW / FRAUD_HOLD) are deliberately collapsed into a
 * neutral "đang thẩm định" so the customer UI never discloses fraud suspicion or review lanes.
 */
const VIEW: Record<ClaimStatus, View> = {
  PREFLIGHT: { labelVi: 'Đang kiểm tra chứng từ', step: 0, tone: 'info' },
  SUBMITTED: { labelVi: 'Đã nộp hồ sơ', step: 0, tone: 'info' },
  AI_PROCESSING: { labelVi: 'Đang thẩm định', step: 1, tone: 'info' },
  GREEN_STP: { labelVi: 'Đang thẩm định', step: 1, tone: 'info' },
  DOCTOR_REVIEW: { labelVi: 'Đang thẩm định', step: 1, tone: 'info' },
  FRAUD_HOLD: { labelVi: 'Đang thẩm định', step: 1, tone: 'info' },
  SUPPLEMENT_REQUIRED: { labelVi: 'Cần bổ sung chứng từ', step: 1, tone: 'action' },
  WAITING_ORIGINAL_DOCS: { labelVi: 'Chờ nhận bản gốc chứng từ', step: 1, tone: 'action' },
  EOB_READY: { labelVi: 'Chờ bạn xác nhận bảng giải trình', step: 2, tone: 'action' },
  OTP_SIGNED: { labelVi: 'Đã xác nhận', step: 3, tone: 'info' },
  PAYOUT_PROCESSING: { labelVi: 'Đang chi trả', step: 3, tone: 'info' },
  PAID: { labelVi: 'Đã chi trả', step: 4, tone: 'success' },
  REJECTED: { labelVi: 'Từ chối bồi thường', step: 2, tone: 'danger' },
  CLOSED_EXPIRED: { labelVi: 'Đã đóng do quá hạn bổ sung', step: 1, tone: 'muted' },
};

export function statusView(status: ClaimStatus): View {
  return VIEW[status];
}
