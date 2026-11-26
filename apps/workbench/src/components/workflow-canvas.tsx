'use client';

import { useEffect, useRef } from 'react';
import type Modeler from 'bpmn-js/lib/Modeler';
import { NODE_TYPES, type EditorDocument, type NodeType } from '@/lib/workflow-definition';
import { addNode, captureDocument, connectNodes, createModeler, dropPosition, moveNode, removeElement, type DiagramElement } from '@/lib/workflow-modeler';
import { toBpmnXml } from '@/lib/workflow-bpmn';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';
import styles from './workflow-designer.module.css';

export interface CanvasApi {
  add(type: NodeType): string;
  connect(source: string, target: string): void;
  move(id: string, dx: number, dy: number): void;
  remove(id: string, edge?: boolean): void;
  undo(): void; redo(): void;
}
interface Props {
  document: EditorDocument; readOnly: boolean;
  onChange(document: EditorDocument): void;
  onSelect(id: string): void;
  onReady(api: CanvasApi | null): void;
  onError(code: string): void;
}

export default function WorkflowCanvas(props: Props) {
  const host = useRef<HTMLDivElement>(null), modeler = useRef<Modeler | null>(null), latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const instance = await createModeler(host.current!);
      if (cancelled) { instance.destroy(); return; }
      modeler.current = instance;
      const result = await instance.importXML(toBpmnXml(latest.current.document));
      if (cancelled) return;
      if (result.warnings.length) throw new Error('BPMN_IMPORT_WARNING');
      instance.get<{ zoom(value: string): void }>('canvas').zoom('fit-viewport');
      latest.current.onChange(captureDocument(instance, latest.current.document));
      instance.on('commandStack.changed', () => {
        try { latest.current.onChange(captureDocument(instance, latest.current.document)); }
        catch { latest.current.onError('UNSUPPORTED_BPMN_ELEMENT'); }
      });
      instance.on('element.click', (event: { element: DiagramElement }) => {
        const id = event.element.id;
        if (id.startsWith('n_') || id.startsWith('e_')) latest.current.onSelect(id);
      });
      // Labels and properties are edited through the schema-checked properties panel only.
      instance.on('element.dblclick', 2000, () => false);
      instance.get<{ on(name: string, priority: number, callback: () => false | undefined): void }>('eventBus').on('commandStack.canExecute', 3000, () => latest.current.readOnly ? false : undefined);
      latest.current.onReady({
        add: type => addNode(instance, type, latest.current.document),
        connect: (s, t) => connectNodes(instance, s, t, latest.current.document),
        move: (id, x, y) => moveNode(instance, id, x, y), remove: (id, edge) => removeElement(instance, id, edge),
        undo: () => instance.get<{ undo(): void }>('commandStack').undo(), redo: () => instance.get<{ redo(): void }>('commandStack').redo(),
      });
    })().catch(() => { if (!cancelled) latest.current.onError('BPMN_IMPORT_FAILED'); });
    return () => { cancelled = true; latest.current.onReady(null); modeler.current?.destroy(); modeler.current = null; };
  }, []);
  return <div className={styles.canvas} ref={host} role="region" aria-label="Sơ đồ quy trình" data-testid="workflow-canvas"
    onDragOver={event => { if (!props.readOnly) event.preventDefault(); }}
    onDrop={event => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/x-tpa-node') as NodeType;
      if (!props.readOnly && NODE_TYPES.includes(type) && modeler.current && host.current) {
        try { props.onSelect(`n_${addNode(modeler.current, type, props.document, dropPosition(modeler.current, host.current, { x: event.clientX, y: event.clientY }))}`); }
        catch { props.onError('NODE_CREATE_FAILED'); }
      }
    }} />;
}
