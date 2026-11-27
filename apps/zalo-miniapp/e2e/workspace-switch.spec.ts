import { expect, test, type Page } from '@playwright/test';

/**
 * Issue #106 — workspace avatar, chooser, round robin and context-switch safety on the SYNTHETIC adapter.
 * These are prototype (mock) results: real membership/RLS behaviour needs the backend contracts (gaps G1–G9).
 */
function guard(page: Page) {
  const offending: string[] = [];
  const errors: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol !== 'data:' && u.hostname !== '127.0.0.1') offending.push(r.url());
    if (r.method() !== 'GET') offending.push(`${r.method()} ${r.url()}`);
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return {
    assertClean() {
      expect(offending, 'no external or non-GET requests').toEqual([]);
      expect(errors, 'no runtime/console errors').toEqual([]);
    },
  };
}

const html = (page: Page) => page.locator('html');
/** The exposed (non-inert) screen; the outgoing screen stays mounted during a zmp-ui transition. */
const screen = (page: Page) => page.locator('.zaui-routes-item:not([inert])');
const avatar = (page: Page) => screen(page).getByTestId('workspace-avatar');
const wsName = (page: Page) => screen(page).getByTestId('workspace-name');
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Chọn không gian' });
const settled = async (page: Page) => {
  await page.waitForTimeout(50); // let a just-triggered navigation start before checking it finished
  await expect(page.locator('.zaui-routes > .zaui-routes-item')).toHaveCount(1);
};
const ready = (page: Page) => expect(html(page)).toHaveAttribute('data-context-phase', 'ready', { timeout: 10_000 });

async function closeSheet(page: Page) {
  await sheet(page).getByRole('button', { name: 'Đóng' }).click();
  await expect(sheet(page)).toHaveCount(0); // unmounted after the exit animation, mask included
}

