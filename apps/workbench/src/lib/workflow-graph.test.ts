import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canonicalJson, newDocument, validateLocal, type EditorDocument, type WorkflowContent } from './workflow-definition.ts';
import { addNode, connect, connectionProblem, moveNodes, normalizeLayout, removeElements, structuralPaths, toFlow } from './workflow-graph.ts';
import { toBpmnXml } from './workflow-bpmn.ts';
import { EMPTY_LAYOUT, LAYOUT_KEY, parseDocument, readServerLayout, saveServerLayout } from './workflow-draft.ts';

const example = (): WorkflowContent => JSON.parse(readFileSync(new URL('../../../../docs/ai-specs/examples/visual-workflow-intake-review.example.json', import.meta.url), 'utf8'));
const doc = (): EditorDocument => normalizeLayout({ content: example(), layout: { nodes: {}, edges: {} } });

test('normalizeLayout fills geometry deterministically, never changes content, and is idempotent + contract-valid', () => {
  const before = example(), d = normalizeLayout({ content: before, layout: { nodes: {}, edges: {} } });
  assert.equal(canonicalJson(d.content), canonicalJson(example()));
  assert.deepEqual(Object.keys(d.layout.nodes).sort(), before.nodes.map(n => n.nodeId).sort());
  assert.deepEqual(Object.keys(d.layout.edges).sort(), before.edges.map(e => e.edgeId).sort());
  assert.deepEqual(normalizeLayout(d), d);
  assert.deepEqual(parseDocument(canonicalJson(d)), d); // layout satisfies the stored-draft validator
  // layered: START column left of its successor; loopBack edge does not pull ai_extract to the right
  assert.ok(d.layout.nodes.start.x < d.layout.nodes.ai_extract.x && d.layout.nodes.ai_extract.x < d.layout.nodes.confirm_extraction.x);
});

test('graph → canonical → graph round-trip keeps node/edge IDs, guards, roles, evidence and action refs', () => {
  const d = doc(), flow = toFlow(d, 'n_confirm_extraction', false);
  assert.deepEqual(flow.nodes.map(n => n.id), d.content.nodes.map(n => n.nodeId));
  assert.deepEqual(flow.edges.map(e => [e.id, e.source, e.target, e.data.kind]), d.content.edges.map(e => [e.edgeId, e.source, e.target, e.guard.kind]));
  for (const n of flow.nodes) assert.deepEqual(n.data.node, d.content.nodes.find(x => x.nodeId === n.id));
  assert.equal(flow.nodes.find(n => n.id === 'confirm_extraction')!.selected, true);
  // A canvas drag changes geometry only: content (hence contentHash) is identical.
  const moved = moveNodes(d, Object.fromEntries(flow.nodes.map(n => [n.id, { x: n.position.x + 13, y: n.position.y - 7 }])));
  assert.equal(canonicalJson(moved.content), canonicalJson(d.content));
  assert.equal(moved.layout.nodes.start.x, d.layout.nodes.start.x + 13);
  assert.deepEqual(parseDocument(canonicalJson(moved)), moved);
  assert.deepEqual(toFlow(moved, '', false).edges.map(e => e.label), flow.edges.map(e => e.label));
});

test('branch labels name every non-NEXT route, including condition, fallback and loop bound', () => {
  const labels = Object.fromEntries(toFlow(doc(), '', false).edges.map(e => [e.id, e.label ?? '']));
  assert.equal(labels.e_start, '');
  assert.equal(labels.e_confirm, 'Xác nhận dữ liệu');
  assert.equal(labels.e_ai_fail, 'AI lỗi / không chắc');
  assert.equal(labels.e_rounds_exhausted, 'Mặc định');
  assert.equal(labels.e_retry_ai, 'Nếu Lượt bổ sung hiện tại ≤ 3 · lặp tối đa 3');
});

test('connection rules reject END sources, START targets, self loops and >100 edges; new routes get a typed guard', () => {
  const d = doc();
  assert.equal(connectionProblem(d, 'end_manual', 'confirm_extraction'), 'END_HAS_OUTGOING');
  assert.equal(connectionProblem(d, 'confirm_extraction', 'start'), 'START_HAS_INCOMING');
  assert.equal(connectionProblem(d, 'ai_extract', 'ai_extract'), 'SELF_LOOP');
  assert.equal(connectionProblem(d, 'ai_extract', 'nope'), 'DANGLING_EDGE');
  assert.throws(() => connect(d, 'end_manual', 'start'), /END_HAS_OUTGOING/);
  const full = structuredClone(d); while (full.content.edges.length < 100) full.content.edges.push({ ...full.content.edges[0], edgeId: `x_${full.content.edges.length}` });
  assert.equal(connectionProblem(full, 'start', 'end_manual'), 'LIMIT_EXCEEDED');
  const { doc: c, id } = connect(d, 'supplement_round', 'end_completed');
  assert.equal(id, 'route_1');
  assert.deepEqual(c.content.edges.at(-1), { edgeId: 'route_1', source: 'supplement_round', target: 'end_completed', guard: { kind: 'CONDITION', priority: 1, condition: { variable: 'SUPPLEMENT_ROUND', op: 'LTE', value: 1 } } });
  assert.equal(c.layout.edges.route_1.length, 2);
});

