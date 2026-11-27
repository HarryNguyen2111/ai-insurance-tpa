// CLM-02 (#37) acceptance scenario on real PostgreSQL with the unprivileged tpa_app role, FORCE RLS, real migrations,
// the AUTH-01 identity store and the DOC-01 document gate. Synthetic tenants/principals/members/claims only.
// Called by test/claims.pg.test.mjs (Docker PG16 in CI). Preflight (#36) is a synthetic test gate here.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { IdentityStore } from '../../src/identity-tenant/identity-store.ts';
import { OidcVerifier, identityHash } from '../../src/identity-tenant/oidc-verifier.ts';
import { workflowRuntime } from '../../src/workflow-definition/workflow-runtime.ts';
import { ClaimsStore, transitionClaim } from '../../src/claims/claims.store.ts';
import { CLAIM_STATUSES, CLAIM_TRANSITIONS } from '../../src/claims/claim-state.ts';
import { syntheticIssuer } from './synthetic-issuer.ts';

const err = (status, code) => e => { assert.equal(e?.status, status, `expected ${status} ${code}, got ${e?.status} ${e?.code} ${e?.message ?? ''}`); assert.equal(e?.code, code); return true; };
const sqlCode = code => e => { assert.equal(e?.code, code, `expected SQLSTATE ${code}, got ${e?.code}`); return true; };
const hidden = err(404, 'NOT_FOUND'), domain = err(422, 'DOMAIN_VIOLATION'), invalid = err(422, 'VALIDATION_FAILED');
const conflict = err(409, 'IDEMPOTENCY_CONFLICT'), stale = err(409, 'STALE_VERSION');
const MARKER = 'PIIMARK-0912345678';
const DOC_PURPOSE = 'SYNTHETIC_DOCUMENT_PROCESSING', CLAIM_PURPOSE = 'SYNTHETIC_CLAIM_PROCESSING', POLICY_HASH = 'a'.repeat(64);