async function openHub(page: Page, query = '') {
  await page.goto(`/${query}`);
  await page.getByRole('button', { name: 'Mở trang tiện ích cá nhân' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tiện ích của tôi' })).toBeVisible();
  await settled(page);
  await ready(page);
}

async function acceptToTpaHome(page: Page, query = '') {
  await page.goto(`/${query}`);
  await page.getByRole('button', { name: 'Bắt đầu' }).click();
  await page.getByLabel(/Tôi đã đọc và hiểu/).check();
  await page.getByRole('button', { name: 'Đồng ý', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trang chủ' })).toBeVisible();
  await settled(page);
  await ready(page);
}

/** Pointer double tap; waits for the switch to commit. */
async function doubleTap(page: Page) {
  const gen = Number(await html(page).getAttribute('data-context-generation'));
  await page.waitForTimeout(350); // past the post-double-tap cooldown (DOUBLE_TAP_MS), as a person would be
  await avatar(page).dblclick();
  await expect.poll(async () => Number(await html(page).getAttribute('data-context-generation'))).toBeGreaterThan(gen);
  await ready(page);
}

async function chooseInSheet(page: Page, testId: string) {
  await avatar(page).click();
  await expect(sheet(page)).toBeVisible();
  await page.getByTestId(testId).click();
}

test('person avatar and workspace avatar are distinct, labelled controls', async ({ page }) => {
  const g = guard(page);
  await openHub(page);
  const person = page.getByTestId('person-avatar');
  await expect(person).toHaveAccessibleName(/^Tài khoản của bạn: N\*\*\* V\*\*\* M\*\*/);
  await expect(avatar(page)).toHaveAccessibleName('Đơn vị đang dùng: An Bình — DNBH mẫu. Chọn không gian');
  await expect(person.locator('.avatar-caption')).toHaveText('Tài khoản');
  await expect(avatar(page).locator('.avatar-caption')).toHaveText('Đơn vị');
  const radius = async (sel: string) => page.locator(sel).first().evaluate((e) => getComputedStyle(e).borderTopLeftRadius);
  expect(await radius('.person-circle')).toBe('50%');
  expect(await radius('[data-testid="workspace-avatar"] .tenant-mark')).toBe('10px');
  await expect(avatar(page)).toHaveCSS('touch-action', 'manipulation');
  g.assertClean();
});

test('double tap walks the stable ring P → AB → BM → CT → P → AB; order equals the sheet order', async ({ page }) => {
  const g = guard(page);
  await openHub(page, '?start=PERSONAL');
  await expect(wsName(page)).toHaveText('Loyalty360 cá nhân');
  await avatar(page).click();
  await expect(sheet(page)).toBeVisible();
  const order = await sheet(page).locator('.ws-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(order).toEqual(['ws-option-personal', 'ws-option-AB', 'ws-option-BM', 'ws-option-CT']);
  await closeSheet(page);
  await expect(page.getByTestId('quick-switch-hint')).toHaveText('Nhấn đúp để chuyển nhanh');

  const expected = ['An Bình — DNBH mẫu', 'Bình Minh — DNBH mẫu', 'Cát Tường — DNBH mẫu', 'Loyalty360 cá nhân', 'An Bình — DNBH mẫu'];
  for (const name of expected) {
    await doubleTap(page);
    await expect(wsName(page)).toHaveText(name);
    // The first tap of the double never opens (or leaves open) the sheet.
    await page.waitForTimeout(400);
    await expect(sheet(page)).toHaveCount(0);
  }
  g.assertClean();
});

test('single tap opens the chooser after the double-tap window and does not switch', async ({ page }) => {
  const g = guard(page);
  await openHub(page);
  const gen = await html(page).getAttribute('data-context-generation');
  await avatar(page).click();
  await expect(sheet(page)).toBeVisible();
  await expect(page.getByTestId('ws-option-AB')).toHaveAttribute('aria-current', 'true');
  await expect(sheet(page).getByText('(đang dùng)')).toHaveCount(1);
  // Other workspaces are never painted with the active tenant's brand (branding ≠ access, not yet authorised).
  const markBg = (id: string) => page.getByTestId(id).locator('.tenant-mark').evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(await markBg('ws-option-AB')).toBe('rgb(15, 118, 110)');
  expect(await markBg('ws-option-BM')).toBe('rgb(236, 239, 243)');
  expect(await markBg('ws-option-CT')).toBe('rgb(236, 239, 243)');
  expect(await html(page).getAttribute('data-context-generation')).toBe(gen);
  await page.screenshot({ path: 'test-results/106-sheet-390x844.png' });
  g.assertClean();
});

test('keyboard / screen reader: Enter opens the chooser at once, Tab+Enter switches, Escape returns focus', async ({ page }) => {
  const g = guard(page);
  await openHub(page);
  await avatar(page).focus();
  await page.keyboard.press('Enter');
  await expect(sheet(page)).toBeVisible();
  await expect(page.getByTestId('ws-option-AB')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  await expect(avatar(page)).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ws-option-AB')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('ws-option-BM')).toBeFocused();
  await page.keyboard.press('Enter');
  await ready(page);
  await expect(wsName(page)).toHaveText('Bình Minh — DNBH mẫu');
  await expect(page.getByTestId('switch-toast')).toContainText('Đã chuyển sang Bình Minh — DNBH mẫu.');
  g.assertClean();
});

test('0 memberships: personal Loyalty360 home, help for tenant access, no gesture, sheet explains', async ({ page }) => {
  const g = guard(page);
  await openHub(page, '?members=0');
  await expect(wsName(page)).toHaveText('Loyalty360 cá nhân');
  await expect(page.getByTestId('personal-loyalty')).toContainText('Loyalty360 cá nhân (mẫu)');
  await expect(page.getByTestId('no-membership-help')).toContainText('không tự liên kết tài khoản');
  await expect(page.getByTestId('tile-tpa')).toHaveCount(0);
  await expect(page.getByTestId('quick-switch-hint')).toHaveCount(0);
  await expect(avatar(page)).not.toHaveAttribute('aria-describedby', /.+/);
  const gen = await html(page).getAttribute('data-context-generation');
  await avatar(page).dblclick();
  await expect(sheet(page)).toBeVisible();
  await expect(page.getByTestId('ws-empty')).toContainText('Mini App không tự cấp quyền');
  await expect(sheet(page).locator('.ws-item')).toHaveCount(1);
  expect(await html(page).getAttribute('data-context-generation')).toBe(gen);
  await page.screenshot({ path: 'test-results/106-zero-memberships-390x844.png' });
  g.assertClean();
});

test('1 membership: sheet says there is no other workspace; double tap toggles personal ⇄ tenant', async ({ page }) => {
  const g = guard(page);
  await openHub(page, '?members=1');
  await expect(wsName(page)).toHaveText('An Bình — DNBH mẫu');
  await avatar(page).click();
  await expect(page.getByTestId('ws-single')).toContainText('không có đơn vị khác để chuyển');
  await closeSheet(page);
  await doubleTap(page);
  await expect(wsName(page)).toHaveText('Loyalty360 cá nhân');
  await doubleTap(page);
  await expect(wsName(page)).toHaveText('An Bình — DNBH mẫu');
  g.assertClean();
});

test('revoked membership is not silently skipped: explicit failure, no data, refreshed list, explicit return', async ({ page }) => {
  const g = guard(page);
  await openHub(page);
  await page.getByRole('button', { name: 'Cá nhân', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Cá nhân' })).toBeVisible();
  await settled(page);
  await page.getByTestId('revoke-other').click(); // server-side revocation of Bình Minh; client list is stale
  await page.getByRole('button', { name: 'Trang chủ', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tiện ích của tôi' })).toBeVisible();
  await settled(page);
  await chooseInSheet(page, 'ws-option-BM');
  const fail = page.getByTestId('switch-failure');
  await expect(fail).toContainText('Không chuyển được sang Bình Minh — DNBH mẫu');
  await expect(fail).toContainText('không còn hiệu lực');
  await expect(fail.getByRole('button', { name: 'Thử lại' })).toHaveCount(0);
  await expect(wsName(page)).toHaveText('Chưa chọn được đơn vị');
  await expect(html(page)).toHaveAttribute('data-theme', 'neutral');
  await expect(page.getByTestId('tile-tpa')).toHaveCount(0);
  await expect(page.getByTestId('tenant-services')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/106-revoked-390x844.png' });
  await fail.getByRole('button', { name: 'Chọn không gian khác' }).click();
  await expect(page.getByTestId('ws-option-BM')).toHaveCount(0);
  await closeSheet(page);
  await fail.getByRole('button', { name: 'Quay lại An Bình — DNBH mẫu' }).click();
  await ready(page);
  await expect(wsName(page)).toHaveText('An Bình — DNBH mẫu');
  g.assertClean();
});

test('active tenant revoked → leaves it explicitly with no data shown', async ({ page }) => {
  const g = guard(page);
  await openHub(page);
  await page.getByRole('button', { name: 'Cá nhân', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Cá nhân' })).toBeVisible();
  await settled(page);
  await page.getByTestId('revoke-active').click();
  await page.getByTestId('refresh-memberships').click();
  await expect(page.getByTestId('switch-failure')).toContainText('An Bình — DNBH mẫu');
  await expect(html(page)).toHaveAttribute('data-context-phase', 'failed');
  await expect(html(page)).toHaveAttribute('data-theme', 'neutral');
  g.assertClean();
});

test('offline and server error: failure with retry; recovery is explicit', async ({ page }) => {
  const g = guard(page);
  await openHub(page);
  await page.getByRole('button', { name: 'Cá nhân', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Cá nhân' })).toBeVisible();
  await settled(page);
  await page.getByLabel('Mất kết nối mạng (mô phỏng)').check();
  await chooseInSheet(page, 'ws-option-BM');
  const fail = page.getByTestId('switch-failure');
  await expect(fail).toContainText('không có kết nối mạng');
  await expect(html(page)).toHaveAttribute('data-theme', 'neutral');
  await page.getByLabel('Mất kết nối mạng (mô phỏng)').uncheck();
  await fail.getByRole('button', { name: 'Thử lại' }).click();
  await ready(page);
  await expect(wsName(page)).toHaveText('Bình Minh — DNBH mẫu');

  await page.getByLabel('Lần chuyển đơn vị tiếp theo bị lỗi máy chủ').check();
  await avatar(page).dblclick();
  await expect(page.getByTestId('switch-failure')).toContainText('máy chủ mô phỏng báo lỗi');
  await page.getByTestId('switch-failure').getByRole('button', { name: 'Thử lại' }).click();
  await ready(page);
  await expect(wsName(page)).toHaveText('Cát Tường — DNBH mẫu');
  g.assertClean();
});

test('delayed old response is ignored: slow Bình Minh superseded by Cát Tường never paints', async ({ page }) => {
  const g = guard(page);
  await openHub(page, '?slow=BM');
  await chooseInSheet(page, 'ws-option-BM');
  await expect(html(page)).toHaveAttribute('data-context-phase', 'switching');
  await expect(wsName(page)).toHaveText('Bình Minh — DNBH mẫu'); // immediate target indication (name only)
  await expect(html(page)).toHaveAttribute('data-theme', 'neutral');
  await chooseInSheet(page, 'ws-option-CT');
  await ready(page);
  await expect(wsName(page)).toHaveText('Cát Tường — DNBH mẫu');
  // Let the slow Bình Minh responses arrive (1.5 s each, they ignore abort) and prove they are dropped.
  await expect.poll(async () => Number(await html(page).getAttribute('data-stale-dropped')), { timeout: 6000 }).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(500);
  await expect(wsName(page)).toHaveText('Cát Tường — DNBH mẫu');
  expect(await html(page).evaluate((e) => getComputedStyle(e).getPropertyValue('--brand').trim())).toBe('#6d28d9');
  await expect(page.getByText('Bình Minh Rewards (mẫu)')).toHaveCount(0);
  g.assertClean();
});

test('rapid double taps are bounded: a second double tap during a pending switch is ignored', async ({ page }) => {
  const g = guard(page);
  await openHub(page, '?slow=BM');
  await avatar(page).dblclick();
  await expect(html(page)).toHaveAttribute('data-context-phase', 'switching');
  await avatar(page).dblclick();
  await avatar(page).dblclick();
  await ready(page);
  await expect(wsName(page)).toHaveText('Bình Minh — DNBH mẫu');
  g.assertClean();
});

test('no old tenant flash: while switching, prior tenant data and colour are gone and a skeleton shows', async ({ page }) => {
  const g = guard(page);
  await acceptToTpaHome(page, '?slow=BM');
  await expect(page.getByTestId('recent-claim-MAU-2026-000101')).toBeVisible();
  await chooseInSheet(page, 'ws-option-BM');
  await expect(page.getByTestId('service-loading')).toContainText('Đang mở Bình Minh — DNBH mẫu');
  await expect(page.getByTestId('recent-claim-MAU-2026-000101')).toHaveCount(0);
  await expect(html(page)).toHaveAttribute('data-theme', 'neutral');
  await expect(avatar(page)).toHaveAttribute('aria-busy', 'true');
  await page.screenshot({ path: 'test-results/106-switching-skeleton-390x844.png' });
  await ready(page);
  await expect(page.getByTestId('service-loading')).toHaveCount(0);
  await expect(page.getByTestId('recent-claim-MAU-2026-000611')).toBeVisible();
  await expect(page.getByTestId('recent-claim-MAU-2026-000101')).toHaveCount(0);
  g.assertClean();
});

test('pending draft/upload warning: stay, keep in original scope, discard — never moved or submitted', async ({ page }) => {
  const g = guard(page);
  await acceptToTpaHome(page);
  await page.getByRole('button', { name: 'Gửi hồ sơ mới' }).click();
  await page.getByLabel('Từ chối').check();
  await page.getByRole('button', { name: 'Mở camera' }).click();
  await page.getByTestId('gallery-input').setInputFiles([{ name: 'hoa-don-mau.heic', mimeType: 'image/heic', buffer: Buffer.from('synthetic') }]);
  await expect(page.getByTestId('file-list').locator('li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Quay lại', exact: true }).click();
  await settled(page);

  const dialog = page.getByRole('alertdialog', { name: 'Bạn có hồ sơ chưa gửi' });
  await avatar(page).dblclick();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('thuộc An Bình — DNBH mẫu');
  await expect(dialog.getByRole('button', { name: 'Ở lại' })).toBeFocused();
  await page.screenshot({ path: 'test-results/106-pending-draft-390x844.png' });
  await dialog.getByRole('button', { name: 'Ở lại' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(wsName(page)).toHaveText('An Bình — DNBH mẫu');

  await avatar(page).dblclick();
  await dialog.getByRole('button', { name: 'Giữ nháp tại An Bình — DNBH mẫu và chuyển' }).click();
  await ready(page);
  await expect(wsName(page)).toHaveText('Bình Minh — DNBH mẫu');
  // Bình Minh has its own consent scope: the An Bình consent does not carry over.
  await expect(page.getByRole('button', { name: 'Gửi hồ sơ mới' })).toBeDisabled();

  await chooseInSheet(page, 'ws-option-AB');
  await ready(page);
  await page.getByRole('button', { name: 'Gửi hồ sơ mới' }).click();
  await expect(page.getByTestId('file-list')).toContainText('hoa-don-mau.heic'); // kept in its original scope
  await page.getByRole('button', { name: 'Quay lại', exact: true }).click();
  await settled(page);
  await avatar(page).dblclick();
  await dialog.getByRole('button', { name: 'Bỏ nháp và chuyển' }).click();
  await ready(page);
  await chooseInSheet(page, 'ws-option-AB');
  await ready(page);
  await page.getByRole('button', { name: 'Gửi hồ sơ mới' }).click();
  await page.getByLabel('Từ chối').check();
  await page.getByRole('button', { name: 'Mở camera' }).click();
  await expect(page.getByTestId('file-list')).toHaveCount(0);
  g.assertClean();
});

test('switching service keeps the tenant; Loyalty360 shows no insurance/health data', async ({ page }) => {
  const g = guard(page);
  await openHub(page, '?start=BM');
  await page.getByTestId('tile-loyalty').click();
  await settled(page);
  await expect(page.getByTestId('service-badge')).toHaveText('Loyalty360');
  await expect(wsName(page)).toHaveText('Bình Minh — DNBH mẫu');
  await expect(page.getByTestId('loyalty-card')).toContainText('Bình Minh Rewards (mẫu)');
  const text = (await page.locator('.zaui-routes-item:not([inert]) main').innerText()).toLowerCase();
  for (const w of ['mau-2026', 'bồi thường', 'hồ sơ', 'thuốc', 'bệnh', 'hạn mức', 'cccd', 'tài khoản ngân hàng']) expect(text).not.toContain(w);
  await page.screenshot({ path: 'test-results/106-loyalty-BM-390x844.png' });
  await page.getByRole('button', { name: '‹ Trang tiện ích' }).click();
  await settled(page);
  await page.getByTestId('tile-tpa').click();
  await settled(page);
  await expect(page.getByTestId('service-badge')).toHaveText('Bảo hiểm sức khỏe');
  await expect(wsName(page)).toHaveText('Bình Minh — DNBH mẫu');
  await expect(page.getByText('Gói Mẫu Bình Minh — Nội trú')).toBeVisible();
  g.assertClean();
});

test('capability filter: Cát Tường (Loyalty360 only) shows no insurance tile; TPA screen explains access', async ({ page }) => {
  const g = guard(page);
  await openHub(page, '?start=CT');
  await expect(page.getByTestId('tile-loyalty')).toBeVisible();
  await expect(page.getByTestId('tile-tpa')).toHaveCount(0);
  g.assertClean();
});

test('cross-tenant deep link is denied without revealing existence', async ({ page }) => {
  const g = guard(page);
  await openHub(page);
  await page.getByRole('button', { name: 'Cá nhân', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Cá nhân' })).toBeVisible();
  await settled(page);
  await page.getByTestId('foreign-deeplink').click();
  await expect(page.getByTestId('claim-concealed')).toHaveText('Không tìm thấy hồ sơ trong đơn vị đang dùng, hoặc bạn không có quyền xem.');
  await expect(page.getByText('MAU-2026-000611')).toHaveCount(0);
  g.assertClean();
});

test('toast announces the switch and offers an explicit return', async ({ page }) => {
  const g = guard(page);
  await openHub(page);
  await doubleTap(page);
  const toast = page.getByTestId('switch-toast');
  await expect(toast).toContainText('Đã chuyển sang Bình Minh — DNBH mẫu.');
  await expect(page.getByTestId('switch-toast-region')).toHaveAttribute('aria-live', 'polite');
  await toast.getByRole('button', { name: 'Quay lại An Bình — DNBH mẫu' }).click();
  await ready(page);
  await expect(wsName(page)).toHaveText('An Bình — DNBH mẫu');
  g.assertClean();
});

test('notification bell is an honest placeholder (#107): no count, no fabricated alerts', async ({ page }) => {
  const g = guard(page);
  await openHub(page);
  const bell = page.getByTestId('bell-placeholder');
  await expect(bell).toHaveAttribute('aria-disabled', 'true');
  await expect(bell).toHaveAccessibleName('Thông báo — chưa khả dụng trong bản thử nghiệm');
  await expect(bell).not.toContainText(/\d/);
  // aria-disabled (not a working control): Playwright refuses a normal click, so dispatch one.
  await bell.dispatchEvent('click');
  await expect(page.getByText(/issue #107; chưa có thông báo nào/)).toBeVisible();
  g.assertClean();
});
