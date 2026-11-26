'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { BackendHealthReport } from '@/lib/core-api-health';
import { describeHealth, type ClientHealth, type Tone } from '@/lib/backend-health-labels';

const POLL_MS = 15000;

interface Ctx { health: ClientHealth; refresh: () => void; }
const HealthContext = createContext<Ctx | null>(null);

export function BackendHealthProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<ClientHealth>({ kind: 'CHECKING' });
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++seq.current;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setHealth({ kind: 'BROWSER_OFFLINE' });
      return;
    }
    setHealth(prev => (prev.kind === 'REPORT' ? prev : { kind: 'CHECKING' }));
    let next: ClientHealth;
    try {
      const res = await fetch('/api/backend-health', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error('bad status');
      next = { kind: 'REPORT', report: (await res.json()) as BackendHealthReport };
    } catch {
      next = navigator.onLine === false ? { kind: 'BROWSER_OFFLINE' } : { kind: 'WEB_UNREACHABLE' };
    }
    if (id === seq.current) setHealth(next);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    const onOnline = () => void refresh();
    const onOffline = () => { seq.current++; setHealth({ kind: 'BROWSER_OFFLINE' }); };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { clearInterval(timer); window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, [refresh]);

  return <HealthContext value={{ health, refresh: () => void refresh() }}>{children}</HealthContext>;
}

function useHealth(): Ctx {
  const ctx = useContext(HealthContext);
  if (!ctx) throw new Error('BackendHealthProvider missing');
  return ctx;
}

const DOT: Record<Tone, string> = { neutral: 'bg-slate-400', ok: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-rose-500' };
const PILL: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-300',
  ok: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
  warn: 'bg-amber-50 text-amber-800 ring-amber-300',
  bad: 'bg-rose-50 text-rose-800 ring-rose-300',
};

export function BackendStatusPill() {
  const { health } = useHealth();
  const view = describeHealth(health);
  return (
    <span data-testid="backend-status-pill" data-state={view.state} role="status" aria-live="polite"
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ring-1 ${PILL[view.tone]}`}>
      <span className={`h-2 w-2 rounded-full ${DOT[view.tone]}`} aria-hidden />
      {view.title}
    </span>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
}

export function BackendStatusPanel() {
  const { health, refresh } = useHealth();
  const view = describeHealth(health);
  const report = health.kind === 'REPORT' ? health.report : null;
  return (
    <section data-testid="backend-status-panel" data-state={view.state} className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Kết nối Web → Core API (NestJS)</h2>
          <p className="mt-1 text-xs text-slate-500">Route cùng origin <code>/api/backend-health</code> → địa chỉ nội bộ cố định → <code>GET /health</code></p>
        </div>
        <button type="button" onClick={refresh}
          className="rounded-xl bg-brand-700 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">
          Kiểm tra lại
        </button>
      </div>
      <div className={`mt-4 flex items-start gap-3 rounded-2xl p-4 ring-1 ${PILL[view.tone]}`}>
        <span className={`mt-1.5 h-3 w-3 shrink-0 rounded-full ${DOT[view.tone]}`} aria-hidden />
        <div>
          <p data-testid="backend-status-title" className="font-semibold">{view.title}</p>
          <p className="mt-1 text-sm">{view.explanation}</p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div><dt className="text-slate-500">Phạm vi</dt><dd className="font-medium">Liveness tiến trình</dd></div>
        <div><dt className="text-slate-500">HTTP</dt><dd data-testid="backend-http-status" className="font-medium">{report?.httpStatus ?? '—'}</dd></div>
        <div><dt className="text-slate-500">Độ trễ</dt><dd className="font-medium">{report?.latencyMs != null ? `${report.latencyMs} ms` : '—'}</dd></div>
        <div><dt className="text-slate-500">Kiểm tra lúc</dt><dd className="font-medium">{report ? formatTime(report.checkedAt) : '—'}</dd></div>
      </dl>
      {report && <p className="mt-3 text-xs text-slate-500">Mã chi tiết: <code data-testid="backend-detail">{report.detail}</code></p>}
    </section>
  );
}
