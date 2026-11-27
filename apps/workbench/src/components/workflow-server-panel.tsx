'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { WorkflowApiFailure, workflowApi, type MeView, type WorkflowSession, type WorkflowSummary, type WorkflowVersion } from '@/lib/workflow-api';
import styles from './workflow-designer.module.css';

export const STATUS_LABELS: Record<WorkflowSummary['status'], string> = { DRAFT: 'Bản nháp', PUBLISHED: 'Đã xuất bản', RETIRED: 'Đã thay thế', REVOKED: 'Đã thu hồi' };
const BEARER = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const failureText = (error: unknown) => error instanceof WorkflowApiFailure ? `${error.code} · ${error.message}` : 'Máy chủ quy trình không thực hiện được yêu cầu.';

interface Props {
  session: WorkflowSession | null;
  refresh: number;
  onSession(session: WorkflowSession | null): void;
  onOpen(version: WorkflowVersion): void;
}

/** S-V1 + session. The bearer lives only in React memory; no storage, cookie or URL. */
export function WorkflowServerPanel({ session, refresh, onSession, onOpen }: Props) {
  const [token, setToken] = useState(''), [me, setMe] = useState<MeView | null>(null), [membershipId, setMembershipId] = useState('');
  const [items, setItems] = useState<WorkflowSummary[] | null>(null), [versions, setVersions] = useState<{ id: string; items: WorkflowSummary[] } | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error' | 'forbidden'>('idle'), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const connected = !!session?.membershipContext;

  useEffect(() => {
    if (!session?.membershipContext) { setItems(null); return; }
    let cancelled = false;
    setState('loading');
    workflowApi(session).listDefinitions().then(page => { if (!cancelled) { setItems(page.items); setState('idle'); } })
      .catch(cause => { if (!cancelled) { setItems(null); setState(cause instanceof WorkflowApiFailure && cause.status === 403 ? 'forbidden' : 'error'); setError(failureText(cause)); } });
    return () => { cancelled = true; };
  }, [session, refresh]);

  async function task(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (cause) { if (alive.current) setError(failureText(cause)); } finally { if (alive.current) setBusy(false); }
  }
  const connect = () => task(async () => {
    const value = token.trim();
    if (!BEARER.test(value)) throw new WorkflowApiFailure(401, 'UNAUTHENTICATED', 'Access token không đúng định dạng JWT.');
    const next = await workflowApi({ authorization: `Bearer ${value}` }).me();
    if (!alive.current) return;
    setMe(next); setMembershipId(next.memberships[0]?.membershipId ?? ''); setToken('');
    onSession({ authorization: `Bearer ${value}` });
  });
  const choose = () => task(async () => {
    if (!session) return;
    const context = await workflowApi(session).selectMembership(membershipId);
    if (alive.current) onSession({ authorization: session.authorization, membershipContext: context.contextToken });
  });
  const disconnect = () => { setMe(null); setItems(null); setVersions(null); setError(''); onSession(null); };
  const showVersions = (id: string) => task(async () => {
    if (!session) return;
    const page = await workflowApi(session).listVersions(id);
    if (alive.current) setVersions({ id, items: page.items });
  });
  const open = (id: string, versionNo: number) => task(async () => {
    if (!session) return;
    const version = await workflowApi(session).getVersion(id, versionNo);
    if (alive.current) onOpen(version);
  });

  return <details className={styles.server} aria-labelledby="workflow-server-title" open={connected || undefined}>
    <summary><h2 id="workflow-server-title">Máy chủ quy trình</h2> <span className={styles.hint}>{connected ? 'đã kết nối' : 'lưu, kiểm tra và xuất bản'}</span></summary>
    <p role="note" className={styles.hint}>Workbench chưa có đăng nhập OIDC (nhà cung cấp chưa chốt, #21). Dùng access token tổng hợp/thử nghiệm; token chỉ giữ trong bộ nhớ tab, không lưu. Quyền, MFA và maker-checker luôn do máy chủ kiểm tra.</p>
    {!session && <form className={styles.inline} onSubmit={event => { event.preventDefault(); void connect(); }}>
      <label>Access token<input type="password" autoComplete="off" spellCheck={false} value={token} onChange={e => setToken(e.target.value)} disabled={busy} /></label>
      <Button type="submit" variant="outline" disabled={busy || !token}>Kết nối máy chủ</Button>
    </form>}
    {session && !connected && me && <div className={styles.inline}>
      {me.memberships.length ? <label>Tư cách thành viên<select value={membershipId} onChange={e => setMembershipId(e.target.value)} disabled={busy}>
        {me.memberships.map(m => <option key={m.membershipId} value={m.membershipId}>{m.membershipId.slice(0, 8)} · {m.roles.join(', ')}</option>)}
      </select></label> : <p>Không có tư cách thành viên nào.</p>}
      <Button variant="outline" disabled={busy || !membershipId} onClick={() => void choose()}>Chọn tư cách</Button>
      {!me.mfaVerified && <span className={styles.chip}>Chưa xác thực MFA: mọi thao tác ghi sẽ bị từ chối</span>}
    </div>}
    {session && <Button variant="outline" disabled={busy} onClick={disconnect}>Ngắt kết nối</Button>}
    {connected && <div aria-live="polite">
      {state === 'loading' && <p role="status">Đang tải danh sách quy trình…</p>}
      {state === 'forbidden' && <p role="status">Không có quyền xem quy trình của tổ chức này.</p>}
      {state === 'error' && <p role="status">Không tải được danh sách quy trình.</p>}
      {items && !items.length && <p role="status">Chưa có quy trình nào trên máy chủ.</p>}
      {items && items.length > 0 && <table className={styles.table} aria-label="Danh sách quy trình">
        <thead><tr><th>Mã</th><th>Tên</th><th>Phiên bản mới nhất</th><th /></tr></thead>
        <tbody>{items.map(item => <tr key={item.definitionId}>
          <td><code>{item.workflowKey}</code></td><td>{item.title}</td><td>v{item.versionNo} · {STATUS_LABELS[item.status]}</td>
          <td><Button variant="outline" disabled={busy} onClick={() => void showVersions(item.definitionId)}>Phiên bản của {item.workflowKey}</Button></td>
        </tr>)}</tbody>
      </table>}
      {versions && <ul aria-label="Các phiên bản">{versions.items.map(v => <li key={v.versionNo}>
        v{v.versionNo} · {STATUS_LABELS[v.status]} · {new Date(v.updatedAt).toLocaleString('vi-VN')}{' '}
        <Button variant="outline" disabled={busy} onClick={() => void open(versions.id, v.versionNo)}>Mở {v.workflowKey} v{v.versionNo}</Button>
      </li>)}</ul>}
    </div>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </details>;
}
