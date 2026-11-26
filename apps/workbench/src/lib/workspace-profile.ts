// Workspace (organisation) profile, logo and theme rules for the BROWSER-ONLY
// onboarding prototype. Mirrors the proposal in
// docs/ai-specs/13-workspace-onboarding-and-branding-proposal.md so the future
// backend can reuse identical limits/messages. Nothing here grants access,
// creates a tenant or is authoritative: the backend will re-validate everything.

export const ORG_TYPES = ['INSURER', 'TPA_OPERATOR', 'CORPORATE_CLIENT'] as const;
export type OrgType = (typeof ORG_TYPES)[number];

export const ORG_TYPE_LABELS: Record<OrgType, string> = {
  INSURER: 'Doanh nghiệp bảo hiểm',
  TPA_OPERATOR: 'Đơn vị vận hành TPA',
  CORPORATE_CLIENT: 'Doanh nghiệp mua bảo hiểm nhóm',
};

export const RADII = ['NONE', 'SM', 'MD', 'LG'] as const;
export type Radius = (typeof RADII)[number];
export const RADIUS_REM: Record<Radius, string> = { NONE: '0rem', SM: '0.375rem', MD: '0.625rem', LG: '1rem' };
export const RADIUS_LABELS: Record<Radius, string> = { NONE: 'Vuông', SM: 'Bo nhẹ', MD: 'Bo vừa', LG: 'Bo tròn' };

export const MODES = ['LIGHT', 'DARK'] as const;
export type Mode = (typeof MODES)[number];

export const SIDEBAR_STYLES = ['LIGHT', 'BRAND'] as const;
export type SidebarStyle = (typeof SIDEBAR_STYLES)[number];

export interface WorkspaceProfile {
  displayName: string;
  shortName: string;
  slug: string;
  orgType: OrgType;
  description: string;
}

export interface WorkspaceTheme {
  primaryColor: string; // #rrggbb lowercase
  radius: Radius;
  mode: Mode;
  sidebarStyle: SidebarStyle;
}

export const LOGO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type LogoMime = (typeof LOGO_MIME_TYPES)[number];

export interface WorkspaceLogo {
  mime: LogoMime;
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
}

export const LIMITS = {
  displayName: { min: 2, max: 120 },
  shortName: { min: 2, max: 12 },
  slug: { min: 3, max: 32 },
  description: { max: 300 },
  logoBytes: 256 * 1024,
  logoMinPx: 64,
  logoMaxPx: 2048,
  logoMaxAspect: 4,
} as const;

export const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'auth', 'login', 'logout', 'public', 'static', 'health', 'internal',
  'www', 'mail', 'tpa', 'mps', 'support', 'help', 'status', 'docs', 'v1', 'next', 'assets',
]);

export const THEME_PRESETS: { name: string; color: string }[] = [
  { name: 'Xanh đại dương', color: '#1d4ed8' },
  { name: 'Xanh ngọc', color: '#0f766e' },
  { name: 'Lục bảo', color: '#047857' },
  { name: 'Đỏ son', color: '#b91c1c' },
  { name: 'Cam đất', color: '#c2410c' },
  { name: 'Tím than', color: '#6d28d9' },
  { name: 'Than chì', color: '#334155' },
];

export const DEFAULT_THEME: WorkspaceTheme = { primaryColor: '#1d4ed8', radius: 'MD', mode: 'LIGHT', sidebarStyle: 'LIGHT' };

export type FieldErrors = Partial<Record<string, string>>;

const FORBIDDEN_TEXT = /[<>{}`\u0000-\u0008\u000b-\u001f\u007f]/;

export function normalizeText(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ');
}

function checkPlainText(value: string, min: number, max: number, label: string): string | undefined {
  if (value.length < min) return min <= 1 ? `${label} không được để trống.` : `${label} cần ít nhất ${min} ký tự.`;
  if (value.length > max) return `${label} tối đa ${max} ký tự.`;
  if (FORBIDDEN_TEXT.test(value)) return `${label} không được chứa ký tự < > { } \` hoặc ký tự điều khiển.`;
  return undefined;
}

