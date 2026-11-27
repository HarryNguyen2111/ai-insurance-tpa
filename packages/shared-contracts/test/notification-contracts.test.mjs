// NOTIF-01 (#107): additive notification inbox contract (API 1.5.0). Schema/contract evidence only; runtime
// authorization, RLS, idempotency and concurrency are proven by the core-api PG16 scenario, not here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { validate } from '../src/validate.cjs';
import { canonicalJson } from './workflow-graph-oracle.mjs';
import { NOTIFICATION_EXEMPT_OPERATIONS } from './notification-exemption.mjs';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const spec = YAML.parse(read('../../../docs/ai-specs/02-openapi-contracts.yaml'));
const S = spec.components.schemas;
const baseline = JSON.parse(read('./pre-notif1-baseline.json'));
const fixtures = JSON.parse(read('./notification-fixtures.json'));
const valid = name => structuredClone(fixtures.find(f => f.schema === name && f.valid).value);

const EXPECTED_OPS = {
  'GET /v1/me/notifications': 'listMyNotifications',
  'GET /v1/me/notifications/unread-count': 'getMyNotificationUnreadCount',
  'POST /v1/me/notifications/{notificationId}/read': 'markMyNotificationRead',
  'POST /v1/me/notifications/read-all': 'markMyNotificationsRead',
};
const NOTIFICATION_SCHEMAS = ['NotificationScope', 'NotificationService', 'NotificationCategory', 'NotificationPriority', 'NotificationTarget',
  'Notification', 'NotificationList', 'NotificationUnreadCount', 'NotificationReadRequest', 'NotificationReadAllRequest', 'NotificationReadAllResult'];
const NOTIFICATION_PARAMS = ['NotificationScopeQuery', 'NotificationServiceQuery', 'NotificationMembershipContext'];
const operations = () => Object.entries(spec.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, op]) => ({ key: `${method.toUpperCase()} ${path}`, path, method, op })));
const byId = id => operations().find(o => o.op.operationId === id);
/** Every component schema name reachable from a node through $ref (transitively). */
function reachable(node, seen = new Set()) {
  if (!node || typeof node !== 'object') return seen;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/components/schemas/')) {
    const name = node.$ref.split('/').pop();
    if (!seen.has(name)) { seen.add(name); reachable(S[name], seen); }
  }
  for (const value of Object.values(node)) reachable(value, seen);
  return seen;
}

test('API 1.5.0 adds exactly the four /v1/me/notifications operations, all bearer-authenticated', () => {
  assert.equal(spec.info.version, '1.5.0');
  const found = Object.fromEntries(operations().filter(o => o.path.startsWith('/v1/me/notifications')).map(o => [o.key, o.op.operationId]));
  assert.deepEqual(found, EXPECTED_OPS);
  for (const { key, op } of operations().filter(o => o.path.startsWith('/v1/me/notifications'))) {
    assert.deepEqual(op.security ?? spec.security, [{ bearerAuth: [] }], key);
    for (const code of ['401', '403', '404', '409', '422', '429', '503']) assert.equal(op.responses[code].$ref, `#/components/responses/Error${code}`, key);
    assert.deepEqual(op.responses['200'].headers['Cache-Control'].schema.enum, ['no-store'], key);
  }
});

test('D3 guard: the exemption allowlist is exactly these four operations and cannot silently grow', () => {
  assert.deepEqual([...NOTIFICATION_EXEMPT_OPERATIONS].sort(), Object.values(EXPECTED_OPS).sort());
  assert.ok(Object.isFrozen(NOTIFICATION_EXEMPT_OPERATIONS));
  for (const id of NOTIFICATION_EXEMPT_OPERATIONS) assert.ok(byId(id)?.path.startsWith('/v1/me/notifications'), id);
  // Every operation added after 1.4.0 lacking the required membership context or (for POST) a key must be allowlisted.
  for (const { key, path, method, op } of operations()) {
    if (baseline.paths[path] || path.startsWith('/internal/')) continue;
    const context = op.parameters?.some(p => p.$ref === '#/components/parameters/MembershipContext');
    const keyed = op.parameters?.some(p => p.$ref === '#/components/parameters/IdempotencyKey');
    if (!context || (method === 'post' && !keyed)) assert.ok(NOTIFICATION_EXEMPT_OPERATIONS.includes(op.operationId), key);
  }
});

test('D3 guard: exempt operations carry no money, claim-state, EOB, OTP, consent or payment effect', () => {
  const forbidden = /^(Money|ClaimStatus|Eob|Otp|Consent|Payment|Calculation|Insurer|Ledger|Workflow|Claim)/;
  for (const id of NOTIFICATION_EXEMPT_OPERATIONS) {
    const { op } = byId(id);
    const names = [...reachable(op)];
    assert.deepEqual(names.filter(n => forbidden.test(n)), [], `${id} references a business-effect schema`);
    assert.ok(names.every(n => n.startsWith('Notification') || /^Error\d{3}$/.test(n)), `${id}: ${names}`);
    assert.equal(op.parameters.some(p => p.$ref?.endsWith('/IdempotencyKey')), false, `${id} must not pretend to be keyed`);
  }
  for (const id of ['markMyNotificationRead', 'markMyNotificationsRead']) {
    assert.match(byId(id).op.description, /idempotent/i, `${id} documents natural idempotency`);
    assert.match(byId(id).op.description, /(never signs OTP, approves an EOB, accepts consent or advances a claim|Never an EOB\/OTP\/consent\/claim action)/, id);
  }
  assert.match(byId('markMyNotificationRead').op.description, /Naturally idempotent, so no Idempotency-Key header/);
});

