import { validate, type components } from '@tpa/shared-contracts';
import { canonicalJson } from './workflow-definition.ts';

// Browser client for the #80 workflow-definition API and #21 membership context, through the
// same-origin bridge (/api/workflow). Types come from the existing @tpa/shared-contracts
// client; every response body is validated against its contract schema before use.
// UI hints (publishableByCurrentActor) never replace server authorization.

type S = components['schemas'];
export type WorkflowVersion = S['WorkflowDefinitionVersion'];
export type WorkflowPage = S['WorkflowDefinitionPage'];
export type WorkflowSummary = S['WorkflowDefinitionSummary'];
export type ValidationReport = S['WorkflowValidationReport'];
export type WorkflowContentDto = S['WorkflowDefinitionContent'];
export type MeView = S['Me'];
export type MembershipContextView = S['MembershipContext'];
export type ApiErrorCode = S['ApiError']['code'];

export const API_BASE = '/api/workflow/v1';
/** Bearer is held in memory only (never storage); membership context is the opaque #21 token. */
export interface WorkflowSession { authorization: string; membershipContext?: string }

export type FailureCode = ApiErrorCode | 'NETWORK' | 'RESPONSE_INVALID' | `BFF_${string}`;
export class WorkflowApiFailure extends Error {
  readonly status: number; readonly code: FailureCode;
  constructor(status: number, code: FailureCode, messageVi?: string) {
    super(messageVi ?? FALLBACK[code as keyof typeof FALLBACK] ?? 'Máy chủ quy trình không thực hiện được yêu cầu.');
    this.status = status; this.code = code;
  }
  /** 409 STALE_VERSION: someone else changed the draft (or a different revision was reviewed). */
  get stale() { return this.status === 409 && this.code === 'STALE_VERSION'; }
}
const FALLBACK = {
  NETWORK: 'Không kết nối được máy chủ quy trình. Chỉnh sửa vẫn được giữ; thử lại sẽ dùng cùng khóa idempotency.',
  RESPONSE_INVALID: 'Phản hồi máy chủ không đúng hợp đồng; dữ liệu không được hiển thị.',
  UNAUTHENTICATED: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.',
  FORBIDDEN: 'Bạn không có quyền thực hiện thao tác này.',
  NOT_FOUND: 'Không tìm thấy quy trình.',
} as const;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
type Schema = 'Me' | 'MembershipContext' | 'WorkflowDefinitionPage' | 'WorkflowDefinitionVersion' | 'WorkflowValidationReport';

