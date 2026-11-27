import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IdentityStore } from '../identity-tenant/identity-store.ts';
import type { AuthorizedActor, IdentityTransaction } from '../identity-tenant/identity.types.ts';
import { memberRelationAllows, withObjectAccess } from '../identity-tenant/object-authorization.ts';
import { IdentityError } from '../identity-tenant/identity-error.ts';
import { UUID } from '../identity-tenant/identity-context.ts';
import type { WorkflowCall as ClaimCall, WorkflowMutationResult as MutationResult } from '../workflow-definition/workflow-definition.store.ts';
import type { JsonValue, WorkflowRuntime } from '../workflow-definition/workflow-runtime.ts';
import { DOCUMENT, documentView, lockConsumableDocument, lockCurrentConsent, type DocumentRow } from '../documents-consents/documents.store.ts';
import { conflict, domain, hidden, inProgress, invalid, stale, unavailable } from './claim-error.ts';
import { CLAIM_TRANSITIONS, GATED_TARGETS, isClaimStatus, type ClaimStatus } from './claim-state.ts';
import { decodeCursor, encodeCursor, parseListQuery } from './claim-query.ts';
import type { ClaimPreflightGate } from './preflight-gate.ts';
export type { ClaimCall, MutationResult };

/** HTTP-facing port; the controller never touches SQL or tenant ids. */
export interface ClaimsApi {
  submit(call: ClaimCall, body: unknown): Promise<MutationResult>;
  list(call: ClaimCall, query: unknown): Promise<JsonValue>;
  get(call: ClaimCall, claimId: string): Promise<JsonValue>;
  supplement(call: ClaimCall, claimId: string, body: unknown): Promise<MutationResult>;
}
export interface ClaimsOptions {
  /** Approved consent purpose a claim submission must reference (operator provisioned, never defaulted). */
  claimPurpose: string;
  /** Same approved purpose DocumentsModule uses for uploads; attachments pass the DOC-01 consumer gate with it. */
  documentPurpose: string;
  preflight: ClaimPreflightGate;
}
interface SubmitBody {
  memberId: string; benefitType: string; visitDate: string; totalRequested: string; consentId: string;
  documentIds: string[]; preflightId: string; expectedPreflightVersion: number; providerId?: string;
  admitDatetime?: string; dischargeDatetime?: string; hasSurgeryCert?: boolean; icd10Code?: string;
}
interface SupplementBody { expectedVersion: number; documentIds: string[] }
export interface ClaimRow {
  id: string; claim_code: string; member_id: string; benefit_type: string; visit_date: string; total_requested: string;
  status: ClaimStatus; version: number; created_at: Date; updated_at: Date; supplement_deadline: Date | null;
  supplement_open: boolean; last_command_id: string | null; cursor_at: string;
}
// Money leaves PostgreSQL as NUMERIC text ("1500000.00"); it is never converted to a JS number.
export const CLAIM = `SELECT c.id,c.claim_code,c.member_id,c.benefit_type,to_char(c.visit_date,'YYYY-MM-DD') AS visit_date,
 c.total_requested::text AS total_requested,c.status,c.version,c.created_at,c.updated_at,c.supplement_deadline,
 coalesce(c.supplement_deadline > clock_timestamp(),false) AS supplement_open,c.last_command_id,
 to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM tpa.claims c`;
const MAX_DOCUMENTS = 100;
const STAFF_ROLES = ['CLAIM_REVIEWER', 'INSURER_REVIEWER'] as const;

