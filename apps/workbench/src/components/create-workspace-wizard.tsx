'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Check, Rocket } from 'lucide-react';
import { BrandPreview, LogoField, PrototypeNotice, ProfileFields, ThemeFields, WorkspaceAvatar } from '@/components/workspace-form';
import { useWorkspaces } from '@/components/workspace-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import {
  DEFAULT_THEME, ORG_TYPE_LABELS, RADIUS_LABELS, suggestShortName, suggestSlug, validateProfile, validateTheme,
  type FieldErrors, type WorkspaceLogo, type WorkspaceProfile, type WorkspaceTheme,
} from '@/lib/workspace-profile';

const STEPS = [
  { key: 'info', title: 'Thông tin tổ chức', desc: 'Tên, định danh và loại hình' },
  { key: 'logo', title: 'Logo', desc: 'Nhận diện thương hiệu' },
  { key: 'theme', title: 'Giao diện', desc: 'Màu sắc, bo góc, chế độ' },
  { key: 'review', title: 'Xem lại', desc: 'Kiểm tra và tạo' },
] as const;

const EMPTY_PROFILE: WorkspaceProfile = { displayName: '', shortName: '', slug: '', orgType: 'INSURER', description: '' };

export function CreateWorkspaceWizard() {
  const router = useRouter();
  const { workspaces, create } = useWorkspaces();
  const [step, setStep] = useState(0);
  const [profile, setProfile] = useState<WorkspaceProfile>(EMPTY_PROFILE);
  const [logo, setLogo] = useState<WorkspaceLogo | null>(null);
  const [theme, setTheme] = useState<WorkspaceTheme>(DEFAULT_THEME);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [slugTouched, setSlugTouched] = useState(false);
  const [shortTouched, setShortTouched] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const taken = useMemo(() => new Set(workspaces.map(w => w.profile.slug)), [workspaces]);

  const onProfile = (next: WorkspaceProfile) => {
    // A changed slug/short name in this event means the user typed it: stop auto-suggesting.
    const slugEdited = slugTouched || next.slug !== profile.slug;
    const shortEdited = shortTouched || next.shortName !== profile.shortName;
    if (slugEdited !== slugTouched) setSlugTouched(true);
    if (shortEdited !== shortTouched) setShortTouched(true);
    const auto = { ...next };
    if (!slugEdited) auto.slug = suggestSlug(next.displayName);
    if (!shortEdited) auto.shortName = suggestShortName(next.displayName);
    setProfile(auto);
    if (Object.keys(errors).length) setErrors(validateProfile(auto, taken));
  };

  const next = () => {
    if (step === 0) {
      const e = validateProfile(profile, taken);
      setErrors(e);
      if (Object.keys(e).length) return;
    }
    if (step === 2 && Object.keys(validateTheme(theme).errors).length) return;
    setStep(s => Math.min(s + 1, STEPS.length - 1));
  };

  const submit = () => {
    const result = create({ profile, theme, logo });
    if (result.ok) router.push('/?created=1');
    else { setSubmitError(result.message); setErrors(result.errors); if (Object.keys(result.errors).length) setStep(0); }
  };

  return (
    <div className="grid gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Tạo tổ chức mới</h1>
        <p className="mt-1 text-muted-foreground">Thiết lập không gian làm việc cho doanh nghiệp bảo hiểm hoặc đơn vị vận hành.</p>
      </div>
      <ol className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="Các bước">
        {STEPS.map((s, i) => (
          <li key={s.key} data-testid={`wizard-step-${s.key}`} data-state={i < step ? 'done' : i === step ? 'current' : 'todo'}
            aria-current={i === step ? 'step' : undefined}
            className={cn('flex items-center gap-3 rounded-lg border bg-background p-3', i === step && 'border-primary ring-1 ring-primary')}>
            <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
              i < step && 'border-primary bg-primary text-primary-foreground', i === step && 'border-primary text-primary')}>
              {i < step ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{s.title}</span>
              <span className="hidden truncate text-xs text-muted-foreground sm:block">{s.desc}</span>
            </span>
          </li>
        ))}
      </ol>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card>
          <CardHeader>
            <CardTitle>{STEPS[step]!.title}</CardTitle>
            <CardDescription>
              {step === 0 && 'Thông tin cơ bản hiển thị cho thành viên trong không gian làm việc.'}
              {step === 1 && 'Logo xuất hiện ở thanh điều hướng, email và cổng khách hàng (khi có backend).'}
              {step === 2 && 'Chọn màu thương hiệu từ bảng màu đã kiểm tra độ tương phản, hoặc nhập mã màu riêng.'}
              {step === 3 && 'Kiểm tra lại trước khi tạo. Bạn có thể chỉnh sửa sau trong Cài đặt tổ chức.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {step === 0 && <ProfileFields value={profile} onChange={onProfile} errors={errors} />}
            {step === 1 && <LogoField name={profile.displayName} value={logo} onChange={setLogo} />}
            {step === 2 && <ThemeFields value={theme} onChange={setTheme} />}
            {step === 3 && (
              <div className="grid gap-5" data-testid="wizard-review">
                <div className="flex items-center gap-4">
                  <WorkspaceAvatar name={profile.displayName} logo={logo} className="size-14 rounded-xl text-lg" />
                  <div>
                    <p className="text-lg font-semibold">{profile.displayName}</p>
                    <p className="text-sm text-muted-foreground">{ORG_TYPE_LABELS[profile.orgType]} · /w/{profile.slug}</p>
                  </div>
                </div>
                <Separator />
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div><dt className="text-muted-foreground">Tên viết tắt</dt><dd className="font-medium">{profile.shortName}</dd></div>
                  <div><dt className="text-muted-foreground">Logo</dt><dd className="font-medium">{logo ? `${logo.width}×${logo.height}px` : 'Dùng chữ viết tắt'}</dd></div>
                  <div><dt className="text-muted-foreground">Màu thương hiệu</dt><dd className="flex items-center gap-2 font-medium"><span className="size-4 rounded-full" style={{ backgroundColor: theme.primaryColor }} />{theme.primaryColor}</dd></div>
                  <div><dt className="text-muted-foreground">Kiểu giao diện</dt><dd className="font-medium">{theme.mode === 'DARK' ? 'Tối' : 'Sáng'} · {RADIUS_LABELS[theme.radius]} · {theme.sidebarStyle === 'BRAND' ? 'Thanh bên màu thương hiệu' : 'Thanh bên trung tính'}</dd></div>
                  {profile.description && <div className="sm:col-span-2"><dt className="text-muted-foreground">Mô tả</dt><dd>{profile.description}</dd></div>}
                </dl>
                <PrototypeNotice />
                <p className="text-sm text-muted-foreground">
                  Trong hệ thống thật, việc tạo tổ chức là thao tác của nhân sự được cấp quyền (đã chốt OD-05: nhân sự TPA ops tạo tổ chức và cấp quản trị viên đầu tiên), có MFA, audit và gắn với tenant phía máy chủ.
                </p>
                {submitError && <p role="alert" className="text-sm text-destructive">{submitError}</p>}
              </div>
            )}
          </CardContent>
          <CardFooter className="justify-between border-t">
            <Button type="button" variant="ghost" onClick={() => setStep(s => Math.max(0, s - 1))} disabled={step === 0}><ArrowLeft /> Quay lại</Button>
            {step < STEPS.length - 1 ? (
              <Button type="button" data-testid="wizard-next" onClick={next}>{step === 1 && !logo ? 'Bỏ qua, dùng chữ viết tắt' : 'Tiếp tục'} <ArrowRight /></Button>
            ) : (
              <Button type="button" data-testid="wizard-create" onClick={submit}><Rocket /> Tạo tổ chức (prototype)</Button>
            )}
          </CardFooter>
        </Card>
        <aside className="grid gap-3 lg:sticky lg:top-6">
          <p className="text-sm font-medium">Xem trước trực tiếp</p>
          <BrandPreview profile={profile} theme={theme} logo={logo} />
          <p className="text-xs text-muted-foreground">Bản xem trước cập nhật theo từng thay đổi. Màu chữ trên nút được chọn tự động để đạt tương phản WCAG AA.</p>
        </aside>
      </div>
    </div>
  );
}
