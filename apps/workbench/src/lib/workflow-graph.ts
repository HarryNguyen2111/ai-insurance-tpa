import { newNode, NODE_LABELS, NODE_TYPES, suggestedGuard, type EditorDocument, type NodeType, type Point, type WorkflowEdge, type WorkflowLayout, type WorkflowNode } from './workflow-definition.ts';
import { nodeSize } from './workflow-bpmn.ts';
import { CANDIDATE_ROLE_LABELS, END_OUTCOME_LABELS, guardLabel, OWNER_LABELS, duration } from './workflow-labels.ts';

// Projection between the canonical EditorDocument (server/business truth + browser-local layout) and the
// React Flow view model. React Flow state is never persisted or sent: every edit goes through these pure
// functions, which change canonical content only for semantic edits and only layout for geometry edits.

export const MAX_NODES = 50, MAX_EDGES = 100;
const LIMIT = 10000;
const COLUMN = 260, ROW = 150, ORIGIN = 60;

export interface FlowNodeData extends Record<string, unknown> {
  node: WorkflowNode; title: string; kind: string; lines: string[]; issues: number; readOnly: boolean;
}
export interface FlowNode { id: string; type: 'workflow'; position: Point; data: FlowNodeData; selected: boolean; deletable: boolean; draggable: boolean; ariaLabel: string }
export interface FlowEdge {
  id: string; source: string; target: string; type: 'smoothstep'; label?: string; selected: boolean; deletable: boolean;
  data: { kind: WorkflowEdge['guard']['kind']; issues: number }; className?: string; ariaLabel: string;
}

const clamp = (n: number) => Math.max(-LIMIT + 200, Math.min(LIMIT - 200, Math.round(n)));
export function defaultWaypoints(s: WorkflowLayout['nodes'][string], t: WorkflowLayout['nodes'][string]): Point[] {
  return [{ x: s.x + s.width, y: s.y + s.height / 2 }, { x: t.x, y: t.y + t.height / 2 }];
}

/** Deterministic layered placement (columns by BFS depth from START, loopBack edges ignored). */
export function autoLayout(doc: EditorDocument): Record<string, Point> {
  const { nodes, edges } = doc.content;
  const depth = new Map<string, number>();
  const queue = nodes.filter(n => n.type === 'START').map(n => n.nodeId);
  queue.forEach(id => depth.set(id, 0));
  for (let i = 0; i < queue.length; i++) {
    for (const e of edges) {
      if (e.source !== queue[i] || e.loopBack || depth.has(e.target) || !nodes.some(n => n.nodeId === e.target)) continue;
      depth.set(e.target, depth.get(queue[i])! + 1); queue.push(e.target);
    }
  }
  const last = Math.max(0, ...depth.values()) + 1;
  const rows = new Map<number, number>(), out: Record<string, Point> = {};
  for (const n of nodes) {
    const column = depth.get(n.nodeId) ?? last, row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    out[n.nodeId] = { x: ORIGIN + column * COLUMN, y: ORIGIN + row * ROW };
  }
  return out;
}

/**
 * Fill missing geometry (new server versions carry no layout), drop geometry for unknown IDs, and give every edge
 * BPMN-compatible waypoints. Idempotent; content is returned unchanged so contentHash is unaffected.
 */
export function normalizeLayout(doc: EditorDocument): EditorDocument {
  const auto = autoLayout(doc), layout: WorkflowLayout = { nodes: {}, edges: {}, labels: {} };
  for (const n of doc.content.nodes) {
    const old = doc.layout.nodes[n.nodeId];
    layout.nodes[n.nodeId] = old ? { ...old } : { ...auto[n.nodeId], ...nodeSize(n.type) };
  }
  for (const e of doc.content.edges) {
    const s = layout.nodes[e.source], t = layout.nodes[e.target];
    if (!s || !t) continue;
    layout.edges[e.edgeId] = doc.layout.edges[e.edgeId]?.map(p => ({ ...p })) ?? defaultWaypoints(s, t);
  }
  for (const [id, box] of Object.entries(doc.layout.labels ?? {})) {
    const known = id.startsWith('n_') ? !!layout.nodes[id.slice(2)] : id.startsWith('e_') ? !!layout.edges[id.slice(2)] : false;
    if (known) layout.labels![id] = { ...box };
  }
  return { content: doc.content, layout };
}

/** Geometry-only edit. Edges touching a moved node get fresh straight waypoints (BPMN export stays consistent). */
export function moveNodes(doc: EditorDocument, positions: Record<string, Point>): EditorDocument {
  const moved = Object.keys(positions).filter(id => doc.layout.nodes[id]);
  if (!moved.length) return doc;
  const nodes = { ...doc.layout.nodes };
  for (const id of moved) nodes[id] = { ...nodes[id], x: clamp(positions[id].x), y: clamp(positions[id].y) };
  const edges = { ...doc.layout.edges }, labels = { ...(doc.layout.labels ?? {}) };
  for (const e of doc.content.edges) {
    if (!moved.includes(e.source) && !moved.includes(e.target)) continue;
    if (nodes[e.source] && nodes[e.target]) edges[e.edgeId] = defaultWaypoints(nodes[e.source], nodes[e.target]);
    delete labels[`e_${e.edgeId}`];
  }
  for (const id of moved) delete labels[`n_${id}`];
  return { content: doc.content, layout: { nodes, edges, labels } };
}

