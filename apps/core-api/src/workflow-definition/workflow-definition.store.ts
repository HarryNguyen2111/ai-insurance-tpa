import { randomUUID } from 'node:crypto';
import type { IdentityStore } from '../identity-tenant/identity-store.ts';
import type { AuthorizedActor, IdentityTransaction } from '../identity-tenant/identity.types.ts';
import type { VerifiedIdentity } from '../identity-tenant/oidc-verifier.ts';
import { IdentityError } from '../identity-tenant/identity-error.ts';
import { domain, forbidden, hidden, invalidRequest, stale } from './workflow-error.ts';
import type { DefinitionLike, JsonValue, WorkflowRuntime } from './workflow-runtime.ts';

/** Per-request trust inputs. Tenant comes only from the verified membership context. */
export interface WorkflowCall { identity: VerifiedIdentity; membershipContext: unknown; idempotencyKey?: string }
export interface WorkflowMutationResult { status: number; body: JsonValue; replayed: boolean }
export interface PageQuery { limit: number; cursor?: string }
/** HTTP-facing port; the controller never touches SQL or tenant ids. */
export interface WorkflowDefinitionApi {
  list(call: WorkflowCall, query: PageQuery): Promise<JsonValue>;
  listVersions(call: WorkflowCall, definitionId: string, query: PageQuery): Promise<JsonValue>;
  get(call: WorkflowCall, definitionId: string, versionNo: number): Promise<JsonValue>;
  create(call: WorkflowCall, body: unknown): Promise<WorkflowMutationResult>;
  update(call: WorkflowCall, definitionId: string, versionNo: number, body: unknown): Promise<WorkflowMutationResult>;
  validate(call: WorkflowCall, definitionId: string, versionNo: number): Promise<WorkflowMutationResult>;
  publish(call: WorkflowCall, definitionId: string, versionNo: number, body: unknown): Promise<WorkflowMutationResult>;
  revoke(call: WorkflowCall, definitionId: string, versionNo: number, body: unknown): Promise<WorkflowMutationResult>;
  catalog(call: WorkflowCall, catalogVersion: number): Promise<JsonValue>;
}

type Role = 'WORKFLOW_DESIGNER' | 'WORKFLOW_PUBLISHER' | 'WORKFLOW_SUPERVISOR' | 'WORKFLOW_OBSERVER' | 'CLAIM_REVIEWER' | 'INSURER_REVIEWER';
const READERS: Role[] = ['WORKFLOW_DESIGNER', 'WORKFLOW_PUBLISHER', 'WORKFLOW_OBSERVER'];
const CATALOG_READERS: Role[] = ['WORKFLOW_DESIGNER', 'WORKFLOW_PUBLISHER', 'WORKFLOW_SUPERVISOR', 'WORKFLOW_OBSERVER', 'CLAIM_REVIEWER', 'INSURER_REVIEWER'];
const REF_KIND = { modelRef: 'MODEL', promptRef: 'PROMPT', policyRef: 'POLICY', formRef: 'FORM' } as const;

interface VersionRow {
  definition_id: string; workflow_key: string; version_no: number; status: 'DRAFT' | 'PUBLISHED' | 'RETIRED' | 'REVOKED';
  revision: number; content: DefinitionLike; content_hash: string; action_catalog_version: number; benefit_types: string[];
  editor_ids: string[]; created_at: Date; updated_at: Date; published_at: Date | null; retired_at: Date | null;
  revoked_at: Date | null; revoked_reason: string | null; in_flight: number;
}
const VERSION_SELECT = `SELECT d.id::text AS definition_id, d.workflow_key, v.version_no, v.status, v.revision, v.content, v.content_hash,
  v.action_catalog_version, v.benefit_types, v.editor_ids::text[] AS editor_ids, v.created_at, v.updated_at, v.published_at, v.retired_at,
  v.revoked_at, v.revoked_reason,
  (SELECT count(*)::int FROM tpa.workflow_executions e WHERE e.definition_id = v.definition_id AND e.version_no = v.version_no AND e.status <> 'COMPLETED') AS in_flight
  FROM tpa.workflow_definition_versions v JOIN tpa.workflow_definitions d ON d.tenant_id = v.tenant_id AND d.id = v.definition_id`;

