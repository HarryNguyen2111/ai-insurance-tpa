import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, boundedRequestBody, forwardWorkflowRequest, planProxyRequest, type IncomingLike } from './workflow-proxy.ts';

const ORIGIN = 'http://127.0.0.1:3000';
const ID = '0b9c7a52-6a7e-4c1e-9d7a-1f2e3d4c5b6a';
const BEARER = 'Bearer aaa.bbb.ccc';
const KEY = 'vwf02-synthetic-key-0001';
function incoming(method: string, path: string, headers: Record<string, string> = {}, body: string | null = null, search = ''): IncomingLike {
  return { method, segments: path.split('/'), search: new URLSearchParams(search), headers: new Headers({ authorization: BEARER, 'x-membership-context': 'ctx.opaque', ...headers }), body };
}

test('allowlist: only the designer operations are routable; revoke, other APIs and traversal are 404', () => {
  const ok = [
    ['GET', 'v1/admin/workflow-definitions', {}],
    ['GET', `v1/admin/workflow-definitions/${ID}/versions`, {}],
    ['GET', `v1/admin/workflow-definitions/${ID}/versions/3`, {}],
    ['POST', `v1/admin/workflow-definitions/${ID}/versions/3/validate`, { 'idempotency-key': KEY }],
    ['GET', 'v1/workflow/action-catalogs/1', {}],
  ] as const;
  for (const [method, path, headers] of ok) assert.equal(planProxyRequest(ORIGIN, incoming(method, path, headers)).ok, true, path);
  const denied = [
    ['POST', `v1/admin/workflow-definitions/${ID}/versions/3/revoke`],
    ['GET', 'v1/claims'], ['GET', 'health'], ['DELETE', 'v1/admin/workflow-definitions'],
    ['GET', `v1/admin/workflow-definitions/${ID}/../../claims`], ['GET', 'v1/admin/workflow-definitions/not-a-uuid/versions'],
    ['GET', `v1/admin/workflow-definitions/${ID}/versions/0`], ['GET', `v1/admin/workflow-definitions/${ID.toUpperCase()}/versions`],
  ] as const;
  for (const [method, path] of denied) assert.deepEqual(planProxyRequest(ORIGIN, incoming(method, path, { 'idempotency-key': KEY })), { ok: false, status: 404, reason: 'ROUTE_NOT_ALLOWED' }, path);
  assert.equal(planProxyRequest(ORIGIN, { ...incoming('GET', 'x'), segments: ['v1', 'admin%2F..', 'x'] }).ok, false);
});

test('forwards only the three trust headers to the fixed origin; never a tenant selector or cookies', () => {
  const r = planProxyRequest(ORIGIN, incoming('PUT', `v1/admin/workflow-definitions/${ID}/versions/2`,
    { 'idempotency-key': KEY, 'content-type': 'application/json', cookie: 'session=1', host: 'evil.example', 'x-forwarded-host': 'evil.example' }, '{"expectedRevision":1}'));
  assert.ok(r.ok);
  assert.equal(r.plan.url, `${ORIGIN}/v1/admin/workflow-definitions/${ID}/versions/2`);
  assert.deepEqual(Object.keys(r.plan.headers).sort(), ['accept', 'authorization', 'content-type', 'idempotency-key', 'x-membership-context']);
  assert.deepEqual(planProxyRequest(ORIGIN, incoming('GET', 'v1/admin/workflow-definitions', { 'x-tenant-id': ID })), { ok: false, status: 403, reason: 'TENANT_SELECTOR' });
  assert.deepEqual(planProxyRequest(ORIGIN, incoming('GET', 'v1/admin/workflow-definitions', {}, null, `tenantId=${ID}`)), { ok: false, status: 403, reason: 'TENANT_SELECTOR' });
  assert.deepEqual(planProxyRequest(ORIGIN, incoming('GET', 'v1/admin/workflow-definitions', { 'sec-fetch-site': 'cross-site' })), { ok: false, status: 403, reason: 'CROSS_SITE' });
});

