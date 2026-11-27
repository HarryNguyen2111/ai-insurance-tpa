/**
 * Scope keys (issue #106 Deliverable C). Every cached/query/draft value is keyed by
 * principal + context (PERSONAL or membership) + service + entity/version, so nothing written under one
 * tenant can be read under another, and a draft stays bound to the scope where it was started — never
 * to whichever tenant the avatar currently shows. Keys hold opaque IDs only (no names, phone, CCCD).
 */
import type { ServiceKey } from '../adapters/ports.ts';
import type { ContextId } from './context-ring.ts';

export type Scope = { principalId: string; contextId: ContextId; service: ServiceKey | 'PERSONAL_LOYALTY' };

export function scopeKey(scope: Scope, entity: string, version: number | string): string {
  return ['v1', scope.principalId, scope.contextId, scope.service, entity, String(version)].join('|');
}

/** FNOL intake form version the prototype drafts against (synthetic; real value comes from #65 binding). */
export const FNOL_FORM_VERSION = 'synthetic-fnol-v1';

export function draftKey(principalId: string, contextId: ContextId): string {
  return scopeKey({ principalId, contextId, service: 'TPA_INSURANCE' }, 'fnol-draft', FNOL_FORM_VERSION);
}

export function keyBelongsTo(key: string, principalId: string, contextId: ContextId): boolean {
  const parts = key.split('|');
  return parts[1] === principalId && parts[2] === contextId;
}

/** Metadata-only FNOL draft (file name/size/check result; file bytes are never read or stored). */
export type DraftFile = { key: string; name: string; sizeKb: string; ok: boolean; isHeic: boolean; reasonVi: string };
export type FnolDraft = { docType: string; files: DraftFile[]; saved: boolean };

export function draftHasPendingWork(d: FnolDraft | undefined): boolean {
  return !!d && (d.files.length > 0 || d.saved);
}