const roleOf = (actor: AuthorizedActor): string[] => [...actor.roles, ...actor.workflowRoles];
function requireRole(actor: AuthorizedActor, roles: Role[]): void {
  // Inaccessible objects/operations do not reveal existence: missing role is 404 for reads elsewhere;
  // here the operation itself is role-gated, so a staff member without the role gets 403.
  if (!roles.some(r => roleOf(actor).includes(r))) throw forbidden();
}
function cursorEncode(membershipId: string, position: string | number): string {
  return Buffer.from(JSON.stringify([membershipId, position])).toString('base64url');
}
function cursorDecode(membershipId: string, cursor: string | undefined): string | number | null {
  if (cursor === undefined) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(value) && value.length === 2 && value[0] === membershipId && (typeof value[1] === 'string' || Number.isSafeInteger(value[1]))) return value[1];
  } catch { /* fixed error below */ }
  throw invalidRequest(); // cursor bound to membership/filter/order
}

export class WorkflowDefinitionStore implements WorkflowDefinitionApi {
  private readonly identity: IdentityStore;
  private readonly runtime: WorkflowRuntime;
  constructor(identity: IdentityStore, runtime: WorkflowRuntime) { this.identity = identity; this.runtime = runtime; }

  private read<T>(call: WorkflowCall, roles: Role[], fn: (tx: IdentityTransaction, actor: AuthorizedActor) => Promise<T>): Promise<T> {
    return this.identity.withMembership(call.identity, call.membershipContext, async (tx, actor) => { requireRole(actor, roles); return fn(tx, actor); });
  }

  /** Role + MFA + body contract, then durable idempotency, effect, audit and outbox in ONE tenant transaction. */
  private mutate(call: WorkflowCall, operation: string, roles: Role[], request: { schema?: string; body: unknown; params: JsonValue },
    effect: (tx: IdentityTransaction, actor: AuthorizedActor) => Promise<{ status: number; body: JsonValue }>,
    render: (tx: IdentityTransaction, actor: AuthorizedActor, stored: JsonValue) => Promise<JsonValue>): Promise<WorkflowMutationResult> {
    if (!call.idempotencyKey) return Promise.reject(invalidRequest());
    return this.identity.withMembership(call.identity, call.membershipContext, async (tx, actor) => {
      requireRole(actor, roles);
      if (call.identity.mfaValidUntil * 1000 <= Date.now()) throw forbidden();
      if (request.schema ? !this.runtime.validateContract(request.schema, request.body) : request.body !== undefined && !(request.body && typeof request.body === 'object' && !Array.isArray(request.body) && Object.keys(request.body).length === 0)) {
        throw invalidRequest();
      }
      const scope = { operation, actorType: 'USER' as const, actorId: actor.principalId, key: call.idempotencyKey! };
      const hash = this.runtime.requestHash({ params: request.params, body: (request.schema ? request.body : null) as JsonValue });
      const begin = await this.runtime.beginIdempotent(tx, scope, hash);
      if (begin.kind === 'conflict' || begin.kind === 'expired') throw new IdentityError(409, 'IDEMPOTENCY_CONFLICT');
      if (begin.kind === 'in_progress') throw new IdentityError(409, 'OPERATION_IN_PROGRESS');
      const response = begin.kind === 'acquired'
        ? await this.runtime.runOwnedEffect(tx, scope, begin.ownerToken, begin.attempt, t => effect(t, actor))
        : begin.response;
      return { status: response.status, body: await render(tx, actor, response.body), replayed: begin.kind === 'replayed' };
    });
  }

