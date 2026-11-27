/**
 * Tenant theme tokens (issue #106, theme acceptance) derived from the #72 / docs/ai-specs/13 §3 contract.
 *
 * Input is ONLY `WorkspaceTheme.primaryColor` (`^#[0-9a-f]{6}$`, stored lower-case). Nothing else a tenant
 * supplies reaches CSS: no CSS text, font, URL or HTML (contract: "closed allowlist only"). Values are
 * re-validated here even though the server validates too, so a malformed payload falls back to neutral
 * instead of being injected into a style property.
 *
 * Rules taken from spec 13:
 *  - on-primary is white or black, whichever has the higher contrast (always ≥ 4.5:1, WCAG AA).
 *  - primary vs page background < 3:1 → WARNING `LOW_SURFACE_CONTRAST` only (OD-WS1: warn, never reject).
 * Added for #106 (display-only, never written back): when the stored colour is too light to be used as
 * text/links/focus ring on white, a darker `ink` is DERIVED for those roles and a visible control border
 * is added. The stored `primaryColor` is returned unchanged in `brand`.
 *
 * Colour maths uses plain numbers: this is colour, not money (the zero-float rule covers VND amounts).
 */

export const HEX_COLOR = /^#[0-9a-f]{6}$/;

/** Surfaces the shell actually paints tokens on (styles.css --card, --bg, --warm). */
export const SURFACES = { card: '#ffffff', page: '#f4f5f6', warm: '#fff8e6' } as const;

export const TEXT_MIN = 4.5;
export const NON_TEXT_MIN = 3;

export type ThemeWarning = 'LOW_SURFACE_CONTRAST';

export type ThemeTokens = {
  /** Stored brand colour, unchanged. Fills (buttons, raised action, slides, tab indicator). */
  brand: string;
  /** Text/icon colour on `brand` fills. */
  onBrand: string;
  /** Pressed state of brand fills. */
  brandPressed: string;
  /** Tinted background (tile icons, selected rows). */
  brandSoft: string;
  /** Brand used as text/link/selected-tab/focus ring on light surfaces; ≥ 4.5:1 on every surface. */
  ink: string;
  /** Border drawn around brand fills when the fill itself is < 3:1 against the page ('transparent' otherwise). */
  controlBorder: string;
};

export type DerivedTheme = {
  kind: 'TENANT' | 'NEUTRAL';
  tokens: ThemeTokens;
  warnings: ThemeWarning[];
  /** true when `ink`/`controlBorder` differ from the stored brand to keep things readable. */
  fallbackApplied: boolean;
};

type Rgb = readonly [number, number, number];

export function parseHex(hex: string): Rgb | null {
  if (typeof hex !== 'string' || !HEX_COLOR.test(hex)) return null;
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb;
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) throw new Error('invalid colour');
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** WCAG 2.x contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Mix `hex` toward `target` by `pct` percent (integer 0..100). */
export function mix(hex: string, target: string, pct: number): string {
  const a = parseHex(hex)!;
  const b = parseHex(target)!;
  return toHex([0, 1, 2].map((i) => a[i]! + ((b[i]! - a[i]!) * pct) / 100) as unknown as Rgb);
}

export function onColor(hex: string): '#ffffff' | '#000000' {
  return contrast(hex, '#ffffff') >= contrast(hex, '#000000') ? '#ffffff' : '#000000';
}

const worstSurfaceContrast = (hex: string) => Math.min(...Object.values(SURFACES).map((s) => contrast(hex, s)));

/** Darken in 5 % steps until the colour reads as text on every light surface (black always qualifies). */
export function readableInk(hex: string): string {
  for (let pct = 0; pct <= 100; pct += 5) {
    const c = pct === 0 ? hex : mix(hex, '#000000', pct);
    if (worstSurfaceContrast(c) >= TEXT_MIN) return c;
  }
  return '#000000';
}

/** Platform (personal / no-tenant / loading / failed) theme: the #104 reference navy palette. */
export const PLATFORM_PRIMARY = '#183346';

export const NEUTRAL_THEME: DerivedTheme = Object.freeze({
  kind: 'NEUTRAL',
  tokens: {
    brand: PLATFORM_PRIMARY,
    onBrand: '#ffffff',
    brandPressed: '#0f2231',
    brandSoft: '#fdf0c8',
    ink: PLATFORM_PRIMARY,
    controlBorder: 'transparent',
  },
  warnings: [],
  fallbackApplied: false,
}) as DerivedTheme;

/**
 * Derive tokens for a tenant. Returns null for anything that is not a contract-valid colour so the caller
 * shows the neutral theme rather than a previous tenant's colour or an injected value.
 */
export function deriveTenantTheme(primaryColor: unknown): DerivedTheme | null {
  if (typeof primaryColor !== 'string' || !HEX_COLOR.test(primaryColor)) return null;
  const brand = primaryColor;
  const warnings: ThemeWarning[] = contrast(brand, SURFACES.page) < NON_TEXT_MIN ? ['LOW_SURFACE_CONTRAST'] : [];
  const ink = readableInk(brand);
  const lowFill = worstSurfaceContrast(brand) < NON_TEXT_MIN;
  return {
    kind: 'TENANT',
    tokens: {
      brand,
      onBrand: onColor(brand),
      brandPressed: mix(brand, '#000000', 15),
      brandSoft: mix(brand, '#ffffff', 86),
      ink,
      controlBorder: lowFill ? ink : 'transparent',
    },
    warnings,
    fallbackApplied: ink !== brand || lowFill,
  };
}

/** CSS custom properties the shell reads (styles.css). The only place tenant colour enters the DOM. */
export function cssVariables(t: DerivedTheme): Record<string, string> {
  return {
    '--brand': t.tokens.brand,
    '--brand-on': t.tokens.onBrand,
    '--brand-pressed': t.tokens.brandPressed,
    '--brand-soft': t.tokens.brandSoft,
    '--brand-ink': t.tokens.ink,
    '--brand-border': t.tokens.controlBorder,
  };
}

/** Theme cache key: tenant (membership) + branding version only. No principal data, no cross-tenant key. */
export function themeCacheKey(membershipId: string, brandingVersion: number): string {
  return `theme:${membershipId}:v${brandingVersion}`;
}
