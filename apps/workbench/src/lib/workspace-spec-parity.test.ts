import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_THEME, LIMITS, ORG_TYPES, RESERVED_SLUGS, THEME_PRESETS, validateLogoDimensions, validateLogoFile,
  validateProfile, validateTheme, type WorkspaceProfile,
} from './workspace-profile.ts';

// docs/ai-specs/13 is the backend proposal; the prototype must enforce exactly what it documents.
const doc = readFileSync(new URL('../../../../docs/ai-specs/13-workspace-onboarding-and-branding-proposal.md', import.meta.url), 'utf8');
const base: WorkspaceProfile = { displayName: 'Bảo hiểm Mẫu', shortName: 'BHM', slug: 'bao-hiem-mau', orgType: 'INSURER', description: '' };

test('reserved slugs, org types and presets match the proposal', () => {
  const line = doc.split('\n').find(l => l.startsWith('Slug dành riêng:'))!;
  const documented = new Set(line.slice(line.indexOf('`') + 1, line.lastIndexOf('`')).split(',').map(s => s.trim()));
  assert.deepEqual([...documented].sort(), [...RESERVED_SLUGS].sort());
  for (const t of ORG_TYPES) assert.ok(doc.includes(`\`${t}\``), t);
  for (const p of THEME_PRESETS) assert.ok(doc.includes(`${p.name} \`${p.color}\``), p.name);
  assert.ok(doc.includes(`mặc định \`${DEFAULT_THEME.primaryColor}\``));
});

test('documented limits equal the enforced limits', () => {
  for (const s of [
    `${LIMITS.displayName.min}–${LIMITS.displayName.max} ký tự`, `${LIMITS.shortName.min}–${LIMITS.shortName.max}, `,
    `${LIMITS.slug.min}–${LIMITS.slug.max}, `, `≤ ${LIMITS.description.max}`, `≤ ${LIMITS.logoBytes / 1024} KB`,
    `${LIMITS.logoMinPx}–${LIMITS.logoMaxPx} px`, `tỷ lệ ≤ ${LIMITS.logoMaxAspect}:1`,
  ]) assert.ok(doc.includes(s), s);
});

test('every Vietnamese validation message produced by the prototype appears verbatim in the proposal', () => {
  const messages = [
    validateProfile({ ...base, displayName: 'A' }).displayName,
    validateProfile({ ...base, displayName: 'x'.repeat(121) }).displayName,
    validateProfile({ ...base, shortName: 'B H' }).shortName,
    validateProfile({ ...base, slug: 'a--b' }).slug,
    validateProfile({ ...base, slug: 'admin' }).slug,
    validateProfile(base, new Set(['bao-hiem-mau'])).slug,
    validateProfile({ ...base, orgType: 'X' as never }).orgType,
    validateProfile({ ...base, description: 'x'.repeat(301) }).description,
    validateTheme({ ...DEFAULT_THEME, primaryColor: 'red' }).errors.primaryColor,
    validateTheme({ ...DEFAULT_THEME, radius: 'XL' as never }).errors.radius,
    validateTheme({ ...DEFAULT_THEME, mode: 'X' as never }).errors.mode,
    validateTheme({ ...DEFAULT_THEME, sidebarStyle: 'X' as never }).errors.sidebarStyle,
    validateLogoDimensions(32, 32),
    validateLogoFile({ declaredMime: 'image/svg+xml', sniffedMime: 'image/svg+xml', bytes: 1 })!.split('.')[0],
    validateLogoFile({ declaredMime: 'image/png', sniffedMime: 'image/png', bytes: 300 * 1024 })!.split(' (')[0],
  ];
  for (const m of messages) {
    assert.ok(m, 'message expected');
    assert.ok(doc.includes(m!), `missing in spec 13: ${m}`);
  }
});
