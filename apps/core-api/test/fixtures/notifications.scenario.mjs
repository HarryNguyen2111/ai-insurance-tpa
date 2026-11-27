// NOTIF-01 (#107) acceptance scenario on real PostgreSQL: unprivileged tpa_app role, FORCE RLS, real migrations,
// AUTH-01 identity store, synthetic OIDC issuer. Synthetic tenants/principals/notifications only. Called by
// test/notifications.pg.test.mjs (Docker PG16 in CI). Rows are seeded by a privileged fixture standing in for the
// producer, whose real claim-event path is proven in apps/event-worker/test/notification.e2e.test.ts.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IdentityStore } from '../../src/identity-tenant/identity-store.ts';
import { OidcVerifier, identityHash } from '../../src/identity-tenant/oidc-verifier.ts';
import { workflowRuntime } from '../../src/workflow-definition/workflow-runtime.ts';
import { NotificationsStore } from '../../src/notifications/notifications.store.ts';
import { syntheticIssuer } from './synthetic-issuer.ts';

const err = (status, code) => e => { assert.equal(e?.status, status, `expected ${status} ${code}, got ${e?.status} ${e?.code} ${e?.message ?? ''}`); assert.equal(e?.code, code); return true; };
const hidden = err(404, 'NOT_FOUND'), invalid = err(422, 'VALIDATION_FAILED'), forbidden = err(403, 'FORBIDDEN'), stale = err(409, 'STALE_VERSION');
const sqlCode = code => e => { assert.equal(e?.code, code, `expected SQLSTATE ${code}, got ${e?.code}`); return true; };
const MARKER = 'PIIMARK-0912345678';

