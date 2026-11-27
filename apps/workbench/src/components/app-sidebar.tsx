'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity, Building2, Check, ChevronsUpDown, ClipboardCheck, FileText, FormInput, LayoutDashboard, Plus, Settings2, Users,
} from 'lucide-react';
import { BackendStatusPill } from '@/components/backend-health';
import { WorkspaceAvatar } from '@/components/workspace-form';
import { useWorkspaces } from '@/components/workspace-provider';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuBadge,
  SidebarMenuButton, SidebarMenuItem, SidebarRail, useSidebar,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { ORG_TYPE_LABELS } from '@/lib/workspace-profile';

const MAIN = [
  { href: '/', label: 'Tổng quan', icon: LayoutDashboard },
  { href: '/tiep-nhan', label: 'Tiếp nhận hồ sơ', icon: FileText, badge: 'Xem trước' },
  { href: '/quy-trinh', label: 'Thiết kế quy trình', icon: FormInput, badge: 'Cục bộ' },
];
const ADMIN = [
  { href: '/to-chuc/cai-dat', label: 'Cài đặt tổ chức', icon: Settings2 },
  { href: '/he-thong', label: 'Kết nối hệ thống', icon: Activity },
];
const SOON = [
  { label: 'Thành viên & vai trò', icon: Users, ref: '#21' },
  { label: 'Biểu mẫu tiếp nhận', icon: FormInput, ref: 'F11' },
  { label: 'Hàng đợi duyệt', icon: ClipboardCheck, ref: '#51' },
  { label: 'Cổng DNBH', icon: Building2, ref: '#52' },
];

function WorkspaceSwitcher() {
  const { loaded, workspaces, active, setActive } = useWorkspaces();
  const { isMobile, setOpenMobile } = useSidebar();
  const router = useRouter();
  if (!loaded) return <Skeleton className="h-12 w-full" />;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="lg" data-testid="workspace-switcher" className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground">
          {active ? (
            <WorkspaceAvatar name={active.profile.displayName} logo={active.logo} />
          ) : (
            <span className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-xs font-bold text-sidebar-primary-foreground">TPA</span>
          )}
          <span className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-semibold" data-testid="active-workspace-name">{active?.profile.displayName ?? 'TPA Workspace'}</span>
            <span className="truncate text-xs opacity-70">{active ? ORG_TYPE_LABELS[active.profile.orgType] : 'Chưa có tổ chức'}</span>
          </span>
          <ChevronsUpDown className="ml-auto" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width) min-w-60 rounded-lg" align="start" side={isMobile ? 'bottom' : 'right'} sideOffset={4}>
        <DropdownMenuLabel className="text-xs text-muted-foreground">Tổ chức (prototype trên trình duyệt này)</DropdownMenuLabel>
        {workspaces.length === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">Chưa có tổ chức nào.</p>}
        {workspaces.map(w => (
          <DropdownMenuItem key={w.id} className="gap-2 p-2" onSelect={() => { setActive(w.id); if (isMobile) setOpenMobile(false); }}>
            <WorkspaceAvatar name={w.profile.displayName} logo={w.logo} className="size-6 rounded-md text-[10px]" />
            <span className="flex-1 truncate">{w.profile.displayName}</span>
            {w.id === active?.id && <Check className="size-4" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2 p-2" data-testid="switcher-create" onSelect={() => router.push('/to-chuc/tao-moi')}>
          <span className="flex size-6 items-center justify-center rounded-md border bg-background"><Plus className="size-4" /></span>
          <span className="font-medium">Tạo tổ chức mới</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppSidebar() {
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();
  const close = () => { if (isMobile) setOpenMobile(false); };
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  const renderLinks = (items: typeof MAIN) => items.map(item => (
    <SidebarMenuItem key={item.href}>
      <SidebarMenuButton asChild isActive={isActive(item.href)} tooltip={item.label}>
        <Link href={item.href} onClick={close}><item.icon /><span>{item.label}</span></Link>
      </SidebarMenuButton>
      {'badge' in item && item.badge && <SidebarMenuBadge className="text-[10px] opacity-80">{item.badge}</SidebarMenuBadge>}
    </SidebarMenuItem>
  ));
  return (
    <Sidebar collapsible="icon" data-testid="app-sidebar">
      <SidebarHeader>
        <SidebarMenu><SidebarMenuItem><WorkspaceSwitcher /></SidebarMenuItem></SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Không gian làm việc</SidebarGroupLabel>
          <SidebarMenu>{renderLinks(MAIN)}</SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Quản trị</SidebarGroupLabel>
          <SidebarMenu>{renderLinks(ADMIN)}</SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Sắp triển khai</SidebarGroupLabel>
          <SidebarMenu>
            {SOON.map(item => (
              <SidebarMenuItem key={item.label}>
                <SidebarMenuButton aria-disabled="true" disabled tooltip={`${item.label} — chưa triển khai (${item.ref})`} className="opacity-60">
                  <item.icon /><span>{item.label}</span>
                </SidebarMenuButton>
                <SidebarMenuBadge className="text-[10px] opacity-70">{item.ref}</SidebarMenuBadge>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="group-data-[collapsible=icon]:hidden">
        <div className="rounded-lg border border-sidebar-border bg-sidebar-accent/50 p-3 text-xs">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-semibold">Bản xem trước cục bộ</span>
            <Badge variant="outline" className="border-sidebar-border text-[10px] text-sidebar-foreground">Prototype</Badge>
          </div>
          <BackendStatusPill />
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
