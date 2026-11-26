import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@fontsource/be-vietnam-pro/400.css';
import '@fontsource/be-vietnam-pro/500.css';
import '@fontsource/be-vietnam-pro/600.css';
import '@fontsource/be-vietnam-pro/700.css';
import { BackendHealthProvider } from '@/components/backend-health';
import { WorkspaceProvider } from '@/components/workspace-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'TPA Workspace — Bản xem trước', template: '%s · TPA Workspace (xem trước)' },
  description: 'Bản xem trước cục bộ của không gian làm việc TPA Sức khỏe & Nhân thọ. Không phải hệ thống vận hành.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <BackendHealthProvider>
          <WorkspaceProvider>
            <TooltipProvider>{children}</TooltipProvider>
          </WorkspaceProvider>
        </BackendHealthProvider>
      </body>
    </html>
  );
}
