// AUTH-01 PG16 integration: real migrations, real non-privileged tpa_app role, FORCE RLS, synthetic OIDC issuer.
// Synthetic identities/UUIDs only. Not real-provider acceptance (#12/#13 gate that separately).
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '@tpa/database/migrate';
import { createTenantDatabase } from '@tpa/database/tenant';
import { IdentityStore } from '../src/identity-tenant/identity-store.ts';
import { OidcVerifier, identityHash } from '../src/identity-tenant/oidc-verifier.ts';
import { withObjectAccess } from '../src/identity-tenant/object-authorization.ts';
import { syntheticIssuer } from './fixtures/synthetic-issuer.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const image = 'pgvector/pgvector:0.8.7-pg16-trixie@sha256:c28c0b700f3f1b5eec14082b31ad6e7c8a566d14386323609c615315e7c0ffc8';
function docker(...args) {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 150000 }).trim(); }
  catch { throw new Error(`Synthetic Docker ${args[0]} failed (output suppressed)`); }
}
const denied = { status: 403, code: 'FORBIDDEN' }, hidden = { status: 404, code: 'NOT_FOUND' }, stale = { status: 409, code: 'STALE_VERSION' };

test('AUTH-01 PG16: verified principal, tenant membership, MFA gate and object RBAC (PT01/PT17 synthetic)', async t => {
  const name = `tpa-auth01-${randomBytes(6).toString('hex')}`, password = randomBytes(24).toString('hex');
  let started = false, admin, store, issuer, appDb;
  try {
    docker('run', '-d', '--name', name, '--label', `ao.session=${process.env.AO_SESSION_ID ?? name}`,
      '--memory', '384m', '--cpus', '1', '--tmpfs', '/var/lib/postgresql/data:rw,size=512m', '-p', '127.0.0.1::5432',
      '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=tpa', image); started = true;
    const port = docker('port', name, '5432/tcp').split(':').at(-1);
    const url = user => `postgresql://${user}:${password}@127.0.0.1:${port}/tpa`;
    const deadline = Date.now() + 40000;
    while (!admin) {
      const c = new pg.Client({ connectionString: url('postgres'), connectionTimeoutMillis: 2000 });
      try { await c.connect(); admin = c; }
      catch { await c.end().catch(() => {}); if (Date.now() > deadline) throw new Error('Synthetic PG16 readiness timed out'); await delay(250); }
    }
    assert.match((await admin.query('SHOW server_version')).rows[0].server_version, /^16\./);
    await admin.query(await readFile(`${root}infra/migrations/bootstrap.sql`, 'utf8'));
    for (const role of ['tpa_app', 'tpa_migrator']) {
      const { rows: [command] } = await admin.query("SELECT format('ALTER ROLE %I PASSWORD %L',$1::text,$2::text) AS sql", [role, password]);
      await admin.query(command.sql);
    }
    await migrateDatabase(url('tpa_migrator'));
    issuer = await syntheticIssuer();
    const verifier = new OidcVerifier(issuer.profile);
    store = await IdentityStore.connect(url('tpa_app'), randomBytes(32));
    const login = async (subject, claims = {}) => verifier.verifyAuthorization(`Bearer ${await issuer.token(subject, claims)}`);
    const weak = { acr: 'urn:synthetic:password', amr: ['pwd'] };

    // Trusted provisioner (superuser here) issues all grants; the app role has no write path for them.
    const T1 = randomUUID(), T2 = randomUUID();
    const alice = randomUUID(), bob = randomUUID();
    const aliceT1 = randomUUID(), aliceT2 = randomUUID(), bobT1 = randomUUID();
    const mSelf = randomUUID(), mChild = randomUUID(), mBob = randomUUID(), claimX = randomUUID(), claimY = randomUUID();
    await admin.query(`INSERT INTO tpa.identity_principals(id,identity_hash) VALUES($1,$2),($3,$4)`,
      [alice, identityHash(issuer.profile.issuer, 'alice-sub'), bob, identityHash(issuer.profile.issuer, 'bob-sub')]);
    await admin.query(`INSERT INTO tpa.identity_memberships(tenant_id,id,principal_id,roles) VALUES
      ($1,$2,$3,ARRAY['MEMBER','GUARDIAN']),($4,$5,$3,ARRAY['CLAIM_REVIEWER']),($1,$6,$7,ARRAY['MEMBER'])`, [T1, aliceT1, alice, T2, aliceT2, bobT1, bob]);
    await admin.query(`INSERT INTO tpa.identity_membership_directory(membership_id,tenant_id,principal_id) VALUES($1,$2,$3),($4,$5,$3),($6,$2,$7)`,
      [aliceT1, T1, alice, aliceT2, T2, bobT1, bob]);
    await admin.query(`INSERT INTO tpa.identity_member_grants(tenant_id,membership_id,member_id,relation) VALUES
      ($1,$2,$3,'SELF'),($1,$2,$4,'GUARDIAN'),($1,$5,$6,'SELF')`, [T1, aliceT1, mSelf, mChild, bobT1, mBob]);
    await admin.query(`INSERT INTO tpa.identity_object_assignments(tenant_id,membership_id,object_kind,object_id,action) VALUES($1,$2,'CLAIM',$3,'READ')`, [T2, aliceT2, claimX]);
    // Synthetic domain resolver: future claim repositories resolve these inside the same tenant transaction.
    const objects = new Map([[claimX, { tenant: T2, memberId: mBob }], [claimY, { tenant: T2 }], [randomUUID(), { tenant: T1, memberId: mSelf }]]);
    const claimFor = memberId => { const id = randomUUID(); objects.set(id, { tenant: T1, memberId }); return id; };
    const resolve = async (tx, id) => {
      const tenant = (await tx.query('SELECT tpa.current_tenant_id() AS id')).rows[0].id, o = objects.get(id);
      return o && o.tenant === tenant ? { id, kind: 'CLAIM', memberId: o.memberId } : null;
    };
    const memberRead = { kind: 'CLAIM', action: 'READ', requiredRoles: ['CLAIM_REVIEWER'], allowMember: true };
    const select = async (identity, membershipId) => (await store.select(identity, membershipId, randomUUID())).view.contextToken;
    const access = (identity, ctx, id, requirement = memberRead) => withObjectAccess(store, identity, ctx, id, requirement, resolve, async (_tx, actor) => actor.membershipId);

    await t.test('me: server grants only, unknown principal denied, weak MFA reported', async () => {
      const a = await login('alice-sub', weak), me = await store.me(a);
      assert.equal(me.principalId, alice); assert.equal(me.mfaVerified, false);
      assert.deepEqual(me.memberships.map(m => m.membershipId).sort(), [aliceT1, aliceT2].sort());
      assert.deepEqual(me.memberships.find(m => m.membershipId === aliceT2).roles, ['CLAIM_REVIEWER']);
      const b = await store.me(await login('bob-sub'));
      assert.deepEqual(b.memberships.map(m => m.membershipId), [bobT1]);
      assert.doesNotMatch(JSON.stringify(b), new RegExp(`${alice}|${aliceT1}|${aliceT2}|${mSelf}`));
      await assert.rejects(store.me(await login('stranger-sub')), denied);
    });

    await t.test('select: staff MFA gate, spoofed membership denied, idempotent replay, audit without token', async () => {
      await assert.rejects(store.select(await login('alice-sub', weak), aliceT2, randomUUID()), denied);
      await assert.rejects(store.select(await login('bob-sub'), aliceT1, randomUUID()), denied);
      await assert.rejects(store.select(await login('bob-sub'), randomUUID(), randomUUID()), denied);
      const a = await login('alice-sub'), key = randomUUID();
      const first = await store.select(a, aliceT2, key), again = await store.select(a, aliceT2, key);
      assert.equal(first.replayed, false); assert.equal(again.replayed, true);
      assert.equal(again.view.contextToken, first.view.contextToken);
      await assert.rejects(store.select(await login('alice-sub'), aliceT2, key), { status: 409, code: 'IDEMPOTENCY_CONFLICT' });
      // Member-only membership needs no staff MFA.
      assert.ok(await select(await login('alice-sub', weak), aliceT1));
      const audit = await admin.query(`SELECT count(*)::int AS n FROM tpa.audit_logs WHERE tenant_id=$1 AND action='MEMBERSHIP_CONTEXT_CREATED'`, [T2]);
      assert.equal(audit.rows[0].n, 1);
      const stored = JSON.stringify((await admin.query('SELECT response_body FROM tpa.idempotency_records WHERE tenant_id=$1', [T2])).rows);
      assert.ok(!stored.includes(first.view.contextToken.split('.')[1]) && !stored.includes('alice-sub'));
    });

    await t.test('PT01: context bound to token; RLS hides other tenants/principals; grants not writable by app', async () => {
      const a = await login('alice-sub'), ctx = await select(a, aliceT1);
      await assert.rejects(store.withMembership(await login('bob-sub'), ctx, async () => 1), denied);
      await assert.rejects(store.withMembership(await login('alice-sub'), ctx, async () => 1), denied);
      const seen = await store.withMembership(a, ctx, async (tx, actor) => {
        const count = async sql => (await tx.query(sql)).rows[0].n;
        return { tenant: actor.tenantId, membershipId: actor.membershipId,
          memberships: await count('SELECT count(*)::int AS n FROM tpa.identity_memberships'),
          directory: await count('SELECT count(*)::int AS n FROM tpa.identity_membership_directory'),
          principals: await count('SELECT count(*)::int AS n FROM tpa.identity_principals'),
          assignments: await count('SELECT count(*)::int AS n FROM tpa.identity_object_assignments'),
          grants: await count('SELECT count(*)::int AS n FROM tpa.identity_member_grants') };
      });
      // Only alice's own T1 membership/grants; directory shows only alice's own entries; bob and T2 assignment invisible.
      assert.deepEqual(seen, { tenant: T1, membershipId: aliceT1, memberships: 1, directory: 2, principals: 1, assignments: 0, grants: 2 });
      // The shared tenant wrapper fails a whole transaction on ANY query error, so each forbidden write gets
      // its own real tpa_app transaction with the same SET LOCAL tenant + verified identity the store uses.
      appDb ??= createTenantDatabase({ connectionString: url('tpa_app'), max: 2 });
      const writes = {};
      for (const [label, sql, values] of [
          ['grant', `INSERT INTO tpa.identity_member_grants(tenant_id,membership_id,member_id,relation) VALUES(tpa.current_tenant_id(),$1,$2,'GUARDIAN')`, [aliceT1, mBob]],
          ['assignment', `INSERT INTO tpa.identity_object_assignments(tenant_id,membership_id,object_kind,object_id,action) VALUES(tpa.current_tenant_id(),$1,'CLAIM',$2,'WRITE')`, [aliceT1, claimY]],
          ['membership', `UPDATE tpa.identity_memberships SET roles=ARRAY['FINANCE'] WHERE id=$1`, [aliceT1]],
          ['context', `UPDATE tpa.identity_contexts SET expires_at=expires_at WHERE membership_id=$1`, [aliceT1]],
          ['forged-context', `INSERT INTO tpa.identity_contexts(tenant_id,id,membership_id,principal_id,membership_version,principal_version,token_hash,expires_at)
            VALUES(tpa.current_tenant_id(),$1,$2,$3,1,1,$4,now()+interval '1 minute')`, [randomUUID(), bobT1, bob, 'a'.repeat(64)]],
      ]) {
        try {
          await appDb.withTenantTransaction(T1, async tx => {
            await tx.query("SELECT pg_catalog.set_config('app.identity_hash', $1, true)", [a.identityHash]);
            await tx.query(sql, values);
          });
          writes[label] = 'ALLOWED';
        } catch (error) { writes[label] = error.code; }
      }
      assert.deepEqual(writes, { grant: '42501', assignment: '42501', membership: '42501', context: '42501', 'forged-context': '42501' });
    });

    await t.test('PT17: SELF/GUARDIAN member links and staff assignment, everything else hidden', async () => {
      const a = await login('alice-sub'), b = await login('bob-sub');
      const aliceCtx = await select(a, aliceT1), bobCtx = await select(b, bobT1), reviewCtx = await select(a, aliceT2);
      assert.equal(await access(a, aliceCtx, claimFor(mSelf)), aliceT1);
      assert.equal(await access(a, aliceCtx, claimFor(mChild)), aliceT1);
      await assert.rejects(access(a, aliceCtx, claimFor(mBob)), hidden);
      await assert.rejects(access(b, bobCtx, claimFor(mChild)), hidden);
      assert.equal(await access(b, bobCtx, claimFor(mBob)), bobT1);
      // Cross-tenant: a T1 context cannot resolve the T2 claim even for a member it belongs to.
      await assert.rejects(access(b, bobCtx, claimX), hidden);
      // Staff: assigned READ only; WRITE, unassigned objects and member-path-only rules are hidden.
      assert.equal(await access(a, reviewCtx, claimX), aliceT2);
      await assert.rejects(access(a, reviewCtx, claimX, { ...memberRead, action: 'WRITE' }), hidden);
      await assert.rejects(access(a, reviewCtx, claimY), hidden);
      await assert.rejects(access(a, reviewCtx, claimX, { ...memberRead, requiredRoles: ['FINANCE'] }), hidden);
      // A different (weak) token can never reuse a context bound to another token.
      await assert.rejects(access(await login('alice-sub', weak), reviewCtx, claimX), denied);
      // Staff MFA freshness is re-checked on every use with the SAME token, not only at selection.
      const short = await login('alice-sub', { auth_time: Math.floor(Date.now() / 1000) - 297 }), shortCtx = await select(short, aliceT2);
      assert.equal(await access(short, shortCtx, claimX), aliceT2);
      await delay(3500);
      await assert.rejects(access(short, shortCtx, claimX), denied);
    });

    await t.test('grant, membership and principal changes invalidate contexts; one SELF per membership', async () => {
      const a = await login('alice-sub'), ctx = await select(a, aliceT1);
      await admin.query(`INSERT INTO tpa.identity_member_grants(tenant_id,membership_id,member_id,relation) VALUES($1,$2,$3,'GUARDIAN')`, [T1, aliceT1, randomUUID()]);
      await assert.rejects(store.withMembership(a, ctx, async () => 1), stale);
      await assert.rejects(admin.query(`INSERT INTO tpa.identity_member_grants(tenant_id,membership_id,member_id,relation) VALUES($1,$2,$3,'SELF')`, [T1, aliceT1, randomUUID()]),
        error => error.code === '23505');
      const fresh = await select(a, aliceT1);
      await admin.query('UPDATE tpa.identity_principals SET active=false WHERE id=$1', [alice]);
      await assert.rejects(store.withMembership(a, fresh, async () => 1), denied);
      await assert.rejects(store.me(a), denied);
      await admin.query('UPDATE tpa.identity_principals SET active=true WHERE id=$1', [alice]);
      assert.equal((await admin.query('SELECT version FROM tpa.identity_principals WHERE id=$1', [alice])).rows[0].version, 3);
      await assert.rejects(store.withMembership(a, fresh, async () => 1), stale);
      await assert.rejects(admin.query('UPDATE tpa.identity_principals SET version=99 WHERE id=$1', [alice]), error => error.code === '42501');
      // Revoked membership stays in the directory but is hidden from me() and unusable.
      const reviewCtx = await select(a, aliceT2);
      await admin.query('UPDATE tpa.identity_memberships SET active=false WHERE id=$1', [aliceT2]);
      assert.deepEqual((await store.me(a)).memberships.map(m => m.membershipId), [aliceT1]);
      await assert.rejects(store.withMembership(a, reviewCtx, async () => 1), denied);
      await assert.rejects(store.select(a, aliceT2, randomUUID()), denied);
    });
  } finally {
    await appDb?.close().catch(() => {}); await store?.close().catch(() => {}); await issuer?.close().catch(() => {}); await admin?.end().catch(() => {});
    if (started) docker('rm', '-f', '-v', name);
  }
});
