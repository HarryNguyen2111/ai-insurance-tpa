import type Modeler from 'bpmn-js/lib/Modeler';
import { BPMN_TYPES, nodeSize, TPA_DESCRIPTOR, toBpmnXml } from './workflow-bpmn.ts';
import { newNode, NODE_TYPES, suggestedGuard, type EditorDocument, type NodeType, type Point, type WorkflowEdge, type WorkflowNode } from './workflow-definition.ts';

interface BusinessObject {
  $type: string; id: string; name?: string; eventDefinitions?: BusinessObject[];
  get(name: string): unknown;
}
export interface DiagramElement {
  id: string; type: string; businessObject: BusinessObject; labelTarget?: DiagramElement;
  x: number; y: number; width: number; height: number; waypoints?: Point[];
  source?: DiagramElement; target?: DiagramElement;
}
interface Registry { getAll(): DiagramElement[]; get(id: string): DiagramElement }
interface Modeling {
  createShape(shape: unknown, position: Point, parent: unknown): DiagramElement;
  connect(source: DiagramElement, target: DiagramElement, attrs: Record<string, unknown>): DiagramElement;
  updateProperties(element: DiagramElement, properties: Record<string, unknown>): void;
  moveShape(shape: DiagramElement, delta: Point): void;
  removeElements(elements: DiagramElement[]): void;
}
interface Canvas {
  getRootElement(): unknown; zoom(value?: string | number): void;
  viewbox(): { x: number; y: number; scale: number };
}
interface Moddle { create(type: string, properties?: Record<string, unknown>): BusinessObject }
interface ElementFactory { createShape(properties: Record<string, unknown>): unknown }
interface EventBus { on(name: string, priority: number, callback: (context: { context?: { shape?: DiagramElement; newShape?: DiagramElement; elements?: DiagramElement[]; connection?: DiagramElement } }) => false | undefined): void }

export async function createModeler(container: HTMLElement): Promise<Modeler> {
  const { default: BpmnModeler } = await import('bpmn-js/lib/Modeler');
  return new BpmnModeler({ container, moddleExtensions: { tpa: TPA_DESCRIPTOR }, additionalModules: [{
    __init__: ['restrictedRules'], restrictedRules: ['type', RestrictedRules],
    paletteProvider: ['value', { getPaletteEntries: () => ({}) }],
    contextPadProvider: ['value', { getContextPadEntries: () => ({}), getMultiElementContextPadEntries: () => ({}) }],
  }] });
}

function RestrictedRules(eventBus: EventBus) {
  for (const name of ['shape.create', 'shape.append', 'elements.create', 'connection.create', 'connection.reconnect']) {
    eventBus.on(`commandStack.${name}.canExecute`, 2000, event => {
      const context = event.context;
      const elements = context?.elements ?? [context?.shape ?? context?.connection].filter(Boolean) as DiagramElement[];
      if (elements.some(el => ![...Object.values(BPMN_TYPES), 'bpmn:SequenceFlow'].includes(el.type))) return false;
      return undefined;
    });
  }
  for (const name of ['shape.replace', 'element.updateLabel', 'elements.copy']) eventBus.on(`commandStack.${name}.canExecute`, 2000, () => false);
}
RestrictedRules.$inject = ['eventBus'];

export function captureDocument(modeler: Modeler, previous: EditorDocument): EditorDocument {
  const all = modeler.get<Registry>('elementRegistry').getAll().filter(e => !e.labelTarget);
  const nodes: WorkflowNode[] = [], edges: WorkflowEdge[] = [];
  const layout: EditorDocument['layout'] = { nodes: {}, edges: {} };
  for (const el of all.filter(e => e.id.startsWith('n_'))) {
    const payload = el.businessObject.get('tpa:node');
    if (typeof payload !== 'string') throw new Error('UNSUPPORTED_BPMN_ELEMENT');
    const node = JSON.parse(payload) as WorkflowNode;
    // Upstream IDs are unique, including pasted elements; never carry a duplicated canonical node ID.
    node.nodeId = el.id.slice(2);
    if (BPMN_TYPES[node.type] !== el.type) throw new Error('UNSUPPORTED_BPMN_ELEMENT');
    nodes.push(node);
    layout.nodes[node.nodeId] = { x: el.x, y: el.y, width: el.width, height: el.height };
  }
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  for (const el of all.filter(e => e.type === 'bpmn:SequenceFlow')) {
    if (!el.source || !el.target) throw new Error('DANGLING_EDGE');
    const source = el.source.id.slice(2), target = el.target.id.slice(2);
    const s = byId.get(source);
    if (!s || !byId.has(target)) throw new Error('DANGLING_EDGE');
    const payload = el.businessObject.get('tpa:edge');
    const old = typeof payload === 'string' ? JSON.parse(payload) as WorkflowEdge : undefined;
    // Reconnecting a flow preserves its guard; validation reports an incompatible source.
    const edge: WorkflowEdge = { ...(old ?? { guard: suggestedGuard(s, edges.filter(e => e.source === source)) }), edgeId: el.id.startsWith('e_') ? el.id.slice(2) : `flow_${el.id.toLowerCase()}`, source, target };
    edges.push(edge);
    layout.edges[edge.edgeId] = (el.waypoints ?? []).map(p => ({ x: p.x, y: p.y }));
  }
  // Preserve canonical array order; moving nodes must not alter contentHash.
  const order = <T,>(items: T[], old: T[], id: (v: T) => string) => items.sort((a, b) => {
    const rank = (v: T) => { const i = old.findIndex(o => id(o) === id(v)); return i < 0 ? old.length : i; };
    return rank(a) - rank(b);
  });
  order(nodes, previous.content.nodes, n => n.nodeId); order(edges, previous.content.edges, e => e.edgeId);
  layout.labels = {};
  for (const el of all.filter(e => e.labelTarget)) {
    const id = el.labelTarget!.id;
    if (id.startsWith('n_') || id.startsWith('e_')) layout.labels[id] = { x: el.x, y: el.y, width: el.width, height: el.height };
  }
  return { content: { ...previous.content, nodes, edges }, layout };
}

