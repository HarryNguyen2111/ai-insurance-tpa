import { createHash } from 'node:crypto';
import { D, type Money, WaterfallInputError, ZERO, formatMoney, minMoney, parseMoney, parsePercent, roundVnd } from './money.ts';
import type {
  AiFlag, LineDecision, LineReduction, LineStatus, ReviewReason, StpAssessment, StpBlocker, Totals,
  WaterfallInput, WaterfallLine, WaterfallResult,
} from './types.ts';

export const WATERFALL_ENGINE_VERSION = 'ben-02.waterfall/1.0.0';

const BENEFIT_TYPES = ['OUTPATIENT', 'INPATIENT', 'DENTAL', 'MATERNITY', 'ACCIDENT', 'HOSPITAL_INCOME'];
const STP_BENEFIT_TYPES = ['OUTPATIENT', 'DENTAL'];
/** Spec 03 step 2: excluded categories (both carry the TPCN_EXCLUDED flag). */
const EXCLUDED_CATEGORIES = ['SUPPLEMENT_TPCN', 'COSMETIC'];
const PRICE_ANOMALY_FACTOR = new D('1.30');
const STP_FRAUD_THRESHOLD = 20;
const MODES = ['SHADOW', 'ENABLED', 'DISABLED'];
const HASH = /^[0-9a-f]{64}$/;

