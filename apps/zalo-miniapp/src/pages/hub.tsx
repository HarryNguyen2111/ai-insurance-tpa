import { useNavigate } from 'zmp-ui';
import { SvgIcon } from '../components/icons.tsx';
import { Section } from '../components/section.tsx';
import { Shell } from '../components/shell.tsx';
import { ContextHeader } from '../components/context-header.tsx';
import { ServiceState } from '../components/service-state.tsx';
import { BenefitList, LoyaltyCard } from './loyalty.tsx';
import { useLoyaltyView, useTpaView, useWorkspace } from '../state.tsx';

function Welcome() {
  const { switcher } = useWorkspace();
  return (
    <header className="welcome" data-testid="hub-welcome">
      <h1 className="sr-only">Tiện ích của tôi</h1>
      <p className="welcome-title">Tiện ích của tôi</p>
      <p className="welcome-sub">Chào mừng, {switcher.profile?.displayNameMasked ?? 'bạn'}!</p>
    </header>
  );
}

function FutureTile() {
  return (
    <button type="button" className="tile" aria-disabled="true" disabled data-testid="tile-utilities">
      <span className="tile-icon" aria-hidden="true"><SvgIcon name="grid" /></span>
      <span>Tiện ích khác<br /><span className="soon">Sắp có</span></span>
    </button>
  );
}

/**
 * H0 — app home. No tenant → the person's own Loyalty360 home (owner decision 2026-11-27): personal data
 * only, no tenant/business data, no medical personalisation. Tenant → that tenant's capability-approved
 * services and minimal activity pointers (no amounts, no health data).
 */
export function HubPage() {
  const navigate = useNavigate();
  const { state, memberships, openSheet, theme } = useWorkspace();
  const loyalty = useLoyaltyView();
  const tpa = useTpaView();
  const personal = state.phase === 'ready' && state.active.kind === 'PERSONAL';
  const tenant = state.phase === 'ready' && state.active.kind === 'TENANT' ? state.active : null;

  return (
    <Shell title="Tiện ích của tôi" back={false} tone="warm" hero={<><ContextHeader /><Welcome /></>}>
      {state.phase !== 'ready' ? (
        <ServiceState view={loyalty.status === 'ready' ? { status: 'failed' } : loyalty} serviceVi="của không gian này" />
      ) : personal && loyalty.status === 'ready' ? (
        <>
          <Section title="Loyalty360 cá nhân" testId="personal-loyalty">
            <LoyaltyCard data={loyalty.data} personal />
            <BenefitList data={loyalty.data} />
          </Section>
          <Section title="Dịch vụ">
            <nav className="tiles" aria-label="Dịch vụ cá nhân">
              <button type="button" className="tile" onClick={() => navigate('/loyalty')} data-testid="tile-loyalty">
                <span className="tile-icon" aria-hidden="true"><SvgIcon name="star" /></span>
                <span>Loyalty360</span>
              </button>
              <FutureTile />
            </nav>
            <p className="hint">Dịch vụ bảo hiểm chỉ hiện khi bạn chọn đơn vị đã cấp quyền.</p>
          </Section>
          <Section title="Đơn vị của bạn" testId="tenant-access">
            {memberships.length === 0 ? (
              <p data-testid="no-membership-help">
                Bạn chưa thuộc đơn vị nào. Khi doanh nghiệp bảo hiểm xác minh và cấp quyền, đơn vị sẽ hiện ở đây. Mini App
                không tự liên kết tài khoản theo tên hay số điện thoại.
              </p>
            ) : (
              <>
                <p>Bạn có {memberships.length} đơn vị được cấp quyền (giả lập).</p>
                <button type="button" className="chip-btn" onClick={openSheet}>Chọn đơn vị</button>
              </>
            )}
          </Section>
        </>
      ) : tenant ? (
        <>
          <Section title={`Dịch vụ của ${tenant.membership.workspace.displayName}`} testId="tenant-services">
            <nav className="tiles" aria-label="Dịch vụ của đơn vị">
              {tenant.membership.services.includes('LOYALTY360') && (
                <button type="button" className="tile" onClick={() => navigate('/loyalty')} data-testid="tile-loyalty">
                  <span className="tile-icon" aria-hidden="true"><SvgIcon name="star" /></span>
                  <span>Loyalty360</span>
                </button>
              )}
              {tenant.membership.services.includes('TPA_INSURANCE') && (
                <button type="button" className="tile" onClick={() => navigate('/home')} data-testid="tile-tpa">
                  <span className="tile-icon" aria-hidden="true"><SvgIcon name="shield" /></span>
                  <span>Bảo hiểm sức khỏe</span>
                </button>
              )}
              <FutureTile />
            </nav>
          </Section>
          <Section title="Hoạt động gần đây" action={<button type="button" className="link" onClick={() => navigate('/hub/activity')}>Xem tất cả</button>}>
            <ActivityPointers />
          </Section>
          {tpa.status === 'unavailable' && <p className="hint">Đơn vị này chưa bật dịch vụ bảo hiểm cho bạn.</p>}
          {theme.warnings.includes('LOW_SURFACE_CONTRAST') && (
            <p className="hint" data-testid="theme-warning">
              Màu thương hiệu của đơn vị có độ tương phản thấp với nền (cảnh báo OD-WS1). Ứng dụng dùng màu chữ và viền dẫn
              xuất để dễ đọc; màu gốc của đơn vị không bị thay đổi.
            </p>
          )}
          {tenant.themeFallback && (
            <p className="hint" data-testid="theme-fallback">Không đọc được cấu hình màu của đơn vị; đang dùng giao diện trung tính.</p>
          )}
        </>
      ) : null}
    </Shell>
  );
}

/**
 * H4 pointers: capability-filtered, minimal metadata for the ACTIVE context only. No amounts, diagnoses or
 * claim content; opening one goes to the scoped service screen, which re-checks access.
 */
export function ActivityPointers() {
  const navigate = useNavigate();
  const tpa = useTpaView();
  const loyalty = useLoyaltyView();
  const items: { key: string; text: string; to: string; icon: 'shield' | 'star' }[] = [];
  if (tpa.status === 'ready') {
    const open = tpa.data.claims.filter((c) => !['PAID', 'REJECTED', 'CLOSED_EXPIRED'].includes(c.status)).length;
    items.push({ key: 'tpa', text: open ? `Bảo hiểm: ${open} hồ sơ đang xử lý` : 'Bảo hiểm: không có hồ sơ đang xử lý', to: '/claims', icon: 'shield' });
  }
  if (loyalty.status === 'ready') items.push({ key: 'loy', text: 'Loyalty360: xem hạng và ưu đãi', to: '/loyalty', icon: 'star' });
  if (!items.length) return <p className="hint" data-testid="activity-empty">Chưa có hoạt động.</p>;
  return (
    <ul className="recent" aria-label="Hoạt động gần đây" data-testid="activity-list">
      {items.map((i) => (
        <li key={i.key}>
          <button type="button" className="recent-item" onClick={() => navigate(i.to)}>
            <span className="recent-icon" aria-hidden="true"><SvgIcon name={i.icon} /></span>
            <span className="recent-body"><strong>{i.text}</strong></span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ActivityPage() {
  return (
    <Shell title="Hoạt động" back={false} tone="warm" hero={<ContextHeader />}>
      <h1 className="sr-only">Hoạt động</h1>
      <Section title="Hoạt động của không gian đang dùng">
        <ActivityPointers />
        <p className="hint">Chỉ hiển thị con trỏ tối thiểu của không gian đang dùng; không gộp hồ sơ của nhiều đơn vị.</p>
      </Section>
    </Shell>
  );
}
