import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  configurationHash, EDGE_TERMS, PolicyApprovalRequired, PolicyBenefitRepository, PolicyConfigurationError,
  selectConfiguration, validatePolicy, validateRule, type ApprovedSnapshot, type CoverageInput, type PolicyInput,
  type RuleInput, type SelectionRequest, type VersionRef,
} from './policy-benefit';

interface Fixture { tenantId: string; actorId: string; policy: PolicyInput; rule: RuleInput; coverage: CoverageInput; request: SelectionRequest }
const load = (): Fixture => JSON.parse(readFileSync(resolve(__dirname, '../../../../packages/database/test/fixtures/policy-benefit.json'), 'utf8'));
const ref = (x: { id: string; version: number }): VersionRef => ({ id: x.id, version: x.version, hash: configurationHash(x) });
function candidate(f: Fixture): ApprovedSnapshot {
  const policyRef = ref(f.policy); f.rule.policyVersion = policyRef;
  const ruleRef = ref(f.rule); f.coverage.policyVersion = policyRef; f.coverage.ruleVersion = ruleRef;
  return { policy: f.policy, rule: f.rule, coverage: f.coverage, terms: {}, policyRef, ruleRef, coverageRef: ref(f.coverage) };
}

describe('BEN-01 approved configuration selection (not benefit adjudication)', () => {
  test('exact source references, string amounts and complete edge settings resolve without mutating input', () => {
    const f = load(), c = candidate(f), before = structuredClone(c);
    const result = selectConfiguration(f.request,[c]);
    expect(result.kind).toBe('CONFIGURED'); expect(c).toEqual(before);
    if (result.kind === 'CONFIGURED') {
      expect(result.snapshot.rule.annualLimit).toBe('10000000.00');
      expect(result.snapshot.rule.configuration.stpExecutionMode).toBe('SHADOW');
      expect(Object.isFrozen(result.snapshot.rule)).toBe(true);
      expect(result.snapshot.terms).toEqual(f.rule.edgeTerms);
    }
  });
  test.each(EDGE_TERMS)('missing approved %s term routes review, never an inferred exclusion/default', term => {
    const f = load(); delete f.rule.edgeTerms[term];
    expect(selectConfiguration(f.request,[candidate(f)])).toEqual({ kind: 'REVIEW', reasons: [`MISSING_TERM_${term}`] });
  });
  test('missing clause, wrong source hash, guardian and premium uncertainty route human review', () => {
    const f = load(); f.rule.clauseId = randomUUID();
    expect(selectConfiguration(f.request,[candidate(f)])).toEqual({ kind: 'REVIEW', reasons: ['MISSING_CLAUSE'] });
    const c = candidate(load()); c.rule.policyVersion = { ...c.policyRef, hash: 'b'.repeat(64) };
    expect(selectConfiguration(load().request,[c]).kind).toBe('REVIEW');
    const f2 = load(); delete f2.coverage.guardianMemberId; f2.coverage.premiumPaid = false;
    expect(selectConfiguration(f2.request,[candidate(f2)])).toEqual({ kind: 'REVIEW', reasons: ['PREMIUM_REQUIRES_REVIEW','MISSING_VERIFIED_GUARDIAN'] });
  });
  test('effective dates include both boundaries; no matching/overlapping versions never use latest-version wins', () => {
    const f = load(), c = candidate(f);
    for (const visitDate of ['2026-01-01','2026-12-31']) expect(selectConfiguration({ ...f.request,visitDate },[c]).kind).toBe('CONFIGURED');
    for (const visitDate of ['2025-12-31','2027-01-01']) expect(selectConfiguration({ ...f.request,visitDate },[c]).kind).toBe('REVIEW');
    expect(selectConfiguration(f.request,[])).toEqual({ kind:'REVIEW',reasons:['NO_APPROVED_CONFIGURATION'] });
    expect(selectConfiguration(f.request,[c,c])).toEqual({ kind:'REVIEW',reasons:['AMBIGUOUS_EFFECTIVE_VERSIONS'] });
    expect(selectConfiguration(f.request,[c],true).kind).toBe('REVIEW');
  });
  test('complete explicit endorsement precedence wins per term regardless of insertion order; effective dates apply', () => {
    const f = load(), clauseId = f.policy.clauses[0].clauseId;
    const high = { id:randomUUID(),sourceVersion:f.policy.sourceDocument,clauseId,effectiveFrom:'2026-06-01',effectiveTo:'2026-06-30',
      terms:{ originalDocuments:{clauseId,threshold:'30000000.00'} } };
    const low = { ...high,id:randomUUID(),terms:{ originalDocuments:{clauseId,threshold:'25000000.00'} } };
    f.policy.endorsements = [low,high]; f.policy.precedence = [high.id,low.id];
    const result = selectConfiguration(f.request,[candidate(f)]);
    expect(result.kind === 'CONFIGURED' && result.snapshot.terms.originalDocuments?.threshold).toBe('30000000.00');
    f.policy.endorsements.reverse();
    const result2 = selectConfiguration(f.request,[candidate(f)]);
    expect(result2.kind === 'CONFIGURED' && result2.snapshot.terms.originalDocuments?.threshold).toBe('30000000.00');
    const outside = selectConfiguration({ ...f.request,visitDate:'2026-07-01' },[candidate(f)]);
    expect(outside.kind === 'CONFIGURED' && outside.snapshot.terms.originalDocuments?.threshold).toBe('20000000.00');
    f.policy.precedence = [high.id,high.id]; expect(() => validatePolicy(f.policy)).toThrow(PolicyConfigurationError);
  });
  test('both approved hospital-income bases are explicit; malformed settings, numeric money and unknown PII fail validation', () => {
    const f = load(); f.rule.edgeTerms.hospitalIncome!.dayBasis = 'FULL_24H'; expect(() => validateRule(f.rule)).not.toThrow();
    (f.rule as unknown as { annualLimit: unknown }).annualLimit = 10000000;
    expect(() => validateRule(f.rule)).toThrow(PolicyConfigurationError);
    const f2 = load(); f2.rule.edgeTerms.prescription!.maximumDays = 4; expect(() => validateRule(f2.rule)).toThrow(PolicyConfigurationError);
    const f3 = load(); Object.assign(f3.rule,{ pii:'PT17-MARKER-079123456789' });
    expect(() => validateRule(f3.rule)).toThrow('Invalid policy configuration');
    expect(() => validatePolicy({ ...load().policy,effectiveFrom:'2026-02-30' })).toThrow(PolicyConfigurationError);
  });
  test('source approval fails closed and has no database effects when missing, false or unavailable', async () => {
    const f = load(), db = { withTenantTransaction:jest.fn() };
    for (const approve of [undefined,async () => false,async () => { throw new Error('PT17-MARKER'); }]) {
      await expect(new PolicyBenefitRepository(db,approve).createPolicy(f.tenantId,f.actorId,f.policy)).rejects.toThrow(PolicyApprovalRequired);
    }
    expect(db.withTenantTransaction).not.toHaveBeenCalled();
  });
  test('approval binds a frozen private copy: caller mutations cannot change the subsequently stored snapshot', async () => {
    const f = load(), expected = structuredClone(f.policy), writes: unknown[][] = [];
    let accept!: () => void;
    const gate = new Promise<void>(resolve => { accept=resolve; });
    const db = { async withTenantTransaction<T>(_tenant: string, work: (tx: { query(sql: string, values?: unknown[]): Promise<{rows:Record<string,unknown>[]}> }) => Promise<T>) {
      return work({async query(_sql, values) { writes.push(values ?? []); return { rows:[] }; }});
    } };
    const repository = new PolicyBenefitRepository(db,async request => { expect(Object.isFrozen(request.definition)).toBe(true); expect(request.actorId).toBe(f.actorId); expect(request.tenantId).toBe(f.tenantId); await gate; return request.contentHash === configurationHash(expected); });
    const creating = repository.createPolicy(f.tenantId,f.actorId,f.policy);
    f.policy.clauses[0].contractClauseCited = 'changed after approval request'; accept();
    const created = await creating;
    expect(created.hash).toBe(configurationHash(expected));
    expect(JSON.parse(writes[1][7] as string)).toEqual(expected); // first query acquires tenant lock
  });
  test('unchanged TC monetary fixtures preserve contract strings only; no waterfall PASS is claimed', () => {
    const golden = JSON.parse(readFileSync(resolve(__dirname,'../../../../docs/ai-specs/04-golden-test-cases.json'),'utf8'));
    for (const tc of golden.test_cases.filter((c: {input:{rule?:unknown}}) => c.input.rule)) {
      const f = load();
      f.rule.annualLimit = tc.input.rule.annual_limit; f.rule.perVisitLimit = tc.input.rule.per_visit_limit;
      f.rule.deductiblePerClaim = tc.input.rule.deductible_per_claim; f.rule.copayInsurerPct = tc.input.rule.copay_insurer_pct;
      expect(() => validateRule(f.rule)).not.toThrow();
      expect(f.rule.annualLimit).toBe(tc.input.rule.annual_limit);
    }
  });
});
