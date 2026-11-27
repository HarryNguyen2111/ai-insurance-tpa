import { useEffect, useRef } from 'react';
import { Sheet } from 'zmp-ui';
import { useWorkspace } from '../state.tsx';

/** Short toast after a user-initiated switch commits: announces the name and offers an explicit return. */
export function SwitchToast() {
  const { toast, dismissToast, requestSwitch } = useWorkspace();
  return (
    <div className="toast-region" aria-live="polite" role="status" data-testid="switch-toast-region">
      {toast && (
        <div className="toast" data-testid="switch-toast">
          <span>{toast.text}</span>
          {toast.returnTo && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                const back = toast.returnTo!;
                dismissToast();
                requestSwitch(back);
              }}
            >
              Quay lại {toast.returnLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Unsaved intake/upload in the CURRENT scope → warn before switching. Choices: stay; keep the draft in its
 * original tenant+service+form scope and switch; discard and switch. Nothing is auto-submitted and the draft
 * is never moved to the target tenant.
 */
export function PendingWorkDialog() {
  const { warning, resolveWarning } = useWorkspace();
  const stayRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (warning) window.setTimeout(() => stayRef.current?.focus(), 50);
  }, [warning]);
  return (
    <Sheet visible={!!warning} onClose={() => resolveWarning('stay')} autoHeight unmountOnClose mask maskClosable={false} swipeToClose={false}>
      <div className="ws-sheet" role="alertdialog" aria-modal="true" aria-labelledby="pw-title" aria-describedby="pw-body" data-testid="pending-work-dialog">
        <h2 id="pw-title">Bạn có hồ sơ chưa gửi</h2>
        <p id="pw-body">
          Hồ sơ bồi thường đang soạn (tệp đã chọn hoặc bản nháp) thuộc <strong>{warning?.scopeLabel}</strong>. Nếu chuyển, hồ
          sơ không được gửi và không chuyển sang đơn vị khác.
        </p>
        <div className="actions">
          <button ref={stayRef} type="button" className="btn-primary" onClick={() => resolveWarning('stay')}>Ở lại</button>
          <button type="button" className="btn-secondary" onClick={() => resolveWarning('keep')}>
            Giữ nháp tại {warning?.scopeLabel} và chuyển
          </button>
          <button type="button" className="btn-danger" onClick={() => resolveWarning('discard')}>Bỏ nháp và chuyển</button>
        </div>
      </div>
    </Sheet>
  );
}
