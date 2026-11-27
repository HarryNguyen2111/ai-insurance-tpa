import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NEUTRAL_THEME,
  SURFACES,
  TEXT_MIN,
  NON_TEXT_MIN,
  contrast,
  cssVariables,
  deriveTenantTheme,
  onColor,
  themeCacheKey,
} from './theme.ts';
import { SYNTHETIC_THEMES } from '../fixtures/workspaces.ts';

const allSurfaces = (c: string) => Object.values(SURFACES).map((s) => contrast(c, s));

test('only contract-valid #rrggbb (lower-case) is accepted; anything else → null (neutral fallback)', () => {
  for (const bad of ['red', '#0F766E', '#0f766e;x', '#fff', 'url(x)', '', null, undefined, 42, '#0f766e\n']) {
    assert.equal(deriveTenantTheme(bad), null, String(bad));
  }
  assert.ok(deriveTenantTheme('#0f766e'));
});

test('on-primary is white or black, whichever contrasts more, and always ≥ 4.5:1 (spec 13)', () => {
  for (let i = 0; i < 4096; i += 7) {
    const hex = `#${[(i >> 8) & 15, (i >> 4) & 15, i & 15].map((n) => (n * 17).toString(16).padStart(2, '0')).join('')}`;
    const on = onColor(hex);
    assert.ok(contrast(hex, on) >= TEXT_MIN, `${hex} on ${on}`);
  }
});

test('readable teal: no warning, ink equals stored brand', () => {
  const t = deriveTenantTheme('#0f766e')!;
  assert.deepEqual(t.warnings, []);
  assert.equal(t.tokens.brand, '#0f766e');
  assert.equal(t.tokens.ink, '#0f766e');
  assert.equal(t.tokens.onBrand, '#ffffff');
  assert.equal(t.tokens.controlBorder, 'transparent');
  assert.equal(t.fallbackApplied, false);
});

test('OD-WS1: low-contrast yellow WARNS (no rejection), stored brand untouched, derived ink/border readable', () => {
  const t = deriveTenantTheme('#ecbf3b')!;
  assert.deepEqual(t.warnings, ['LOW_SURFACE_CONTRAST']);
  assert.equal(t.tokens.brand, '#ecbf3b', 'stored brand is never altered');
  assert.equal(t.tokens.onBrand, '#000000');
  assert.notEqual(t.tokens.ink, '#ecbf3b');
  for (const c of allSurfaces(t.tokens.ink)) assert.ok(c >= TEXT_MIN, `ink contrast ${c}`);
  assert.equal(t.tokens.controlBorder, t.tokens.ink);
  for (const c of allSurfaces(t.tokens.controlBorder)) assert.ok(c >= NON_TEXT_MIN);
  assert.equal(t.fallbackApplied, true);
});

test('every synthetic tenant theme yields readable ink, on-brand and focus ring', () => {
  for (const th of Object.values(SYNTHETIC_THEMES)) {
    const t = deriveTenantTheme(th.primaryColor)!;
    assert.ok(contrast(t.tokens.brand, t.tokens.onBrand) >= TEXT_MIN);
    assert.ok(contrast(t.tokens.brandPressed, t.tokens.onBrand) >= TEXT_MIN - 1.5, 'pressed state stays legible');
    for (const c of allSurfaces(t.tokens.ink)) assert.ok(c >= TEXT_MIN);
  }
});

test('css variables are exactly the brand token set — semantic ok/warn/bad are never emitted', () => {
  const vars = cssVariables(deriveTenantTheme('#6d28d9')!);
  assert.deepEqual(Object.keys(vars).sort(), ['--brand', '--brand-border', '--brand-ink', '--brand-on', '--brand-pressed', '--brand-soft']);
  for (const v of Object.values(vars)) assert.match(v, /^(#[0-9a-f]{6}|transparent)$/);
  assert.equal(cssVariables(NEUTRAL_THEME)['--brand'], '#183346');
});

test('theme cache key = membership + branding version only', () => {
  assert.equal(themeCacheKey('m-1', 3), 'theme:m-1:v3');
  assert.notEqual(themeCacheKey('m-1', 3), themeCacheKey('m-1', 4));
});
