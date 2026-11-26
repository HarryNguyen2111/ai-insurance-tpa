import { CORE_API_HEALTH_PATH, type CoreApiConfig } from './core-api-config.ts';

// Result exposed to the browser via the same-origin route. It reports PROCESS
// LIVENESS of core-api only; it never asserts database, workflow, event, search,
// identity or claims readiness. The internal backend address is not echoed.
export type BackendHealthState =
  | 'ONLINE' // GET /health -> 200 {"status":"ok"}
  | 'UNREACHABLE' // connection refused / reset / DNS / timeout
  | 'UNEXPECTED_RESPONSE' // reachable, but not the liveness contract
  | 'MISCONFIGURED'; // server-side backend address rejected by the allowlist

export interface BackendHealthReport {
  state: BackendHealthState;
  scope: 'PROCESS_LIVENESS_ONLY';
  checkedAt: string;
  latencyMs: number | null;
  httpStatus: number | null;
  detail: string;
}

export const HEALTH_TIMEOUT_MS = 2000;
const MAX_BODY_BYTES = 1024;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface CheckOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
}

async function readLimitedText(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function checkCoreApiHealth(config: CoreApiConfig, options: CheckOptions = {}): Promise<BackendHealthReport> {
  const now = options.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const base = { scope: 'PROCESS_LIVENESS_ONLY' as const, checkedAt };
  if (!config.ok) {
    return { ...base, state: 'MISCONFIGURED', latencyMs: null, httpStatus: null, detail: `CONFIG_${config.reason}` };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const started = performance.now();
  let response: Response;
  try {
    response = await fetchImpl(`${config.origin}${CORE_API_HEALTH_PATH}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(options.timeoutMs ?? HEALTH_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return { ...base, state: 'UNREACHABLE', latencyMs: null, httpStatus: null, detail: timedOut ? 'TIMEOUT' : 'CONNECTION_FAILED' };
  }
  const latencyMs = Math.round(performance.now() - started);
  const httpStatus = response.status;
  let text: string | null;
  try {
    text = await readLimitedText(response);
  } catch {
    return { ...base, state: 'UNREACHABLE', latencyMs, httpStatus, detail: 'BODY_READ_FAILED' };
  }
  if (httpStatus !== 200) {
    return { ...base, state: 'UNEXPECTED_RESPONSE', latencyMs, httpStatus, detail: 'NON_200_STATUS' };
  }
  if (text === null) {
    return { ...base, state: 'UNEXPECTED_RESPONSE', latencyMs, httpStatus, detail: 'BODY_TOO_LARGE' };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ...base, state: 'UNEXPECTED_RESPONSE', latencyMs, httpStatus, detail: 'INVALID_JSON' };
  }
  const isLiveness =
    typeof body === 'object' && body !== null && !Array.isArray(body) &&
    Object.keys(body).length === 1 && (body as Record<string, unknown>).status === 'ok';
  if (!isLiveness) {
    return { ...base, state: 'UNEXPECTED_RESPONSE', latencyMs, httpStatus, detail: 'UNEXPECTED_BODY' };
  }
  return { ...base, state: 'ONLINE', latencyMs, httpStatus, detail: 'LIVENESS_OK' };
}
