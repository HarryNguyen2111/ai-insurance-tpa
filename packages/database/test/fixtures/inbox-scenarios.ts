// TEST ONLY: EVT-02 (#24) PG scenarios shared by inbox.integration.test.ts (Docker PG16).
// PT08 (duplicate / old event / version gap) and DB halves of PT05/PT17 for consumers.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type pg from 'pg';
import { buildEventEnvelope, type EventEnvelope } from '@tpa/event-contracts';
import {
  discardParkedEvent, listParkedEvents, parkInboxEvent, processInboxEvent, replayParkedEvents, ReplayDeniedError,
  type InboxHandler, type QuarantineSink, type ReplayAuthorizer,
} from '../../src/inbox.ts';
import type { TenantDatabase } from '../../src/tenant.ts';
import { syntheticHandler } from './synthetic-handler.ts';

export interface InboxScenarioContext {
  db: TenantDatabase; // tpa_app
  admin: pg.Client; // superuser, for inspection only
  raw: pg.Client; // tpa_app without tenant context
  quarantine: QuarantineSink;
}
export const MARKER = 'PT17-SYNTHETIC-MARKER-079123456789-0912345678';
const sqlCode = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;
const allow: ReplayAuthorizer = async () => true;

export async function inboxScenarios(t: TestContext, { db, admin, raw, quarantine }: InboxScenarioContext): Promise<void> {
  const [A, B] = [randomUUID(), randomUUID()];
  const operator = randomUUID();
  const ev = (tenant: string, aggregateId: string, aggregateVersion: number, toStatus = 'AI_PROCESSING'): Readonly<EventEnvelope> =>
    buildEventEnvelope(tenant, aggregateVersion === 1
      ? { eventType: 'claim.submitted', aggregateId, aggregateVersion, correlationId: randomUUID(), causationId: randomUUID(), payload: {} }
      : { eventType: 'claim.state-changed', aggregateId, aggregateVersion, correlationId: randomUUID(), causationId: randomUUID(),
        payload: { fromStatus: 'SUBMITTED', toStatus } }).envelope;
  const q = <R extends pg.QueryResultRow>(tenant: string, sql: string, params: unknown[] = []) =>
    db.withTenantTransaction(tenant, async tx => (await tx.query<R>(sql, params)).rows);
  const effects = async (tenant: string, eventId: string, consumer = 'synthetic-projection') =>
    (await q<{ n: number }>(tenant, 'SELECT count(*)::int AS n FROM tpa.synthetic_effects WHERE event_id=$1 AND consumer_name=$2', [eventId, consumer]))[0].n;
  const projection = async (tenant: string, aggregate: string) =>
    (await q<{ version: number; status: string }>(tenant, 'SELECT version, status FROM tpa.synthetic_projection WHERE aggregate_id=$1', [aggregate]))[0];
  const inbox = async (tenant: string, eventId: string) =>
    (await q<{ outcome: string; replayed_from: string | null }>(tenant, 'SELECT outcome, replayed_from::text FROM tpa.consumer_inbox WHERE event_id=$1', [eventId]))[0];
  const auditActions = async (tenant: string, entityId: string) =>
    (await q<{ action: string }>(tenant, 'SELECT action FROM tpa.audit_logs WHERE entity_id=$1 ORDER BY sequence', [entityId])).map(r => r.action);

  await t.test('PT08 duplicate: redelivery is skipped; the effect happens exactly once', async () => {
    const handler = syntheticHandler();
    const e1 = ev(A, randomUUID(), 1);
    assert.deepEqual(await processInboxEvent(db, handler, e1), { kind: 'applied', version: 1 });
    for (let i = 0; i < 3; i++) assert.deepEqual(await processInboxEvent(db, handler, structuredClone(e1)), { kind: 'duplicate' });
    assert.equal(await effects(A, e1.eventId), 1);
    assert.deepEqual(await inbox(A, e1.eventId), { outcome: 'APPLIED', replayed_from: null });
  });

  await t.test('rebalance overlap: concurrent processing of one event commits one effect', async () => {
    const handler = syntheticHandler();
    const e1 = ev(A, randomUUID(), 1);
    const results = await Promise.all(Array.from({ length: 4 }, () => processInboxEvent(db, handler, e1)));
    assert.deepEqual(results.map(r => r.kind).sort(), ['applied', 'duplicate', 'duplicate', 'duplicate']);
    assert.equal(await effects(A, e1.eventId), 1);
  });

  await t.test('crash inside the effect transaction rolls effect and inbox back; retry applies once', async () => {
    let crash = true;
    const handler = syntheticHandler({ afterApply: async () => { if (crash) throw new Error('process died mid-transaction'); } });
    const e1 = ev(A, randomUUID(), 1);
    await assert.rejects(processInboxEvent(db, handler, e1), /mid-transaction/);
    assert.equal(await effects(A, e1.eventId), 0);
    assert.equal(await inbox(A, e1.eventId), undefined);
    crash = false;
    assert.equal((await processInboxEvent(db, handler, e1)).kind, 'applied');
    assert.equal(await effects(A, e1.eventId), 1);
  });

  await t.test('PT08 out-of-order/old event: stale versions are recorded but never roll the projection back', async () => {
    const handler = syntheticHandler();
    const aggregate = randomUUID();
    const [v1, v2, v3] = [ev(A, aggregate, 1), ev(A, aggregate, 2, 'DOCTOR_REVIEW'), ev(A, aggregate, 3, 'EOB_READY')];
    for (const e of [v1, v2, v3]) assert.equal((await processInboxEvent(db, handler, e)).kind, 'applied');
    const oldCopy = ev(A, aggregate, 2, 'SUBMITTED'); // distinct eventId, older version (e.g. re-emitted/replayed)
    assert.deepEqual(await processInboxEvent(db, handler, oldCopy), { kind: 'stale', version: 3 });
    assert.equal(await effects(A, oldCopy.eventId), 0);
    assert.deepEqual(await projection(A, aggregate), { version: 3, status: 'EOB_READY' });
    assert.equal((await inbox(A, oldCopy.eventId)).outcome, 'STALE');
    assert.equal((await processInboxEvent(db, handler, oldCopy)).kind, 'duplicate');
  });

  await t.test('PT08 version gap with reconcile: authorized snapshot reload, later old events are stale', async () => {
    const handler = syntheticHandler({ withReconcile: true });
    const aggregate = randomUUID();
    await db.withTenantTransaction(A, tx => tx.query("INSERT INTO tpa.synthetic_source VALUES (tpa.current_tenant_id(), $1, 5, 'PAID')", [aggregate]));
    assert.equal((await processInboxEvent(db, handler, ev(A, aggregate, 1))).kind, 'applied');
    const v4 = ev(A, aggregate, 4, 'OTP_SIGNED');
    assert.deepEqual(await processInboxEvent(db, handler, v4), { kind: 'reconciled', version: 5 });
    assert.deepEqual(await projection(A, aggregate), { version: 5, status: 'PAID' });
    for (const v of [2, 3, 5]) assert.equal((await processInboxEvent(db, handler, ev(A, aggregate, v))).kind, 'stale');
    assert.deepEqual(await projection(A, aggregate), { version: 5, status: 'PAID' }, 'no rollback');
    assert.equal((await inbox(A, v4.eventId)).outcome, 'RECONCILED');
  });

  await t.test('gap without reconcile parks; later versions park behind it; predecessor still applies; audited replay restores order', async () => {
    const handler = syntheticHandler({ consumerName: 'gap-projection' });
    const aggregate = randomUUID();
    const [v1, v2, v3, v4] = [ev(A, aggregate, 1), ev(A, aggregate, 2, 'DOCTOR_REVIEW'), ev(A, aggregate, 3, 'EOB_READY'), ev(A, aggregate, 4, 'OTP_SIGNED')];
    assert.equal((await processInboxEvent(db, handler, v1)).kind, 'applied');
    const p3 = await processInboxEvent(db, handler, v3, { topic: 'tpa.e2e.claim', partition: 1, offset: '42' });
    assert.ok(p3.kind === 'parked' && p3.reason === 'VERSION_GAP' && p3.created);
    const p4 = await processInboxEvent(db, handler, v4);
    assert.ok(p4.kind === 'parked' && p4.reason === 'BLOCKED_BY_PARKED');
    assert.equal((await processInboxEvent(db, handler, v3)).kind, 'duplicate', 'redelivered parked event is not re-parked');
    assert.equal((await processInboxEvent(db, handler, v2)).kind, 'applied', 'the missing predecessor is not blocked');
    assert.deepEqual(await projection(A, aggregate), { version: 2, status: 'DOCTOR_REVIEW' });
    const parked = await listParkedEvents(db, A, 'gap-projection');
    assert.deepEqual(parked.map(p => [p.aggregateVersion, p.reasonCode]), [[3, 'VERSION_GAP'], [4, 'BLOCKED_BY_PARKED']]);

    assert.deepEqual(await replayParkedEvents(db, handler, A, { actorId: operator }, allow),
      { applied: 2, reconciled: 0, stale: 0, stillParked: 0, failed: 0, alreadyResolved: 0 });
    assert.deepEqual(await projection(A, aggregate), { version: 4, status: 'OTP_SIGNED' });
    for (const e of [v3, v4]) {
      assert.equal(await effects(A, e.eventId, 'gap-projection'), 1);
      assert.equal((await inbox(A, e.eventId)).outcome, 'APPLIED');
    }
    for (const p of parked) {
      assert.deepEqual(await auditActions(A, p.id), ['EVENT_REPLAY']);
      const [row] = await q<{ status: string; resolved_by: string; resolution: string }>(A,
        'SELECT status, resolved_by::text, resolution FROM tpa.consumer_parked_events WHERE id=$1', [p.id]);
      assert.deepEqual(row, { status: 'REPLAYED', resolved_by: operator, resolution: 'APPLIED' });
    }
    assert.deepEqual(await replayParkedEvents(db, handler, A, { actorId: operator }, allow),
      { applied: 0, reconciled: 0, stale: 0, stillParked: 0, failed: 0, alreadyResolved: 0 }, 'replaying again repeats nothing');
    for (const e of [v3, v4]) assert.equal(await effects(A, e.eventId, 'gap-projection'), 1);
  });

  await t.test('bounded retry: exhausted event parks (codes only), failed replay is audited, fixed replay applies once; discard is audited', async () => {
    let broken = true;
    const handler: InboxHandler = syntheticHandler({ consumerName: 'retry-projection',
      fail: () => broken ? new TypeError(`downstream rejected ${MARKER}`) : undefined });
    const aggregate = randomUUID();
    const v1 = ev(A, aggregate, 1);
    await assert.rejects(processInboxEvent(db, handler, v1), TypeError);
    const parked = await parkInboxEvent(db, handler, v1, 'RETRY_EXHAUSTED', 3, new TypeError(MARKER), { topic: 'tpa.e2e.claim', partition: 0, offset: '7' });
    assert.ok(parked.kind === 'parked' && parked.created);
    const again = await parkInboxEvent(db, handler, v1, 'RETRY_EXHAUSTED', 3, new TypeError('x'));
    assert.ok(again.kind === 'parked' && !again.created && again.parkedId === parked.parkedId, 'parking is idempotent');
    const [row] = await q<{ reason_code: string; attempts: number; error_name: string; source_offset: string; text: string }>(A,
      'SELECT reason_code, attempts, error_name, source_offset::text, p::text AS text FROM tpa.consumer_parked_events p WHERE id=$1', [parked.parkedId]);
    assert.deepEqual({ ...row, text: undefined }, { reason_code: 'RETRY_EXHAUSTED', attempts: 3, error_name: 'TypeError', source_offset: '7', text: undefined });
    assert.ok(!row.text.includes(MARKER), 'error message is never stored');

    assert.deepEqual(await replayParkedEvents(db, handler, A, { actorId: operator }, allow),
      { applied: 0, reconciled: 0, stale: 0, stillParked: 0, failed: 1, alreadyResolved: 0 });
    assert.deepEqual(await auditActions(A, parked.parkedId), ['EVENT_REPLAY_FAILED']);
    assert.equal((await q<{ n: number }>(A, 'SELECT replay_attempts AS n FROM tpa.consumer_parked_events WHERE id=$1', [parked.parkedId]))[0].n, 1);
    broken = false;
    assert.equal((await replayParkedEvents(db, handler, A, { actorId: operator, parkedIds: [parked.parkedId] }, allow)).applied, 1);
    assert.equal(await effects(A, v1.eventId, 'retry-projection'), 1);
    assert.deepEqual(await auditActions(A, parked.parkedId), ['EVENT_REPLAY_FAILED', 'EVENT_REPLAY']);

    const poison = ev(A, randomUUID(), 1);
    const p = await parkInboxEvent(db, handler, poison, 'HANDLER_REJECTED', 1, new Error('x'));
    assert.ok(p.kind === 'parked');
    assert.equal(await discardParkedEvent(db, A, 'retry-projection', p.parkedId, operator, allow), true);
    assert.equal(await discardParkedEvent(db, A, 'retry-projection', p.parkedId, operator, allow), false, 'already resolved');
    assert.deepEqual(await auditActions(A, p.parkedId), ['EVENT_DISCARD']);
    assert.equal((await processInboxEvent(db, handler, poison)).kind, 'duplicate', 'discarded event is not re-applied on redelivery');
    assert.equal(await effects(A, poison.eventId, 'retry-projection'), 0);
  });

  await t.test('replay is authorized: denied operators change nothing and leave no audit', async () => {
    const handler = syntheticHandler({ consumerName: 'denied-projection' });
    const aggregate = randomUUID();
    await processInboxEvent(db, handler, ev(A, aggregate, 1));
    const p = await processInboxEvent(db, handler, ev(A, aggregate, 3));
    assert.ok(p.kind === 'parked');
    for (const authorize of [async () => false, async () => { throw new Error('idp down'); }] as ReplayAuthorizer[]) {
      await assert.rejects(replayParkedEvents(db, handler, A, { actorId: operator }, authorize), ReplayDeniedError);
      await assert.rejects(discardParkedEvent(db, A, 'denied-projection', p.parkedId, operator, authorize), ReplayDeniedError);
    }
    assert.equal((await listParkedEvents(db, A, 'denied-projection')).length, 1);
    assert.deepEqual(await auditActions(A, p.parkedId), []);
    // Replay authorized for tenant B cannot touch tenant A's parked rows (RLS).
    assert.deepEqual(await replayParkedEvents(db, handler, B, { actorId: operator }, allow),
      { applied: 0, reconciled: 0, stale: 0, stillParked: 0, failed: 0, alreadyResolved: 0 });
    assert.equal((await listParkedEvents(db, A, 'denied-projection')).length, 1);
  });

  await t.test('RLS and immutability: tenant isolation, append-only inbox, advancing positions, resolved parking immutable', async () => {
    const handler = syntheticHandler({ consumerName: 'guard-projection' });
    const aggregate = randomUUID();
    const v1 = ev(A, aggregate, 1);
    await processInboxEvent(db, handler, v1);
    const parked = await processInboxEvent(db, handler, ev(A, aggregate, 3));
    assert.ok(parked.kind === 'parked');
    assert.equal(await inbox(B, v1.eventId), undefined, 'tenant B cannot see tenant A inbox');
    assert.deepEqual(await listParkedEvents(db, B, 'guard-projection'), []);
    for (const table of ['consumer_inbox', 'consumer_aggregate_positions', 'consumer_parked_events']) {
      await assert.rejects(raw.query(`SELECT * FROM tpa.${table}`), sqlCode('42501'), `${table} requires tenant context`);
    }
    const denied: [string, unknown[]][] = [
      ["UPDATE tpa.consumer_inbox SET outcome='STALE' WHERE event_id=$1", [v1.eventId]],
      ['DELETE FROM tpa.consumer_inbox WHERE event_id=$1', [v1.eventId]],
      ['TRUNCATE tpa.consumer_inbox', []],
      ['UPDATE tpa.consumer_aggregate_positions SET last_version=0 WHERE aggregate_id=$1', [aggregate]],
      ['DELETE FROM tpa.consumer_aggregate_positions WHERE aggregate_id=$1', [aggregate]],
      ["UPDATE tpa.consumer_parked_events SET envelope='{}' WHERE id=$1", [parked.parkedId]],
      ["UPDATE tpa.consumer_parked_events SET reason_code='VERSION_GAP' WHERE id=$1", [parked.parkedId]],
      ['DELETE FROM tpa.consumer_parked_events WHERE id=$1', [parked.parkedId]],
    ];
    for (const [sql, params] of denied) await assert.rejects(q(A, sql, params), sqlCode('42501'), sql);
    await discardParkedEvent(db, A, 'guard-projection', parked.parkedId, operator, allow);
    await assert.rejects(q(A, "UPDATE tpa.consumer_parked_events SET status='PARKED', resolved_by=NULL, resolution=NULL WHERE id=$1",
      [parked.parkedId]), sqlCode('42501'), 'resolved rows are immutable');
    // Even an RLS-bypassing superuser hits the guards.
    await assert.rejects(admin.query('UPDATE tpa.consumer_inbox SET outcome=$1 WHERE event_id=$2', ['STALE', v1.eventId]), sqlCode('42501'));
    await assert.rejects(admin.query('DELETE FROM tpa.consumer_parked_events WHERE id=$1', [parked.parkedId]), sqlCode('42501'));
  });

  await t.test('quarantine keeps only coordinates + sha256 and is not readable by the app', async () => {
    const source = { topic: 'tpa.e2e.claim', partition: 2, offset: '99' };
    const rawBytes = Buffer.from(`{"note":"${MARKER}"}`);
    assert.equal(await quarantine.quarantine('synthetic-projection', source, rawBytes, 'SCHEMA_INVALID'), true);
    assert.equal(await quarantine.quarantine('synthetic-projection', source, rawBytes, 'SCHEMA_INVALID'), false, 'idempotent per coordinates');
    await assert.rejects(raw.query('SELECT * FROM tpa.consumer_quarantine'), sqlCode('42501'));
    await assert.rejects(raw.query("INSERT INTO tpa.consumer_quarantine (consumer_name, source_topic, source_partition, source_offset, record_sha256, reason_code) VALUES ('abc','t',0,0,repeat('a',64),'UNPARSEABLE')"), sqlCode('42501'));
    const { rows } = await admin.query("SELECT q::text AS text, record_sha256 FROM tpa.consumer_quarantine q WHERE source_offset=99");
    assert.equal(rows.length, 1);
    assert.match(rows[0].record_sha256, /^[0-9a-f]{64}$/);
  });

  await t.test('PT17 (DB half): no PII marker in inbox, positions, parked rows or quarantine', async () => {
    const { rows: [{ n }] } = await admin.query(`SELECT
      (SELECT count(*) FROM tpa.consumer_inbox x WHERE x::text LIKE $1) + (SELECT count(*) FROM tpa.consumer_aggregate_positions x WHERE x::text LIKE $1)
      + (SELECT count(*) FROM tpa.consumer_parked_events x WHERE x::text LIKE $1) + (SELECT count(*) FROM tpa.consumer_quarantine x WHERE x::text LIKE $1) AS n`,
      [`%${MARKER}%`]);
    assert.equal(Number(n), 0);
    const { rows: [{ parked }] } = await admin.query('SELECT count(*)::int AS parked FROM tpa.consumer_parked_events');
    assert.ok(parked >= 5, 'parked rows were actually scanned');
  });
}
