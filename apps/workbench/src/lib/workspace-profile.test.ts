import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contrastRatio, DEFAULT_THEME, foregroundFor, initialsOf, sniffImageMime, suggestShortName, suggestSlug,
  themeCssVars, THEME_PRESETS, validateLogoDimensions, validateLogoFile, validateProfile, validateTheme,
  type WorkspaceProfile,
} from './workspace-profile.ts';

const valid: WorkspaceProfile = {
  displayName: 'Bảo hiểm Mẫu Minh Họa', shortName: 'BHMH', slug: 'bao-hiem-mau', orgType: 'INSURER', description: '',
};

test('a well-formed profile has no errors and is normalised (NFC, trim, case)', () => {
  assert.deepEqual(validateProfile(valid), {});
  assert.deepEqual(validateProfile({ ...valid, displayName: '  Bảo   hiểm  Mẫu ', shortName: 'bhmh', slug: ' Bao-Hiem-Mau ' }), {});
});

test('suggests ASCII slug and initials from Vietnamese names', () => {
  assert.equal(suggestSlug('Bảo hiểm Đông Á – Chi nhánh 1'), 'bao-hiem-dong-a-chi-nhanh-1');
  assert.equal(suggestSlug('123 Công ty'), 'cong-ty');
  assert.equal(suggestShortName('Bảo hiểm Đông Á'), 'BHDA');
  assert.equal(initialsOf('Bảo hiểm Đông Á'), 'BÁ');
  assert.equal(initialsOf('Vietin'), 'VI');
});

test('rejects markup/control characters and length violations with Vietnamese messages', () => {
  assert.match(validateProfile({ ...valid, displayName: '<script>x</script>' }).displayName!, /không được chứa/);
  assert.match(validateProfile({ ...valid, displayName: 'A' }).displayName!, /ít nhất 2/);
  assert.match(validateProfile({ ...valid, displayName: 'x'.repeat(121) }).displayName!, /tối đa 120/);
  assert.match(validateProfile({ ...valid, description: 'ok {{ x }}' }).description!, /không được chứa/);
  assert.match(validateProfile({ ...valid, shortName: 'B H' }).shortName!, /chữ in hoa/);
});

test('slug rules: pattern, double hyphen, reserved words and uniqueness', () => {
  for (const slug of ['ab', '1abc', 'abc-', 'a--b', 'abc_d', 'ábc', 'x'.repeat(33)]) {
    assert.match(validateProfile({ ...valid, slug }).slug!, /Định danh URL gồm/, slug);
  }
  assert.match(validateProfile({ ...valid, slug: 'admin' }).slug!, /dành riêng/);
  assert.match(validateProfile({ ...valid, slug: 'bao-hiem-mau' }, new Set(['bao-hiem-mau'])).slug!, /đã được dùng/);
  assert.match(validateProfile({ ...valid, orgType: 'HACKER' as never }).orgType!, /loại hình/);
});

test('contrast ratio matches WCAG reference values', () => {
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
  assert.equal(contrastRatio('#767676', '#ffffff'), 4.54);
  assert.equal(foregroundFor('#1d4ed8'), '#ffffff');
  assert.equal(foregroundFor('#fde047'), '#000000');
  assert.equal(foregroundFor('#3f8730'), '#000000');
});

