import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Issue #104 regressions: persistent ZaUI bottom navigation modelled on the owner reference (vimid-loyalty),
 * consent gating of the raised action, one nav instance during transitions, and nothing covered by the bar
 * on 390×844 and a smaller 360×640 viewport (with and without a bottom safe-area inset).
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

const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });
const nav = (page: Page) => page.getByRole('navigation', { name: 'Điều hướng chính' });
const tab = (page: Page, name: string) => nav(page).getByRole('button', { name, exact: true });

async function toConsent(page: Page) {
  await page.goto('/');
  await expect(nav(page)).toHaveCount(0); // onboarding: no bar
  await page.getByRole('button', { name: 'Bắt đầu' }).click();
  await expect(h1(page, 'Đồng ý xử lý dữ liệu')).toBeVisible();
  await expect(nav(page)).toHaveCount(0); // consent: no bar
}

async function accept(page: Page) {
  await toConsent(page);
  await page.getByLabel(/Tôi đã đọc và hiểu/).check();
  await page.getByRole('button', { name: 'Đồng ý', exact: true }).click();
  await expect(h1(page, 'Trang chủ')).toBeVisible();
  await settled(page);
}

/** Wait until the zmp-ui route transition has finished (only the active screen mounted). */
const settled = (page: Page) => expect(page.locator('.zaui-routes > .zaui-routes-item')).toHaveCount(1);

/** Scroll every scroll container of the active screen to the bottom, then assert `target` sits fully above
 * the bar AND the raised centre button (the bar's highest point). */
async function assertNotCovered(page: Page, target: Locator) {
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>('.zaui-routes-item:not([inert]), .zaui-routes-item:not([inert]) .zaui-page')
      .forEach((el) => { el.scrollTop = el.scrollHeight; });
  });
  const t = await target.boundingBox();
  const bar = await nav(page).locator('.zaui-bottom-navigation').boundingBox();
  const raised = await page.getByTestId('raised-action').boundingBox();
  expect(t && bar && raised, 'boxes measurable').toBeTruthy();
  const vh = page.viewportSize()!.height;
  expect(bar!.y + bar!.height, 'bar is pinned to the viewport bottom').toBeCloseTo(vh, 0);
  expect(t!.y + t!.height, 'content ends above the bar').toBeLessThanOrEqual(bar!.y);
  expect(t!.y + t!.height, 'content ends above the raised action').toBeLessThanOrEqual(raised!.y);
}

