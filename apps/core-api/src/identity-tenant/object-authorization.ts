import { IdentityError } from './identity-error.ts';
import { UUID } from './identity-context.ts';
import type { IdentityStore } from './identity-store.ts';
import type { VerifiedIdentity } from './oidc-verifier.ts';
import type { AuthorizedActor, IdentityTransaction, ObjectRequirement, ObjectScope } from './identity.types.ts';

/**
 * SELF links are usable only with the MEMBER role; GUARDIAN links only with the GUARDIAN role.
 * Holding both roles never lets a SELF link stand in for a guardian link or vice versa.
 */
export function memberRelationAllows(actor: AuthorizedActor, memberId: string | undefined): boolean {
  if (!memberId || !UUID.test(memberId)) return false;
  return actor.memberGrants.some(g => g.memberId === memberId
    && ((g.relation === 'SELF' && actor.roles.includes('MEMBER')) || (g.relation === 'GUARDIAN' && actor.roles.includes('GUARDIAN'))));
}
/** Domain resolution, authorization and effect share ONE tenant transaction. No cached actor authorization. */
export async function withObjectAccess<T>(store: IdentityStore, identity: VerifiedIdentity, context: unknown,
  requestedId: string, requirement: ObjectRequirement,
  resolve: (tx: IdentityTransaction, id: string) => Promise<ObjectScope | null>,
  effect: (tx: IdentityTransaction, actor: AuthorizedActor, object: ObjectScope) => Promise<T>): Promise<T> {
  const hidden = () => new IdentityError(404, 'NOT_FOUND');
  if (!UUID.test(requestedId)) throw hidden();
  return store.withMembership(identity, context, async (tx, actor) => {
    const object = await resolve(tx, requestedId);
    if (!object || object.id !== requestedId || object.kind !== requirement.kind) throw hidden();
    const owned = requirement.allowMember === true && memberRelationAllows(actor, object.memberId);
    if (!owned) {
      const roles = [...actor.roles, ...actor.workflowRoles];
      if (!requirement.requiredRoles.length || !requirement.requiredRoles.some(r => roles.includes(r))) throw hidden();
      const { rows } = await tx.query(`SELECT 1 FROM tpa.identity_object_assignments WHERE membership_id=$1 AND active AND action=$2
        AND ((object_kind=$3 AND object_id=$4) OR (object_kind='CLAIM' AND object_id=$5 AND $3='DOCUMENT')) LIMIT 1`,
      [actor.membershipId, requirement.action, object.kind, object.id, object.parentClaimId ?? null]);
      if (!rows.length) throw hidden();
    }
    return effect(tx, actor, object);
  });
}