test('header, query and body shapes are bounded before any upstream call', () => {
  const list = 'v1/admin/workflow-definitions';
  assert.equal(planProxyRequest(ORIGIN, incoming('GET', list, { authorization: 'Basic x' })).ok, false);
  assert.equal(planProxyRequest(ORIGIN, { ...incoming('GET', list), headers: new Headers({ 'x-membership-context': 'c' }) }).ok, false);
  assert.equal(planProxyRequest(ORIGIN, { ...incoming('GET', list), headers: new Headers({ authorization: BEARER }) }).ok, false, 'membership context required');
  assert.equal(planProxyRequest(ORIGIN, incoming('GET', 'v1/me/memberships')).ok, false, 'me must not carry a context');
  assert.equal(planProxyRequest(ORIGIN, incoming('POST', list, { 'content-type': 'application/json' }, '{}')).ok, false, 'mutation needs key');
  assert.equal(planProxyRequest(ORIGIN, incoming('GET', list, { 'idempotency-key': KEY })).ok, false, 'GET must not carry key');
  assert.equal(planProxyRequest(ORIGIN, incoming('GET', list, {}, null, 'limit=5&cursor=abc_-1')).ok, true);
  for (const q of ['limit=0', 'limit=100', 'cursor=a/b', 'filter=x', 'limit=5&limit=6']) assert.equal(planProxyRequest(ORIGIN, incoming('GET', list, {}, null, q)).ok, false, q);
  assert.equal(planProxyRequest(ORIGIN, incoming('GET', `v1/admin/workflow-definitions/${ID}/versions/1`, {}, null, 'limit=5')).ok, false, 'no query on get');
  const post = (body: string | null, type = 'application/json') => planProxyRequest(ORIGIN, incoming('POST', list, { 'idempotency-key': KEY, 'content-type': type }, body));
  assert.equal(post('{"content":{}}').ok, true);
  assert.deepEqual(post('{"a":1}', 'text/plain'), { ok: false, status: 415, reason: 'BAD_BODY' });
  assert.deepEqual(post('[1]'), { ok: false, status: 400, reason: 'BAD_BODY' });
  assert.deepEqual(post('{broken'), { ok: false, status: 400, reason: 'BAD_BODY' });
  assert.deepEqual(post(`{"x":"${'a'.repeat(MAX_REQUEST_BYTES)}"}`), { ok: false, status: 413, reason: 'BODY_TOO_LARGE' });
  assert.equal(planProxyRequest(ORIGIN, incoming('POST', `v1/admin/workflow-definitions/${ID}/versions/1/validate`, { 'idempotency-key': KEY }, '{"x":1}')).ok, false, 'validate has no body');
});

test('forwarding: status/body pass through as no-store JSON; redirects, oversize, non-JSON and timeouts fail closed', async () => {
  const config = { ok: true as const, origin: ORIGIN };
  let seen: { url: string; init: RequestInit } | undefined;
  const reply = (body: string, status = 200, headers: Record<string, string> = {}) => async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(body, { status, headers }); };
  const conflict = await forwardWorkflowRequest(config, incoming('GET', 'v1/admin/workflow-definitions'), reply('{"code":"STALE_VERSION"}', 409, { 'idempotent-replayed': 'true', 'set-cookie': 'a=b' }));
  assert.equal(conflict.status, 409); assert.equal(conflict.headers.get('cache-control'), 'no-store');
  assert.equal(conflict.headers.get('idempotent-replayed'), 'true'); assert.equal(conflict.headers.get('set-cookie'), null);
  assert.deepEqual(await conflict.json(), { code: 'STALE_VERSION' });
  assert.equal(seen!.init.redirect, 'manual');
  const code = async (r: Response) => [r.status, (await r.json()).code];
  assert.deepEqual(await code(await forwardWorkflowRequest(config, incoming('GET', 'v1/admin/workflow-definitions'), reply('', 302, { location: 'http://evil.example' }))), [502, 'BFF_UPSTREAM_REDIRECT']);
  assert.deepEqual(await code(await forwardWorkflowRequest(config, incoming('GET', 'v1/admin/workflow-definitions'), reply('x'.repeat(MAX_RESPONSE_BYTES + 1)))), [502, 'BFF_UPSTREAM_TOO_LARGE']);
  assert.deepEqual(await code(await forwardWorkflowRequest(config, incoming('GET', 'v1/admin/workflow-definitions'), reply('<html>'))), [502, 'BFF_UPSTREAM_NOT_JSON']);
  assert.deepEqual(await code(await forwardWorkflowRequest(config, incoming('GET', 'v1/admin/workflow-definitions'), (_u, init) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))), 20)), [504, 'BFF_UPSTREAM_TIMEOUT']);
  assert.deepEqual(await code(await forwardWorkflowRequest(config, incoming('GET', 'v1/admin/workflow-definitions'), async () => { throw new TypeError('refused'); })), [502, 'BFF_UPSTREAM_UNREACHABLE']);
  assert.deepEqual(await code(await forwardWorkflowRequest({ ok: false, reason: 'NOT_LOOPBACK' }, incoming('GET', 'v1/admin/workflow-definitions'), reply('{}'))), [503, 'BFF_MISCONFIGURED']);
  let called = false;
  const denied = await forwardWorkflowRequest(config, incoming('POST', `v1/admin/workflow-definitions/${ID}/versions/1/revoke`, { 'idempotency-key': KEY }), async () => { called = true; return new Response('{}'); });
  assert.equal(denied.status, 404); assert.equal(called, false);
});


test('chunked request bodies stop at the real byte limit without trusting Content-Length', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(MAX_REQUEST_BYTES)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  });
  const request = new Request('http://localhost', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
  assert.equal(await boundedRequestBody(request), null);
  assert.equal(cancelled, true);
  assert.equal(await boundedRequestBody(new Request('http://localhost', { method: 'POST', body: '{"ok":true}' })), '{"ok":true}');
});

test('an upstream body failure returns a bounded error without leaking the exception', async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('secret transport detail')); } });
  const response = await forwardWorkflowRequest({ ok: true, origin: ORIGIN }, incoming('GET', 'v1/admin/workflow-definitions'), async () => new Response(stream));
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'BFF_UPSTREAM_UNREACHABLE');
});
