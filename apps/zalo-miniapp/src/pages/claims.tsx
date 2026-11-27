import { Button, useNavigate, useParams } from 'zmp-ui';
import { Shell } from '../components/shell.tsx';
import { ServiceState } from '../components/service-state.tsx';
import { useTpaView } from '../state.tsx';
import { TRACKER_STEPS, statusView } from '../lib/claim-status.ts';
import { formatVnd } from '../lib/money.ts';

const BENEFIT_VI: Record<string, string> = {
  OUTPATIENT: 'Ngoại trú',
  INPATIENT: 'Nội trú',
  DENTAL: 'Nha khoa',
  MATERNITY: 'Thai sản',
  ACCIDENT: 'Tai nạn',
  HOSPITAL_INCOME: 'Trợ cấp nằm viện',
};

const viDate = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/');

/** Same text for "does not exist" and "belongs to another tenant/no access": existence is never revealed. */
export const CONCEALED_VI = 'Không tìm thấy hồ sơ trong đơn vị đang dùng, hoặc bạn không có quyền xem.';

export function ClaimsPage() {
  const navigate = useNavigate();
  const view = useTpaView();
  if (view.status !== 'ready') {
    return (
      <Shell title="Hồ sơ của tôi">
        <ServiceState view={view} serviceVi="Bảo hiểm sức khỏe" />
      </Shell>
    );
  }
  return (
    <Shell title="Hồ sơ của tôi">
      <p className="meta" data-testid="claims-scope">Đơn vị: {view.label}</p>
      <ul className="claims" aria-label="Danh sách hồ sơ mẫu">
        {view.data.claims.map((c) => {
          const v = statusView(c.status);
          return (
            <li key={c.claimId}>
              <button type="button" className="claim" onClick={() => navigate(`/claims/${c.claimId}`)} data-testid={`claim-${c.claimCode}`}>
                <span className="row space">
                  <strong>{c.claimCode}</strong>
                  <span className={`chip ${v.tone}`}>{v.labelVi}</span>
                </span>
                <span className="row space meta">
                  <span>{BENEFIT_VI[c.benefitType]} · {viDate(c.visitDate)}</span>
                  <span>{formatVnd(c.totalRequested)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Shell>
  );
}

export function ClaimDetailPage() {
  const navigate = useNavigate();
  const { claimId = '' } = useParams();
  const view = useTpaView();
  if (view.status !== 'ready') {
    return (
      <Shell title="Hồ sơ">
        <ServiceState view={view} serviceVi="Bảo hiểm sức khỏe" />
      </Shell>
    );
  }
  // Looked up ONLY in the active tenant's committed snapshot (backend object checks remain the authority).
  const detail = view.data.claimDetails[claimId];
  if (!detail) {
    return (
      <Shell title="Không tìm thấy hồ sơ">
        <p className="card notice" role="alert" data-testid="claim-concealed">{CONCEALED_VI}</p>
      </Shell>
    );
  }
  const { claim } = detail;
  const v = statusView(claim.status);
  const eob = view.data.eobs[claim.claimId];
  return (
    <Shell title={`Hồ sơ ${claim.claimCode}`}>
      <section className="card" aria-labelledby="summary-title">
        <h2 id="summary-title">Thông tin hồ sơ</h2>
        <dl className="kv">
          <dt>Trạng thái</dt><dd><span className={`chip ${v.tone}`} data-testid="claim-status">{v.labelVi}</span></dd>
          <dt>Quyền lợi</dt><dd>{BENEFIT_VI[claim.benefitType]}</dd>
          <dt>Ngày khám</dt><dd>{viDate(claim.visitDate)}</dd>
          <dt>Số tiền yêu cầu</dt><dd data-testid="claim-requested">{formatVnd(claim.totalRequested)}</dd>
        </dl>
      </section>
      <section className="card" aria-labelledby="tracker-title">
        <h2 id="tracker-title">Tiến trình</h2>
        <ol className="tracker" data-testid="tracker">
          {TRACKER_STEPS.map((label, i) => (
            <li
              key={label}
              className={i < v.step ? 'done' : i === v.step ? 'current' : 'todo'}
              aria-current={i === v.step ? 'step' : undefined}
            >
              {label}
            </li>
          ))}
        </ol>
      </section>
      {detail.supplementAllowed && (
        <section className="card notice" role="status">
          <h2>Cần bổ sung chứng từ</h2>
          <p>
            Vui lòng bổ sung trước {detail.supplementDeadline ? viDate(detail.supplementDeadline) : 'hạn được thông báo'}.
            Quá 15 ngày không bổ sung, hồ sơ sẽ tự đóng.
          </p>
          <Button fullWidth variant="secondary" onClick={() => navigate('/claims/new')}>Bổ sung chứng từ (mô phỏng)</Button>
        </section>
      )}
      {eob && (
        <Button fullWidth onClick={() => navigate(`/claims/${claim.claimId}/eob`)}>Xem bảng giải trình chi trả</Button>
      )}
    </Shell>
  );
}