export function nextId(prefix: string, taken: (id: string) => boolean): string {
  let i = 1;
  while (taken(`${prefix}_${i}`)) i++;
  return `${prefix}_${i}`;
}

/** Adds an intentionally incomplete step: no SLA/AI policy defaults are invented (fields must be configured). */
export function addNode(doc: EditorDocument, type: NodeType, position?: Point): { doc: EditorDocument; id: string } {
  if (!NODE_TYPES.includes(type)) throw new Error('UNSUPPORTED_NODE_TYPE');
  if (doc.content.nodes.length >= MAX_NODES) throw new Error('LIMIT_EXCEEDED');
  const id = nextId(type.toLowerCase(), v => doc.content.nodes.some(n => n.nodeId === v));
  const node = newNode(type, id);
  if (node.type === 'HUMAN_TASK' && !doc.content.assignmentPolicy.rules.some(r => r.ruleKey === node.assignmentRuleKey)) {
    node.assignmentRuleKey = doc.content.assignmentPolicy.rules[0]?.ruleKey ?? node.assignmentRuleKey;
  }
  const count = doc.content.nodes.length;
  const at = position ?? { x: ORIGIN + (count % 4) * COLUMN, y: ORIGIN + 4 * ROW + Math.floor(count / 4) * ROW };
  return {
    id,
    doc: {
      content: { ...doc.content, nodes: [...doc.content.nodes, node] },
      layout: { ...doc.layout, nodes: { ...doc.layout.nodes, [id]: { x: clamp(at.x), y: clamp(at.y), ...nodeSize(type) } } },
    },
  };
}

/** Structural connection rules mirrored from spec 14 §2; the server re-validates everything. */
export function connectionProblem(doc: EditorDocument, source: string, target: string): string | null {
  const s = doc.content.nodes.find(n => n.nodeId === source), t = doc.content.nodes.find(n => n.nodeId === target);
  if (!s || !t) return 'DANGLING_EDGE';
  if (source === target) return 'SELF_LOOP';
  if (s.type === 'END') return 'END_HAS_OUTGOING';
  if (t.type === 'START') return 'START_HAS_INCOMING';
  if (doc.content.edges.length >= MAX_EDGES) return 'LIMIT_EXCEEDED';
  return null;
}
export const CONNECTION_MESSAGES: Record<string, string> = {
  DANGLING_EDGE: 'Chọn bước nguồn và bước đích có trong sơ đồ.',
  SELF_LOOP: 'Một bước không thể nối vào chính nó.',
  END_HAS_OUTGOING: 'Bước kết thúc không có nhánh ra.',
  START_HAS_INCOMING: 'Không nối vào bước bắt đầu.',
  LIMIT_EXCEEDED: 'Đã đạt giới hạn 100 nhánh.',
};
export function connect(doc: EditorDocument, source: string, target: string): { doc: EditorDocument; id: string } {
  const problem = connectionProblem(doc, source, target);
  if (problem) throw new Error(problem);
  const s = doc.content.nodes.find(n => n.nodeId === source)!;
  const id = nextId('route', v => doc.content.edges.some(e => e.edgeId === v));
  const edge: WorkflowEdge = { edgeId: id, source, target, guard: suggestedGuard(s, doc.content.edges.filter(e => e.source === source)) };
  const ls = doc.layout.nodes[source], lt = doc.layout.nodes[target];
  return {
    id,
    doc: {
      content: { ...doc.content, edges: [...doc.content.edges, edge] },
      layout: ls && lt ? { ...doc.layout, edges: { ...doc.layout.edges, [id]: defaultWaypoints(ls, lt) } } : doc.layout,
    },
  };
}

/** Deleting a step also deletes its connections. References elsewhere (e.g. distinctFromNodeIds) are kept and flagged. */
export function removeElements(doc: EditorDocument, nodeIds: string[], edgeIds: string[]): EditorDocument {
  const nodes = new Set(nodeIds), edges = new Set(edgeIds);
  for (const e of doc.content.edges) if (nodes.has(e.source) || nodes.has(e.target)) edges.add(e.edgeId);
  if (!nodes.size && !edges.size) return doc;
  const layout: WorkflowLayout = { nodes: { ...doc.layout.nodes }, edges: { ...doc.layout.edges }, labels: { ...(doc.layout.labels ?? {}) } };
  nodes.forEach(id => { delete layout.nodes[id]; delete layout.labels![`n_${id}`]; });
  edges.forEach(id => { delete layout.edges[id]; delete layout.labels![`e_${id}`]; });
  return {
    content: { ...doc.content, nodes: doc.content.nodes.filter(n => !nodes.has(n.nodeId)), edges: doc.content.edges.filter(e => !edges.has(e.edgeId)) },
    layout,
  };
}

