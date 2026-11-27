import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { WaterfallInput } from '../../src/waterfall/index.ts';

/** Read directly from the locked spec file; never copied or edited. */
export const GOLDEN_PATH = new URL('../../../../docs/ai-specs/04-golden-test-cases.json', import.meta.url);
export interface GoldenCase { id: string; description: string; input: Record<string, any>; expected: Record<string, any> }
export const golden = (): GoldenCase[] => JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')).test_cases;

/** Field mapping only. The golden rule is treated as one synthetic approved rule
 * version (hash of its JSON); execution mode is the production default SHADOW. */
export function toWaterfallInput(tc: GoldenCase): WaterfallInput {
  const i = tc.input, r = i.rule;
  return {
    benefitType: i.benefit_type, taxVerifiedValid: i.is_tax_verified, isMergedSummary: i.is_merged_summary,
    fraudRiskScore: i.fraud_risk_score, daysActive: i.days_active, isChronicSpecial: i.is_chronic_special,
    usedAnnualAmount: r.used_annual_amount,
    rule: {
      ruleVersion: { id: `synthetic-${tc.id}`, version: 1, hash: createHash('sha256').update(JSON.stringify(r)).digest('hex') },
      annualLimit: r.annual_limit, perVisitLimit: r.per_visit_limit ?? null, copayInsurerPct: r.copay_insurer_pct,
      deductiblePerClaim: r.deductible_per_claim, waitingDaysNormal: r.waiting_days_normal,
      ...(r.waiting_days_special === undefined ? {} : { waitingDaysSpecial: r.waiting_days_special }),
      stpAutoApproveLimit: r.stp_auto_approve_limit, contractClauseCited: r.contract_clause_ref, stpExecutionMode: 'SHADOW',
    },
    lines: i.lines.map((l: Record<string, any>) => ({
      lineId: l.line_id, rawItemName: l.raw_item_name, category: l.category, unitPrice: l.unit_price,
      requestedAmount: l.requested_amount,
      ...(l.reference_unit_price === undefined ? {} : { referenceUnitPrice: l.reference_unit_price }),
      ...(l.exclusion_clause === undefined ? {} : { exclusionClauseCited: l.exclusion_clause }),
    })),
  };
}
