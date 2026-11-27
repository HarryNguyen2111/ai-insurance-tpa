import { createHash, randomUUID } from 'node:crypto';

/** BEN-01 internal port: production composition supplies the existing
 * withTenantTransaction helper. No HTTP handler, tenant selector or default approval. */
export interface PolicyTransaction {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface PolicyDatabase {
  withTenantTransaction<T>(tenantId: string, work: (tx: PolicyTransaction) => Promise<T>): Promise<T>;
}
export interface VersionRef { id: string; version: number; hash: string }
export type BenefitType = 'OUTPATIENT' | 'INPATIENT' | 'DENTAL' | 'MATERNITY' | 'ACCIDENT' | 'HOSPITAL_INCOME';
export interface Clause {
  clauseId: string; source: 'BENEFIT_RULE' | 'MEDICAL_CATALOG'; sourceVersion: VersionRef;
  contractClauseCited: string; explanationVi: string;
}
export interface EdgeTerms {
  hospitalIncome?: { clauseId: string; dayBasis: 'NIGHTS' | 'FULL_24H' };
  admissionOverlap?: { clauseId: string; action: 'REVIEW' };
  daycare?: { clauseId: string; maxHours: number; withoutSurgery: 'OUTPATIENT' | 'REVIEW' };
  prePostAdmission?: { clauseId: string; beforeDays: number; afterDays: number; icdGroupingVersion: VersionRef };
  stamp?: { clauseId: string; emrWaiver: boolean };
  prescription?: { clauseId: string; normalDays: number; maximumDays: number; interimReceiptRequired: boolean };
  originalDocuments?: { clauseId: string; threshold: string };
  dualApproval?: { clauseId: string; threshold: string };
  guardianPayee?: { clauseId: string; minorAge: number; mode: 'VERIFIED_GUARDIAN' };
}
export type EdgeTerm = keyof EdgeTerms;
export interface Endorsement {
  id: string; sourceVersion: VersionRef; clauseId: string; effectiveFrom: string; effectiveTo: string; terms: EdgeTerms;
}
export interface PolicyInput {
  id: string; policyId: string; version: number; effectiveFrom: string; effectiveTo: string;
  sourceDocument: VersionRef; approvalReference: string; clauses: Clause[];
  endorsements: Endorsement[]; precedence: string[];
}
export interface RuleInput {
  id: string; planId: string; version: number; policyVersion: VersionRef; clauseId: string;
  effectiveFrom: string; effectiveTo: string; benefitType: BenefitType;
  annualLimit: string; perVisitLimit?: string; deductiblePerClaim: string; copayInsurerPct: string;
  waitingDaysNormal: number; waitingDaysSpecial: number; configurationVersion: VersionRef;
  configuration: { stpExecutionMode: 'SHADOW' | 'ENABLED' | 'DISABLED'; ruleOrder: string[] };
  edgeTerms: EdgeTerms; approvalReference: string;
}
export interface CoverageInput {
  id: string; memberId: string; planId: string; version: number; policyVersion: VersionRef; ruleVersion: VersionRef;
  effectiveFrom: string; effectiveTo: string; premiumPaid: boolean; guardianMemberId?: string; approvalReference: string;
}
export interface SelectionRequest {
  memberId: string; planId: string; visitDate: string; benefitType: BenefitType;
  admission: boolean; prePostAdmission: boolean; prescription: boolean; minor: boolean;
}
export interface ApprovedSnapshot {
  policy: PolicyInput; rule: RuleInput; coverage: CoverageInput; terms: EdgeTerms;
  policyRef: VersionRef; ruleRef: VersionRef; coverageRef: VersionRef;
}
export type Selection = { kind: 'REVIEW'; reasons: string[] } | { kind: 'CONFIGURED'; snapshot: ApprovedSnapshot };
export interface ApprovalRequest {
  tenantId: string; actorId: string; kind: 'POLICY' | 'RULE' | 'COVERAGE'; contentHash: string;
  /** Frozen copy: verifier must establish exact approved source, text, applicability and authority. */
  definition: Readonly<PolicyInput | RuleInput | CoverageInput>;
}
export type SourceApprovalVerifier = (request: Readonly<ApprovalRequest>) => Promise<boolean>;

export class PolicyConfigurationError extends Error {
  constructor() { super('Invalid policy configuration'); this.name = 'PolicyConfigurationError'; }
}
export class PolicyApprovalRequired extends Error {
  constructor() { super('Verified source approval required'); this.name = 'PolicyApprovalRequired'; }
}
const bad = (): never => { throw new PolicyConfigurationError(); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const MONEY = /^(0|[1-9][0-9]{0,12})\.[0-9]{2}$/;
const BENEFITS: readonly string[] = ['OUTPATIENT', 'INPATIENT', 'DENTAL', 'MATERNITY', 'ACCIDENT', 'HOSPITAL_INCOME'];
export const EDGE_TERMS: readonly EdgeTerm[] = ['hospitalIncome', 'admissionOverlap', 'daycare', 'prePostAdmission', 'stamp',
  'prescription', 'originalDocuments', 'dualApproval', 'guardianPayee'];
function uuid(x: unknown): asserts x is string { if (typeof x !== 'string' || !UUID.test(x)) bad(); }
function integer(x: unknown, minimum = 0): asserts x is number { if (!Number.isSafeInteger(x) || (x as number) < minimum || (x as number) > 2147483647) bad(); }
function date(x: unknown): asserts x is string {
  if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x) || Number.isNaN(Date.parse(x)) || new Date(x).toISOString().slice(0, 10) !== x) bad();
}
function interval(x: { effectiveFrom: string; effectiveTo: string }) { date(x.effectiveFrom); date(x.effectiveTo); if (x.effectiveFrom > x.effectiveTo) bad(); }
function plainObject(x: object): boolean {
  const prototype = Object.getPrototypeOf(x);
  // structuredClone/Jest may use another realm's Object.prototype.
  return prototype !== null && Object.getPrototypeOf(prototype) === null;
}
function keys(x: unknown, required: string[], optional: string[] = []): void {
  if (!x || typeof x !== 'object' || Array.isArray(x) || !plainObject(x)
    || required.some(k => !Object.hasOwn(x, k)) || Reflect.ownKeys(x).some(k => typeof k !== 'string' || ![...required, ...optional].includes(k))) bad();
}
function ref(x: VersionRef) { keys(x, ['id', 'version', 'hash']); uuid(x.id); integer(x.version, 1); if (typeof x.hash !== 'string' || !HASH.test(x.hash)) bad(); }
function money(x: unknown) { if (typeof x !== 'string' || !MONEY.test(x)) bad(); }
function text(x: unknown) { if (typeof x !== 'string' || x.trim().length === 0 || x.length > 4000) bad(); }
function unique(xs: unknown[], max = 100) { if (!Array.isArray(xs) || xs.length > max || new Set(xs).size !== xs.length) bad(); }
function canonical(x: unknown): string {
  if (x === null || typeof x === 'boolean' || typeof x === 'string') return JSON.stringify(x);
  if (typeof x === 'number') { integer(x); return JSON.stringify(x); }
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (!x || typeof x !== 'object' || !plainObject(x)) return bad();
  return `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`).join(',')}}`;
}
export const configurationHash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
function frozenCopy<T>(input: T): T {
  const copy = structuredClone(input);
  const freeze = (x: unknown): void => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } };
  freeze(copy); return copy;
}
export function validateEdgeTerms(terms: EdgeTerms): void {
  keys(terms, [], [...EDGE_TERMS]);
  for (const key of EDGE_TERMS) {
    const term = terms[key];
    if (!term) { if (Object.hasOwn(terms, key)) bad(); continue; }
    const properties: Record<EdgeTerm, string[]> = {
      hospitalIncome: ['dayBasis'], admissionOverlap: ['action'], daycare: ['maxHours', 'withoutSurgery'],
      prePostAdmission: ['beforeDays', 'afterDays', 'icdGroupingVersion'], stamp: ['emrWaiver'],
      prescription: ['normalDays', 'maximumDays', 'interimReceiptRequired'], originalDocuments: ['threshold'],
      dualApproval: ['threshold'], guardianPayee: ['minorAge', 'mode'],
    };
    keys(term, ['clauseId', ...properties[key]]); uuid(term.clauseId);
  }
  if (terms.hospitalIncome && !['NIGHTS', 'FULL_24H'].includes(terms.hospitalIncome.dayBasis)) bad();
  if (terms.admissionOverlap && terms.admissionOverlap.action !== 'REVIEW') bad();
  if (terms.daycare) { integer(terms.daycare.maxHours, 1); if (!['OUTPATIENT', 'REVIEW'].includes(terms.daycare.withoutSurgery)) bad(); }
  if (terms.prePostAdmission) { integer(terms.prePostAdmission.beforeDays); integer(terms.prePostAdmission.afterDays); ref(terms.prePostAdmission.icdGroupingVersion); }
  if (terms.stamp && typeof terms.stamp.emrWaiver !== 'boolean') bad();
  if (terms.prescription) {
    integer(terms.prescription.normalDays); integer(terms.prescription.maximumDays);
    if (terms.prescription.maximumDays < terms.prescription.normalDays || typeof terms.prescription.interimReceiptRequired !== 'boolean') bad();
  }
  if (terms.originalDocuments) money(terms.originalDocuments.threshold);
  if (terms.dualApproval) money(terms.dualApproval.threshold);
  if (terms.guardianPayee) { integer(terms.guardianPayee.minorAge, 1); if (terms.guardianPayee.mode !== 'VERIFIED_GUARDIAN') bad(); }
}
export function validatePolicy(input: PolicyInput): void {
  keys(input, ['id','policyId','version','effectiveFrom','effectiveTo','sourceDocument','approvalReference','clauses','endorsements','precedence']);
  uuid(input.id); uuid(input.policyId); integer(input.version, 1); interval(input); ref(input.sourceDocument); uuid(input.approvalReference);
  if (!Array.isArray(input.clauses) || input.clauses.length < 1 || input.clauses.length > 100) bad();
  const clauseIds = input.clauses.map(c => {
    keys(c, ['clauseId','source','sourceVersion','contractClauseCited','explanationVi']); uuid(c.clauseId); ref(c.sourceVersion);
    if (!['BENEFIT_RULE', 'MEDICAL_CATALOG'].includes(c.source)) bad(); text(c.contractClauseCited); text(c.explanationVi); return c.clauseId;
  });
  unique(clauseIds);
  if (!Array.isArray(input.endorsements)) bad();
  unique(input.precedence); unique(input.endorsements.map(e => e.id));
  if (input.precedence.length !== input.endorsements.length || input.precedence.some(id => !input.endorsements.some(e => e.id === id))) bad();
  for (const e of input.endorsements) {
    keys(e, ['id','sourceVersion','clauseId','effectiveFrom','effectiveTo','terms']); uuid(e.id); ref(e.sourceVersion); interval(e); validateEdgeTerms(e.terms);
    if (!clauseIds.includes(e.clauseId) || e.effectiveFrom < input.effectiveFrom || e.effectiveTo > input.effectiveTo
      || Object.values(e.terms).some(t => !clauseIds.includes(t.clauseId))) bad();
  }
}
export function validateRule(input: RuleInput): void {
  keys(input, ['id','planId','version','policyVersion','clauseId','effectiveFrom','effectiveTo','benefitType','annualLimit','deductiblePerClaim',
    'copayInsurerPct','waitingDaysNormal','waitingDaysSpecial','configurationVersion','configuration','edgeTerms','approvalReference'], ['perVisitLimit']);
  uuid(input.id); uuid(input.planId); integer(input.version, 1); ref(input.policyVersion); uuid(input.clauseId); interval(input); uuid(input.approvalReference);
  if (!BENEFITS.includes(input.benefitType)) bad();
  money(input.annualLimit); money(input.deductiblePerClaim); if (input.perVisitLimit !== undefined) money(input.perVisitLimit);
  if (typeof input.copayInsurerPct !== 'string' || !/^(100\.00|[0-9]{1,2}\.[0-9]{2})$/.test(input.copayInsurerPct)) bad();
  integer(input.waitingDaysNormal); integer(input.waitingDaysSpecial); ref(input.configurationVersion); validateEdgeTerms(input.edgeTerms);
  keys(input.configuration, ['stpExecutionMode','ruleOrder']);
  if (!['SHADOW','ENABLED','DISABLED'].includes(input.configuration.stpExecutionMode)) bad();
  unique(input.configuration.ruleOrder, 20);
  if (!input.configuration.ruleOrder.length || input.configuration.ruleOrder.some(k => typeof k !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(k))) bad();
}
export function validateCoverage(input: CoverageInput): void {
  keys(input, ['id','memberId','planId','version','policyVersion','ruleVersion','effectiveFrom','effectiveTo','premiumPaid','approvalReference'], ['guardianMemberId']);
  uuid(input.id); uuid(input.memberId); uuid(input.planId); integer(input.version, 1); ref(input.policyVersion); ref(input.ruleVersion); interval(input); uuid(input.approvalReference);
  if (typeof input.premiumPaid !== 'boolean') bad(); if (input.guardianMemberId !== undefined) uuid(input.guardianMemberId);
}
function inDate(value: { effectiveFrom: string; effectiveTo: string }, dateValue: string) { return value.effectiveFrom <= dateValue && value.effectiveTo >= dateValue; }
function reference(input: { id: string; version: number }, hash: string): VersionRef { return { id: input.id, version: input.version, hash }; }
function sameRef(a: VersionRef, b: VersionRef) { return a.id === b.id && a.version === b.version && a.hash === b.hash; }

/** Pure selection, not adjudication: CONFIGURED never means covered/approved/STP.
 * Explicit first-in-precedence wins per term. Overlap among policy/rule/coverage
 * versions is ambiguous and routes review; version number is NOT a tie breaker. */
export function selectConfiguration(input: SelectionRequest, candidates: ApprovedSnapshot[], conflictingVersions = false): Selection {
  keys(input, ['memberId','planId','visitDate','benefitType','admission','prePostAdmission','prescription','minor']);
  uuid(input.memberId); uuid(input.planId); date(input.visitDate); if (!BENEFITS.includes(input.benefitType)) bad();
  if (['admission','prePostAdmission','prescription','minor'].some(k => typeof input[k as keyof SelectionRequest] !== 'boolean')) bad();
  if (conflictingVersions || candidates.length > 1) return { kind: 'REVIEW', reasons: ['AMBIGUOUS_EFFECTIVE_VERSIONS'] };
  if (!candidates.length) return { kind: 'REVIEW', reasons: ['NO_APPROVED_CONFIGURATION'] };
  const selected = frozenCopy(candidates[0]);
  const { policy, rule, coverage } = selected;
  try { validatePolicy(policy); validateRule(rule); validateCoverage(coverage); }
  catch { return { kind: 'REVIEW', reasons: ['INVALID_APPROVED_CONFIGURATION'] }; }
  const reasons: string[] = [];
  if (!sameRef(reference(policy,configurationHash(policy)),selected.policyRef)
    || !sameRef(reference(rule,configurationHash(rule)),selected.ruleRef)
    || !sameRef(reference(coverage,configurationHash(coverage)),selected.coverageRef)
    || !sameRef(rule.policyVersion, selected.policyRef) || !sameRef(coverage.policyVersion, selected.policyRef)
    || !sameRef(coverage.ruleVersion, selected.ruleRef) || rule.planId !== coverage.planId || rule.planId !== input.planId
    || coverage.memberId !== input.memberId || rule.benefitType !== input.benefitType
    || configurationHash(policy) !== selected.policyRef.hash || configurationHash(rule) !== selected.ruleRef.hash
    || configurationHash(coverage) !== selected.coverageRef.hash) reasons.push('INCONSISTENT_REFERENCE');
  if (![policy, rule, coverage].every(x => inDate(x, input.visitDate))) reasons.push('OUTSIDE_EFFECTIVE_INTERVAL');
  if (!coverage.premiumPaid) reasons.push('PREMIUM_REQUIRES_REVIEW');
  const terms: EdgeTerms = structuredClone(rule.edgeTerms);
  // Iterate in reverse so the declared highest-priority endorsement wins.
  for (const id of [...policy.precedence].reverse()) {
    const endorsement = policy.endorsements.find(e => e.id === id)!;
    if (inDate(endorsement, input.visitDate)) Object.assign(terms, endorsement.terms);
  }
  const clauses = new Set(policy.clauses.map(c => c.clauseId));
  if (!clauses.has(rule.clauseId) || Object.values(terms).some(t => !clauses.has(t.clauseId))) reasons.push('MISSING_CLAUSE');
  const required: EdgeTerm[] = ['originalDocuments','dualApproval'];
  if (input.benefitType === 'HOSPITAL_INCOME') required.push('hospitalIncome','admissionOverlap');
  if (input.admission) required.push('admissionOverlap','daycare');
  if (input.prePostAdmission) required.push('prePostAdmission');
  if (input.prescription) required.push('stamp','prescription');
  if (input.minor) { required.push('guardianPayee'); if (!coverage.guardianMemberId) reasons.push('MISSING_VERIFIED_GUARDIAN'); }
  for (const name of new Set(required)) if (!terms[name]) reasons.push(`MISSING_TERM_${name}`);
  if (reasons.length) return { kind: 'REVIEW', reasons };
  return { kind: 'CONFIGURED', snapshot: frozenCopy({ ...selected, terms }) };
}

/** Private repository; every public operation uses the injected tenant helper.
 * Approvals are externally verified, never inferred from request flags. Sources
 * and hashes must be checked by the actual pilot/contract owner adapter before
 * this repository can accept production configuration. Default is deny. */
export class PolicyBenefitRepository {
  private readonly db: PolicyDatabase;
  private readonly approve: SourceApprovalVerifier;
  constructor(db: PolicyDatabase, approve: SourceApprovalVerifier = async () => false) { this.db = db; this.approve = approve; }
  private inTenant<T>(tenantId: string, work: (tx: PolicyTransaction) => Promise<T>): Promise<T> {
    return this.db.withTenantTransaction(tenantId, async tx => {
      // Low-volume configuration changes and selections serialize per tenant.
      // Acquire before reading so READ COMMITTED sees any preceding commit.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('policy-config/' || tpa.current_tenant_id()::text, 0))");
      return work(tx);
    });
  }
  private async verify(tenantId: string, actorId: string, kind: ApprovalRequest['kind'], definition: PolicyInput | RuleInput | CoverageInput): Promise<string> {
    uuid(tenantId); const contentHash = configurationHash(definition);
    let allowed = false;
    try { allowed = await this.approve(Object.freeze({ tenantId, actorId, kind, contentHash, definition })) === true; } catch { /* deny */ }
    if (!allowed) throw new PolicyApprovalRequired(); return contentHash;
  }
  private async audit(tx: PolicyTransaction, entityId: string, actorId: string, action: string, hash: string): Promise<void> {
    await tx.query('SELECT * FROM tpa.append_audit($1,$2,$3,$4,$5,$6)',
      ['POLICY', entityId, 'USER', actorId, action, JSON.stringify({ after_hash: hash })]);
  }
  async createPolicy(tenantId: string, actorId: string, value: PolicyInput): Promise<VersionRef> {
    uuid(actorId); const p = frozenCopy(value); validatePolicy(p); const hash = await this.verify(tenantId, actorId, 'POLICY', p);
    return this.inTenant(tenantId, async tx => {
      await tx.query(`INSERT INTO tpa.policy_versions (tenant_id,id,policy_id,version_no,effective_from,effective_to,content_hash,approval_reference,definition)
        VALUES (tpa.current_tenant_id(),$1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [p.id,p.policyId,p.version,p.effectiveFrom,p.effectiveTo,hash,p.approvalReference,JSON.stringify(p)]);
      for (const clause of p.clauses) await tx.query(`INSERT INTO tpa.contract_clauses
        (tenant_id,id,policy_version_id,source_version,contract_clause_cited,explanation_vi) VALUES(tpa.current_tenant_id(),$1,$2,$3::jsonb,$4,$5)`,
      [clause.clauseId,p.id,JSON.stringify(clause.sourceVersion),clause.contractClauseCited,clause.explanationVi]);
      for (const e of p.endorsements) await tx.query(`INSERT INTO tpa.endorsements
        (tenant_id,id,policy_version_id,clause_id,priority,effective_from,effective_to,terms) VALUES(tpa.current_tenant_id(),$1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [e.id,p.id,e.clauseId,p.precedence.indexOf(e.id),e.effectiveFrom,e.effectiveTo,JSON.stringify(e.terms)]);
      await this.audit(tx,p.id,actorId,'POLICY_VERSION_CREATED',hash); return reference(p,hash);
    });
  }
  private async policy(tx: PolicyTransaction, requested: VersionRef): Promise<PolicyInput> {
    const { rows } = await tx.query('SELECT definition,content_hash,version_no FROM tpa.policy_versions WHERE id=$1', [requested.id]);
    const row = rows[0];
    if (!row || row.content_hash !== requested.hash || row.version_no !== requested.version) bad();
    return row.definition as unknown as PolicyInput;
  }
  async createRule(tenantId: string, actorId: string, value: RuleInput): Promise<VersionRef> {
    uuid(actorId); const r = frozenCopy(value); validateRule(r); const hash = await this.verify(tenantId, actorId, 'RULE', r);
    return this.inTenant(tenantId, async tx => {
      const p = await this.policy(tx,r.policyVersion);
      if (!p.clauses.some(c => c.clauseId === r.clauseId) || Object.values(r.edgeTerms).some(t => !p.clauses.some(c => c.clauseId === t.clauseId))) bad();
      await tx.query(`INSERT INTO tpa.benefit_rule_versions (tenant_id,id,plan_id,policy_version_id,clause_id,version_no,benefit_type,
        effective_from,effective_to,annual_limit,per_visit_limit,deductible_per_claim,copay_insurer_pct,definition,content_hash,approval_reference)
        VALUES(tpa.current_tenant_id(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)`,
      [r.id,r.planId,r.policyVersion.id,r.clauseId,r.version,r.benefitType,r.effectiveFrom,r.effectiveTo,r.annualLimit,
        r.perVisitLimit ?? null,r.deductiblePerClaim,r.copayInsurerPct,JSON.stringify(r),hash,r.approvalReference]);
      await this.audit(tx,r.id,actorId,'RULE_VERSION_CREATED',hash); return reference(r,hash);
    });
  }
  async createCoverage(tenantId: string, actorId: string, value: CoverageInput): Promise<VersionRef> {
    uuid(actorId); const c = frozenCopy(value); validateCoverage(c); const hash = await this.verify(tenantId, actorId, 'COVERAGE', c);
    return this.inTenant(tenantId, async tx => {
      await this.policy(tx,c.policyVersion);
      const { rows: [r] } = await tx.query('SELECT content_hash,version_no FROM tpa.benefit_rule_versions WHERE id=$1', [c.ruleVersion.id]);
      if (!r || r.content_hash !== c.ruleVersion.hash || r.version_no !== c.ruleVersion.version) bad();
      await tx.query(`INSERT INTO tpa.member_coverages(tenant_id,id,member_id,plan_id,policy_version_id,rule_version_id,version_no,
        effective_from,effective_to,premium_paid,guardian_member_id,content_hash,approval_reference)
        VALUES(tpa.current_tenant_id(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [c.id,c.memberId,c.planId,c.policyVersion.id,c.ruleVersion.id,c.version,c.effectiveFrom,c.effectiveTo,c.premiumPaid,c.guardianMemberId ?? null,hash,c.approvalReference]);
      await this.audit(tx,c.id,actorId,'COVERAGE_VERSION_CREATED',hash); return reference(c,hash);
    });
  }
  private async selection(tx: PolicyTransaction, request: SelectionRequest): Promise<Selection> {
    // Validate even when the tenant has no matching rows.
    selectConfiguration(request,[]);
    const { rows } = await tx.query(`SELECT p.definition AS policy,r.definition AS rule,p.content_hash AS policy_hash,r.content_hash AS rule_hash,
      c.content_hash AS coverage_hash,c.id,c.member_id,c.plan_id,c.version_no,c.policy_version_id,c.rule_version_id,c.premium_paid,
      c.guardian_member_id,c.approval_reference,to_char(c.effective_from,'YYYY-MM-DD') AS effective_from,to_char(c.effective_to,'YYYY-MM-DD') AS effective_to,
      (SELECT count(*)::int FROM tpa.policy_versions other WHERE other.policy_id=p.policy_id AND $3::date BETWEEN other.effective_from AND other.effective_to) AS policy_count,
      (SELECT count(*)::int FROM tpa.benefit_rule_versions other WHERE other.plan_id=r.plan_id AND other.policy_version_id=p.id
        AND other.benefit_type=r.benefit_type AND $3::date BETWEEN other.effective_from AND other.effective_to) AS rule_count
      FROM tpa.member_coverages c JOIN tpa.benefit_rule_versions r ON (r.tenant_id,r.id)=(c.tenant_id,c.rule_version_id)
      JOIN tpa.policy_versions p ON (p.tenant_id,p.id)=(c.tenant_id,c.policy_version_id)
      WHERE c.member_id=$1 AND c.plan_id=$2 AND $3::date BETWEEN c.effective_from AND c.effective_to AND r.benefit_type=$4
      ORDER BY c.id`, [request.memberId,request.planId,request.visitDate,request.benefitType]);
    const candidates = rows.map(row => {
      const policy = row.policy as unknown as PolicyInput, rule = row.rule as unknown as RuleInput;
      const policyRef = reference(policy,row.policy_hash as string), ruleRef = reference(rule,row.rule_hash as string);
      const coverage: CoverageInput = { id: row.id as string, memberId: row.member_id as string, planId: row.plan_id as string,
        version: row.version_no as number, policyVersion: policyRef, ruleVersion: ruleRef, effectiveFrom: row.effective_from as string,
        effectiveTo: row.effective_to as string, premiumPaid: row.premium_paid as boolean, approvalReference: row.approval_reference as string,
        ...(row.guardian_member_id ? { guardianMemberId: row.guardian_member_id as string } : {}) };
      return { policy,rule,coverage,policyRef,ruleRef,coverageRef: reference(coverage,row.coverage_hash as string),terms: {} };
    });
    return selectConfiguration(request,candidates,rows.some(r => r.policy_count !== 1 || r.rule_count !== 1));
  }
  resolve(tenantId: string, request: SelectionRequest): Promise<Selection> {
    uuid(tenantId); const copy = frozenCopy(request);
    return this.inTenant(tenantId, tx => this.selection(tx,copy));
  }
  /** Pins exact versions for a future claim/calculation owner. Does not change a claim status. */
  async resolveAndPin(tenantId: string, actorId: string, claimId: string, request: SelectionRequest): Promise<Selection> {
    uuid(tenantId); uuid(actorId); uuid(claimId); const copy = frozenCopy(request);
    return this.inTenant(tenantId, async tx => {
      // Serialize same-claim requests; snapshots themselves never change.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended(tpa.current_tenant_id()::text || $1, 0))",[claimId]);
      const result = await this.selection(tx,copy);
      if (result.kind === 'REVIEW') return result;
      const s = result.snapshot, snapshotHash = configurationHash({ snapshot: s, request: copy });
      const { rows: [existing] } = await tx.query('SELECT snapshot_hash FROM tpa.policy_version_usages WHERE claim_id=$1',[claimId]);
      if (existing) return existing.snapshot_hash === snapshotHash ? result : { kind: 'REVIEW', reasons: ['ALREADY_PINNED_DIFFERENT_SNAPSHOT'] };
      await tx.query(`INSERT INTO tpa.policy_version_usages(tenant_id,id,claim_id,coverage_version_id,rule_version_id,policy_version_id,visit_date,selection_context,snapshot_hash)
        VALUES(tpa.current_tenant_id(),$1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,[randomUUID(),claimId,s.coverage.id,s.rule.id,s.policy.id,copy.visitDate,JSON.stringify(copy),snapshotHash]);
      await this.audit(tx,claimId,actorId,'POLICY_SNAPSHOT_PINNED',snapshotHash);
      return result;
    });
  }
}