test('scope header rule: X-Membership-Context is required for TENANT and rejected for PERSONAL', () => {
  const header = spec.components.parameters.NotificationMembershipContext;
  assert.equal(header.in, 'header'); assert.equal(header.name, 'X-Membership-Context'); assert.equal(header.required, false);
  assert.match(header.description, /Required when scope=TENANT and forbidden \(422\) when scope=PERSONAL/);
  assert.deepEqual(header.schema, spec.components.parameters.MembershipContext.schema, 'same opaque token bounds');
  const scope = spec.components.parameters.NotificationScopeQuery;
  assert.equal(scope.required, true, 'scope is always explicit');
  assert.deepEqual(S.NotificationScope.enum, ['PERSONAL', 'TENANT'], 'no ALL/all-tenant aggregation scope');
  for (const id of NOTIFICATION_EXEMPT_OPERATIONS) {
    const params = byId(id).op.parameters;
    assert.ok(params.some(p => p.$ref === '#/components/parameters/NotificationMembershipContext'), id);
    assert.equal(params.some(p => p.$ref === '#/components/parameters/MembershipContext'), false, id);
  }
  for (const id of ['listMyNotifications', 'getMyNotificationUnreadCount']) {
    assert.ok(byId(id).op.parameters.some(p => p.$ref === '#/components/parameters/NotificationScopeQuery'), id);
  }
  for (const name of ['NotificationReadRequest', 'NotificationReadAllRequest']) assert.ok(S[name].required.includes('scope'), name);
  assert.match(byId('listMyNotifications').op.description, /never a mixed or all-tenant inbox/);
});

test('pre-NOTIF-01 snapshot: every 1.4.0 path, component and top-level block is byte-for-byte unchanged', () => {
  const h = v => createHash('sha256').update(canonicalJson(v)).digest('hex');
  assert.equal(baseline.apiVersion, '1.4.0');
  for (const [k, hash] of Object.entries(baseline.topLevel)) assert.equal(h(spec[k]), hash, k);
  for (const [p, hash] of Object.entries(baseline.paths)) assert.equal(h(spec.paths[p]), hash, p);
  for (const [g, entries] of Object.entries(baseline.components)) for (const [n, hash] of Object.entries(entries)) {
    assert.equal(h(spec.components[g][n]), hash, `${g}.${n}`);
  }
  assert.deepEqual(Object.keys(S).filter(n => !(n in baseline.components.schemas)).sort(), [...NOTIFICATION_SCHEMAS].sort());
  assert.deepEqual(Object.keys(spec.components.parameters).filter(n => !(n in baseline.components.parameters)).sort(), [...NOTIFICATION_PARAMS].sort());
  assert.deepEqual(Object.keys(spec.paths).filter(p => !(p in baseline.paths)).sort(), [...new Set(Object.keys(EXPECTED_OPS).map(k => k.split(' ')[1]))].sort());
  assert.deepEqual(Object.keys(spec.components.responses).sort(), Object.keys(baseline.components.responses).sort(), 'no new error responses');
  assert.deepEqual(S.Error422.properties.code.enum, ['VALIDATION_FAILED', 'DOMAIN_VIOLATION'], 'shared error codes reused');
});

test('privacy boundary: no notification schema carries tenant, recipient, membership, source event or money fields', () => {
  const walk = (node, path, seen = new Set()) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return [];
    seen.add(node);
    const hits = node.properties ? Object.keys(node.properties)
      .filter(k => /tenant|recipient|membership|principal|sourceEvent|amount|money|url|html|phone|cccd|bank|diagnos|icd/i.test(k)).map(k => `${path}.${k}`) : [];
    return hits.concat(...Object.entries(node).map(([k, v]) => walk(v, `${path}.${k}`, seen)));
  };
  for (const name of NOTIFICATION_SCHEMAS) assert.deepEqual(walk(S[name], name), [], name);
  assert.deepEqual(S.NotificationTarget.properties.kind.enum, ['CLAIM'], 'internal descriptor, never a URL');
  for (const [field, max] of [['titleVi', 120], ['bodyVi', 280]]) assert.equal(S.Notification.properties[field].maxLength, max, field);
  for (const name of NOTIFICATION_SCHEMAS.filter(n => S[n].type === 'object')) assert.equal(S[name].additionalProperties, false, name);
});

test('read state: readAt absent while unread, version 1|2, never null; read-all requires explicit cutoff', () => {
  const unread = valid('Notification');
  assert.equal(unread.readAt, undefined); assert.equal(validate('Notification', unread), true);
  assert.equal(validate('Notification', { ...unread, readAt: null }), false);
  assert.equal(validate('Notification', { ...unread, version: 0 }), false);
  assert.ok(S.NotificationReadAllRequest.required.includes('cutoff'));
  assert.equal(validate('NotificationReadAllRequest', { scope: 'TENANT' }), false);
  assert.equal(S.NotificationUnreadCount.properties.unreadCount.maximum, 999);
  assert.ok(S.NotificationUnreadCount.required.includes('capped'), 'no silent cap');
});
