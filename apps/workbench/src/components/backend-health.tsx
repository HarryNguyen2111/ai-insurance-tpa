'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { BackendHealthReport } from '@/lib/core-api-health';
import { describeHealth, type ClientHealth, type Tone } from '@/lib/backend-health-labels';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RefreshCw } from 'lucide-react';

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
  neutral: 'bg-muted text-muted-foreground ring-border',
  ok: 'bg-emerald-50 text-emerald-800 ring-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-800',
  warn: 'bg-amber-50 text-amber-800 ring-amber-300 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-800',
  bad: 'bg-rose-50 text-rose-800 ring-rose-300 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-800',
};

export function useBackendHealthState(): string {
  return describeHealth(useHealth().health).title;
}

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
    <Card data-testid="backend-status-panel" data-state={view.state}>
      <CardHeader>
        <CardTitle>Kết nối Web → Core API (NestJS)</CardTitle>
        <CardDescription>Route cùng origin <code>/api/backend-health</code> → địa chỉ nội bộ cố định → <code>GET /health</code></CardDescription>
        <CardAction>
          <Button type="button" variant="outline" size="sm" onClick={refresh}><RefreshCw /> Kiểm tra lại</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className={`flex items-start gap-3 rounded-lg p-4 ring-1 ${PILL[view.tone]}`}>
          <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT[view.tone]}`} aria-hidden />
          <div>
            <p data-testid="backend-status-title" className="font-semibold">{view.title}</p>
            <p className="mt-1 text-sm">{view.explanation}</p>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div><dt className="text-muted-foreground">Phạm vi</dt><dd className="font-medium">Liveness</dd></div>
          <div><dt className="text-muted-foreground">HTTP</dt><dd data-testid="backend-http-status" className="font-medium">{report?.httpStatus ?? '—'}</dd></div>
          <div><dt className="text-muted-foreground">Độ trễ</dt><dd className="font-medium">{report?.latencyMs != null ? `${report.latencyMs} ms` : '—'}</dd></div>
          <div><dt className="text-muted-foreground">Kiểm tra lúc</dt><dd className="font-medium">{report ? formatTime(report.checkedAt) : '—'}</dd></div>
        </dl>
        {report && <p className="text-xs text-muted-foreground">Mã chi tiết: <code data-testid="backend-detail">{report.detail}</code></p>}
      </CardContent>
    </Card>
  );
}
