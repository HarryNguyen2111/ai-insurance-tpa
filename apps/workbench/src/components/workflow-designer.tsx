'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import { useWorkspaces } from '@/components/workspace-provider';
import { Button } from '@/components/ui/button';
import { AI_ACTIONS, HUMAN_ACTIONS, NODE_LABELS, NODE_TYPES, canonicalJson, isAssignmentPolicy, isWorkflowNode, isWorkflowEdge, newDocument, validateLocal as validateLocalWorkflow, type EditorDocument, type WorkflowIssue, type WorkflowNode } from '@/lib/workflow-definition';
import { DRAFT_KEY, DraftConflict, MAX_DRAFT_BYTES, parseDocument, readDraft, saveDraft } from '@/lib/workflow-draft';
import { MAX_XML_BYTES, fromBpmnXml, toBpmnXml } from '@/lib/workflow-bpmn';
import type { CanvasApi } from './workflow-canvas';
import styles from './workflow-designer.module.css';

const BPMN_LICENSE = "Copyright (c) 2014-present Camunda Services GmbH\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of\nthis software and associated documentation files (the \"Software\"), to deal in the\nSoftware without restriction, including without limitation the rights to use, copy,\nmodify, merge, publish, distribute, sublicense, and/or sell copies of the Software,\nand to permit persons to whom the Software is furnished to do so, subject to the\nfollowing conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nThe source code responsible for displaying the bpmn.io project watermark that\nlinks back to https://bpmn.io as part of rendered diagrams MUST NOT be\nremoved or changed. When this software is being used in a website or application,\nthe watermark must stay fully visible and not visually overlapped by other elements.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,\nINCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR\nPURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE\nLIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,\nTORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE\nOR OTHER DEALINGS IN THE SOFTWARE.\n";

const Canvas = dynamic(() => import('./workflow-canvas'), { ssr: false, loading: () => <p role="status">Đang tải trình vẽ…</p> });

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type })), link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function WorkflowDesigner() {
  const { loaded, active } = useWorkspaces();
  if (!loaded) return <p role="status">Đang tải bản nháp cục bộ…</p>;
  const scope = `${DRAFT_KEY}.${active?.id ?? 'sandbox'}`;
  return <LocalEditor key={scope} scope={scope} />;
}

