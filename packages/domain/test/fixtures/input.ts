import type { WaterfallInput, WaterfallLine } from '../../src/waterfall/index.ts';

export const HASH = 'a'.repeat(64);
export const line = (lineId: string, requested: string, extra: Partial<WaterfallLine> = {}): WaterfallLine =>
  ({ lineId, rawItemName: `Synthetic ${lineId}`, category: 'CONSULTATION', unitPrice: requested, requestedAmount: requested, ...extra });

/** Synthetic clean STP-eligible outpatient case; tests override single fields. */
export function base(overrides: Partial<WaterfallInput> = {}, rule: Partial<WaterfallInput['rule']> = {}): WaterfallInput {
  return {
    benefitType: 'OUTPATIENT', taxVerifiedValid: true, isMergedSummary: false, fraudRiskScore: 0, daysActive: 90,
    isChronicSpecial: false, usedAnnualAmount: '0.00',
    rule: {
      ruleVersion: { id: 'synthetic-rule', version: 1, hash: HASH }, annualLimit: '10000000.00', perVisitLimit: '2000000.00',
      copayInsurerPct: '100.00', deductiblePerClaim: '0.00', waitingDaysNormal: 30, waitingDaysSpecial: 365,
      stpAutoApproveLimit: '2000000.00', contractClauseCited: 'Synthetic clause 2.1', stpExecutionMode: 'SHADOW', ...rule,
    },
    lines: [line('L1', '500000.00')],
    ...overrides,
  };
}
