import { useState, type UIEvent } from 'react';
import { Button, useNavigate } from 'zmp-ui';
import { SvgIcon } from '../components/icons.tsx';
import { Section } from '../components/section.tsx';
import { Shell } from '../components/shell.tsx';
import { SYNTHETIC_CLAIMS, SYNTHETIC_ECARD, SYNTHETIC_PLAN } from '../fixtures/synthetic.ts';
import { statusView } from '../lib/claim-status.ts';
import { formatVnd } from '../lib/money.ts';
import { usePrototype } from '../state.tsx';

/** Neutral, text-only slides (reference `pages/index/banner.tsx` shows a 2:1 image carousel). No images,
 * no tenant logo, no autoplay; the user swipes or scrolls. */
const SLIDES = [
  { icon: 'shield', title: 'Bồi thường sức khỏe trên Zalo', body: 'Gửi chứng từ, theo dõi hồ sơ và xem giải trình chi trả.' },
  { icon: 'camera', title: 'Chụp hóa đơn, đơn thuốc', body: 'Hỗ trợ ảnh HEIC từ iPhone và tệp PDF.' },
  { icon: 'chart', title: 'Giải trình từng khoản', body: 'Mỗi khoản không chi trả đều có điều khoản trích dẫn.' },
] as const;

function Banner() {
  const [index, setIndex] = useState(0);
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setIndex(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
  };
  return (
    <div className="home-banner" aria-roledescription="carousel" aria-label="Giới thiệu dịch vụ" data-testid="home-banner">
      <div className="slides" onScroll={onScroll} tabIndex={0}>
        {SLIDES.map((s, i) => (
          <div key={s.title} className="slide" role="group" aria-roledescription="slide" aria-label={`${i + 1} / ${SLIDES.length}`}>
            <span className="slide-art" aria-hidden="true"><SvgIcon name={s.icon} size={36} /></span>
            <span className="slide-text">
              <strong>{s.title}</strong>
              <span>{s.body}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="dots" aria-hidden="true">
        {SLIDES.map((s, i) => <span key={s.title} className={i === index ? 'dot active' : 'dot'} />)}
      </div>
    </div>
  );
}

/** Reference `components/welcome_vimid.tsx`: app title + "Chào mừng, {name}!" under the banner. */
function Welcome() {
  return (
    <header className="welcome" data-testid="welcome">
      <h1 className="sr-only">Trang chủ</h1>
      <p className="welcome-title">Bồi thường Sức khỏe</p>
      <p className="welcome-sub">Chào mừng, {SYNTHETIC_ECARD.displayNameMasked}!</p>
    </header>
  );
}

const viDate = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/');

export function HomePage() {
  const navigate = useNavigate();
  const { canSubmit, decision } = usePrototype();
  return (
    <Shell title="Trang chủ" back={false} tone="warm" hero={<><Banner /><Welcome /></>}>
      {!canSubmit && (
        <div className="card notice" role="status" data-testid="restricted-mode">
          <p>
            {decision === 'DENIED'
              ? 'Chế độ giới hạn: bạn chưa đồng ý xử lý dữ liệu nên chưa thể gửi hồ sơ bồi thường.'
              : 'Bạn cần đồng ý xử lý dữ liệu trước khi gửi hồ sơ.'}
          </p>
          <Button size="small" variant="secondary" onClick={() => navigate('/consent')}>Xem lại điều khoản đồng ý</Button>
        </div>
      )}

      <Section title="Hợp đồng của bạn">
        <div className="plan-card" aria-label="Thông tin hợp đồng mẫu" role="group">
          <span className="plan-insurer">{SYNTHETIC_PLAN.insurerLabel}</span>
          <strong className="plan-name">{SYNTHETIC_PLAN.planLabel}</strong>
          <span className="plan-row">
            <span>Người được bảo hiểm: <span>{SYNTHETIC_ECARD.displayNameMasked}</span></span>
          </span>
          <span className="plan-row muted">Hiệu lực {viDate(SYNTHETIC_PLAN.effectiveFrom)} – {viDate(SYNTHETIC_PLAN.effectiveTo)}</span>
        </div>
      </Section>

      <Section title="Dịch vụ">
        <nav className="tiles" aria-label="Chức năng">
          <button type="button" className="tile" onClick={() => navigate('/ecard')}>
            <span className="tile-icon" aria-hidden="true"><SvgIcon name="card" /></span>
            <span>Thẻ bảo hiểm điện tử</span>
          </button>
          <button type="button" className="tile" disabled={!canSubmit} onClick={() => navigate('/claims/new')}>
            <span className="tile-icon" aria-hidden="true"><SvgIcon name="camera" /></span>
            <span>Gửi yêu cầu bồi thường</span>
          </button>
          <button type="button" className="tile" onClick={() => navigate('/claims')}>
            <span className="tile-icon" aria-hidden="true"><SvgIcon name="list" /></span>
            <span>Hồ sơ của tôi</span>
          </button>
        </nav>
      </Section>

      <Section
        title="Hồ sơ gần đây"
        action={<button type="button" className="link" onClick={() => navigate('/claims')}>Xem tất cả</button>}
      >
        <ul className="recent" aria-label="Hồ sơ gần đây (mẫu)">
          {SYNTHETIC_CLAIMS.slice(0, 2).map((c) => {
            const v = statusView(c.status);
            return (
              <li key={c.claimId}>
                <button
                  type="button"
                  className="recent-item"
                  onClick={() => navigate(`/claims/${c.claimId}`)}
                  data-testid={`recent-claim-${c.claimCode}`}
                >
                  <span className="recent-icon" aria-hidden="true"><SvgIcon name="file" /></span>
                  <span className="recent-body">
                    <span className="recent-row">
                      <strong>{c.claimCode}</strong>
                      <span className="recent-amount">{formatVnd(c.totalRequested)}</span>
                    </span>
                    <span className={`chip ${v.tone}`}>{v.labelVi}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Section>
    </Shell>
  );
}
