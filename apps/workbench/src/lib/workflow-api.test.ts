import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { IntentKeys, WorkflowApiFailure, workflowApi, type FetchLike, type WorkflowVersion } from './workflow-api.ts';

const content = JSON.parse(readFileSync(new URL('../../../../docs/ai-specs/examples/visual-workflow-intake-review.example.json', import.meta.url), 'utf8'));
const ID = '0b9c7a52-6a7e-4c1e-9d7a-1f2e3d4c5b6a';
const version = (over: Partial<WorkflowVersion> = {}): WorkflowVersion => ({ definitionId: ID, workflowKey: content.workflowKey, versionNo: 1, status: 'DRAFT', revision: 1,
  contentHash: 'a'.repeat(64), content, publishableByCurrentActor: false, inFlightExecutionCount: 0, createdAt: '2026-11-27T00:00:00.000Z', updatedAt: '2026-11-27T00:00:00.000Z', ...over });
const session = { authorization: 'Bearer a.b.c', membershipContext: 'ctx' };
function recorder(responses: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => { calls.push({ url, init }); const next = responses.shift(); if (!next) throw new Error('unexpected'); return next(); };
  return { calls, fetchImpl };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers });

test('sends bearer + membership context + idempotency key to the same-origin bridge only', async () => {
  const { calls, fetchImpl } = recorder([json(version(), 201)]);
  const created = await workflowApi(session, fetchImpl).createDraft(content);
  assert.equal(created.value.versionNo, 1); assert.equal(created.replayed, false);
  assert.equal(calls[0].url, '/api/workflow/v1/admin/workflow-definitions');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer a.b.c'); assert.equal(headers['x-membership-context'], 'ctx');
  assert.match(headers['idempotency-key'], /^[0-9a-f-]{36}$/); assert.equal(calls[0].init.credentials, 'omit');
  assert.deepEqual(JSON.parse(calls[0].init.body as string), { content });
  assert.equal('tenantId' in JSON.parse(calls[0].init.body as string), false);
});

test('maps C1 errors (409 stale, 403, 422 domain) and refuses responses that break the contract', async () => {
  const error = (status: number, code: string) => json({ code, messageVi: 'Thông báo máy chủ', correlationId: '6f1d2c3b-0d7a-4c1b-9b7e-3c2a1d4e5f61' }, status);
  const { fetchImpl } = recorder([error(409, 'STALE_VERSION'), error(403, 'FORBIDDEN'), error(422, 'DOMAIN_VIOLATION'),
    json({ ...version(), tenantId: ID }), json({ code: 'BFF_ROUTE_NOT_ALLOWED', messageVi: 'x' }, 404), () => new Response('<html>', { status: 500 })]);
  const api = workflowApi(session, fetchImpl);
  const stale = await api.updateDraft(ID, 1, 1, content).catch(e => e);
  assert.ok(stale instanceof WorkflowApiFailure && stale.stale && stale.message === 'Thông báo máy chủ');
  assert.equal((await api.publish(ID, 1, 1, 'a'.repeat(64)).catch(e => e)).code, 'FORBIDDEN');
  assert.equal((await api.publish(ID, 1, 1, 'a'.repeat(64)).catch(e => e)).code, 'DOMAIN_VIOLATION');
  assert.equal((await api.getVersion(ID, 1).catch(e => e)).code, 'RESPONSE_INVALID', 'tenantId in response is a contract violation');
  assert.equal((await api.getVersion(ID, 1).catch(e => e)).code, 'BFF_ROUTE_NOT_ALLOWED');
  assert.equal((await api.getVersion(ID, 1).catch(e => e)).code, 'RESPONSE_INVALID');
  await assert.rejects(workflowApi({ authorization: 'Bearer a.b.c' }, fetchImpl).listDefinitions(), (e: WorkflowApiFailure) => e.code === 'VALIDATION_FAILED');
});

test('network failure keeps the same Idempotency-Key for the same intent+payload; definitive outcomes rotate it', async () => {
  const { calls, fetchImpl } = recorder([() => { throw new TypeError('offline'); }, json(version({ revision: 2 }), 200, { 'idempotent-replayed': 'true' }),
    json(version({ revision: 3 }))]);
  const api = workflowApi(session, fetchImpl);
  assert.equal((await api.updateDraft(ID, 1, 1, content).catch(e => e)).code, 'NETWORK');
  const retried = await api.updateDraft(ID, 1, 1, content);
  assert.equal(retried.replayed, true);
  const key = (i: number) => (calls[i].init.headers as Record<string, string>)['idempotency-key'];
  assert.equal(key(0), key(1));
  await api.updateDraft(ID, 1, 2, content);
  assert.notEqual(key(2), key(1));
  const keys = new IntentKeys(() => String(Math.random()));
  assert.equal(keys.key('a', { x: 1 }), keys.key('a', { x: 1 }));
  assert.notEqual(keys.key('a', { x: 1 }), keys.key('a', { x: 2 }), 'changed payload is a new intent');
});

test('validate sends no body; publish sends exactly the reviewed revision and hash', async () => {
  const report = { valid: false, revision: 2, contentHash: 'b'.repeat(64), issues: [{ detailCode: 'DEAD_END', path: '/nodes/1', nodeId: 'confirm_extraction' }] };
  const { calls, fetchImpl } = recorder([json(report), json(version({ status: 'PUBLISHED', revision: 2, publishedAt: '2026-11-27T01:00:00.000Z' }))]);
  const api = workflowApi(session, fetchImpl);
  assert.deepEqual(await api.validateDraft(ID, 1, 2), report);
  assert.equal(calls[0].init.body, undefined); assert.equal(calls[0].url, `/api/workflow/v1/admin/workflow-definitions/${ID}/versions/1/validate`);
  assert.equal((await api.publish(ID, 1, 2, 'b'.repeat(64))).value.status, 'PUBLISHED');
  assert.deepEqual(JSON.parse(calls[1].init.body as string), { expectedRevision: 2, contentHash: 'b'.repeat(64) });
});


test('ambiguous server errors and invalid successful responses retain the intent key until a validated outcome', async () => {
  const { calls, fetchImpl } = recorder([json({ code: 'PROVIDER_NOT_CONFIGURED', messageVi: 'Unavailable' }, 503), json({ invalid: true }), json(version())]);
  const api = workflowApi(session, fetchImpl);
  await assert.rejects(api.createDraft(content), WorkflowApiFailure);
  await assert.rejects(api.createDraft(content), (e: WorkflowApiFailure) => e.code === 'RESPONSE_INVALID');
  await api.createDraft(content);
  const keys = calls.map(c => (c.init.headers as Record<string, string>)['idempotency-key']);
  assert.equal(new Set(keys).size, 1, 'retry after a possibly committed write must replay the same intent');
});