  private async versionRow(tx: IdentityTransaction, definitionId: string, versionNo: number, lock = false): Promise<VersionRow> {
    const { rows: [row] } = await tx.query<VersionRow>(`${VERSION_SELECT} WHERE v.definition_id = $1 AND v.version_no = $2${lock ? ' FOR UPDATE OF v' : ''}`, [definitionId, versionNo]);
    if (!row) throw hidden(); // other-tenant rows are invisible under FORCE RLS: same 404
    return row;
  }
  private async lockDefinition(tx: IdentityTransaction, definitionId: string): Promise<{ workflow_key: string }> {
    const { rows: [row] } = await tx.query<{ workflow_key: string }>('SELECT workflow_key FROM tpa.workflow_definitions WHERE id = $1 FOR UPDATE', [definitionId]);
    if (!row) throw hidden();
    return row;
  }
  private async bumpDefinition(tx: IdentityTransaction, definitionId: string): Promise<number> {
    const { rows: [row] } = await tx.query<{ aggregate_version: number }>(
      'UPDATE tpa.workflow_definitions SET aggregate_version = aggregate_version + 1 WHERE id = $1 RETURNING aggregate_version', [definitionId]);
    return row.aggregate_version;
  }
  private audit(tx: IdentityTransaction, actor: AuthorizedActor, definitionId: string, action: string, value: unknown) {
    return this.runtime.appendAudit(tx, { entityType: 'WORKFLOW_DEFINITION', entityId: definitionId, actorType: 'USER',
      actorId: actor.principalId, action, payload: { after_hash: this.runtime.requestHash(value as JsonValue) } });
  }
  private view(row: VersionRow, actor: AuthorizedActor): JsonValue {
    return {
      definitionId: row.definition_id, workflowKey: row.workflow_key, versionNo: row.version_no, status: row.status, revision: row.revision,
      contentHash: row.content_hash, content: row.content as unknown as JsonValue,
      publishableByCurrentActor: row.status === 'DRAFT' && actor.workflowRoles.includes('WORKFLOW_PUBLISHER') && !row.editor_ids.includes(actor.principalId),
      inFlightExecutionCount: row.in_flight, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
      ...(row.published_at ? { publishedAt: row.published_at.toISOString() } : {}),
      ...(row.retired_at ? { retiredAt: row.retired_at.toISOString() } : {}),
      ...(row.revoked_at ? { revokedAt: row.revoked_at.toISOString(), revokedReasonCode: row.revoked_reason } : {}),
    };
  }
  private renderVersion = async (tx: IdentityTransaction, actor: AuthorizedActor, stored: JsonValue): Promise<JsonValue> => {
    const ref = stored as { definitionId: string; versionNo: number };
    return this.view(await this.versionRow(tx, ref.definitionId, ref.versionNo), actor);
  };

  /** Server-side context for the publish rules: tenant-published pins and other keys' bindings. */
  private async validationIssues(tx: IdentityTransaction, content: DefinitionLike, definitionId: string | null) {
    const published = new Set<string>();
    for (const ref of this.runtime.pinnedRefs(content)) {
      const { rows } = await tx.query(`SELECT 1 FROM tpa.workflow_reference_versions
        WHERE ref_kind = $1 AND ref_key = $2 AND version = $3 AND content_hash = $4 AND status = 'PUBLISHED'`, [REF_KIND[ref.kind], ref.key, ref.version, ref.hash]);
      if (rows.length) published.add(this.runtime.refKey(ref));
    }
    const { rows: bindings } = await tx.query<{ benefit_type: string; workflow_key: string }>(`SELECT b.benefit_type, d.workflow_key
      FROM tpa.workflow_scope_bindings b JOIN tpa.workflow_definitions d ON d.tenant_id = b.tenant_id AND d.id = b.definition_id
      WHERE ($1::uuid IS NULL OR b.definition_id <> $1::uuid)`, [definitionId]);
    const catalog = this.runtime.actionCatalog(content.actionCatalogVersion) ?? this.runtime.actionCatalog(1)!;
    return this.runtime.validateDefinitionContent(content, { catalog, publishedRefs: published,
      otherPublishedScopes: Object.fromEntries(bindings.map(b => [b.benefit_type, b.workflow_key])) });
  }

