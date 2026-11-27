import { useParams } from 'zmp-ui';
import { Shell } from '../components/shell.tsx';
import { ServiceState } from '../components/service-state.tsx';
import { useTpaView } from '../state.tsx';
import { CONCEALED_VI } from './claims.tsx';
import { formatVnd } from '../lib/money.ts';

const LINE_STATUS_VI = { APPROVED: 'Chi trả toàn bộ', PARTIAL: 'Chi trả một phần', REJECTED: 'Không chi trả' } as const;
const LINE_TONE = { APPROVED: 'success', PARTIAL: 'action', REJECTED: 'danger' } as const;

export function EobPage() {
  const { claimId = '' } = useParams();
  const view = useTpaView();
  if (view.status !== 'ready') {
    return (
      <Shell title="Bảng giải trình">
        <ServiceState view={view} serviceVi="Bảo hiểm sức khỏe" />
      </Shell>
    );
  }
  if (!view.data.claimDetails[claimId]) {
    return (
      <Shell title="Bảng giải trình">
        <p className="card notice" role="alert" data-testid="claim-concealed">{CONCEALED_VI}</p>
      </Shell>
    );
  }
  const eob = view.data.eobs[claimId];
  if (!eob) {
    return (
      <Shell title="Bảng giải trình">
        <p className="card notice" role="alert">Chưa có bảng giải trình cho hồ sơ này.</p>
      </Shell>
    );
  }
  const s = eob.summary;
  return (
    <Shell title="Bảng giải trình chi trả">
      <section className="card" aria-labelledby="eob-summary">
        <h2 id="eob-summary">Hồ sơ {eob.claimCode}</h2>
        <p className="meta" data-testid="eob-version">
          Phiên bản EOB {eob.eobVersion} · Mã băm <code>{eob.eobHash.slice(0, 12)}…</code>
        </p>
        <dl className="kv totals">
          <dt>Tổng yêu cầu</dt><dd data-testid="eob-total-requested">{formatVnd(s.totalRequested)}</dd>
          <dt>Được chi trả</dt><dd data-testid="eob-total-approved" className="pos">{formatVnd(s.totalApproved)}</dd>
          <dt>Không chi trả</dt><dd data-testid="eob-total-rejected" className="neg">{formatVnd(s.totalRejected)}</dd>
          <dt>Hạn mức năm còn lại</dt><dd>{formatVnd(s.remainingAnnualLimit)}</dd>
        </dl>
      </section>
      <section aria-labelledby="eob-lines">
        <h2 id="eob-lines" className="section-title">Chi tiết từng khoản</h2>
        <ul className="lines">
          {eob.lineItems.map((l) => (
            <li key={l.lineId} className="card line" data-testid="eob-line">
              <div className="row space">
                <strong>{l.itemName}</strong>
                <span className={`chip ${LINE_TONE[l.status]}`}>{LINE_STATUS_VI[l.status]}</span>
              </div>
              <dl className="kv">
                <dt>Yêu cầu</dt><dd>{formatVnd(l.requested)}</dd>
                <dt>Chi trả</dt><dd className="pos">{formatVnd(l.approved)}</dd>
                <dt>Không chi trả</dt><dd className="neg">{formatVnd(l.rejected)}</dd>
              </dl>
              <p>{l.explanationVi}</p>
              <details>
                <summary>Căn cứ: {l.clauseCited}</summary>
                <blockquote>{l.contractClause.contractClauseCited}</blockquote>
                <p>{l.contractClause.explanationVi}</p>
              </details>
            </li>
          ))}
        </ul>
      </section>
      <section className="card notice" role="note">
        <p>
          Điều khoản hiển thị là văn bản MẪU. Xác nhận bảng giải trình bằng OTP cần hệ thống thật (UI-Z2 #50) và gắn với
          đúng phiên bản/mã băm EOB; bản thử nghiệm không có chức năng này.
        </p>
        <button type="button" className="btn-disabled" disabled aria-disabled="true">Xác nhận bằng OTP (chưa khả dụng)</button>
      </section>
    </Shell>
  );
}
