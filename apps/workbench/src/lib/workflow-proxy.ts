import type { CoreApiConfig } from './core-api-config.ts';

// Server-only same-origin bridge from the Workbench to the #80 workflow-definition API
// and the #21 membership-context API. Nothing from the browser selects the target:
// the origin is the fixed loopback config, the path must match a closed allowlist and
// only the three trust headers the contract defines are forwarded. Authorization is
// never decided here — core-api re-verifies identity, MFA, membership, role and
// maker-checker on every call. This module only narrows what can be sent.

export type ProxyMethod = 'GET' | 'POST' | 'PUT';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const VERSION = '[1-9][0-9]{0,9}';
const BASE = 'v1/admin/workflow-definitions';
interface Route { method: ProxyMethod; pattern: RegExp; query?: true; body: 'json' | 'none' }
/** Closed list (spec 14 §5 operations used by S-V1..S-V4, plus #21 me/membership). Revoke is not exposed by the designer. */
export const ROUTES: readonly Route[] = [
  { method: 'GET', pattern: /^v1\/me\/memberships$/, body: 'none' },
  { method: 'POST', pattern: /^v1\/me\/membership$/, body: 'json' },
  { method: 'GET', pattern: new RegExp(`^${BASE}$`), query: true, body: 'none' },
  { method: 'POST', pattern: new RegExp(`^${BASE}$`), body: 'json' },
  { method: 'GET', pattern: new RegExp(`^${BASE}/${UUID}/versions$`), query: true, body: 'none' },
  { method: 'GET', pattern: new RegExp(`^${BASE}/${UUID}/versions/${VERSION}$`), body: 'none' },
  { method: 'PUT', pattern: new RegExp(`^${BASE}/${UUID}/versions/${VERSION}$`), body: 'json' },
  { method: 'POST', pattern: new RegExp(`^${BASE}/${UUID}/versions/${VERSION}/validate$`), body: 'none' },
  { method: 'POST', pattern: new RegExp(`^${BASE}/${UUID}/versions/${VERSION}/publish$`), body: 'json' },
  { method: 'GET', pattern: new RegExp(`^v1/workflow/action-catalogs/${VERSION}$`), body: 'none' },
];
export const MAX_REQUEST_BYTES = 96 * 1024;
export const MAX_RESPONSE_BYTES = 512 * 1024;
export const UPSTREAM_TIMEOUT_MS = 10_000;
const BEARER = /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const CONTEXT = /^[\x21-\x7e]{1,8192}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,100}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,2048}$/;

export type ProxyRejection = 'ROUTE_NOT_ALLOWED' | 'CROSS_SITE' | 'TENANT_SELECTOR' | 'BAD_HEADER' | 'BAD_QUERY' | 'BAD_BODY' | 'BODY_TOO_LARGE';
export interface ProxyPlan { url: string; method: ProxyMethod; headers: Record<string, string>; body?: string }
export type PlanResult = { ok: true; plan: ProxyPlan } | { ok: false; status: number; reason: ProxyRejection };

export interface IncomingLike { method: string; segments: string[]; search: URLSearchParams; headers: Headers; body: string | null }

