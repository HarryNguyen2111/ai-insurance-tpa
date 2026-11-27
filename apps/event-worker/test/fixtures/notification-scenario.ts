// NOTIF-01 (#107) producer scenario: real claim rows, real outbox envelopes (appendOutboxEvent in a tpa_app
// tenant transaction), inbox processing with FORCE RLS. Synthetic tenants/principals/claims only.
// `deliver` moves committed outbox events to the notification consumer: Kafka relay + consumer in CI
// (notification.e2e.test.ts), or direct processInboxEvent for local non-PG16 feedback.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type pg from 'pg';
import { buildEventEnvelope, type EventEnvelope } from '@tpa/event-contracts';
import { appendOutboxEvent } from '@tpa/database/outbox';
import { NonRetryableEventError, processInboxEvent, type InboxHandler } from '@tpa/database/inbox';
import { createTenantDatabase } from '@tpa/database/tenant';
import { createNotificationProjectionHandler } from '../../src/consumers/notification-projection.ts';

const MARKER = 'PIIMARK-0912345678';
const POLICY_HASH = 'a'.repeat(64);
export const NOTIFICATION_CONSUMER = 'notification-projection';

export async function runNotificationProjectionScenario(t: TestContext, { url, admin, deliver }: {
  url: (user: 'tpa_app') => string; admin: pg.Client;
  /** Publish every committed outbox row and resolve once the consumer has durably processed `expectedInbox` rows. */
  deliver: (expectedInbox: number) => Promise<void>;
}): Promise<void> {
  const db = createTenantDatabase({ connectionString: url('tpa_app'), max: 4 });
  const handler = createNotificationProjectionHandler();
  try {
    const T1 = randomUUID(), T2 = randomUUID();
    async function person(tenant: string) {
      const principal = randomUUID(), membership = randomUUID(), member = randomUUID(), consent = randomUUID();
      await admin.query('INSERT INTO tpa.identity_principals(id,identity_hash) VALUES($1,$2)', [principal, randomUUID().replaceAll('-', '').padEnd(64, '0')]);
      await admin.query(`INSERT INTO tpa.identity_memberships(tenant_id,id,principal_id,roles) VALUES($1,$2,$3,'{MEMBER}')`, [tenant, membership, principal]);
      await admin.query(`INSERT INTO tpa.consent_policies(tenant_id,purpose,policy_version,policy_hash) VALUES($1,'SYNTHETIC_CLAIM_PROCESSING','v1',$2) ON CONFLICT DO NOTHING`, [tenant, POLICY_HASH]);
      await admin.query(`INSERT INTO tpa.consent_records(tenant_id,id,member_id,principal_id,membership_id,purpose,policy_version,policy_hash)
        VALUES($1,$2,$3,$4,$5,'SYNTHETIC_CLAIM_PROCESSING','v1',$6)`, [tenant, consent, member, principal, membership, POLICY_HASH]);
      return { tenant, principal, membership, member, consent };
    }
    type Person = Awaited<ReturnType<typeof person>>;
    async function claim(p: Person): Promise<string> {
      const id = randomUUID();
      await admin.query(`INSERT INTO tpa.claims(tenant_id,id,claim_code,member_id,principal_id,membership_id,consent_id,submission_hash,benefit_type,
          visit_date,total_requested,icd10_code,preflight_id,preflight_version,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'OUTPATIENT','2026-11-20','1500000.00',$9,$10,1,'SUBMITTED')`,
      [p.tenant, id, `CLM-${randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase()}`, p.member, p.principal, p.membership, p.consent,
        randomUUID().replaceAll('-', '').padEnd(64, '0'), MARKER, randomUUID()]);
      await emit(p.tenant, { eventType: 'claim.submitted', aggregateId: id, aggregateVersion: 1, payload: {} });
      return id;
    }
    async function emit(tenant: string, draft: { eventType: string; aggregateId: string; aggregateVersion: number; payload: Record<string, unknown> }) {
      // Same helper the claims store uses; the outbox row commits in a tenant transaction.
      await db.withTenantTransaction(tenant, tx => appendOutboxEvent(tx, { ...draft, correlationId: randomUUID(), causationId: randomUUID() }));
    }
    async function move(tenant: string, id: string, from: string, to: string, version: number) {
      await admin.query(`UPDATE tpa.claims SET status=$3,version=$4,supplement_deadline=CASE WHEN $3='SUPPLEMENT_REQUIRED' THEN clock_timestamp()+interval '15 days' END
        WHERE tenant_id=$1 AND id=$2`, [tenant, id, to, version]);
      await emit(tenant, { eventType: 'claim.state-changed', aggregateId: id, aggregateVersion: version, payload: { fromStatus: from, toStatus: to } });
    }
    const rows = async (tenant: string) => (await admin.query(`SELECT recipient_principal_id::text AS principal, recipient_membership_id::text AS membership,
      template_key, priority, target_id::text AS target, source_event_type, source_aggregate_version AS version, title_vi, body_vi, read_at
      FROM tpa.tenant_notifications WHERE tenant_id=$1 ORDER BY created_at, id`, [tenant])).rows;
    const inbox = async () => (await admin.query(`SELECT count(*)::int AS n FROM tpa.consumer_inbox WHERE consumer_name=$1`, [NOTIFICATION_CONSUMER])).rows[0].n as number;

    const alice = await person(T1), bob = await person(T1), carol = await person(T2);
    let aliceClaim = '', bobClaim = '', carolClaim = '';

    await t.test('real claim events -> recipient-scoped tenant notifications; internal/FRAUD states produce nothing', async () => {
      aliceClaim = await claim(alice); bobClaim = await claim(bob); carolClaim = await claim(carol);
      await move(T1, aliceClaim, 'SUBMITTED', 'AI_PROCESSING', 2);
      await move(T1, aliceClaim, 'AI_PROCESSING', 'DOCTOR_REVIEW', 3);
      await move(T1, aliceClaim, 'DOCTOR_REVIEW', 'SUPPLEMENT_REQUIRED', 4);
      await move(T1, bobClaim, 'SUBMITTED', 'AI_PROCESSING', 2);
      await move(T1, bobClaim, 'AI_PROCESSING', 'FRAUD_HOLD', 3);
      await deliver(8);
      const t1 = await rows(T1);
      const mine = (p: Person) => t1.filter(r => r.principal === p.principal);
      assert.deepEqual(mine(alice).map(r => [r.template_key, r.version, r.target, r.membership]),
        [['CLAIM_SUBMITTED', 1, aliceClaim, alice.membership], ['CLAIM_SUPPLEMENT_REQUIRED', 4, aliceClaim, alice.membership]]);
      assert.equal(mine(alice)[1].priority, 'ACTION_REQUIRED');
      assert.deepEqual(mine(bob).map(r => r.template_key), ['CLAIM_SUBMITTED'], 'FRAUD_HOLD/AI/doctor review are never announced');
      assert.equal(t1.length, 3, 'no T2 or cross-recipient rows in T1');
      assert.deepEqual((await rows(T2)).map(r => [r.principal, r.target]), [[carol.principal, carolClaim]]);
      assert.ok(t1.every(r => r.read_at === null));
    });

    await t.test('zero PII/medical markers in outbox envelopes and notifications; text is the fixed template', async () => {
      const { rows: [hits] } = await admin.query(`SELECT
          (SELECT count(*)::int FROM tpa.outbox_events WHERE envelope::text LIKE '%'||$1||'%') AS outbox,
          (SELECT count(*)::int FROM tpa.tenant_notifications WHERE (to_jsonb(tenant_notifications)::text) LIKE '%'||$1||'%') AS notif,
          (SELECT count(*)::int FROM tpa.tenant_notifications WHERE to_jsonb(tenant_notifications)::text ~ '1500000') AS amounts`, [MARKER]);
      assert.deepEqual(hits, { outbox: 0, notif: 0, amounts: 0 });
      for (const r of await rows(T1)) { assert.doesNotMatch(`${r.title_vi} ${r.body_vi}`, /[0-9]|https?:|<|CLM-/); }
    });

    // The remaining checks drive processInboxEvent directly with envelopes that never enter Kafka.
    const envelope = (tenant: string, draft: { eventType: string; aggregateId: string; aggregateVersion: number; payload: Record<string, unknown> }): EventEnvelope =>
      buildEventEnvelope(tenant, { ...draft, correlationId: randomUUID(), causationId: randomUUID() }).envelope as EventEnvelope;
    const count = async (tenant: string, claimId: string) => (await admin.query(
      'SELECT count(*)::int AS n FROM tpa.tenant_notifications WHERE tenant_id=$1 AND target_id=$2', [tenant, claimId])).rows[0].n as number;

    await t.test('at-least-once dedup: redelivery is a no-op; a lost inbox row still cannot duplicate (unique source key)', async () => {
      await move(T1, aliceClaim, 'SUPPLEMENT_REQUIRED', 'SUBMITTED', 5); // supplement re-entry: not re-announced
      await move(T1, aliceClaim, 'SUBMITTED', 'AI_PROCESSING', 6);
      await move(T1, aliceClaim, 'AI_PROCESSING', 'GREEN_STP', 7);
      await deliver(11);
      const before = await count(T1, aliceClaim);
      assert.equal(before, 2, 'SUBMITTED re-entry, AI and STP states are not announced');
      const eob = envelope(T1, { eventType: 'claim.state-changed', aggregateId: aliceClaim, aggregateVersion: 8, payload: { fromStatus: 'GREEN_STP', toStatus: 'EOB_READY' } });
      await admin.query(`UPDATE tpa.claims SET status='EOB_READY',version=8 WHERE tenant_id=$1 AND id=$2`, [T1, aliceClaim]);
      assert.equal((await processInboxEvent(db, handler, eob)).kind, 'applied');
      assert.equal((await processInboxEvent(db, handler, eob)).kind, 'duplicate');
      // Simulate a lost inbox row: apply the effect again in a fresh tenant transaction.
      await db.withTenantTransaction(T1, tx => handler.apply(tx, eob));
      assert.equal(await count(T1, aliceClaim), before + 1);
      const [row] = (await rows(T1)).filter(r => r.template_key === 'CLAIM_EOB_READY');
      assert.match(row.body_vi, /không phải là xác nhận/, 'reading is explicitly not an EOB confirmation');
    });

    await t.test('atomicity: a crash after the insert rolls back notification and inbox together; retry applies once', async () => {
      const paid = envelope(T1, { eventType: 'claim.state-changed', aggregateId: aliceClaim, aggregateVersion: 9, payload: { fromStatus: 'OTP_SIGNED', toStatus: 'PAID' } });
      await admin.query(`UPDATE tpa.claims SET status='OTP_SIGNED',version=9 WHERE tenant_id=$1 AND id=$2`, [T1, aliceClaim]);
      const crashing: InboxHandler = { ...handler, async apply(tx, e) { await handler.apply(tx, e); throw new Error('Synthetic crash after insert'); } };
      const before = await count(T1, aliceClaim);
      await assert.rejects(processInboxEvent(db, crashing, paid));
      assert.equal(await count(T1, aliceClaim), before, 'no orphan notification without inbox');
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM tpa.consumer_inbox WHERE consumer_name=$1 AND event_id=$2`, [NOTIFICATION_CONSUMER, paid.eventId])).rows[0].n, 0);
      assert.equal((await processInboxEvent(db, handler, paid)).kind, 'applied');
      assert.equal(await count(T1, aliceClaim), before + 1);
    });

    await t.test('out-of-order delivery is harmless; events not matching PostgreSQL truth fail closed (park)', async () => {
      const later = envelope(T2, { eventType: 'claim.state-changed', aggregateId: carolClaim, aggregateVersion: 3, payload: { fromStatus: 'DOCTOR_REVIEW', toStatus: 'REJECTED' } });
      const earlier = envelope(T2, { eventType: 'claim.state-changed', aggregateId: carolClaim, aggregateVersion: 2, payload: { fromStatus: 'AI_PROCESSING', toStatus: 'SUPPLEMENT_REQUIRED' } });
      await admin.query(`UPDATE tpa.claims SET status='AI_PROCESSING',version=2 WHERE tenant_id=$1 AND id=$2`, [T2, carolClaim]);
      await admin.query(`UPDATE tpa.claims SET status='DOCTOR_REVIEW',version=3 WHERE tenant_id=$1 AND id=$2`, [T2, carolClaim]);
      assert.equal((await processInboxEvent(db, handler, later)).kind, 'applied');
      assert.equal((await processInboxEvent(db, handler, earlier)).kind, 'applied');
      assert.deepEqual((await rows(T2)).map(r => [r.template_key, r.version]).sort(),
        [['CLAIM_DECISION_AVAILABLE', 3], ['CLAIM_SUBMITTED', 1], ['CLAIM_SUPPLEMENT_REQUIRED', 2]]);
      const ghost = envelope(T1, { eventType: 'claim.submitted', aggregateId: randomUUID(), aggregateVersion: 1, payload: {} });
      await assert.rejects(processInboxEvent(db, handler, ghost), NonRetryableEventError);
      const future = envelope(T1, { eventType: 'claim.state-changed', aggregateId: bobClaim, aggregateVersion: 99, payload: { fromStatus: 'FRAUD_HOLD', toStatus: 'REJECTED' } });
      await assert.rejects(processInboxEvent(db, handler, future), NonRetryableEventError);
      // Cross-tenant: an event stamped T2 for a T1 claim cannot see the claim under FORCE RLS.
      const crossed = envelope(T2, { eventType: 'claim.submitted', aggregateId: aliceClaim, aggregateVersion: 1, payload: {} });
      await assert.rejects(processInboxEvent(db, handler, crossed), NonRetryableEventError);
      assert.equal(await count(T2, aliceClaim), 0);
    });

    await t.test('producer cannot read inbox rows back, and app role cannot edit or delete notification content', async () => {
      await db.withTenantTransaction(T1, async tx => {
        assert.equal((await tx.query('SELECT count(*)::int AS n FROM tpa.tenant_notifications')).rows[0].n, 0, 'no identity context: no rows visible');
        assert.equal((await tx.query(`UPDATE tpa.tenant_notifications SET read_at=clock_timestamp(), version=2`)).rowCount, 0);
      });
      await assert.rejects(db.withTenantTransaction(T1, tx => tx.query(`UPDATE tpa.tenant_notifications SET title_vi='x'`)), (e: { code?: string }) => e?.code === '42501');
      await assert.rejects(db.withTenantTransaction(T1, tx => tx.query('DELETE FROM tpa.tenant_notifications')), (e: { code?: string }) => e?.code === '42501');
      await assert.rejects(db.withTenantTransaction(T1, tx => tx.query('INSERT INTO tpa.personal_notifications(id) VALUES(gen_random_uuid())')), (e: { code?: string }) => e?.code === '42501');
      assert.ok(await inbox() >= 11);
    });
  } finally {
    await db.close();
  }
}
