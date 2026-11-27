/** Original-spec edge cases (spec 03 §3.2–3.4). Term shapes structurally match
 * BEN-01 #32 `EdgeTerms`; a missing approved term routes review — the values in
 * tests (24h, ±30 days) are synthetic examples, never universal defaults.
 * Datetime arithmetic here is time, not money; no amounts are computed. */
import { WaterfallInputError } from './money.ts';

export type EdgeReview = { kind: 'REVIEW'; reason: string };
export interface HospitalIncomeTerm { clauseId: string; dayBasis: 'NIGHTS' | 'FULL_24H' }
export interface DaycareTerm { clauseId: string; maxHours: number; withoutSurgery: 'OUTPATIENT' | 'REVIEW' }
export interface PrePostTerm { clauseId: string; beforeDays: number; afterDays: number; icdGroupingVersion: { id: string; version: number; hash: string } }
export interface AdmissionInterval { claimId: string; admit: string; discharge: string }

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** ISO-8601 with explicit offset; local wall time without zone is ambiguous. */
function instant(value: unknown, field: string): number {
  if (typeof value !== 'string' || !DATETIME.test(value)) throw new WaterfallInputError(field);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new WaterfallInputError(field);
  return ms;
}
function day(value: unknown, field: string): number {
  if (typeof value !== 'string' || !DATE.test(value)) throw new WaterfallInputError(field);
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new WaterfallInputError(field);
  return ms / DAY;
}
function stay(admit: string, discharge: string): [number, number] {
  const a = instant(admit, 'admit'), d = instant(discharge, 'discharge');
  if (d < a) throw new WaterfallInputError('discharge');
  return [a, d];
}

/** HOSPITAL_INCOME day count per approved plan basis: NIGHTS = local midnights
 * crossed in the plan's UTC offset; FULL_24H = floor(hours / 24). */
export function hospitalIncomeDays(admit: string, discharge: string, term: HospitalIncomeTerm | undefined, utcOffsetMinutes: number):
  { kind: 'DAYS'; days: number; clauseId: string } | EdgeReview {
  if (!term) return { kind: 'REVIEW', reason: 'MISSING_TERM_hospitalIncome' };
  if (!Number.isSafeInteger(utcOffsetMinutes) || Math.abs(utcOffsetMinutes) > 14 * 60) throw new WaterfallInputError('utcOffsetMinutes');
  const [a, d] = stay(admit, discharge);
  const shift = utcOffsetMinutes * 60_000;
  const days = term.dayBasis === 'NIGHTS'
    ? Math.floor((d + shift) / DAY) - Math.floor((a + shift) / DAY)
    : Math.floor((d - a) / DAY);
  return { kind: 'DAYS', days, clauseId: term.clauseId };
}

/** Closed-interval overlap with previously approved admissions ([admit, discharge]).
 * Overlap routes human review; it is never an automatic rejection. */
export function admissionOverlaps(candidate: AdmissionInterval, approved: readonly AdmissionInterval[]): string[] {
  const [a, d] = stay(candidate.admit, candidate.discharge);
  return approved.filter(other => {
    if (other.claimId === candidate.claimId) return false;
    const [oa, od] = stay(other.admit, other.discharge);
    return a <= od && oa <= d;
  }).map(other => other.claimId).sort();
}

/** Daycare: stay < maxHours without a surgery certificate converts to OUTPATIENT
 * (or review, per the approved term). */
export function daycareBenefit(admit: string, discharge: string, hasSurgeryCert: boolean, term: DaycareTerm | undefined):
  { kind: 'OUTPATIENT'; clauseId: string } | { kind: 'UNCHANGED' } | EdgeReview {
  if (typeof hasSurgeryCert !== 'boolean') throw new WaterfallInputError('hasSurgeryCert');
  if (!term) return { kind: 'REVIEW', reason: 'MISSING_TERM_daycare' };
  const [a, d] = stay(admit, discharge);
  if (d - a >= term.maxHours * HOUR || hasSurgeryCert) return { kind: 'UNCHANGED' };
  return term.withoutSurgery === 'OUTPATIENT' ? { kind: 'OUTPATIENT', clauseId: term.clauseId } : { kind: 'REVIEW', reason: 'DAYCARE_WITHOUT_SURGERY' };
}

/** Outpatient visit inside [admitDate - before, dischargeDate + after] with the same
 * ICD group (from one versioned grouping) yields a merge SUGGESTION only. */
export function prePostAdmissionSuggestion(
  input: { visitDate: string; admitDate: string; dischargeDate: string; visitIcdGroup?: string; admissionIcdGroup?: string; groupingVersionId?: string },
  term: PrePostTerm | undefined,
): { kind: 'SUGGEST_MERGE_INPATIENT'; clauseId: string } | { kind: 'NONE' } | EdgeReview {
  if (!term) return { kind: 'REVIEW', reason: 'MISSING_TERM_prePostAdmission' };
  const visit = day(input.visitDate, 'visitDate'), admit = day(input.admitDate, 'admitDate'), discharge = day(input.dischargeDate, 'dischargeDate');
  if (discharge < admit) throw new WaterfallInputError('dischargeDate');
  if (visit < admit - term.beforeDays || visit > discharge + term.afterDays) return { kind: 'NONE' };
  if (!input.visitIcdGroup || !input.admissionIcdGroup || input.groupingVersionId !== term.icdGroupingVersion.id) {
    return { kind: 'REVIEW', reason: 'MISSING_ICD_GROUPING' };
  }
  return input.visitIcdGroup === input.admissionIcdGroup ? { kind: 'SUGGEST_MERGE_INPATIENT', clauseId: term.clauseId } : { kind: 'NONE' };
}
