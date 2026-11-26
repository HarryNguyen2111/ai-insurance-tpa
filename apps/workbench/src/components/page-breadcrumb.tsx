'use client';

import { usePathname } from 'next/navigation';
import { useWorkspaces } from '@/components/workspace-provider';
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';

const TITLES: Record<string, string> = {
  '/': 'Tổng quan',
  '/tiep-nhan': 'Tiếp nhận hồ sơ',
  '/quy-trinh': 'Thiết kế quy trình',
  '/to-chuc/cai-dat': 'Cài đặt tổ chức',
  '/he-thong': 'Kết nối hệ thống',
};

export function PageBreadcrumb() {
  const pathname = usePathname();
  const { active } = useWorkspaces();
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem className="hidden max-w-52 truncate md:block">{active?.profile.displayName ?? 'TPA Workspace'}</BreadcrumbItem>
        <BreadcrumbSeparator className="hidden md:block" />
        <BreadcrumbItem><BreadcrumbPage>{TITLES[pathname] ?? 'Trang'}</BreadcrumbPage></BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
