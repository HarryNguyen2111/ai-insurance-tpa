'use client';

import { forwardRef, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Download, FileUp, Info } from 'lucide-react';
import { byteLength, canonicalJson, MAX_CONTENT_BYTES, NODE_LABELS, type EditorDocument } from '@/lib/workflow-definition';
import { structuralPaths } from '@/lib/workflow-graph';
import { issueKey, type BuilderIssue } from '@/lib/workflow-inspector';
import { CANDIDATE_ROLE_LABELS, duration, OWNER_LABELS } from '@/lib/workflow-labels';
import styles from './workflow-designer.module.css';

export type DrawerTab = 'issues' | 'preview' | 'advanced';
export interface ServerResult { valid: boolean; revision: number; issues: BuilderIssue[]; publishText: string }

function IssueList({ issues, doc, onIssue }: { issues: BuilderIssue[]; doc: EditorDocument; onIssue(i: BuilderIssue): void }) {
  const name = (i: BuilderIssue) => i.nodeId ? doc.content.nodes.find(n => n.nodeId === i.nodeId)?.label ?? i.nodeId
    : i.edgeId ? `Nhánh ${i.edgeId}` : 'Thiết lập quy trình';
  return <ul className={styles.issues}>{issues.map((i, n) => <li key={`${issueKey(i)}-${i.field}-${i.code}-${n}`}>
    <button type="button" onClick={() => onIssue(i)} data-severity={i.severity}>
      <AlertCircle size={14} aria-hidden="true" />
      <span><strong>{name(i)}</strong>{i.field ? <span className={styles.issueField}> · {i.field}</span> : null} — {i.message}</span>
      <code>{i.code}</code>
    </button>
  </li>)}</ul>;
}

interface Props {
  doc: EditorDocument; tab: DrawerTab; open: boolean; setTab(t: DrawerTab): void; setOpen(v: boolean): void;
  issues: BuilderIssue[]; checked: boolean; server: ServerResult | null; serverNote: string; onIssue(i: BuilderIssue): void;
  advanced: ReactNode; serverRef: React.Ref<HTMLDivElement>;
}
/** Bottom drawer: live validation keyed to node+field, structural path preview, and the advanced interchange tools. */
export const WorkflowDrawer = forwardRef<HTMLDivElement, Props>(function WorkflowDrawer({ doc, tab, open, setTab, setOpen, issues, checked, server, serverNote, onIssue, advanced, serverRef }, ref) {
  const errors = issues.filter(i => i.severity === 'error').length;
  const tabs: [DrawerTab, string][] = [['issues', `Kiểm tra${issues.length ? ` (${issues.length})` : ''}`], ['preview', 'Xem trước'], ['advanced', 'Nâng cao · JSON/BPMN']];
  return <section className={styles.drawer} data-open={open || undefined} aria-label="Bảng kiểm tra và công cụ">
    <div className={styles.drawerTabs} role="tablist" aria-label="Bảng dưới">
      {tabs.map(([id, label]) => <button key={id} type="button" role="tab" id={`wf-tab-${id}`} aria-selected={open && tab === id} aria-controls={`wf-panel-${id}`}
        data-count={id === 'issues' && errors ? errors : undefined} onClick={() => { setTab(id); setOpen(!(open && tab === id)); }}>{label}</button>)}
      <button type="button" className={styles.iconButton} aria-label={open ? 'Thu gọn bảng dưới' : 'Mở bảng dưới'} onClick={() => setOpen(!open)}>{open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}</button>
    </div>
    {open && tab === 'issues' && <div id="wf-panel-issues" role="tabpanel" aria-labelledby="wf-tab-issues" className={styles.drawerBody}>
      <div ref={ref} tabIndex={-1} role="region" aria-label="Kết quả kiểm tra" className={styles.result}>
        <h3>{!checked ? (issues.length ? `${issues.length} vấn đề đang mở (cập nhật khi bạn sửa)` : 'Chưa kiểm tra. Bấm “Kiểm tra” để xem kết quả.')
          : issues.length ? `${issues.length} lỗi cục bộ` : <><CheckCircle2 size={15} aria-hidden="true" /> Cấu trúc và đồ thị cục bộ hợp lệ</>}</h3>
        {issues.length > 0 && <IssueList issues={issues} doc={doc} onIssue={onIssue} />}
        <p className={styles.hint}><Info size={13} aria-hidden="true" /> Kiểm tra trên trình duyệt không xét phiên bản đã ghim, binding tổ chức, quyền, MFA hay maker-checker. Không đủ điều kiện xuất bản; dùng kiểm tra trên máy chủ.</p>
      </div>
      {serverNote && <p className={styles.hint} role="note">{serverNote}</p>}
      {server && <div ref={serverRef} tabIndex={-1} role="region" aria-label="Kết quả kiểm tra máy chủ" className={styles.result}>
        <h3>{server.valid ? `Máy chủ: hợp lệ (revision ${server.revision})` : `Máy chủ: ${server.issues.length} lỗi (revision ${server.revision})`}</h3>
        {server.issues.length > 0 && <IssueList issues={server.issues} doc={doc} onIssue={onIssue} />}
        <p>{server.publishText}</p>
      </div>}
    </div>}
    {open && tab === 'preview' && <div id="wf-panel-preview" role="tabpanel" aria-labelledby="wf-tab-preview" className={styles.drawerBody}><Preview doc={doc} /></div>}
    {open && tab === 'advanced' && <div id="wf-panel-advanced" role="tabpanel" aria-labelledby="wf-tab-advanced" className={styles.drawerBody}>{advanced}</div>}
  </section>;
});

