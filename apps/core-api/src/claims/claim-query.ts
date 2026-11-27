import { createHash } from 'node:crypto';
import { UUID } from '../identity-tenant/identity-context.ts';
import { invalid } from './claim-error.ts';
import { isClaimStatus, type ClaimStatus } from './claim-state.ts';

export interface ClaimListQuery { cursor?: string; limit: number; status?: ClaimStatus; memberId?: string }
export interface CursorPosition { createdAt: string; claimId: string }
const ALLOWED = new Set(['cursor', 'limit', 'status', 'memberId']);
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;

/** OpenAPI listClaims allowlist: unknown filters/sort/tenant/DSL and repeated parameters are 422. */
export function parseListQuery(raw: unknown): ClaimListQuery {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.some(([k, v]) => !ALLOWED.has(k) || typeof v !== 'string')) throw invalid();
  const q = raw as Record<string, string | undefined>;
  const query: ClaimListQuery = { limit: 20 };
  if (q.limit !== undefined) {
    if (!/^[1-9][0-9]{0,2}$/.test(q.limit) || Number(q.limit) > 100) throw invalid();
    query.limit = Number(q.limit);
  }
  if (q.status !== undefined) { if (!isClaimStatus(q.status)) throw invalid(); query.status = q.status; }
  if (q.memberId !== undefined) { if (!UUID.test(q.memberId)) throw invalid(); query.memberId = q.memberId; }
  if (q.cursor !== undefined) { if (q.cursor.length < 1 || q.cursor.length > 2048) throw invalid('INVALID_CURSOR'); query.cursor = q.cursor; }
  return query;
}

/** Binds a cursor to the membership and the exact filters (not the page size). */
function binding(membershipId: string, query: ClaimListQuery): string {
  return createHash('sha256').update(JSON.stringify(['claims-list-v1', membershipId, query.status ?? null, query.memberId ?? null])).digest('hex');
}
/**
 * Opaque keyset cursor. It carries no tenant or PII. It is not a capability: every page query still
 * authorizes each row, so a forged position can only skip within the caller's own authorized set.
 */
export function encodeCursor(membershipId: string, query: ClaimListQuery, position: CursorPosition): string {
  return Buffer.from(JSON.stringify([1, binding(membershipId, query), position.createdAt, position.claimId])).toString('base64url');
}
export function decodeCursor(membershipId: string, query: ClaimListQuery): CursorPosition | undefined {
  if (query.cursor === undefined) return undefined;
  let data: unknown;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error('format');
    data = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
  } catch { throw invalid('INVALID_CURSOR'); }
  if (!Array.isArray(data) || data.length !== 4 || data[0] !== 1 || data[1] !== binding(membershipId, query)
    || typeof data[2] !== 'string' || !TIMESTAMP.test(data[2]) || typeof data[3] !== 'string' || !UUID.test(data[3])) throw invalid('INVALID_CURSOR');
  return { createdAt: data[2], claimId: data[3] };
}
