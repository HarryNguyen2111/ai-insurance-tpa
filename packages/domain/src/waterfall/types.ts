/** BEN-02 waterfall input/output contracts. Money is always a NUMERIC(15,2)
 * string ("720000.00"); counters (days, fraud score) are safe integers. */

export type BenefitType = 'OUTPATIENT' | 'INPATIENT' | 'DENTAL' | 'MATERNITY' | 'ACCIDENT' | 'HOSPITAL_INCOME';
export type StpExecutionMode = 'SHADOW' | 'ENABLED' | 'DISABLED';
export type LineCategory = 'CONSULTATION' | 'DRUG' | 'LAB_TEST' | 'SUPPLEMENT_TPCN' | 'COSMETIC' | (string & {});
export type AiFlag = 'NONE' | 'TPCN_EXCLUDED' | 'PRICE_ANOMALY' | 'ICD_MISMATCH';
export type LineStatus = 'APPROVED' | 'PARTIAL' | 'REJECTED' | 'PENDING_REVIEW';
export type TriageLane = 'GREEN_STP' | 'YELLOW_REVIEW';
export type ReductionStep = 'EXCLUSION' | 'PROVIDER_BLACKLIST' | 'DEDUCTIBLE' | 'COPAY' | 'VISIT_LIMIT' | 'ANNUAL_LIMIT';

/** Immutable approved rule version reference (BEN-01 #32 `VersionRef`). */
export interface RuleVersionRef { id: string; version: number; hash: string }

/** Approved rule terms copied from an immutable BEN-01 rule version. No defaults are
 * inferred: every value must come from the approved configuration snapshot. */
export interface WaterfallRule {
  ruleVersion: RuleVersionRef;
  annualLimit: string;
  /** `null` only when the approved rule explicitly has no per-visit limit. */
  perVisitLimit: string | null;
  copayInsurerPct: string;
  deductiblePerClaim: string;
  waitingDaysNormal: number;
  /** Required whenever the diagnosis is chronic/special; missing -> review. */
  waitingDaysSpecial?: number;
  stpAutoApproveLimit: string;
  /** Rule clause cited for deductible/copay/limit reductions. Missing -> review. */
  contractClauseCited: string;
  stpExecutionMode: StpExecutionMode;
}

export interface WaterfallLine {
  lineId: string;
  rawItemName: string;
  category: LineCategory;
  unitPrice: string;
  referenceUnitPrice?: string;
  requestedAmount: string;
  /** Exclusion clause from benefit_rules/medical_catalog for excluded categories. */
  exclusionClauseCited?: string;
  /** Evidence-backed AI signal; it only blocks STP and never rejects a line. */
  icdMismatch?: boolean;
}

export interface ProviderPolicy {
  policyStatus: 'DIRECT_BILLING' | 'REIMBURSEMENT_ONLY' | 'BLACKLISTED';
  exclusionClauseRef?: string;
}

export interface WaterfallInput {
  benefitType: BenefitType;
  /** e_invoice.tax_lookup_status === 'VERIFIED_VALID' (source verified, not parse success). */
  taxVerifiedValid: boolean;
  isMergedSummary: boolean;
  fraudRiskScore: number;
  daysActive: number;
  isChronicSpecial: boolean;
  rule: WaterfallRule;
  /** Benefit account state read under the reservation lock by the caller. */
  usedAnnualAmount: string;
  provider?: ProviderPolicy;
  lines: WaterfallLine[];
}

export interface LineReduction { step: ReductionStep; amount: string; contractClauseCited: string }

export interface LineDecision {
  lineId: string;
  requested: string;
  approved: string;
  rejected: string;
  pendingReview: string;
  status: LineStatus;
  aiFlag: AiFlag;
  signals: AiFlag[];
  reductions: LineReduction[];
  contractClauseCited: string | null;
  explanationVi: string;
}

export type ReviewReason =
  | 'MISSING_RULE_CLAUSE' | 'MISSING_EXCLUSION_CLAUSE' | 'MISSING_PROVIDER_EXCLUSION_CLAUSE'
  | 'MISSING_WAITING_DAYS_SPECIAL' | 'WAITING_PERIOD_NORMAL_NOT_MET' | 'WAITING_PERIOD_SPECIAL_NOT_MET'
  | 'USED_ANNUAL_EXCEEDS_LIMIT' | 'UNSUPPORTED_BENEFIT_CALCULATION' | 'PROVIDER_BLACKLISTED';

export type StpBlocker =
  | 'BENEFIT_TYPE' | 'OVER_AUTO_APPROVE_LIMIT' | 'TAX_NOT_VERIFIED' | 'MERGED_SUMMARY' | 'FRAUD_SCORE'
  | 'LINE_FLAGGED' | 'LINE_REJECTED' | 'LINE_PENDING_REVIEW' | 'LIMIT_CAPPED' | 'CHRONIC_SPECIAL'
  | 'WAITING_PERIOD_NORMAL' | 'ELIGIBILITY_REVIEW';

export interface StpAssessment {
  /** Eligibility only: the 5 GREEN_STP gates. Separate from execution. */
  eligible: boolean;
  blockers: StpBlocker[];
  executionMode: StpExecutionMode;
  /** True unless eligible AND tenant/plan mode is ENABLED. SHADOW still needs a person. */
  humanApprovalRequired: boolean;
}

export interface Totals {
  totalRequested: string;
  totalApproved: string;
  totalRejected: string;
  totalPendingReview: string;
  remainingAnnualLimitAfter: string;
}

export interface WaterfallResult {
  engineVersion: string;
  ruleVersion: RuleVersionRef;
  /** `null` when the eligibility gate routes review: no amount is inferred (TC06). */
  calculation: { totals: Totals; lines: LineDecision[] } | null;
  reviewReasons: ReviewReason[];
  triageLane: TriageLane;
  stp: StpAssessment;
  inputHash: string;
  outputHash: string;
}
