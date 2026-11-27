// NOTIF-01 (#107): template allowlist and handler contract, no database. PG behaviour: notification.e2e.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { NonRetryableEventError, assertInboxHandler } from '@tpa/database/inbox';
import { CLAIM_TEMPLATES, claimTemplate, createNotificationProjectionHandler } from '../src/consumers/notification-projection.ts';

const STATUSES = JSON.parse(readFileSync(new URL('../../../packages/event-contracts/registry/schemas/claim.state-changed/1.0.0.json', import.meta.url), 'utf8'))
  .properties.payload.properties.toStatus.enum as string[];
const ANNOUNCED = ['SUPPLEMENT_REQUIRED', 'WAITING_ORIGINAL_DOCS', 'EOB_READY', 'PAID', 'REJECTED', 'CLOSED_EXPIRED'];
const change = (toStatus: string) => ({ eventType: 'claim.state-changed', payload: { fromStatus: 'SUBMITTED', toStatus } });

test('every claim status is either an allowlisted template or deliberately silent (FRAUD_HOLD and review states never announced)', () => {
  const announced = STATUSES.filter(s => claimTemplate(change(s)) !== undefined);
  assert.deepEqual(announced.sort(), [...ANNOUNCED].sort());
  for (const silent of ['FRAUD_HOLD', 'DOCTOR_REVIEW', 'AI_PROCESSING', 'GREEN_STP', 'OTP_SIGNED', 'PAYOUT_PROCESSING', 'SUBMITTED', 'PREFLIGHT']) {
    assert.equal(claimTemplate(change(silent)), undefined, silent);
  }
  assert.equal(claimTemplate({ eventType: 'claim.submitted', payload: {} })?.key, 'CLAIM_SUBMITTED');
  assert.equal(claimTemplate({ eventType: 'eob.published', payload: {} }), undefined);
  assert.equal(claimTemplate(change('__proto__')), undefined);
  assert.equal(claimTemplate(change('toString')), undefined);
});

test('templates satisfy the DB text-safety CHECK and carry no PII, amounts, URLs, markup or OTP wording', () => {
  // Mirrors tpa.notification_text_safe in infra/migrations/0016_notifications.sql.
  const safe = (v: string, max: number) => v.length >= 1 && v.length <= max && v === v.trim() && !/[<>]/.test(v)
    && !/(:\/\/|www\.)/i.test(v) && !/[\u0000-\u001f\u007f]/.test(v) && !/[0-9]{6,}/.test(v);
  const keys = new Set<string>();
  for (const tpl of Object.values(CLAIM_TEMPLATES)) {
    assert.ok(Object.isFrozen(tpl));
    assert.match(tpl.key, /^[A-Z][A-Z0-9_]{2,63}$/); assert.equal(tpl.version, 1); keys.add(tpl.key);
    assert.ok(safe(tpl.titleVi, 120), tpl.key); assert.ok(safe(tpl.bodyVi, 280), tpl.key);
    assert.doesNotMatch(`${tpl.titleVi} ${tpl.bodyVi}`, /[0-9]|OTP|đ\b|VND|CCCD|chẩn đoán|bệnh|gian lận/i, tpl.key);
  }
  assert.equal(keys.size, Object.keys(CLAIM_TEMPLATES).length, 'template keys are unique');
  assert.match(CLAIM_TEMPLATES.EOB_READY.bodyVi, /không phải là xác nhận/, 'reading is not an EOB confirmation');
  assert.ok(Object.isFrozen(CLAIM_TEMPLATES));
});

test('handler: valid inbox contract; recipient comes from PostgreSQL truth, never the event; mismatch fails closed', async () => {
  const handler = createNotificationProjectionHandler();
  assertInboxHandler(handler);
  assert.deepEqual([...handler.eventTypes], ['claim.submitted', 'claim.state-changed']);
  const calls: { sql: string; values?: unknown[] }[] = [];
  const claimRow = { principal_id: '00000000-0000-4000-8000-0000000000a1', membership_id: '00000000-0000-4000-8000-0000000000b1', version: 4 };
  const tx = { async query(sql: string, values?: unknown[]) { calls.push({ sql, values }); return { rows: sql.startsWith('SELECT') ? [claimRow] : [], rowCount: 1 }; } };
  const base = { eventId: '00000000-0000-4000-8000-0000000000e1', aggregateId: '00000000-0000-4000-8000-0000000000c1', occurredAt: '2026-11-27T03:00:00.000Z',
    tenantId: '00000000-0000-4000-8000-0000000000f1', schemaVersion: '1.0.0', correlationId: '00000000-0000-4000-8000-0000000000d1', causationId: '00000000-0000-4000-8000-0000000000d2' };
  await handler.apply(tx as never, { ...base, eventType: 'claim.state-changed', aggregateVersion: 4, payload: { fromStatus: 'DOCTOR_REVIEW', toStatus: 'FRAUD_HOLD' } } as never);
  assert.equal(calls.length, 0, 'silent statuses do not even read the claim');
  await handler.apply(tx as never, { ...base, eventType: 'claim.state-changed', aggregateVersion: 4, payload: { fromStatus: 'DOCTOR_REVIEW', toStatus: 'SUPPLEMENT_REQUIRED' } } as never);
  const insert = calls.find(c => c.sql.includes('INSERT INTO tpa.tenant_notifications'))!;
  assert.match(insert.sql, /tpa\.current_tenant_id\(\)/, 'tenant from SET LOCAL context, never the envelope');
  assert.match(insert.sql, /ON CONFLICT DO NOTHING/);
  assert.deepEqual(insert.values!.slice(0, 2), [claimRow.principal_id, claimRow.membership_id]);
  assert.ok(!insert.values!.includes(base.tenantId));
  await assert.rejects(handler.apply(tx as never, { ...base, eventType: 'claim.state-changed', aggregateVersion: 5, payload: { fromStatus: 'DOCTOR_REVIEW', toStatus: 'REJECTED' } } as never),
    NonRetryableEventError);
});
