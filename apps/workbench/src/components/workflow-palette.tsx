'use client';

import { useId, useState } from 'react';
import { Search } from 'lucide-react';
import { NODE_LABELS, type EditorDocument, type NodeType } from '@/lib/workflow-definition';
import { guardLabel, NODE_GROUPS, NODE_HELP } from '@/lib/workflow-labels';
import { NODE_DRAG_TYPE, NODE_ICONS } from './workflow-flow-canvas-icons';
import styles from './workflow-designer.module.css';

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
const match = (query: string, ...texts: string[]) => !query.trim() || texts.some(t => fold(t).includes(fold(query.trim())));

/** Left rail: library of the seven supported step types (click/Enter adds, drag drops) and a searchable outline. */
export function WorkflowPalette({ document, selected, disabled, onAdd, onSelect }: {
  document: EditorDocument; selected: string; disabled: boolean;
  onAdd(type: NodeType): void; onSelect(id: string): void;
}) {
  const [query, setQuery] = useState(''), [find, setFind] = useState('');
  const help = useId();
  const groups = NODE_GROUPS.map(g => ({ ...g, types: g.types.filter(t => match(query, NODE_LABELS[t], NODE_HELP[t], t)) })).filter(g => g.types.length);
  const nodes = document.content.nodes.filter(n => match(find, n.label, n.nodeId, NODE_LABELS[n.type]));
  const label = (id: string) => document.content.nodes.find(n => n.nodeId === id)?.label ?? id;
  const edges = document.content.edges.filter(e => match(find, guardLabel(e), e.edgeId, label(e.source), label(e.target)));
  return <aside className={styles.rail} aria-label="Thư viện bước và danh sách sơ đồ">
    <section aria-labelledby={`${help}-lib`}>
      <h2 id={`${help}-lib`} className={styles.railTitle}>Thư viện bước</h2>
      <label className={styles.search}><Search size={14} aria-hidden="true" /><span className="sr-only">Tìm loại bước</span>
        <input type="search" placeholder="Tìm loại bước…" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <p id={help} className={styles.hint}>Bấm, Enter hoặc kéo vào sơ đồ. Chỉ có các loại bước được hợp đồng hỗ trợ; không có mã, HTTP hay công cụ tùy ý.</p>
      {groups.map(g => <div key={g.title} role="group" aria-label={g.title} className={styles.group}>
        <h3>{g.title}</h3>
        {g.types.map(type => {
          const Icon = NODE_ICONS[type];
          return <button key={type} type="button" className={styles.paletteItem} data-type={type} aria-label={NODE_LABELS[type]} aria-describedby={`${help}-${type}`}
            disabled={disabled} draggable={!disabled} onDragStart={e => { e.dataTransfer.setData(NODE_DRAG_TYPE, type); e.dataTransfer.effectAllowed = 'move'; }}
            onClick={() => onAdd(type)}>
            <span className={styles.cardIcon} aria-hidden="true"><Icon size={15} /></span>
            <span><strong>{NODE_LABELS[type]}</strong><small id={`${help}-${type}`}>{NODE_HELP[type]}</small></span>
          </button>;
        })}
      </div>)}
      {!groups.length && <p className={styles.hint} role="status">Không có loại bước phù hợp. Các loại hỗ trợ: {Object.values(NODE_LABELS).join(', ')}.</p>}
    </section>
    <section aria-labelledby={`${help}-outline`} className={styles.outline}>
      <h2 id={`${help}-outline`} className={styles.railTitle}>Các bước trong sơ đồ</h2>
      <label className={styles.search}><Search size={14} aria-hidden="true" /><span className="sr-only">Tìm trong sơ đồ</span>
        <input type="search" placeholder="Tìm bước hoặc nhánh…" value={find} onChange={e => setFind(e.target.value)} /></label>
      <ul aria-label="Bước">{nodes.map(n => <li key={n.nodeId}><button type="button" aria-pressed={selected === `n_${n.nodeId}`} onClick={() => onSelect(`n_${n.nodeId}`)}>
        {n.label}<small> · {NODE_LABELS[n.type]} · {n.nodeId}</small></button></li>)}</ul>
      <ul aria-label="Nhánh">{edges.map(e => <li key={e.edgeId}><button type="button" aria-pressed={selected === `e_${e.edgeId}`} onClick={() => onSelect(`e_${e.edgeId}`)}>
        Nhánh {guardLabel(e) || 'tiếp theo'}<small> · {label(e.source)} → {label(e.target)} · {e.edgeId}</small></button></li>)}</ul>
    </section>
  </aside>;
}
