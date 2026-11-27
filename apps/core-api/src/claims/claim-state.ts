/** Spec 03 §1 claim state machine. Mirrored by tpa.claim_transition_allowed (0015); the PG suite asserts equality. */
export const CLAIM_STATUSES = ['PREFLIGHT', 'SUBMITTED', 'AI_PROCESSING', 'GREEN_STP', 'DOCTOR_REVIEW', 'FRAUD_HOLD',
  'SUPPLEMENT_REQUIRED', 'WAITING_ORIGINAL_DOCS', 'EOB_READY', 'OTP_SIGNED', 'PAYOUT_PROCESSING', 'PAID', 'REJECTED',
  'CLOSED_EXPIRED'] as const;
export type ClaimStatus = typeof CLAIM_STATUSES[number];

export const CLAIM_TRANSITIONS: Readonly<Record<ClaimStatus, readonly ClaimStatus[]>> = Object.freeze({
  PREFLIGHT: ['SUBMITTED'],
  SUBMITTED: ['AI_PROCESSING'],
  AI_PROCESSING: ['GREEN_STP', 'DOCTOR_REVIEW', 'FRAUD_HOLD', 'SUPPLEMENT_REQUIRED'],
  // STP stays SHADOW by default: GREEN_STP may still go to human review.
  GREEN_STP: ['EOB_READY', 'DOCTOR_REVIEW'],
  DOCTOR_REVIEW: ['EOB_READY', 'SUPPLEMENT_REQUIRED', 'FRAUD_HOLD', 'WAITING_ORIGINAL_DOCS', 'REJECTED'],
  FRAUD_HOLD: ['DOCTOR_REVIEW', 'REJECTED'],
  SUPPLEMENT_REQUIRED: ['SUBMITTED', 'CLOSED_EXPIRED'],
  WAITING_ORIGINAL_DOCS: ['DOCTOR_REVIEW', 'EOB_READY', 'PAYOUT_PROCESSING'],
  EOB_READY: ['OTP_SIGNED', 'DOCTOR_REVIEW'],
  // A re-published EOB invalidates the prior signature and needs a new one.
  OTP_SIGNED: ['PAYOUT_PROCESSING', 'WAITING_ORIGINAL_DOCS', 'EOB_READY'],
  PAYOUT_PROCESSING: ['PAID'],
  PAID: [], REJECTED: [], CLOSED_EXPIRED: [],
});

/**
 * Targets whose entry needs evidence owned by other modules (EOB version/hash #40, OTP signature #41,
 * payment gates/original receipt #43/#45, confirmed payout #45/#46). The generic CLM-02 transition refuses
 * them (fail closed) until the owning module supplies its gated entry point.
 * SUBMITTED is entered only through a member supplement (or initial submit), never a service command.
 */
export const GATED_TARGETS: ReadonlySet<ClaimStatus> = new Set<ClaimStatus>(['EOB_READY', 'OTP_SIGNED', 'PAYOUT_PROCESSING', 'PAID', 'SUBMITTED']);

export function isClaimStatus(value: unknown): value is ClaimStatus {
  return typeof value === 'string' && (CLAIM_STATUSES as readonly string[]).includes(value);
}
export function transitionAllowed(from: ClaimStatus, to: ClaimStatus): boolean {
  return CLAIM_TRANSITIONS[from].includes(to);
}
