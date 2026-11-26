'use client';

import { useRef, useState, type CSSProperties } from 'react';
import { Check, FileText, ImageUp, LayoutDashboard, Loader2, Moon, Settings2, ShieldAlert, Sun, Trash2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { processLogoFile } from '@/lib/logo-processing';
import { cn } from '@/lib/utils';
import {
  initialsOf, LIMITS, ORG_TYPE_LABELS, ORG_TYPES, RADIUS_LABELS, RADII, THEME_PRESETS, themeCssVars, validateTheme,
  type FieldErrors, type WorkspaceLogo, type WorkspaceProfile, type WorkspaceTheme,
} from '@/lib/workspace-profile';

export function PrototypeNotice({ className }: { className?: string }) {
  return (
    <Alert data-testid="prototype-notice" className={cn('border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100', className)}>
      <ShieldAlert />
      <AlertTitle>Prototype — chưa lưu máy chủ</AlertTitle>
      <AlertDescription className="text-amber-900 dark:text-amber-200">
        Tổ chức chỉ được lưu trong trình duyệt này (localStorage) để minh họa hành trình. Chưa có đăng nhập, tenant, phân quyền hay
        máy chủ. Không nhập thông tin thật hoặc bí mật.
      </AlertDescription>
    </Alert>
  );
}

export function WorkspaceAvatar({ name, logo, className }: { name: string; logo: WorkspaceLogo | null; className?: string }) {
  return (
    <span className={cn('flex aspect-square size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground', logo && 'bg-white', className)}>
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element -- validated, re-encoded data URL
        <img src={logo.dataUrl} alt={`Logo ${name}`} className="size-full object-contain" />
      ) : (
        initialsOf(name || '?')
      )}
    </span>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return <p id={id} role="alert" className="text-sm text-destructive">{message}</p>;
}

