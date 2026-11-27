import { randomUUID } from 'node:crypto';
import { memberRelationAllows, withObjectAccess } from './object-authorization.ts';
import type { IdentityStore } from './identity-store.ts';
import type { VerifiedIdentity } from './oidc-verifier.ts';
import type { AuthorizedActor, BaseRole, MemberGrant, ObjectRequirement, ObjectScope, WorkflowRole } from './identity.types.ts';

const identity = {} as VerifiedIdentity;
function actorWith(roles: BaseRole[], grants: MemberGrant[] = [], workflowRoles: WorkflowRole[] = []): AuthorizedActor {
  return Object.freeze({ tenantId: randomUUID(), principalId: randomUUID(), membershipId: randomUUID(), version: 1, roles,
    memberIds: grants.map(g => g.memberId), memberGrants: grants, workflowRoles });
}
/** Fake store runs the callback like withMembership; tx records assignment lookups. */
function harness(actor: AuthorizedActor, assigned = false) {
  const query = jest.fn(async (_sql: string, _values: unknown[]) => ({ rows: assigned ? [{ '?column?': 1 }] : [] }));
  const store = { withMembership: jest.fn(async (_i: unknown, _c: unknown, fn: (tx: unknown, a: AuthorizedActor) => unknown) => fn({ query }, actor)) };
  return { store: store as unknown as IdentityStore, query };
}
const claimRead: ObjectRequirement = { kind: 'CLAIM', action: 'READ', requiredRoles: ['CLAIM_REVIEWER'], allowMember: true };
async function access(actor: AuthorizedActor, object: ObjectScope, requirement = claimRead, assigned = false) {
  const { store, query } = harness(actor, assigned), effect = jest.fn(async () => 'ok');
  const result = withObjectAccess(store, identity, 'ctx', object.id, requirement, async () => object, effect);
  return { result, effect, query };
}
const hidden = { status: 404, code: 'NOT_FOUND' };

describe('object authorization: SELF/MEMBER vs GUARDIAN and staff assignment', () => {
  const member = randomUUID(), dependant = randomUUID();
  const claim = (memberId?: string): ObjectScope => ({ id: randomUUID(), kind: 'CLAIM', memberId });

  it('MEMBER reaches only its SELF-linked member objects', async () => {
    const actor = actorWith(['MEMBER'], [{ memberId: member, relation: 'SELF' }]);
    const own = await access(actor, claim(member));
    await expect(own.result).resolves.toBe('ok');
    expect(own.query).not.toHaveBeenCalled();
    await expect((await access(actor, claim(randomUUID()))).result).rejects.toMatchObject(hidden);
  });

  it('a GUARDIAN-relation link is useless without the GUARDIAN role, and SELF without MEMBER', async () => {
    const memberOnly = actorWith(['MEMBER'], [{ memberId: dependant, relation: 'GUARDIAN' }]);
    await expect((await access(memberOnly, claim(dependant))).result).rejects.toMatchObject(hidden);
    const guardianOnly = actorWith(['GUARDIAN'], [{ memberId: member, relation: 'SELF' }]);
    await expect((await access(guardianOnly, claim(member))).result).rejects.toMatchObject(hidden);
  });

  it('GUARDIAN reaches dependants it is linked to, not other members', async () => {
    const actor = actorWith(['MEMBER', 'GUARDIAN'], [{ memberId: member, relation: 'SELF' }, { memberId: dependant, relation: 'GUARDIAN' }]);
    await expect((await access(actor, claim(dependant))).result).resolves.toBe('ok');
    await expect((await access(actor, claim(member))).result).resolves.toBe('ok');
    await expect((await access(actor, claim(randomUUID()))).result).rejects.toMatchObject(hidden);
    expect(memberRelationAllows(actor, undefined)).toBe(false);
    expect(memberRelationAllows(actor, 'not-a-uuid')).toBe(false);
  });

  it('operations that do not allow member access ignore member links entirely', async () => {
    const actor = actorWith(['MEMBER'], [{ memberId: member, relation: 'SELF' }]);
    const staffOnly: ObjectRequirement = { ...claimRead, allowMember: false };
    const attempt = await access(actor, claim(member), staffOnly, true);
    await expect(attempt.result).rejects.toMatchObject(hidden);
    expect(attempt.effect).not.toHaveBeenCalled();
  });

  it('staff need both a required role AND an active assignment for this membership', async () => {
    const reviewer = actorWith(['CLAIM_REVIEWER']), object = claim(member);
    const unassigned = await access(reviewer, object);
    await expect(unassigned.result).rejects.toMatchObject(hidden);
    const assigned = await access(reviewer, object, claimRead, true);
    await expect(assigned.result).resolves.toBe('ok');
    expect(assigned.query.mock.calls[0][1]).toEqual([reviewer.membershipId, 'READ', 'CLAIM', object.id, null]);
    const finance = await access(actorWith(['FINANCE']), object, claimRead, true);
    await expect(finance.result).rejects.toMatchObject(hidden);
    expect(finance.query).not.toHaveBeenCalled();
  });

  it('documents inherit only the resolved parent claim assignment, never a client-supplied parent', async () => {
    const reviewer = actorWith(['CLAIM_REVIEWER']), parent = randomUUID();
    const doc: ObjectScope = { id: randomUUID(), kind: 'DOCUMENT', parentClaimId: parent };
    const attempt = await access(reviewer, doc, { kind: 'DOCUMENT', action: 'READ', requiredRoles: ['CLAIM_REVIEWER'] }, true);
    await expect(attempt.result).resolves.toBe('ok');
    expect(attempt.query.mock.calls[0][1]).toEqual([reviewer.membershipId, 'READ', 'DOCUMENT', doc.id, parent]);
  });

  it('spoofed/mismatched object ids or kinds are hidden as 404 before any effect', async () => {
    const actor = actorWith(['MEMBER'], [{ memberId: member, relation: 'SELF' }]);
    const { store } = harness(actor), effect = jest.fn();
    await expect(withObjectAccess(store, identity, 'ctx', 'forged', claimRead, async () => claim(member), effect)).rejects.toMatchObject(hidden);
    expect((store.withMembership as jest.Mock)).not.toHaveBeenCalled();
    await expect(withObjectAccess(store, identity, 'ctx', randomUUID(), claimRead, async () => claim(member), effect)).rejects.toMatchObject(hidden);
    const wrongKind: ObjectScope = { id: randomUUID(), kind: 'POLICY', memberId: member };
    await expect(withObjectAccess(store, identity, 'ctx', wrongKind.id, claimRead, async () => wrongKind, effect)).rejects.toMatchObject(hidden);
    await expect(withObjectAccess(store, identity, 'ctx', randomUUID(), claimRead, async () => null, effect)).rejects.toMatchObject(hidden);
    expect(effect).not.toHaveBeenCalled();
  });
});