function Preview({ doc }: { doc: EditorDocument }) {
  const { paths, truncated } = structuralPaths(doc);
  return <>
    <p role="note" className={styles.notice}><strong>Xem trước cấu trúc.</strong> Chỉ đọc sơ đồ để liệt kê các đường đi; không chạy Temporal, không gọi AI, không tạo hồ sơ, không lưu và không chi trả.</p>
    <ol className={styles.paths} aria-label="Các đường đi">{paths.map((p, i) => <li key={i}>{p.map((s, j) => <span key={j}>{s.via !== undefined && <em>{s.via ? ` —${s.via}→ ` : ' → '}</em>}{s.label}{s.loop && <small> (↺ {s.loop})</small>}</span>)}</li>)}</ol>
    {truncated && <p className={styles.hint}>Chỉ hiển thị 20 đường đi đầu tiên.</p>}
    <table className={styles.table} aria-label="Xem trước quy trình" data-testid="workflow-summary">
      <thead><tr><th>Bước</th><th>Loại</th><th>Người chịu trách nhiệm</th><th>Ứng viên</th><th>SLA / thời hạn</th><th>Hành động</th><th>Bằng chứng</th></tr></thead>
      <tbody>{doc.content.nodes.map(n => {
        const r = n.type === 'HUMAN_TASK' ? doc.content.assignmentPolicy.rules.find(x => x.ruleKey === n.assignmentRuleKey) : undefined;
        const due = n.type === 'HUMAN_TASK' ? `${n.sla.dueSeconds}s (${duration(n.sla.dueSeconds)}) → ${n.sla.escalateTo}` : n.type === 'SUPPLEMENT_WAIT' ? `${n.maxWaitSeconds}s (${duration(n.maxWaitSeconds)})`
          : n.type === 'TIMER' ? `${n.delaySeconds}s (${duration(n.delaySeconds)})` : n.type === 'AI_ACTIVITY' ? `${n.timeoutSeconds}s` : n.type === 'END' ? n.outcome : '—';
        return <tr key={n.nodeId}><td>{n.label} · <code>{n.nodeId}</code></td><td>{NODE_LABELS[n.type]}</td>
          <td>{'accountableOwner' in n ? `${OWNER_LABELS[n.accountableOwner]} (${n.accountableOwner})` : '—'}</td>
          <td>{r ? `${r.candidateRoles.map(c => `${CANDIDATE_ROLE_LABELS[c]} (${c})`).join(', ')} · ${r.strategy}` : n.type === 'AI_ACTIVITY' ? `Tác nhân AI: ${n.serviceActorScopeKey}` : '—'}</td><td>{due}</td>
          <td>{'allowedActionIds' in n ? n.allowedActionIds.join(', ') || '—' : '—'}</td>
          <td>{'allowedEvidence' in n ? [...n.allowedEvidence.documentTypes, ...n.allowedEvidence.sources].join(', ') || '—' : '—'}</td></tr>;
      })}</tbody>
    </table>
  </>;
}

/** Advanced: canonical JSON/BPMN interchange and diagnostics. Not needed for normal editing. */
export function AdvancedTools({ doc, disabled, busy, onImport, onExportJson, onExportBpmn, layoutNote }: {
  doc: EditorDocument; disabled: boolean; busy: boolean; layoutNote: string;
  onImport(file: File | undefined, input: HTMLInputElement): void; onExportJson(): void; onExportBpmn(): void;
}) {
  const [show, setShow] = useState(false);
  const bytes = byteLength(canonicalJson(doc.content));
  return <div className={styles.advanced}>
    <p className={styles.hint}>Định dạng trao đổi cho người kỹ thuật. Tệp nhập được kiểm tra theo hợp đồng trước khi thay bản nháp; phần tử không hỗ trợ bị từ chối, không bỏ qua âm thầm. BPMN chỉ là định dạng trao đổi; máy chủ không chạy BPMN.</p>
    <div className={styles.inlineRow}>
      <label className={styles.fileButton}><FileUp size={14} aria-hidden="true" />Nhập JSON / BPMN<input type="file" accept=".json,.bpmn,.xml" disabled={disabled} onChange={e => onImport(e.target.files?.[0], e.target)} /></label>
      <button type="button" className={styles.secondaryButton} disabled={busy} onClick={onExportJson}><Download size={14} />Xuất JSON</button>
      <button type="button" className={styles.secondaryButton} disabled={busy} onClick={onExportBpmn}><Download size={14} />Xuất BPMN</button>
      <button type="button" className={styles.secondaryButton} aria-expanded={show} onClick={() => setShow(v => !v)}>Xem JSON chuẩn</button>
    </div>
    <dl className={styles.facts}>
      <dt>Kích thước nội dung chuẩn</dt><dd>{bytes.toLocaleString('vi-VN')} / {MAX_CONTENT_BYTES.toLocaleString('vi-VN')} byte</dd>
      <dt>Số bước / nhánh</dt><dd>{doc.content.nodes.length} / 50 · {doc.content.edges.length} / 100</dd>
      <dt>Bố cục</dt><dd>{layoutNote}</dd>
      <dt>Trình vẽ</dt><dd>React Flow (<code>@xyflow/react</code> 13.0.3, giấy phép MIT, <a href="https://github.com/xyflow/xyflow/blob/main/LICENSE" target="_blank" rel="noreferrer">LICENSE</a>)</dd>
    </dl>
    {show && <pre data-testid="canonical-preview" className={styles.preview}>{canonicalJson(doc)}</pre>}
  </div>;
}
