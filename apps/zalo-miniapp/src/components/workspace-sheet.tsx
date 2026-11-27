import { useEffect, useRef, useState } from 'react';
import { Sheet } from 'zmp-ui';
import { SvgIcon } from './icons.tsx';
import { TenantMark } from './context-header.tsx';
import { PERSONAL } from '../lib/context-ring.ts';
import { PERSONAL_LABEL } from '../lib/context-switcher.ts';
import type { ServiceKey } from '../adapters/ports.ts';
import { useWorkspace } from '../state.tsx';

const SERVICE_VI: Record<ServiceKey, string> = { TPA_INSURANCE: 'Bảo hiểm', LOYALTY360: 'Loyalty360' };

/**
 * H1 workspace chooser. Normal labelled buttons in the SAME stable order the double tap walks, so keyboard,
 * screen-reader and motor-impaired users have an equivalent of the gesture. zmp-ui Sheet supplies the
 * visual bottom sheet; dialog semantics/focus handling are added here (Sheet has none).
 */
export function WorkspaceSheet() {
  const ws = useWorkspace();
  const { sheetOpen, closeSheet, ring, memberships, activeId, state, requestSwitch, switcher, touch } = ws;
  const listRef = useRef<HTMLOListElement>(null);
  const [refreshNote, setRefreshNote] = useState('');
  const [accessNote, setAccessNote] = useState(false);

  useEffect(() => {
    if (!sheetOpen) {
      setRefreshNote('');
      setAccessNote(false);
      return;
    }
    const opener = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => {
      const current = listRef.current?.querySelector<HTMLButtonElement>('[aria-current="true"]');
      (current ?? listRef.current?.querySelector<HTMLButtonElement>('button'))?.focus();
    }, 50);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSheet();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [sheetOpen, closeSheet]);

  const choose = (id: string) => {
    closeSheet();
    requestSwitch(id);
  };

  const refresh = async () => {
    setRefreshNote('Đang kiểm tra lại quyền với máy chủ mô phỏng…');
    try {
      await switcher.refreshMemberships();
      setRefreshNote(`Đã cập nhật: ${switcher.memberships.length} đơn vị được cấp quyền.`);
    } catch {
      setRefreshNote('Không làm mới được (mất kết nối mô phỏng). Danh sách hiện tại có thể đã cũ.');
    }
    touch();
  };

  const n = memberships.length;
  const pendingTarget = state.phase === 'switching' ? state.target : null;

  return (
    <Sheet visible={sheetOpen} onClose={closeSheet} autoHeight unmountOnClose swipeToClose mask maskClosable>
      <div className="ws-sheet" role="dialog" aria-modal="true" aria-labelledby="ws-sheet-title" data-testid="workspace-sheet">
        <h2 id="ws-sheet-title">Chọn không gian</h2>
        <p className="hint" data-testid="ws-current">
          Đang dùng: <strong>{activeId ? ws.label(activeId) : pendingTarget ? `đang chuyển sang ${ws.label(pendingTarget)}` : 'chưa chọn'}</strong>
        </p>
        {n === 0 && (
          <p className="card notice" data-testid="ws-empty">
            Bạn chưa có đơn vị nào. Loyalty360 cá nhân vẫn dùng được. Để dùng dịch vụ của doanh nghiệp bảo hiểm, đơn vị
            đó cần xác minh và cấp quyền cho bạn; Mini App không tự cấp quyền.
          </p>
        )}
        {n === 1 && (
          <p className="hint" data-testid="ws-single">Bạn chỉ có một đơn vị nên không có đơn vị khác để chuyển; bạn có thể quay về Loyalty360 cá nhân.</p>
        )}
        <ol ref={listRef} className="ws-list" aria-label="Danh sách không gian, theo thứ tự chuyển nhanh">
          {ring.map((id, i) => {
            const m = memberships.find((x) => x.membershipId === id);
            const current = id === activeId;
            const label = id === PERSONAL ? PERSONAL_LABEL : (m?.workspace.displayName ?? '');
            return (
              <li key={id}>
                <button
                  type="button"
                  className={current ? 'ws-item current' : 'ws-item'}
                  aria-current={current ? 'true' : undefined}
                  onClick={() => (current ? closeSheet() : choose(id))}
                  data-testid={`ws-option-${id === PERSONAL ? 'personal' : m?.workspace.shortName}`}
                >
                  <span className="ws-order" aria-hidden="true">{i + 1}</span>
                  <TenantMark shortName={m?.workspace.shortName ?? ''} personal={id === PERSONAL} size={36} />
                  <span className="ws-body">
                    <strong>{label}</strong>
                    <span className="ws-badges">
                      {id === PERSONAL ? (
                        <span className="badge">Cá nhân</span>
                      ) : (
                        m?.services.map((s) => <span key={s} className="badge">{SERVICE_VI[s]}</span>)
                      )}
                      {id === pendingTarget && <span className="badge pending">Đang chuyển…</span>}
                    </span>
                  </span>
                  {current && (
                    <span className="ws-check">
                      <SvgIcon name="check" size={20} />
                      <span className="sr-only">(đang dùng)</span>
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
        {ring.length > 1 && <p className="hint">Nhấn đúp vào biểu tượng không gian để chuyển lần lượt theo thứ tự trên, rồi quay lại đầu danh sách.</p>}
        <div className="row">
          <button type="button" className="chip-btn" onClick={refresh} data-testid="ws-refresh">Làm mới danh sách</button>
          <button type="button" className="chip-btn" onClick={() => setAccessNote(true)}>Yêu cầu quyền đơn vị khác</button>
        </div>
        {refreshNote && <p className="hint" role="status">{refreshNote}</p>}
        {accessNote && (
          <p className="hint" role="status">
            Chưa có trong bản thử nghiệm. Quyền chỉ do đơn vị cấp sau khi xác minh (#21); Mini App không tự thêm đơn vị.
          </p>
        )}
        <button type="button" className="btn-close" onClick={closeSheet}>Đóng</button>
      </div>
    </Sheet>
  );
}
