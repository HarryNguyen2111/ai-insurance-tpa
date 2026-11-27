import { useNavigate } from 'zmp-ui';
import { Section } from '../components/section.tsx';
import { Shell } from '../components/shell.tsx';
import { ContextHeader } from '../components/context-header.tsx';
import { SYNTHETIC_MEMBERSHIPS, SYNTHETIC_TPA, WS } from '../fixtures/workspaces.ts';
import { usePrototype, useWorkspace } from '../state.tsx';

const DECISION_VI = { PENDING: 'Chưa quyết định', ACCEPTED: 'Đã đồng ý', DENIED: 'Không đồng ý' } as const;

/**
 * H5 — personal settings & per-service consents. Personal identity is masked display only (data class a).
 * Consents are per tenant + service: the TPA consent shown is the ACTIVE tenant's; Loyalty360 consent has no
 * contract yet (gap G9) so it is shown as not available instead of borrowing the insurance consent.
 */
export function PersonalPage() {
  const navigate = useNavigate();
  const ws = useWorkspace();
  const { decision } = usePrototype();
  const { switcher, adapter, state, touch, memberships } = ws;
  const tenant = state.phase === 'ready' && state.active.kind === 'TENANT' ? state.active : null;
  const c = adapter.controls;

  const toggle = (fn: () => void) => {
    fn();
    touch();
  };
  const revokeTarget = memberships.find((m) => m.membershipId !== tenant?.id) ?? null;
  // Deep-link simulation: a claim that belongs to tenant B (or A when B is active) — the app must deny it.
  const foreignTenant = tenant?.id === WS.B ? WS.A : WS.B;
  const foreignClaim = SYNTHETIC_TPA[foreignTenant]!.claims[0]!;

  return (
    <Shell title="Cá nhân" back={false} tone="warm" hero={<ContextHeader />}>
      <h1 className="sr-only">Cá nhân</h1>
      <Section title="Tài khoản">
        <p data-testid="profile-name">Tên hiển thị (đã che): <strong>{switcher.profile?.displayNameMasked ?? '—'}</strong></p>
        <p className="hint">
          Danh tính cá nhân tách khỏi đơn vị: đổi không gian không đổi tài khoản Zalo. Không lưu CCCD, số điện thoại hay
          tài khoản ngân hàng trong Mini App.
        </p>
        <p className="hint" data-testid="preferred">
          Không gian ưu tiên khi mở lại: <strong>{switcher.activeId ? switcher.label(switcher.activeId) : '—'}</strong> (chỉ
          giữ trong bộ nhớ; luôn được máy chủ kiểm tra lại quyền).
        </p>
      </Section>

      <Section title="Đồng ý theo từng dịch vụ" testId="service-consents">
        <ul className="kv-list">
          <li>
            <span>Bảo hiểm sức khỏe {tenant ? `— ${tenant.membership.workspace.displayName}` : ''}</span>
            <strong data-testid="consent-tpa">{tenant?.snapshot.tpa ? DECISION_VI[decision] : 'Không áp dụng'}</strong>
          </li>
          <li>
            <span>Loyalty360</span>
            <strong data-testid="consent-loyalty">Chưa có (chờ hợp đồng đồng ý riêng)</strong>
          </li>
        </ul>
        {tenant?.snapshot.tpa && (
          <button type="button" className="chip-btn" onClick={() => navigate('/consent')}>Xem điều khoản bảo hiểm</button>
        )}
      </Section>

      <Section title="Bảng điều khiển mô phỏng" testId="prototype-controls">
        <p className="hint">Chỉ dùng để thử các tình huống; không có máy chủ thật. Mọi trạng thái mất khi tải lại.</p>
        <label className="check">
          <input type="checkbox" checked={c.offline} onChange={(e) => toggle(() => { c.offline = e.target.checked; })} />
          Mất kết nối mạng (mô phỏng)
        </label>
        <label className="check">
          <input type="checkbox" checked={c.failNextSwitch} onChange={(e) => toggle(() => { c.failNextSwitch = e.target.checked; })} />
          Lần chuyển đơn vị tiếp theo bị lỗi máy chủ
        </label>
        {revokeTarget && (
          <button
            type="button"
            className="chip-btn"
            onClick={() => toggle(() => c.revoked.add(revokeTarget.membershipId))}
            data-testid="revoke-other"
          >
            Thu hồi quyền tại {revokeTarget.workspace.displayName} (phía máy chủ)
          </button>
        )}
        {tenant && (
          <button type="button" className="chip-btn" onClick={() => toggle(() => c.revoked.add(tenant.id))} data-testid="revoke-active">
            Thu hồi quyền đơn vị đang dùng
          </button>
        )}
        <button
          type="button"
          className="chip-btn"
          onClick={() => toggle(() => c.brandingBumped.add(SYNTHETIC_MEMBERSHIPS.A.membershipId))}
          data-testid="branding-update"
        >
          An Bình đổi màu thương hiệu (phiên bản mới)
        </button>
        <button
          type="button"
          className="chip-btn"
          onClick={async () => {
            await switcher.refreshMemberships().catch(() => undefined);
            touch();
          }}
          data-testid="refresh-memberships"
        >
          Kiểm tra lại quyền với máy chủ
        </button>
        <button
          type="button"
          className="chip-btn"
          onClick={() => navigate(`/claims/${foreignClaim.claimId}`)}
          data-testid="foreign-deeplink"
        >
          Mở liên kết sâu tới hồ sơ của đơn vị khác
        </button>
      </Section>
    </Shell>
  );
}
