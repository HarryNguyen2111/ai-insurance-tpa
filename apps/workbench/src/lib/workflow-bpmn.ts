import { byteLength, canonicalJson, isWorkflowContent, type EditorDocument, type NodeType, type WorkflowContent, type WorkflowEdge, type WorkflowNode } from './workflow-definition.ts';
import { validLayout } from './workflow-draft.ts';

export const NS = {
  bpmn: 'http://www.omg.org/spec/BPMN/20100524/MODEL', bpmndi: 'http://www.omg.org/spec/BPMN/20100524/DI',
  dc: 'http://www.omg.org/spec/DD/20100524/DC', di: 'http://www.omg.org/spec/DD/20100524/DI', tpa: 'urn:tpa:workflow:1',
};
export const BPMN_TYPES: Record<NodeType, string> = {
  START: 'bpmn:StartEvent', END: 'bpmn:EndEvent', HUMAN_TASK: 'bpmn:UserTask', AI_ACTIVITY: 'bpmn:ServiceTask',
  CONDITION: 'bpmn:ExclusiveGateway', SUPPLEMENT_WAIT: 'bpmn:IntermediateCatchEvent', TIMER: 'bpmn:IntermediateCatchEvent',
};
const TAGS: Record<NodeType, string> = { START: 'startEvent', END: 'endEvent', HUMAN_TASK: 'userTask', AI_ACTIVITY: 'serviceTask', CONDITION: 'exclusiveGateway', SUPPLEMENT_WAIT: 'intermediateCatchEvent', TIMER: 'intermediateCatchEvent' };
// Typed, namespaced attributes; JSON payloads are independently checked against the VWF-01 contract.
export const TPA_DESCRIPTOR = {
  name: 'TPA', uri: NS.tpa, prefix: 'tpa', xml: { tagAlias: 'lowerCase' },
  types: [{ name: 'WorkflowData', extends: ['bpmn:BaseElement'], properties: [
    { name: 'metadata', type: 'String', isAttr: true }, { name: 'node', type: 'String', isAttr: true }, { name: 'edge', type: 'String', isAttr: true },
  ] }],
};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
export const nodeSize = (type: NodeType) => type === 'HUMAN_TASK' || type === 'AI_ACTIVITY' ? { width: 120, height: 80 } : type === 'CONDITION' ? { width: 50, height: 50 } : { width: 36, height: 36 };

