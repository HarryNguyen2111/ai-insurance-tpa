'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CheckCheck, Eye, FilePlus2, LayoutTemplate, MoreHorizontal, Redo2, RotateCw, Save, Send, Undo2 } from 'lucide-react';
import { useWorkspaces } from '@/components/workspace-provider';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { canonicalJson, newDocument, NODE_LABELS, validateLocal as validateLocalWorkflow, type EditorDocument, type NodeType, type Point } from '@/lib/workflow-definition';
import { DRAFT_KEY, DraftConflict, MAX_DRAFT_BYTES, parseDocument, readDraft, readServerLayout, saveDraft, saveServerLayout } from '@/lib/workflow-draft';
import { MAX_XML_BYTES, fromBpmnXml, toBpmnXml } from '@/lib/workflow-bpmn';
import { addNode, connect, CONNECTION_MESSAGES, moveNodes, normalizeLayout, removeElements } from '@/lib/workflow-graph';
import { issueCounts, localIssues, serverIssues, type BuilderIssue } from '@/lib/workflow-inspector';
import { createHistory, record, redo as redoHistory, reset, undo as undoHistory, type History } from '@/lib/workflow-history';
import { TEMPLATES } from '@/lib/workflow-templates';
import { WorkflowApiFailure, workflowApi, type ValidationReport, type WorkflowSession, type WorkflowVersion } from '@/lib/workflow-api';
import { STATUS_LABELS, WorkflowServerPanel, failureText } from './workflow-server-panel';
import { WorkflowPalette } from './workflow-palette';
import { WorkflowInspector, type FocusRequest } from './workflow-inspector';
import { AdvancedTools, WorkflowDrawer, type DrawerTab } from './workflow-drawer';
import type { CanvasApi } from './workflow-flow-canvas';
import styles from './workflow-designer.module.css';

// Upstream React Flow is loaded only when the editor opens (separate chunk).
const Canvas = dynamic(() => import('./workflow-flow-canvas'), { ssr: false, loading: () => <p role="status" className={styles.canvasLoading}>Đang tải trình vẽ…</p> });

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type })), link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

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
  // Keyed by tenant/workspace: switching remounts the editor, so no draft, history or server state leaks across tenants.
  const scope = `${DRAFT_KEY}.${active?.id ?? 'sandbox'}`;
  return <Editor key={scope} scope={scope} allowSyntheticSession={allowSyntheticSession} />;
}

