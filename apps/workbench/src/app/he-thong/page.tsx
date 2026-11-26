import { BackendStatusPanel } from '@/components/backend-health';

export const metadata = { title: 'Kết nối hệ thống — TPA (xem trước)' };

export default function SystemPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-brand-900">Kết nối hệ thống</h1>
        <p className="mt-1 text-sm text-slate-600">Trạng thái thật của tiến trình Core API, kiểm tra mỗi 15 giây hoặc khi bấm “Kiểm tra lại”.</p>
      </header>
      <BackendStatusPanel />
      <section className="rounded-3xl bg-white p-5 text-sm shadow-sm ring-1 ring-slate-200">
        <h2 className="text-base font-semibold">Kiểm tra này chứng minh gì?</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-slate-700">
          <li><strong>Có:</strong> máy chủ web Next.js gọi được tiến trình NestJS core-api đã build và nhận <code>{'{"status":"ok"}'}</code>.</li>
          <li><strong>Không:</strong> cơ sở dữ liệu, Redis, Kafka, Temporal, Elasticsearch, lưu trữ chứng từ, danh tính hay API hồ sơ đã sẵn sàng.</li>
          <li>Trình duyệt chỉ gọi <code>/api/backend-health</code> cùng origin. Máy chủ web gọi một địa chỉ loopback cố định cấu hình phía server; không có proxy tùy ý và không chuyển tiếp tham số từ trình duyệt.</li>
          <li>Không có token, cookie đăng nhập hay tenant nào được gửi đi.</li>
        </ul>
      </section>
    </div>
  );
}