/** Projection only. Canonical content remains independent of XML/layout. */
export function toBpmnXml(doc: EditorDocument): string {
  const { nodes, edges, ...metadata } = doc.content;
  const positions = Object.fromEntries(nodes.map((n, i) => [n.nodeId, doc.layout.nodes[n.nodeId] ?? { x: 80 + (i % 5) * 160, y: 80 + Math.floor(i / 5) * 160, ...nodeSize(n.type) }]));
  const label = (id: string) => {
    const b = doc.layout.labels?.[id];
    return b ? `<bpmndi:BPMNLabel><dc:Bounds x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}"/></bpmndi:BPMNLabel>` : '';
  };
  const steps = nodes.map(n => {
    const event = n.type === 'TIMER' ? '<bpmn:timerEventDefinition/>' : n.type === 'SUPPLEMENT_WAIT' ? '<bpmn:messageEventDefinition/>' : '';
    return `<bpmn:${TAGS[n.type]} id="n_${n.nodeId}" name="${esc(n.label)}" tpa:node="${esc(canonicalJson(n))}">${event}</bpmn:${TAGS[n.type]}>`;
  }).join('');
  const flows = edges.filter(e => positions[e.source] && positions[e.target]).map(e => `<bpmn:sequenceFlow id="e_${e.edgeId}" sourceRef="n_${e.source}" targetRef="n_${e.target}" tpa:edge="${esc(canonicalJson(e))}"/>`).join('');
  const shapes = nodes.map(n => { const p = positions[n.nodeId]; return `<bpmndi:BPMNShape id="shape_${n.nodeId}" bpmnElement="n_${n.nodeId}"><dc:Bounds x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}"/>${label(`n_${n.nodeId}`)}</bpmndi:BPMNShape>`; }).join('');
  const lines = edges.filter(e => positions[e.source] && positions[e.target]).map(e => {
    const s = positions[e.source], t = positions[e.target];
    const points = doc.layout.edges[e.edgeId] ?? [{ x: s.x + s.width, y: s.y + s.height / 2 }, { x: t.x, y: t.y + t.height / 2 }];
    return `<bpmndi:BPMNEdge id="line_${e.edgeId}" bpmnElement="e_${e.edgeId}">${points.map(p => `<di:waypoint x="${p.x}" y="${p.y}"/>`).join('')}${label(`e_${e.edgeId}`)}</bpmndi:BPMNEdge>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><bpmn:definitions ${Object.entries(NS).map(([p, uri]) => `xmlns:${p}="${uri}"`).join(' ')} id="Definitions_1" targetNamespace="${NS.tpa}"><bpmn:process id="Process_1" isExecutable="false" tpa:metadata="${esc(canonicalJson(metadata))}">${steps}${flows}</bpmn:process><bpmndi:BPMNDiagram id="Diagram_1"><bpmndi:BPMNPlane id="Plane_1" bpmnElement="Process_1">${shapes}${lines}</bpmndi:BPMNPlane></bpmndi:BPMNDiagram></bpmn:definitions>`;
}

export const MAX_XML_BYTES = 256 * 1024;
/** Runs before DOM parsing and before upstream import. No entity declarations or processing instructions. */
export function checkXmlEnvelope(xml: string): void {
  if (byteLength(xml) > MAX_XML_BYTES) throw new Error('LIMIT_EXCEEDED');
  const body = xml.replace(/^\s*<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?\s*\?>/i, '');
  if (/<!|<\?|\u0000/i.test(body)) throw new Error('UNSAFE_XML');
}
const allowedTags: Record<string, string[]> = {
  [NS.bpmn]: ['definitions', 'process', ...Object.values(TAGS), 'sequenceFlow', 'incoming', 'outgoing', 'messageEventDefinition', 'timerEventDefinition'],
  [NS.bpmndi]: ['BPMNDiagram', 'BPMNPlane', 'BPMNShape', 'BPMNEdge', 'BPMNLabel'], [NS.dc]: ['Bounds'], [NS.di]: ['waypoint'],
};
const attrs: Record<string, string[]> = {
  definitions: ['id', 'targetNamespace', 'exporter', 'exporterVersion'], process: ['id', 'isExecutable'],
  startEvent: ['id', 'name'], endEvent: ['id', 'name'], userTask: ['id', 'name'], serviceTask: ['id', 'name'],
  exclusiveGateway: ['id', 'name'], intermediateCatchEvent: ['id', 'name'], sequenceFlow: ['id', 'sourceRef', 'targetRef', 'name'],
  incoming: [], outgoing: [], messageEventDefinition: ['id'], timerEventDefinition: ['id'],
  BPMNDiagram: ['id'], BPMNPlane: ['id', 'bpmnElement'], BPMNShape: ['id', 'bpmnElement'], BPMNEdge: ['id', 'bpmnElement'],
  BPMNLabel: ['id'], Bounds: ['x', 'y', 'width', 'height'], waypoint: ['x', 'y'],
};
const children: Record<string, string[]> = {
  definitions: ['process', 'BPMNDiagram'], process: [...Object.values(TAGS), 'sequenceFlow'], BPMNDiagram: ['BPMNPlane'],
  BPMNPlane: ['BPMNShape', 'BPMNEdge'], BPMNShape: ['Bounds', 'BPMNLabel'], BPMNEdge: ['waypoint', 'BPMNLabel'], BPMNLabel: ['Bounds'],
  intermediateCatchEvent: ['incoming', 'outgoing', 'messageEventDefinition', 'timerEventDefinition'],
  startEvent: ['incoming', 'outgoing'], endEvent: ['incoming', 'outgoing'], userTask: ['incoming', 'outgoing'], serviceTask: ['incoming', 'outgoing'], exclusiveGateway: ['incoming', 'outgoing'],
};
function fail(code = 'UNSUPPORTED_BPMN_ELEMENT'): never { throw new Error(code); }

/** Accept only the supported TPA interchange format, never silently discard BPMN semantics. */
export function fromBpmnXml(xml: string): EditorDocument {
  checkXmlEnvelope(xml);
  const dom = new DOMParser().parseFromString(xml, 'application/xml');
  if (dom.getElementsByTagName('parsererror').length) fail('MALFORMED_XML');
  const root = dom.documentElement;
  if (root.namespaceURI !== NS.bpmn || root.localName !== 'definitions') fail();
  const all = [root, ...Array.from(root.getElementsByTagName('*'))];
  if (all.length > 5000) fail('LIMIT_EXCEEDED');
  const ids = new Set<string>();
  for (const el of all) {
    if (/^(parallelGateway|inclusiveGateway|complexGateway|multiInstanceLoopCharacteristics)$/.test(el.localName)) fail('PARALLEL_NOT_SUPPORTED');
    if (!allowedTags[el.namespaceURI ?? '']?.includes(el.localName)) fail();
    for (const attr of Array.from(el.attributes)) {
      if (attr.namespaceURI === 'http://www.w3.org/2000/xmlns/') {
        if (!Object.values(NS).includes(attr.value)) fail();
      } else if (attr.namespaceURI === NS.tpa) {
        const expected = el.localName === 'process' ? 'metadata' : el.localName === 'sequenceFlow' ? 'edge' : Object.values(TAGS).includes(el.localName) ? 'node' : '';
        if (attr.localName !== expected) fail();
      } else if (attr.namespaceURI || !attrs[el.localName]?.includes(attr.name)) fail();
    }
    for (const child of Array.from(el.children)) if (!children[el.localName]?.includes(child.localName)) fail();
    for (const text of Array.from(el.childNodes)) if (text.nodeType === 3 && text.textContent?.trim() && !['incoming', 'outgoing'].includes(el.localName)) fail();
    const id = el.getAttribute('id');
    if (id) { if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(id) || ids.has(id)) fail('DUPLICATE_ID'); ids.add(id); }
  }
  const get = (namespace: string, tag: string) => Array.from(dom.getElementsByTagNameNS(namespace, tag));
  const processes = get(NS.bpmn, 'process'), planes = get(NS.bpmndi, 'BPMNPlane');
  if (processes.length !== 1 || planes.length !== 1 || get(NS.bpmndi, 'BPMNDiagram').length !== 1 || root.children.length !== 2) fail();
  const process = processes[0];
  if (process.getAttribute('isExecutable') !== 'false' || planes[0].getAttribute('bpmnElement') !== process.id) fail();
  const metadata = JSON.parse(process.getAttributeNS(NS.tpa, 'metadata') ?? 'null') as Record<string, unknown> | null;
  if (!metadata || 'nodes' in metadata || 'edges' in metadata) fail('SCHEMA_INVALID');
  const nodes: WorkflowNode[] = [], edges: WorkflowEdge[] = [];
  for (const el of Array.from(process.children)) {
    if (el.localName === 'sequenceFlow') {
      const edge = JSON.parse(el.getAttributeNS(NS.tpa, 'edge') ?? 'null') as WorkflowEdge | null;
      if (!edge || el.id !== `e_${edge.edgeId}` || el.getAttribute('sourceRef') !== `n_${edge.source}` || el.getAttribute('targetRef') !== `n_${edge.target}` || el.hasAttribute('name')) fail('SCHEMA_INVALID');
      edges.push(edge);
    } else {
      const node = JSON.parse(el.getAttributeNS(NS.tpa, 'node') ?? 'null') as WorkflowNode | null;
      if (!node || !Object.hasOwn(TAGS, node.type) || el.id !== `n_${node.nodeId}` || el.localName !== TAGS[node.type] || el.getAttribute('name') !== node.label) fail('SCHEMA_INVALID');
      const events = Array.from(el.children).filter(c => c.localName.endsWith('EventDefinition'));
      const expected = node.type === 'TIMER' ? 'timerEventDefinition' : node.type === 'SUPPLEMENT_WAIT' ? 'messageEventDefinition' : null;
      if (events.length !== (expected ? 1 : 0) || (expected && events[0].localName !== expected)) fail();
      nodes.push(node);
    }
  }
  const content = { ...metadata, nodes, edges } as WorkflowContent;
  if (!isWorkflowContent(content) || byteLength(canonicalJson(content)) > 65536) fail('SCHEMA_INVALID');
  const layout: EditorDocument['layout'] = { nodes: {}, edges: {}, labels: {} };
  const readLabel = (parent: Element, id: string) => {
    const labels = Array.from(parent.children).filter(c => c.localName === 'BPMNLabel');
    if (labels.length > 1) fail();
    if (labels.length) {
      const bounds = Array.from(labels[0].children);
      if (bounds.length !== 1 || bounds[0].localName !== 'Bounds') fail();
      const b = bounds[0];
      layout.labels![id] = { x: numeric(b, 'x'), y: numeric(b, 'y'), width: numeric(b, 'width'), height: numeric(b, 'height') };
    }
  };
  for (const shape of get(NS.bpmndi, 'BPMNShape')) {
    const id = shape.getAttribute('bpmnElement')?.slice(2) ?? '';
    if (!nodes.some(n => n.nodeId === id) || layout.nodes[id] || shape.getAttribute('bpmnElement') !== `n_${id}`) fail();
    const bounds = Array.from(shape.children).filter(c => c.namespaceURI === NS.dc && c.localName === 'Bounds');
    if (bounds.length !== 1) fail();
    readLabel(shape, `n_${id}`);
    const b = bounds[0];
    layout.nodes[id] = { x: numeric(b, 'x'), y: numeric(b, 'y'), width: numeric(b, 'width'), height: numeric(b, 'height') };
  }
  for (const line of get(NS.bpmndi, 'BPMNEdge')) {
    const id = line.getAttribute('bpmnElement')?.slice(2) ?? '';
    if (!edges.some(e => e.edgeId === id) || layout.edges[id] || line.getAttribute('bpmnElement') !== `e_${id}`) fail();
    readLabel(line, `e_${id}`);
    layout.edges[id] = Array.from(line.children).filter(c => c.namespaceURI === NS.di && c.localName === 'waypoint').map(p => ({ x: numeric(p, 'x'), y: numeric(p, 'y') }));
  }
  if (Object.keys(layout.nodes).length !== nodes.length || Object.keys(layout.edges).length !== edges.length || !validLayout(layout)) fail('SCHEMA_INVALID');
  // All model references must resolve within this process, including auxiliary incoming/outgoing refs.
  for (const el of [...get(NS.bpmn, 'incoming'), ...get(NS.bpmn, 'outgoing')]) {
    const edge = edges.find(e => `e_${e.edgeId}` === el.textContent?.trim());
    if (!edge || el.parentElement?.id !== `n_${el.localName === 'incoming' ? edge.target : edge.source}`) fail('UNSAFE_REFERENCE');
  }
  if (edges.some(e => !nodes.some(n => n.nodeId === e.source) || !nodes.some(n => n.nodeId === e.target))) fail('UNSAFE_REFERENCE');
  return { content, layout };
}
function numeric(el: Element, attr: string): number {
  const text = el.getAttribute(attr);
  if (!text || !/^-?\d+(?:\.\d+)?$/.test(text)) return fail('SCHEMA_INVALID');
  return Number(text);
}