test('every preset is accessible (text >= 4.5:1) and themes are validated', () => {
  for (const p of THEME_PRESETS) {
    const check = validateTheme({ ...DEFAULT_THEME, primaryColor: p.color });
    assert.deepEqual(check.errors, {}, p.name);
    assert.ok(check.textContrast! >= 4.5, `${p.name} ${check.textContrast}`);
  }
  assert.match(validateTheme({ ...DEFAULT_THEME, primaryColor: 'red' }).errors.primaryColor!, /#RRGGBB/);
  assert.match(validateTheme({ ...DEFAULT_THEME, primaryColor: '#1d4ed8; background:url(x)' }).errors.primaryColor!, /#RRGGBB/);
  assert.equal(validateTheme({ ...DEFAULT_THEME, radius: 'XL' as never }).errors.radius, 'Độ bo góc không hợp lệ.');
  assert.ok(validateTheme({ ...DEFAULT_THEME, primaryColor: '#a3a3a3' }).warnings.some(w => w.includes('nền sáng')));
  assert.ok(validateTheme({ ...DEFAULT_THEME, primaryColor: '#1e1b4b', mode: 'DARK' }).warnings.some(w => w.includes('nền tối')));
  assert.deepEqual(validateTheme({ ...DEFAULT_THEME, primaryColor: '#1d4ed8' }).warnings, []);
});

test('automatic button text colour keeps WCAG AA (>= 4.5:1) for every colour', () => {
  for (let i = 0; i < 4096; i++) {
    const hex = `#${((i * 2654435761) >>> 8 & 0xffffff).toString(16).padStart(6, '0')}`;
    assert.ok(contrastRatio(hex, foregroundFor(hex)) >= 4.5, hex);
  }
});

test('CSS variables come only from the allowlist, never from raw input', () => {
  const vars = themeCssVars({ primaryColor: '#0F766E', radius: 'LG', mode: 'LIGHT', sidebarStyle: 'LIGHT' });
  assert.equal(vars['--primary'], '#0f766e');
  assert.equal(vars['--primary-foreground'], '#ffffff');
  assert.equal(vars['--radius'], '1rem');
  const injected = themeCssVars({ primaryColor: 'red;}body{display:none', radius: 'BAD' as never, mode: 'LIGHT', sidebarStyle: 'LIGHT' });
  assert.equal(injected['--primary'], DEFAULT_THEME.primaryColor);
  assert.equal(injected['--radius'], '0.625rem');
  const brand = themeCssVars({ ...DEFAULT_THEME, sidebarStyle: 'BRAND' });
  assert.match(brand['--sidebar']!, /^color-mix\(in oklch, #1d4ed8 88%, black\)$/);
  assert.equal(Object.keys(vars).every(k => /^--[a-z0-9-]+$/.test(k)), true);
});

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
const webp = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ');

test('logo type comes from magic bytes; SVG and disguised files are rejected', () => {
  assert.equal(sniffImageMime(png), 'image/png');
  assert.equal(sniffImageMime(jpeg), 'image/jpeg');
  assert.equal(sniffImageMime(webp), 'image/webp');
  assert.equal(sniffImageMime(new TextEncoder().encode('  <svg onload="alert(1)">')), 'image/svg+xml');
  assert.equal(sniffImageMime(new TextEncoder().encode('<?xml version="1.0"?><svg/>')), 'image/svg+xml');
  assert.equal(sniffImageMime(new TextEncoder().encode('MZ\x90\0')), null);
  assert.match(validateLogoFile({ declaredMime: 'image/png', sniffedMime: 'image/svg+xml', bytes: 10 })!, /SVG/);
  assert.match(validateLogoFile({ declaredMime: 'image/png', sniffedMime: null, bytes: 10 })!, /không phải ảnh/);
  assert.match(validateLogoFile({ declaredMime: 'image/png', sniffedMime: 'image/png', bytes: 300 * 1024 })!, /tối đa 256 KB/);
  assert.equal(validateLogoFile({ declaredMime: 'application/octet-stream', sniffedMime: 'image/webp', bytes: 1000 }), undefined);
});

test('logo dimensions and aspect ratio limits', () => {
  assert.equal(validateLogoDimensions(256, 256), undefined);
  assert.equal(validateLogoDimensions(512, 128), undefined);
  assert.match(validateLogoDimensions(32, 32)!, /tối thiểu 64/);
  assert.match(validateLogoDimensions(4096, 1024)!, /tối đa 2048/);
  assert.match(validateLogoDimensions(1000, 100)!, /quá dài/);
});