function Editor({ scope, allowSyntheticSession }: { scope: string; allowSyntheticSession: boolean }) {
  const [history, setHistory] = useState<History<EditorDocument>>(() => createHistory(normalizeLayout(newDocument())));
  const doc = history.present;
  const [revision, setRevision] = useState(0), [opened, setOpened] = useState(false), [hasSaved, setHasSaved] = useState(false);
  const [api, setApi] = useState<CanvasApi | null>(null), [selected, setSelected] = useState('');
  const [checked, setChecked] = useState<EditorDocument | null>(null), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [readOnly, setReadOnly] = useState(false), [busy, setBusy] = useState(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('issues'), [drawerOpen, setDrawerOpen] = useState(false);
  const [session, setSession] = useState<WorkflowSession | null>(null), [server, setServer] = useState<ServerState | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null), [conflict, setConflict] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false), [refresh, setRefresh] = useState(0), [focus, setFocus] = useState<FocusRequest | null>(null);
  const [focusDrawer, setFocusDrawer] = useState(0), [focusReport, setFocusReport] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);
  const errorsRef = useRef<HTMLDivElement>(null), reportRef = useRef<HTMLDivElement>(null), conflictRef = useRef<HTMLDivElement>(null), alive = useRef(true);
  const remote = useMemo(() => session?.membershipContext ? workflowApi(session) : null, [session]);
  useEffect(() => {
    alive.current = true;
    try { const saved = readDraft(localStorage, scope); if (saved) { setHistory(reset(normalizeLayout({ content: saved.content, layout: saved.layout }))); setRevision(saved.revision); setHasSaved(true); } }
    catch { setError('Không thể đọc bản nháp cục bộ. Dữ liệu không được hiển thị; bản đã lưu vẫn được giữ nguyên.'); }
    return () => { alive.current = false; };
  }, [scope]);
  // Server versions other than DRAFT are immutable (spec 14 §3.4): the editor is a read-only view.
  const immutable = !!server && server.status !== 'DRAFT';
  const locked = readOnly || busy || immutable || confirmPublish;
  const dirty = !!server && canonicalJson(doc.content) !== server.savedContent;
  const issues = useMemo(() => localIssues(doc), [doc]);
  const counts = useMemo(() => issueCounts(issues), [issues]);

  // Fit the editor to the viewport below the shell header/banner (their height varies with width), so the canvas,
  // rail and inspector scroll internally and nothing is clipped behind the page fold.
  useLayoutEffect(() => {
    const el = sectionRef.current;
    if (!el || !opened) return;
    const fit = () => { el.style.setProperty('--editor-top', `${Math.max(0, el.getBoundingClientRect().top + window.scrollY)}px`); };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [opened]);
  useEffect(() => { if (focusReport) reportRef.current?.focus(); }, [focusReport]);
  useEffect(() => { if (conflict) conflictRef.current?.focus(); }, [conflict]);
  useEffect(() => { if (focusDrawer) errorsRef.current?.focus(); }, [focusDrawer]);

  /** Every user edit is an undoable step; server state is never touched until an explicit save. */
  const change = useCallback((next: EditorDocument, tag?: string) => {
    setHistory(h => record(h, next, tag)); setReport(null); setMessage('Có chỉnh sửa chưa lưu.');
  }, []);
  function replace(next: EditorDocument, text: string) { change(normalizeLayout(next)); setSelected(''); setMessage(text); }
  function run(action: () => void) { setError(''); try { action(); } catch (cause) {
    const code = cause instanceof Error ? cause.message : '';
    setError(CONNECTION_MESSAGES[code] ? `${code} · ${CONNECTION_MESSAGES[code]}` : 'Thao tác không hợp lệ; bản nháp hiện tại được giữ nguyên.');
  } }
  const undo = useCallback(() => { if (!locked) { setHistory(undoHistory); setReport(null); setMessage('Đã hoàn tác.'); } }, [locked]);
  const redo = useCallback(() => { if (!locked) { setHistory(redoHistory); setReport(null); setMessage('Đã làm lại.'); } }, [locked]);
  useEffect(() => {
    if (!opened) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input, textarea, select, [contenteditable="true"]'))) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); } else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [opened, undo, redo]);

  const addStep = (type: NodeType, position?: Point) => run(() => {
    const { doc: next, id } = addNode(doc, type, position);
    change(next); setSelected(`n_${id}`); setMessage(`Đã thêm ${NODE_LABELS[type]} (${id}). Cấu hình ở bảng bên phải.`);
    setTimeout(() => api?.center(id), 50);
  });
  const connectSteps = (source: string, target: string) => run(() => {
    const { doc: next, id } = connect(doc, source, target);
    change(next); setSelected(`e_${id}`); setMessage(`Đã thêm nhánh ${id}. Chọn loại nhánh ở bảng bên phải.`);
  });
  const deleteElements = (nodeIds: string[], edgeIds: string[]) => {
    if (locked) return;
    change(removeElements(doc, nodeIds, edgeIds));
    setSelected(''); setMessage(`Đã xóa ${nodeIds.length ? `${nodeIds.length} bước` : ''}${nodeIds.length && edgeIds.length ? ' và ' : ''}${edgeIds.length ? `${edgeIds.length} nhánh` : ''}. Có thể hoàn tác.`);
  };
  const focusIssue = (issue: BuilderIssue) => {
    const id = issue.nodeId ? `n_${issue.nodeId}` : issue.edgeId ? `e_${issue.edgeId}` : '';
    if (id && !(doc.content.nodes.some(n => `n_${n.nodeId}` === id) || doc.content.edges.some(e => `e_${e.edgeId}` === id))) return;
    setSelected(id); setFocus({ ...(issue.field ? { field: issue.field } : {}), nonce: Date.now() });
    if (issue.nodeId) api?.center(issue.nodeId);
    setMessage(`Đang sửa: ${issue.message}`);
  };
  function validateLocal() {
    setChecked(doc); setDrawerTab('issues'); setDrawerOpen(true); setFocusDrawer(v => v + 1);
    if (remote && server?.status === 'DRAFT' && !dirty) void validateServer();
  }
  async function importFile(file: File | undefined, input: HTMLInputElement) {
    if (!file || busy || locked) return;
    setBusy(true); setError('');
    try {
      const xml = file.name.toLowerCase().endsWith('.bpmn') || file.name.toLowerCase().endsWith('.xml');
      if (file.size > (xml ? MAX_XML_BYTES : MAX_DRAFT_BYTES)) throw new Error('LIMIT_EXCEEDED');
      const raw = await file.text();
      const next = xml ? fromBpmnXml(raw) : parseDocument(raw);
      if (alive.current) replace(next, 'Đã nhập vào bản nháp chưa lưu.');
    } catch (cause) {
      if (alive.current) setError(`Không nhập tệp: ${cause instanceof Error && /^[A-Z_]+$/.test(cause.message) ? cause.message : 'SCHEMA_INVALID'}. Bản nháp không đổi.`);
    } finally { if (alive.current) setBusy(false); input.value = ''; }
  }
  function saveLocal() {
    setError('');
    try { const saved = saveDraft(localStorage, scope, doc, revision); setRevision(saved.revision); setHasSaved(true); setMessage('Đã lưu bản nháp cục bộ.'); }
    catch (cause) { setError(cause instanceof DraftConflict ? cause.message : 'Không lưu được. Kiểm tra các ô còn thiếu trong bảng Kiểm tra, dữ liệu đã lưu và dung lượng trình duyệt. Chỉnh sửa vẫn được giữ nguyên.'); }
  }
  function loadLocal() {
    run(() => { const saved = readDraft(localStorage, scope); if (!saved) throw new Error(); setHistory(reset(normalizeLayout(saved))); setRevision(saved.revision); setSelected(''); setOpened(true); setMessage('Đã tải bản đã lưu; chưa gọi máy chủ.'); });
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
    setServer(fromView(view)); setHistory(reset(normalizeLayout({ content: view.content, layout })));
    setSelected(''); setChecked(null); setReport(null); setConflict(false); setConfirmPublish(false); setOpened(true);
    setMessage(`Đã tải ${view.workflowKey} v${view.versionNo} (${STATUS_LABELS[view.status]}) từ máy chủ.`);
  }
  /** Accept the server's view of a write; keep the local geometry for the returned contentHash. */
  function accepted(view: WorkflowVersion, text: string) {
    const next = normalizeLayout({ content: view.content, layout: doc.layout });
    saveServerLayout(localStorage, view.definitionId, view.contentHash, next);
    setServer(fromView(view)); setHistory(h => record(h, normalizeLayout({ content: view.content, layout: h.present.layout }))); setConflict(false); setReport(null);
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
    setReport(result); setDrawerTab('issues'); setDrawerOpen(true); setFocusReport(v => v + 1);
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
  const reportReady = !!report?.valid && report.revision === server?.revision && report.contentHash === server?.contentHash;
  // User-facing explanation of why publish is unavailable. UI hint only; the server re-checks everything.
  const publishHint = !remote ? 'Xuất bản cần kết nối máy chủ quy trình và quyền người phát hành.'
    : !server ? 'Lưu lên máy chủ trước; chỉ người phát hành khác người soạn mới xuất bản được.'
      : immutable ? 'Phiên bản này đã khóa; tạo bản nháp mới để thay đổi.'
        : conflict ? 'Giải quyết xung đột phiên bản trước.'
          : dirty ? 'Có chỉnh sửa chưa lưu; lưu lên máy chủ rồi kiểm tra lại.'
            : !server.publishable ? 'Bạn không thể xuất bản bản nháp này (cần vai trò người phát hành và không phải người đã soạn/sửa).'
              : !reportReady ? 'Bấm “Kiểm tra” để máy chủ xác nhận đúng revision này trước khi xuất bản.' : 'Sẵn sàng xuất bản revision đã kiểm tra.';
  const serverNote = remote && server && server.status === 'DRAFT' && dirty ? 'Có chỉnh sửa chưa lưu: lưu lên máy chủ để kiểm tra trên máy chủ.' : '';
  const serverResult = report && server ? {
    valid: report.valid, revision: report.revision, issues: serverIssues(report, doc.content),
    publishText: report.valid ? (server.publishable ? 'Có thể xuất bản đúng revision và mã băm này.' : 'Chỉ người phát hành khác người soạn/sửa bản nháp mới xuất bản được.') : 'Không thể xuất bản cho tới khi sửa hết lỗi.',
  } : null;

  const chip = server
    ? `Máy chủ · v${server.versionNo} · ${STATUS_LABELS[server.status]} · revision ${server.revision}${dirty ? ' · chưa lưu' : ''}`
    : `Bản nháp · cục bộ v${revision}`;
  const layoutNote = server ? `Chỉ lưu trên trình duyệt này, gắn với định nghĩa và mã băm ${server.contentHash.slice(0, 12)}…; không gửi lên máy chủ.` : 'Lưu cùng bản nháp cục bộ trên trình duyệt này.';
  const errorCount = issues.length;

  return <section ref={sectionRef} className={styles.editor} aria-labelledby="workflow-title" data-full-bleed data-opened={opened || undefined}>
    <header className={styles.toolbar}>
      <div className={styles.titleBlock}>
        <p className={styles.eyebrow}><span id="workflow-title">Trình thiết kế quy trình</span></p>
        <input className={styles.titleInput} aria-label="Tên workflow" disabled={locked || !opened} value={doc.content.title} maxLength={120}
          onChange={e => change({ ...doc, content: { ...doc.content, title: e.target.value } }, 'wf:title')} />
      </div>
      <span className={styles.chip} data-testid="workflow-status" data-state={server?.status ?? 'LOCAL'}>{chip}</span>
      {opened && <div className={styles.toolGroup} role="group" aria-label="Lịch sử">
        <button type="button" className={styles.iconButton} aria-label="Hoàn tác" title="Hoàn tác (Ctrl+Z)" disabled={locked || !history.past.length} onClick={undo}><Undo2 size={16} /></button>
        <button type="button" className={styles.iconButton} aria-label="Làm lại" title="Làm lại (Ctrl+Shift+Z)" disabled={locked || !history.future.length} onClick={redo}><Redo2 size={16} /></button>
      </div>}
      <div className={styles.toolGroup}>
        {opened && <Button variant="outline" size="sm" disabled={busy} onClick={validateLocal}><CheckCheck size={15} />Kiểm tra{errorCount ? <span className={styles.countBadge} aria-label={`${errorCount} vấn đề`}>{errorCount}</span> : null}</Button>}
        {opened && <Button variant="outline" size="sm" aria-expanded={drawerOpen && drawerTab === 'preview'} onClick={() => { setDrawerTab('preview'); setDrawerOpen(!(drawerOpen && drawerTab === 'preview')); }}><Eye size={15} />Xem trước</Button>}
        {!server && opened && <Button variant="outline" size="sm" disabled={readOnly || busy} onClick={saveLocal}><Save size={15} />Lưu cục bộ</Button>}
        {remote && !immutable && opened && <Button size="sm" variant={canPublish ? 'outline' : 'default'} disabled={readOnly || busy || conflict} onClick={() => void saveServer()}><Save size={15} />{server ? 'Lưu lên máy chủ' : 'Tạo bản nháp trên máy chủ'}</Button>}
        {remote && immutable && <Button size="sm" variant="outline" disabled={busy} onClick={() => void saveServer()}><FilePlus2 size={15} />Tạo bản nháp mới từ phiên bản này</Button>}
        {/* UI hint only: the server re-checks role, MFA and maker-checker on every publish. */}
        {canPublish ? <Button size="sm" disabled={busy || !reportReady} aria-describedby="publish-hint" onClick={() => setConfirmPublish(true)}><Send size={15} />Xuất bản</Button>
          : !server && <Button size="sm" disabled aria-describedby="publish-hint" title={publishHint}><Send size={15} />Xuất bản (cần máy chủ)</Button>}
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button type="button" className={styles.iconButton} aria-label="Thêm thao tác"><MoreHorizontal size={16} /></button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {remote && server && <DropdownMenuItem disabled={busy} onSelect={() => void reloadServer()}><RotateCw size={14} />Tải lại từ máy chủ</DropdownMenuItem>}
            {!server && <DropdownMenuItem disabled={busy} onSelect={loadLocal}><RotateCw size={14} />Tải bản đã lưu</DropdownMenuItem>}
            <DropdownMenuItem disabled={locked} onSelect={() => setOpened(false)}><LayoutTemplate size={14} />Chọn mẫu khác…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={readOnly} onCheckedChange={v => setReadOnly(!!v)}>Chỉ xem cục bộ</DropdownMenuCheckboxItem>
            <DropdownMenuItem onSelect={() => { setOpened(true); setDrawerTab('advanced'); setDrawerOpen(true); }}>Nâng cao: JSON / BPMN</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p id="publish-hint" className={styles.publishHint}>{publishHint}</p>
    </header>

    {readOnly && <div role="note" className={styles.notice}>Đang ở chế độ chỉ xem cục bộ: mọi thao tác sửa bị tắt.</div>}
    {immutable && server && <div role="note" className={styles.notice} data-testid="immutable-notice"><strong>Phiên bản {STATUS_LABELS[server.status].toLowerCase()} là bất biến.</strong> Chỉ xem{server.publishedAt ? ` · xuất bản lúc ${new Date(server.publishedAt).toLocaleString('vi-VN')}` : ''} · mã băm <code>{server.contentHash.slice(0, 12)}…</code> · {server.inFlight} lượt chạy đang dùng. Tạo bản nháp mới để thay đổi.</div>}
    {allowSyntheticSession && <WorkflowServerPanel session={session} refresh={refresh} onSession={next => { setSession(next); if (!next) { setServer(null); setReport(null); setConflict(false); } }} onOpen={openVersion} />}
    {conflict && <div ref={conflictRef} tabIndex={-1} role="region" aria-label="Xung đột phiên bản" className={styles.alertBox}>
      <h2>Bản nháp trên máy chủ đã được người khác thay đổi (409 STALE_VERSION)</h2>
      <p>Chỉnh sửa của bạn vẫn được giữ nguyên trong trình vẽ. Chọn cách xử lý:</p>
      <div className={styles.inlineRow}>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => download('workflow.unsaved.json', canonicalJson(doc), 'application/json')}>Xuất chỉnh sửa của tôi</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void overwriteLatest()}>Giữ chỉnh sửa của tôi và lưu lên revision mới nhất</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void reloadServer()}>Bỏ chỉnh sửa và tải bản máy chủ</Button>
      </div>
    </div>}
    {confirmPublish && server && <div role="dialog" aria-modal="false" aria-labelledby="publish-title" className={styles.alertBox}>
      <h2 id="publish-title">Xác nhận xuất bản {server.workflowKey} v{server.versionNo}</h2>
      <p>Nội dung đã xem: revision {server.revision} · mã băm <code>{server.contentHash}</code>. Sau khi xuất bản, phiên bản này bất biến và phiên bản đang xuất bản trước đó (nếu có) chuyển sang đã thay thế. Quy trình chỉ chạy trên Temporal sau khi có hồ sơ thật; trình thiết kế không chạy thử.</p>
      <div className={styles.inlineRow}>
        <Button size="sm" disabled={busy} onClick={() => void publish()}>Xác nhận xuất bản</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirmPublish(false)}>Hủy</Button>
      </div>
    </div>}

    {!opened ? <div className={styles.start}>
      <div>
        <h2>Bắt đầu thiết kế quy trình</h2>
        <ol className={styles.steps}>
          <li>Chọn một mẫu hoặc bản trống.</li><li>Kéo bước từ thư viện bên trái vào sơ đồ, hoặc bấm/Enter để thêm.</li>
          <li>Kéo từ chấm bên phải của bước sang bước khác để nối; chọn loại nhánh ở bảng bên phải.</li>
          <li>Bấm “Kiểm tra”, bấm từng lỗi để tới đúng ô cần sửa, rồi lưu.</li>
        </ol>
        <p className={styles.hint}>Không cần nhập JSON hay mã kỹ thuật. AI chỉ đề xuất; người phụ trách luôn là con người. Nhánh song song và mã thực thi không được hỗ trợ.</p>
        <div className={styles.inlineRow}>
          <Button onClick={() => setOpened(true)}>Mở trình vẽ</Button>
          {hasSaved && !server && <Button variant="outline" onClick={loadLocal}>Tiếp tục bản nháp đã lưu</Button>}
        </div>
      </div>
      <ul className={styles.templates} aria-label="Mẫu quy trình">{TEMPLATES.map(t => <li key={t.id}>
        <button type="button" disabled={locked} onClick={() => { replace(t.build(), `Đã dùng mẫu “${t.title}”. Các ô cần cấu hình được liệt kê trong bảng Kiểm tra.`); setOpened(true); setDrawerTab('issues'); setDrawerOpen(false); }}>
          <span className={styles.badge}>{t.badge}</span><strong>Dùng mẫu: {t.title}</strong><small>{t.description}</small>
        </button></li>)}</ul>
    </div> : <>
      <div className={styles.workspace}>
        <WorkflowPalette document={doc} selected={selected} disabled={locked} onAdd={type => addStep(type)} onSelect={id => { setSelected(id); if (id.startsWith('n_')) api?.center(id.slice(2)); }} />
        <div className={styles.stage}>
          <Canvas document={doc} selected={selected} readOnly={locked} counts={counts} onSelect={setSelected}
            onMove={positions => change(moveNodes(doc, positions))} onConnect={connectSteps} onDelete={deleteElements}
            onDropType={(type, position) => addStep(type, position)} onReady={setApi} />
          {doc.content.nodes.length <= 2 && <p className={styles.canvasHint}>Gợi ý: kéo “Người xử lý” hoặc “AI đề xuất” từ thư viện vào giữa Bắt đầu và Kết thúc, hoặc chọn một mẫu trong menu ⋯.</p>}
        </div>
        <WorkflowInspector doc={doc} selected={selected} disabled={locked} keyLocked={!!server} issues={issues} focus={focus} change={change}
          onSelect={setSelected} onConnect={connectSteps} onDelete={id => deleteElements(id.startsWith('n_') ? [id.slice(2)] : [], id.startsWith('e_') ? [id.slice(2)] : [])} onCenter={id => api?.center(id)} />
      </div>
      <WorkflowDrawer ref={errorsRef} serverRef={reportRef} doc={doc} tab={drawerTab} open={drawerOpen} setTab={setDrawerTab} setOpen={setDrawerOpen}
        issues={issues} checked={checked === doc} server={serverResult} serverNote={serverNote} onIssue={focusIssue}
        advanced={<AdvancedTools doc={doc} disabled={locked} busy={busy} layoutNote={layoutNote} onImport={(f, i) => void importFile(f, i)}
          onExportJson={() => download('workflow.local.json', canonicalJson(doc), 'application/json')}
          onExportBpmn={() => run(() => { if (validateLocalWorkflow(doc.content).some(i => i.detailCode === 'SCHEMA_INVALID')) throw new Error(); download('workflow.local.bpmn', toBpmnXml(doc), 'application/xml'); })} />} />
    </>}
    {error && <div role="alert" className={styles.error}>{error}</div>}
    <p role="status" aria-live="polite" className={styles.srStatus}>{message}</p>
  </section>;
}