/** Pure request planning; unit-tested without a network. */
export function planProxyRequest(origin: string, incoming: IncomingLike): PlanResult {
  const reject = (status: number, reason: ProxyRejection): PlanResult => ({ ok: false, status, reason });
  const path = incoming.segments.join('/');
  if (incoming.segments.some(s => s === '' || s === '.' || s === '..' || s.includes('/') || s.includes('\\')) || path.length > 300) return reject(404, 'ROUTE_NOT_ALLOWED');
  const route = ROUTES.find(r => r.method === incoming.method && r.pattern.test(path));
  if (!route) return reject(404, 'ROUTE_NOT_ALLOWED');
  // Browsers mark cross-site requests; a token in a header is not CSRF-exposed, but refuse anyway.
  const site = incoming.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') return reject(403, 'CROSS_SITE');
  // Tenant is selected only by the verified membership context (#21); never forward a client selector.
  if (incoming.headers.has('x-tenant-id') || incoming.search.has('tenantId')) return reject(403, 'TENANT_SELECTOR');
  const headers: Record<string, string> = { accept: 'application/json' };
  const authorization = incoming.headers.get('authorization');
  if (authorization === null || authorization.length > 8200 || !BEARER.test(authorization)) return reject(401, 'BAD_HEADER');
  headers.authorization = authorization;
  const context = incoming.headers.get('x-membership-context');
  if (!path.startsWith('v1/me')) {
    if (context === null || !CONTEXT.test(context)) return reject(400, 'BAD_HEADER');
    headers['x-membership-context'] = context;
  } else if (context !== null) return reject(400, 'BAD_HEADER');
  const key = incoming.headers.get('idempotency-key');
  if (incoming.method !== 'GET') {
    if (key === null || !IDEMPOTENCY_KEY.test(key)) return reject(400, 'BAD_HEADER');
    headers['idempotency-key'] = key;
  } else if (key !== null) return reject(400, 'BAD_HEADER');
  const query = new URLSearchParams();
  for (const [name, value] of incoming.search) {
    if (!route.query || query.has(name)) return reject(400, 'BAD_QUERY');
    if (name === 'limit' && /^[1-9][0-9]?$/.test(value)) query.set(name, value);
    else if (name === 'cursor' && CURSOR.test(value)) query.set(name, value);
    else return reject(400, 'BAD_QUERY');
  }
  let body: string | undefined;
  if (route.body === 'json') {
    if (!(incoming.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json') || incoming.body === null) return reject(415, 'BAD_BODY');
    if (new TextEncoder().encode(incoming.body).length > MAX_REQUEST_BYTES) return reject(413, 'BODY_TOO_LARGE');
    try {
      const parsed: unknown = JSON.parse(incoming.body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reject(400, 'BAD_BODY');
    } catch { return reject(400, 'BAD_BODY'); }
    body = incoming.body;
    headers['content-type'] = 'application/json';
  } else if (incoming.body !== null && incoming.body !== '') return reject(400, 'BAD_BODY');
  const qs = query.toString();
  return { ok: true, plan: { url: `${origin}/${path}${qs ? `?${qs}` : ''}`, method: route.method, headers, ...(body !== undefined ? { body } : {}) } };
}

/** Read incrementally: Content-Length is optional and cannot enforce the actual byte limit. */
export async function boundedRequestBody(request: Request): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { reader.releaseLock(); }
}

const local = (status: number, code: string) => Response.json({ code, messageVi: 'Yêu cầu tới máy chủ quy trình không hợp lệ hoặc không thực hiện được.' },
  { status, headers: { 'Cache-Control': 'no-store' } });

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Executes a planned request against the fixed origin and returns a bounded, no-store JSON response. */
export async function forwardWorkflowRequest(config: CoreApiConfig, incoming: IncomingLike, fetchImpl: FetchLike = fetch, timeoutMs = UPSTREAM_TIMEOUT_MS): Promise<Response> {
  if (!config.ok) return local(503, 'BFF_MISCONFIGURED');
  const planned = planProxyRequest(config.origin, incoming);
  if (!planned.ok) return local(planned.status, `BFF_${planned.reason}`);
  const { plan } = planned;
  let upstream: Response;
  try {
    upstream = await fetchImpl(plan.url, { method: plan.method, headers: plan.headers, body: plan.body, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const timedOut = error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return local(timedOut ? 504 : 502, timedOut ? 'BFF_UPSTREAM_TIMEOUT' : 'BFF_UPSTREAM_UNREACHABLE');
  }
  if (upstream.status >= 300 && upstream.status < 400) return local(502, 'BFF_UPSTREAM_REDIRECT');
  const reader = upstream.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); return local(502, 'BFF_UPSTREAM_TOO_LARGE'); }
        chunks.push(value);
      }
    }
  } catch {
    return local(502, 'BFF_UPSTREAM_UNREACHABLE');
  } finally { reader?.releaseLock(); }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  if (text !== '') { try { JSON.parse(text); } catch { return local(502, 'BFF_UPSTREAM_NOT_JSON'); } }
  const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
  if (upstream.headers.get('idempotent-replayed') === 'true') headers['Idempotent-Replayed'] = 'true';
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter && /^[0-9]{1,4}$/.test(retryAfter)) headers['Retry-After'] = retryAfter;
  return new Response(text === '' ? null : text, { status: upstream.status, headers });
}