export function ProfileFields({ value, onChange, errors, onSlugTouched, onShortTouched }: {
  value: WorkspaceProfile;
  onChange: (next: WorkspaceProfile) => void;
  errors: FieldErrors;
  onSlugTouched?: () => void;
  onShortTouched?: () => void;
}) {
  const set = <K extends keyof WorkspaceProfile>(key: K, v: WorkspaceProfile[K]) => onChange({ ...value, [key]: v });
  return (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <Label htmlFor="ws-name">Tên tổ chức</Label>
        <Input id="ws-name" data-testid="ws-name" value={value.displayName} maxLength={LIMITS.displayName.max + 20}
          placeholder="VD: Bảo hiểm Mẫu Minh Họa" aria-invalid={!!errors.displayName} aria-describedby="ws-name-err"
          onChange={e => set('displayName', e.target.value)} />
        <FieldError id="ws-name-err" message={errors.displayName} />
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="ws-short">Tên viết tắt</Label>
          <Input id="ws-short" data-testid="ws-short" value={value.shortName} maxLength={LIMITS.shortName.max} placeholder="VD: BHMH"
            aria-invalid={!!errors.shortName} aria-describedby="ws-short-err ws-short-help"
            onChange={e => { onShortTouched?.(); set('shortName', e.target.value.toUpperCase()); }} />
          <p id="ws-short-help" className="text-xs text-muted-foreground">Hiển thị khi không có logo và trong báo cáo.</p>
          <FieldError id="ws-short-err" message={errors.shortName} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="ws-slug">Định danh URL</Label>
          <div className="flex items-center rounded-md border border-input focus-within:ring-[3px] focus-within:ring-ring/50">
            <span className="pl-3 text-sm text-muted-foreground">/w/</span>
            <Input id="ws-slug" data-testid="ws-slug" value={value.slug} maxLength={LIMITS.slug.max} placeholder="bao-hiem-mau"
              className="border-0 pl-1 shadow-none focus-visible:ring-0" aria-invalid={!!errors.slug} aria-describedby="ws-slug-err ws-slug-help"
              onChange={e => { onSlugTouched?.(); set('slug', e.target.value.toLowerCase()); }} />
          </div>
          <p id="ws-slug-help" className="text-xs text-muted-foreground">Chỉ để định tuyến; không phải bằng chứng quyền truy cập.</p>
          <FieldError id="ws-slug-err" message={errors.slug} />
        </div>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">Loại hình tổ chức</legend>
        <div className="grid gap-3 sm:grid-cols-3" role="radiogroup">
          {ORG_TYPES.map(t => (
            <button key={t} type="button" role="radio" aria-checked={value.orgType === t} data-testid={`ws-type-${t}`}
              onClick={() => set('orgType', t)}
              className={cn('rounded-lg border p-3 text-left text-sm transition hover:border-primary/60',
                value.orgType === t ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border')}>
              <span className="flex items-center justify-between gap-2 font-medium">{ORG_TYPE_LABELS[t]}{value.orgType === t && <Check className="size-4 text-primary" />}</span>
            </button>
          ))}
        </div>
        <FieldError id="ws-type-err" message={errors.orgType} />
      </fieldset>
      <div className="grid gap-2">
        <Label htmlFor="ws-desc">Mô tả ngắn <span className="font-normal text-muted-foreground">(không bắt buộc)</span></Label>
        <Textarea id="ws-desc" data-testid="ws-desc" value={value.description} maxLength={LIMITS.description.max + 20} rows={3}
          placeholder="Giới thiệu ngắn về tổ chức, hiển thị trong không gian làm việc." aria-invalid={!!errors.description}
          aria-describedby="ws-desc-err" onChange={e => set('description', e.target.value)} />
        <p className="text-right text-xs text-muted-foreground">{value.description.length}/{LIMITS.description.max}</p>
        <FieldError id="ws-desc-err" message={errors.description} />
      </div>
    </div>
  );
}

export function LogoField({ name, value, onChange }: { name: string; value: WorkspaceLogo | null; onChange: (logo: WorkspaceLogo | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  async function handle(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    const result = await processLogoFile(file);
    setBusy(false);
    if (result.ok) onChange(result.logo);
    else setError(result.message);
    if (input.current) input.current.value = '';
  }

  return (
    <div className="grid gap-4">
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); void handle(e.dataTransfer.files[0]); }}
        className={cn('flex flex-col items-center gap-4 rounded-xl border-2 border-dashed p-6 text-center sm:flex-row sm:text-left',
          dragging ? 'border-primary bg-primary/5' : 'border-border')}>
        <WorkspaceAvatar name={name} logo={value} className="size-20 rounded-2xl text-xl ring-1 ring-border" />
        <div className="flex-1 space-y-1">
          <p className="font-medium">{value ? 'Logo hiện tại' : 'Chưa có logo — đang dùng chữ viết tắt'}</p>
          <p className="text-sm text-muted-foreground">PNG, JPEG hoặc WebP · tối thiểu {LIMITS.logoMinPx}×{LIMITS.logoMinPx}px · tỷ lệ tối đa {LIMITS.logoMaxAspect}:1. Kéo thả hoặc chọn tệp.</p>
          {value && <p className="text-xs text-muted-foreground" data-testid="logo-meta">Đã tối ưu: {value.width}×{value.height}px · {Math.ceil(value.bytes / 1024)} KB · {value.mime}</p>}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => input.current?.click()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <ImageUp />} {value ? 'Đổi logo' : 'Chọn logo'}
          </Button>
          {value && <Button type="button" variant="ghost" size="icon" aria-label="Xóa logo" onClick={() => onChange(null)}><Trash2 /></Button>}
        </div>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" data-testid="logo-input"
          aria-label="Tệp logo" onChange={e => void handle(e.target.files?.[0])} />
      </div>
      {error && <p role="alert" data-testid="logo-error" className="text-sm text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">Ảnh được kiểm tra theo nội dung tệp (không tin phần mở rộng), vẽ lại trong trình duyệt để loại bỏ metadata (EXIF/GPS) và thu nhỏ tối đa 512px. Không tệp nào được tải lên máy chủ.</p>
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange, testid }: { value: T; options: { value: T; label: string; icon?: React.ReactNode }[]; onChange: (v: T) => void; testid: string }) {
  return (
    <div role="radiogroup" className="inline-flex rounded-lg border bg-muted/40 p-1">
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} data-testid={`${testid}-${o.value}`} onClick={() => onChange(o.value)}
          className={cn('inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition', value === o.value ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  );
}

export function ThemeFields({ value, onChange }: { value: WorkspaceTheme; onChange: (next: WorkspaceTheme) => void }) {
  const [hexDraft, setHexDraft] = useState(value.primaryColor);
  const check = validateTheme(value);
  const set = <K extends keyof WorkspaceTheme>(key: K, v: WorkspaceTheme[K]) => onChange({ ...value, [key]: v });
  const setColor = (c: string) => { setHexDraft(c); if (/^#[0-9a-f]{6}$/i.test(c)) set('primaryColor', c.toLowerCase()); };
  return (
    <div className="grid gap-6">
      <div className="grid gap-3">
        <Label>Màu thương hiệu</Label>
        <div className="flex flex-wrap gap-2">
          {THEME_PRESETS.map(p => (
            <button key={p.color} type="button" title={p.name} aria-label={p.name} aria-pressed={value.primaryColor === p.color}
              data-testid={`preset-${p.color.slice(1)}`} onClick={() => setColor(p.color)}
              className={cn('relative size-9 rounded-full ring-offset-2 ring-offset-background transition hover:scale-105', value.primaryColor === p.color && 'ring-2 ring-foreground')}
              style={{ backgroundColor: p.color }}>
              {value.primaryColor === p.color && <Check className="absolute inset-0 m-auto size-4 text-white" />}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <input type="color" aria-label="Chọn màu tùy chỉnh" value={value.primaryColor} onChange={e => setColor(e.target.value)}
            className="h-9 w-12 cursor-pointer rounded-md border bg-transparent p-1" />
          <Input aria-label="Mã màu HEX" data-testid="theme-hex" value={hexDraft} maxLength={7} className="w-32 font-mono"
            aria-invalid={!/^#[0-9a-f]{6}$/i.test(hexDraft)} onChange={e => setColor(e.target.value.trim())} />
          {check.textContrast !== null && (
            <Badge variant="outline" data-testid="theme-contrast">Tương phản chữ {check.textContrast}:1 {check.textContrast >= 4.5 ? '· AA' : ''}</Badge>
          )}
        </div>
        {!/^#[0-9a-f]{6}$/i.test(hexDraft) && <p role="alert" className="text-sm text-destructive">Mã màu phải có dạng #RRGGBB.</p>}
        {check.warnings.map(w => <p key={w} data-testid="theme-warning" className="text-sm text-amber-700 dark:text-amber-400">{w}</p>)}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label>Chế độ hiển thị</Label>
          <Segmented testid="theme-mode" value={value.mode} onChange={v => set('mode', v)}
            options={[{ value: 'LIGHT', label: 'Sáng', icon: <Sun className="size-3.5" /> }, { value: 'DARK', label: 'Tối', icon: <Moon className="size-3.5" /> }]} />
        </div>
        <div className="grid gap-2">
          <Label>Thanh điều hướng</Label>
          <Segmented testid="theme-sidebar" value={value.sidebarStyle} onChange={v => set('sidebarStyle', v)}
            options={[{ value: 'LIGHT', label: 'Trung tính' }, { value: 'BRAND', label: 'Màu thương hiệu' }]} />
        </div>
      </div>
      <div className="grid gap-2">
        <Label>Bo góc</Label>
        <Segmented testid="theme-radius" value={value.radius} onChange={v => set('radius', v)} options={RADII.map(r => ({ value: r, label: RADIUS_LABELS[r] }))} />
      </div>
      <p className="text-xs text-muted-foreground">Giao diện chỉ chọn từ tập giá trị được duyệt (màu, bo góc, chế độ). Không nhận CSS, font hay URL tùy ý.</p>
    </div>
  );
}

// Scoped live preview: CSS variables are applied to this subtree only.
export function BrandPreview({ profile, theme, logo }: { profile: WorkspaceProfile; theme: WorkspaceTheme; logo: WorkspaceLogo | null }) {
  const style = themeCssVars(theme) as CSSProperties;
  const name = profile.displayName.trim() || 'Tên tổ chức';
  return (
    <div data-testid="brand-preview" data-primary={theme.primaryColor} className={cn('overflow-hidden rounded-xl border shadow-sm', theme.mode === 'DARK' && 'dark')} style={style}>
      <div className="flex h-72 bg-background text-foreground">
        <div className="flex w-40 flex-col gap-1 border-r border-sidebar-border bg-sidebar p-2 text-sidebar-foreground">
          <div className="mb-2 flex items-center gap-2 rounded-md p-1">
            <WorkspaceAvatar name={name} logo={logo} className="size-7" />
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold">{name}</p>
              <p className="truncate text-[10px] opacity-70">{profile.shortName || 'TC'}</p>
            </div>
          </div>
          {[{ i: <LayoutDashboard className="size-3.5" />, l: 'Tổng quan', a: true }, { i: <FileText className="size-3.5" />, l: 'Tiếp nhận' }, { i: <Settings2 className="size-3.5" />, l: 'Cài đặt' }].map(x => (
            <div key={x.l} className={cn('flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px]', x.a && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground')}>{x.i}{x.l}</div>
          ))}
        </div>
        <div className="flex-1 space-y-3 bg-muted/30 p-4">
          <div className="h-2.5 w-24 rounded-full bg-foreground/15" />
          <div className="rounded-[var(--radius)] border bg-card p-3 text-card-foreground shadow-xs">
            <p className="text-xs font-semibold">Chào mừng đến {name}</p>
            <p className="mt-1 text-[10px] text-muted-foreground">Xem trước giao diện không gian làm việc.</p>
            <div className="mt-3 flex gap-2">
              <span className="rounded-[var(--radius)] bg-primary px-2.5 py-1 text-[10px] font-medium text-primary-foreground">Nút chính</span>
              <span className="rounded-[var(--radius)] border px-2.5 py-1 text-[10px]">Nút phụ</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-[var(--radius)] border bg-card p-2"><div className="h-1.5 w-2/3 rounded-full bg-primary" /><div className="mt-2 h-1.5 w-1/2 rounded-full bg-foreground/10" /></div>
            <div className="rounded-[var(--radius)] border bg-card p-2"><div className="h-1.5 w-1/2 rounded-full bg-primary/60" /><div className="mt-2 h-1.5 w-2/3 rounded-full bg-foreground/10" /></div>
          </div>
        </div>
      </div>
    </div>
  );
}