  list(call: WorkflowCall, query: PageQuery) {
    return this.read(call, READERS, async (tx, actor) => {
      const after = cursorDecode(actor.membershipId, query.cursor);
      if (after !== null && typeof after !== 'string') throw invalidRequest();
      const { rows } = await tx.query<{ definition_id: string; workflow_key: string; version_no: number; status: string; title: string; updated_at: Date }>(
        `SELECT DISTINCT ON (d.workflow_key) d.id::text AS definition_id, d.workflow_key, v.version_no, v.status, v.content->>'title' AS title, v.updated_at
         FROM tpa.workflow_definitions d JOIN tpa.workflow_definition_versions v ON v.tenant_id = d.tenant_id AND v.definition_id = d.id
         WHERE ($1::text IS NULL OR d.workflow_key > $1) ORDER BY d.workflow_key, v.version_no DESC LIMIT $2`, [after, query.limit + 1]);
      const items = rows.slice(0, query.limit).map(r => ({ definitionId: r.definition_id, workflowKey: r.workflow_key, versionNo: r.version_no,
        status: r.status, title: r.title, updatedAt: r.updated_at.toISOString() }));
      return { items, ...(rows.length > query.limit ? { nextCursor: cursorEncode(actor.membershipId, items[items.length - 1].workflowKey) } : {}) };
    });
  }

  listVersions(call: WorkflowCall, definitionId: string, query: PageQuery) {
    return this.read(call, READERS, async (tx, actor) => {
      const before = cursorDecode(actor.membershipId, query.cursor);
      if (before !== null && typeof before !== 'number') throw invalidRequest();
      const { rows: [definition] } = await tx.query('SELECT 1 FROM tpa.workflow_definitions WHERE id = $1', [definitionId]);
      if (!definition) throw hidden();
      const { rows } = await tx.query<{ version_no: number; status: string; title: string; updated_at: Date; workflow_key: string }>(
        `SELECT v.version_no, v.status, v.content->>'title' AS title, v.updated_at, d.workflow_key
         FROM tpa.workflow_definition_versions v JOIN tpa.workflow_definitions d ON d.tenant_id = v.tenant_id AND d.id = v.definition_id
         WHERE v.definition_id = $1 AND ($2::int IS NULL OR v.version_no < $2) ORDER BY v.version_no DESC LIMIT $3`, [definitionId, before, query.limit + 1]);
      const items = rows.slice(0, query.limit).map(r => ({ definitionId, workflowKey: r.workflow_key, versionNo: r.version_no, status: r.status,
        title: r.title, updatedAt: r.updated_at.toISOString() }));
      return { items, ...(rows.length > query.limit ? { nextCursor: cursorEncode(actor.membershipId, items[items.length - 1].versionNo) } : {}) };
    });
  }

  get(call: WorkflowCall, definitionId: string, versionNo: number) {
    return this.read(call, READERS, async (tx, actor) => this.view(await this.versionRow(tx, definitionId, versionNo), actor));
  }

  catalog(call: WorkflowCall, catalogVersion: number) {
    return this.read(call, CATALOG_READERS, async () => {
      const catalog = this.runtime.actionCatalog(catalogVersion);
      if (!catalog) throw hidden();
      return catalog as unknown as JsonValue;
    });
  }

  create(call: WorkflowCall, body: unknown) {
    return this.mutate(call, 'createWorkflowDraft', ['WORKFLOW_DESIGNER'], { schema: 'WorkflowDraftCreateRequest', body, params: null }, async (tx, actor) => {
      const { content, basedOnVersionNo } = body as { content: DefinitionLike; basedOnVersionNo?: number };
      await tx.query(`INSERT INTO tpa.workflow_definitions (tenant_id, id, workflow_key) VALUES (tpa.current_tenant_id(), $1, $2)
        ON CONFLICT (tenant_id, workflow_key) DO NOTHING`, [randomUUID(), content.workflowKey]);
      const { rows: [definition] } = await tx.query<{ id: string }>('SELECT id::text FROM tpa.workflow_definitions WHERE workflow_key = $1 FOR UPDATE', [content.workflowKey]);
      const { rows: [versions] } = await tx.query<{ max: number | null; drafts: number; based: number }>(
        `SELECT max(version_no) AS max, count(*) FILTER (WHERE status = 'DRAFT')::int AS drafts, count(*) FILTER (WHERE version_no = $2)::int AS based
         FROM tpa.workflow_definition_versions WHERE definition_id = $1`, [definition.id, basedOnVersionNo ?? null]);
      if (basedOnVersionNo !== undefined && versions.based !== 1) throw invalidRequest();
      if (versions.drafts > 0) throw stale('DRAFT_EXISTS');
      const versionNo = (versions.max ?? 0) + 1;
      const hash = this.runtime.contentHash(content);
      await tx.query(`INSERT INTO tpa.workflow_definition_versions (tenant_id, definition_id, version_no, status, revision, content, content_hash,
          action_catalog_version, benefit_types, created_by, editor_ids)
        VALUES (tpa.current_tenant_id(), $1, $2, 'DRAFT', 1, $3::jsonb, $4, $5, $6::text[], $7, ARRAY[$7::uuid])`,
      [definition.id, versionNo, JSON.stringify(content), hash, content.actionCatalogVersion, content.scope.benefitTypes, actor.principalId]);
      await this.bumpDefinition(tx, definition.id);
      await this.audit(tx, actor, definition.id, 'WORKFLOW_DRAFT_CREATED', { versionNo, contentHash: hash });
      return { status: 201, body: { definitionId: definition.id, versionNo } };
    }, this.renderVersion);
  }

