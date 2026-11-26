'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Activity, ArrowRight, Building2, CheckCircle2, Circle, ClipboardList, FileText, ImageIcon, Inbox, Lock, Palette, PartyPopper, Plus, Users,
} from 'lucide-react';
import { BackendStatusPanel, useBackendHealthState } from '@/components/backend-health';
import { WorkspaceAvatar } from '@/components/workspace-form';
import { useWorkspaces } from '@/components/workspace-provider';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { LIVE_CAPABILITIES, PENDING_CAPABILITIES } from '@/lib/capabilities';
import { ORG_TYPE_LABELS } from '@/lib/workspace-profile';

const JOURNEY = [
  { icon: Building2, title: 'Tạo tổ chức', desc: 'Tên, định danh URL, loại hình', state: 'prototype' },
  { icon: ImageIcon, title: 'Logo & nhận diện', desc: 'Tải logo, kiểm tra an toàn', state: 'prototype' },
  { icon: Palette, title: 'Giao diện thương hiệu', desc: 'Màu, bo góc, sáng/tối', state: 'prototype' },
  { icon: Users, title: 'Mời thành viên', desc: 'Cần danh tính OIDC (#21)', state: 'blocked' },
  { icon: ClipboardList, title: 'Biểu mẫu tiếp nhận', desc: 'Xem trước cấu hình spec 11', state: 'preview' },
  { icon: Activity, title: 'Kết nối hệ thống', desc: 'Liveness Core API thật', state: 'live' },
] as const;

const STATE_BADGE = {
  prototype: <Badge variant="secondary">Prototype</Badge>,
  blocked: <Badge variant="outline">Chưa khả dụng</Badge>,
  preview: <Badge variant="secondary">Xem trước</Badge>,
  live: <Badge>Thật</Badge>,
} as const;