// Vietnamese-aware slug suggestion: "Bảo hiểm Hòa Bình" -> "bao-hiem-hoa-binh".
export function suggestSlug(displayName: string): string {
  return displayName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[0-9-]+/, '')
    .slice(0, LIMITS.slug.max)
    .replace(/-+$/g, '');
}

export function suggestShortName(displayName: string): string {
  const words = suggestSlug(displayName).split('-').filter(Boolean);
  const initials = words.map(w => w[0]).join('').toUpperCase();
  return initials.slice(0, LIMITS.shortName.max);
}

export function normalizeProfile(input: WorkspaceProfile): WorkspaceProfile {
  return {
    displayName: normalizeText(input.displayName),
    shortName: normalizeText(input.shortName).toUpperCase(),
    slug: input.slug.trim().toLowerCase(),
    orgType: input.orgType,
    description: input.description.normalize('NFC').trim(),
  };
}

export function validateProfile(input: WorkspaceProfile, takenSlugs: ReadonlySet<string> = new Set()): FieldErrors {
  const p = normalizeProfile(input);
  const errors: FieldErrors = {};
  errors.displayName = checkPlainText(p.displayName, LIMITS.displayName.min, LIMITS.displayName.max, 'Tên tổ chức');
  if (p.shortName.length < LIMITS.shortName.min || p.shortName.length > LIMITS.shortName.max || !/^[A-Z0-9][A-Z0-9-]*$/.test(p.shortName)) {
    errors.shortName = `Tên viết tắt gồm ${LIMITS.shortName.min}–${LIMITS.shortName.max} chữ in hoa, số hoặc dấu gạch ngang.`;
  }
  if (p.slug.length < LIMITS.slug.min || p.slug.length > LIMITS.slug.max || !/^[a-z][a-z0-9-]*[a-z0-9]$/.test(p.slug) || p.slug.includes('--')) {
    errors.slug = `Định danh URL gồm ${LIMITS.slug.min}–${LIMITS.slug.max} ký tự a-z, 0-9, dấu gạch ngang; bắt đầu bằng chữ cái.`;
  } else if (RESERVED_SLUGS.has(p.slug)) {
    errors.slug = 'Định danh URL này được hệ thống dành riêng.';
  } else if (takenSlugs.has(p.slug)) {
    errors.slug = 'Định danh URL đã được dùng cho tổ chức khác.';
  }
  if (!ORG_TYPES.includes(p.orgType)) errors.orgType = 'Vui lòng chọn loại hình tổ chức.';
  if (p.description !== '') {
    errors.description = checkPlainText(p.description.replace(/\n/g, ' '), 1, LIMITS.description.max, 'Mô tả');
  }
  for (const key of Object.keys(errors)) if (errors[key] === undefined) delete errors[key];
  return errors;
}

// ---- Colour / contrast (WCAG 2.x relative luminance) ----

export function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

export const LIGHT_TEXT = '#ffffff';
export const DARK_TEXT = '#000000';

export function foregroundFor(primary: string): string {
  return contrastRatio(primary, LIGHT_TEXT) >= contrastRatio(primary, DARK_TEXT) ? LIGHT_TEXT : DARK_TEXT;
}

export interface ThemeCheck {
  errors: FieldErrors;
  warnings: string[];
  textContrast: number | null;
}

export function validateTheme(theme: WorkspaceTheme): ThemeCheck {
  const errors: FieldErrors = {};
  const warnings: string[] = [];
  if (!isHexColor(theme.primaryColor)) errors.primaryColor = 'Màu chính phải có dạng #RRGGBB.';
  if (!RADII.includes(theme.radius)) errors.radius = 'Độ bo góc không hợp lệ.';
  if (!MODES.includes(theme.mode)) errors.mode = 'Chế độ hiển thị không hợp lệ.';
  if (!SIDEBAR_STYLES.includes(theme.sidebarStyle)) errors.sidebarStyle = 'Kiểu thanh bên không hợp lệ.';
  if (errors.primaryColor) return { errors, warnings, textContrast: null };
  const color = theme.primaryColor.toLowerCase();
  // Text colour is chosen automatically (white/near-black); the better of the two is
  // always >= 4.5:1 (WCAG AA), so only the colour-on-surface contrast can fail.
  const textContrast = contrastRatio(color, foregroundFor(color));
  const surface = theme.mode === 'DARK' ? '#0a0a0a' : '#ffffff';
  const uiContrast = contrastRatio(color, surface);
  if (uiContrast < 3) warnings.push(`Màu chính trên nền ${theme.mode === 'DARK' ? 'tối' : 'sáng'} chỉ đạt ${uiContrast}:1; viền/biểu tượng có thể khó nhận ra.`);
  return { errors, warnings, textContrast };
}

