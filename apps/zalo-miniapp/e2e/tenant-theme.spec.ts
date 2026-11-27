import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Issue #106 theme acceptance: the app theme follows the active VERIFIED tenant through CSS tokens; computed
 * colours (not screenshots) are asserted. Contrast maths mirrors WCAG 2.x. Synthetic adapter only.
 */
function guard(page: Page) {
  const errors: string[] = [];
  const offending: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol !== 'data:' && u.hostname !== '127.0.0.1') offending.push(r.url());
    if (r.method() !== 'GET') offending.push(`${r.method()} ${r.url()}`);
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return { assertClean: () => { expect(offending).toEqual([]); expect(errors).toEqual([]); } };
}

const html = (page: Page) => page.locator('html');
const screen = (page: Page) => page.locator('.zaui-routes-item:not([inert])');
const avatar = (page: Page) => screen(page).getByTestId('workspace-avatar');
const ready = (page: Page) => expect(html(page)).toHaveAttribute('data-context-phase', 'ready', { timeout: 10_000 });
const settled = async (page: Page) => {
  await page.waitForTimeout(50);
  await expect(page.locator('.zaui-routes > .zaui-routes-item')).toHaveCount(1);
};

type Rgb = [number, number, number];
function parse(c: string): Rgb {
  const hex = c.trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as Rgb;
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) throw new Error(`colour? ${c}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
const lum = (c: Rgb) => {
  const ch = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(parse(a)), lum(parse(b))].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
const rgb = (hex: string) => `rgb(${parse(hex).join(', ')})`;

const token = (page: Page, name: string) => html(page).evaluate((e, n) => getComputedStyle(e).getPropertyValue(n).trim(), name);
const css = (l: Locator, prop: string) => l.first().evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);

async function openHub(page: Page, query = '') {
  await page.goto(`/${query}`);
  await page.getByRole('button', { name: 'Mở trang tiện ích cá nhân' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tiện ích của tôi' })).toBeVisible();
  await settled(page);
  await ready(page);
}

async function choose(page: Page, testId: string) {
  await avatar(page).click();
  await page.getByTestId(testId).click();
  await ready(page);
}

const SURFACES = ['#ffffff', '#f4f5f6', '#fff8e6'];

/** Assert the tokens a tenant drives are applied and readable on every surface. */
async function assertTenantTokens(page: Page, brand: string) {
  expect(await token(page, '--brand')).toBe(brand);
  const ink = await token(page, '--brand-ink');
  const on = await token(page, '--brand-on');
  for (const s of SURFACES) expect(contrast(ink, s), `ink ${ink} on ${s}`).toBeGreaterThanOrEqual(4.5);
  expect(contrast(brand, on), 'on-primary on brand').toBeGreaterThanOrEqual(4.5);
  return { ink, on };
}

test('contrasting tenants A/B switch the whole app tokens across hub, Loyalty360 and TPA', async ({ page }) => {
  const g = guard(page);
  await openHub(page);
  await expect(html(page)).toHaveAttribute('data-theme', 'tenant');

  for (const [brand, testId] of [['#0f766e', null], ['#ecbf3b', 'ws-option-BM']] as const) {
    if (testId) await choose(page, testId);
    const { ink, on } = await assertTenantTokens(page, brand);
    const suffix = brand === '#0f766e' ? 'A' : 'B';
    // Hub: tile icon uses ink; tenant mark uses brand + on-brand.
    expect(await css(screen(page).locator('.tile-icon'), 'color')).toBe(rgb(ink));
    expect(await css(screen(page).locator('[data-testid="workspace-avatar"] .tenant-mark'), 'background-color')).toBe(rgb(brand));
    expect(await css(screen(page).locator('[data-testid="workspace-avatar"] .tenant-mark'), 'color')).toBe(rgb(on));
    await page.screenshot({ path: `test-results/106-hub-tenant-${suffix}-390x844.png` });
    await page.setViewportSize({ width: 360, height: 640 });
    await page.screenshot({ path: `test-results/106-hub-tenant-${suffix}-360x640.png` });
    await page.setViewportSize({ width: 390, height: 844 });

    // Loyalty360: card filled with brand, text on-brand. Same tenant, different service.
    await screen(page).getByTestId('tile-loyalty').click();
    await settled(page);
    const card = screen(page).getByTestId('loyalty-card');
    expect(await css(card, 'background-color')).toBe(rgb(brand));
    expect(await css(card, 'color')).toBe(rgb(on));
    expect(await css(screen(page).getByTestId('service-badge'), 'color')).toBe(rgb(ink));
    await page.screenshot({ path: `test-results/106-loyalty-tenant-${suffix}-390x844.png` });

    // TPA: raised action filled with brand (with on-brand icon), active tab in ink, slides on brand.
    await screen(page).getByRole('button', { name: '‹ Trang tiện ích' }).click();
    await settled(page);
    await screen(page).getByTestId('tile-tpa').click();
    await settled(page);
    // No consent for this tenant yet → raised claim action is DISABLED: fixed grey, never tenant-coloured.
    await expect(page.getByTestId('raised-action')).toBeDisabled();
    expect(await css(page.getByTestId('raised-action'), 'background-color')).toBe(rgb('#9aa3ab'));
    // zmp-ui secondary button (consent CTA) is driven by the zaui tokens → brand-soft fill, ink text.
    const cta = screen(page).getByRole('button', { name: 'Xem lại điều khoản đồng ý' });
    expect(await css(cta, 'color')).toBe(rgb(ink));
    expect(await css(cta, 'background-color')).toBe(rgb(await token(page, '--brand-soft')));
    expect(await css(page.locator('.zaui-bottom-navigation-item-active'), 'color')).toBe(rgb(ink));
    expect(await css(screen(page).locator('.slide'), 'color')).toBe(rgb(on));
    await page.screenshot({ path: `test-results/106-tpa-tenant-${suffix}-390x844.png` });
    await screen(page).getByRole('button', { name: '‹ Trang tiện ích' }).click();
    await settled(page);
  }
  g.assertClean();
});

test('OD-WS1: low-contrast brand shows a warning, keeps the stored colour, derives readable ink/border/focus', async ({ page }) => {
  const g = guard(page);
  await openHub(page, '?start=BM');
  await expect(html(page)).toHaveAttribute('data-theme-warning', 'LOW_SURFACE_CONTRAST');
  await expect(screen(page).getByTestId('theme-warning')).toContainText('màu gốc của đơn vị không bị thay đổi');
  expect(await token(page, '--brand')).toBe('#ecbf3b'); // stored brand untouched
  const ink = await token(page, '--brand-ink');
  expect(ink).not.toBe('#ecbf3b');
  expect(await token(page, '--brand-border')).toBe(ink); // control fallback border
  expect(await token(page, '--brand-on')).toBe('#000000');
  // Focus ring on a control uses the readable ink.
  await avatar(page).focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  expect(await css(avatar(page), 'outline-color')).toBe(rgb(ink));
  // The brand-filled mark carries the derived border so its edge is visible on white.
  expect(await css(screen(page).locator('[data-testid="workspace-avatar"] .tenant-mark'), 'box-shadow')).toContain(rgb(ink));
  await page.screenshot({ path: 'test-results/106-low-contrast-B-360x640.png' });
  g.assertClean();
});

test('readable teal brand: no warning, ink = stored brand, no fallback border', async ({ page }) => {
  const g = guard(page);
  await openHub(page);
  await expect(html(page)).toHaveAttribute('data-theme-warning', 'none');
  expect(await token(page, '--brand-ink')).toBe('#0f766e');
  expect(await token(page, '--brand-border')).toBe('transparent');
  await expect(screen(page).getByTestId('theme-warning')).toHaveCount(0);
  g.assertClean();
});

test('semantic success/warning/error and disabled colours do not change with the tenant', async ({ page }) => {
  const g = guard(page);
  const sample = async () => ({
    ok: await token(page, '--ok'),
    warn: await token(page, '--warn'),
    bad: await token(page, '--bad'),
    disabled: await css(screen(page).getByTestId('tile-utilities'), 'color'),
  });
  await openHub(page);
  const a = await sample();
  await choose(page, 'ws-option-BM');
  const b = await sample();
  await choose(page, 'ws-option-CT');
  const c = await sample();
  expect(a).toEqual({ ok: '#0f6b3a', warn: '#8a4b00', bad: '#b3261e', disabled: rgb('#4a5468') });
  expect(b).toEqual(a);
  expect(c).toEqual(a);

  // Claim status chips (PAID = success) are identical under A and B.
  const paidChip = async (code: string) => {
    await screen(page).getByTestId('tile-tpa').click();
    await settled(page);
    await page.getByRole('button', { name: 'Hồ sơ', exact: true }).click();
    await settled(page);
    const chip = screen(page).getByTestId(`claim-${code}`).locator('.chip');
    return { bg: await css(chip, 'background-color'), fg: await css(chip, 'color') };
  };
  await choose(page, 'ws-option-AB');
  const chipA = await paidChip('MAU-2026-000087');
  await page.getByRole('button', { name: 'Trang chủ', exact: true }).click();
  await settled(page);
  await choose(page, 'ws-option-BM');
  await screen(page).getByRole('button', { name: '‹ Trang tiện ích' }).click();
  await settled(page);
  const chipB = await paidChip('MAU-2026-000612');
  expect(chipB).toEqual(chipA);
  expect(chipA.fg).toBe(rgb('#0f6b3a'));
  g.assertClean();
});

test('error state colour is semantic, theme neutral while failed', async ({ page }) => {
  const g = guard(page);
  await openHub(page);
  await page.getByRole('button', { name: 'Cá nhân', exact: true }).click();
  await settled(page);
  await page.getByLabel('Mất kết nối mạng (mô phỏng)').check();
  await avatar(page).click();
  await page.getByTestId('ws-option-BM').click();
  const fail = screen(page).getByTestId('switch-failure');
  await expect(fail).toBeVisible();
  expect(await css(fail, 'border-top-color')).toBe(rgb('#b3261e'));
  await expect(html(page)).toHaveAttribute('data-theme', 'neutral');
  expect(await token(page, '--brand')).toBe('#183346');
  g.assertClean();
});

test('neutral theme: personal context, while switching, and for an invalid theme payload', async ({ page }) => {
  const g = guard(page);
  await openHub(page, '?start=PERSONAL&slow=BM&badtheme=CT');
  await expect(html(page)).toHaveAttribute('data-theme', 'neutral');
  expect(await token(page, '--brand')).toBe('#183346');
  await page.screenshot({ path: 'test-results/106-hub-personal-neutral-390x844.png' });
  await page.setViewportSize({ width: 360, height: 640 });
  await page.screenshot({ path: 'test-results/106-hub-personal-neutral-360x640.png' });
  await page.setViewportSize({ width: 390, height: 844 });

  // Switching to slow B: neutral until B commits — never the previous colour, never B early.
  await choose(page, 'ws-option-AB');
  expect(await token(page, '--brand')).toBe('#0f766e');
  await avatar(page).click();
  await page.getByTestId('ws-option-BM').click();
  await expect(html(page)).toHaveAttribute('data-context-phase', 'switching');
  expect(await token(page, '--brand')).toBe('#183346');
  await ready(page);
  expect(await token(page, '--brand')).toBe('#ecbf3b');

  // C's theme payload is invalid ('red') → contract validation fails → neutral, with an explanation.
  await choose(page, 'ws-option-CT');
  await expect(html(page)).toHaveAttribute('data-theme', 'neutral');
  expect(await token(page, '--brand')).toBe('#183346');
  await expect(screen(page).getByTestId('theme-fallback')).toBeVisible();
  g.assertClean();
});

test('branding update: cache keyed by version is invalidated; new colour after re-authorised switch', async ({ page }) => {
  const g = guard(page);
  await openHub(page);
  expect(await token(page, '--brand')).toBe('#0f766e');
  await page.getByRole('button', { name: 'Cá nhân', exact: true }).click();
  await settled(page);
  await page.getByTestId('branding-update').click();
  await page.getByTestId('refresh-memberships').click();
  await choose(page, 'ws-option-BM');
  await choose(page, 'ws-option-AB');
  expect(await token(page, '--brand')).toBe('#b91c1c');
  g.assertClean();
});

test('reload / remembered preference is re-authorised: granted → that tenant theme; not granted → personal', async ({ page }) => {
  const g = guard(page);
  await openHub(page, '?start=BM');
  expect(await token(page, '--brand')).toBe('#ecbf3b');
  await page.reload();
  await page.getByRole('button', { name: 'Mở trang tiện ích cá nhân' }).click();
  await ready(page);
  expect(await token(page, '--brand')).toBe('#ecbf3b');
  await openHub(page, '?start=BM&members=1'); // preference no longer granted
  await expect(html(page)).toHaveAttribute('data-theme', 'neutral');
  await expect(screen(page).getByTestId('workspace-name')).toHaveText('Loyalty360 cá nhân');
  g.assertClean();
});

test('switch timing at stated synthetic conditions (measurement, not an SLA)', async ({ page }) => {
  const g = guard(page);
  await openHub(page);
  const samples: number[] = [];
  for (const id of ['ws-option-BM', 'ws-option-CT', 'ws-option-AB', 'ws-option-personal']) {
    await choose(page, id);
    samples.push(Number(await html(page).getAttribute('data-switch-ms')));
  }
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/106-switch-timing.json', `${JSON.stringify({
    conditions: 'synthetic adapter, 120 ms per call (select + theme + data for tenants; 1 call for personal), Pixel 7 Chromium emulation, production bundle via vite preview',
    samplesMs: samples,
  }, null, 2)}\n`);
  for (const s of samples) expect(s).toBeGreaterThan(0);
  g.assertClean();
});
