import type pg from 'pg';

export interface IdentityTransaction { query<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, values?: unknown[]): Promise<pg.QueryResult<R>> }
export interface IdentityTenantDatabase {
  withTenantTransaction<T>(tenantId: string, fn: (tx: IdentityTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export const BASE_ROLES = ['MEMBER', 'GUARDIAN', 'CLAIM_REVIEWER', 'INSURER_REVIEWER', 'FINANCE', 'CURATOR'] as const;
export type BaseRole = typeof BASE_ROLES[number];
export const WORKFLOW_ROLES = ['WORKFLOW_DESIGNER', 'WORKFLOW_PUBLISHER', 'WORKFLOW_SUPERVISOR', 'WORKFLOW_OBSERVER'] as const;
export type WorkflowRole = typeof WORKFLOW_ROLES[number];
export type MemberRelation = 'SELF' | 'GUARDIAN';
/** Server-provisioned enrollment link. SELF needs the MEMBER role, GUARDIAN the GUARDIAN role. */
export interface MemberGrant { readonly memberId: string; readonly relation: MemberRelation }
export interface MembershipView { membershipId: string; roles: BaseRole[]; memberIds: string[]; version: number }
export interface MeView { principalId: string; memberships: MembershipView[]; mfaVerified: boolean }
export interface MembershipContextView { membershipId: string; expiresAt: string; contextToken: string }
export interface AuthorizedActor {
  readonly tenantId: string; readonly principalId: string; readonly membershipId: string; readonly version: number;
  readonly roles: readonly BaseRole[]; readonly memberIds: readonly string[]; readonly memberGrants: readonly MemberGrant[]; readonly workflowRoles: readonly WorkflowRole[];
}
export type ObjectKind = 'CLAIM' | 'DOCUMENT' | 'POLICY' | 'WORKFLOW_DEFINITION' | 'WORKFLOW_TASK';
export type ObjectAction = 'READ' | 'WRITE';
export interface ObjectRequirement {
  kind: ObjectKind; action: ObjectAction; requiredRoles: readonly (BaseRole | typeof WORKFLOW_ROLES[number])[];
  /** Domain operation must explicitly allow member/guardian access. Never inferred from HTTP verbs. */
  allowMember?: boolean;
}
/** Returned by a trusted domain repository inside the same tenant transaction, never by a request body. */
export interface ObjectScope { id: string; kind: ObjectKind; memberId?: string; parentClaimId?: string }
