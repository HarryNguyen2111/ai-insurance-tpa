import { randomUUID } from 'node:crypto';
import type { IdentityStore } from '../identity-tenant/identity-store.ts';
import type { AuthorizedActor, IdentityTransaction } from '../identity-tenant/identity.types.ts';
import { memberRelationAllows, withObjectAccess } from '../identity-tenant/object-authorization.ts';
import { IdentityError, unavailable } from '../identity-tenant/identity-error.ts';
import { UUID } from '../identity-tenant/identity-context.ts';
import type { WorkflowCall as DocumentCall, WorkflowMutationResult as MutationResult } from '../workflow-definition/workflow-definition.store.ts';
import type { JsonValue, WorkflowRuntime } from '../workflow-definition/workflow-runtime.ts';
import { type DocumentStorage, type UploadObject, typeMatches, sniffType } from './storage.ts';
import type { DocumentScanner } from './scanner.ts';
export type { DocumentCall, MutationResult };
export interface DocumentsApi {
  consent(call: DocumentCall, body: unknown): Promise<MutationResult>;
  presign(call: DocumentCall, body: unknown): Promise<MutationResult>;
  complete(call: DocumentCall, id: string, body: unknown): Promise<MutationResult>;
  get(call: DocumentCall, id: string): Promise<JsonValue>;
}
interface UploadRow {
  id: string; member_id: string; principal_id: string; membership_id: string; consent_id: string;
  object_key: string; content_type: string; doc_type: string; size_bytes: number; sha256: string; expires_at: Date;
}
interface DocumentRow extends UploadRow { document_id: string; object_version: string; created_at: Date; version: number; status: string }
const DOCUMENT = `SELECT u.*,d.id AS document_id,d.object_version,d.created_at,d.version,s.status FROM tpa.document_versions d
 JOIN tpa.upload_sessions u ON u.tenant_id=d.tenant_id AND u.id=d.upload_id
 JOIN tpa.document_scan_outbox s ON s.tenant_id=d.tenant_id AND s.document_id=d.id`;