async function call<T>(fetchImpl: FetchLike, session: WorkflowSession, method: 'GET' | 'POST' | 'PUT', path: string, schema: Schema,
  options: { body?: unknown; key?: string; context?: boolean } = {}): Promise<{ value: T; replayed: boolean }> {
  const headers: Record<string, string> = { authorization: session.authorization, accept: 'application/json' };
  if (options.context !== false) {
    if (!session.membershipContext) throw new WorkflowApiFailure(422, 'VALIDATION_FAILED', 'Chưa chọn tư cách thành viên.');
    headers['x-membership-context'] = session.membershipContext;
  }
  if (options.key) headers['idempotency-key'] = options.key;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetchImpl(`${API_BASE}/${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), cache: 'no-store', credentials: 'omit', redirect: 'error' });
  } catch { throw new WorkflowApiFailure(0, 'NETWORK'); }
  let body: unknown = null;
  try { const text = await response.text(); body = text ? JSON.parse(text) : null; } catch { throw new WorkflowApiFailure(response.status, 'RESPONSE_INVALID'); }
  if (!response.ok) {
    if (validate('ApiError', body)) { const e = body as S['ApiError']; throw new WorkflowApiFailure(response.status, e.code, e.messageVi); }
    const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
    throw new WorkflowApiFailure(response.status, typeof code === 'string' && /^BFF_[A-Z_]{1,40}$/.test(code) ? code as FailureCode : 'RESPONSE_INVALID');
  }
  if (!validate(schema, body)) throw new WorkflowApiFailure(response.status, 'RESPONSE_INVALID');
  return { value: body as T, replayed: response.headers.get('idempotent-replayed') === 'true' };
}

/**
 * One Idempotency-Key per user intent. A retry of the same intent with the same payload (e.g. after a
 * network failure) reuses the key, so the server replays instead of double-applying (AGENTS §2.6).
 */
export class IntentKeys {
  private readonly pending = new Map<string, { fingerprint: string; key: string }>();
  private readonly newKey: () => string;
  constructor(newKey: () => string = () => crypto.randomUUID()) { this.newKey = newKey; }
  key(intent: string, payload: unknown): string {
    const fingerprint = canonicalJson(payload ?? null), current = this.pending.get(intent);
    if (current && current.fingerprint === fingerprint) return current.key;
    const key = this.newKey();
    this.pending.set(intent, { fingerprint, key });
    return key;
  }
  /** Definitive outcome (success or non-retryable error): the next attempt is a new intent. */
  settle(intent: string) { this.pending.delete(intent); }
}
const retryable = (error: unknown) => error instanceof WorkflowApiFailure && (error.code === 'NETWORK' || error.code === 'RESPONSE_INVALID' || error.code === 'OPERATION_IN_PROGRESS' || error.status >= 500);

const enc = encodeURIComponent;
export function workflowApi(session: WorkflowSession, fetchImpl: FetchLike = (i, o) => fetch(i, o), keys = new IntentKeys()) {
  async function mutate<T>(intent: string, method: 'POST' | 'PUT', path: string, schema: Schema, body: unknown, context = true) {
    const key = keys.key(intent, { path, body });
    try { const result = await call<T>(fetchImpl, session, method, path, schema, { body, key, context }); keys.settle(intent); return result; }
    catch (error) { if (!retryable(error)) keys.settle(intent); throw error; }
  }
  const page = (cursor?: string) => cursor ? `?limit=50&cursor=${enc(cursor)}` : '?limit=50';
  const version = (id: string, no: number) => `admin/workflow-definitions/${enc(id)}/versions/${no}`;
  return {
    me: () => call<MeView>(fetchImpl, session, 'GET', 'me/memberships', 'Me', { context: false }).then(r => r.value),
    selectMembership: (membershipId: string) => mutate<MembershipContextView>('select-membership', 'POST', 'me/membership', 'MembershipContext', { membershipId }, false).then(r => r.value),
    listDefinitions: (cursor?: string) => call<WorkflowPage>(fetchImpl, session, 'GET', `admin/workflow-definitions${page(cursor)}`, 'WorkflowDefinitionPage').then(r => r.value),
    listVersions: (id: string, cursor?: string) => call<WorkflowPage>(fetchImpl, session, 'GET', `admin/workflow-definitions/${enc(id)}/versions${page(cursor)}`, 'WorkflowDefinitionPage').then(r => r.value),
    getVersion: (id: string, no: number) => call<WorkflowVersion>(fetchImpl, session, 'GET', version(id, no), 'WorkflowDefinitionVersion').then(r => r.value),
    createDraft: (content: WorkflowContentDto, basedOnVersionNo?: number) =>
      mutate<WorkflowVersion>('create-draft', 'POST', 'admin/workflow-definitions', 'WorkflowDefinitionVersion', { content, ...(basedOnVersionNo ? { basedOnVersionNo } : {}) }),
    updateDraft: (id: string, no: number, expectedRevision: number, content: WorkflowContentDto) =>
      mutate<WorkflowVersion>(`update:${id}:${no}`, 'PUT', version(id, no), 'WorkflowDefinitionVersion', { expectedRevision, content }),
    validateDraft: (id: string, no: number, revision: number) =>
      // The report is per revision; the payload fingerprint keeps one key per reviewed revision.
      mutateNoBody<ValidationReport>(`validate:${id}:${no}:${revision}`, version(id, no) + '/validate', 'WorkflowValidationReport'),
    publish: (id: string, no: number, expectedRevision: number, contentHash: string) =>
      mutate<WorkflowVersion>(`publish:${id}:${no}`, 'POST', `${version(id, no)}/publish`, 'WorkflowDefinitionVersion', { expectedRevision, contentHash }),
  };
  async function mutateNoBody<T>(intent: string, path: string, schema: Schema) {
    const key = keys.key(intent, { path });
    try { const result = await call<T>(fetchImpl, session, 'POST', path, schema, { key }); keys.settle(intent); return result.value; }
    catch (error) { if (!retryable(error)) keys.settle(intent); throw error; }
  }
}
export type WorkflowApi = ReturnType<typeof workflowApi>;