export async function runClaimsScenario(t, { url, admin }) {
  const runtime = await workflowRuntime();
  const issuer = await syntheticIssuer();
  const identity = await IdentityStore.connect(url('tpa_app'), Buffer.alloc(32, 9));
  const db = runtime.createTenantDatabase({ connectionString: url('tpa_app'), max: 8 });
  const verifier = new OidcVerifier(issuer.profile);
  try {
    const T = randomUUID(), T2 = randomUUID();
    const memberA = randomUUID(), memberB = randomUUID(), ward = randomUUID();
    // ---------- trusted provisioning (privileged fixture; no public endpoint exists for these) ----------
    const people = {};
    async function person(name, tenant, roles, grants = []) {
      const p = people[name] ?? { principal: randomUUID() };
      if (!people[name]) await admin.query('INSERT INTO tpa.identity_principals(id,identity_hash) VALUES($1,$2)', [p.principal, identityHash(issuer.profile.issuer, name)]);
      const membership = randomUUID();
      await admin.query('INSERT INTO tpa.identity_memberships(tenant_id,id,principal_id,roles) VALUES($1,$2,$3,$4)', [tenant, membership, p.principal, roles]);
      await admin.query('INSERT INTO tpa.identity_membership_directory(tenant_id,membership_id,principal_id) VALUES($1,$2,$3)', [tenant, membership, p.principal]);
      for (const [member, relation] of grants) await admin.query('INSERT INTO tpa.identity_member_grants(tenant_id,membership_id,member_id,relation) VALUES($1,$2,$3,$4)', [tenant, membership, member, relation]);
      people[name] = p; return { name, tenant, principal: p.principal, membership };
    }
    for (const tenant of [T, T2]) for (const purpose of [DOC_PURPOSE, CLAIM_PURPOSE])
      await admin.query(`INSERT INTO tpa.consent_policies(tenant_id,purpose,policy_version,policy_hash) VALUES($1,$2,'v1',$3)`, [tenant, purpose, POLICY_HASH]);
    const alice = await person('alice', T, ['MEMBER'], [[memberA, 'SELF']]);
    const bob = await person('bob', T, ['MEMBER'], [[memberB, 'SELF']]);
    const gina = await person('gina', T, ['GUARDIAN'], [[ward, 'GUARDIAN']]);
    const reviewer = await person('rita', T, ['CLAIM_REVIEWER']);
    const outsider = await person('oscar', T, ['CLAIM_REVIEWER']);
    const aliceCross = await person('alice', T2, ['MEMBER'], [[memberA, 'SELF']]);
    // BEN-01 coverage for memberA and ward only (memberB is not an insured member).
    async function coverage(tenant, member) {
      const policy = randomUUID(), clause = randomUUID(), rule = randomUUID(), plan = randomUUID();
      await admin.query('BEGIN');
      await admin.query(`INSERT INTO tpa.policy_versions(tenant_id,id,policy_id,version_no,effective_from,effective_to,content_hash,approval_reference,definition)
        VALUES($1,$2,$3,1,'2026-01-01','2026-12-31',$4,$5,'{}')`, [tenant, policy, randomUUID(), 'b'.repeat(64), randomUUID()]);
      await admin.query(`INSERT INTO tpa.contract_clauses(tenant_id,id,policy_version_id,source_version,contract_clause_cited,explanation_vi)
        VALUES($1,$2,$3,'{}','Dieu 2.1 synthetic','Synthetic clause')`, [tenant, clause, policy]);
      await admin.query('COMMIT');
      await admin.query(`INSERT INTO tpa.benefit_rule_versions(tenant_id,id,plan_id,policy_version_id,clause_id,version_no,benefit_type,effective_from,effective_to,
        annual_limit,per_visit_limit,deductible_per_claim,copay_insurer_pct,definition,content_hash,approval_reference)
        VALUES($1,$2,$3,$4,$5,1,'OUTPATIENT','2026-01-01','2026-12-31','10000000.00','2000000.00','0.00','80.00','{}',$6,$7)`,
      [tenant, rule, plan, policy, clause, 'c'.repeat(64), randomUUID()]);
      await admin.query(`INSERT INTO tpa.member_coverages(tenant_id,id,member_id,plan_id,policy_version_id,rule_version_id,version_no,effective_from,effective_to,premium_paid,content_hash,approval_reference)
        VALUES($1,$2,$3,$4,$5,$6,1,'2026-01-01','2026-12-31',true,$7,$8)`, [tenant, randomUUID(), member, plan, policy, rule, 'd'.repeat(64), randomUUID()]);
    }
    await coverage(T, memberA); await coverage(T, ward); await coverage(T2, memberA);
    async function consent(who, member, purpose) {
      const id = randomUUID();
      await admin.query(`INSERT INTO tpa.consent_records(tenant_id,id,member_id,principal_id,membership_id,purpose,policy_version,policy_hash)
        VALUES($1,$2,$3,$4,$5,$6,'v1',$7)`, [who.tenant, id, member, who.principal, who.membership, purpose, POLICY_HASH]);
      return id;
    }
    const docConsent = new Map();
    async function newDoc(who, member, status = 'CLEAN') {
      const key = `${who.membership}/${member}`;
      if (!docConsent.has(key)) docConsent.set(key, await consent(who, member, DOC_PURPOSE));
      const upload = randomUUID(), id = randomUUID();
      await admin.query(`INSERT INTO tpa.upload_sessions(tenant_id,id,member_id,principal_id,membership_id,consent_id,object_key,content_type,doc_type,size_bytes,sha256,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'application/pdf','INVOICE_PHOTO',100,$8,clock_timestamp()+interval '200 seconds')`,
      [who.tenant, upload, member, who.principal, who.membership, docConsent.get(key), `quarantine/${who.tenant}/${upload}`, 'e'.repeat(64)]);
      await admin.query(`INSERT INTO tpa.document_versions(tenant_id,id,upload_id,object_version) VALUES($1,$2,$3,'v1')`, [who.tenant, id, upload]);
      await admin.query(`INSERT INTO tpa.document_scan_outbox(tenant_id,document_id,status,scanner_version,scanned_at)
        VALUES($1,$2,$3::text,CASE WHEN $3::text IN ('CLEAN','REJECTED') THEN 'synthetic-v1' END,CASE WHEN $3::text IN ('CLEAN','REJECTED') THEN clock_timestamp() END)`, [who.tenant, id, status]);
      return id;
    }
    // Synthetic preflight gate (#36 owns the real one). Verifies it runs in the caller's tenant transaction.
    const preflights = new Map(), gateTenants = new Set();
    const preflight = { async verify(tx, actor, ref) {
      gateTenants.add((await tx.query('SELECT tpa.current_tenant_id()::text AS t')).rows[0].t);
      const p = preflights.get(ref.preflightId);
      if (!p || p.memberId !== ref.memberId || p.actor !== actor.principalId) return 'NOT_FOUND';
      return p.version === ref.expectedVersion ? 'MATCH' : 'STALE';
    } };
    const newPreflight = (who, member, version = 1) => { const id = randomUUID(); preflights.set(id, { memberId: member, actor: who.principal, version }); return id; };
    const store = new ClaimsStore(identity, runtime, { claimPurpose: CLAIM_PURPOSE, documentPurpose: DOC_PURPOSE, preflight });
    const contexts = {};
    async function ctx(who) {
      const token = await issuer.token(who.name), verified = await verifier.verifyAuthorization(`Bearer ${token}`);
      contexts[who.membership] = { identity: verified, membershipContext: (await identity.select(verified, who.membership, randomUUID())).view.contextToken };
      return contexts[who.membership];
    }
    for (const who of [alice, bob, gina, reviewer, outsider, aliceCross]) await ctx(who);
    const as = (who, key = `claim-key-${randomUUID()}`) => ({ ...contexts[who.membership], idempotencyKey: key });
    const read = who => contexts[who.membership];
    const claimConsentA = await consent(alice, memberA, CLAIM_PURPOSE);
    const submitBody = async (who = alice, member = memberA, consentId = claimConsentA, overrides = {}) => ({
      memberId: member, benefitType: 'OUTPATIENT', visitDate: '2026-11-20', totalRequested: '1500000.00', consentAccepted: true, consentId,
      documentIds: [await newDoc(who, member), await newDoc(who, member)], preflightId: newPreflight(who, member), expectedPreflightVersion: 1,
      icd10Code: MARKER, ...overrides });
    const countClaims = async () => (await admin.query('SELECT count(*)::int AS n FROM tpa.claims WHERE tenant_id=$1', [T])).rows[0].n;

    await t.test('state graph parity: TypeScript CLAIM_TRANSITIONS equals tpa.claim_transition_allowed', async () => {
      const { rows } = await admin.query(`SELECT f,s FROM unnest($1::text[]) f CROSS JOIN unnest($1::text[]) s WHERE tpa.claim_transition_allowed(f,s) ORDER BY f,s`, [CLAIM_STATUSES]);
      const expected = Object.entries(CLAIM_TRANSITIONS).flatMap(([f, ts]) => ts.map(s => ({ f, s }))).sort((a, b) => (a.f + a.s).localeCompare(b.f + b.s));
      assert.deepEqual(rows.sort((a, b) => (a.f + a.s).localeCompare(b.f + b.s)), expected);
    });

    let claim1, call1, body1;
    await t.test('PT22 submit: one claim per key, exact replay, changed payload 409, concurrent same key, Decimal string money', async () => {
      body1 = await submitBody(); call1 = as(alice);
      const first = await store.submit(call1, body1);
      assert.equal(first.status, 201); assert.equal(first.replayed, false);
      claim1 = first.body;
      assert.equal(claim1.status, 'SUBMITTED'); assert.equal(claim1.version, 1);
      assert.equal(claim1.totalRequested, '1500000.00'); assert.equal(typeof claim1.totalRequested, 'string');
      assert.match(claim1.claimCode, /^CLM-[0-9A-F]{20}$/);
      const again = await store.submit(call1, body1);
      assert.equal(again.replayed, true); assert.deepEqual(again.body, claim1);
      await assert.rejects(store.submit(call1, { ...body1, totalRequested: '1500001.00' }), conflict);
      assert.equal(await countClaims(), 1);
      // Same key in parallel: one effect, both callers observe the same claim.
      const body = await submitBody(), call = as(alice);
      const pair = await Promise.all([store.submit(call, body), store.submit(call, body)]);
      assert.equal(pair[0].body.claimId, pair[1].body.claimId);
      assert.deepEqual(pair.map(r => r.replayed).sort(), [false, true]);
      assert.equal(await countClaims(), 2);
      // NUMERIC(15,2) roundtrip without float.
      const big = await store.submit(as(alice), await submitBody(alice, memberA, claimConsentA, { totalRequested: '9999999999999.99' }));
      assert.equal(big.body.totalRequested, '9999999999999.99');
      const { rows: [n] } = await admin.query('SELECT total_requested::text AS v, pg_typeof(total_requested)::text AS t FROM tpa.claims WHERE id=$1', [big.body.claimId]);
      assert.deepEqual(n, { v: '9999999999999.99', t: 'numeric' });
    });

    await t.test('different keys racing for the same documents: exactly one claim; documents are single-claim evidence', async () => {
      const shared = await submitBody(), before = await countClaims();
      const results = await Promise.allSettled([store.submit(as(alice), shared), store.submit(as(alice), { ...shared, preflightId: newPreflight(alice, memberA) })]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      domain(results.find(r => r.status === 'rejected').reason);
      assert.equal(await countClaims(), before + 1);
      await assert.rejects(store.submit(as(alice), { ...await submitBody(), documentIds: [body1.documentIds[0]] }), domain);
    });

    await t.test('submit gates: owner/guardian only, consent, insured member, preflight version, CLEAN owned documents, schema/money', async () => {
      const before = await countClaims();
      await assert.rejects(store.submit(as(alice), await submitBody(alice, memberB)), hidden); // not alice's member
      await assert.rejects(store.submit(as(reviewer), await submitBody(alice)), hidden); // staff cannot submit
      await assert.rejects(store.submit(as(aliceCross), await submitBody()), domain); // T2 consent id is not in T2
      await assert.rejects(store.submit(as(alice), await submitBody(alice, memberA, randomUUID())), domain);
      await assert.rejects(store.submit(as(alice), await submitBody(alice, memberA, await consent(alice, memberA, DOC_PURPOSE))), domain); // wrong purpose
      const bobConsent = await consent(bob, memberB, CLAIM_PURPOSE);
      await assert.rejects(store.submit(as(bob), await submitBody(bob, memberB, bobConsent)), domain); // not an insured member
      await assert.rejects(store.submit(as(alice), { ...await submitBody(), expectedPreflightVersion: 2 }), stale);
      await assert.rejects(store.submit(as(alice), { ...await submitBody(), preflightId: randomUUID() }), domain);
      await assert.rejects(store.submit(as(alice), { ...await submitBody(), documentIds: [await newDoc(alice, memberA, 'QUARANTINED')] }), domain);
      await assert.rejects(store.submit(as(alice), { ...await submitBody(), documentIds: [await newDoc(alice, memberA, 'REJECTED')] }), domain);
      await assert.rejects(store.submit(as(alice), { ...await submitBody(), documentIds: [await newDoc(bob, memberB)] }), hidden);
      for (const o of [{ totalRequested: '0.00' }, { totalRequested: 1500000 }, { totalRequested: '1500000.5' }, { totalRequested: '1e6' },
        { consentAccepted: false }, { tenantId: T }, { documentIds: [] }, { admitDatetime: '2026-11-21T00:00:00Z', dischargeDatetime: '2026-11-20T00:00:00Z' }])
        await assert.rejects(store.submit(as(alice), { ...await submitBody(), ...o }), invalid);
      await assert.rejects(store.submit({ ...read(alice) }, await submitBody()), invalid); // no Idempotency-Key
      // Revoked consent policy fails closed.
      await admin.query('UPDATE tpa.consent_policies SET active=false WHERE tenant_id=$1 AND purpose=$2', [T, CLAIM_PURPOSE]);
      await assert.rejects(store.submit(as(alice), await submitBody()), domain);
      await admin.query('UPDATE tpa.consent_policies SET active=true WHERE tenant_id=$1 AND purpose=$2', [T, CLAIM_PURPOSE]);
      assert.equal(await countClaims(), before);
      assert.deepEqual([...gateTenants], [T], 'preflight gate runs inside the caller tenant transaction only');
    });

    let wardClaim;
    await t.test('PT01 reads: owner/guardian/assigned staff only; other member, unassigned staff and other tenant see 404', async () => {
      const detail = await store.get(read(alice), claim1.claimId);
      assert.deepEqual(detail.claim, claim1);
      assert.equal(detail.documents.length, 2); assert.equal(detail.supplementAllowed, false);
      assert.ok(detail.documents.every(d => d.scanStatus === 'CLEAN' && !('objectKey' in d)));
      for (const who of [bob, gina, reviewer, outsider, aliceCross]) await assert.rejects(store.get(read(who), claim1.claimId), hidden);
      await assert.rejects(store.get(read(alice), randomUUID()), hidden);
      await assert.rejects(store.get(read(alice), 'not-a-uuid'), hidden);
      const ginaConsent = await consent(gina, ward, CLAIM_PURPOSE);
      wardClaim = (await store.submit(as(gina), await submitBody(gina, ward, ginaConsent))).body;
      assert.equal((await store.get(read(gina), wardClaim.claimId)).claim.memberId, ward);
      await assert.rejects(store.get(read(alice), wardClaim.claimId), hidden);
      await admin.query(`INSERT INTO tpa.identity_object_assignments(tenant_id,membership_id,object_kind,object_id,action) VALUES($1,$2,'CLAIM',$3,'READ')`, [T, reviewer.membership, claim1.claimId]);
      await assert.rejects(store.get(read(reviewer), claim1.claimId), stale); // grant change invalidates the old context
      await ctx(reviewer);
      assert.equal((await store.get(read(reviewer), claim1.claimId)).claim.claimId, claim1.claimId);
      await assert.rejects(store.get(read(reviewer), wardClaim.claimId), hidden);
      const { rows } = await admin.query(`SELECT count(*)::int AS n FROM tpa.audit_logs WHERE tenant_id=$1 AND entity_id=$2 AND action='CLAIM_DETAIL_READ'`, [T, claim1.claimId]);
      assert.equal(rows[0].n, 2);
    });

    await t.test('list: authorized rows only, stable cursor paging bound to membership/filters, allowlisted query', async () => {
      const { rows: [{ n: aliceCount }] } = await admin.query('SELECT count(*)::int AS n FROM tpa.claims WHERE tenant_id=$1 AND member_id=$2', [T, memberA]);
      const seen = []; let cursor;
      do {
        const page = await store.list(read(alice), { limit: '2', ...(cursor ? { cursor } : {}) });
        assert.ok(page.items.length <= 2); seen.push(...page.items); cursor = page.nextCursor;
      } while (cursor);
      assert.equal(seen.length, aliceCount); assert.equal(new Set(seen.map(c => c.claimId)).size, aliceCount);
      assert.ok(seen.every(c => c.memberId === memberA));
      const order = seen.map(c => c.createdAt);
      assert.deepEqual(order, [...order].sort().reverse());
      const first = await store.list(read(alice), { limit: '1' });
      await assert.rejects(store.list(read(gina), { limit: '1', cursor: first.nextCursor }), invalid); // other membership
      await assert.rejects(store.list(read(alice), { limit: '1', status: 'SUBMITTED', cursor: first.nextCursor }), invalid); // other filters
      for (const q of [{ tenantId: T }, { sort: 'totalRequested' }, { limit: '500' }, { status: ['SUBMITTED', 'PAID'] }])
        await assert.rejects(store.list(read(alice), q), invalid);
      await assert.rejects(store.list(read(alice), { memberId: ward }), hidden);
      assert.deepEqual((await store.list(read(gina), {})).items.map(c => c.claimId), [wardClaim.claimId]);
      assert.deepEqual((await store.list(read(bob), {})).items, []);
      assert.deepEqual((await store.list(read(reviewer), {})).items.map(c => c.claimId), [claim1.claimId]);
      assert.deepEqual((await store.list(read(outsider), {})).items, []);
      assert.deepEqual((await store.list(read(aliceCross), {})).items, []);
      assert.deepEqual((await store.list(read(alice), { status: 'PAID' })).items, []);
    });

    let version = 1;
    const svc = randomUUID();
    const move = (toStatus, extra = {}, tenant = T, claimId = claim1.claimId) => db.withTenantTransaction(tenant, tx =>
      transitionClaim(tx, runtime, { claimId, expectedVersion: version, toStatus, commandId: randomUUID(), actorType: 'SERVICE', actorId: svc, ...extra }));
    await t.test('expected-version transitions: graph, gated targets, stale, idempotent command retry, single winner under race', async () => {
      const command = randomUUID();
      const r = await db.withTenantTransaction(T, tx => transitionClaim(tx, runtime, { claimId: claim1.claimId, expectedVersion: 1, toStatus: 'AI_PROCESSING', commandId: command, actorType: 'SERVICE', actorId: svc }));
      assert.equal(r.replayed, false); assert.equal(r.claim.version, 2); version = 2;
      const retry = await db.withTenantTransaction(T, tx => transitionClaim(tx, runtime, { claimId: claim1.claimId, expectedVersion: 1, toStatus: 'AI_PROCESSING', commandId: command, actorType: 'SERVICE', actorId: svc }));
      assert.equal(retry.replayed, true); assert.equal(retry.claim.version, 2);
      await assert.rejects(db.withTenantTransaction(T, tx => transitionClaim(tx, runtime, { claimId: claim1.claimId, expectedVersion: 1, toStatus: 'DOCTOR_REVIEW', commandId: randomUUID(), actorType: 'SERVICE', actorId: svc })), stale);
      await assert.rejects(move('PAID'), domain); await assert.rejects(move('EOB_READY'), domain);
      await assert.rejects(move('REJECTED'), domain); // not an edge from AI_PROCESSING
      await assert.rejects(move('DOCTOR_REVIEW', {}, T2), hidden); // other tenant cannot see the claim
      const race = await Promise.allSettled([move('DOCTOR_REVIEW'), move('FRAUD_HOLD')]);
      assert.equal(race.filter(x => x.status === 'fulfilled').length, 1);
      stale(race.find(x => x.status === 'rejected').reason);
      version = 3;
      const status = (await admin.query('SELECT status,version FROM tpa.claims WHERE id=$1', [claim1.claimId])).rows[0];
      assert.equal(status.version, 3); assert.ok(['DOCTOR_REVIEW', 'FRAUD_HOLD'].includes(status.status));
      if (status.status === 'FRAUD_HOLD') { await move('DOCTOR_REVIEW'); version = 4; }
      await assert.rejects(move('SUPPLEMENT_REQUIRED'), invalid); // deadline required
      await assert.rejects(move('SUPPLEMENT_REQUIRED', { supplementDeadline: '2020-01-01T00:00:00Z' }), invalid);
      const supp = await move('SUPPLEMENT_REQUIRED', { supplementDeadline: new Date(Date.now() + 86400000).toISOString() });
      version = supp.claim.version;
      const detail = await store.get(read(alice), claim1.claimId);
      assert.equal(detail.supplementAllowed, true); assert.ok(detail.supplementDeadline);
    });

    await t.test('supplement: owner only, expected version, CLEAN docs, atomic transition, replay/409, state guard and deadline', async () => {
      const extra = await newDoc(alice, memberA), body = { expectedVersion: version, documentIds: [extra] }, call = as(alice);
      await assert.rejects(store.supplement(as(bob), claim1.claimId, body), hidden);
      await assert.rejects(store.supplement(as(reviewer), claim1.claimId, body), hidden);
      await assert.rejects(store.supplement(as(aliceCross), claim1.claimId, body), hidden);
      await assert.rejects(store.supplement(as(alice), claim1.claimId, { ...body, expectedVersion: version - 1 }), stale);
      await assert.rejects(store.supplement(as(alice), claim1.claimId, { ...body, documentIds: [await newDoc(alice, memberA, 'QUARANTINED')] }), domain);
      await assert.rejects(store.supplement(as(alice), claim1.claimId, { ...body, documentIds: [body1.documentIds[1]] }), domain);
      const done = await store.supplement(call, claim1.claimId, body);
      assert.equal(done.status, 200); assert.equal(done.body.claim.status, 'SUBMITTED'); assert.equal(done.body.claim.version, version + 1);
      assert.equal(done.body.documents.length, 3); assert.equal(done.body.supplementAllowed, false);
      const replay = await store.supplement(call, claim1.claimId, body);
      assert.equal(replay.replayed, true); assert.deepEqual(replay.body, done.body);
      await assert.rejects(store.supplement(call, claim1.claimId, { ...body, documentIds: [await newDoc(alice, memberA)] }), conflict);
      await assert.rejects(store.supplement(as(alice), claim1.claimId, { expectedVersion: version + 1, documentIds: [await newDoc(alice, memberA)] }), domain);
      version += 1;
      // Deadline passes: no supplement after it, even with the right version.
      const c2 = (await store.submit(as(alice), await submitBody())).body;
      const step = (expectedVersion, toStatus, extra = {}) => db.withTenantTransaction(T, tx => transitionClaim(tx, runtime,
        { claimId: c2.claimId, expectedVersion, toStatus, commandId: randomUUID(), actorType: 'SERVICE', actorId: svc, ...extra }));
      await step(1, 'AI_PROCESSING');
      await step(2, 'SUPPLEMENT_REQUIRED', { supplementDeadline: new Date(Date.now() + 1500).toISOString() });
      const v = 3;
      await delay(2000);
      await assert.rejects(store.supplement(as(alice), c2.claimId, { expectedVersion: v, documentIds: [await newDoc(alice, memberA)] }), domain);
      await step(v, 'CLOSED_EXPIRED');
      await assert.rejects(step(v + 1, 'DOCTOR_REVIEW'), domain); // terminal
    });

    await t.test('state + audit + outbox are atomic; audit/outbox failure leaves nothing and the same key succeeds later', async () => {
      const body = await submitBody(), call = as(alice), before = await countClaims();
      const broken = new ClaimsStore(identity, { ...runtime, appendOutboxEvent: async () => { throw new Error('synthetic outbox outage'); } },
        { claimPurpose: CLAIM_PURPOSE, documentPurpose: DOC_PURPOSE, preflight });
      await assert.rejects(broken.submit(call, body), err(503, 'DEPENDENCY_UNAVAILABLE'));
      const brokenAudit = new ClaimsStore(identity, { ...runtime, appendAudit: async () => { throw new Error('synthetic audit outage'); } },
        { claimPurpose: CLAIM_PURPOSE, documentPurpose: DOC_PURPOSE, preflight });
      await assert.rejects(brokenAudit.submit(call, body), err(503, 'DEPENDENCY_UNAVAILABLE'));
      assert.equal(await countClaims(), before);
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM tpa.claim_documents WHERE document_id=ANY($1)', [body.documentIds])).rows[0].n, 0);
      const ok = await store.submit(call, body);
      assert.equal(ok.status, 201); assert.equal(ok.replayed, false);
      // Rolled-back transition leaves version/status untouched.
      await assert.rejects(db.withTenantTransaction(T, tx => transitionClaim(tx, { ...runtime, appendOutboxEvent: async () => { throw new Error('outage'); } },
        { claimId: ok.body.claimId, expectedVersion: 1, toStatus: 'AI_PROCESSING', commandId: randomUUID(), actorType: 'SERVICE', actorId: svc })));
      assert.deepEqual((await admin.query('SELECT status,version FROM tpa.claims WHERE id=$1', [ok.body.claimId])).rows[0], { status: 'SUBMITTED', version: 1 });
      // Every committed claim version has exactly one event and the audit chain records each change.
      const { rows: events } = await admin.query(`SELECT event_type, aggregate_version, envelope FROM tpa.outbox_events WHERE tenant_id=$1 AND aggregate_id=$2 ORDER BY seq`, [T, claim1.claimId]);
      const { rows: [{ v: finalVersion }] } = await admin.query('SELECT version AS v FROM tpa.claims WHERE id=$1', [claim1.claimId]);
      assert.deepEqual(events.map(e => e.aggregate_version), Array.from({ length: finalVersion }, (_, i) => i + 1));
      assert.equal(events[0].event_type, 'claim.submitted'); assert.deepEqual(events[0].envelope.payload, {});
      assert.ok(events.slice(1).every(e => e.event_type === 'claim.state-changed' && Object.keys(e.envelope.payload).sort().join() === 'fromStatus,toStatus'));
      const { rows: audit } = await admin.query(`SELECT action FROM tpa.audit_logs WHERE tenant_id=$1 AND entity_id=$2 AND action<>'CLAIM_DETAIL_READ' ORDER BY sequence`, [T, claim1.claimId]);
      assert.equal(audit.length, finalVersion); assert.equal(audit[0].action, 'CLAIM_SUBMITTED');
      assert.ok(audit.some(a => a.action === 'CLAIM_SUPPLEMENTED'));
    });

    await t.test('PT17: no PII marker, raw key or storage key in events, audit or idempotency records', async () => {
      const { rows: [evidence] } = await admin.query(`SELECT (SELECT json_agg(o.envelope) FROM tpa.outbox_events o WHERE tenant_id=$1) AS events,
        (SELECT json_agg(a) FROM tpa.audit_logs a WHERE tenant_id=$1) AS audit,
        (SELECT json_agg(json_build_object('body',i.response_body,'hash',i.request_hash)) FROM tpa.idempotency_records i WHERE tenant_id=$1) AS idem`, [T]);
      // Events/audit carry status codes and hashes only; the idempotency replay body is the ClaimSummary (no ICD/PII/storage).
      assert.doesNotMatch(JSON.stringify([evidence.events, evidence.audit]), new RegExp(`${MARKER}|quarantine/|1500000|${memberA}|${call1.idempotencyKey}`));
      assert.doesNotMatch(JSON.stringify(evidence.idem), new RegExp(`${MARKER}|quarantine/|icd10`));
      const { rows: [row] } = await admin.query('SELECT to_jsonb(c) AS c FROM tpa.claims c WHERE id=$1', [claim1.claimId]);
      assert.doesNotMatch(JSON.stringify(row.c), new RegExp(call1.idempotencyKey), 'raw Idempotency-Key is never stored on the claim');
    });

    await t.test('PT01 DB guards: FORCE RLS, composite FK, immutable facts, transition trigger, no delete/truncate', async () => {
      const app = db;
      assert.equal((await app.withTenantTransaction(T2, tx => tx.query('SELECT * FROM tpa.claims'))).rows.length, 0);
      assert.equal((await app.withTenantTransaction(T2, tx => tx.query('SELECT * FROM tpa.claim_documents'))).rows.length, 0);
      await assert.rejects(app.withTenantTransaction(T2, tx => tx.query(`INSERT INTO tpa.claim_documents(tenant_id,claim_id,document_id,claim_version) VALUES($1,$2,$3,1)`,
        [T2, claim1.claimId, body1.documentIds[0]])), sqlCode('23503'));
      const spare = await newDoc(alice, memberA);
      await assert.rejects(app.withTenantTransaction(T2, tx => tx.query(`INSERT INTO tpa.claim_documents(tenant_id,claim_id,document_id,claim_version) VALUES($1,$2,$3,1)`,
        [T, claim1.claimId, spare])), sqlCode('42501'));
      await assert.rejects(app.withTenantTransaction(T, tx => tx.query(`UPDATE tpa.claims SET total_requested='1.00',version=version+1,status='AI_PROCESSING' WHERE id=$1`, [claim1.claimId])), sqlCode('42501'));
      await assert.rejects(app.withTenantTransaction(T, tx => tx.query(`UPDATE tpa.claims SET status='PAID',version=version+1 WHERE id=$1`, [claim1.claimId])), sqlCode('23514'));
      await assert.rejects(app.withTenantTransaction(T, tx => tx.query(`UPDATE tpa.claims SET status='AI_PROCESSING' WHERE id=$1`, [claim1.claimId])), sqlCode('23514'));
      await assert.rejects(app.withTenantTransaction(T, tx => tx.query('DELETE FROM tpa.claims WHERE id=$1', [claim1.claimId])), sqlCode('42501'));
      await assert.rejects(app.withTenantTransaction(T, tx => tx.query('DELETE FROM tpa.claim_documents WHERE claim_id=$1', [claim1.claimId])), sqlCode('42501'));
      await assert.rejects(app.withTenantTransaction(T, tx => tx.query('TRUNCATE tpa.claims')), sqlCode('42501'));
      await assert.rejects(app.withTenantTransaction(T, tx => tx.query(`INSERT INTO tpa.claims(tenant_id,id,claim_code,member_id,principal_id,membership_id,consent_id,submission_hash,benefit_type,visit_date,total_requested,preflight_id,preflight_version,status)
        VALUES($1,$2,'CLM-00000000000000000000',$3,$4,$5,$6,$7,'OUTPATIENT','2026-11-20','1.00',$2,1,'PAID')`, [T, randomUUID(), memberA, alice.principal, alice.membership, claimConsentA, 'f'.repeat(64)])), sqlCode('23514'));
      // Reused pooled connection keeps no tenant outside the transaction.
      const { rows: [policy] } = await admin.query(`SELECT c.relforcerowsecurity AS forced, (SELECT count(*)::int FROM pg_policies WHERE schemaname='tpa' AND tablename IN ('claims','claim_documents')) AS n
        FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='tpa' AND c.relname='claims'`);
      assert.deepEqual(policy, { forced: true, n: 2 });
    });
    console.log('PASS CLM-02 synthetic PG16: submit idempotency/concurrency, owner/guardian/staff reads, cursor list, expected-version transitions, supplement guards, atomic state/audit/outbox, RLS/FK/trigger guards, PII boundary.');
  } finally {
    await identity.close(); await issuer.close(); await db.close();
  }
}
