import type pg from 'pg';
import type { IdentityTenantDatabase, IdentityTransaction } from './identity.types.ts';

interface IdempotencyScope { operation: string; actorType: 'USER'; actorId: string; key: string }
type Begin = { kind: 'acquired'; ownerToken: string; attempt: number } | { kind: 'replayed'; response: { status: number; body: unknown } }
  | { kind: 'conflict' } | { kind: 'expired' } | { kind: 'in_progress'; retryAfterSeconds: number };
export interface DatabaseRuntime {
  createTenantDatabase(config: pg.PoolConfig): IdentityTenantDatabase;
  beginIdempotent(tx: IdentityTransaction, scope: IdempotencyScope, hash: string): Promise<Begin>;
  runOwnedEffect(tx: IdentityTransaction, scope: IdempotencyScope, owner: string, attempt: number,
    effect: (tx: IdentityTransaction) => Promise<{ status: number; body: { contextId: string } }>): Promise<{ status: number; body: unknown }>;
  requestHash(value: unknown): string;
  appendAudit(tx: IdentityTransaction, input: { entityType: string; entityId: string; actorType: 'USER'; actorId: string; action: string; payload: { after_hash: string } }): Promise<unknown>;
}
let runtime: Promise<DatabaseRuntime> | undefined;
/** Public package exports only. Node24 executes the existing TS exports; no source copying or package rewrite. */
export function databaseRuntime(): Promise<DatabaseRuntime> {
  runtime ??= Promise.all(['@tpa/database/tenant', '@tpa/database/idempotency', '@tpa/database/audit'].map(path => import(path)))
    .then(([tenant, idempotency, audit]) => ({ ...tenant, ...idempotency, ...audit }) as DatabaseRuntime);
  return runtime;
}