test('bottom nav: tab roots only, aria-current follows the route, unavailable tab never fakes a screen', async ({ page }) => {
  const g = guard(page);
  await accept(page);
  await expect(nav(page)).toHaveCount(1);
  await expect(tab(page, 'Trang chủ')).toHaveAttribute('aria-current', 'page');

  await tab(page, 'Hồ sơ').click();
  await expect(h1(page, 'Hồ sơ của tôi')).toBeVisible();
  await expect(tab(page, 'Hồ sơ')).toHaveAttribute('aria-current', 'page');
  await expect(tab(page, 'Trang chủ')).not.toHaveAttribute('aria-current', 'page');

  await tab(page, 'Thẻ BH').click();
  await expect(h1(page, 'Thẻ bảo hiểm điện tử')).toBeVisible();
  await expect(tab(page, 'Thẻ BH')).toHaveAttribute('aria-current', 'page');

  // Unsupported profile tab: explains itself, stays on the same screen, no new route.
  await tab(page, 'Cá nhân Sắp có').click();
  await expect(page.getByTestId('nav-unavailable')).toHaveText('Chức năng Cá nhân chưa có trong bản thử nghiệm.');
  await expect(h1(page, 'Thẻ bảo hiểm điện tử')).toBeVisible();
  await expect(page.locator('.zaui-routes > .zaui-routes-item')).toHaveCount(1);

  // Detail screens hide the bar and keep the back button; back restores it.
  await tab(page, 'Hồ sơ').click();
  await page.getByTestId('claim-MAU-2026-000101').click();
  await expect(h1(page, 'Hồ sơ MAU-2026-000101')).toBeVisible();
  await expect(nav(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Xem bảng giải trình chi trả' }).click();
  await expect(h1(page, 'Bảng giải trình chi trả')).toBeVisible();
  await expect(nav(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Quay lại' }).click();
  await page.getByRole('button', { name: 'Quay lại' }).click();
  await expect(h1(page, 'Hồ sơ của tôi')).toBeVisible();
  await expect(nav(page)).toHaveCount(1);
  g.assertClean();
});

test('consent gates the raised claim action; FNOL hides the bar so submit is never covered', async ({ page }) => {
  const g = guard(page);
  await toConsent(page);
  await page.getByRole('button', { name: 'Không đồng ý' }).click();
  await page.getByRole('button', { name: 'Tiếp tục với chức năng giới hạn' }).click();
  await expect(h1(page, 'Trang chủ')).toBeVisible();
  const raised = page.getByRole('button', { name: 'Gửi hồ sơ mới' });
  await expect(raised).toBeDisabled();
  await expect(raised).toHaveAccessibleDescription('Cần đồng ý xử lý dữ liệu trước khi gửi hồ sơ.');
  await expect(page.getByRole('button', { name: 'Gửi yêu cầu bồi thường' })).toBeDisabled();
  // Restricted mode still allows the e-card through the bar.
  await tab(page, 'Thẻ BH').click();
  await expect(h1(page, 'Thẻ bảo hiểm điện tử')).toBeVisible();
  await tab(page, 'Trang chủ').click();

  await page.getByRole('button', { name: 'Xem lại điều khoản đồng ý' }).click();
  await page.getByLabel(/Tôi đã đọc và hiểu/).check();
  await page.getByRole('button', { name: 'Đồng ý', exact: true }).click();
  await expect(raised).toBeEnabled();
  await raised.click();
  await expect(h1(page, 'Gửi yêu cầu bồi thường')).toBeVisible();
  await expect(nav(page)).toHaveCount(0);
  const send = page.getByRole('button', { name: 'Gửi hồ sơ (mô phỏng)' });
  await send.scrollIntoViewIfNeeded();
  await expect(send).toBeInViewport({ ratio: 1 });
  g.assertClean();
});

test('tab switch transition: one bar, one exposed screen, outgoing screen inert', async ({ page }) => {
  const g = guard(page);
  await accept(page);
  const items = page.locator('.zaui-routes > .zaui-routes-item');
  await tab(page, 'Hồ sơ').click();
  await expect(items).toHaveCount(2); // mid-transition
  await expect(page.locator('.zaui-routes > .zaui-routes-item[inert][aria-hidden="true"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="bottom-nav"]')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.locator('.bottom-nav')).not.toHaveAttribute('inert');
  await settled(page);
  g.assertClean();
});

for (const vp of [{ width: 390, height: 844 }, { width: 360, height: 640 }]) {
  test.describe(`viewport ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    test('home structure matches the reference hierarchy and nothing is covered by the bar', async ({ page }) => {
      const g = guard(page);
      await accept(page);
      const home = page.locator('.zaui-routes-item:not([inert])');
      // Reference order: banner → welcome header → titled sections → persistent bottom bar.
      const order = await home.evaluate((root) =>
        ['[data-testid="prototype-banner"]', '[data-testid="home-banner"]', '[data-testid="welcome"]', '.section']
          .map((s) => root.querySelector(s)!.getBoundingClientRect().top));
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      await expect(home.locator('.section-heading')).toHaveText(['Hợp đồng của bạn', 'Dịch vụ', 'Hồ sơ gần đây']);
      expect(await page.evaluate(() => getComputedStyle(document.querySelector('.page.warm')!).backgroundColor))
        .toBe('rgb(255, 248, 230)');
      // The honesty strip stays compact (≤ 2 lines), not a dominating panel.
      expect((await home.getByTestId('prototype-banner').boundingBox())!.height).toBeLessThanOrEqual(44);
      // Tap targets ≥ 44 px.
      for (const b of await nav(page).getByRole('button').all()) {
        const box = (await b.boundingBox())!;
        expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
      }
      await page.screenshot({ path: `test-results/104-home-top-${vp.width}x${vp.height}.png` });
      await assertNotCovered(page, page.getByTestId('recent-claim-MAU-2026-000102'));
      await page.screenshot({ path: `test-results/104-home-bottom-${vp.width}x${vp.height}.png` });

      await tab(page, 'Hồ sơ').click();
      await expect(h1(page, 'Hồ sơ của tôi')).toBeVisible();
      await settled(page);
      await assertNotCovered(page, page.getByTestId('claim-MAU-2026-000087'));
      await page.screenshot({ path: `test-results/104-claims-${vp.width}x${vp.height}.png` });

      await tab(page, 'Thẻ BH').click();
      await expect(h1(page, 'Thẻ bảo hiểm điện tử')).toBeVisible();
      await settled(page);
      await assertNotCovered(page, page.getByText(/Thẻ chỉ xác nhận hiệu lực bảo hiểm/));
      await page.screenshot({ path: `test-results/104-ecard-${vp.width}x${vp.height}.png` });
      g.assertClean();
    });

    test('bottom safe-area inset (home indicator) grows the bar and content still clears it', async ({ page }) => {
      const g = guard(page);
      await accept(page);
      const bar = nav(page).locator('.zaui-bottom-navigation');
      const before = (await bar.boundingBox())!.height;
      // Chromium has no notch; emulate env(safe-area-inset-bottom) = 34 px through the single token every
      // bottom offset derives from.
      await page.addStyleTag({ content: ':root { --safe-bottom: 34px !important; }' });
      await expect.poll(async () => (await bar.boundingBox())!.height).toBe(before + 34);
      const labelBox = (await tab(page, 'Trang chủ').boundingBox())!;
      const barBox = (await bar.boundingBox())!;
      expect(labelBox.y + labelBox.height, 'tab labels sit above the home indicator').toBeLessThanOrEqual(barBox.y + barBox.height - 34 + 0.5);
      await assertNotCovered(page, page.getByTestId('recent-claim-MAU-2026-000102'));
      g.assertClean();
    });
  });
}