function Welcome() {
  return (
    <div className="grid gap-6" data-testid="welcome">
      <section className="relative overflow-hidden rounded-2xl border bg-card p-6 md:p-10">
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-primary/10 blur-3xl" />
        <Badge variant="secondary" className="mb-4">Issue #68 · Bản xem trước</Badge>
        <h1 className="max-w-2xl text-3xl font-semibold tracking-tight md:text-4xl">Chào mừng đến TPA Workspace</h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Bắt đầu bằng việc tạo tổ chức cho doanh nghiệp bảo hiểm hoặc đơn vị vận hành: thông tin, logo và giao diện thương hiệu.
          Sau đó tổ chức sẽ có không gian riêng để tiếp nhận và xử lý hồ sơ bồi thường.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button asChild size="lg" data-testid="cta-create"><Link href="/to-chuc/tao-moi"><Plus /> Tạo tổ chức</Link></Button>
          <Button asChild size="lg" variant="outline"><Link href="/tiep-nhan">Xem trước tiếp nhận hồ sơ</Link></Button>
        </div>
      </section>
      <div>
        <h2 className="mb-3 text-lg font-semibold">Hành trình thiết lập</h2>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {JOURNEY.map((j, i) => (
            <li key={j.title}>
              <Card className="h-full gap-3 py-4">
                <CardContent className="flex items-start gap-3 px-4">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><j.icon className="size-4" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2"><p className="font-medium">{i + 1}. {j.title}</p>{STATE_BADGE[j.state]}</div>
                    <p className="text-sm text-muted-foreground">{j.desc}</p>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ol>
      </div>
      <Alert>
        <Lock />
        <AlertTitle>Ai tạo tổ chức trong hệ thống thật?</AlertTitle>
        <AlertDescription>
          Theo đặc tả, Phase 1 không có tự đăng ký. Đã chốt: nhân sự TPA ops tạo tổ chức và cấp quản trị viên đầu tiên (OD-05), slug do TPA cấp (OD-02). Hợp đồng API đã có trong OpenAPI (WSC1); backend chưa triển khai.
          Màn hình này là prototype để thống nhất trải nghiệm trước khi làm backend.
        </AlertDescription>
      </Alert>
    </div>
  );
}

function Dashboard() {
  const { active } = useWorkspaces();
  const health = useBackendHealthState();
  const created = useSearchParams().get('created') === '1';
  if (!active) return null;
  const checklist = [
    { title: 'Tạo tổ chức', done: true, href: '/to-chuc/cai-dat' },
    { title: 'Thêm logo', done: active.logo !== null, href: '/to-chuc/cai-dat' },
    { title: 'Chọn giao diện thương hiệu', done: true, href: '/to-chuc/cai-dat' },
    { title: 'Mời thành viên', done: false, blocked: 'Cần #21' },
    { title: 'Xuất bản biểu mẫu tiếp nhận', done: false, blocked: 'Cần F4/F11' },
  ];
  const doneCount = checklist.filter(c => c.done).length;
  return (
    <div className="grid gap-6" data-testid="dashboard">
      {created && (
        <Alert data-testid="created-alert" className="border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100">
          <PartyPopper />
          <AlertTitle>Đã tạo tổ chức prototype “{active.profile.displayName}”</AlertTitle>
          <AlertDescription>Dữ liệu chỉ nằm trong trình duyệt này. Chưa có tenant hay máy chủ nào được tạo.</AlertDescription>
        </Alert>
      )}
      <section className="flex flex-wrap items-center gap-4">
        <WorkspaceAvatar name={active.profile.displayName} logo={active.logo} className="size-14 rounded-xl text-lg" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight md:text-3xl" data-testid="dashboard-title">{active.profile.displayName}</h1>
          <p className="text-sm text-muted-foreground">{ORG_TYPE_LABELS[active.profile.orgType]} · /w/{active.profile.slug}</p>
        </div>
        <Button asChild variant="outline"><Link href="/to-chuc/cai-dat">Cài đặt tổ chức</Link></Button>
      </section>
      {active.profile.description && <p className="-mt-2 max-w-3xl text-muted-foreground">{active.profile.description}</p>}

      <div className="grid gap-4 md:grid-cols-3">
        {[
          { icon: Inbox, title: 'Hồ sơ bồi thường', text: 'Chưa có dữ liệu — API hồ sơ (#37) chưa sẵn sàng.' },
          { icon: Users, title: 'Thành viên', text: 'Chưa khả dụng — cần danh tính OIDC (#21).' },
          { icon: Activity, title: 'Core API', text: health },
        ].map(c => (
          <Card key={c.title} className="gap-2">
            <CardHeader className="flex-row items-center gap-2"><c.icon className="size-4 text-muted-foreground" /><CardTitle className="text-sm font-medium">{c.title}</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground">{c.text}</CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card data-testid="setup-checklist">
          <CardHeader>
            <CardTitle>Thiết lập tổ chức</CardTitle>
            <CardDescription>{doneCount}/{checklist.length} bước hoàn tất</CardDescription>
            <Progress value={(doneCount / checklist.length) * 100} className="mt-2" aria-label="Tiến độ thiết lập" />
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {checklist.map(c => (
                <li key={c.title} className="flex items-center gap-3 py-2.5 text-sm">
                  {c.done ? <CheckCircle2 className="size-4 text-primary" /> : <Circle className="size-4 text-muted-foreground" />}
                  <span className={c.done ? '' : 'text-muted-foreground'}>{c.title}</span>
                  <span className="ml-auto">
                    {'blocked' in c && c.blocked ? <Badge variant="outline">{c.blocked}</Badge> : !c.done && c.href ? (
                      <Button asChild size="sm" variant="ghost"><Link href={c.href}>Thực hiện <ArrowRight /></Link></Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <BackendStatusPanel />
      </div>
      <Capabilities />
    </div>
  );
}

function Capabilities() {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>Đã chạy thật trong bản này</CardTitle></CardHeader>
        <CardContent><ul className="grid gap-3" data-testid="live-capabilities">
          {LIVE_CAPABILITIES.map(c => <li key={c.title} className="flex gap-3 text-sm"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" /><span><span className="font-medium">{c.title}</span><span className="block text-muted-foreground">{c.detail}</span></span></li>)}
        </ul></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Đang chờ backend / chưa triển khai</CardTitle></CardHeader>
        <CardContent><ul className="grid gap-3" data-testid="pending-capabilities">
          {PENDING_CAPABILITIES.map(c => <li key={c.title} className="flex gap-3 text-sm"><Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span className="flex-1"><span className="font-medium">{c.title}</span><span className="block text-muted-foreground">{c.detail}</span></span><Badge variant="outline" className="h-fit shrink-0">{c.ref}</Badge></li>)}
        </ul></CardContent>
      </Card>
    </div>
  );
}

export function WorkspaceOverview() {
  const { loaded, active } = useWorkspaces();
  if (!loaded) return <div className="grid gap-4"><Skeleton className="h-48 w-full" /><Skeleton className="h-32 w-full" /></div>;
  if (!active) return (<div className="grid gap-6"><Welcome /><BackendStatusPanel /><Capabilities /></div>);
  return <Dashboard />;
}