  update(call: WorkflowCall, definitionId: string, versionNo: number, body: unknown) {
    return this.mutate(call, 'updateWorkflowDraft', ['WORKFLOW_DESIGNER'], { schema: 'WorkflowDraftUpdateRequest', body, params: { definitionId, versionNo } }, async (tx, actor) => {
      const { content, expectedRevision } = body as { content: DefinitionLike; expectedRevision: number };
      const definition = await this.lockDefinition(tx, definitionId);
      const row = await this.versionRow(tx, definitionId, versionNo, true);
      if (row.status !== 'DRAFT') throw stale('NOT_DRAFT');
      if (row.revision !== expectedRevision) throw stale();
      if (content.workflowKey !== definition.workflow_key) throw invalidRequest();
      const hash = this.runtime.contentHash(content);
      await tx.query(`UPDATE tpa.workflow_definition_versions SET revision = revision + 1, content = $3::jsonb, content_hash = $4,
          action_catalog_version = $5, benefit_types = $6::text[],
          editor_ids = CASE WHEN $7::uuid = ANY (editor_ids) THEN editor_ids ELSE editor_ids || $7::uuid END
        WHERE definition_id = $1 AND version_no = $2`,
      [definitionId, versionNo, JSON.stringify(content), hash, content.actionCatalogVersion, content.scope.benefitTypes, actor.principalId]);
      await this.bumpDefinition(tx, definitionId);
      await this.audit(tx, actor, definitionId, 'WORKFLOW_DRAFT_UPDATED', { versionNo, revision: expectedRevision + 1, contentHash: hash });
      return { status: 200, body: { definitionId, versionNo } };
    }, this.renderVersion);
  }

  validate(call: WorkflowCall, definitionId: string, versionNo: number) {
    return this.mutate(call, 'validateWorkflowDraft', ['WORKFLOW_DESIGNER', 'WORKFLOW_PUBLISHER'], { body: undefined, params: { definitionId, versionNo } }, async (tx, actor) => {
      const row = await this.versionRow(tx, definitionId, versionNo);
      const issues = (await this.validationIssues(tx, row.content, definitionId)).slice(0, 200);
      const report = { valid: issues.length === 0, revision: row.revision, contentHash: row.content_hash, issues: issues as unknown as JsonValue };
      // Pure check: no business state change; the report hash is audited for publish review.
      await this.audit(tx, actor, definitionId, 'WORKFLOW_DEFINITION_VALIDATED', report);
      return { status: 200, body: report };
    }, async (_tx, _actor, stored) => stored);
  }

