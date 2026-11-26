import type { ReactNode } from 'react';
import { Page, useNavigate } from 'zmp-ui';
import { usePrototype } from '../state.tsx';

export function PrototypeBanner() {
  const { runtime } = usePrototype();
  return (
    <div className="banner" role="note" aria-label="Thông báo bản thử nghiệm" data-testid="prototype-banner">
      <strong>BẢN THỬ NGHIỆM · DỮ LIỆU GIẢ LẬP</strong>
      <span>
        {runtime === 'browser'
          ? 'Đang chạy ngoài Zalo (chế độ giả lập trình duyệt). Không có dữ liệu thật nào được gửi đi.'
          : 'Đang chạy trong Zalo. Dữ liệu vẫn là giả lập; chưa kết nối hệ thống thật.'}
      </span>
    </div>
  );
}

export function Shell({ title, back = true, children }: { title: string; back?: boolean; children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <Page className="page" hideScrollbar>
      <PrototypeBanner />
      <header className="topbar">
        {back ? (
          <button type="button" className="back" onClick={() => navigate(-1)} aria-label="Quay lại">
            ‹
          </button>
        ) : (
          <span className="back-spacer" aria-hidden="true" />
        )}
        <h1>{title}</h1>
      </header>
      <main className="content">{children}</main>
    </Page>
  );
}