export function replaceNode(doc: EditorDocument, node: WorkflowNode): EditorDocument {
  return { ...doc, content: { ...doc.content, nodes: doc.content.nodes.map(n => n.nodeId === node.nodeId ? node : n) } };
}
export function replaceEdge(doc: EditorDocument, edge: WorkflowEdge): EditorDocument {
  return { ...doc, content: { ...doc.content, edges: doc.content.edges.map(e => e.edgeId === edge.edgeId ? edge : e) } };
}

/** Card lines: role / responsibility / timing summary. Values not configured are shown as such, never invented. */
export function nodeLines(node: WorkflowNode, doc: EditorDocument): string[] {
  const owner = 'accountableOwner' in node ? `Chịu trách nhiệm: ${OWNER_LABELS[node.accountableOwner] ?? node.accountableOwner}` : '';
  switch (node.type) {
    case 'START': return ['Hồ sơ vào quy trình'];
    case 'END': return [`Kết quả: ${END_OUTCOME_LABELS[node.outcome] ?? node.outcome}`];
    case 'CONDITION': return [`${doc.content.edges.filter(e => e.source === node.nodeId).length} nhánh ra`];
    case 'TIMER': return [`Chờ ${duration(node.delaySeconds)}`];
    case 'SUPPLEMENT_WAIT': return [owner, `Hạn bổ sung: ${duration(node.maxWaitSeconds)}`];
    case 'HUMAN_TASK': {
      const rule = doc.content.assignmentPolicy.rules.find(r => r.ruleKey === node.assignmentRuleKey);
      return [`Ứng viên: ${rule ? rule.candidateRoles.map(r => CANDIDATE_ROLE_LABELS[r] ?? r).join(', ') : 'chưa chọn quy tắc'}`, owner, `SLA: ${duration(node.sla.dueSeconds)}`];
    }
    case 'AI_ACTIVITY': return [`Tác nhân AI: ${node.serviceActorScopeKey === 'configure.required' ? 'chưa cấu hình' : node.serviceActorScopeKey}`, owner, `Tối đa ${duration(node.timeoutSeconds)}`];
  }
}

export interface IssueCounts { nodes: Record<string, number>; edges: Record<string, number> }
export function toFlow(doc: EditorDocument, selected: string, readOnly: boolean, counts: IssueCounts = { nodes: {}, edges: {} }): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes = doc.content.nodes.map((node): FlowNode => {
    const box = doc.layout.nodes[node.nodeId] ?? { x: ORIGIN, y: ORIGIN };
    return {
      id: node.nodeId, type: 'workflow', position: { x: box.x, y: box.y }, selected: selected === `n_${node.nodeId}`,
      deletable: !readOnly, draggable: !readOnly, ariaLabel: `${NODE_LABELS[node.type]}: ${node.label}`,
      data: { node, title: node.label, kind: NODE_LABELS[node.type], lines: nodeLines(node, doc).filter(Boolean), issues: counts.nodes[node.nodeId] ?? 0, readOnly },
    };
  });
  const edges = doc.content.edges.map((edge): FlowEdge => {
    const label = guardLabel(edge), issues = counts.edges[edge.edgeId] ?? 0;
    return {
      id: edge.edgeId, source: edge.source, target: edge.target, type: 'smoothstep', selected: selected === `e_${edge.edgeId}`, deletable: !readOnly,
      ...(label ? { label } : {}), data: { kind: edge.guard.kind, issues },
      ...(issues ? { className: 'has-issue' } : {}),
      ariaLabel: `Nhánh ${label || 'tiếp theo'} từ ${edge.source} tới ${edge.target}`,
    };
  });
  return { nodes, edges };
}

export interface PathStep { nodeId: string; label: string; via?: string; loop?: string }
/**
 * Structural path preview: enumerates routes from START by following edges (each loopBack edge is shown once, as a
 * return marker, not executed). This reads the graph only; it does not run Temporal, AI or any business logic.
 */
export function structuralPaths(doc: EditorDocument, limit = 20): { paths: PathStep[][]; truncated: boolean } {
  const nodes = new Map(doc.content.nodes.map(n => [n.nodeId, n]));
  const paths: PathStep[][] = [];
  let truncated = false;
  const walk = (id: string, trail: PathStep[], seen: Set<string>) => {
    if (paths.length >= limit) { truncated = true; return; }
    const node = nodes.get(id);
    if (!node) return;
    const out = doc.content.edges.filter(e => e.source === id && nodes.has(e.target));
    if (!out.length) { paths.push(trail); return; }
    for (const e of out) {
      const label = guardLabel(e), target = nodes.get(e.target)!;
      if (e.loopBack || seen.has(e.target)) { paths.push([...trail, { nodeId: target.nodeId, label: target.label, via: label, loop: e.loopBack ? `quay lại, tối đa ${e.loopBack.maxIterations} lần` : 'vòng lặp chưa giới hạn' }]); continue; }
      walk(e.target, [...trail, { nodeId: target.nodeId, label: target.label, via: label }], new Set([...seen, e.target]));
    }
  };
  for (const start of doc.content.nodes.filter(n => n.type === 'START')) walk(start.nodeId, [{ nodeId: start.nodeId, label: start.label }], new Set([start.nodeId]));
  return { paths, truncated };
}