export function addNode(modeler: Modeler, type: NodeType, doc: EditorDocument, position?: Point): string {
  if (!NODE_TYPES.includes(type) || doc.content.nodes.length >= 50) throw new Error('LIMIT_EXCEEDED');
  let index = 1;
  while (doc.content.nodes.some(n => n.nodeId === `${type.toLowerCase()}_${index}`)) index++;
  const id = `${type.toLowerCase()}_${index}`, node = newNode(type, id);
  const moddle = modeler.get<Moddle>('moddle');
  const bo = moddle.create(BPMN_TYPES[type], { id: `n_${id}`, name: node.label, 'tpa:node': JSON.stringify(node) });
  if (type === 'TIMER' || type === 'SUPPLEMENT_WAIT') bo.eventDefinitions = [moddle.create(type === 'TIMER' ? 'bpmn:TimerEventDefinition' : 'bpmn:MessageEventDefinition')];
  const shape = modeler.get<ElementFactory>('elementFactory').createShape({ type: BPMN_TYPES[type], businessObject: bo, ...nodeSize(type) });
  const size = nodeSize(type);
  modeler.get<Modeling>('modeling').createShape(shape, position ?? { x: 260 + (doc.content.nodes.length % 3) * 160 + size.width / 2, y: 320 + Math.floor(doc.content.nodes.length / 3) * 120 }, modeler.get<Canvas>('canvas').getRootElement());
  modeler.get<Canvas>('canvas').zoom('fit-viewport');
  return id;
}
export function connectNodes(modeler: Modeler, source: string, target: string, doc: EditorDocument): void {
  const node = doc.content.nodes.find(n => n.nodeId === source), t = doc.content.nodes.find(n => n.nodeId === target);
  if (!node || !t || node.type === 'END' || t.type === 'START' || source === target || doc.content.edges.length >= 100) throw new Error('GUARD_NOT_ALLOWED_FOR_SOURCE');
  let index = 1; while (doc.content.edges.some(e => e.edgeId === `route_${index}`)) index++;
  const id = `route_${index}`, edge: WorkflowEdge = { edgeId: id, source, target, guard: suggestedGuard(node, doc.content.edges.filter(e => e.source === source)) };
  const registry = modeler.get<Registry>('elementRegistry');
  const bo = modeler.get<Moddle>('moddle').create('bpmn:SequenceFlow', { id: `e_${id}`, 'tpa:edge': JSON.stringify(edge) });
  modeler.get<Modeling>('modeling').connect(registry.get(`n_${source}`), registry.get(`n_${target}`), { type: 'bpmn:SequenceFlow', businessObject: bo });
}
export function moveNode(modeler: Modeler, id: string, dx: number, dy: number): void {
  modeler.get<Modeling>('modeling').moveShape(modeler.get<Registry>('elementRegistry').get(`n_${id}`), { x: dx, y: dy });
}
export function removeElement(modeler: Modeler, id: string, edge = false): void {
  modeler.get<Modeling>('modeling').removeElements([modeler.get<Registry>('elementRegistry').get(`${edge ? 'e' : 'n'}_${id}`)]);
}
export function dropPosition(modeler: Modeler, container: HTMLElement, client: Point): Point {
  const box = container.getBoundingClientRect(), v = modeler.get<Canvas>('canvas').viewbox();
  return { x: Math.max(60, v.x + (client.x - box.left) / v.scale), y: Math.max(60, v.y + (client.y - box.top) / v.scale) };
}
