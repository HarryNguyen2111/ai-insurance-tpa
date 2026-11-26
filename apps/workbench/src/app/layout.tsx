import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { BackendHealthProvider } from '@/components/backend-health';
import { WorkspaceShell } from '@/components/workspace-shell';
import './globals.css';

export const metadata: Metadata = {
  title: 'TPA Sức khỏe & Nhân thọ — Bản xem trước',
  description: 'Bản xem trước cục bộ của không gian làm việc TPA. Không phải hệ thống vận hành.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body>
        <BackendHealthProvider>
          <WorkspaceShell>{children}</WorkspaceShell>
        </BackendHealthProvider>
      </body>
    </html>
  );
}
