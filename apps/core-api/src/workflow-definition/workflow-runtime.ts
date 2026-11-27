import type pg from 'pg';
import type { IdentityTransaction } from '../identity-tenant/identity.types.ts';

/** Structural mirrors of the ESM workspace exports used here (core-api compiles to CommonJS). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface ValidationIssue { detailCode: string; path: string; nodeId?: string; edgeId?: string }
export interface DefinitionLike {
  workflowKey: string; title: string; actionCatalogVersion: number; scope: { benefitTypes: string[] };
  nodes: { nodeId: string; type: string; [k: string]: unknown }[]; edges: unknown[];
}
export interface PinnedRef { kind: 'modelRef' | 'promptRef' | 'policyRef' | 'formRef'; key: string; version: number; hash: string }
export interface CatalogLike { schemaVersion: string; catalogVersion: number; actions: unknown[] }
interface IdempotencyScope { operation: string; actorType: 'USER' | 'SERVICE' | 'SYSTEM'; actorId: string; key: string }
type Begin = { kind: 'acquired'; ownerToken: string; attempt: number } | { kind: 'replayed'; response: { status: number; body: JsonValue } }
  | { kind: 'conflict' } | { kind: 'expired' } | { kind: 'in_progress'; retryAfterSeconds: number };
export interface TenantDatabaseLike {
  withTenantTransaction<T>(tenantId: string, fn: (tx: IdentityTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export interface WorkflowRuntime {
  validateContract(name: string, value: unknown): boolean;
  validateDefinitionContent(content: unknown, ctx: { catalog: CatalogLike; publishedRefs?: ReadonlySet<string>; otherPublishedScopes?: Readonly<Record<string, string>> }): ValidationIssue[];
  contentHash(content: unknown): string;
  pinnedRefs(content: DefinitionLike): PinnedRef[];
  refKey(ref: { key: string; version: number; hash: string }): string;
  actionCatalog(version: number): CatalogLike | undefined;
  appendAudit(tx: IdentityTransaction, input: { entityType: string; entityId: string; actorType: 'USER' | 'SERVICE' | 'SYSTEM'; actorId: string; action: string; payload: { after_hash: string } }): Promise<unknown>;
  appendOutboxEvent(tx: IdentityTransaction, draft: { eventType: string; aggregateId: string; aggregateVersion: number; correlationId: string; causationId: string; payload: Record<string, unknown> }): Promise<unknown>;
  beginIdempotent(tx: IdentityTransaction, scope: IdempotencyScope, hash: string): Promise<Begin>;
  runOwnedEffect(tx: IdentityTransaction, scope: IdempotencyScope, owner: string, attempt: number,
    effect: (tx: IdentityTransaction) => Promise<{ status: number; body: JsonValue }>): Promise<{ status: number; body: JsonValue }>;
  requestHash(value: unknown): string;
  createTenantDatabase(config: pg.PoolConfig): TenantDatabaseLike;
}
let runtime: Promise<WorkflowRuntime> | undefined;
/** Public package exports only, loaded once (Node 24 executes the TS exports, as database-runtime.ts does). */
export function workflowRuntime(): Promise<WorkflowRuntime> {
  runtime ??= Promise.all(['@tpa/workflow/definition-validator', '@tpa/workflow/definition', '@tpa/database/audit',
    '@tpa/database/outbox', '@tpa/database/idempotency', '@tpa/database/tenant'].map(path => import(path)))
    .then(modules => Object.assign({}, ...modules) as WorkflowRuntime);
  return runtime;
}
