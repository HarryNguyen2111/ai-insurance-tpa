import { expect, test, type Page } from '@playwright/test';

/**
 * Browser smoke for the SYNTHETIC prototype (#74). Runs without the Zalo runtime (dev fallback) and
 * asserts that no request ever leaves the local preview server — i.e. nothing is uploaded or sent.
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

async function start(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('prototype-banner')).toContainText('DỮ LIỆU GIẢ LẬP');
  await expect(page.getByTestId('prototype-banner')).toContainText('ngoài Zalo');
  await expect(page.getByRole('heading', { level: 1, name: 'Chào mừng bạn' })).toBeVisible();
  await page.getByRole('button', { name: 'Bắt đầu' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Đồng ý xử lý dữ liệu' })).toBeVisible();
}

async function accept(page: Page) {
  await start(page);
  await page.getByLabel(/Tôi đã đọc và hiểu/).check();
  await page.getByRole('button', { name: 'Đồng ý', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trang chủ' })).toBeVisible();
}

test('consent is versioned; denial blocks claim submission and can be revisited', async ({ page }) => {
  const g = guard(page);
  await start(page);
  await expect(page.getByTestId('consent-version')).toContainText('synthetic-2026.11-v1');
  const agree = page.getByRole('button', { name: 'Đồng ý', exact: true });
  await expect(agree).toBeDisabled();

  await page.getByRole('button', { name: 'Không đồng ý' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Bạn chưa đồng ý' })).toBeVisible();
  await page.screenshot({ path: 'test-results/01-consent-denied.png', fullPage: true });
  await page.getByRole('button', { name: 'Tiếp tục với chức năng giới hạn' }).click();
  await expect(page.getByTestId('restricted-mode')).toContainText('chưa đồng ý');
  await expect(page.getByRole('button', { name: 'Gửi yêu cầu bồi thường' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Thẻ bảo hiểm điện tử' })).toBeEnabled();

  await page.getByRole('button', { name: 'Xem lại điều khoản đồng ý' }).click();
  await page.getByLabel(/Tôi đã đọc và hiểu/).check();
  await expect(agree).toBeEnabled();
  await agree.click();
  await expect(page.getByRole('button', { name: 'Gửi yêu cầu bồi thường' })).toBeEnabled();
  await expect(page.getByTestId('restricted-mode')).toHaveCount(0);
  g.assertClean();
});

test('e-card shows a 60 s rotating placeholder, never a real QR payload', async ({ page }) => {
  const g = guard(page);
  await page.clock.install({ time: new Date('2026-11-26T03:00:00Z') });
  await accept(page);
  // Freeze exactly on a minute boundary so the 60 s rotation is deterministic.
  await page.clock.pauseAt(new Date('2026-11-26T03:10:00Z'));
  await page.getByRole('button', { name: 'Thẻ bảo hiểm điện tử' }).click();
  await expect(page.getByTestId('ecard-countdown')).toHaveText('60');
  const art = page.getByTestId('ecard-placeholder');
  await expect(art).toHaveAttribute('aria-label', /không phải mã QR/);
  await expect(page.getByText('MẪU — KHÔNG PHẢI MÃ QR')).toBeVisible();
  await expect(page.getByTestId('card-number')).toHaveText(/^MAU-/);
  const token = page.getByTestId('ecard-token');
  await expect(token).toHaveText(/^PLACEHOLDER-KHONG-PHAI-MA-QR-/);
  const firstToken = await token.textContent();
  const firstWindow = await art.getAttribute('data-window');
  await page.screenshot({ path: 'test-results/02-ecard.png', fullPage: true });

  await page.clock.runFor(30_000);
  await expect(page.getByTestId('ecard-countdown')).toHaveText('30');
  await expect(token).toHaveText(firstToken!);

  await page.clock.runFor(31_000);
  await expect(art).not.toHaveAttribute('data-window', firstWindow!);
  await expect(token).not.toHaveText(firstToken!);
  await expect(token).toHaveText(/^PLACEHOLDER-KHONG-PHAI-MA-QR-/);
  await expect(page.getByTestId('ecard-countdown')).toHaveText('59');
  g.assertClean();
});

test('FNOL: camera denial shows the 3-step fallback; HEIC accepted by type only; nothing uploaded', async ({ page }) => {
  const g = guard(page);
  await accept(page);
  await page.getByRole('button', { name: 'Gửi yêu cầu bồi thường' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Gửi yêu cầu bồi thường' })).toBeVisible();
  const send = page.getByRole('button', { name: 'Gửi hồ sơ (mô phỏng)' });
  await expect(send).toBeDisabled();

  await page.getByLabel('Từ chối').check();
  await page.getByRole('button', { name: 'Mở camera' }).click();
  const fallback = page.getByTestId('camera-fallback');
  await expect(fallback).toBeVisible();
  await expect(fallback.locator('ol > li')).toHaveCount(3);
  await expect(page.getByTestId('fallback-retry')).toContainText('Bật lại quyền camera');
  await expect(page.getByTestId('fallback-gallery')).toContainText('Chọn ảnh có sẵn');
  await expect(page.getByTestId('fallback-later')).toContainText('Lưu nháp, gửi sau');

  await page.getByRole('button', { name: 'Mở cài đặt quyền' }).click();
  await expect(page.getByText(/Ngoài Zalo không mở được cài đặt quyền/)).toBeVisible();
  await page.getByRole('button', { name: 'Lưu nháp' }).click();
  await expect(page.getByText(/Đã lưu nháp tạm/)).toBeVisible();

  // Synthetic bytes: the app never reads them, only name/type/size.
  await page.getByTestId('gallery-input').setInputFiles([
    { name: 'hoa-don-mau.heic', mimeType: 'image/heic', buffer: Buffer.from('synthetic-not-an-image') },
    { name: 'anh-dong.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') },
  ]);
  const list = page.getByTestId('file-list');
  await expect(list.locator('li')).toHaveCount(2);
  await expect(list.locator('li', { hasText: 'hoa-don-mau.heic' })).toContainText('HEIC — sẽ chuyển đổi trên máy chủ');
  await expect(list.locator('li', { hasText: 'anh-dong.gif' })).toContainText('Định dạng chưa hỗ trợ');
  await page.screenshot({ path: 'test-results/03-fnol-fallback.png', fullPage: true });

  await page.getByLabel('Cho phép').check();
  await page.getByRole('button', { name: 'Thử lại' }).click();
  await expect(page.getByTestId('camera-granted')).toContainText('(giả lập)');

  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByTestId('fnol-done')).toContainText('Không có tệp hay dữ liệu nào được gửi đi');
  g.assertClean();
});

test('claim tracker and EOB render synthetic fixtures with string money and cited clauses', async ({ page }) => {
  const g = guard(page);
  await accept(page);
  await page.getByRole('button', { name: 'Hồ sơ của tôi' }).click();
  await expect(page.getByRole('list', { name: 'Danh sách hồ sơ mẫu' }).locator('li')).toHaveCount(3);
  await expect(page.getByTestId('claim-MAU-2026-000102')).toContainText('Cần bổ sung chứng từ');
  await expect(page.getByTestId('claim-MAU-2026-000087')).toContainText('540.000 ₫');

  await page.getByTestId('claim-MAU-2026-000101').click();
  await expect(page.getByTestId('claim-status')).toHaveText('Chờ bạn xác nhận bảng giải trình');
  await expect(page.getByTestId('claim-requested')).toHaveText('1.000.000 ₫');
  await expect(page.getByTestId('tracker').locator('[aria-current="step"]')).toHaveText('Có bảng giải trình');

  await page.getByRole('button', { name: 'Xem bảng giải trình chi trả' }).click();
  await expect(page.getByTestId('eob-version')).toContainText('Phiên bản EOB 1');
  await expect(page.getByTestId('eob-total-requested')).toHaveText('1.000.000 ₫');
  await expect(page.getByTestId('eob-total-approved')).toHaveText('720.000 ₫');
  await expect(page.getByTestId('eob-total-rejected')).toHaveText('280.000 ₫');
  const lines = page.getByTestId('eob-line');
  await expect(lines).toHaveCount(3);
  const rejected = lines.filter({ hasText: 'Thực phẩm chức năng' });
  await expect(rejected).toContainText('Không chi trả');
  await rejected.getByText(/Căn cứ: Điều MẪU 9\.3/).click();
  await expect(rejected.locator('blockquote')).toContainText('Không chi trả thực phẩm chức năng');
  await expect(page.getByRole('button', { name: 'Xác nhận bằng OTP (chưa khả dụng)' })).toBeDisabled();
  await page.screenshot({ path: 'test-results/04-eob.png', fullPage: true });

  await page.getByRole('button', { name: 'Quay lại' }).click();
  await page.getByRole('button', { name: 'Quay lại' }).click();
  await page.getByTestId('claim-MAU-2026-000102').click();
  await expect(page.getByText('Cần bổ sung chứng từ', { exact: true }).last()).toBeVisible();
  await expect(page.getByText(/trước 06\/12\/2026|trước 05\/12\/2026/)).toBeVisible();
  g.assertClean();
});

test('during a screen transition only the incoming screen is exposed and interactive', async ({ page }) => {
  // Regression for the flaky "Quay lại resolved to 2 elements": zmp-ui keeps the outgoing screen mounted
  // for the 400 ms transition. It must be inert + aria-hidden for that whole window.
  const g = guard(page);
  await accept(page);
  await page.getByRole('button', { name: 'Hồ sơ của tôi' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Hồ sơ của tôi' })).toBeVisible();

  const items = page.locator('.zaui-routes > .zaui-routes-item');
  const exiting = page.locator('.zaui-routes > .zaui-routes-item[inert][aria-hidden="true"]');

  await page.getByTestId('claim-MAU-2026-000101').click();
  // Both screens are mounted right now (transition in progress)…
  await expect(items).toHaveCount(2);
  // …but the outgoing one is already inert/hidden, so the accessible tree holds exactly one screen.
  await expect(exiting).toHaveCount(1);
  await expect(exiting).toContainText('Hồ sơ của tôi');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Quay lại' })).toHaveCount(1);
  // Transition completes and the outgoing screen unmounts.
  await expect(items).toHaveCount(1);
  await expect(exiting).toHaveCount(0);

  // Same guarantee for a back (POP) transition.
  await page.getByRole('button', { name: 'Quay lại' }).click();
  await expect(exiting).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1, name: 'Hồ sơ của tôi' })).toBeVisible();
  await expect(items).toHaveCount(1);
  g.assertClean();
});