export async function runNotificationsScenario(t, { url, admin }) {
  const runtime = await workflowRuntime();
  const issuer = await syntheticIssuer();
  const identity = await IdentityStore.connect(url('tpa_app'), Buffer.alloc(32, 7));
  const verifier = new OidcVerifier(issuer.profile);
  const store = new NotificationsStore(identity, runtime);
  try {
    const T1 = randomUUID(), T2 = randomUUID();
    const people = {};
    async function principal(name) {
      if (!people[name]) {
        people[name] = { name, principal: randomUUID() };
        await admin.query('INSERT INTO tpa.identity_principals(id,identity_hash) VALUES($1,$2)', [people[name].principal, identityHash(issuer.profile.issuer, name)]);
      }
      return people[name];
    }
    async function member(name, tenant) {
      const p = await principal(name), membership = randomUUID();
      await admin.query(`INSERT INTO tpa.identity_memberships(tenant_id,id,principal_id,roles) VALUES($1,$2,$3,'{MEMBER}')`, [tenant, membership, p.principal]);
      await admin.query('INSERT INTO tpa.identity_membership_directory(tenant_id,membership_id,principal_id) VALUES($1,$2,$3)', [tenant, membership, p.principal]);
      return { ...p, tenant, membership };
    }
    // Producer stand-in. created_at is offset into the past so ordering/cutoffs are deterministic.
    let seq = 0;
    async function tenantRow(who, { ageSeconds = 3600 - ++seq, expired = false, templateKey = 'CLAIM_SUBMITTED' } = {}) {
      const id = randomUUID();
      await admin.query(`INSERT INTO tpa.tenant_notifications(tenant_id,id,recipient_principal_id,recipient_membership_id,service,category,priority,template_key,
          template_version,title_vi,body_vi,target_kind,target_id,source_event_id,source_event_type,source_aggregate_version,occurred_at,created_at,expires_at)
        VALUES($1,$2,$3,$4,'TPA_INSURANCE','CLAIM_STATUS','INFO',$5,1,'Đã tiếp nhận hồ sơ bồi thường','Mở hồ sơ để theo dõi tiến trình.','CLAIM',$6,$7,
          'claim.submitted',1,clock_timestamp() - make_interval(secs => $8),clock_timestamp() - make_interval(secs => $8),
          CASE WHEN $9 THEN clock_timestamp() - interval '1 second' ELSE clock_timestamp() + interval '90 days' END)`,
      [who.tenant, id, who.principal, who.membership, templateKey, randomUUID(), randomUUID(), expired ? 7200 : ageSeconds, expired]);
      return id;
    }
    async function personalRow(who, { ageSeconds = 3600 - ++seq } = {}) {
      const id = randomUUID();
      await admin.query(`INSERT INTO tpa.personal_notifications(id,recipient_principal_id,service,category,priority,template_key,template_version,title_vi,body_vi,
          source_event_id,source_event_type,source_aggregate_version,occurred_at,created_at,expires_at)
        VALUES($1,$2,'LOYALTY360','SERVICE_NOTICE','INFO','SYNTHETIC_SERVICE_NOTICE',1,'Thông báo dịch vụ','Thông báo tổng hợp thử nghiệm.',$3,'loyalty.synthetic',1,
          clock_timestamp() - make_interval(secs => $4),clock_timestamp() - make_interval(secs => $4),clock_timestamp() + interval '90 days')`,
      [id, who.principal, randomUUID(), ageSeconds]);
      return id;
    }
    const verified = async name => verifier.verifyAuthorization(`Bearer ${await issuer.token(name)}`);
    async function ctx(who) { const v = await verified(who.name); return { identity: v, membershipContext: (await identity.select(v, who.membership, randomUUID())).view.contextToken }; }
    const personal = async name => ({ identity: await verified(name) });

    // The marker is part of alice's identity subject: it may only ever be stored as a hash.
    const ALICE = `alice-${MARKER}`;
    const alice = await member(ALICE, T1), aliceT2 = await member(ALICE, T2), bob = await member('bob', T1);
    const dave = await principal('dave'); // zero memberships: personal inbox only
    const a1 = [], b1 = [], a2 = [], pa = [], pb = [];
    for (let i = 0; i < 25; i++) a1.push(await tenantRow(alice));
    a1.push(await tenantRow(alice, { expired: true }));
    for (let i = 0; i < 3; i++) b1.push(await tenantRow(bob));
    for (let i = 0; i < 2; i++) a2.push(await tenantRow(aliceT2));
    for (let i = 0; i < 4; i++) pa.push(await personalRow(people[ALICE]));
    pb.push(await personalRow(dave));
    const A = await ctx(alice), A2 = await ctx(aliceT2), B = await ctx(bob), AP = await personal(ALICE), DP = await personal('dave');
    const ids = page => page.items.map(i => i.notificationId);
    const all = async (call, query) => { const out = []; let cursor; do { const p = await store.list(call, { ...query, ...(cursor ? { cursor } : {}) }); out.push(...ids(p)); cursor = p.nextCursor; } while (cursor); return out; };
    /** Direct tpa_app tenant transaction carrying the recipient's identity hash: proves RLS/trigger behaviour by SQLSTATE. */
    async function asRecipient(name, tenant, sql, values = []) {
      const db = runtime.createTenantDatabase({ connectionString: url('tpa_app'), max: 1 }), v = await verified(name);
      try {
        return await db.withTenantTransaction(tenant, async tx => {
          await tx.query("SELECT pg_catalog.set_config('app.identity_hash', $1, true)", [v.identityHash]);
          return tx.query(sql, values);
        });
      } finally { await db.close(); }
    }
    const valid = (schema, body) => assert.equal(runtime.validateContract(schema, body), true, `${schema} contract: ${JSON.stringify(body).slice(0, 300)}`);

    await t.test('scope isolation: tenant inbox = current membership only; personal inbox = principal only; no mixing', async () => {
      const tenant = await all(A, { scope: 'TENANT', limit: '50' });
      assert.deepEqual(new Set(tenant), new Set(a1.slice(0, 25)), 'T1 alice only, expired excluded, no bob/T2/personal rows');
      assert.deepEqual(new Set(await all(A2, { scope: 'TENANT' })), new Set(a2));
      assert.deepEqual(new Set(await all(B, { scope: 'TENANT' })), new Set(b1));
      assert.deepEqual(new Set(await all(AP, { scope: 'PERSONAL' })), new Set(pa), 'personal never lists tenant rows');
      assert.deepEqual(await all(DP, { scope: 'PERSONAL' }), pb, 'zero-membership principal has a personal inbox');
      const page = await store.list(A, { scope: 'TENANT', limit: '5' });
      valid('NotificationList', page);
      for (const item of page.items) {
        assert.equal(item.scope, 'TENANT'); assert.equal(item.target.kind, 'CLAIM');
        assert.ok(!('readAt' in item)); assert.equal(item.version, 1);
        assert.doesNotMatch(JSON.stringify(item), new RegExp(`${T1}|${alice.principal}|${alice.membership}`));
        assert.deepEqual(Object.keys(item).filter(k => /tenant|recipient|membership|principal|source/i.test(k)), []);
      }
      const p = await store.list(AP, { scope: 'PERSONAL' });
      valid('NotificationList', p); assert.ok(p.items.every(i => i.scope === 'PERSONAL' && !('target' in i)));
      // Service filters stay inside the scope: no LOYALTY360 rows exist in the tenant inbox, no TPA rows in personal.
      assert.deepEqual(ids(await store.list(A, { scope: 'TENANT', service: 'LOYALTY360' })), []);
      assert.deepEqual(ids(await store.list(AP, { scope: 'PERSONAL', service: 'TPA_INSURANCE' })), []);
    });

    await t.test('scope header rules: TENANT without valid context and PERSONAL with context are contracted errors', async () => {
      await assert.rejects(store.list(AP, { scope: 'TENANT' }), invalid);
      await assert.rejects(store.unreadCount(DP, { scope: 'TENANT' }), invalid);
      await assert.rejects(store.markAllRead(AP, { scope: 'TENANT', cutoff: new Date().toISOString() }), invalid);
      await assert.rejects(store.list(A, { scope: 'PERSONAL' }), invalid);
      await assert.rejects(store.markRead(A, pa[0], { scope: 'PERSONAL' }), invalid);
      await assert.rejects(store.list({ ...A, membershipContext: 'forged' }, { scope: 'TENANT' }), forbidden);
      await assert.rejects(store.list({ ...A, membershipContext: B.membershipContext }, { scope: 'TENANT' }), forbidden, 'context bound to another principal');
      for (const q of [{}, { scope: 'ALL' }, { scope: 'TENANT', tenantId: T2 }, { scope: 'TENANT', limit: '51' }, { scope: ['TENANT'] }])
        await assert.rejects(store.list(A, q), invalid);
    });

    await t.test('keyset pagination: stable, no duplicates, cursor bound to principal/scope/membership/filters', async () => {
      const pages = []; let cursor;
      do { const p = await store.list(A, { scope: 'TENANT', limit: '10', ...(cursor ? { cursor } : {}) }); pages.push(ids(p)); cursor = p.nextCursor; } while (cursor);
      assert.deepEqual(pages.map(p => p.length), [10, 10, 5]);
      assert.equal(new Set(pages.flat()).size, 25);
      assert.deepEqual(pages.flat(), [...a1.slice(0, 25)].reverse(), 'newest first');
      const { nextCursor } = await store.list(A, { scope: 'TENANT', limit: '10' });
      await assert.rejects(store.list(A, { scope: 'TENANT', status: 'UNREAD', cursor: nextCursor }), invalid);
      await assert.rejects(store.list(A2, { scope: 'TENANT', cursor: nextCursor }), invalid);
      await assert.rejects(store.list(B, { scope: 'TENANT', cursor: nextCursor }), invalid);
    });

    await t.test('unread count equals list(UNREAD), excludes expired, is bounded and contract-valid', async () => {
      const count = await store.unreadCount(A, { scope: 'TENANT' });
      valid('NotificationUnreadCount', count);
      assert.equal(count.unreadCount, 25); assert.equal(count.capped, false);
      assert.equal((await all(A, { scope: 'TENANT', status: 'UNREAD' })).length, count.unreadCount);
      assert.equal((await store.unreadCount(AP, { scope: 'PERSONAL' })).unreadCount, 4);
      assert.equal((await store.unreadCount(A, { scope: 'TENANT', service: 'LOYALTY360' })).unreadCount, 0);
      await assert.rejects(store.markRead(A, a1[25], { scope: 'TENANT' }), hidden, 'expired is not readable');
    });

    await t.test('mark-one: idempotent, concurrent and cross-device consistent; audited once; read_at monotonic', async () => {
      const deviceB = await ctx(alice); // a second session/device for the same membership
      const target = a1[24];
      const results = await Promise.all([1, 2, 3, 4, 5, 6].map(i => store.markRead(i % 2 ? A : deviceB, target, { scope: 'TENANT' })));
      const readAt = results[0].readAt;
      assert.match(readAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
      assert.ok(results.every(r => r.readAt === readAt && r.version === 2), 'every device observes one server-authoritative readAt');
      valid('Notification', results[0]);
      const again = await store.markRead(deviceB, target, { scope: 'TENANT' });
      assert.equal(again.readAt, readAt);
      const listed = (await store.list(deviceB, { scope: 'TENANT', limit: '50' })).items.find(i => i.notificationId === target);
      assert.equal(listed.readAt, readAt, 'cross-device: other session lists it read');
      assert.equal((await store.unreadCount(deviceB, { scope: 'TENANT' })).unreadCount, 24);
      const { rows: audit } = await admin.query(`SELECT action, payload_diff FROM tpa.audit_logs WHERE tenant_id=$1 AND entity_id=$2`, [T1, target]);
      assert.deepEqual(audit.map(a => a.action), ['NOTIFICATION_READ'], 'first transition audited exactly once');
      assert.deepEqual(Object.keys(audit[0].payload_diff), ['after_hash']);
      // Monotonic at the database: the app role cannot revert to unread or rewrite text.
      await assert.rejects(asRecipient(ALICE, T1, 'UPDATE tpa.tenant_notifications SET read_at=NULL, version=1 WHERE id=$1', [target]), sqlCode('42501'));
      await assert.rejects(asRecipient(ALICE, T1, 'UPDATE tpa.tenant_notifications SET read_at=clock_timestamp(), version=3 WHERE id=$1', [target]), sqlCode('42501'));
      await assert.rejects(asRecipient(ALICE, T1, "UPDATE tpa.tenant_notifications SET title_vi='x' WHERE id=$1", [target]), sqlCode('42501'));
      await assert.rejects(asRecipient(ALICE, T1, 'DELETE FROM tpa.tenant_notifications WHERE id=$1', [target]), sqlCode('42501'));
      // Personal read-state is recipient UI state: idempotent, not a tenant audit event.
      const p1 = await store.markRead(AP, pa[0], { scope: 'PERSONAL' }), p2 = await store.markRead(AP, pa[0], { scope: 'PERSONAL' });
      assert.equal(p1.readAt, p2.readAt); assert.equal(p1.scope, 'PERSONAL');
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM tpa.audit_logs WHERE entity_id=$1', [pa[0]])).rows[0].n, 0);
    });

    await t.test('cross-user / cross-tenant / cross-scope mark-read denial is 404 without side effects', async () => {
      await assert.rejects(store.markRead(B, a1[0], { scope: 'TENANT' }), hidden);
      await assert.rejects(store.markRead(A2, a1[0], { scope: 'TENANT' }), hidden);
      await assert.rejects(store.markRead(AP, a1[0], { scope: 'PERSONAL' }), hidden, 'tenant id via personal scope');
      await assert.rejects(store.markRead(A, pa[1], { scope: 'TENANT' }), hidden, 'personal id via tenant scope');
      await assert.rejects(store.markRead(DP, pa[1], { scope: 'PERSONAL' }), hidden, 'another person');
      await assert.rejects(store.markRead(A, randomUUID(), { scope: 'TENANT' }), hidden);
      await assert.rejects(store.markRead(A, 'not-a-uuid', { scope: 'TENANT' }), hidden);
      await assert.rejects(store.markRead(A, a1[0], { scope: 'TENANT', tenantId: T2 }), invalid);
      const { rows } = await admin.query('SELECT count(*)::int AS n FROM tpa.tenant_notifications WHERE id=$1 AND read_at IS NOT NULL', [a1[0]]);
      assert.equal(rows[0].n, 0);
    });

    await t.test('mark-all: explicit cutoff keeps concurrent new events unread; idempotent; scopes never clear each other', async () => {
      const seen = await store.unreadCount(A, { scope: 'TENANT' });
      const fresh = await tenantRow(alice, { ageSeconds: 0 }); // arrives after the user looked
      await assert.rejects(store.markAllRead(A, { scope: 'TENANT', cutoff: new Date(Date.now() + 60_000).toISOString() }), invalid);
      const result = await store.markAllRead(A, { scope: 'TENANT', cutoff: seen.asOf });
      valid('NotificationReadAllResult', result);
      assert.equal(result.markedCount, seen.unreadCount);
      const after = await store.list(A, { scope: 'TENANT', status: 'UNREAD' });
      assert.deepEqual(ids(after), [fresh], 'only the post-cutoff notification stays unread');
      assert.equal((await store.markAllRead(A, { scope: 'TENANT', cutoff: seen.asOf })).markedCount, 0, 'repeat is a no-op');
      // Concurrent read-all from two devices: each row transitions once, total equals the unread set.
      const deviceB = await ctx(alice), cut = (await store.unreadCount(A, { scope: 'TENANT' })).asOf;
      const both = await Promise.all([store.markAllRead(A, { scope: 'TENANT', cutoff: cut }), store.markAllRead(deviceB, { scope: 'TENANT', cutoff: cut })]);
      assert.equal(both[0].markedCount + both[1].markedCount, 1);
      // Other scopes/tenants/recipients untouched.
      assert.equal((await store.unreadCount(A2, { scope: 'TENANT' })).unreadCount, 2);
      assert.equal((await store.unreadCount(AP, { scope: 'PERSONAL' })).unreadCount, 3);
      assert.equal((await store.unreadCount(B, { scope: 'TENANT' })).unreadCount, 3);
      const { rows: audit } = await admin.query(`SELECT action, entity_id::text AS entity FROM tpa.audit_logs WHERE tenant_id=$1 AND action='NOTIFICATION_READ_ALL'`, [T1]);
      assert.deepEqual(audit.map(a => a.entity), [alice.membership, alice.membership], 'one audit per effective read-all, none for no-op');
      const personalAll = await store.markAllRead(AP, { scope: 'PERSONAL', cutoff: (await store.unreadCount(AP, { scope: 'PERSONAL' })).asOf });
      assert.equal(personalAll.markedCount, 3);
      assert.equal((await store.unreadCount(A, { scope: 'TENANT' })).unreadCount, 0);
      assert.equal((await store.unreadCount(A2, { scope: 'TENANT' })).unreadCount, 2, 'personal read-all never touches tenant inboxes');
    });

    await t.test('revoked membership: old context denied on list/count/read; RLS hides rows even inside a tenant tx', async () => {
      const extra = await tenantRow(bob);
      await admin.query('UPDATE tpa.identity_memberships SET active=false WHERE tenant_id=$1 AND id=$2', [T1, bob.membership]);
      await assert.rejects(store.list(B, { scope: 'TENANT' }), forbidden);
      await assert.rejects(store.unreadCount(B, { scope: 'TENANT' }), forbidden);
      await assert.rejects(store.markRead(B, extra, { scope: 'TENANT' }), forbidden);
      await assert.rejects(store.markAllRead(B, { scope: 'TENANT', cutoff: new Date().toISOString() }), forbidden);
      // Defense in depth: a tenant transaction with bob's identity still sees nothing for the inactive membership.
      assert.equal((await asRecipient('bob', T1, 'SELECT count(*)::int AS n FROM tpa.tenant_notifications')).rows[0].n, 0);
      assert.equal((await asRecipient('bob', T1, 'UPDATE tpa.tenant_notifications SET read_at=clock_timestamp(), version=2 WHERE id=$1', [extra])).rowCount, 0);
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM tpa.tenant_notifications WHERE id=$1 AND read_at IS NULL', [extra])).rows[0].n, 1);
      // Personal inbox does not depend on any membership.
      assert.equal((await store.list(await personal('bob'), { scope: 'PERSONAL' })).items.length, 0);
    });

    await t.test('grant change makes the old context stale (409); deactivated principal loses the personal inbox (403)', async () => {
      await admin.query('UPDATE tpa.identity_memberships SET roles=$3 WHERE tenant_id=$1 AND id=$2', [T2, aliceT2.membership, ['MEMBER', 'GUARDIAN']]);
      await assert.rejects(store.list(A2, { scope: 'TENANT' }), stale);
      assert.equal((await store.list(await ctx(aliceT2), { scope: 'TENANT' })).items.length, 2);
      await admin.query('UPDATE tpa.identity_principals SET active=false WHERE id=$1', [dave.principal]);
      await assert.rejects(store.list(DP, { scope: 'PERSONAL' }), forbidden);
    });

    await t.test('zero PII markers: notifications/audit store references only; personal tx cannot touch tenant tables', async () => {
      const { rows: [hits] } = await admin.query(`SELECT
        (SELECT count(*)::int FROM tpa.tenant_notifications WHERE to_jsonb(tenant_notifications)::text LIKE '%'||$1||'%') AS t,
        (SELECT count(*)::int FROM tpa.personal_notifications WHERE to_jsonb(personal_notifications)::text LIKE '%'||$1||'%') AS p,
        (SELECT count(*)::int FROM tpa.audit_logs WHERE to_jsonb(audit_logs)::text LIKE '%'||$1||'%') AS a`, [MARKER]);
      assert.deepEqual(hits, { t: 0, p: 0, a: 0 });
      await assert.rejects(admin.query(`INSERT INTO tpa.tenant_notifications(tenant_id,id,recipient_principal_id,recipient_membership_id,service,category,priority,template_key,
          template_version,title_vi,body_vi,target_kind,target_id,source_event_id,source_event_type,source_aggregate_version,occurred_at,expires_at)
        VALUES($1,gen_random_uuid(),$2,$3,'TPA_INSURANCE','CLAIM_STATUS','INFO','CLAIM_SUBMITTED',1,'Gọi 0912345678','<b>x</b> https://evil.invalid','CLAIM',gen_random_uuid(),
          gen_random_uuid(),'claim.submitted',1,now(),now()+interval '1 day')`, [T1, alice.principal, alice.membership]), sqlCode('23514'), 'unsafe text rejected by CHECK');
      await assert.rejects(identity.withPrincipal(AP.identity, tx => tx.query('SELECT count(*) FROM tpa.tenant_notifications')), err(503, 'DEPENDENCY_UNAVAILABLE'));
      await assert.rejects(identity.withPrincipal(AP.identity, tx => tx.query('INSERT INTO tpa.personal_notifications(id) VALUES(gen_random_uuid())')), err(503, 'DEPENDENCY_UNAVAILABLE'));
    });
  } finally {
    await identity.close();
    await issuer.close();
  }
}
