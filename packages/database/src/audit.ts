import { createHash } from 'node:crypto';
import type { TenantTransaction } from './tenant.ts';

export const AUDIT_VERSION = '1';
export const GENESIS_HASH = '0'.repeat(64);
export interface AuditInput {
  entityType: string;
  entityId: string;
  actorType: 'SYSTEM' | 'USER' | 'SERVICE';
  /** Opaque internal UUID, never a name, phone or external identity. */
  actorId: string;
  action: string;
  payload: { before_hash?: string; after_hash?: string };
}
export interface AuditRecord {
  tenant_id: string; entity_type: string; entity_id: string; actor_type: string;
  actor_id: string; action: string; payload_diff: Record<string, string>;
  sequence: string; version: string; occurred_at: string; prev_hash: string; curr_hash: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const code = /^[A-Z][A-Z_]{0,49}$/;
function invalid(): never { throw new Error('Invalid minimal audit metadata'); }
export function validateAuditInput(input: AuditInput): void {
  if (!input || !code.test(input.entityType) || !code.test(input.action) ||
      !uuid.test(input.entityId) || !uuid.test(input.actorId) ||
      !['SYSTEM', 'USER', 'SERVICE'].includes(input.actorType)) invalid();
  if (!input.payload || Object.getPrototypeOf(input.payload) !== Object.prototype ||
      Reflect.ownKeys(input.payload).some(key => typeof key !== 'string' ||
        !['before_hash', 'after_hash'].includes(key) ||
        typeof input.payload[key as keyof typeof input.payload] !== 'string' ||
        !hash.test(input.payload[key as keyof typeof input.payload]!))) invalid();
}
/** v1: sorted ASCII keys, UTF-8 JSON, no whitespace; strings/objects only. */
export function canonicalAudit(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  return '{' + Object.keys(value).sort().map(key => {
    if (!/^[a-z_]+$/.test(key)) invalid();
    return JSON.stringify(key) + ':' + canonicalAudit((value as Record<string, unknown>)[key]);
  }).join(',') + '}';
}
export function auditHash(record: Omit<AuditRecord, 'curr_hash'>): string {
  return createHash('sha256').update(canonicalAudit(record), 'utf8').digest('hex');
}
/** Must share the caller's withTenantTransaction with its mutation. */
export async function appendAudit(tx: TenantTransaction, input: AuditInput): Promise<AuditRecord> {
  validateAuditInput(input);
  const { rows: [record] } = await tx.query<AuditRecord>(
    'SELECT * FROM tpa.append_audit($1,$2,$3,$4,$5,$6)',
    [input.entityType, input.entityId, input.actorType, input.actorId, input.action, JSON.stringify(input.payload)]);
  return record;
}
/** Verify a complete chain against a separately retained expected head. */
export function verifyAuditChain(records: AuditRecord[], expected: { sequence: string; curr_hash: string }): boolean {
  let previous = GENESIS_HASH, sequence = 0n;
  const first = records[0];
  try {
    for (const record of records) {
      const { curr_hash, ...body } = record;
      validateAuditInput({ entityType: record.entity_type, entityId: record.entity_id,
        actorType: record.actor_type as AuditInput['actorType'], actorId: record.actor_id,
        action: record.action, payload: record.payload_diff });
      if (record.version !== AUDIT_VERSION || !uuid.test(record.tenant_id) ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(record.occurred_at) ||
          new Date(record.occurred_at).toISOString() !== record.occurred_at ||
          record.tenant_id !== first.tenant_id || record.entity_type !== first.entity_type ||
          record.entity_id !== first.entity_id || record.sequence !== String(++sequence) ||
          record.prev_hash !== previous || auditHash(body) !== curr_hash) return false;
      previous = curr_hash;
    }
    return expected.sequence === String(sequence) && expected.curr_hash === previous;
  } catch { return false; }
}
