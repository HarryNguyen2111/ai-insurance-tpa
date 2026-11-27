import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  assertNoRawPii, buildEventEnvelope, domainTopic, eventTypes, EventContractError, partitionKey, topicName,
  validateEventEnvelope, type DomainEventDraft,
} from '../src/index.ts';

const { validate: openapiValidate } = createRequire(import.meta.url)('@tpa/shared-contracts') as { validate: (n: string, v: unknown) => boolean };
const tenant = randomUUID();
const draft = (overrides: Partial<DomainEventDraft> = {}): DomainEventDraft => ({
  eventType: 'claim.state-changed', aggregateId: randomUUID(), aggregateVersion: 2,
  correlationId: randomUUID(), causationId: randomUUID(),
  payload: { fromStatus: 'SUBMITTED', toStatus: 'AI_PROCESSING' }, ...overrides,
});
const MARKER = 'PII-MARKER-0912345678-079123456789';

test('spec 06 minimal events are registered on domain topics', () => {
  assert.deepEqual(eventTypes(), ['benefit.limit-changed', 'catalog.proposal-reviewed', 'claim.state-changed', 'claim.submitted',
    'eob.published', 'invoice.allocation-changed', 'payment.status-changed', 'workspace.changed']);
  assert.equal(domainTopic('claim.submitted'), 'claim');
  assert.equal(domainTopic('eob.published'), 'eob');
  assert.equal(topicName('tpa.dev', 'claim'), 'tpa.dev.claim');
  assert.throws(() => topicName('TPA', 'claim'), EventContractError);
  assert.throws(() => topicName('tpa.dev', 'claim.x'), EventContractError);
});

test('envelope: versioned, validated, frozen, tenantId:aggregateId partition key', () => {
  const upperAggregate = randomUUID().toUpperCase();
  const built = buildEventEnvelope(tenant.toUpperCase(), draft({ aggregateId: upperAggregate, occurredAt: new Date('2026-11-26T01:02:03.004Z') }));
  assert.equal(built.envelope.schemaVersion, '1.0.0');
  assert.equal(built.envelope.tenantId, tenant, 'UUIDs normalised to lowercase for DB consistency checks');
  assert.equal(built.envelope.aggregateId, upperAggregate.toLowerCase());
  assert.equal(built.envelope.occurredAt, '2026-11-26T01:02:03.004Z');
  assert.equal(built.partitionKey, `${tenant}:${upperAggregate.toLowerCase()}`);
  assert.equal(built.topic, 'claim');
  assert.ok(Object.isFrozen(built.envelope) && Object.isFrozen(built.envelope.payload));
  assert.notEqual(buildEventEnvelope(tenant, draft()).envelope.eventId, built.envelope.eventId);
  assert.equal(partitionKey(tenant, tenant), `${tenant}:${tenant}`);
  assert.throws(() => partitionKey('tenant', tenant), EventContractError);
});

test('envelope rejects unknown types/versions, wrong shapes and non-integer versions', () => {
  const rejects = (d: DomainEventDraft, message: RegExp) => assert.throws(() => buildEventEnvelope(tenant, d), (e: unknown) =>
    e instanceof EventContractError && message.test(e.message));
  rejects(draft({ eventType: 'claim.deleted' }), /Unknown event type/);
  rejects(draft({ schemaVersion: '2.0.0' }), /Unregistered schema version/);
  rejects(draft({ payload: { fromStatus: 'SUBMITTED' } }), /violates/);
  rejects(draft({ payload: { fromStatus: 'SUBMITTED', toStatus: 'NOT_A_STATUS' } }), /violates/);
  rejects(draft({ aggregateVersion: 0 }), /violates/);
  rejects(draft({ aggregateVersion: 1.5 }), /violates/);
  rejects(draft({ correlationId: 'not-a-uuid' }), /violates/);
  assert.throws(() => buildEventEnvelope('not-a-tenant', draft()), EventContractError);
});

test('PT17 guard: raw PII cannot enter an event and errors never echo it', () => {
  const attempts: DomainEventDraft[] = [
    draft({ payload: { fromStatus: 'SUBMITTED', toStatus: 'PAID', note: MARKER } }),
    draft({ payload: { fromStatus: 'SUBMITTED', toStatus: 'PAID', phone: MARKER } }),
    draft({ eventType: 'claim.submitted', payload: { cccd: MARKER } }),
    draft({ eventType: 'workspace.changed', payload: { changeKind: MARKER } }),
  ];
  for (const attempt of attempts) {
    assert.throws(() => buildEventEnvelope(tenant, attempt), (e: unknown) => {
      assert.ok(e instanceof EventContractError);
      assert.ok(!JSON.stringify({ m: e.message, p: e.paths, s: e.stack }).includes(MARKER), 'error must not echo the value');
      assert.ok(!JSON.stringify(e.paths).match(/note|phone|cccd/), 'extra property names are not surfaced');
      return true;
    });
  }
  // Direct guard: structured strings pass, free text / digits / e-mail / PII keys / floats fail.
  assertNoRawPii({ a: randomUUID(), b: 'a'.repeat(64), c: '2026-11-26T00:00:00.000Z', d: '1.0.0', e: '720000.00', f: 'GREEN_STP', g: 7, h: null, i: true });
  for (const bad of [{ x: 'Nguyen Van A' }, { x: '0912345678' }, { x: '079123456789' }, { x: 'a@b.vn' }, { fullName: 'APPROVE' },
    { bankAccount: 'APPROVE' }, { x: 720000.5 }, { x: [{ y: 'free text' }] }, { x: undefined }]) {
    assert.throws(() => assertNoRawPii(bad), EventContractError, JSON.stringify(Object.keys(bad)));
  }
});

test('OpenAPI parity: registry and @tpa/shared-contracts validators agree on fixtures', () => {
  const ids = () => ({ aggregateId: randomUUID(), correlationId: randomUUID(), causationId: randomUUID(), aggregateVersion: 3 });
  const valid: [string, DomainEventDraft][] = [
    ['EobPublishedEvent', { eventType: 'eob.published', ...ids(), payload: { eob: { eobVersion: 1, eobHash: 'a'.repeat(64) }, calculationRunId: randomUUID() } }],
    ['PaymentStatusChangedEvent', { eventType: 'payment.status-changed', ...ids(), payload: { status: 'UNKNOWN' } }],
    ['CatalogProposalReviewedEvent', { eventType: 'catalog.proposal-reviewed', ...ids(), payload: { decision: 'APPROVE', catalogVersion: { id: randomUUID(), version: 2, hash: 'b'.repeat(64) } } }],
    ['WorkspaceChangedEvent', { eventType: 'workspace.changed', ...ids(), payload: { changeKind: 'THEME' } }],
  ];
  for (const [component, d] of valid) {
    const { envelope } = buildEventEnvelope(tenant, d);
    assert.equal(openapiValidate(component, envelope), true, component);
    const broken = { ...structuredClone(envelope), payload: { ...envelope.payload, extra: 'X' } };
    assert.equal(openapiValidate(component, broken), false);
    assert.throws(() => validateEventEnvelope(broken), EventContractError);
  }
});
