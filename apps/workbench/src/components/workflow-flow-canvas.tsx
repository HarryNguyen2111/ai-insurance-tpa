'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  Background, BackgroundVariant, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Connection, type Edge, type EdgeChangeset, type Node, type NodeChangeset, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { NODE_TYPES, type EditorDocument, type NodeType, type Point } from '@/lib/workflow-definition';
import { connectionProblem, toFlow, type FlowNodeData, type IssueCounts } from '@/lib/workflow-graph';
import { NODE_DRAG_TYPE, NODE_ICONS } from './workflow-flow-canvas-icons';
import styles from './workflow-designer.module.css';

// Upstream React Flow (@xyflow/react, MIT) renders and handles pan/zoom/select/connect. It owns no business state:
// every committed change is reported to the designer, which applies it to the canonical document.

export interface CanvasApi { center(nodeId: string): void; fit(): void }
interface Props {
  document: EditorDocument; selected: string; readOnly: boolean; counts: IssueCounts;
  onSelect(id: string): void;
  onMove(positions: Record<string, Point>): void;
  onConnect(source: string, target: string): void;
  onDelete(nodeIds: string[], edgeIds: string[]): void;
  onDropType(type: NodeType, position: Point): void;
  onReady(api: CanvasApi | null): void;
}
type FlowNode = Node<FlowNodeData, 'workflow'>;

const WorkflowNodeCard = memo(function WorkflowNodeCard({ data, selected }: NodeProps<FlowNode>) {
  const Icon = NODE_ICONS[data.node.type];
  return <div className={styles.card} data-type={data.node.type} data-selected={selected || undefined} data-invalid={data.issues > 0 || undefined}>
    {data.node.type !== 'START' && <Handle type="target" position={Position.Left} className={styles.handle} aria-label="Điểm nối vào" />}
    <div className={styles.cardHead}>
      <span className={styles.cardIcon} aria-hidden="true"><Icon size={15} /></span>
      <span className={styles.cardKind}>{data.kind}</span>
      {data.issues > 0 && <span className={styles.cardBadge} title={`${data.issues} vấn đề cần sửa`}>{data.issues}</span>}
    </div>
    <div className={styles.cardTitle}>{data.title}</div>
    {data.lines.map(line => <div key={line} className={styles.cardLine}>{line}</div>)}
    {data.node.type !== 'END' && <Handle type="source" position={Position.Right} className={styles.handle} aria-label="Điểm nối ra" />}
  </div>;
});
const nodeTypes = { workflow: WorkflowNodeCard };

