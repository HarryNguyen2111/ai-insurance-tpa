'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CheckCircle2, Lock, Plus, Save, Trash2 } from 'lucide-react';
import { BrandPreview, LogoField, PrototypeNotice, ProfileFields, ThemeFields, WorkspaceAvatar } from '@/components/workspace-form';
import { useWorkspaces, type MutationResult } from '@/components/workspace-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { PrototypeWorkspace } from '@/lib/prototype-store';
import { ORG_TYPE_LABELS, type FieldErrors } from '@/lib/workspace-profile';

function SaveStatus({ result }: { result: MutationResult | null }) {
  if (!result) return null;
  if (result.ok) {
    return <p role="status" data-testid="save-ok" className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="size-4" /> Đã lưu trong trình duyệt (prototype).</p>;
  }
  return <p role="alert" data-testid="save-error" className="text-sm text-destructive">{result.message}</p>;
}

function Editor({ ws }: { ws: PrototypeWorkspace }) {
  const { update, remove } = useWorkspaces();
  const [profile, setProfile] = useState(ws.profile);
  const [logo, setLogo] = useState(ws.logo);
  const [theme, setTheme] = useState(ws.theme);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [result, setResult] = useState<MutationResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = (patch: Parameters<typeof update>[2]) => {
    const r = update(ws.id, ws.version, patch);
    setResult(r);
    setErrors(r.ok ? {} : r.errors);
  };

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-4">
        <WorkspaceAvatar name={ws.profile.displayName} logo={ws.logo} className="size-14 rounded-xl text-lg" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{ws.profile.displayName}</h1>
          <p className="text-sm text-muted-foreground">{ORG_TYPE_LABELS[ws.profile.orgType]} · /w/{ws.profile.slug} · phiên bản {ws.version}</p>
        </div>
        <Badge variant="outline">Prototype</Badge>
      </div>
      <PrototypeNotice />
      <Tabs defaultValue="general" onValueChange={() => setResult(null)}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="general">Thông tin chung</TabsTrigger>
          <TabsTrigger value="logo">Logo</TabsTrigger>
          <TabsTrigger value="theme">Giao diện</TabsTrigger>
          <TabsTrigger value="members">Thành viên</TabsTrigger>
          <TabsTrigger value="danger">Nâng cao</TabsTrigger>
        </TabsList>
        <TabsContent value="general">
          <Card>
            <CardHeader><CardTitle>Thông tin chung</CardTitle><CardDescription>Tên, định danh URL và loại hình tổ chức.</CardDescription></CardHeader>
            <CardContent><ProfileFields value={profile} onChange={setProfile} errors={errors} /></CardContent>
            <CardFooter className="justify-between gap-3 border-t"><SaveStatus result={result} /><Button className="ml-auto" data-testid="save-general" onClick={() => save({ profile })}><Save /> Lưu thay đổi</Button></CardFooter>
          </Card>
        </TabsContent>
        <TabsContent value="logo">
          <Card>
            <CardHeader><CardTitle>Logo</CardTitle><CardDescription>Logo hiển thị ở thanh điều hướng và bộ chuyển tổ chức.</CardDescription></CardHeader>
            <CardContent><LogoField name={profile.displayName} value={logo} onChange={setLogo} /></CardContent>
            <CardFooter className="justify-between gap-3 border-t"><SaveStatus result={result} /><Button className="ml-auto" data-testid="save-logo" onClick={() => save({ logo })}><Save /> Lưu logo</Button></CardFooter>
          </Card>
        </TabsContent>
        <TabsContent value="theme">
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
            <Card>
              <CardHeader><CardTitle>Giao diện</CardTitle><CardDescription>Màu thương hiệu, chế độ sáng/tối, thanh điều hướng và bo góc.</CardDescription></CardHeader>
              <CardContent><ThemeFields value={theme} onChange={setTheme} /></CardContent>
              <CardFooter className="justify-between gap-3 border-t"><SaveStatus result={result} /><Button className="ml-auto" data-testid="save-theme" onClick={() => save({ theme })}><Save /> Áp dụng giao diện</Button></CardFooter>
            </Card>
            <div className="grid gap-2 lg:sticky lg:top-20"><p className="text-sm font-medium">Xem trước</p><BrandPreview profile={profile} theme={theme} logo={logo} /></div>
          </div>
        </TabsContent>
        <TabsContent value="members">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><Lock className="size-4" /> Thành viên & vai trò — chưa khả dụng</CardTitle>
              <CardDescription>Mời thành viên cần danh tính OIDC và membership phía máy chủ (#21). Ai được cấp vai trò quản trị workspace là quyết định mở OD-05.</CardDescription></CardHeader>
            <CardContent className="grid gap-2 text-sm text-muted-foreground">
              <p>Vai trò dự kiến (spec 11 §4): WORKSPACE_ADMIN, FORM_AUTHOR, FORM_PUBLISHER, CLAIM_REVIEWER, INSURER_REVIEWER.</p>
              <p>Prototype không giả lập lời mời, email hay đăng nhập.</p>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="danger">
          <Card className="border-destructive/40">
            <CardHeader><CardTitle>Xóa tổ chức prototype</CardTitle><CardDescription>Chỉ xóa dữ liệu prototype trong trình duyệt này. Hệ thống thật sẽ không cho xóa trực tiếp tenant có dữ liệu nghiệp vụ.</CardDescription></CardHeader>
            <CardFooter className="gap-2 border-t">
              {!confirmDelete ? (
                <Button variant="destructive" data-testid="delete-workspace" onClick={() => setConfirmDelete(true)}><Trash2 /> Xóa tổ chức này</Button>
              ) : (
                <>
                  <Button variant="destructive" data-testid="confirm-delete" onClick={() => remove(ws.id)}>Xác nhận xóa “{ws.profile.shortName}”</Button>
                  <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Hủy</Button>
                </>
              )}
            </CardFooter>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function WorkspaceSettings() {
  const { loaded, active } = useWorkspaces();
  if (!loaded) return <Skeleton className="h-96 w-full" />;
  if (!active) {
    return (
      <Card className="mx-auto max-w-lg text-center" data-testid="settings-empty">
        <CardHeader><CardTitle>Chưa có tổ chức</CardTitle><CardDescription>Tạo một tổ chức (prototype) để chỉnh thông tin, logo và giao diện.</CardDescription></CardHeader>
        <CardFooter className="justify-center"><Button asChild><Link href="/to-chuc/tao-moi"><Plus /> Tạo tổ chức</Link></Button></CardFooter>
      </Card>
    );
  }
  return <Editor key={active.id} ws={active} />;
}
