import type { ReactNode } from 'react';
import { AppSidebar } from '@/components/app-sidebar';
import { PageBreadcrumb } from '@/components/page-breadcrumb';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <PageBreadcrumb />
        </header>
        <div role="note" data-testid="preview-banner" className="border-b bg-muted/50 px-4 py-1.5 text-xs text-muted-foreground">
          <strong className="text-foreground">BẢN XEM TRƯỚC CỤC BỘ.</strong> Chỉ kiểm tra liveness Core API là kết nối thật. Tổ chức là prototype lưu trên trình duyệt; không tạo hồ sơ, không tính quyền lợi, không chạy AI.
        </div>
        <main className="mx-auto w-full max-w-6xl flex-1 p-4 md:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