const hidden = () => new IdentityError(404, 'NOT_FOUND');
const invalid = () => new IdentityError(422, 'VALIDATION_FAILED');
const domain = () => new IdentityError(422, 'DOMAIN_VIOLATION');
const conflict = () => new IdentityError(409, 'IDEMPOTENCY_CONFLICT');
function object(row: UploadRow): UploadObject {
  return { key: row.object_key, contentType: row.content_type, sizeBytes: row.size_bytes, sha256: row.sha256, expiresAt: row.expires_at };
}
function view(d: DocumentRow): JsonValue {
  return { documentId: d.document_id, memberId: d.member_id, docType: d.doc_type, contentType: d.content_type,
    sizeBytes: d.size_bytes, sha256: d.sha256, version: d.version, scanStatus: d.status, createdAt: d.created_at.toISOString() };
}
/** All business queries live inside IdentityStore.withMembership -> withTenantTransaction (SET LOCAL). */
export class DocumentsStore implements DocumentsApi {
  private readonly identity: IdentityStore; private readonly runtime: WorkflowRuntime;
  private readonly storage: DocumentStorage; private readonly uploadPurpose: string;
  constructor(identity: IdentityStore, runtime: WorkflowRuntime, storage: DocumentStorage, uploadPurpose: string) {
    this.identity = identity; this.runtime = runtime; this.storage = storage; this.uploadPurpose = uploadPurpose;
  }
  private async audit(tx: IdentityTransaction, actor: AuthorizedActor, id: string, action: string, evidence: unknown) {
    await this.runtime.appendAudit(tx, { entityType: 'DOCUMENT', entityId: id, actorType: 'USER', actorId: actor.principalId,
      action, payload: { after_hash: this.runtime.requestHash(evidence) } });
  }
  private member(actor: AuthorizedActor, id: string) { if (!memberRelationAllows(actor, id)) throw hidden(); }
  private owner(actor: AuthorizedActor, u: UploadRow) {
    this.member(actor, u.member_id);
    if (u.principal_id !== actor.principalId || u.membership_id !== actor.membershipId) throw hidden();
  }
  private async currentConsent(tx: IdentityTransaction, actor: AuthorizedActor, memberId: string, consentId?: string): Promise<string> {
    const { rows: [c] } = await tx.query<{ id: string }>(`SELECT c.id FROM tpa.consent_records c
      JOIN tpa.consent_policies p ON p.tenant_id=c.tenant_id AND p.purpose=c.purpose
       AND p.policy_version=c.policy_version AND p.policy_hash=c.policy_hash
      WHERE c.member_id=$1 AND c.principal_id=$2 AND c.membership_id=$3 AND c.purpose=$4 AND p.active
       AND ($5::uuid IS NULL OR c.id=$5) AND tpa.document_lock_policy(p.purpose,p.policy_version,p.policy_hash) ORDER BY c.recorded_at DESC LIMIT 1`,
    [memberId, actor.principalId, actor.membershipId, this.uploadPurpose, consentId ?? null]);
    if (!c) throw domain(); return c.id;
  }
  private async mutate(call: DocumentCall, operation: string, schema: string, body: unknown, params: JsonValue,
    authorize: (tx: IdentityTransaction, actor: AuthorizedActor) => Promise<void>,
    effect: (tx: IdentityTransaction, actor: AuthorizedActor) => Promise<{ status: number; body: JsonValue }>,
    render?: (tx: IdentityTransaction, actor: AuthorizedActor, stored: JsonValue) => Promise<JsonValue>): Promise<MutationResult> {
    if (!call.idempotencyKey || !this.runtime.validateContract(schema, body)) throw invalid();
    return this.identity.withMembership(call.identity, call.membershipContext, async (tx, actor) => {
      await authorize(tx, actor); // revalidate even on a durable replay
      const scope = { operation, actorType: 'USER' as const, actorId: actor.principalId, key: call.idempotencyKey! };
      const hash = this.runtime.requestHash({ body, params, membershipId: actor.membershipId });
      const begun = await this.runtime.beginIdempotent(tx, scope, hash);
      if (begun.kind === 'conflict' || begun.kind === 'expired') throw conflict();
      if (begun.kind === 'in_progress') throw new IdentityError(409, 'OPERATION_IN_PROGRESS');
      const response = begun.kind === 'acquired' ? await this.runtime.runOwnedEffect(tx, scope, begun.ownerToken, begun.attempt,
        t => effect(t, actor)) : begun.response;
      return { status: response.status, body: render ? await render(tx, actor, response.body) : response.body, replayed: begun.kind === 'replayed' };
    });
  }
  consent(call: DocumentCall, body: unknown): Promise<MutationResult> {
    const b = body as { memberId: string; purpose: string; policyVersion: string; policyHash: string };
    return this.mutate(call, 'recordConsent', 'ConsentRequest', body, {}, async (tx, actor) => {
      this.member(actor, b.memberId);
      const { rows } = await tx.query<{ active: boolean }>(`SELECT tpa.document_lock_policy($1,$2,$3) AS active`,
        [b.purpose, b.policyVersion, b.policyHash]);
      if (!rows[0]?.active) throw domain();
    }, async (tx, actor) => {
      const id = randomUUID();
      const { rows: [r] } = await tx.query<{ recorded_at: Date }>(`INSERT INTO tpa.consent_records
        (tenant_id,id,member_id,principal_id,membership_id,purpose,policy_version,policy_hash)
        VALUES(tpa.current_tenant_id(),$1,$2,$3,$4,$5,$6,$7) RETURNING recorded_at`,
      [id, b.memberId, actor.principalId, actor.membershipId, b.purpose, b.policyVersion, b.policyHash]);
      const result = { consentId: id, memberId: b.memberId, purpose: b.purpose, policyVersion: b.policyVersion,
        policyHash: b.policyHash, recordedAt: r.recorded_at.toISOString(), version: 1 };
      await this.audit(tx, actor, id, 'CONSENT_RECORDED', result);
      return { status: 200, body: result };
    });
  }
  presign(call: DocumentCall, body: unknown): Promise<MutationResult> {
    const b = body as { memberId: string; contentType: string; docType: string; sizeBytes: number; sha256: string };
    return this.mutate(call, 'presignUpload', 'UploadRequest', body, {}, async (tx, actor) => {
      this.member(actor, b.memberId); await this.currentConsent(tx, actor, b.memberId);
    }, async (tx, actor) => {
      const id = randomUUID(), consent = await this.currentConsent(tx, actor, b.memberId);
      await tx.query(`INSERT INTO tpa.upload_sessions(tenant_id,id,member_id,principal_id,membership_id,consent_id,object_key,content_type,doc_type,size_bytes,sha256,expires_at)
        VALUES(tpa.current_tenant_id(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()+interval '295 seconds')`,
      [id,b.memberId,actor.principalId,actor.membershipId,consent,`quarantine/${actor.tenantId}/${id}`,b.contentType,b.docType,b.sizeBytes,b.sha256]);
      await this.audit(tx, actor, id, 'UPLOAD_AUTHORIZED', { memberId: b.memberId, sha256: b.sha256, consent });
      return { status: 200, body: { uploadId: id } };
    }, async (tx, actor, stored) => {
      const id = (stored as { uploadId: string }).uploadId, u = await this.upload(tx, id); this.owner(actor, u);
      await this.currentConsent(tx, actor, u.member_id, u.consent_id);
      if (u.expires_at.getTime() <= Date.now()) throw conflict();
      let uploadUrl: string;
      try { uploadUrl = await this.storage.grant(object(u)); } catch { throw unavailable(); }
      if (!uploadUrl.startsWith('https://')) throw unavailable();
      return { uploadId: id, uploadUrl, method: 'PUT', expiresAt: u.expires_at.toISOString(), requiredHeaders: {
        'Content-Type': u.content_type, 'x-amz-checksum-sha256': Buffer.from(u.sha256, 'hex').toString('base64') } };
    });
  }
  private async upload(tx: IdentityTransaction, id: string): Promise<UploadRow> {
    if (!UUID.test(id)) throw hidden();
    const { rows: [u] } = await tx.query<UploadRow>('SELECT * FROM tpa.upload_sessions WHERE id=$1', [id]);
    if (!u) throw hidden(); return u;
  }
  complete(call: DocumentCall, id: string, body: unknown): Promise<MutationResult> {
    const b = body as { sha256: string; sizeBytes: number };
    return this.mutate(call, 'completeUpload', 'UploadComplete', body, { uploadId: id }, async (tx, actor) => {
      const u = await this.upload(tx, id); this.owner(actor, u);
      await this.currentConsent(tx, actor, u.member_id, u.consent_id);
    }, async (tx, actor) => {
      const u = await this.upload(tx, id);
      // Serialize completion across DIFFERENT idempotency keys as well.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,151526))', [id]);
      if (b.sha256 !== u.sha256 || b.sizeBytes !== u.size_bytes) throw domain();
      const { rows: [existing] } = await tx.query<DocumentRow>(`${DOCUMENT} WHERE d.upload_id=$1`, [id]);
      if (existing) return { status: 202, body: { ...view(existing) as Record<string, JsonValue>, scanStatus: 'QUARANTINED' } };
      if (u.expires_at.getTime() <= Date.now()) throw conflict();
      let h;
      try { h = await this.storage.head(object(u)); } catch { throw unavailable(); }
      if (h.sha256 !== u.sha256 || h.sizeBytes !== u.size_bytes || h.contentType !== u.content_type) throw domain();
      // Bounded read of exact version; never caller-supplied URL/key. The original is never rewritten.
      let bytes;
      try { bytes = await this.storage.read(object(u), h.version); } catch { throw unavailable(); }
      if (!typeMatches(u.content_type, sniffType(bytes))) throw domain();
      const documentId = randomUUID();
      await tx.query(`INSERT INTO tpa.document_versions(tenant_id,id,upload_id,object_version) VALUES(tpa.current_tenant_id(),$1,$2,$3)`, [documentId,id,h.version]);
      await tx.query(`INSERT INTO tpa.document_scan_outbox(tenant_id,document_id) VALUES(tpa.current_tenant_id(),$1)`, [documentId]);
      await this.audit(tx, actor, documentId, 'DOCUMENT_QUARANTINED', { uploadId: id, objectVersion: h.version, sha256: u.sha256 });
      const { rows: [d] } = await tx.query<DocumentRow>(`${DOCUMENT} WHERE d.id=$1`, [documentId]);
      return { status: 202, body: view(d) };
    });
  }
  get(call: DocumentCall, id: string): Promise<JsonValue> {
    return withObjectAccess(this.identity, call.identity, call.membershipContext, id,
      { kind: 'DOCUMENT', action: 'READ', allowMember: true, requiredRoles: ['CLAIM_REVIEWER','INSURER_REVIEWER'] },
      async (tx, documentId) => {
        const { rows: [d] } = await tx.query<DocumentRow>(`${DOCUMENT} WHERE d.id=$1`, [documentId]);
        return d ? { id: d.document_id, kind: 'DOCUMENT', memberId: d.member_id } : null;
      }, async (tx, actor) => {
        const { rows: [d] } = await tx.query<DocumentRow>(`${DOCUMENT} WHERE d.id=$1`, [id]);
        await this.audit(tx, actor, id, 'DOCUMENT_STATUS_READ', { version: d.version }); return view(d);
      });
  }
  /** Consumer boundary for later preflight/AI/attachment modules. Same transaction as the consumer effect. */
  async consume<T>(call: DocumentCall, id: string, effect: (tx: IdentityTransaction, object: UploadObject, version: string) => Promise<T>): Promise<T> {
    if (!UUID.test(id)) throw hidden();
    return this.identity.withMembership(call.identity, call.membershipContext, async (tx, actor) => {
      const { rows: [d] } = await tx.query<DocumentRow>(`${DOCUMENT} WHERE d.id=$1 FOR SHARE OF s`, [id]);
      if (!d) throw hidden(); this.owner(actor, d);
      await this.currentConsent(tx, actor, d.member_id, d.consent_id);
      if (d.status !== 'CLEAN') throw domain();
      await this.audit(tx, actor, id, 'DOCUMENT_CONTENT_ACCESS', { version: d.version });
      return effect(tx, object(d), d.object_version);
    });
  }
}
/** Recoverable transactional scan outbox. Caller supplies an operator-controlled tenant, never a public route.
 * Hold row lock through bounded I/O. Crash/timeout rolls back; next worker retries same pinned original.
 */
