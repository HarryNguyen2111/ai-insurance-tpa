'use client';

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspaces } from '@/components/workspace-provider';
import { Button } from '@/components/ui/button';
import { AI_ACTIONS, HUMAN_ACTIONS, NODE_LABELS, NODE_TYPES, canonicalJson, isAssignmentPolicy, isWorkflowNode, isWorkflowEdge, newDocument, validateLocal as validateLocalWorkflow, type EditorDocument, type WorkflowContent, type WorkflowIssue, type WorkflowNode } from '@/lib/workflow-definition';
import { DRAFT_KEY, DraftConflict, MAX_DRAFT_BYTES, parseDocument, readDraft, readServerLayout, saveDraft, saveServerLayout } from '@/lib/workflow-draft';
import { MAX_XML_BYTES, fromBpmnXml, toBpmnXml } from '@/lib/workflow-bpmn';
import { WorkflowApiFailure, workflowApi, type ValidationReport, type WorkflowSession, type WorkflowVersion } from '@/lib/workflow-api';
import { STATUS_LABELS, WorkflowServerPanel, failureText } from './workflow-server-panel';
import type { CanvasApi } from './workflow-canvas';
import styles from './workflow-designer.module.css';

const BPMN_LICENSE = "Copyright (c) 2014-present Camunda Services GmbH\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of\nthis software and associated documentation files (the \"Software\"), to deal in the\nSoftware without restriction, including without limitation the rights to use, copy,\nmodify, merge, publish, distribute, sublicense, and/or sell copies of the Software,\nand to permit persons to whom the Software is furnished to do so, subject to the\nfollowing conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nThe source code responsible for displaying the bpmn.io project watermark that\nlinks back to https://bpmn.io as part of rendered diagrams MUST NOT be\nremoved or changed. When this software is being used in a website or application,\nthe watermark must stay fully visible and not visually overlapped by other elements.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,\nINCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR\nPURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE\nLIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,\nTORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE\nOR OTHER DEALINGS IN THE SOFTWARE.\n";

const Canvas = dynamic(() => import('./workflow-canvas'), { ssr: false, loading: () => <p role="status">Đang tải trình vẽ…</p> });

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type })), link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const ESCALATIONS = ['CASE_OWNER', 'SUPERVISOR_QUEUE'] as const;
const CANDIDATE_ROLES = ['CLAIM_REVIEWER', 'INSURER_REVIEWER'] as const;
const END_OUTCOMES = ['REVIEW_COMPLETED', 'ROUTED_TO_MANUAL_REVIEW', 'SUPPLEMENT_EXPIRED'] as const;
type Rule = WorkflowContent['assignmentPolicy']['rules'][number];

/** Server binding of the open document (#80). Content is authoritative from the server; layout is local only. */
interface ServerState {
  definitionId: string; workflowKey: string; versionNo: number; status: WorkflowVersion['status']; revision: number;
  contentHash: string; publishable: boolean; inFlight: number; publishedAt?: string; savedContent: string;
}
const fromView = (v: WorkflowVersion): ServerState => ({ definitionId: v.definitionId, workflowKey: v.workflowKey, versionNo: v.versionNo, status: v.status,
  revision: v.revision, contentHash: v.contentHash, publishable: v.publishableByCurrentActor, inFlight: v.inFlightExecutionCount,
  ...(v.publishedAt ? { publishedAt: v.publishedAt } : {}), savedContent: canonicalJson(v.content) });

export function WorkflowDesigner({ allowSyntheticSession = false }: { allowSyntheticSession?: boolean }) {
  const { loaded, active } = useWorkspaces();
  if (!loaded) return <p role="status">Đang tải bản nháp cục bộ…</p>;
  const scope = `${DRAFT_KEY}.${active?.id ?? 'sandbox'}`;
  return <Editor key={scope} scope={scope} allowSyntheticSession={allowSyntheticSession} />;
}

