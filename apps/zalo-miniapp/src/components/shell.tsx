import type { ReactNode } from 'react';
import { Page, useNavigate } from 'zmp-ui';
import { SvgIcon } from './icons.tsx';
import { usePrototype } from '../state.tsx';

/** Compact, always-visible honesty strip (was a two-line debug banner in #74). */
export function PrototypeBanner() {
  const { runtime } = usePrototype();
  return (
    <div className="banner" role="note" aria-label="Thông báo bản thử nghiệm" data-testid="prototype-banner">
      <SvgIcon name="info" size={16} />
      <p>
        <strong>BẢN THỬ NGHIỆM · DỮ LIỆU GIẢ LẬP</strong>{' '}
        <span>
          {runtime === 'browser'
            ? '· Chạy ngoài Zalo, không gửi dữ liệu thật.'
            : '· Chạy trong Zalo, chưa kết nối hệ thống thật.'}
        </span>
      </p>
    </div>
  );
}

/**
 * Screen frame. `tone="warm"` uses the reference home background (#FFF8E6); tab-root screens get bottom
 * padding for the persistent bar via `body.has-bottom-nav` (see styles.css), so content is never covered.
 * `hero` replaces the plain title bar (home: banner + welcome header, reference `pages/index/index.tsx`).
 */
export function Shell({
  title,
  back = true,
  tone = 'plain',
  hero,
  children,
}: {
  title: string;
  back?: boolean;
  tone?: 'plain' | 'warm';
  hero?: ReactNode;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <Page className={`page ${tone}`} hideScrollbar>
      <PrototypeBanner />
      {hero ?? (
        <header className="topbar">
          {back ? (
            <button type="button" className="back" onClick={() => navigate(-1)} aria-label="Quay lại">
              <SvgIcon name="back" />
            </button>
          ) : (
            <span className="back-spacer" aria-hidden="true" />
          )}
          <h1>{title}</h1>
        </header>
      )}
      <main className="content">{children}</main>
    </Page>
  );
}