test('adding steps never invents SLA/AI policy; deleting a step removes its routes and geometry only', () => {
  const { doc: d, id } = addNode(normalizeLayout(newDocument()), 'HUMAN_TASK');
  assert.equal(id, 'human_task_1');
  const node = d.content.nodes.find(n => n.nodeId === id)!;
  assert.ok(node.type === 'HUMAN_TASK' && node.sla.dueSeconds === 0 && node.allowedActionIds.length === 0);
  assert.ok(validateLocal(d.content).some(i => i.detailCode === 'SCHEMA_INVALID'));
  const linked = connect(connect(d, 'start', id).doc, id, 'end').doc;
  const removed = removeElements(linked, [id], []);
  assert.deepEqual(removed.content.edges.map(e => e.edgeId), ['start_end']);
  assert.equal(removed.layout.nodes[id], undefined);
  assert.deepEqual(removed.content, normalizeLayout(newDocument()).content);
  assert.throws(() => addNode(d, 'SCRIPT' as never), /UNSUPPORTED_NODE_TYPE/);
});

test('read-only projection marks every node/edge non-deletable and non-draggable', () => {
  const flow = toFlow(doc(), '', true);
  assert.ok(flow.nodes.every(n => !n.deletable && !n.draggable && n.data.readOnly));
  assert.ok(flow.edges.every(e => !e.deletable));
});

test('stale layout isolation: geometry is reused only for the same definition and contentHash', () => {
  const store = new Map<string, string>(), storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  const d = doc(), id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222', hash = 'a'.repeat(64);
  const moved = moveNodes(d, { start: { x: 999, y: 999 } });
  assert.equal(saveServerLayout(storage, id, hash, moved), true);
  assert.equal(readServerLayout(storage, id, hash, d.content).nodes.start.x, 999);
  assert.deepEqual(readServerLayout(storage, id, 'b'.repeat(64), d.content), EMPTY_LAYOUT());
  assert.deepEqual(readServerLayout(storage, other, hash, d.content), EMPTY_LAYOUT());
  store.set(`${LAYOUT_KEY}:${id}`, '{"contentHash":"' + hash + '","layout":{"nodes":{"evil":{"x":1,"y":1,"width":30,"height":30}},"edges":{}}}');
  assert.deepEqual(readServerLayout(storage, id, hash, d.content), EMPTY_LAYOUT());
  assert.equal(normalizeLayout({ content: d.content, layout: EMPTY_LAYOUT() }).layout.nodes.start.x, d.layout.nodes.start.x);
});

test('BPMN projection of a normalized document carries every node/edge with its canonical payload', () => {
  const d = doc(), xml = toBpmnXml(d);
  for (const n of d.content.nodes) assert.ok(xml.includes(`id="n_${n.nodeId}"`));
  for (const e of d.content.edges) assert.ok(xml.includes(`id="e_${e.edgeId}"`) && xml.includes(`id="line_${e.edgeId}"`));
});

test('structural path preview lists every route once and marks bounded loop-backs without executing them', () => {
  const { paths, truncated } = structuralPaths(doc());
  assert.equal(truncated, false);
  const text = paths.map(p => p.map(s => `${s.via ? `[${s.via}] ` : ''}${s.nodeId}${s.loop ? '↺' : ''}`).join(' > '));
  assert.ok(text.includes('start > ai_extract > [AI hoàn tất] confirm_extraction > [Xác nhận dữ liệu] end_completed'));
  assert.ok(text.some(t => t.endsWith('[Nếu Lượt bổ sung hiện tại ≤ 3 · lặp tối đa 3] ai_extract↺')));
  assert.ok(paths.every(p => p.at(-1)!.loop || doc().content.nodes.find(n => n.nodeId === p.at(-1)!.nodeId)!.type === 'END'));
  assert.equal(structuralPaths(doc(), 2).truncated, true);
});
