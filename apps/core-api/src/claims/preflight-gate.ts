import type { AuthorizedActor, IdentityTransaction } from '../identity-tenant/identity.types.ts';

export interface PreflightReference {
  readonly preflightId: string; readonly expectedVersion: number; readonly memberId: string;
  readonly benefitType: string; readonly documentIds: readonly string[];
}
/**
 * Seam owned by CLM-01 (#36). Runs inside the submit tenant transaction so the owner can lock its preflight row.
 * MATCH: completed preflight of this exact version for the same actor/member/benefit/documents.
 * STALE: exists but another version (or still pending); NOT_FOUND: missing/foreign/inaccessible.
 * No implementation is provided here: an unconfigured gate fails closed (503), never a silent pass.
 */
export type PreflightVerdict = 'MATCH' | 'STALE' | 'NOT_FOUND';
export interface ClaimPreflightGate {
  verify(tx: IdentityTransaction, actor: AuthorizedActor, reference: PreflightReference): Promise<PreflightVerdict>;
}
