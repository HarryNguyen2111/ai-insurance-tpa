import type { ServiceView } from '../state.tsx';
import { useWorkspace } from '../state.tsx';

/**
 * Neutral, data-free rendering for every non-ready service state. Shared by hub/Loyalty360/TPA screens so
 * "switching", "failed", "pick a tenant" and "service not enabled" look and read the same everywhere.
 */
export function ServiceState({ view, serviceVi }: { view: Exclude<ServiceView<unknown>, { status: 'ready' }>; serviceVi: string }) {
  const { openSheet } = useWorkspace();
  switch (view.status) {
    case 'loading':
      return (
        <div className="card skeleton" role="status" aria-busy="true" data-testid="service-loading">
          <p>{view.label ? `Đang mở ${view.label}…` : 'Đang tải…'}</p>
          <span className="sk-line" aria-hidden="true" />
          <span className="sk-line short" aria-hidden="true" />
        </div>
      );
    case 'failed':
      return (
        <div className="card" data-testid="service-failed">
          <p>Chưa có không gian nào được mở nên không hiển thị dữ liệu {serviceVi}.</p>
        </div>
      );
    case 'needs-tenant':
      return (
        <div className="card notice" data-testid="service-needs-tenant">
          <p>{serviceVi} là dịch vụ của doanh nghiệp bảo hiểm. Hãy chọn đơn vị đã cấp quyền cho bạn để xem.</p>
          <button type="button" className="chip-btn" onClick={openSheet}>Chọn đơn vị</button>
        </div>
      );
    case 'unavailable':
      return (
        <div className="card notice" data-testid="service-unavailable">
          <p>
            <strong>{view.label}</strong> chưa bật dịch vụ {serviceVi} cho bạn. Quyền dịch vụ do đơn vị quyết định; Mini
            App không tự bật.
          </p>
        </div>
      );
  }
}
