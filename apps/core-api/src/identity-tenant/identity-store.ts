import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { databaseRuntime, type DatabaseRuntime } from './database-runtime.ts';
import { IdentityContextCodec, UUID } from './identity-context.ts';
import { denied, IdentityError, unavailable } from './identity-error.ts';
import { assertVerifiedIdentity, type VerifiedIdentity } from './oidc-verifier.ts';
import type { AuthorizedActor, BaseRole, MemberGrant, MemberRelation, IdentityTenantDatabase, IdentityTransaction, MeView, MembershipContextView, MembershipView, WorkflowRole } from './identity.types.ts';

interface Directory { principal_id: string; tenant_id: string; membership_id: string }
interface Grant extends MembershipView { principalId: string; principalVersion: number; workflowRoles: WorkflowRole[]; memberGrants: MemberGrant[] }
interface ContextRow { id: string; membership_version: number; principal_version: number; token_hash: string; expires_at: Date }

export class IdentityStore {
  private readonly pool: pg.Pool;
  private readonly database: IdentityTenantDatabase;
  private readonly codec: IdentityContextCodec;
  private readonly runtime: DatabaseRuntime;
  constructor(pool: pg.Pool, database: IdentityTenantDatabase, codec: IdentityContextCodec, runtime: DatabaseRuntime) {
    this.pool = pool; this.database = database; this.codec = codec; this.runtime = runtime;
  }
  static async connect(connectionString: string, contextKey: Uint8Array): Promise<IdentityStore> {
    const runtime = await databaseRuntime();
    return new IdentityStore(new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 3000 }),
      runtime.createTenantDatabase({ connectionString, max: 4, connectionTimeoutMillis: 3000 }), new IdentityContextCodec(contextKey), runtime);
  }
  async close(): Promise<void> { await Promise.all([this.pool.end(), this.database.close()]); }
  private async discover(identity: VerifiedIdentity): Promise<{ principalId: string; directories: Directory[] }> {
    assertVerifiedIdentity(identity);
    const client = await this.pool.connect();
    try {
      const { rows: [role] } = await client.query(`SELECT current_user AS name, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname=current_user`);
      if (role.name !== 'tpa_app' || Object.entries(role).some(([k, v]) => k !== 'name' && v !== false)) throw unavailable();
      // Only global identity discovery metadata is accessed here. No tenant/business rows.
      await client.query('BEGIN READ ONLY');
      await client.query("SELECT pg_catalog.set_config('app.identity_hash', $1, true)", [identity.identityHash]);
      const { rows: [principal] } = await client.query<{ id: string }>(`SELECT id FROM tpa.identity_principals WHERE identity_hash=$1 AND active AND kind='HUMAN'`, [identity.identityHash]);
      if (!principal) throw denied();
      const { rows } = await client.query<Directory>(`SELECT principal_id, tenant_id, membership_id FROM tpa.identity_membership_directory WHERE principal_id=$1 ORDER BY membership_id LIMIT 101`, [principal.id]);
      if (rows.length > 100) throw unavailable();
      await client.query('COMMIT');
      return { principalId: principal.id, directories: rows };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error instanceof IdentityError ? error : unavailable(); }
    finally { client.release(); }
  }
  /**
   * Principal-scoped transaction for data that belongs to a person, not a tenant (NOTIF-01 personal inbox).
   * No tenant context is set, so any tenant table access fails closed (tpa.current_tenant_id() raises 42501);
   * principal-scoped RLS reads app.identity_hash (SET LOCAL via set_config(..., true)). No tenant=NULL bypass.
   */
  async withPrincipal<T>(identity: VerifiedIdentity, fn: (tx: IdentityTransaction, principalId: string) => Promise<T>): Promise<T> {
    assertVerifiedIdentity(identity);
    const client = await this.pool.connect();
    let began = false;
    try {
      const { rows: [role] } = await client.query(`SELECT current_user AS name, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname=current_user`);
      if (role.name !== 'tpa_app' || Object.entries(role).some(([k, v]) => k !== 'name' && v !== false)) throw unavailable();
      await client.query('BEGIN'); began = true;
      await client.query("SELECT pg_catalog.set_config('app.identity_hash', $1, true)", [identity.identityHash]);
      const { rows: [principal] } = await client.query<{ id: string }>(
        `SELECT id FROM tpa.identity_principals WHERE identity_hash=$1 AND active AND kind='HUMAN' FOR SHARE`, [identity.identityHash]);
      if (!principal) throw denied();
      const tx: IdentityTransaction = Object.freeze({ query: <R extends pg.QueryResultRow>(sql: string, values?: unknown[]) => client.query<R>(sql, values) });
      const value = await fn(tx, principal.id);
      await client.query('COMMIT'); began = false;
      return value;
    } catch (error) {
      if (began) await client.query('ROLLBACK').catch(() => {});
      throw error instanceof IdentityError ? error : unavailable();
    } finally { client.release(); }
  }
  private async inTenant<T>(identity: VerifiedIdentity, directory: Directory, fn: (tx: IdentityTransaction, grant: Grant) => Promise<T>): Promise<T> {
    try {
      return await this.database.withTenantTransaction(directory.tenant_id, async tx => {
        await tx.query("SELECT pg_catalog.set_config('app.identity_hash', $1, true)", [identity.identityHash]);
        // Narrow SECURITY DEFINER lock, FORCE RLS still applies. Grants cannot change during the callback.
        // The lock raises insufficient_privilege for a revoked/inactive grant: that is a denial, not an outage.
        await tx.query('SELECT tpa.identity_lock_membership($1)', [directory.membership_id])
          .catch((error: unknown) => { throw (error as { code?: unknown })?.code === '42501' ? denied() : error; });
        assertVerifiedIdentity(identity);
        // Principal row is share-locked above; its version invalidates contexts on deactivate/kind changes.
        const { rows: [principal] } = await tx.query<{ version: number }>(
          `SELECT version FROM tpa.identity_principals WHERE id=$1 AND active AND kind='HUMAN'`, [directory.principal_id]);
        if (!principal) throw denied();
        const { rows: [row] } = await tx.query<{ id: string; principal_id: string; roles: BaseRole[]; workflow_roles: WorkflowRole[]; version: number }>(
          `SELECT id, principal_id, roles, workflow_roles, version FROM tpa.identity_memberships WHERE id=$1 AND principal_id=$2 AND active`, [directory.membership_id, directory.principal_id]);
        if (!row) throw denied();
        const { rows: members } = await tx.query<{ member_id: string; relation: MemberRelation }>(`SELECT member_id, relation FROM tpa.identity_member_grants WHERE membership_id=$1 AND active ORDER BY member_id LIMIT 101`, [row.id]);
        if (members.length > 100) throw unavailable();
        return fn(tx, { membershipId: row.id, principalId: row.principal_id, principalVersion: principal.version, roles: row.roles,
          workflowRoles: row.workflow_roles, memberIds: members.map(m => m.member_id),
          memberGrants: members.map(m => ({ memberId: m.member_id, relation: m.relation })), version: row.version });
      });
    } catch (error) { throw error instanceof IdentityError ? error : unavailable(); }
  }
  async me(identity: VerifiedIdentity): Promise<MeView> {
    const { principalId, directories } = await this.discover(identity), memberships: MembershipView[] = [];
    for (const directory of directories) {
      // Revoked entries stay in the directory until trusted cleanup; do not expose them.
      try {
        const grant = await this.inTenant(identity, directory, async (_tx, g) => g);
        memberships.push({ membershipId: grant.membershipId, roles: grant.roles, memberIds: grant.memberIds, version: grant.version });
      } catch (error) { if (!(error instanceof IdentityError) || error.code !== 'FORBIDDEN') throw error; }
    }
    return { principalId, memberships, mfaVerified: identity.mfaValidUntil * 1000 > Date.now() };
  }
  async select(identity: VerifiedIdentity, membershipId: string, key: string): Promise<{ view: MembershipContextView; replayed: boolean }> {
    const { directories } = await this.discover(identity), directory = directories.find(d => d.membership_id === membershipId);
    if (!directory) throw denied();
    return this.inTenant(identity, directory, async (tx, grant) => {
      this.requireAssurance(identity, grant);
      const scope = { actorType: 'USER' as const, actorId: grant.principalId, operation: 'selectMembership', key };
      const hash = this.runtime.requestHash({ membershipId, tokenHash: identity.tokenHash });
      const begin = await this.runtime.beginIdempotent(tx, scope, hash);
      if (begin.kind === 'conflict' || begin.kind === 'expired') throw new IdentityError(409, 'IDEMPOTENCY_CONFLICT');
      if (begin.kind === 'in_progress') throw new IdentityError(409, 'OPERATION_IN_PROGRESS');
      const create = async () => {
        const contextId = randomUUID();
        // DB clock caps the lifetime so it always satisfies the 15-minute CHECK.
        await tx.query(`INSERT INTO tpa.identity_contexts(tenant_id,id,membership_id,principal_id,membership_version,principal_version,token_hash,expires_at)
          VALUES(tpa.current_tenant_id(),$1,$2,$3,$4,$5,$6,LEAST(to_timestamp($7),now()+interval '15 minutes'))`, [contextId, membershipId, grant.principalId, grant.version, grant.principalVersion, identity.tokenHash, identity.expiresAt]);
        await this.runtime.appendAudit(tx, { entityType: 'MEMBERSHIP_CONTEXT', entityId: contextId, actorType: 'USER', actorId: grant.principalId,
          action: 'MEMBERSHIP_CONTEXT_CREATED', payload: { after_hash: this.runtime.requestHash({ membershipId, version: grant.version, principalVersion: grant.principalVersion }) } });
        // Durable idempotency stores only an internal UUID, never a bearer/context token.
        return { status: 200, body: { contextId } };
      };
      const response = begin.kind === 'acquired' ? await this.runtime.runOwnedEffect(tx, scope, begin.ownerToken, begin.attempt, create) : begin.response;
      const id = (response.body as { contextId?: unknown })?.contextId;
      if (typeof id !== 'string' || !UUID.test(id)) throw unavailable();
      const context = await this.readContext(tx, identity, grant, id);
      return { view: { membershipId, expiresAt: context.expires_at.toISOString(), contextToken: this.codec.encode(identity, membershipId, id) }, replayed: begin.kind === 'replayed' };
    });
  }
  private requireAssurance(identity: VerifiedIdentity, grant: Grant): void {
    const staff = grant.roles.some(role => role !== 'MEMBER' && role !== 'GUARDIAN') || grant.workflowRoles.length > 0;
    if (staff && identity.mfaValidUntil * 1000 <= Date.now()) throw denied();
  }
  private async readContext(tx: IdentityTransaction, identity: VerifiedIdentity, grant: Grant, id: string): Promise<ContextRow> {
    const { rows: [row] } = await tx.query<ContextRow>(`SELECT id,membership_version,principal_version,token_hash,expires_at FROM tpa.identity_contexts WHERE id=$1 AND membership_id=$2 AND principal_id=$3`, [id, grant.membershipId, grant.principalId]);
    if (!row || row.token_hash !== identity.tokenHash) throw denied();
    if (row.membership_version !== grant.version || row.principal_version !== grant.principalVersion || row.expires_at.getTime() <= Date.now()) throw new IdentityError(409, 'STALE_VERSION');
    return row;
  }
  async withMembership<T>(identity: VerifiedIdentity, contextToken: unknown, fn: (tx: IdentityTransaction, actor: AuthorizedActor) => Promise<T>): Promise<T> {
    const context = this.codec.decode(identity, contextToken), { directories } = await this.discover(identity);
    const directory = directories.find(d => d.membership_id === context.membershipId);
    if (!directory) throw denied();
    return this.inTenant(identity, directory, async (tx, grant) => {
      this.requireAssurance(identity, grant); await this.readContext(tx, identity, grant, context.contextId);
      const actor = Object.freeze({ tenantId: directory.tenant_id, principalId: grant.principalId, membershipId: grant.membershipId,
        version: grant.version, roles: Object.freeze([...grant.roles]), memberIds: Object.freeze([...grant.memberIds]),
        memberGrants: Object.freeze(grant.memberGrants.map(g => Object.freeze({ ...g }))), workflowRoles: Object.freeze([...grant.workflowRoles]) });
      return fn(tx, actor);
    });
  }
}