export async function scanNext(tx: IdentityTransaction, runtime: WorkflowRuntime, storage: DocumentStorage,
  scanner: DocumentScanner, serviceId: string): Promise<boolean> {
  const { rows: [d] } = await tx.query<DocumentRow>(`${DOCUMENT} WHERE s.status='QUARANTINED' AND EXISTS (SELECT 1 FROM tpa.consent_records c
    JOIN tpa.consent_policies p ON p.tenant_id=c.tenant_id AND p.purpose=c.purpose AND p.policy_version=c.policy_version AND p.policy_hash=c.policy_hash
    WHERE c.tenant_id=u.tenant_id AND c.id=u.consent_id AND p.active AND tpa.document_lock_policy(p.purpose,p.policy_version,p.policy_hash)) ORDER BY d.created_at LIMIT 1 FOR UPDATE OF s SKIP LOCKED`);
  if (!d) return false;
  await tx.query(`UPDATE tpa.document_scan_outbox SET status='SCANNING' WHERE document_id=$1`, [d.document_id]);
  const bytes = await storage.read(object(d), d.object_version), verdict = await scanner.scan(bytes, d.content_type);
  if (!/^[A-Za-z0-9_.:+-]{1,200}$/.test(verdict.scannerVersion) || typeof verdict.clean !== 'boolean') throw new Error('Invalid scanner verdict');
  const status = verdict.clean ? 'CLEAN' : 'REJECTED';
  await tx.query(`UPDATE tpa.document_scan_outbox SET status=$2,scanner_version=$3,scanned_at=clock_timestamp() WHERE document_id=$1`,
    [d.document_id,status,verdict.scannerVersion]);
  await runtime.appendAudit(tx, { entityType: 'DOCUMENT', entityId: d.document_id, actorType: 'SERVICE', actorId: serviceId,
    action: 'DOCUMENT_SCANNED', payload: { after_hash: runtime.requestHash({ sha256: d.sha256, status, scannerVersion: verdict.scannerVersion, objectVersion: d.object_version }) } });
  return true;
}
