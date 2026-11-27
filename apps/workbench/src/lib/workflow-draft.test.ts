import assert from 'node:assert/strict';
import test from 'node:test';
import { newDocument, canonicalJson } from './workflow-definition.ts';
import { DraftConflict, MAX_DRAFT_BYTES, parseDocument, readDraft, saveDraft, draftKey } from './workflow-draft.ts';

const storage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};
test('save/reload preserves semantic content, layout and local revisions within a workspace', () => {
  const store = storage(), doc = newDocument();
  const first = saveDraft(store, 'sandbox', doc, 0);
  assert.equal(first.revision, 1); assert.deepEqual(readDraft(store, 'sandbox'), first);
  const changed = structuredClone(doc); changed.content.title = 'Bản mới';
  assert.equal(saveDraft(store, 'sandbox', changed, 1).revision, 2);
  assert.equal(readDraft(store, 'other'), null);
});
test('stale tab cannot overwrite a newer draft and retains its in-memory edits', () => {
  const store = storage(), a = newDocument(), b = newDocument(); b.content.title = 'Chỉnh sửa chưa lưu';
  saveDraft(store, 'sandbox', a, 0);
  assert.throws(() => saveDraft(store, 'sandbox', b, 0), DraftConflict);
  assert.equal(readDraft(store, 'sandbox')!.content.title, a.content.title);
  assert.equal(b.content.title, 'Chỉnh sửa chưa lưu');
});
test('corrupt/tampered browser storage is preserved, rejected and never silently replaced', () => {
  const store = storage(); store.setItem(draftKey('sandbox'), '{invalid');
  assert.throws(() => readDraft(store, 'sandbox'));
  assert.throws(() => saveDraft(store, 'sandbox', newDocument(), 0));
  assert.equal(store.getItem(draftKey('sandbox')), '{invalid');
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    store.setItem(draftKey('sandbox'), JSON.stringify({ ...newDocument(), schema: 1, revision }));
    assert.throws(() => readDraft(store, 'sandbox'));
  }
});
test('unknown fields, unsafe labels, invalid geometry and oversized inputs fail before display', () => {
  const doc = newDocument();
  const cases = [
    { ...doc, surprise: true },
    { ...doc, content: { ...doc.content, tenantId: 'forged' } },
    { ...doc, content: { ...doc.content, title: '<img src=x onerror=alert(1)>' } },
    { ...doc, layout: { ...doc.layout, nodes: { start: { x: 'bad', y: 1, width: 36, height: 36 } } } },
  ];
  for (const value of cases) assert.throws(() => parseDocument(canonicalJson(value)), /SCHEMA_INVALID/);
  assert.throws(() => parseDocument('x'.repeat(MAX_DRAFT_BYTES + 1)), /LIMIT_EXCEEDED/);
});
test('storage quota error never marks an unsaved edit as persisted', () => {
  const store = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
  const doc = newDocument(); assert.throws(() => saveDraft(store, 'sandbox', doc, 0), /QuotaExceededError/);
  assert.deepEqual(doc, newDocument());
});
test('orphan geometry and duplicate canonical IDs cannot be silently discarded during import', () => {
  const doc = newDocument();
  doc.layout.nodes.orphan = { x: 1, y: 1, width: 36, height: 36 };
  assert.throws(() => parseDocument(canonicalJson(doc)), /UNSAFE_REFERENCE/);
  delete doc.layout.nodes.orphan;
  doc.content.nodes.push({ ...doc.content.nodes[0] });
  assert.throws(() => parseDocument(canonicalJson(doc)), /DUPLICATE_ID/);
  assert.throws(() => saveDraft(storage(), 'sandbox', newDocument(), Number.MAX_SAFE_INTEGER), /LIMIT_EXCEEDED/);
});

test('server layout cache: reused only for the same definition + contentHash; tampered or stale entries fall back', async () => {
  const { saveServerLayout, readServerLayout, LAYOUT_KEY } = await import('./workflow-draft.ts');
  const store = storage(), doc = newDocument(), id = '0b9c7a52-6a7e-4c1e-9d7a-1f2e3d4c5b6a', hash = 'a'.repeat(64);
  doc.layout.nodes.start.x = 333;
  assert.equal(saveServerLayout(store, id, hash, doc), true);
  assert.deepEqual(readServerLayout(store, id, hash, doc.content), doc.layout);
  assert.deepEqual(readServerLayout(store, id, 'b'.repeat(64), doc.content), { nodes: {}, edges: {} }, 'other content version');
  const fewer = structuredClone(doc.content); fewer.nodes = fewer.nodes.filter(n => n.nodeId !== 'start');
  assert.deepEqual(readServerLayout(store, id, hash, fewer), { nodes: {}, edges: {} }, 'layout ids must exist in content');
  store.setItem(`${LAYOUT_KEY}:${id}`, '{"contentHash":"' + hash + '","layout":{"nodes":{"start":{"x":"<script>","y":0,"width":36,"height":36}},"edges":{}}}');
  assert.deepEqual(readServerLayout(store, id, hash, doc.content), { nodes: {}, edges: {} });
  assert.equal(saveServerLayout(store, '../x', hash, doc), false);
});