export function claimSummary(c: ClaimRow): JsonValue {
  return { claimId: c.id, claimCode: c.claim_code, memberId: c.member_id, benefitType: c.benefit_type, visitDate: c.visit_date,
    totalRequested: c.total_requested, status: c.status, version: c.version, createdAt: c.created_at.toISOString(), updatedAt: c.updated_at.toISOString() };
}
async function readClaim(tx: IdentityTransaction, id: string, lock = false): Promise<ClaimRow | undefined> {
  if (!UUID.test(id)) return undefined;
  const { rows: [row] } = await tx.query<ClaimRow>(`${CLAIM} WHERE c.id=$1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return row;
}
async function claimDetail(tx: IdentityTransaction, id: string): Promise<JsonValue> {
  const c = await readClaim(tx, id);
  if (!c) throw hidden();
  const { rows: docs } = await tx.query<DocumentRow>(`${DOCUMENT} JOIN tpa.claim_documents cd ON cd.tenant_id=d.tenant_id AND cd.document_id=d.id
    WHERE cd.claim_id=$1 ORDER BY cd.attached_at, d.id LIMIT ${MAX_DOCUMENTS}`, [id]);
  return { claim: claimSummary(c), documents: docs.map(documentView), supplementAllowed: c.status === 'SUPPLEMENT_REQUIRED' && c.supplement_open,
    ...(c.supplement_deadline ? { supplementDeadline: c.supplement_deadline.toISOString() } : {}) };
}
async function stateChanged(tx: IdentityTransaction, runtime: WorkflowRuntime, row: ClaimRow, from: ClaimStatus,
  actor: { actorType: 'USER' | 'SERVICE'; actorId: string }, action: string): Promise<void> {
  await runtime.appendAudit(tx, { entityType: 'CLAIM', entityId: row.id, ...actor, action,
    payload: { after_hash: runtime.requestHash({ claimId: row.id, fromStatus: from, toStatus: row.status, version: row.version }) } });
  // Minimal event: status codes only, no amounts/members/documents/free text.
  await runtime.appendOutboxEvent(tx, { eventType: 'claim.state-changed', aggregateId: row.id, aggregateVersion: row.version,
    correlationId: randomUUID(), causationId: randomUUID(), payload: { fromStatus: from, toStatus: row.status } });
}

/** All business queries run inside IdentityStore.withMembership -> withTenantTransaction (SET LOCAL, FORCE RLS). */
export class ClaimsStore implements ClaimsApi {
  private readonly identity: IdentityStore; private readonly runtime: WorkflowRuntime; private readonly options: ClaimsOptions;
  constructor(identity: IdentityStore, runtime: WorkflowRuntime, options: ClaimsOptions) {
    if (!options?.claimPurpose || !options.documentPurpose || !options.preflight) throw new Error('Claims require approved purposes and a preflight gate');
    this.identity = identity; this.runtime = runtime; this.options = options;
  }
  private async mutate(call: ClaimCall, operation: string, schema: string, body: unknown, params: JsonValue,
    precheck: (b: unknown) => void,
    authorize: (tx: IdentityTransaction, actor: AuthorizedActor) => Promise<void>,
    effect: (tx: IdentityTransaction, actor: AuthorizedActor) => Promise<{ status: number; body: JsonValue }>): Promise<MutationResult> {
    if (!call.idempotencyKey || !this.runtime.validateContract(schema, body)) throw invalid();
    precheck(body);
    return this.identity.withMembership(call.identity, call.membershipContext, async (tx, actor) => {
      await authorize(tx, actor); // revalidated on every replay as well
      const scope = { operation, actorType: 'USER' as const, actorId: actor.principalId, key: call.idempotencyKey! };
      const hash = this.runtime.requestHash({ body, params, membershipId: actor.membershipId });
      const begun = await this.runtime.beginIdempotent(tx, scope, hash);
      if (begun.kind === 'conflict' || begun.kind === 'expired') throw conflict();
      if (begun.kind === 'in_progress') throw inProgress();
      const response = begun.kind === 'acquired'
        ? await this.runtime.runOwnedEffect(tx, scope, begun.ownerToken, begun.attempt, t => effect(t, actor)) : begun.response;
      return { status: response.status, body: response.body, replayed: begun.kind === 'replayed' };
    });
  }
  /** DOC-01 consumer gate for every document, in stable order, plus single-claim attachment. */
  private async attachable(tx: IdentityTransaction, actor: AuthorizedActor, memberId: string, ids: readonly string[]): Promise<string[]> {
    const sorted = [...ids].sort();
    for (const id of sorted) {
      // Serialize attachment of the same document across claims/keys; checked again under the lock below.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,151537))', [id]);
      let d: DocumentRow;
      try { d = await lockConsumableDocument(tx, actor, id, this.options.documentPurpose); }
      catch (error) { throw error instanceof IdentityError && error.code === 'DOMAIN_VIOLATION' ? domain('DOCUMENT_NOT_ATTACHABLE') : error; }
      if (d.member_id !== memberId) throw domain('DOCUMENT_NOT_ATTACHABLE');
    }
    const { rows } = await tx.query('SELECT 1 FROM tpa.claim_documents WHERE document_id = ANY($1::uuid[]) LIMIT 1', [sorted]);
    if (rows.length) throw domain('DOCUMENT_NOT_ATTACHABLE');
    return sorted;
  }
  private async attach(tx: IdentityTransaction, claimId: string, version: number, ids: string[]): Promise<void> {
    await tx.query(`INSERT INTO tpa.claim_documents(tenant_id,claim_id,document_id,claim_version)
      SELECT tpa.current_tenant_id(),$1,unnest($2::uuid[]),$3`, [claimId, ids, version]);
  }
  submit(call: ClaimCall, body: unknown): Promise<MutationResult> {
    const b = body as SubmitBody;
    return this.mutate(call, 'submitClaim', 'ClaimSubmit', body, {}, () => {
      if (b.totalRequested === '0.00') throw invalid('INVALID_AMOUNT');
      if (b.admitDatetime && b.dischargeDatetime && Date.parse(b.dischargeDatetime) < Date.parse(b.admitDatetime)) throw invalid();
    }, async (_tx, actor) => {
      if (!memberRelationAllows(actor, b.memberId)) throw hidden();
    }, async (tx, actor) => {
      // Durable backstop: a submission scope can never create a second claim, even after idempotency retention.
      const submissionHash = createHash('sha256').update(JSON.stringify(['submitClaim', actor.principalId, call.idempotencyKey])).digest('hex');
      if ((await tx.query('SELECT 1 FROM tpa.claims WHERE submission_hash=$1', [submissionHash])).rows.length) throw conflict();
      try { await lockCurrentConsent(tx, actor, b.memberId, this.options.claimPurpose, b.consentId); }
      catch (error) { throw error instanceof IdentityError && error.code === 'DOMAIN_VIOLATION' ? domain('CONSENT_REQUIRED') : error; }
      // Verified insured member: provisioned BEN-01 coverage. Source: 02-openapi-contracts.yaml ClaimSubmit ("Server verifies
      // ownership, CLEAN docs, current consent/purpose/policy, preflight version and coverage") with the contracted
      // Error422 code DOMAIN_VIOLATION (ApiError enum; 07 §4 "422 domain violation"). Date/benefit applicability is pinned later via
      // PolicyBenefitRepository.resolveAndPin, where missing/ambiguous configuration routes review (spec 03 §5).
      const { rows: insured } = await tx.query('SELECT 1 FROM tpa.member_coverages WHERE member_id=$1 LIMIT 1', [b.memberId]);
      if (!insured.length) throw domain('MEMBER_NOT_INSURED');
      let verdict: unknown;
      try {
        verdict = await this.options.preflight.verify(tx, actor, Object.freeze({ preflightId: b.preflightId, expectedVersion: b.expectedPreflightVersion,
          memberId: b.memberId, benefitType: b.benefitType, documentIds: Object.freeze([...b.documentIds]) }));
      } catch (error) { throw error instanceof IdentityError ? error : unavailable(); }
      if (verdict === 'STALE') throw stale('STALE_PREFLIGHT');
      if (verdict === 'NOT_FOUND') throw domain('PREFLIGHT_NOT_FOUND');
      if (verdict !== 'MATCH') throw unavailable();
      const documents = await this.attachable(tx, actor, b.memberId, b.documentIds);
      const id = randomUUID(), code = `CLM-${randomBytes(10).toString('hex').toUpperCase()}`;
      await tx.query(`INSERT INTO tpa.claims(tenant_id,id,claim_code,member_id,principal_id,membership_id,consent_id,submission_hash,
        benefit_type,visit_date,total_requested,provider_id,admit_datetime,discharge_datetime,has_surgery_cert,icd10_code,preflight_id,preflight_version,status)
        VALUES(tpa.current_tenant_id(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10::numeric(15,2),$11,$12,$13,$14,$15,$16,$17,'SUBMITTED')`,
      [id, code, b.memberId, actor.principalId, actor.membershipId, b.consentId, submissionHash, b.benefitType, b.visitDate, b.totalRequested,
        b.providerId ?? null, b.admitDatetime ?? null, b.dischargeDatetime ?? null, b.hasSurgeryCert ?? false, b.icd10Code ?? null,
        b.preflightId, b.expectedPreflightVersion]);
      await this.attach(tx, id, 1, documents);
      const row = (await readClaim(tx, id))!;
      await this.runtime.appendAudit(tx, { entityType: 'CLAIM', entityId: id, actorType: 'USER', actorId: actor.principalId, action: 'CLAIM_SUBMITTED',
        payload: { after_hash: this.runtime.requestHash({ claimId: id, version: 1, status: row.status, memberId: b.memberId, benefitType: b.benefitType,
          visitDate: b.visitDate, totalRequested: row.total_requested, documentIds: documents, consentId: b.consentId,
          preflightId: b.preflightId, preflightVersion: b.expectedPreflightVersion }) } });
      // claim.submitted 1.0.0 has an empty payload: consumers reload the authorized claim by aggregateId.
      await this.runtime.appendOutboxEvent(tx, { eventType: 'claim.submitted', aggregateId: id, aggregateVersion: 1,
        correlationId: randomUUID(), causationId: randomUUID(), payload: {} });
      return { status: 201, body: claimSummary(row) };
    });
  }
  supplement(call: ClaimCall, claimId: string, body: unknown): Promise<MutationResult> {
    const b = body as SupplementBody;
    if (!UUID.test(claimId)) return Promise.reject(hidden());
    return this.mutate(call, 'supplementClaim', 'ClaimSupplement', body, { claimId }, () => {}, async (tx, actor) => {
      const c = await readClaim(tx, claimId);
      // Only the owner/verified guardian supplements; staff and other members see 404.
      if (!c || !memberRelationAllows(actor, c.member_id)) throw hidden();
    }, async (tx, actor) => {
      const c = (await readClaim(tx, claimId, true))!;
      if (c.version !== b.expectedVersion) throw stale();
      if (c.status !== 'SUPPLEMENT_REQUIRED') throw domain('STATUS_NOT_ALLOWED');
      if (!c.supplement_open) throw domain('SUPPLEMENT_EXPIRED');
      const documents = await this.attachable(tx, actor, c.member_id, b.documentIds);
      const { rows: [count] } = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM tpa.claim_documents WHERE claim_id=$1', [claimId]);
      if (count.n + documents.length > MAX_DOCUMENTS) throw domain('DOCUMENT_NOT_ATTACHABLE');
      const { rowCount } = await tx.query(`UPDATE tpa.claims SET status='SUBMITTED',version=version+1,supplement_deadline=NULL,last_command_id=NULL
        WHERE id=$1 AND version=$2`, [claimId, b.expectedVersion]);
      if (rowCount !== 1) throw stale();
      await this.attach(tx, claimId, b.expectedVersion + 1, documents);
      const row = (await readClaim(tx, claimId))!;
      await stateChanged(tx, this.runtime, row, c.status, { actorType: 'USER', actorId: actor.principalId }, 'CLAIM_SUPPLEMENTED');
      return { status: 200, body: await claimDetail(tx, claimId) };
    });
  }
  get(call: ClaimCall, claimId: string): Promise<JsonValue> {
    return withObjectAccess(this.identity, call.identity, call.membershipContext, claimId,
      { kind: 'CLAIM', action: 'READ', allowMember: true, requiredRoles: STAFF_ROLES },
      async (tx, id) => {
        const c = await readClaim(tx, id);
        return c ? { id: c.id, kind: 'CLAIM', memberId: c.member_id } : null;
      }, async (tx, actor) => {
        const detail = await claimDetail(tx, claimId);
        await this.runtime.appendAudit(tx, { entityType: 'CLAIM', entityId: claimId, actorType: 'USER', actorId: actor.principalId,
          action: 'CLAIM_DETAIL_READ', payload: { after_hash: this.runtime.requestHash({ claimId, version: (detail as { claim: { version: number } }).claim.version }) } });
        return detail;
      });
  }
  async list(call: ClaimCall, raw: unknown): Promise<JsonValue> {
    const query = parseListQuery(raw);
    return this.identity.withMembership(call.identity, call.membershipContext, async (tx, actor) => {
      const members = actor.memberGrants.filter(g => memberRelationAllows(actor, g.memberId)).map(g => g.memberId);
      const staff = actor.roles.some(r => (STAFF_ROLES as readonly string[]).includes(r));
      if (query.memberId && !staff && !members.includes(query.memberId)) throw hidden();
      const position = decodeCursor(actor.membershipId, query);
      // Every row is authorized: owner/guardian relation, or explicit active READ assignment for staff.
      const { rows } = await tx.query<ClaimRow>(`${CLAIM}
        WHERE (c.member_id = ANY($1::uuid[]) OR ($2::boolean AND EXISTS (SELECT 1 FROM tpa.identity_object_assignments a
          WHERE a.membership_id=$3 AND a.active AND a.action='READ' AND a.object_kind='CLAIM' AND a.object_id=c.id)))
          AND ($4::text IS NULL OR c.status=$4) AND ($5::uuid IS NULL OR c.member_id=$5)
          AND ($6::timestamptz IS NULL OR (c.created_at,c.id) < ($6::timestamptz,$7::uuid))
        ORDER BY c.created_at DESC, c.id DESC LIMIT $8`,
      [members, staff, actor.membershipId, query.status ?? null, query.memberId ?? null, position?.createdAt ?? null,
        position?.claimId ?? null, query.limit + 1]);
      const items = rows.slice(0, query.limit), last = items.at(-1);
      return { items: items.map(claimSummary),
        ...(rows.length > query.limit && last ? { nextCursor: encodeCursor(actor.membershipId, query, { createdAt: last.cursor_at, claimId: last.id }) } : {}) };
    });
  }
}

export interface ClaimTransitionCommand {
  claimId: string; expectedVersion: number; toStatus: ClaimStatus;
  /** Stable workflow command ID: a retried command replays without a second transition/audit/event. */
  commandId: string;
  actorType: 'SERVICE' | 'USER'; actorId: string;
  /** Required exactly when entering SUPPLEMENT_REQUIRED; computed by the caller from approved configuration. */
  supplementDeadline?: string;
}
/**
 * Internal domain transition for trusted callers (Temporal activities, #38) that already run inside a
 * withTenantTransaction and have authenticated their service/staff actor. Expected-version optimistic check under a
 * row lock; state + audit + outbox commit with the caller's transaction. Evidence-gated targets fail closed.
 */
export async function transitionClaim(tx: IdentityTransaction, runtime: WorkflowRuntime, cmd: ClaimTransitionCommand): Promise<{ claim: JsonValue; replayed: boolean }> {
  if (!cmd || !UUID.test(cmd.claimId) || !UUID.test(cmd.commandId) || !UUID.test(cmd.actorId) || !['SERVICE', 'USER'].includes(cmd.actorType)
    || !Number.isSafeInteger(cmd.expectedVersion) || cmd.expectedVersion < 1 || !isClaimStatus(cmd.toStatus)) throw invalid();
  if (GATED_TARGETS.has(cmd.toStatus)) throw domain('GATE_REQUIRED');
  const needsDeadline = cmd.toStatus === 'SUPPLEMENT_REQUIRED';
  if (needsDeadline !== (cmd.supplementDeadline !== undefined)) throw invalid();
  if (needsDeadline && (typeof cmd.supplementDeadline !== 'string' || Number.isNaN(Date.parse(cmd.supplementDeadline)))) throw invalid();
  const c = await readClaim(tx, cmd.claimId, true);
  if (!c) throw hidden();
  if (c.last_command_id === cmd.commandId && c.version === cmd.expectedVersion + 1 && c.status === cmd.toStatus) {
    return { claim: claimSummary(c), replayed: true };
  }
  if (c.version !== cmd.expectedVersion) throw stale();
  if (!CLAIM_TRANSITIONS[c.status].includes(cmd.toStatus)) throw domain('TRANSITION_NOT_ALLOWED');
  if (needsDeadline) {
    const { rows: [future] } = await tx.query<{ ok: boolean }>('SELECT $1::timestamptz > clock_timestamp() AS ok', [cmd.supplementDeadline]);
    if (!future.ok) throw invalid();
  }
  const { rowCount } = await tx.query(`UPDATE tpa.claims SET status=$2,version=version+1,supplement_deadline=$3,last_command_id=$4
    WHERE id=$1 AND version=$5`, [cmd.claimId, cmd.toStatus, cmd.supplementDeadline ?? null, cmd.commandId, cmd.expectedVersion]);
  if (rowCount !== 1) throw stale();
  const row = (await readClaim(tx, cmd.claimId))!;
  await stateChanged(tx, runtime, row, c.status, { actorType: cmd.actorType, actorId: cmd.actorId }, 'CLAIM_STATUS_CHANGED');
  return { claim: claimSummary(row), replayed: false };
}
