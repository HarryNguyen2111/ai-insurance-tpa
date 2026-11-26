import Link from 'next/link';
import { BackendStatusPanel } from '@/components/backend-health';
import { LIVE_CAPABILITIES, PENDING_CAPABILITIES } from '@/lib/capabilities';

export default function OverviewPage() {
  return (
    <div className="space-y-6">
      <section className="rounded-3xl bg-brand-900 p-6 text-white shadow-lg sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-brand-100/80">Issue #68 · Bản xem trước đầu tiên</p>
        <h1 className="mt-2 text-2xl font-bold sm:text-3xl">Không gian làm việc TPA Sức khỏe & Nhân thọ</h1>
        <p className="mt-3 max-w-2xl text-sm text-brand-100">
          Trang này cho thấy web Next.js và Core API NestJS đang chạy cùng nhau trên máy cục bộ. Đây chưa phải luồng bồi thường hoàn chỉnh.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link href="/tiep-nhan" className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-brand-900">Xem trước tiếp nhận hồ sơ</Link>
          <Link href="/he-thong" className="rounded-2xl px-4 py-2 text-sm font-semibold ring-1 ring-white/40">Chi tiết kết nối</Link>
        </div>
      </section>

      <BackendStatusPanel />

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200" aria-labelledby="live-h">
          <h2 id="live-h" className="text-base font-semibold">Đã chạy thật trong bản này</h2>
          <ul className="mt-3 space-y-3" data-testid="live-capabilities">
            {LIVE_CAPABILITIES.map(c => (
              <li key={c.title} className="rounded-2xl bg-emerald-50 p-3 ring-1 ring-emerald-200">
                <p className="text-sm font-semibold text-emerald-900">{c.title}</p>
                <p className="text-xs text-emerald-800">{c.detail}</p>
              </li>
            ))}
          </ul>
        </section>
        <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200" aria-labelledby="pending-h">
          <h2 id="pending-h" className="text-base font-semibold">Đang chờ backend / chưa triển khai</h2>
          <ul className="mt-3 space-y-3" data-testid="pending-capabilities">
            {PENDING_CAPABILITIES.map(c => (
              <li key={c.title} className="rounded-2xl bg-slate-50 p-3 ring-1 ring-slate-200">
                <p className="flex items-center justify-between gap-2 text-sm font-semibold text-slate-800">{c.title}<span className="shrink-0 rounded-full bg-slate-200 px-2 py-0.5 text-[10px] text-slate-700">{c.ref}</span></p>
                <p className="text-xs text-slate-600">{c.detail}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
