'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { BackendStatusPill } from './backend-health';

const NAV = [
  { href: '/', label: 'Tổng quan', note: 'Tiến độ & phạm vi' },
  { href: '/tiep-nhan', label: 'Tiếp nhận hồ sơ', note: 'Xem trước biểu mẫu' },
  { href: '/he-thong', label: 'Kết nối hệ thống', note: 'Web ↔ Core API' },
] as const;

const PENDING = [
  { label: 'Hàng đợi duyệt (Workbench)', ref: '#51' },
  { label: 'Cổng DNBH', ref: '#52' },
] as const;

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Điều hướng workspace" className="flex flex-col gap-1">
      {NAV.map(item => {
        const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href} onClick={onNavigate} aria-current={active ? 'page' : undefined}
            className={`rounded-2xl px-4 py-3 transition ${active ? 'bg-white text-brand-900 shadow-sm' : 'text-brand-50 hover:bg-white/10'}`}>
            <span className="block text-sm font-semibold">{item.label}</span>
            <span className={`block text-xs ${active ? 'text-slate-500' : 'text-brand-100/80'}`}>{item.note}</span>
          </Link>
        );
      })}
      <p className="mt-4 px-4 text-[11px] font-semibold uppercase tracking-wide text-brand-100/70">Chưa triển khai</p>
      {PENDING.map(item => (
        <span key={item.label} aria-disabled="true" className="flex cursor-not-allowed items-center justify-between rounded-2xl px-4 py-2 text-sm text-brand-100/60">
          {item.label}
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px]">{item.ref}</span>
        </span>
      ))}
    </nav>
  );
}

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-screen lg:flex">
      <aside className="hidden w-72 shrink-0 flex-col gap-6 bg-brand-900 p-5 lg:flex">
        <Brand />
        <NavLinks />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
          <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
            <button type="button" className="rounded-xl p-2 text-brand-900 ring-1 ring-slate-200 lg:hidden"
              aria-label={open ? 'Đóng menu' : 'Mở menu'} aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen(v => !v)}>
              <span aria-hidden className="block h-0.5 w-5 bg-current" /><span aria-hidden className="mt-1 block h-0.5 w-5 bg-current" /><span aria-hidden className="mt-1 block h-0.5 w-5 bg-current" />
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-brand-900">Workspace: Bản xem trước cục bộ</p>
              <p className="truncate text-xs text-slate-500">Không đăng nhập · không có tenant thật · không có dữ liệu khách hàng</p>
            </div>
            <BackendStatusPill />
          </div>
          {open && (
            <div id="mobile-nav" className="bg-brand-900 p-3 lg:hidden"><NavLinks onNavigate={() => setOpen(false)} /></div>
          )}
        </header>
        <div role="note" data-testid="preview-banner" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 sm:px-6">
          <strong>BẢN XEM TRƯỚC CỤC BỘ.</strong> Chỉ có kiểm tra liveness của Core API là kết nối thật. Không tạo hồ sơ, không tính quyền lợi, không chạy AI, không lưu dữ liệu.
        </div>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-3 px-2">
      <span className="grid h-10 w-10 place-items-center rounded-2xl bg-white text-sm font-bold text-brand-900">TPA</span>
      <div>
        <p className="text-sm font-semibold text-white">TPA Sức khỏe & Nhân thọ</p>
        <p className="text-xs text-brand-100/80">Không gian làm việc</p>
      </div>
    </div>
  );
}