function count(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new WaterfallInputError(field);
  return value as number;
}
function flag(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new WaterfallInputError(field);
  return value;
}
const present = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter(k => record[k] !== undefined).sort()
    .map(k => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`;
}
const sha256 = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

interface ParsedLine { line: WaterfallLine; requested: Money; signals: AiFlag[]; excluded: boolean }

function parseLines(lines: unknown): ParsedLine[] {
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 500) throw new WaterfallInputError('lines');
  const ids = new Set<string>();
  return lines.map((line: WaterfallLine, index) => {
    const at = `lines[${index}]`;
    if (!line || typeof line !== 'object' || !present(line.lineId) || ids.has(line.lineId)) throw new WaterfallInputError(`${at}.lineId`);
    ids.add(line.lineId);
    if (!present(line.category)) throw new WaterfallInputError(`${at}.category`);
    const unit = parseMoney(line.unitPrice, `${at}.unitPrice`);
    const requested = parseMoney(line.requestedAmount, `${at}.requestedAmount`);
    const signals: AiFlag[] = [];
    const excluded = EXCLUDED_CATEGORIES.includes(line.category);
    if (excluded) signals.push('TPCN_EXCLUDED');
    if (line.icdMismatch !== undefined && flag(line.icdMismatch, `${at}.icdMismatch`)) signals.push('ICD_MISMATCH');
    if (line.referenceUnitPrice !== undefined) {
      const reference = parseMoney(line.referenceUnitPrice, `${at}.referenceUnitPrice`);
      if (unit.greaterThan(reference.times(PRICE_ANOMALY_FACTOR))) signals.push('PRICE_ANOMALY');
    }
    return { line, requested, signals, excluded };
  });
}

/** DB ai_flag holds one value; exclusion dominates, then ICD, then price. */
function primaryFlag(signals: AiFlag[]): AiFlag {
  for (const f of ['TPCN_EXCLUDED', 'ICD_MISMATCH', 'PRICE_ANOMALY'] as const) if (signals.includes(f)) return f;
  return 'NONE';
}

const STEP_VI: Record<LineReduction['step'], string> = {
  EXCLUSION: 'Loại trừ theo hợp đồng',
  PROVIDER_BLACKLIST: 'Cơ sở y tế thuộc danh sách loại trừ',
  DEDUCTIBLE: 'Mức khấu trừ',
  COPAY: 'Đồng chi trả',
  VISIT_LIMIT: 'Vượt hạn mức mỗi lần khám',
  ANNUAL_LIMIT: 'Vượt hạn mức năm',
};

function explain(status: LineStatus, approved: string, reductions: LineReduction[], clause: string | null): string {
  if (status === 'PENDING_REVIEW') return 'Chưa có điều khoản loại trừ được phê duyệt; chuyển chuyên viên xem xét, không tự từ chối.';
  const parts = reductions.map(r => `${STEP_VI[r.step]}: giảm ${r.amount} VNĐ`);
  const head = status === 'APPROVED' ? `Chấp thuận toàn bộ ${approved} VNĐ` : `Chấp thuận ${approved} VNĐ`;
  return `${[head, ...parts].join('; ')}.${clause ? ` Căn cứ: ${clause}.` : ''}`;
}

function statusOf(approved: Money, requested: Money): LineStatus {
  if (approved.equals(requested)) return 'APPROVED';
  return approved.isZero() ? 'REJECTED' : 'PARTIAL';
}

function decision(p: ParsedLine, approved: Money, pending: Money, reductions: LineReduction[]): LineDecision {
  const status: LineStatus = pending.isZero() ? statusOf(approved, p.requested) : 'PENDING_REVIEW';
  const rejected = p.requested.minus(approved).minus(pending);
  // Every reduction carries its own clause; the line cites the first (dominant) one.
  const clause = reductions[0]?.contractClauseCited ?? null;
  const approvedText = formatMoney(approved);
  return {
    lineId: p.line.lineId, requested: formatMoney(p.requested), approved: approvedText, rejected: formatMoney(rejected),
    pendingReview: formatMoney(pending), status, aiFlag: primaryFlag(p.signals), signals: [...p.signals], reductions,
    contractClauseCited: clause, explanationVi: explain(status, approvedText, reductions, clause),
  };
}

/** Pure, deterministic Smart Reimbursement waterfall (spec 03 §2). Lines are
 * processed in the given invoice order; deductible and limits are consumed in
 * that order. Missing eligibility data or clauses route review instead of
 * inferring a rejection. Never performs I/O or reads the clock. */
export function calculateWaterfallEOB(input: WaterfallInput): WaterfallResult {
  if (!input || typeof input !== 'object') throw new WaterfallInputError('input');
  if (!BENEFIT_TYPES.includes(input.benefitType)) throw new WaterfallInputError('benefitType');
  const taxVerified = flag(input.taxVerifiedValid, 'taxVerifiedValid');
  const merged = flag(input.isMergedSummary, 'isMergedSummary');
  const chronic = flag(input.isChronicSpecial, 'isChronicSpecial');
  const fraud = count(input.fraudRiskScore, 'fraudRiskScore');
  const daysActive = count(input.daysActive, 'daysActive');
  const rule = input.rule;
  if (!rule || typeof rule !== 'object') throw new WaterfallInputError('rule');
  const ref = rule.ruleVersion;
  if (!ref || !present(ref.id) || !Number.isSafeInteger(ref.version) || ref.version < 1 || !HASH.test(ref.hash)) throw new WaterfallInputError('rule.ruleVersion');
  const annualLimit = parseMoney(rule.annualLimit, 'rule.annualLimit');
  const perVisit = rule.perVisitLimit === null ? null : parseMoney(rule.perVisitLimit, 'rule.perVisitLimit');
  const pct = parsePercent(rule.copayInsurerPct, 'rule.copayInsurerPct');
  const deductible = parseMoney(rule.deductiblePerClaim, 'rule.deductiblePerClaim');
  const stpLimit = parseMoney(rule.stpAutoApproveLimit, 'rule.stpAutoApproveLimit');
  const waitingNormal = count(rule.waitingDaysNormal, 'rule.waitingDaysNormal');
  const waitingSpecial = rule.waitingDaysSpecial === undefined ? undefined : count(rule.waitingDaysSpecial, 'rule.waitingDaysSpecial');
  if (!MODES.includes(rule.stpExecutionMode)) throw new WaterfallInputError('rule.stpExecutionMode');
  const used = parseMoney(input.usedAnnualAmount, 'usedAnnualAmount');
  const provider = input.provider;
  if (provider !== undefined && !['DIRECT_BILLING', 'REIMBURSEMENT_ONLY', 'BLACKLISTED'].includes(provider?.policyStatus)) throw new WaterfallInputError('provider');
  const lines = parseLines(input.lines);
  const totalRequested = lines.reduce((sum, l) => sum.plus(l.requested), ZERO);

  // Step 1: eligibility gate. Premium/effective dates are resolved by BEN-01 selection.
  const reasons: ReviewReason[] = [];
  const ruleClause = present(rule.contractClauseCited) ? rule.contractClauseCited : null;
  if (!ruleClause) reasons.push('MISSING_RULE_CLAUSE');
  if (input.benefitType === 'HOSPITAL_INCOME') reasons.push('UNSUPPORTED_BENEFIT_CALCULATION');
  if (daysActive < waitingNormal) reasons.push('WAITING_PERIOD_NORMAL_NOT_MET');
  if (chronic && waitingSpecial === undefined) reasons.push('MISSING_WAITING_DAYS_SPECIAL');
  if (chronic && waitingSpecial !== undefined && daysActive < waitingSpecial) reasons.push('WAITING_PERIOD_SPECIAL_NOT_MET');
  if (used.greaterThan(annualLimit)) reasons.push('USED_ANNUAL_EXCEEDS_LIMIT');
  const blacklisted = provider?.policyStatus === 'BLACKLISTED';
  const providerClause = blacklisted && present(provider?.exclusionClauseRef) ? provider.exclusionClauseRef : null;
  if (blacklisted) reasons.push(providerClause ? 'PROVIDER_BLACKLISTED' : 'MISSING_PROVIDER_EXCLUSION_CLAUSE');

  let calculation: WaterfallResult['calculation'] = null;
  let decisions: LineDecision[] = [];
  const gateBlocked = reasons.some(r => r !== 'PROVIDER_BLACKLISTED');
  if (!gateBlocked && providerClause) {
    // Whole claim proposed REJECTED with the provider exclusion clause; still human-reviewed.
    decisions = lines.map(p => decision(p, ZERO, ZERO,
      [{ step: 'PROVIDER_BLACKLIST', amount: formatMoney(p.requested), contractClauseCited: providerClause }]));
  } else if (!gateBlocked && ruleClause) {
    let remainingDeductible = deductible;
    let remainingVisit = perVisit;
    let remainingAnnual = annualLimit.minus(used);
    decisions = lines.map(p => {
      // Step 2: line filter.
      if (p.excluded) {
        if (!present(p.line.exclusionClauseCited)) {
          if (!reasons.includes('MISSING_EXCLUSION_CLAUSE')) reasons.push('MISSING_EXCLUSION_CLAUSE');
          return decision(p, ZERO, p.requested, []);
        }
        return decision(p, ZERO, ZERO, [{ step: 'EXCLUSION', amount: formatMoney(p.requested), contractClauseCited: p.line.exclusionClauseCited }]);
      }
      // Step 3: deductible -> copay (ROUND_HALF_UP to VND) -> visit cap -> annual cap.
      const reductions: LineReduction[] = [];
      const cut = (step: LineReduction['step'], amount: Money) => {
        if (amount.greaterThan(0)) reductions.push({ step, amount: formatMoney(amount), contractClauseCited: ruleClause });
      };
      const deducted = minMoney(p.requested, remainingDeductible);
      remainingDeductible = remainingDeductible.minus(deducted);
      const afterDeductible = p.requested.minus(deducted);
      cut('DEDUCTIBLE', deducted);
      // Rounding to whole VND must never approve more than was claimed (e.g. 100% of 12345.56).
      const afterCopay = minMoney(roundVnd(afterDeductible.times(pct).dividedBy(100)), afterDeductible);
      cut('COPAY', afterDeductible.minus(afterCopay));
      let amount = afterCopay;
      if (remainingVisit !== null) {
        const capped = minMoney(amount, remainingVisit);
        cut('VISIT_LIMIT', amount.minus(capped));
        amount = capped;
        remainingVisit = remainingVisit.minus(amount);
      }
      const approved = minMoney(amount, remainingAnnual);
      cut('ANNUAL_LIMIT', amount.minus(approved));
      remainingAnnual = remainingAnnual.minus(approved);
      return decision(p, approved, ZERO, reductions);
    });
  }
  if (decisions.length) {
    const sum = (pick: (d: LineDecision) => string) => decisions.reduce((s, d) => s.plus(pick(d)), ZERO);
    const approved = sum(d => d.approved);
    const totals: Totals = {
      totalRequested: formatMoney(totalRequested), totalApproved: formatMoney(approved),
      totalRejected: formatMoney(sum(d => d.rejected)), totalPendingReview: formatMoney(sum(d => d.pendingReview)),
      remainingAnnualLimitAfter: formatMoney(annualLimit.minus(used).minus(approved)),
    };
    calculation = { totals, lines: decisions };
  }

  // Step 4: the five GREEN_STP gates (eligibility only).
  const blockers: StpBlocker[] = [];
  const add = (condition: boolean, blocker: StpBlocker) => { if (condition) blockers.push(blocker); };
  add(!STP_BENEFIT_TYPES.includes(input.benefitType), 'BENEFIT_TYPE');
  add(totalRequested.greaterThan(stpLimit), 'OVER_AUTO_APPROVE_LIMIT');
  add(!taxVerified, 'TAX_NOT_VERIFIED');
  add(merged, 'MERGED_SUMMARY');
  add(fraud >= STP_FRAUD_THRESHOLD, 'FRAUD_SCORE');
  add(lines.some(l => l.signals.length > 0), 'LINE_FLAGGED');
  add(decisions.some(d => d.status === 'REJECTED'), 'LINE_REJECTED');
  add(decisions.some(d => d.status === 'PENDING_REVIEW'), 'LINE_PENDING_REVIEW');
  add(decisions.some(d => d.reductions.some(r => r.step === 'VISIT_LIMIT' || r.step === 'ANNUAL_LIMIT')), 'LIMIT_CAPPED');
  add(chronic, 'CHRONIC_SPECIAL');
  add(daysActive < waitingNormal, 'WAITING_PERIOD_NORMAL');
  add(reasons.length > 0 || calculation === null, 'ELIGIBILITY_REVIEW');
  const eligible = blockers.length === 0;
  const stp: StpAssessment = {
    eligible, blockers, executionMode: rule.stpExecutionMode,
    humanApprovalRequired: !(eligible && rule.stpExecutionMode === 'ENABLED'),
  };
  const body = {
    engineVersion: WATERFALL_ENGINE_VERSION, ruleVersion: { id: ref.id, version: ref.version, hash: ref.hash },
    calculation, reviewReasons: reasons, triageLane: eligible ? 'GREEN_STP' as const : 'YELLOW_REVIEW' as const, stp,
    inputHash: sha256(input),
  };
  return { ...body, outputHash: sha256(body) };
}