// CSS custom properties consumed by the shadcn/ui tokens in globals.css. Values are
// produced only from the validated closed allowlist above (no tenant-supplied CSS).
export function themeCssVars(theme: WorkspaceTheme): Record<string, string> {
  const primary = isHexColor(theme.primaryColor) ? theme.primaryColor.toLowerCase() : DEFAULT_THEME.primaryColor;
  const fg = foregroundFor(primary);
  const vars: Record<string, string> = {
    '--primary': primary,
    '--primary-foreground': fg,
    '--ring': primary,
    '--chart-1': primary,
    '--sidebar-primary': primary,
    '--sidebar-primary-foreground': fg,
    '--sidebar-ring': primary,
    '--radius': RADIUS_REM[theme.radius] ?? RADIUS_REM.MD,
  };
  if (theme.sidebarStyle === 'BRAND') {
    vars['--sidebar'] = `color-mix(in oklch, ${primary} 88%, black)`;
    vars['--sidebar-foreground'] = '#ffffff';
    vars['--sidebar-accent'] = 'color-mix(in oklch, white 14%, transparent)';
    vars['--sidebar-accent-foreground'] = '#ffffff';
    vars['--sidebar-border'] = 'color-mix(in oklch, white 14%, transparent)';
    vars['--sidebar-primary'] = '#ffffff';
    vars['--sidebar-primary-foreground'] = primary;
  }
  return vars;
}

// ---- Logo ----

// Identify the real image type from magic bytes; the declared browser MIME is not trusted.
export function sniffImageMime(head: Uint8Array): LogoMime | 'image/svg+xml' | null {
  const b = head;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  const text = new TextDecoder().decode(b.slice(0, 256)).trimStart().toLowerCase();
  if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) return 'image/svg+xml';
  return null;
}

export function validateLogoFile(meta: { declaredMime: string; sniffedMime: string | null; bytes: number }): string | undefined {
  if (meta.sniffedMime === 'image/svg+xml' || meta.declaredMime === 'image/svg+xml') {
    return 'Không hỗ trợ SVG vì tệp SVG có thể chứa mã thực thi. Hãy dùng PNG, JPEG hoặc WebP.';
  }
  if (meta.sniffedMime === null || !(LOGO_MIME_TYPES as readonly string[]).includes(meta.sniffedMime)) {
    return 'Tệp không phải ảnh PNG, JPEG hoặc WebP hợp lệ.';
  }
  if (meta.bytes === 0) return 'Tệp rỗng.';
  if (meta.bytes > LIMITS.logoBytes) return `Logo tối đa ${LIMITS.logoBytes / 1024} KB (tệp hiện tại ${Math.ceil(meta.bytes / 1024)} KB).`;
  return undefined;
}

export function validateLogoDimensions(width: number, height: number): string | undefined {
  if (width < LIMITS.logoMinPx || height < LIMITS.logoMinPx) return `Logo cần tối thiểu ${LIMITS.logoMinPx}×${LIMITS.logoMinPx} px.`;
  if (width > LIMITS.logoMaxPx || height > LIMITS.logoMaxPx) return `Logo tối đa ${LIMITS.logoMaxPx}×${LIMITS.logoMaxPx} px.`;
  const ratio = Math.max(width / height, height / width);
  if (ratio > LIMITS.logoMaxAspect) return `Tỷ lệ khung hình logo quá dài (tối đa ${LIMITS.logoMaxAspect}:1).`;
  return undefined;
}

export function initialsOf(displayName: string): string {
  const words = normalizeText(displayName).split(' ').filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.length === 1 ? words[0]!.slice(0, 2) : `${words[0]![0]}${words[words.length - 1]![0]}`;
  return letters.toUpperCase();
}
