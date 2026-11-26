import { Button, useNavigate } from 'zmp-ui';
import { Shell } from '../components/shell.tsx';
import { SYNTHETIC_ECARD, SYNTHETIC_PLAN } from '../fixtures/synthetic.ts';
import { usePrototype } from '../state.tsx';

export function HomePage() {
  const navigate = useNavigate();
  const { canSubmit, decision } = usePrototype();
  return (
    <Shell title="Trang chủ" back={false}>
      <section className="card" aria-label="Thông tin hợp đồng mẫu">
        <p className="meta">{SYNTHETIC_PLAN.insurerLabel}</p>
        <h2>{SYNTHETIC_PLAN.planLabel}</h2>
        <p>Người được bảo hiểm: <span>{SYNTHETIC_ECARD.displayNameMasked}</span></p>
      </section>
      {!canSubmit && (
        <p className="card notice" role="status" data-testid="restricted-mode">
          {decision === 'DENIED'
            ? 'Chế độ giới hạn: bạn chưa đồng ý xử lý dữ liệu nên chưa thể gửi hồ sơ bồi thường.'
            : 'Bạn cần đồng ý xử lý dữ liệu trước khi gửi hồ sơ.'}
        </p>
      )}
      <nav className="actions" aria-label="Chức năng">
        <Button fullWidth onClick={() => navigate('/ecard')}>Thẻ bảo hiểm điện tử</Button>
        <Button fullWidth disabled={!canSubmit} onClick={() => navigate('/claims/new')}>Gửi yêu cầu bồi thường</Button>
        <Button fullWidth variant="secondary" onClick={() => navigate('/claims')}>Hồ sơ của tôi</Button>
        {!canSubmit && (
          <Button fullWidth variant="tertiary" onClick={() => navigate('/consent')}>Xem lại điều khoản đồng ý</Button>
        )}
      </nav>
    </Shell>
  );
}