  publish(call: WorkflowCall, definitionId: string, versionNo: number, body: unknown) {
    return this.mutate(call, 'publishWorkflowVersion', ['WORKFLOW_PUBLISHER'], { schema: 'WorkflowPublishRequest', body, params: { definitionId, versionNo } }, async (tx, actor) => {
      const { expectedRevision, contentHash } = body as { expectedRevision: number; contentHash: string };
      await this.lockDefinition(tx, definitionId); // serializes publish/revoke per workflow key
      const row = await this.versionRow(tx, definitionId, versionNo, true);
      if (row.status !== 'DRAFT') throw stale('NOT_DRAFT');
      if (row.revision !== expectedRevision || row.content_hash !== contentHash || this.runtime.contentHash(row.content) !== row.content_hash) throw stale();
      if (row.editor_ids.includes(actor.principalId)) throw forbidden('MAKER_CHECKER'); // VWF-OD-01 fail-closed default
      if ((await this.validationIssues(tx, row.content, definitionId)).length > 0) throw domain('INVALID_DEFINITION');
      const { rows: retired } = await tx.query<{ version_no: number }>(`UPDATE tpa.workflow_definition_versions SET status = 'RETIRED', retired_at = now()
        WHERE definition_id = $1 AND status = 'PUBLISHED' RETURNING version_no`, [definitionId]);
      await tx.query(`UPDATE tpa.workflow_definition_versions SET status = 'PUBLISHED', published_by = $3, published_at = now()
        WHERE definition_id = $1 AND version_no = $2`, [definitionId, versionNo, actor.principalId]);
      await tx.query('DELETE FROM tpa.workflow_scope_bindings WHERE definition_id = $1', [definitionId]);
      // A concurrent publish of another key for the same benefit type loses on the primary key.
      await tx.query(`INSERT INTO tpa.workflow_scope_bindings (tenant_id, benefit_type, definition_id, version_no)
        SELECT tpa.current_tenant_id(), b, $1, $2 FROM unnest($3::text[]) AS b`, [definitionId, versionNo, row.benefit_types])
        .catch((error: unknown) => { throw (error as { code?: string })?.code === '23505' ? domain('AMBIGUOUS_BINDING') : error; });
      const aggregateVersion = await this.bumpDefinition(tx, definitionId);
      await this.audit(tx, actor, definitionId, 'WORKFLOW_DEFINITION_PUBLISHED', { versionNo, contentHash });
      await this.runtime.appendOutboxEvent(tx, { eventType: 'workflow.definition-published', aggregateId: definitionId, aggregateVersion,
        correlationId: randomUUID(), causationId: randomUUID(),
        payload: { changeKind: 'PUBLISHED', versionNo, contentHash, ...(retired[0] ? { retiredVersionNo: retired[0].version_no } : {}) } });
      return { status: 200, body: { definitionId, versionNo } };
    }, this.renderVersion);
  }

  revoke(call: WorkflowCall, definitionId: string, versionNo: number, body: unknown) {
    return this.mutate(call, 'revokeWorkflowVersion', ['WORKFLOW_PUBLISHER'], { schema: 'WorkflowRevokeRequest', body, params: { definitionId, versionNo } }, async (tx, actor) => {
      const { contentHash, reasonCode } = body as { contentHash: string; reasonCode: string };
      await this.lockDefinition(tx, definitionId);
      const row = await this.versionRow(tx, definitionId, versionNo, true);
      if (!['PUBLISHED', 'RETIRED'].includes(row.status) || row.content_hash !== contentHash) throw stale();
      await tx.query(`UPDATE tpa.workflow_definition_versions SET status = 'REVOKED', revoked_by = $3, revoked_at = now(), revoked_reason = $4
        WHERE definition_id = $1 AND version_no = $2`, [definitionId, versionNo, actor.principalId, reasonCode]);
      await tx.query('DELETE FROM tpa.workflow_scope_bindings WHERE definition_id = $1 AND version_no = $2', [definitionId, versionNo]);
      // VWF-OD-02: never migrated; in-flight executions stop in a safe state (only supervisor escalation proceeds).
      const { rowCount } = await tx.query(`UPDATE tpa.workflow_executions SET status = 'SUSPENDED', aggregate_version = aggregate_version + 1
        WHERE definition_id = $1 AND version_no = $2 AND status = 'RUNNING'`, [definitionId, versionNo]);
      const aggregateVersion = await this.bumpDefinition(tx, definitionId);
      await this.audit(tx, actor, definitionId, 'WORKFLOW_DEFINITION_REVOKED', { versionNo, contentHash, reasonCode });
      await this.runtime.appendOutboxEvent(tx, { eventType: 'workflow.definition-revoked', aggregateId: definitionId, aggregateVersion,
        correlationId: randomUUID(), causationId: randomUUID(),
        payload: { changeKind: 'REVOKED', versionNo, contentHash, reasonCode, suspendedExecutionCount: rowCount ?? 0 } });
      return { status: 200, body: { definitionId, versionNo } };
    }, this.renderVersion);
  }
}
