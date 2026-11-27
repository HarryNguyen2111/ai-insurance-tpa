import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import { useNavigate } from 'zmp-ui';
import { SvgIcon, type IconName } from './icons.tsx';
import { createTapArbiter } from '../lib/tap-arbiter.ts';
import { PERSONAL } from '../lib/context-ring.ts';
import { useWorkspace } from '../state.tsx';

/** Rounded-square tenant mark: initials on the tenant brand (never a logo URL from the tenant). */
export function TenantMark({ shortName, personal, size = 40 }: { shortName: string; personal?: boolean; size?: number }) {
  return (
    <span className={personal ? 'tenant-mark personal' : 'tenant-mark'} style={{ width: size, height: size }} aria-hidden="true">
      {personal ? <SvgIcon name="star" size={Math.round(size * 0.5)} /> : shortName}
    </span>
  );
}

/** Person avatar: circle, neutral grey, person initials — deliberately unlike the tenant square. */
function PersonAvatar() {
  const navigate = useNavigate();
  const { switcher } = useWorkspace();
  const p = switcher.profile;
  return (
    <button
      type="button"
      className="person-avatar"
      onClick={() => navigate('/hub/personal', { animate: true })}
      aria-label={`Tài khoản của bạn${p ? `: ${p.displayNameMasked}` : ''}. Mở trang cá nhân`}
      data-testid="person-avatar"
    >
      <span className="person-circle" aria-hidden="true">{p?.initials ?? <SvgIcon name="user" size={20} />}</span>
      <span className="avatar-caption" aria-hidden="true">Tài khoản</span>
    </button>
  );
}

const REASON_VI = {
  REVOKED: 'quyền truy cập đơn vị này không còn hiệu lực (đã kiểm tra lại với máy chủ mô phỏng).',
  OFFLINE: 'không có kết nối mạng (mô phỏng).',
  ERROR: 'máy chủ mô phỏng báo lỗi.',
  NOT_FOUND: 'đơn vị không có trong danh sách quyền hiện tại.',
} as const;

/** Workspace avatar: single tap → chooser sheet; double tap → next context in the stable ring. */
function WorkspaceAvatar() {
  const ws = useWorkspace();
  const { state, quickSwitch } = ws;
  const hintId = useId();
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const [arbiter] = useState(() =>
    createTapArbiter({
      now: () => performance.now(),
      schedule: (fn, ms) => window.setTimeout(fn, ms),
      cancel: (h) => window.clearTimeout(h as number),
      onSingle: () => wsRef.current.openSheet(),
      onDouble: () => wsRef.current.requestSwitch('NEXT'),
    }),
  );
  useEffect(() => () => arbiter.reset(), [arbiter]);

  // Immediate target indication while switching (name only, no target data/colour yet).
  let name: string;
  let caption: string;
  let personal: boolean;
  let short = '';
  if (state.phase === 'switching') {
    name = state.targetLabel;
    caption = 'Đang chuyển…';
    personal = state.target === PERSONAL;
    short = ws.memberships.find((m) => m.membershipId === state.target)?.workspace.shortName ?? '';
  } else if (state.phase === 'ready') {
    personal = state.active.kind === 'PERSONAL';
    name = ws.label(state.active.id);
    caption = personal ? 'Không gian' : 'Đơn vị';
    if (state.active.kind === 'TENANT') short = state.active.membership.workspace.shortName;
  } else {
    name = state.phase === 'failed' ? 'Chưa chọn được đơn vị' : 'Đang tải…';
    caption = 'Đơn vị';
    personal = true;
  }
  const busy = state.phase === 'switching';
  const onClick = (e: MouseEvent<HTMLButtonElement>) =>
    // detail === 0 → keyboard / screen-reader activation → explicit chooser, no timing gesture.
    // While a switch is pending a double tap is still recognised (and then ignored by the switcher), so it
    // never degrades into two single taps that would open the sheet.
    arbiter.tap({ assistive: e.detail === 0, quickSwitch });

  return (
    <div className="workspace-slot">
      <button
        type="button"
        className={`workspace-avatar${busy ? ' busy' : ''}`}
        onClick={onClick}
        aria-haspopup="dialog"
        aria-busy={busy}
        aria-label={`${busy ? `Đang chuyển sang ${name}` : `${caption} đang dùng: ${name}`}. Chọn không gian`}
        aria-describedby={quickSwitch ? hintId : undefined}
        data-testid="workspace-avatar"
        data-context={state.phase === 'ready' ? state.active.id : ''}
      >
        <TenantMark shortName={short} personal={personal} />
        <span className="workspace-text">
          <span className="avatar-caption">{caption}</span>
          <span className="workspace-name" data-testid="workspace-name">{name}</span>
        </span>
        <SvgIcon name="chevron" size={18} />
      </button>
      {quickSwitch && (
        <span id={hintId} className="quick-hint" data-testid="quick-switch-hint">Nhấn đúp để chuyển nhanh</span>
      )}
    </div>
  );
}

/** Placeholder slot for #107 (notification centre). No count, no logic, no fabricated alerts. */
function BellPlaceholder() {
  const [note, setNote] = useState(false);
  return (
    <span className="bell-slot">
      <button
        type="button"
        className="bell"
        aria-disabled="true"
        aria-label="Thông báo — chưa khả dụng trong bản thử nghiệm"
        onClick={() => setNote((v) => !v)}
        data-testid="bell-placeholder"
      >
        <SvgIcon name="bell" size={20} />
      </button>
      {note && <span className="bell-note" role="status">Trung tâm thông báo sẽ làm ở issue #107; chưa có thông báo nào.</span>}
    </span>
  );
}

function FailureBanner() {
  const { state, requestSwitch, openSheet, label, ring } = useWorkspace();
  if (state.phase !== 'failed') return null;
  const back = state.from && ring.includes(state.from) ? state.from : null;
  return (
    <div className="card failure" role="alert" data-testid="switch-failure">
      <p>
        <strong>Không chuyển được sang {state.targetLabel}</strong>: {REASON_VI[state.reason]} Không có dữ liệu nào của đơn vị
        được hiển thị.
      </p>
      <span className="row">
        {state.reason !== 'REVOKED' && state.reason !== 'NOT_FOUND' && (
          <button type="button" className="chip-btn" onClick={() => requestSwitch(state.target)}>Thử lại</button>
        )}
        {back && <button type="button" className="chip-btn" onClick={() => requestSwitch(back)}>Quay lại {label(back)}</button>}
        <button type="button" className="chip-btn" onClick={openSheet}>Chọn không gian khác</button>
      </span>
    </div>
  );
}

export type ServiceBadge = { label: string; icon: IconName };

/**
 * Context header shared by the hub and both services (reference welcome area): person avatar, workspace
 * avatar near the top, bell slot; optional service row (label + way back to the hub) so Loyalty360 and TPA
 * are visibly different services under the same tenant theme.
 */
export function ContextHeader({ service }: { service?: ServiceBadge }) {
  const navigate = useNavigate();
  return (
    <div className="ctx" data-testid="context-header">
      <div className="ctx-row">
        <PersonAvatar />
        <WorkspaceAvatar />
        <BellPlaceholder />
      </div>
      {service && (
        <div className="service-row" data-testid="service-row">
          <button type="button" className="link small" onClick={() => navigate('/hub', { animate: true, direction: 'backward' })}>
            ‹ Trang tiện ích
          </button>
          <span className="service-badge" data-testid="service-badge">
            <SvgIcon name={service.icon} size={16} /> {service.label}
          </span>
        </div>
      )}
      <FailureBanner />
    </div>
  );
}
