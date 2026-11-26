import { byteLength, canonicalJson, isWorkflowContent, MAX_CONTENT_BYTES, type EditorDocument, type WorkflowLayout } from './workflow-definition.ts';

export const DRAFT_KEY = 'tpa.workflow.local.v1';
export const MAX_DRAFT_BYTES = 128 * 1024;
export interface LocalDraft extends EditorDocument { schema: 1; revision: number }
export interface DraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export class DraftConflict extends Error { constructor() { super('Bản nháp đã đổi ở tab khác. Giữ nguyên chỉnh sửa; xuất JSON trước khi tải lại.'); } }
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function validLayout(v: unknown): v is WorkflowLayout {
  if (!plain(v) || !['edges,nodes', 'edges,labels,nodes'].includes(Object.keys(v).sort().join()) || !plain(v.nodes) || !plain(v.edges)) return false;
  const number = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= -10000 && n <= 10000;
  if (v.labels !== undefined && (!plain(v.labels) || Object.keys(v.labels).length > 150 || !Object.entries(v.labels).every(([key, p]) => /^[ne]_[a-z][a-z0-9_]{1,39}$/.test(key) && plain(p)
    && Object.keys(p).sort().join() === 'height,width,x,y' && number(p.x) && number(p.y) && number(p.width) && number(p.height) && (p.width as number) > 0 && (p.height as number) > 0))) return false;
  return Object.entries(v.nodes).length <= 50 && Object.entries(v.edges).length <= 100
    && Object.entries(v.nodes).every(([key, p]) => /^[a-z][a-z0-9_]{1,39}$/.test(key) && plain(p)
      && Object.keys(p).sort().join() === 'height,width,x,y' && number(p.x) && number(p.y) && number(p.width) && number(p.height)
      && (p.width as number) >= 20 && (p.height as number) >= 20)
    && Object.entries(v.edges).every(([key, points]) => /^[a-z][a-z0-9_]{1,39}$/.test(key) && Array.isArray(points) && points.length >= 2 && points.length <= 100
      && points.every(p => plain(p) && Object.keys(p).sort().join() === 'x,y' && number(p.x) && number(p.y)));
}
/** Untrusted browser storage/imports must satisfy the contract before being displayed. */
export function parseDocument(raw: string): EditorDocument {
  if (byteLength(raw) > MAX_DRAFT_BYTES) throw new Error('LIMIT_EXCEEDED');
  const value: unknown = JSON.parse(raw);
  if (!plain(value) || !isWorkflowContent(value.content) || !validLayout(value.layout)) throw new Error('SCHEMA_INVALID');
  if (Object.keys(value).some(k => !['content', 'layout', 'schema', 'revision'].includes(k))) throw new Error('SCHEMA_INVALID');
  const c = value.content;
  if (!Array.isArray(c.nodes) || !Array.isArray(c.edges) || c.nodes.length > 50 || c.edges.length > 100) throw new Error('SCHEMA_INVALID');
  if (byteLength(canonicalJson(c)) > MAX_CONTENT_BYTES) throw new Error('LIMIT_EXCEEDED');
  const nodes = new Set(c.nodes.map(n => n.nodeId)), edges = new Set(c.edges.map(e => e.edgeId));
  if (nodes.size !== c.nodes.length || edges.size !== c.edges.length) throw new Error('DUPLICATE_ID');
  if (c.edges.some(e => !nodes.has(e.source) || !nodes.has(e.target))) throw new Error('DANGLING_EDGE');
  if (Object.keys(value.layout.nodes).some(id => !nodes.has(id)) || Object.keys(value.layout.edges).some(id => !edges.has(id))
    || Object.keys(value.layout.labels ?? {}).some(id => id.startsWith('n_') ? !nodes.has(id.slice(2)) : id.startsWith('e_') ? !edges.has(id.slice(2)) : true)) throw new Error('UNSAFE_REFERENCE');
  return { content: c as EditorDocument['content'], layout: value.layout };
}
export function draftKey(scope: string) { return `${DRAFT_KEY}:${scope}`; }
export function readDraft(storage: DraftStorage, scope: string): LocalDraft | null {
  const raw = storage.getItem(draftKey(scope));
  if (!raw) return null;
  const doc = parseDocument(raw), data = JSON.parse(raw) as LocalDraft;
  if (data.schema !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 1) throw new Error('SCHEMA_INVALID');
  return { ...doc, schema: 1, revision: data.revision };
}
export function saveDraft(storage: DraftStorage, scope: string, document: EditorDocument, expectedRevision: number): LocalDraft {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error('LIMIT_EXCEEDED');
  parseDocument(canonicalJson(document));
  const current = readDraft(storage, scope);
  if ((current?.revision ?? 0) !== expectedRevision) throw new DraftConflict();
  const next: LocalDraft = { ...document, schema: 1, revision: expectedRevision + 1 };
  const raw = canonicalJson(next);
  if (byteLength(raw) > MAX_DRAFT_BYTES) throw new Error('LIMIT_EXCEEDED');
  storage.setItem(draftKey(scope), raw);
  return next;
}
