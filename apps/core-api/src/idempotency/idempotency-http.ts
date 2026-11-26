import { randomUUID } from 'node:crypto';

/**
 * HTTP boundary for API-01 durable idempotency (#22). Storage, canonical hashing,
 * ownership and retention live in `@tpa/database/idempotency`; this module only
 * validates the `Idempotency-Key` header and maps stored outcomes onto the
 * OpenAPI 1.3.0 contract (Error409/Error422, Retry-After, Cache-Control: no-store).
 * No endpoint uses it yet; wiring happens with the first sensitive mutation.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface StoredResponse { status: number; body: JsonValue }
/** Structural mirror of `IdempotentOutcome` in `@tpa/database/idempotency`. */
export type IdempotencyOutcome =
  | { kind: 'executed'; response: StoredResponse; attempt: number }
  | { kind: 'replayed'; response: StoredResponse }
  | { kind: 'conflict' }
  | { kind: 'expired' }
  | { kind: 'in_progress'; retryAfterSeconds: number };
export interface IdempotencyHttpResult { status: number; headers: Record<string, string>; body: JsonValue }

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** OpenAPI `IdempotencyKeyValue`. */
const KEY_PATTERN = /^[A-Za-z0-9._:-]{16,100}$/;
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

const MESSAGES = {
  VALIDATION_FAILED: 'Idempotency-Key không hợp lệ hoặc bị thiếu.',
  IDEMPOTENCY_CONFLICT: 'Idempotency-Key đã được dùng cho một yêu cầu khác hoặc đã hết hạn; hãy dùng khóa mới.',
  OPERATION_IN_PROGRESS: 'Yêu cầu với Idempotency-Key này đang được xử lý; vui lòng thử lại sau.',
} as const;

function apiError(status: number, code: keyof typeof MESSAGES, correlationId: string,
  extraHeaders: Record<string, string> = {}): IdempotencyHttpResult {
  return { status, headers: { ...NO_STORE, ...extraHeaders }, body: { code, messageVi: MESSAGES[code], correlationId } };
}

/** Returns the key, or null when missing/duplicated/malformed. Never echo or log the raw value. */
export function readIdempotencyKey(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) return null;
  return value;
}

export function invalidIdempotencyKey(correlationId: string = randomUUID()): IdempotencyHttpResult {
  return apiError(422, 'VALIDATION_FAILED', correlationId);
}

/**
 * executed/replayed: the original status/body (replay marked by `Idempotent-Replayed`);
 * conflict/expired: 409 IDEMPOTENCY_CONFLICT without Retry-After (a new key is required);
 * in_progress: 409 OPERATION_IN_PROGRESS with integer Retry-After >= 1.
 * Authorization must already have been re-checked for the current principal.
 */
export function toIdempotencyHttpResult(outcome: IdempotencyOutcome, correlationId: string = randomUUID()): IdempotencyHttpResult {
  switch (outcome.kind) {
    case 'executed':
      return { status: outcome.response.status, headers: { ...NO_STORE }, body: outcome.response.body };
    case 'replayed':
      return { status: outcome.response.status, headers: { ...NO_STORE, 'Idempotent-Replayed': 'true' }, body: outcome.response.body };
    case 'conflict':
    case 'expired':
      return apiError(409, 'IDEMPOTENCY_CONFLICT', correlationId);
    case 'in_progress': {
      const seconds = Number.isSafeInteger(outcome.retryAfterSeconds) && outcome.retryAfterSeconds >= 1
        ? outcome.retryAfterSeconds : 1;
      return apiError(409, 'OPERATION_IN_PROGRESS', correlationId, { 'Retry-After': String(seconds) });
    }
    default: {
      const exhaustive: never = outcome;
      throw new Error(`Unhandled idempotency outcome ${String((exhaustive as { kind?: unknown }).kind)}`);
    }
  }
}