function Editor({ scope, allowSyntheticSession }: { scope: string; allowSyntheticSession: boolean }) {
  const [doc, setDoc] = useState<EditorDocument>(newDocument);
  const [revision, setRevision] = useState(0), [opened, setOpened] = useState(false), [epoch, setEpoch] = useState(0);
  const [api, setApi] = useState<CanvasApi | null>(null), [selected, setSelected] = useState('n_start');
  const [propertyText, setPropertyText] = useState(''), [policyText, setPolicyText] = useState('');
  const [issues, setIssues] = useState<WorkflowIssue[] | null>(null), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [readOnly, setReadOnly] = useState(false), [source, setSource] = useState('start'), [target, setTarget] = useState('end');
  const [preview, setPreview] = useState(false), [summary, setSummary] = useState(false), [busy, setBusy] = useState(false);
  const [session, setSession] = useState<WorkflowSession | null>(null), [server, setServer] = useState<ServerState | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null), [conflict, setConflict] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false), [refresh, setRefresh] = useState(0);
  const errorsRef = useRef<HTMLDivElement>(null), reportRef = useRef<HTMLDivElement>(null), conflictRef = useRef<HTMLDivElement>(null), alive = useRef(true);
  const remote = useMemo(() => session?.membershipContext ? workflowApi(session) : null, [session]);
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
  // Server versions other than DRAFT are immutable (spec 14 §3.4): the editor is a read-only view.
  const immutable = !!server && server.status !== 'DRAFT';
  const locked = readOnly || busy || immutable || confirmPublish;
  const dirty = !!server && canonicalJson(doc.content) !== server.savedContent;

  function changed(next: EditorDocument) { setDoc(next); setIssues(null); setReport(null); setMessage('Có chỉnh sửa chưa lưu.'); }
  function replace(next: EditorDocument) { changed(next); setEpoch(v => v + 1); setSelected(next.content.nodes[0] ? `n_${next.content.nodes[0].nodeId}` : ''); }
  function run(action: () => void) { setError(''); try { action(); } catch { setError('Thao tác không hợp lệ; bản nháp hiện tại được giữ nguyên.'); } }
  useEffect(() => { if (report) reportRef.current?.focus(); }, [report]);
  useEffect(() => { if (conflict) conflictRef.current?.focus(); }, [conflict]);
  useEffect(() => { if (issues?.length) errorsRef.current?.focus(); }, [issues]);
  function validateLocal() { const result = validateLocalWorkflow(doc.content); setIssues(result); }
  function changeProperty(key: string, value: unknown) { run(() => { const n = JSON.parse(propertyText) as Record<string, unknown>; n[key] = value; setPropertyText(JSON.stringify(n, null, 2)); }); }
  function updateRule(ruleKey: string, patch: Partial<Rule>) {
    run(() => {
      const policy = { ...doc.content.assignmentPolicy, rules: doc.content.assignmentPolicy.rules.map(r => r.ruleKey === ruleKey ? { ...r, ...patch } : r) };
      if (!isAssignmentPolicy(policy)) throw new Error();
      changed({ ...doc, content: { ...doc.content, assignmentPolicy: policy } });
    });
  }
  let formNode: WorkflowNode | undefined;
  try {
    const value: unknown = JSON.parse(propertyText);
    if (value && typeof value === 'object' && !Array.isArray(value)) formNode = value as WorkflowNode;
  } catch { /* Raw JSON errors are reported when applying. */ }
  const field = <T,>(key: string, fallback: T): T => formNode && key in formNode ? (formNode as unknown as Record<string, T>)[key] : fallback;
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
    if (!file || busy || locked) return;
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

  // ---- Server (#80) operations. Every failure keeps the in-memory edits untouched. ----
  async function serverTask(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); }
    catch (cause) { if (alive.current) setError(failureText(cause)); }
    finally { if (alive.current) setBusy(false); }
  }
  function openVersion(view: WorkflowVersion) {
    const layout = readServerLayout(localStorage, view.definitionId, view.contentHash, view.content);
    setServer(fromView(view)); setDoc({ content: view.content, layout }); setEpoch(v => v + 1);
    setSelected(view.content.nodes[0] ? `n_${view.content.nodes[0].nodeId}` : '');
    setIssues(null); setReport(null); setConflict(false); setConfirmPublish(false); setOpened(true);
    setMessage(`Đã tải ${view.workflowKey} v${view.versionNo} (${STATUS_LABELS[view.status]}) từ máy chủ.`);
  }
  /** Accept the server's view of a write; keep the local geometry for the returned contentHash. */
  function accepted(view: WorkflowVersion, text: string) {
    saveServerLayout(localStorage, view.definitionId, view.contentHash, { content: view.content, layout: doc.layout });
    setServer(fromView(view)); setDoc(d => ({ content: view.content, layout: d.layout })); setConflict(false); setReport(null);
    setRefresh(v => v + 1); setMessage(text);
  }
  const saveServer = () => serverTask(async () => {
    if (!remote) return;
    if (!server) {
      const { value } = await remote.createDraft(doc.content);
      if (alive.current) accepted(value, `Đã tạo bản nháp ${value.workflowKey} v${value.versionNo} trên máy chủ (revision ${value.revision}).`);
    } else if (immutable) {
      const { value } = await remote.createDraft(doc.content, server.versionNo);
      if (alive.current) accepted(value, `Đã tạo bản nháp v${value.versionNo} từ v${server.versionNo}.`);
    } else {
      try {
        const { value } = await remote.updateDraft(server.definitionId, server.versionNo, server.revision, doc.content);
        if (alive.current) accepted(value, `Đã lưu bản nháp lên máy chủ (revision ${value.revision}).`);
      } catch (cause) {
        if (cause instanceof WorkflowApiFailure && cause.stale && alive.current) { setConflict(true); return; }
        throw cause;
      }
    }
  });
  const reloadServer = () => serverTask(async () => {
    if (!remote || !server) return;
    const view = await remote.getVersion(server.definitionId, server.versionNo);
    if (alive.current) openVersion(view);
  });
  /** Explicit user choice after a 409: re-base the kept edits onto the latest server revision. */
  const overwriteLatest = () => serverTask(async () => {
    if (!remote || !server) return;
    const latest = await remote.getVersion(server.definitionId, server.versionNo);
    if (latest.status !== 'DRAFT') throw new WorkflowApiFailure(409, 'STALE_VERSION', 'Phiên bản này không còn là bản nháp; tạo bản nháp mới.');
    const { value } = await remote.updateDraft(server.definitionId, server.versionNo, latest.revision, doc.content);
    if (alive.current) accepted(value, `Đã lưu chỉnh sửa của bạn lên revision ${value.revision}.`);
  });
  const validateServer = () => serverTask(async () => {
    if (!remote || !server) return;
    const result = await remote.validateDraft(server.definitionId, server.versionNo, server.revision);
    if (!alive.current) return;
    setReport(result);
    if (result.revision !== server.revision) setMessage('Báo cáo thuộc revision khác; tải lại trước khi xuất bản.');
  });
  const publish = () => serverTask(async () => {
    if (!remote || !server) return;
    try {
      const { value } = await remote.publish(server.definitionId, server.versionNo, server.revision, server.contentHash);
      if (alive.current) { setConfirmPublish(false); accepted(value, `Đã xuất bản ${value.workflowKey} v${value.versionNo}. Phiên bản này bất biến.`); }
    } catch (cause) {
      if (alive.current) setConfirmPublish(false);
      throw cause;
    }
  });
  const canPublish = !!server && server.status === 'DRAFT' && server.publishable && !dirty && !conflict;
  const selectIssue = (i: { nodeId?: string; edgeId?: string }) => {
    const id = i.nodeId ? `n_${i.nodeId}` : i.edgeId ? `e_${i.edgeId}` : '';
    if (id && (doc.content.nodes.some(n => `n_${n.nodeId}` === id) || doc.content.edges.some(e => `e_${e.edgeId}` === id))) setSelected(id);
  };
  const humanTasks = doc.content.nodes.filter(n => n.type === 'HUMAN_TASK');
  const rule = node?.type === 'HUMAN_TASK' ? doc.content.assignmentPolicy.rules.find(r => r.ruleKey === node.assignmentRuleKey) : undefined;

  const chip = server
    ? `Máy chủ · v${server.versionNo} · ${STATUS_LABELS[server.status]} · revision ${server.revision}${dirty ? ' · chưa lưu' : ''}`
    : `Bản nháp · cục bộ v${revision}`;
  return <section className={styles.editor} aria-labelledby="workflow-title">
    <header className={styles.header}><div><p className={styles.eyebrow}>THIẾT KẾ QUY TRÌNH · VWF-02</p><h1 id="workflow-title">Trình thiết kế quy trình</h1></div><span className={styles.chip} data-testid="workflow-status">{chip}</span></header>
    {server ? <div role="note" className={styles.notice}><strong>Định nghĩa trên máy chủ (#80).</strong> Nội dung chuẩn do máy chủ lưu và kiểm tra; bố cục sơ đồ chỉ lưu trên trình duyệt này. Không nhập thông tin cá nhân.</div>
      : <div role="note" className={styles.notice}><strong>Chỉ lưu trên trình duyệt này.</strong> Dùng cấu hình mẫu, không nhập thông tin cá nhân. Kết nối máy chủ quy trình bên dưới để lưu, kiểm tra và xuất bản; kiểm tra cục bộ không cấp quyền.</div>}
    {immutable && server && <div role="note" className={styles.notice} data-testid="immutable-notice"><strong>Phiên bản {STATUS_LABELS[server.status].toLowerCase()} là bất biến.</strong> Chỉ xem{server.publishedAt ? ` · xuất bản lúc ${new Date(server.publishedAt).toLocaleString('vi-VN')}` : ''} · mã băm <code>{server.contentHash.slice(0, 12)}…</code> · {server.inFlight} lượt chạy đang dùng. Tạo bản nháp mới để thay đổi.</div>}
    {allowSyntheticSession && <WorkflowServerPanel session={session} refresh={refresh} onSession={next => { setSession(next); if (!next) { setServer(null); setReport(null); setConflict(false); } }} onOpen={openVersion} />}
    {!opened ? <div className={styles.empty}><h2>Thiết kế luồng xử lý có giới hạn</h2><p>7 loại bước; AI chỉ đề xuất, người phụ trách luôn là con người. Nhánh song song và mã thực thi không được hỗ trợ.</p><Button onClick={() => setOpened(true)}>Mở trình vẽ</Button><p className={styles.hint}>bpmn-js chỉ tải khi mở trình vẽ.</p></div> : <>
      <div className={styles.toolbar}>
        {!server && <>
          <Button variant="outline" disabled={readOnly || busy || !api} onClick={() => {
            setError(''); try { const saved = saveDraft(localStorage, scope, doc, revision); setRevision(saved.revision); setMessage('Đã lưu bản nháp cục bộ.'); }
            catch (cause) { setError(cause instanceof DraftConflict ? cause.message : 'Không lưu được. Kiểm tra trường bắt buộc, dữ liệu đã lưu và dung lượng trình duyệt. Chỉnh sửa vẫn được giữ nguyên.'); }
          }}>Lưu cục bộ</Button>
          <Button variant="outline" disabled={busy} onClick={() => run(() => { const saved = readDraft(localStorage, scope); if (!saved) throw new Error(); replace(saved); setRevision(saved.revision); setMessage('Đã tải bản đã lưu; chưa gọi máy chủ.'); })}>Tải bản đã lưu</Button>
        </>}
        <Button variant="outline" disabled={busy} onClick={validateLocal}>Kiểm tra cục bộ</Button>
        {remote && !immutable && <Button variant="outline" disabled={readOnly || busy || !api || conflict} onClick={() => void saveServer()}>{server ? 'Lưu lên máy chủ' : 'Tạo bản nháp trên máy chủ'}</Button>}
        {remote && immutable && <Button variant="outline" disabled={busy} onClick={() => void saveServer()}>Tạo bản nháp mới từ phiên bản này</Button>}
        {remote && server && server.status === 'DRAFT' && <Button variant="outline" disabled={busy || dirty} title={dirty ? 'Lưu trước khi kiểm tra trên máy chủ' : undefined} onClick={() => void validateServer()}>Kiểm tra trên máy chủ</Button>}
        {remote && server && <Button variant="outline" disabled={busy} onClick={() => void reloadServer()}>Tải lại từ máy chủ</Button>}
        <Button variant="outline" onClick={() => setSummary(v => !v)} aria-expanded={summary}>Xem trước</Button>
        <Button variant="outline" onClick={() => setPreview(v => !v)}>Xem JSON chuẩn</Button>
        {/* UI hint only: the server re-checks role, MFA and maker-checker on every publish. */}
        {canPublish ? <Button disabled={busy || !report?.valid || report.revision !== server?.revision || report.contentHash !== server?.contentHash} onClick={() => setConfirmPublish(true)}>Xuất bản</Button>
          : !server && <Button disabled title="Lưu lên máy chủ; chỉ người phát hành khác người soạn mới thấy nút này">Xuất bản (cần máy chủ)</Button>}
        <label className={styles.inline}><input type="checkbox" checked={readOnly} onChange={e => setReadOnly(e.target.checked)} />Chỉ xem cục bộ</label>
      </div>
      {conflict && <div ref={conflictRef} tabIndex={-1} role="region" aria-label="Xung đột phiên bản" className={styles.validation}>
        <h2>Bản nháp trên máy chủ đã được người khác thay đổi (409 STALE_VERSION)</h2>
        <p>Chỉnh sửa của bạn vẫn được giữ nguyên trong trình vẽ. Chọn cách xử lý:</p>
        <div className={styles.toolbar}>
          <Button variant="outline" disabled={busy} onClick={() => download('workflow.unsaved.json', canonicalJson(doc), 'application/json')}>Xuất chỉnh sửa của tôi</Button>
          <Button variant="outline" disabled={busy} onClick={() => void overwriteLatest()}>Giữ chỉnh sửa của tôi và lưu lên revision mới nhất</Button>
          <Button variant="outline" disabled={busy} onClick={() => void reloadServer()}>Bỏ chỉnh sửa và tải bản máy chủ</Button>
        </div>
      </div>}
      {confirmPublish && server && <div role="dialog" aria-modal="false" aria-labelledby="publish-title" className={styles.validation}>
        <h2 id="publish-title">Xác nhận xuất bản {server.workflowKey} v{server.versionNo}</h2>
        <p>Nội dung đã xem: revision {server.revision} · mã băm <code>{server.contentHash}</code>. Sau khi xuất bản, phiên bản này bất biến và phiên bản đang xuất bản trước đó (nếu có) chuyển sang đã thay thế.</p>
        <div className={styles.toolbar}>
          <Button disabled={busy} onClick={() => void publish()}>Xác nhận xuất bản</Button>
          <Button variant="outline" disabled={busy} onClick={() => setConfirmPublish(false)}>Hủy</Button>
        </div>
      </div>}
      <div className={styles.fields}>
        <label>Mã workflow<input disabled={locked || !!server} value={doc.content.workflowKey} onChange={e => changed({ ...doc, content: { ...doc.content, workflowKey: e.target.value } })} /></label>
        <label>Tên workflow<input disabled={locked} value={doc.content.title} onChange={e => changed({ ...doc, content: { ...doc.content, title: e.target.value } })} /></label>
      </div>
      <div className={styles.toolbox} aria-label="Các bước được phép">{NODE_TYPES.map(type => <button key={type} type="button" draggable={!locked && !!api} disabled={locked || !api}
        onDragStart={event => event.dataTransfer.setData('application/x-tpa-node', type)}
        onClick={() => run(() => { if (api) setSelected(`n_${api.add(type)}`); })}>{NODE_LABELS[type]}</button>)}</div>
      <p className={styles.hint}>Bấm hoặc kéo bước vào sơ đồ. Dùng danh sách chọn và nút di chuyển/kết nối nếu không dùng chuột. Bước mới cần cấu hình; không có mặc định SLA hay chính sách AI.</p>
      <div className={styles.workspace}>
        <div><Canvas key={epoch} document={doc} readOnly={locked} onChange={next => { setDoc(next); setIssues(null); }} onSelect={setSelected} onReady={setApi} onError={setError} />
          <div className={styles.connections}>
            <label>Từ bước<select value={source} disabled={locked} onChange={e => setSource(e.target.value)}>{doc.content.nodes.map(n => <option key={n.nodeId} value={n.nodeId}>{n.label} · {n.nodeId}</option>)}</select></label>
            <label>Đến bước<select value={target} disabled={locked} onChange={e => setTarget(e.target.value)}>{doc.content.nodes.map(n => <option key={n.nodeId} value={n.nodeId}>{n.label} · {n.nodeId}</option>)}</select></label>
            <Button variant="outline" disabled={locked || !api} onClick={() => run(() => api?.connect(source, target))}>Kết nối</Button>
          </div>
        </div>
        <aside className={styles.panel} aria-label="Thuộc tính phần tử">
          <h2>Thuộc tính</h2><label>Chọn phần tử<select value={selected} onChange={e => setSelected(e.target.value)}>
            {doc.content.nodes.map(n => <option key={`n_${n.nodeId}`} value={`n_${n.nodeId}`}>{NODE_LABELS[n.type]} · {n.nodeId}</option>)}
            {doc.content.edges.map(e => <option key={`e_${e.edgeId}`} value={`e_${e.edgeId}`}>Cạnh · {e.edgeId}</option>)}
          </select></label>
          <fieldset disabled={locked || !api} className={styles.properties}>
            {node && <><label>Nhãn bước<input value={formNode?.label ?? ''} onChange={e => changeProperty('label', e.target.value)} /></label>
              {'accountableOwner' in node && <label>Người chịu trách nhiệm<select value={field('accountableOwner', '')} onChange={e => changeProperty('accountableOwner', e.target.value)}><option value="">Chọn người chịu trách nhiệm</option><option value="CASE_OWNER">CASE_OWNER · người phụ trách hồ sơ</option></select></label>}
              {node.type === 'END' && <label>Kết quả kết thúc<select value={field('outcome', '')} onChange={e => changeProperty('outcome', e.target.value)}>{END_OUTCOMES.map(o => <option key={o} value={o}>{o}</option>)}</select></label>}
              {node.type === 'TIMER' && <label>Thời gian chờ (giây, 60–604800)<input type="number" min={60} max={604800} value={field<number | ''>('delaySeconds', '')} onChange={e => changeProperty('delaySeconds', Number(e.target.value))} /></label>}
              {node.type === 'SUPPLEMENT_WAIT' && <label>Hạn bổ sung (giây, 86400–2592000)<input type="number" min={86400} max={2592000} value={field<number | ''>('maxWaitSeconds', '')} onChange={e => changeProperty('maxWaitSeconds', Number(e.target.value))} /></label>}
              {node.type === 'AI_ACTIVITY' && <label>Thời gian tối đa AI (giây, 30–600)<input type="number" min={30} max={600} value={field<number | ''>('timeoutSeconds', '')} onChange={e => changeProperty('timeoutSeconds', Number(e.target.value))} /></label>}
              {node.type === 'HUMAN_TASK' && <>
                <label>Quy tắc phân công<select value={field('assignmentRuleKey', '')} onChange={e => changeProperty('assignmentRuleKey', e.target.value)}>{doc.content.assignmentPolicy.rules.map(r => <option key={r.ruleKey} value={r.ruleKey}>{r.ruleKey} · {r.candidateRoles.join(', ')}</option>)}</select></label>
                <label>SLA (giây)<input type="number" min={3600} max={1209600} value={field<{ dueSeconds?: number }>('sla', {}).dueSeconds ?? ''} onChange={e => changeProperty('sla', { ...field<object>('sla', {}), dueSeconds: Number(e.target.value) })} /></label>
                <label>Chuyển cấp khi quá SLA<select value={field<{ escalateTo?: string }>('sla', {}).escalateTo ?? ''} onChange={e => changeProperty('sla', { ...field<object>('sla', {}), escalateTo: e.target.value })}>{ESCALATIONS.map(v => <option key={v} value={v}>{v}</option>)}</select></label>
              </>}
              {(node.type === 'HUMAN_TASK' || node.type === 'AI_ACTIVITY') && <fieldset><legend>Hành động được phép</legend>{(node.type === 'HUMAN_TASK' ? HUMAN_ACTIONS : AI_ACTIONS).map(action => {
                const actions: string[] = Array.isArray(field<unknown>('allowedActionIds', [])) ? field<string[]>('allowedActionIds', []) : [];
                return <label className={styles.inline} key={action}><input type="checkbox" checked={actions.includes(action)} onChange={e => changeProperty('allowedActionIds', e.target.checked ? [...actions, action] : actions.filter(a => a !== action))} />{action}</label>;
              })}</fieldset>}
              {'allowedEvidence' in node && <fieldset><legend>Phạm vi bằng chứng</legend>{([
                ['documentTypes', ['INVOICE_PHOTO', 'ITEMIZED_LIST', 'PRESCRIPTION', 'LAB_ORDER', 'LAB_RESULT', 'DISCHARGE_PAPER', 'VNEID_HISTORY']],
                ['sources', ['XML', 'OCR', 'VLM', 'QR', 'IMAGE_ANALYSIS']],
              ] as const).map(([key, values]) => <div key={key}>{values.map(value => {
                const raw = field<unknown>('allowedEvidence', null);
                const evidence = raw && typeof raw === 'object' ? raw as Record<string, unknown> : { documentTypes: [], sources: [] };
                const current: string[] = Array.isArray(evidence[key]) ? evidence[key] as string[] : [];
                return <label className={styles.inline} key={value}><input type="checkbox" checked={current.includes(value)} onChange={e => changeProperty('allowedEvidence', { ...evidence, [key]: e.target.checked ? [...current, value] : current.filter(v => v !== value) })} />{value}</label>;
              })}</div>)}</fieldset>}
            </>}
            <label>{edge ? 'Cạnh và điều kiện (JSON)' : 'Toàn bộ thuộc tính bước (JSON)'}<textarea data-testid="workflow-properties" rows={10} value={propertyText} onChange={e => setPropertyText(e.target.value)} spellCheck={false} /></label>
            <Button variant="outline" onClick={applyProperties}>Áp dụng thuộc tính</Button>
            {rule && <fieldset aria-label="Ứng viên"><legend>Ứng viên · quy tắc {rule.ruleKey} (áp dụng ngay)</legend>
              {CANDIDATE_ROLES.map(role => <label className={styles.inline} key={role}><input type="checkbox" checked={rule.candidateRoles.includes(role)}
                onChange={e => updateRule(rule.ruleKey, { candidateRoles: e.target.checked ? [...rule.candidateRoles, role] : rule.candidateRoles.filter(r => r !== role) })} />{role}</label>)}
              <label>Cách nhận việc<select value={rule.strategy} onChange={e => updateRule(rule.ruleKey, { strategy: e.target.value as Rule['strategy'] })}><option value="QUEUE_CLAIM">QUEUE_CLAIM · nhận từ hàng đợi</option><option value="CASE_OWNER_DIRECT">CASE_OWNER_DIRECT · giao người phụ trách</option></select></label>
              <label>Số việc tối đa mỗi người<input type="number" min={1} max={50} value={rule.maxActiveTasksPerAssignee} onChange={e => updateRule(rule.ruleKey, { maxActiveTasksPerAssignee: Number(e.target.value) })} /></label>
              {humanTasks.filter(n => n.nodeId !== node?.nodeId).map(n => <label className={styles.inline} key={n.nodeId}><input type="checkbox" checked={rule.distinctFromNodeIds.includes(n.nodeId)}
                onChange={e => updateRule(rule.ruleKey, { distinctFromNodeIds: e.target.checked ? [...rule.distinctFromNodeIds, n.nodeId] : rule.distinctFromNodeIds.filter(id => id !== n.nodeId) })} />Khác người xử lý {n.nodeId}</label>)}
            </fieldset>}
            <div className={styles.toolbar}>{node && <>{[['Trái', -20, 0], ['Phải', 20, 0], ['Lên', 0, -20], ['Xuống', 0, 20]].map(([label, dx, dy]) => <button key={label} type="button" onClick={() => run(() => api?.move(node.nodeId, Number(dx), Number(dy)))}>{label}</button>)}</>}<button type="button" onClick={() => run(() => { if (node || edge) api?.remove((node?.nodeId ?? edge?.edgeId)!, !!edge); })}>Xóa phần tử</button></div>
          </fieldset>
        </aside>
      </div>
      <details className={styles.policy}><summary>Ứng viên, phân công và tách nhiệm vụ</summary><p>Chỉ vai trò con người; nhóm chờ danh bạ #21. CASE_OWNER không phải AI. INSURER_REVIEWER chỉ dùng khi tenant bật rõ.</p>
        <label>Chính sách phân công (JSON)<textarea rows={12} disabled={locked} value={policyText} onChange={e => setPolicyText(e.target.value)} /></label>
        <Button variant="outline" disabled={locked} onClick={() => run(() => { const policy: unknown = JSON.parse(policyText); if (!isAssignmentPolicy(policy)) throw new Error(); changed({ ...doc, content: { ...doc.content, assignmentPolicy: policy } }); })}>Áp dụng phân công</Button>
      </details>
      <div className={styles.toolbar}><label className={styles.import}>Nhập JSON / BPMN<input type="file" accept=".json,.bpmn,.xml" disabled={locked || !api} onChange={e => void importFile(e.target.files?.[0], e.target)} /></label>
        <Button variant="outline" disabled={busy} onClick={() => download('workflow.local.json', canonicalJson(doc), 'application/json')}>Xuất JSON</Button>
        <Button variant="outline" disabled={busy || !api} onClick={() => run(() => { if (validateLocalWorkflow(doc.content).some(i => i.detailCode === 'SCHEMA_INVALID')) throw new Error(); download('workflow.local.bpmn', toBpmnXml(doc), 'application/xml'); })}>Xuất BPMN</Button>
      </div>
      {summary && <table className={styles.table} aria-label="Xem trước quy trình" data-testid="workflow-summary">
        <thead><tr><th>Bước</th><th>Loại</th><th>Người chịu trách nhiệm</th><th>Ứng viên</th><th>SLA / thời hạn</th><th>Hành động</th><th>Bằng chứng</th></tr></thead>
        <tbody>{doc.content.nodes.map(n => {
          const r = n.type === 'HUMAN_TASK' ? doc.content.assignmentPolicy.rules.find(x => x.ruleKey === n.assignmentRuleKey) : undefined;
          const due = n.type === 'HUMAN_TASK' ? `${n.sla.dueSeconds}s → ${n.sla.escalateTo}` : n.type === 'SUPPLEMENT_WAIT' ? `${n.maxWaitSeconds}s` : n.type === 'TIMER' ? `${n.delaySeconds}s` : n.type === 'AI_ACTIVITY' ? `${n.timeoutSeconds}s` : n.type === 'END' ? n.outcome : '—';
          return <tr key={n.nodeId}><td>{n.label} · <code>{n.nodeId}</code></td><td>{NODE_LABELS[n.type]}</td><td>{'accountableOwner' in n ? n.accountableOwner : '—'}</td>
            <td>{r ? `${r.candidateRoles.join(', ')} · ${r.strategy}` : '—'}</td><td>{due}</td>
            <td>{'allowedActionIds' in n ? n.allowedActionIds.join(', ') || '—' : '—'}</td>
            <td>{'allowedEvidence' in n ? [...n.allowedEvidence.documentTypes, ...n.allowedEvidence.sources].join(', ') || '—' : '—'}</td></tr>;
        })}</tbody>
      </table>}
      {preview && <pre data-testid="canonical-preview" className={styles.preview}>{canonicalJson(doc)}</pre>}
      {report && <div ref={reportRef} tabIndex={-1} className={styles.validation} role="region" aria-label="Kết quả kiểm tra máy chủ">
        <h2>{report.valid ? `Máy chủ: hợp lệ (revision ${report.revision})` : `Máy chủ: ${report.issues.length} lỗi (revision ${report.revision})`}</h2>
        <ul>{report.issues.map((issue, i) => <li key={i}><button type="button" onClick={() => selectIssue(issue)}><code>{issue.detailCode}</code> · <code>{issue.path}</code>{issue.nodeId && ` · ${issue.nodeId}`}{issue.edgeId && ` · ${issue.edgeId}`}</button></li>)}</ul>
        <p>{report.valid ? (server?.publishable ? 'Có thể xuất bản đúng revision và mã băm này.' : 'Chỉ người phát hành khác người soạn/sửa bản nháp mới xuất bản được.') : 'Không thể xuất bản cho tới khi sửa hết lỗi.'}</p></div>}
      {issues && <div ref={errorsRef} tabIndex={-1} className={styles.validation} role="region" aria-label="Kết quả kiểm tra"><h2>{issues.length ? `${issues.length} lỗi cục bộ` : 'Cấu trúc và đồ thị cục bộ hợp lệ'}</h2>
        <ul>{issues.map((issue, i) => <li key={i}><code>{issue.detailCode}</code> · <code>{issue.path}</code>{issue.nodeId && ` · ${issue.nodeId}`}</li>)}</ul><p>Kiểm tra cục bộ không xét pin đã xuất bản, binding tenant, quyền, MFA hay maker-checker. Không đủ điều kiện xuất bản; dùng kiểm tra trên máy chủ.</p></div>}
    </>}
    <details className={styles.policy} data-testid="bpmn-license"><summary>bpmn-js 18.33.1 · Giấy phép upstream</summary><pre className={styles.license}>{BPMN_LICENSE}</pre><a href="https://github.com/bpmn-io/bpmn-js/tree/v18.33.1" target="_blank" rel="noreferrer">Mã nguồn bpmn-js</a></details>
    {error && <div role="alert" className={styles.error}>{error}</div>}
    <p role="status" aria-live="polite" className={styles.hint}>{message}</p>
  </section>;
}