function Flow(props: Props) {
  const flow = useReactFlow<FlowNode, Edge>();
  const latest = useRef(props);
  latest.current = props;
  const projected = useMemo(() => toFlow(props.document, props.selected, props.readOnly, props.counts), [props.document, props.selected, props.readOnly, props.counts]);
  const [nodes, setNodes] = useState<FlowNode[]>(projected.nodes as FlowNode[]);
  const [edges, setEdges] = useState<Edge[]>(projected.edges as Edge[]);
  // Re-project on every document change but keep upstream's measured dimensions so nothing flickers.
  useEffect(() => {
    setNodes(prev => projected.nodes.map(n => { const old = prev.find(p => p.id === n.id); return { ...n, ...(old?.measured ? { measured: old.measured } : {}) } as FlowNode; }));
    setEdges(projected.edges as Edge[]);
  }, [projected]);
  useEffect(() => {
    props.onReady({
      center: id => {
        const n = flow.getNode(id);
        if (!n) return;
        void flow.setCenter(n.position.x + (n.measured?.width ?? 200) / 2, n.position.y + (n.measured?.height ?? 80) / 2, { zoom: Math.max(flow.getZoom(), 0.9), duration: 200 });
      },
      fit: () => { void flow.fitView({ padding: 0.15, duration: 200 }); },
    });
    return () => latest.current.onReady(null);
  }, [flow]); // eslint-disable-line react-hooks/exhaustive-deps

  const onNodesChange = useCallback((changes: NodeChangeset<FlowNode>) => {
    setNodes(ns => changes.applyTo(ns));
    const moved: Record<string, Point> = {};
    for (const c of changes) if (c.type === 'position' && c.position && c.dragging !== true) moved[c.id] = c.position;
    if (Object.keys(moved).length && !latest.current.readOnly) latest.current.onMove(moved);
    // Keyboard selection (Enter/Space on a focused card) must drive the inspector just like a click.
    const picked = [...changes].find(c => c.type === 'select' && c.selected);
    if (picked) latest.current.onSelect(`n_${picked.id}`);
  }, []);
  const onEdgesChange = useCallback((changes: EdgeChangeset<Edge>) => {
    setEdges(es => changes.applyTo(es));
    const picked = [...changes].find(c => c.type === 'select' && c.selected);
    if (picked) latest.current.onSelect(`e_${picked.id}`);
  }, []);
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const type = event.dataTransfer.getData(NODE_DRAG_TYPE) as NodeType;
    if (props.readOnly || !NODE_TYPES.includes(type)) return;
    props.onDropType(type, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  };
  const locked = props.readOnly;
  return <ReactFlow<FlowNode, Edge>
    nodes={nodes} edges={edges} nodeTypes={nodeTypes}
    onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
    onConnect={(c: Connection) => { if (c.source && c.target) props.onConnect(c.source, c.target); }}
    isValidConnection={c => !locked && connectionProblem(latest.current.document, c.source, c.target) === null}
    onDelete={({ nodes: n, edges: e }) => { if (!locked) props.onDelete(n.map(x => x.id), e.map(x => x.id)); }}
    onNodeClick={(_, n) => props.onSelect(`n_${n.id}`)}
    onEdgeClick={(_, e) => props.onSelect(`e_${e.id}`)}
    onPaneClick={() => props.onSelect('')}
    onDragOver={event => { if (!locked) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
    onDrop={onDrop}
    nodesDraggable={!locked} nodesConnectable={!locked} edgesReconnectable={false} elementsSelectable
    deleteKeyCode={locked ? null : ['Backspace', 'Delete']} multiSelectionKeyCode={null} selectionKeyCode={null}
    fitView fitViewOptions={{ padding: 0.1, maxZoom: 1, minZoom: 0.62 }} minZoom={0.2} maxZoom={2}
    defaultEdgeOptions={{ type: 'smoothstep' }}
    ariaLabelConfig={{
      'node.a11yDescription.default': 'Nhấn Enter hoặc Space để chọn bước. Nhấn Delete để xóa, phím mũi tên để di chuyển.',
      'node.a11yDescription.keyboardDisabled': 'Nhấn Enter hoặc Space để chọn bước.',
      'edge.a11yDescription.default': 'Nhấn Enter hoặc Space để chọn nhánh. Nhấn Delete để xóa.',
      'controls.ariaLabel': 'Điều khiển sơ đồ', 'controls.zoomIn.ariaLabel': 'Phóng to', 'controls.zoomOut.ariaLabel': 'Thu nhỏ',
      'controls.fitView.ariaLabel': 'Vừa khung nhìn', 'controls.interactive.ariaLabel': 'Khóa/mở tương tác', 'minimap.ariaLabel': 'Bản đồ thu nhỏ',
    }}
  >
    <Background variant={BackgroundVariant.Dots} gap={18} size={1.4} />
    <Controls showInteractive={false} />
    <MiniMap pannable zoomable nodeStrokeWidth={3} className={styles.minimap} style={{ width: 150, height: 96 }} />
  </ReactFlow>;
}

export default function WorkflowFlowCanvas(props: Props) {
  return <div className={styles.canvas} role="region" aria-label="Sơ đồ quy trình" data-testid="workflow-canvas">
    <ReactFlowProvider><Flow {...props} /></ReactFlowProvider>
  </div>;
}