function LocalEditor({ scope }: { scope: string }) {
  const [doc, setDoc] = useState<EditorDocument>(newDocument);
  const [revision, setRevision] = useState(0), [opened, setOpened] = useState(false), [epoch, setEpoch] = useState(0);
  const [api, setApi] = useState<CanvasApi | null>(null), [selected, setSelected] = useState('n_start');
  const [propertyText, setPropertyText] = useState(''), [policyText, setPolicyText] = useState('');
  const [issues, setIssues] = useState<WorkflowIssue[] | null>(null), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [readOnly, setReadOnly] = useState(false), [source, setSource] = useState('start'), [target, setTarget] = useState('end');
  const [preview, setPreview] = useState(false), [busy, setBusy] = useState(false);
  const errorsRef = useRef<HTMLDivElement>(null), alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    try { const saved = readDraft(localStorage, scope); if (saved) { setDoc({ content: saved.content, layout: saved.layout }); setRevision(saved.revision); } }
    catch { setError('Không thể đọc bản nháp cục bộ. Dữ liệu không được hiển thị; bản đã lưu vẫn được giữ nguyên.'); }
    return () => { alive.current = false; };
  }, [scope]);
  const node = selected.startsWith('n_') ? doc.content.nodes.find(n => n.nodeId === selected.slice(2)) : undefined;
  const edge = selected.startsWith('e_') ? doc.content.edges.find(e => e.edgeId === selected.slice(2)) : undefined;
  useEffect(() => { setPropertyText(JSON.stringify(node ?? edge ?? {}, null, 2)); }, [selected, node, edge]);
  useEffect(() => { setPolicyText(JSON.stringify(doc.content.assignmentPolicy, null, 2)); }, [doc.content.assignmentPolicy]);

  function changed(next: EditorDocument) { setDoc(next); setIssues(null); setMessage('Có chỉnh sửa chưa lưu.'); }
  function replace(next: EditorDocument) { changed(next); setEpoch(v => v + 1); setSelected(next.content.nodes[0] ? `n_${next.content.nodes[0].nodeId}` : ''); }
  function run(action: () => void) { setError(''); try { action(); } catch { setError('Thao tác không hợp lệ; bản nháp hiện tại được giữ nguyên.'); } }
  function validateLocal() { const result = validateLocalWorkflow(doc.content); setIssues(result); if (result.length) setTimeout(() => errorsRef.current?.focus(), 0); }
  function changeProperty(key: string, value: unknown) { run(() => { const n = JSON.parse(propertyText) as Record<string, unknown>; n[key] = value; setPropertyText(JSON.stringify(n, null, 2)); }); }
  let formNode: WorkflowNode | undefined;
  try {
    const value: unknown = JSON.parse(propertyText);
    if (value && typeof value === 'object' && !Array.isArray(value)) formNode = value as WorkflowNode;
  } catch { /* Raw JSON errors are reported when applying. */ }
  function applyProperties() {
    setError('');
    try {
      const value: unknown = JSON.parse(propertyText);
      if (node) {
        if (!isWorkflowNode(value) || value.nodeId !== node.nodeId || value.type !== node.type) throw new Error();
        changed({ ...doc, content: { ...doc.content, nodes: doc.content.nodes.map(n => n.nodeId === node.nodeId ? value : n) } });
      } else if (edge) {
        const candidate = { ...doc.content, edges: doc.content.edges.map(e => e.edgeId === edge.edgeId ? value : e) };
        // Edge schema can be checked independently even while other new nodes are incomplete.
        if (!isWorkflowEdge(value) || value.edgeId !== edge.edgeId || !doc.content.nodes.some(n => n.nodeId === value.source) || !doc.content.nodes.some(n => n.nodeId === value.target)) throw new Error();
        changed({ ...doc, content: candidate as EditorDocument['content'] });
      }
      setEpoch(v => v + 1); setMessage('Đã áp dụng thuộc tính vào bản nháp chưa lưu.');
    } catch { setError('SCHEMA_INVALID · thuộc tính: kiểm tra JSON, trường bắt buộc và giới hạn. Mã và loại phần tử không được đổi.'); }
  }
  async function importFile(file: File | undefined, input: HTMLInputElement) {
    if (!file || busy || readOnly) return;
    setBusy(true); setError('');
    try {
      const xml = file.name.toLowerCase().endsWith('.bpmn') || file.name.toLowerCase().endsWith('.xml');
      if (file.size > (xml ? MAX_XML_BYTES : MAX_DRAFT_BYTES)) throw new Error('LIMIT_EXCEEDED');
      const raw = await file.text();
      const next = xml ? fromBpmnXml(raw) : parseDocument(raw);
      if (alive.current) { replace(next); setMessage('Đã nhập vào bản nháp chưa lưu.'); }
    } catch (cause) {
      if (alive.current) setError(`Không nhập tệp: ${cause instanceof Error && /^[A-Z_]+$/.test(cause.message) ? cause.message : 'SCHEMA_INVALID'}. Bản nháp không đổi.`);
    } finally { if (alive.current) setBusy(false); input.value = ''; }
  }
  return <section className={styles.editor} aria-labelledby="workflow-title">
    <header className={styles.header}><div><p className={styles.eyebrow}>THIẾT KẾ QUY TRÌNH · VWF-02a</p><h1 id="workflow-title">Trình thiết kế quy trình</h1></div><span className={styles.chip}>Bản nháp · cục bộ v{revision}</span></header>
    <div role="note" className={styles.notice}><strong>Chỉ lưu trên trình duyệt này.</strong> Dùng cấu hình mẫu, không nhập thông tin cá nhân. Chưa kết nối lưu trữ, danh tính hay phân quyền máy chủ. Xuất bản chờ #80 và #21; kiểm tra cục bộ không cấp quyền.</div>
    {!opened ? <div className={styles.empty}><h2>Thiết kế luồng xử lý có giới hạn</h2><p>7 loại bước; AI chỉ đề xuất, người phụ trách luôn là con người. Nhánh song song và mã thực thi không được hỗ trợ.</p><Button onClick={() => setOpened(true)}>Mở trình vẽ</Button><p className={styles.hint}>bpmn-js chỉ tải khi mở trình vẽ.</p></div> : <>
      <div className={styles.toolbar}>
        <Button variant="outline" disabled={readOnly || busy || !api} onClick={() => {
          setError(''); try { const saved = saveDraft(localStorage, scope, doc, revision); setRevision(saved.revision); setMessage('Đã lưu bản nháp cục bộ.'); }
          catch (cause) { setError(cause instanceof DraftConflict ? cause.message : 'Không lưu được. Kiểm tra trường bắt buộc, dữ liệu đã lưu và dung lượng trình duyệt. Chỉnh sửa vẫn được giữ nguyên.'); }
        }}>Lưu cục bộ</Button>
        <Button variant="outline" disabled={busy} onClick={() => run(() => { const saved = readDraft(localStorage, scope); if (!saved) throw new Error(); replace(saved); setRevision(saved.revision); setMessage('Đã tải bản đã lưu; chưa gọi máy chủ.'); })}>Tải bản đã lưu</Button>
        <Button variant="outline" disabled={busy} onClick={validateLocal}>Kiểm tra cục bộ</Button>
        <Button variant="outline" onClick={() => setPreview(v => !v)}>Xem JSON chuẩn</Button>
        <Button disabled title="Chờ API và phân quyền máy chủ (#80, #21)">Xuất bản (chưa kết nối)</Button>
        <label className={styles.inline}><input type="checkbox" checked={readOnly} onChange={e => setReadOnly(e.target.checked)} />Chỉ xem cục bộ</label>
      </div>
      <div className={styles.fields}>
        <label>Mã workflow<input disabled={readOnly || busy} value={doc.content.workflowKey} onChange={e => changed({ ...doc, content: { ...doc.content, workflowKey: e.target.value } })} /></label>
        <label>Tên workflow<input disabled={readOnly || busy} value={doc.content.title} onChange={e => changed({ ...doc, content: { ...doc.content, title: e.target.value } })} /></label>
      </div>
      <div className={styles.toolbox} aria-label="Các bước được phép">{NODE_TYPES.map(type => <button key={type} type="button" draggable={!readOnly && !!api} disabled={readOnly || busy || !api}
        onDragStart={event => event.dataTransfer.setData('application/x-tpa-node', type)}
        onClick={() => run(() => { if (api) setSelected(`n_${api.add(type)}`); })}>{NODE_LABELS[type]}</button>)}</div>
      <p className={styles.hint}>Bấm hoặc kéo bước vào sơ đồ. Dùng danh sách chọn và nút di chuyển/kết nối nếu không dùng chuột. Bước mới cần cấu hình; không có mặc định SLA hay chính sách AI.</p>
      <div className={styles.workspace}>
        <div><Canvas key={epoch} document={doc} readOnly={readOnly || busy} onChange={next => { setDoc(next); setIssues(null); }} onSelect={setSelected} onReady={setApi} onError={setError} />
          <div className={styles.connections}>
            <label>Từ bước<select value={source} disabled={readOnly || busy} onChange={e => setSource(e.target.value)}>{doc.content.nodes.map(n => <option key={n.nodeId} value={n.nodeId}>{n.label} · {n.nodeId}</option>)}</select></label>
            <label>Đến bước<select value={target} disabled={readOnly || busy} onChange={e => setTarget(e.target.value)}>{doc.content.nodes.map(n => <option key={n.nodeId} value={n.nodeId}>{n.label} · {n.nodeId}</option>)}</select></label>
            <Button variant="outline" disabled={readOnly || busy || !api} onClick={() => run(() => api?.connect(source, target))}>Kết nối</Button>
          </div>
        </div>
        <aside className={styles.panel} aria-label="Thuộc tính phần tử">
          <h2>Thuộc tính</h2><label>Chọn phần tử<select value={selected} onChange={e => setSelected(e.target.value)}>
            {doc.content.nodes.map(n => <option key={`n_${n.nodeId}`} value={`n_${n.nodeId}`}>{NODE_LABELS[n.type]} · {n.nodeId}</option>)}
            {doc.content.edges.map(e => <option key={`e_${e.edgeId}`} value={`e_${e.edgeId}`}>Cạnh · {e.edgeId}</option>)}
          </select></label>
          <fieldset disabled={readOnly || busy || !api} className={styles.properties}>
            {node && <><label>Nhãn bước<input value={formNode?.label ?? ''} onChange={e => changeProperty('label', e.target.value)} /></label>
              {'accountableOwner' in node && <label>Người chịu trách nhiệm<select value={formNode && 'accountableOwner' in formNode ? formNode.accountableOwner : ''} onChange={e => changeProperty('accountableOwner', e.target.value)}><option value="">Chọn người chịu trách nhiệm</option><option value="CASE_OWNER">CASE_OWNER · người phụ trách hồ sơ</option></select></label>}
              {node.type === 'HUMAN_TASK' && <>
                <label>Quy tắc phân công<select value={formNode?.type === 'HUMAN_TASK' ? formNode.assignmentRuleKey : ''} onChange={e => changeProperty('assignmentRuleKey', e.target.value)}>{doc.content.assignmentPolicy.rules.map(r => <option key={r.ruleKey} value={r.ruleKey}>{r.ruleKey} · {r.candidateRoles.join(', ')}</option>)}</select></label>
                <label>SLA (giây)<input type="number" min={3600} max={1209600} value={formNode?.type === 'HUMAN_TASK' ? formNode.sla?.dueSeconds ?? '' : ''} onChange={e => changeProperty('sla', { ...(formNode?.type === 'HUMAN_TASK' ? formNode.sla : {}), dueSeconds: Number(e.target.value) })} /></label>
              </>}
              {(node.type === 'HUMAN_TASK' || node.type === 'AI_ACTIVITY') && <fieldset><legend>Hành động được phép</legend>{(node.type === 'HUMAN_TASK' ? HUMAN_ACTIONS : AI_ACTIONS).map(action => {
                const actions: string[] = formNode && 'allowedActionIds' in formNode && Array.isArray(formNode.allowedActionIds) ? formNode.allowedActionIds : [];
                return <label className={styles.inline} key={action}><input type="checkbox" checked={actions.includes(action)} onChange={e => changeProperty('allowedActionIds', e.target.checked ? [...actions, action] : actions.filter(a => a !== action))} />{action}</label>;
              })}</fieldset>}
              {'allowedEvidence' in node && <fieldset><legend>Phạm vi bằng chứng</legend>{([
                ['documentTypes', ['INVOICE_PHOTO', 'ITEMIZED_LIST', 'PRESCRIPTION', 'LAB_ORDER', 'LAB_RESULT', 'DISCHARGE_PAPER', 'VNEID_HISTORY']],
                ['sources', ['XML', 'OCR', 'VLM', 'QR', 'IMAGE_ANALYSIS']],
              ] as const).map(([field, values]) => <div key={field}>{values.map(value => {
                const evidence = formNode && 'allowedEvidence' in formNode && formNode.allowedEvidence && typeof formNode.allowedEvidence === 'object' ? formNode.allowedEvidence : { documentTypes: [], sources: [] };
                const current: string[] = Array.isArray(evidence[field]) ? evidence[field] : [];
                return <label className={styles.inline} key={value}><input type="checkbox" checked={current.includes(value)} onChange={e => changeProperty('allowedEvidence', { ...evidence, [field]: e.target.checked ? [...current, value] : current.filter(v => v !== value) })} />{value}</label>;
              })}</div>)}</fieldset>}
            </>}
            <label>{edge ? 'Cạnh và điều kiện (JSON)' : 'Toàn bộ thuộc tính bước (JSON)'}<textarea data-testid="workflow-properties" rows={10} value={propertyText} onChange={e => setPropertyText(e.target.value)} spellCheck={false} /></label>
            <Button variant="outline" onClick={applyProperties}>Áp dụng thuộc tính</Button>
            <div className={styles.toolbar}>{node && <>{[['Trái', -20, 0], ['Phải', 20, 0], ['Lên', 0, -20], ['Xuống', 0, 20]].map(([label, dx, dy]) => <button key={label} type="button" onClick={() => run(() => api?.move(node.nodeId, Number(dx), Number(dy)))}>{label}</button>)}</>}<button type="button" onClick={() => run(() => { if (node || edge) api?.remove((node?.nodeId ?? edge?.edgeId)!, !!edge); })}>Xóa phần tử</button></div>
          </fieldset>
        </aside>
      </div>
      <details className={styles.policy}><summary>Ứng viên, phân công và tách nhiệm vụ</summary><p>Chỉ vai trò con người; nhóm chờ danh bạ #21. CASE_OWNER không phải AI. INSURER_REVIEWER chỉ dùng khi tenant bật rõ.</p>
        <label>Chính sách phân công (JSON)<textarea rows={12} disabled={readOnly || busy} value={policyText} onChange={e => setPolicyText(e.target.value)} /></label>
        <Button variant="outline" disabled={readOnly || busy} onClick={() => run(() => { const policy: unknown = JSON.parse(policyText); if (!isAssignmentPolicy(policy)) throw new Error(); changed({ ...doc, content: { ...doc.content, assignmentPolicy: policy } }); })}>Áp dụng phân công</Button>
      </details>
      <div className={styles.toolbar}><label className={styles.import}>Nhập JSON / BPMN<input type="file" accept=".json,.bpmn,.xml" disabled={readOnly || busy || !api} onChange={e => void importFile(e.target.files?.[0], e.target)} /></label>
        <Button variant="outline" disabled={busy} onClick={() => download('workflow.local.json', canonicalJson(doc), 'application/json')}>Xuất JSON</Button>
        <Button variant="outline" disabled={busy || !api} onClick={() => run(() => { if (validateLocalWorkflow(doc.content).some(i => i.detailCode === 'SCHEMA_INVALID')) throw new Error(); download('workflow.local.bpmn', toBpmnXml(doc), 'application/xml'); })}>Xuất BPMN</Button>
      </div>
      {preview && <pre data-testid="canonical-preview" className={styles.preview}>{canonicalJson(doc)}</pre>}
      {issues && <div ref={errorsRef} tabIndex={-1} className={styles.validation} role="region" aria-label="Kết quả kiểm tra"><h2>{issues.length ? `${issues.length} lỗi cục bộ` : 'Cấu trúc và đồ thị cục bộ hợp lệ'}</h2>
        <ul>{issues.map((issue, i) => <li key={i}><code>{issue.detailCode}</code> · <code>{issue.path}</code>{issue.nodeId && ` · ${issue.nodeId}`}</li>)}</ul><p>Chưa kiểm tra pin được xuất bản, binding tenant, quyền, MFA hay maker-checker trên máy chủ. Không đủ điều kiện xuất bản.</p></div>}
    </>}
    <details className={styles.policy} data-testid="bpmn-license"><summary>bpmn-js 18.33.1 · Giấy phép upstream</summary><pre className={styles.license}>{BPMN_LICENSE}</pre><a href="https://github.com/bpmn-io/bpmn-js/tree/v18.33.1" target="_blank" rel="noreferrer">Mã nguồn bpmn-js</a></details>
    {error && <div role="alert" className={styles.error}>{error}</div>}
    <p role="status" aria-live="polite" className={styles.hint}>{message}</p>
  </section>;
}
